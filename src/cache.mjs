// A short-lived read cache, so repeated questions cost one request.
//
// The usage endpoints rate-limit reads: eight probes in quick succession during
// development were enough to earn a 429, and a 429 on a usage endpoint is
// especially confusing because it looks like the account quota it is meant to
// report on.
//
// Comparable tools sidestep this entirely by never calling an API — they read
// the rate_limits block Claude Code already hands a statusline on stdin. That
// source is free but only exists inside a statusline invocation, so an
// on-demand or multi-provider read still has to make a request, and still has
// to be careful with it.
//
// Two defences here: serve a recent answer instead of asking again, and when a
// provider does fail, fall back to the last good answer marked stale rather
// than reporting nothing. Stale numbers about a five-hour window are far more
// useful than silence.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TTL_MS = 60_000;

const dir = () => path.join(os.tmpdir(), "agent-runway-cache");
const fileFor = (key) => path.join(dir(), `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);

/** How long a cached answer stays fresh. 0 disables the cache entirely. */
export function ttlMs(env = process.env) {
  const raw = env.AGENT_RUNWAY_CACHE_MS;
  if (raw === undefined) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

/**
 * @returns {{value: any, ageMs: number, fresh: boolean}|null}
 */
export function read(key, maxAgeMs = DEFAULT_TTL_MS) {
  try {
    const { at, value } = JSON.parse(fs.readFileSync(fileFor(key), "utf8"));
    const ageMs = Date.now() - at;
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;
    return { value, ageMs, fresh: maxAgeMs > 0 && ageMs <= maxAgeMs };
  } catch {
    return null; // absent or unreadable is simply a miss
  }
}

export function write(key, value) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileFor(key), JSON.stringify({ at: Date.now(), value }), "utf8");
  } catch {
    // A cache that cannot be written must never break the read it was helping.
  }
}

export function clear(key) {
  try {
    fs.rmSync(key ? fileFor(key) : dir(), { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Seconds a 429 asks us to wait, when the server says so.
 * Retry-After is either a delay in seconds or an HTTP date.
 */
export function retryAfterSeconds(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, Math.round((when - Date.now()) / 1000)) : null;
}
