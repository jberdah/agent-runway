import assert from "node:assert/strict";
import { test } from "node:test";

import { clear, read, retryAfterSeconds, ttlMs, write } from "../src/cache.mjs";

const key = () => `test-${Math.random().toString(36).slice(2)}`;

test("a written value comes back fresh", () => {
  const k = key();
  try {
    write(k, { windows: [{ percentUsed: 42 }] });
    const hit = read(k, 60_000);
    assert.equal(hit.value.windows[0].percentUsed, 42);
    assert.equal(hit.fresh, true);
    assert.ok(hit.ageMs >= 0 && hit.ageMs < 5_000);
  } finally {
    clear(k);
  }
});

test("a value past its TTL is returned, but not as fresh", () => {
  const k = key();
  try {
    write(k, { windows: [] });
    // Stale entries still matter: a failed provider can fall back to them.
    const hit = read(k, 0);
    assert.ok(hit, "a stale entry is still returned");
    assert.equal(hit.fresh, false, "but never claims to be current");
  } finally {
    clear(k);
  }
});

test("a miss is a null, never a throw", () => {
  assert.equal(read(key(), 60_000), null);
  assert.doesNotThrow(() => clear(key()));
});

test("ttlMs honours the environment and ignores nonsense", () => {
  assert.equal(ttlMs({}), 60_000);
  assert.equal(ttlMs({ AGENT_RUNWAY_CACHE_MS: "5000" }), 5_000);
  assert.equal(ttlMs({ AGENT_RUNWAY_CACHE_MS: "0" }), 0, "zero disables the cache");
  assert.equal(ttlMs({ AGENT_RUNWAY_CACHE_MS: "-1" }), 60_000);
  assert.equal(ttlMs({ AGENT_RUNWAY_CACHE_MS: "soon" }), 60_000);
});

test("retryAfterSeconds reads both forms the header can take", () => {
  const headers = (value) => ({ get: (name) => (name === "retry-after" ? value : null) });

  assert.equal(retryAfterSeconds(headers("120")), 120);
  assert.equal(retryAfterSeconds(headers(null)), null);
  assert.equal(retryAfterSeconds(undefined), null);

  // The HTTP-date form, which must become a delay rather than a timestamp.
  const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
  const seconds = retryAfterSeconds(headers(inTwoMinutes));
  assert.ok(seconds >= 110 && seconds <= 120, `expected about 120, got ${seconds}`);

  // A date already past must not come back negative.
  assert.equal(retryAfterSeconds(headers(new Date(Date.now() - 60_000).toUTCString())), 0);
});
