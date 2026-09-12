// Provider registry: read one, or read them all at once.
//
// Reading several providers must never fail as a whole. Antigravity only
// answers while its IDE runs, a Codex token expires, `gh` may be absent — any
// of those is a per-provider status, never an exception that loses the other
// three. Every adapter is wrapped so a throw or a hang degrades that provider
// alone.

import * as cache from "../cache.mjs";
import * as antigravity from "./antigravity.mjs";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as copilot from "./copilot.mjs";
import { bindingWindow, secondsUntilReset, unavailable } from "./shared.mjs";

export const ADAPTERS = { claude, codex, copilot, antigravity };
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
  const guard = new Promise((resolve) =>
    setTimeout(
      () => resolve(unavailable(name, "unreachable", `no answer within ${HARD_TIMEOUT_MS / 1000}s`)),
      options.hardTimeoutMs ?? HARD_TIMEOUT_MS
    ).unref?.()
  );

  let result;
  try {
    result = await Promise.race([adapter.read(options), guard]);
  } catch (error) {
    result = unavailable(name, "error", String(error?.message ?? error));
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
  // In parallel: Antigravity spawns two processes and Copilot shells out to gh,
  // so serial reads would add up to seconds.
  return Promise.all(names.map((name) => readOne(name, options)));
}

export const readProvider = readOne;

/**
 * Turn readings into a decision.
 *
 * `threshold` is a policy, not a fact: at 92% the provider is not blocked, the
 * caller's own rule says not to start. Three outcomes, because two are not
 * enough — a provider that cannot be read is "unknown", never "fine".
 */
export function capacity(results, { threshold = 90 } = {}) {
  const providers = results.map((r) => {
    if (r.status !== "ok") {
      return { provider: r.provider, label: r.label, decision: "unknown", reason: r.status, detail: r.detail };
    }

    const binding = bindingWindow(r.windows);
    if (!binding || binding.percentUsed == null) {
      return { provider: r.provider, label: r.label, decision: "unknown", reason: "no_readable_window" };
    }

    // Codex states outright whether it will serve a request; that beats a
    // percentage we interpreted ourselves.
    if (r.allowed === false) {
      return {
        provider: r.provider, label: r.label, decision: "defer", reason: "provider_says_limit_reached",
        binding, retryAt: binding.resetsAt, retryAtBasis: "reported_reset",
      };
    }

    const over = binding.percentUsed >= threshold;
    return {
      provider: r.provider,
      label: r.label,
      decision: over ? "defer" : "proceed",
      reason: over ? "threshold_exceeded" : "within_threshold",
      binding,
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

  const cadences = new Set(usable.map((p) => p.binding.windowSeconds ?? "calendar"));

  return {
    threshold,
    providers,
    recommended: recommended
      ? {
          provider: recommended.provider,
          percentUsed: recommended.binding.percentUsed,
          window: recommended.binding.label,
          windowSeconds: recommended.binding.windowSeconds,
          secondsUntilReset: secondsUntilReset(recommended.binding),
          rule: "least consumed binding window among providers under the threshold",
          comparable: cadences.size <= 1,
        }
      : null,
    anyUnknown: providers.some((p) => p.decision === "unknown"),
  };
}
