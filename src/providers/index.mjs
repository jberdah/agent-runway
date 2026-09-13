// Provider registry: read one, or read them all at once.
//
// Reading several providers must never fail as a whole. A Codex token expires,
// `gh` may be absent, a network is a network — any of those is a per-provider
// status, never an exception that loses the others. Every adapter is wrapped so
// a throw or a hang degrades that provider alone.
//
// Every provider here is also spawnable, and a test holds that line. Reporting
// quota for something a caller cannot invoke was worse than useless: capacity()
// happily recommended Antigravity, an IDE, as the agent to send work to.

import * as cache from "../cache.mjs";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as copilot from "./copilot.mjs";
import { bindingWindow, secondsUntilReset, unavailable } from "./shared.mjs";

export const ADAPTERS = { claude, codex, copilot };
export const PROVIDER_IDS = Object.keys(ADAPTERS);

const HARD_TIMEOUT_MS = 20000;

/** Never throws, never hangs: an adapter's failure becomes that provider's status. */
async function readOne(name, options) {
  const adapter = ADAPTERS[name];
  if (!adapter) return unavailable(name, "error", "unknown provider");

  const maxAge = options.cacheMs ?? cache.ttlMs(options.env ?? process.env);

  // A recent answer beats asking again: these endpoints rate-limit reads, and a
  // 429 on a usage endpoint reads like the account quota it reports on.
  const hit = cache.read(name, maxAge);
  if (hit?.fresh) {
    return { ...hit.value, cached: true, ageMs: hit.ageMs, latencyMs: 0 };
  }

  const started = Date.now();
  const limitMs = options.hardTimeoutMs ?? HARD_TIMEOUT_MS;

  // The timeout used to be a race and nothing more: it let readOne return while
  // the adapter carried on in the background, holding a socket or a child
  // process. The controller makes it a real cancellation — the fetch is torn
  // down, the spawned process is killed — and the race stays as a backstop, so
  // that an adapter which ignored its signal could still never hang the caller.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limitMs);
  timer.unref?.();

  const guard = new Promise((resolve) =>
    setTimeout(() => resolve(unavailable(name, "unreachable", `no answer within ${limitMs / 1000}s`)), limitMs).unref?.()
  );

  let result;
  try {
    result = await Promise.race([adapter.read({ ...options, signal: controller.signal }), guard]);
  } catch (error) {
    result = unavailable(name, "error", String(error?.message ?? error));
  } finally {
    clearTimeout(timer);
    // Also on success: an adapter may still be trying a second port or a
    // fallback endpoint, and the answer is already in hand.
    controller.abort();
  }

  // Once the deadline has passed we have given up, and an adapter that answers
  // on its way out must not be believed: aborting a read mid-flight can leave
  // it holding a partial payload, and "ok" from a cancelled read is the one
  // answer that would be acted on.
  if (timedOut) {
    result = unavailable(name, "unreachable", `no answer within ${limitMs / 1000}s`);
  }

  const enriched = { ...result, label: adapter.label ?? name, latencyMs: Date.now() - started };

  if (enriched.status === "ok") {
    cache.write(name, enriched);
    return enriched;
  }

  // Failed. Stale numbers about a five-hour window still say more than silence,
  // so long as they are labelled as stale rather than passed off as current.
  if (hit) {
    return {
      ...hit.value,
      cached: true,
      stale: true,
      ageMs: hit.ageMs,
      latencyMs: enriched.latencyMs,
      detail: `serving a cached reading ${Math.round(hit.ageMs / 1000)}s old: ${enriched.detail ?? enriched.status}`,
    };
  }
  return enriched;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.providers] subset to read; defaults to all
 * @returns {Promise<Array>} one result per provider, in registry order
 */
export async function readAll(options = {}) {
  const names = options.providers?.length ? options.providers : PROVIDER_IDS;
  // In parallel: Copilot shells out to gh and the others make network calls,
  // so serial reads would add up to seconds.
  return Promise.all(names.map((name) => readOne(name, options)));
}

export const readProvider = readOne;

/**
 * How the per-provider decisions combine into one answer.
 *
 * These are two different questions and conflating them is dangerous. "Can I
 * keep working" is about the caller's own provider; "is there any agent that
 * could take this" is about a fan-out. Answering the second when the first was
 * asked reports room that the caller does not have — Claude at 96% beside
 * Codex at 10% would come back as proceed.
 *
 * So the default is the conservative reading, and the permissive one has to be
 * asked for by name. Scoping to a single provider makes the two identical,
 * which is the form a caller asking about itself should use.
 */
const RULES = {
  all: "every readable provider is under the threshold",
  any: "at least one provider is under the threshold",
};

function overallDecision(providers, rule) {
  // A provider that could not be read is neither under the threshold nor over
  // it: it is outside the set the rule speaks about. Counting it as blocking
  // contradicted the rule's own wording — "every READABLE provider" — and made
  // one provider that could not be reached answer "unknown" for a machine where
  // the others had plenty of room. The unreadable ones are named in
  // `overall.unreadable` instead, so a decision is never quietly based on
  // partial data.
  const readable = providers.filter((p) => p.decision !== "unknown");
  if (!readable.length) return "unknown";

  if (rule === "any") {
    return readable.some((p) => p.decision === "proceed") ? "proceed" : "defer";
  }
  return readable.some((p) => p.decision === "defer") ? "defer" : "proceed";
}

/**
 * Turn readings into a decision.
 *
 * `threshold` is a policy, not a fact: at 92% the provider is not blocked, the
 * caller's own rule says not to start. Three outcomes, because two are not
 * enough — a provider that cannot be read is "unknown", never "fine".
 */
export function capacity(results, { threshold = 90, rule = "all" } = {}) {
  const providers = results.map((r) => {
    if (r.status !== "ok") {
      return { provider: r.provider, label: r.label, decision: "unknown", reason: r.status, detail: r.detail };
    }

    const binding = bindingWindow(r.windows);
    if (!binding || binding.percentUsed == null) {
      return { provider: r.provider, label: r.label, decision: "unknown", reason: "no_readable_window" };
    }

    // A reading served from cache after a live read failed cannot support
    // "proceed" — but it can still support "defer", and the difference matters.
    //
    // Consumption only rises inside a window. So a stale 94% is still at least
    // 94%: the constraint it reports is real, and answering "unknown" there
    // would throw away an actionable defer complete with a reset time. A stale
    // 15% proves nothing about now — the window may have filled while the
    // provider was unreachable, which is often exactly why it was unreachable.
    //
    // The one case where even defer is unfounded: the window this reading
    // describes has since reset, so the number belongs to a window that no
    // longer exists.
    if (r.stale) {
      const reset = binding.resetsAt ? Date.parse(binding.resetsAt) : NaN;
      const windowGone = Number.isFinite(reset) && reset <= Date.now();
      const blocked = r.allowed === false || binding.percentUsed >= threshold;

      if (windowGone || !blocked) {
        return {
          provider: r.provider,
          label: r.label,
          decision: "unknown",
          reason: windowGone ? "stale_window_already_reset" : "stale_cannot_show_room",
          detail: r.detail,
          binding,
          windows: r.windows,
          stale: true,
          staleMs: r.ageMs ?? null,
        };
      }
      return {
        provider: r.provider,
        label: r.label,
        decision: "defer",
        reason: r.allowed === false ? "provider_says_limit_reached" : "threshold_exceeded",
        binding,
        windows: r.windows,
        retryAt: binding.resetsAt,
        retryAtBasis: "window_reset",
        stale: true,
        staleMs: r.ageMs ?? null,
      };
    }

    // Codex states outright whether it will serve a request; that beats a
    // percentage we interpreted ourselves.
    if (r.allowed === false) {
      return {
        provider: r.provider, label: r.label, decision: "defer", reason: "provider_says_limit_reached",
        binding, windows: r.windows, retryAt: binding.resetsAt, retryAtBasis: "reported_reset",
      };
    }

    const over = binding.percentUsed >= threshold;
    return {
      provider: r.provider,
      label: r.label,
      decision: over ? "defer" : "proceed",
      reason: over ? "threshold_exceeded" : "within_threshold",
      binding,
      // The binding window decides, but hiding the rest loses information the
      // read already paid for: a session at 0% next to a weekly at 89% is a
      // different situation from a session at 0% alone.
      windows: r.windows,
      retryAt: over ? binding.resetsAt : null,
      // The reset is when the window rolls over, not a promise that service
      // resumes exactly then. Naming the basis keeps the two apart.
      retryAtBasis: over ? "window_reset" : null,
    };
  });

  const usable = providers.filter((p) => p.decision === "proceed" && p.binding);

  // Ranking rule, stated rather than implied: most headroom in the window that
  // would bind first. Windows of different cadence are NOT interchangeable —
  // 0% of a five-hour window is far less capacity than 0% of a monthly
  // allowance — so the basis travels with the recommendation.
  const recommended = usable.length
    ? usable.reduce((best, p) => (p.binding.percentUsed < best.binding.percentUsed ? p : best))
    : null;

  const cadenceKey = (p) => p.binding.windowSeconds ?? "calendar";
  const comparable = new Set(usable.map(cadenceKey)).size <= 1;

  const describe = (p) => ({
    provider: p.provider,
    percentUsed: p.binding.percentUsed,
    window: p.binding.label,
    windowSeconds: p.binding.windowSeconds,
    secondsUntilReset: secondsUntilReset(p.binding),
  });

  // The best provider within each cadence class. Comparing across classes is
  // what cannot be done honestly; comparing inside one is straightforward, and
  // a caller that knows its own workload can pick from these.
  const byCadence = new Map();
  for (const p of usable) {
    const best = byCadence.get(cadenceKey(p));
    if (!best || p.binding.percentUsed < best.binding.percentUsed) byCadence.set(cadenceKey(p), p);
  }

  const decision = overallDecision(providers, rule);

  return {
    threshold,
    // The one answer a caller acts on, carrying the rule that produced it so
    // that "proceed" can never be read as more than it claims.
    overall: {
      decision,
      rule: rule === "any" ? "any" : "all",
      ruleText: RULES[rule] ?? RULES.all,
      scoped: providers.length === 1 ? providers[0].provider : null,
      // Named, not merged into the decision: "proceed, and two providers could
      // not be read" is a different situation from "proceed".
      unreadable: providers.filter((p) => p.decision === "unknown").map((p) => p.provider),
    },
    providers,
    // Offered only when the candidates share a cadence. 0% of a five-hour
    // window is not 0% of a monthly allowance, and a field named `recommended`
    // gets acted on while a `comparable: false` sitting beside it gets skimmed
    // past. Withholding the recommendation is the safer failure; the material
    // it was built from stays in `candidates`.
    recommended:
      recommended && comparable
        ? {
            ...describe(recommended),
            rule: "least consumed binding window among providers under the threshold",
            comparable: true,
          }
        : null,
    // One entry per cadence class, each the least consumed of its class. When
    // `recommended` is null this is what a caller chooses from, knowing which
    // window its own work will actually burn.
    candidates: [...byCadence.values()].map(describe),
    anyUnknown: providers.some((p) => p.decision === "unknown"),
  };
}
