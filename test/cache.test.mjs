import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("a reading older than a day is treated as a miss, not as stale", () => {
  const k = key();
  const file = path.join(os.tmpdir(), "agent-runway-cache", `${k}.json`);
  try {
    write(k, { windows: [] });
    // Backdate it past the bound: a five-hour window has turned over many times
    // by then, so the numbers are wrong rather than merely old.
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify({ at: twoDaysAgo, value: { windows: [] } }), "utf8");
    assert.equal(read(k, 0), null);
  } finally {
    clear(k);
  }
});

test("cached readings are not left readable by other users", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-perms-"));
  const previous = process.env.AGENT_RUNWAY_CACHE_DIR;
  process.env.AGENT_RUNWAY_CACHE_DIR = dir;

  try {
    write("permtest", { provider: "claude", plan: "max", windows: [] });
    const file = path.join(dir, "permtest.json");
    assert.ok(fs.existsSync(file));

    // The default location is a world-readable tmpdir: 1777, and a 022 umask
    // leaves new files at 644. None of this is a credential, but it is the
    // account's plan and how much of each window is consumed - not something
    // another user on a shared machine should get for free.
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, "cache entry is readable by others");
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "cache directory is traversable by others");
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUNWAY_CACHE_DIR;
    else process.env.AGENT_RUNWAY_CACHE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing the cache never removes the directory it was pointed at", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-clear-"));
  const previous = process.env.AGENT_RUNWAY_CACHE_DIR;
  process.env.AGENT_RUNWAY_CACHE_DIR = dir;

  // Something that is not ours, in the directory a caller pointed us at.
  const bystander = path.join(dir, "important.txt");
  fs.writeFileSync(bystander, "not a cache entry");

  try {
    write("a", { x: 1 });
    clear();

    // `rmSync(dir, { recursive: true })` was the old implementation. With
    // AGENT_RUNWAY_CACHE_DIR set to a home directory by mistake, that is not a
    // cache clear, it is a deletion.
    assert.ok(fs.existsSync(dir), "the directory itself must survive");
    assert.ok(fs.existsSync(bystander), "files we did not write must survive");
    assert.ok(!fs.existsSync(path.join(dir, "a.json")), "our own entry is gone");
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUNWAY_CACHE_DIR;
    else process.env.AGENT_RUNWAY_CACHE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
