// What the tool can see, and why a provider is not answering.
//
// The support question is always the same shape: "it says no token, but I have
// one". The answer was spread across four credential sources, two Claude
// endpoints that take different credentials, a cache that can serve a stale
// reading, and four providers with logins of their own — visible only as a
// status word and a hint string. This puts it in one place.
//
// It prints no secret, ever. Sources are named, values never are: a diagnostic
// is something people paste into an issue, so it has to be safe to paste. That
// rule is what makes the output useful rather than dangerous, and a test
// asserts it against a report built from planted credentials.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchUsage, resolveCookie, resolveOrgId, resolveToken, UsageError, VERSION } from "./core.mjs";
import { PROVIDER_IDS, readAll } from "./providers/index.mjs";

const cacheDirFor = (env) => env.AGENT_RUNWAY_CACHE_DIR || path.join(os.tmpdir(), "agent-runway-cache");

/** Ages of the cached readings, read off disk without disturbing them. */
function cacheEntries(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          const { at } = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
          return { key: name.replace(/\.json$/, ""), ageMs: Number.isFinite(at) ? Date.now() - at : null };
        } catch {
          return { key: name.replace(/\.json$/, ""), ageMs: null };
        }
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  } catch {
    return []; // nothing cached yet is the normal first run
  }
}

/**
 * @returns {Promise<object>} a structured report. Never throws: a diagnostic
 * that fails when things are broken is the one case it exists for.
 */
export async function diagnose({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = resolveToken(env);
  const cookie = resolveCookie(env);
  const orgId = resolveOrgId(env);

  const claude = {
    token: token
      ? { found: true, source: token.source, expiredAt: token.expiredAt }
      : { found: false, source: null, expiredAt: null },
    cookie: { found: Boolean(cookie), source: cookie?.source ?? null },
    orgId: { known: Boolean(orgId) },
    // The claude.ai endpoint needs both halves. Saying which one is missing is
    // the difference between a fix and a guess.
    claudeAiEligible: Boolean(orgId && cookie),
    attempt: null,
  };

  try {
    const usage = await fetchUsage({ env, fetchImpl });
    claude.attempt = {
      ok: true,
      endpoint: usage.endpoint,
      tokenSource: usage.tokenSource,
      windows: usage.windows.length,
    };
  } catch (error) {
    claude.attempt = {
      ok: false,
      code: error instanceof UsageError ? error.code : "ERROR",
      // fetchUsage already carries the API's own words, per endpoint.
      message: String(error?.message ?? error),
      hint: error instanceof UsageError ? error.hint ?? null : null,
    };
  }

  // Claude was just read in full above; reading it again would spend a second
  // request on a rate-limited endpoint to learn nothing new.
  const others = await readAll({ env, providers: PROVIDER_IDS.filter((id) => id !== "claude") });

  const providers = [
    {
      provider: "claude",
      status: claude.attempt.ok ? "ok" : claude.attempt.code === "NO_TOKEN" ? "no_credentials" : "unreachable",
      stale: false,
      ageMs: null,
      detail: claude.attempt.ok ? `via ${claude.attempt.endpoint}` : claude.attempt.message.split("\n")[0],
    },
    ...others.map((r) => ({
      provider: r.provider,
      status: r.status,
      // The registry answers a failed read with the last good one, still
      // labelled `ok`. That is the right call for a quota question and the
      // wrong one here: it would hide the very failure being diagnosed.
      stale: Boolean(r.stale),
      ageMs: r.ageMs ?? null,
      detail: r.detail ?? null,
    })),
  ];

  const dir = cacheDirFor(env);
  const entries = cacheEntries(dir);
  const readings = entries.filter((e) => PROVIDER_IDS.includes(e.key));

  return {
    // `runtime`, not `tool`: the JSON envelope sets `tool: "agent-runway"`, and
    // a payload field of the same name flattened an object over it — the same
    // collision that once put this tool's version where a Codex binary's
    // belonged. A test now asserts the envelope survives across every kind,
    // rather than against the one field that happened to be remembered.
    runtime: { version: VERSION, node: process.version, platform: process.platform, home: os.homedir() },
    claude,
    providers,
    cache: {
      dir,
      readings,
      // Model and version caches are keyed by a binary's fingerprint and never
      // expire by time, so their ages say nothing worth reading. Listing them
      // buried the four that matter under twenty that do not.
      derivedCount: entries.length - readings.length,
    },
  };
}

const age = (ms) => (ms == null ? "unknown age" : ms < 60_000 ? `${Math.round(ms / 1000)}s old` : `${Math.round(ms / 60_000)}m old`);

export function renderDoctor(report) {
  const out = [];
  const row = (label, value) => out.push(`  ${label.padEnd(12)}${value}`);

  out.push("agent-runway doctor", "");
  row("Tool", `${report.runtime.version}, Node ${report.runtime.node}, ${report.runtime.platform}`);
  row("Home", report.runtime.home);

  out.push("", "Claude credentials");
  const { token, cookie, orgId, claudeAiEligible, attempt } = report.claude;
  row("Token", token.found ? `found - ${token.source}` : "none found");
  if (token.expiredAt) row("", `expired at ${token.expiredAt}`);
  row("Cookie", cookie.found ? `found - ${cookie.source}` : "absent (~/.claude/session-cookie)");
  row("Org id", orgId.known ? "known" : "unknown");
  row(
    "claude.ai",
    claudeAiEligible
      ? "eligible - cookie and org id both present"
      : `not offered - ${!cookie.found && !orgId.known ? "no cookie, no org id" : !cookie.found ? "no cookie" : "no org id"}`
  );

  if (attempt.ok) {
    row("Answered", `${attempt.endpoint} (${attempt.windows} windows), token from ${attempt.tokenSource}`);
  } else {
    row("Answered", `no - ${attempt.code}`);
    for (const line of attempt.message.split("\n")) out.push(`              ${line.trim()}`);
    if (attempt.hint) {
      out.push("");
      for (const line of attempt.hint.split("\n")) out.push(`  ${line}`);
    }
  }

  out.push("", "Providers");
  for (const p of report.providers) {
    const stale = p.stale ? ` [stale, ${age(p.ageMs)}]` : "";
    row(p.provider, `${p.status}${stale}${p.detail ? ` - ${p.detail}` : ""}`);
  }

  out.push("", "Cache");
  row("Directory", report.cache.dir);
  if (!report.cache.readings.length) row("", "no quota readings cached");
  for (const entry of report.cache.readings) row(entry.key, age(entry.ageMs));
  if (report.cache.derivedCount) {
    out.push(
      `  ${String(report.cache.derivedCount).padEnd(12)}model and version entries, keyed by binary fingerprint (no time expiry)`
    );
  }

  return out.join("\n");
}
