import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { discoverInstalls, fingerprint, followShim } from "../src/installs.mjs";

// This project is developed on Windows, and the layouts it has to know about
// differ per platform: a Mac carries the same variety, a Linux box less of it.
// Injecting home and platform is what makes the macOS and Linux branches
// testable from a machine that is neither.

function fakeHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-installs-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return home;
}

const claudeOnly = (home, platform) =>
  discoverInstalls({ home, platform, agents: ["claude"] }).filter((i) => i.kind === "desktop");

test("the desktop app is found on Windows, one entry per version", () => {
  const home = fakeHome({
    "AppData/Roaming/Claude/claude-code/2.1.260/claude.exe": "x",
    "AppData/Roaming/Claude/claude-code/2.1.266/claude.exe": "x",
  });
  try {
    const found = claudeOnly(home, "win32");
    assert.deepEqual(found.map((i) => i.version).sort(), ["2.1.260", "2.1.266"]);
    assert.equal(found[0].layoutVerified, true, "the Windows layout is the one actually observed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the macOS layout is searched, and declares itself unverified", () => {
  const home = fakeHome({ "Library/Application Support/Claude/claude-code/2.1.266/claude": "x" });
  try {
    const found = claudeOnly(home, "darwin");
    assert.equal(found.length, 1);
    assert.equal(found[0].version, "2.1.266");
    // Honest labelling matters more than the guess: nobody has run this on a Mac.
    assert.equal(found[0].layoutVerified, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the Linux layout is searched too", () => {
  const home = fakeHome({ ".config/Claude/claude-code/2.1.266/claude": "x" });
  try {
    const found = claudeOnly(home, "linux");
    assert.equal(found.length, 1);
    assert.equal(found[0].layoutVerified, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an executable named for the wrong platform is not picked up", () => {
  // claude.exe under a POSIX layout means the layout is not what we think.
  const home = fakeHome({ "Library/Application Support/Claude/claude-code/2.1.266/claude.exe": "x" });
  try {
    assert.equal(claudeOnly(home, "darwin").length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a directory that is not a version yields no version, not a crash", () => {
  const home = fakeHome({ "AppData/Roaming/Claude/claude-code/nightly/claude.exe": "x" });
  try {
    const found = claudeOnly(home, "win32");
    assert.equal(found.length, 1);
    assert.equal(found[0].version, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a missing desktop directory is simply no installs", () => {
  const home = fakeHome({});
  try {
    assert.deepEqual(claudeOnly(home, "win32"), []);
    assert.deepEqual(claudeOnly(home, "darwin"), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("followShim resolves an npm launcher to the program it starts", () => {
  const home = fakeHome({
    "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe": "pretend binary",
    "npm/claude": '#!/bin/sh\nexec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"\n',
  });
  try {
    const shim = path.join(home, "npm", "claude");
    const resolved = followShim(shim);
    assert.notEqual(resolved, shim, "the shim must not be mistaken for the program");
    assert.equal(path.basename(resolved), "claude.exe");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("followShim leaves a real binary and a broken shim alone", () => {
  const home = fakeHome({
    "big": "x".repeat(100 * 1024), // past the size where a shim is plausible
    "npm/orphan": '#!/bin/sh\nexec "$basedir/node_modules/gone/bin/gone.exe" "$@"\n',
  });
  try {
    const big = path.join(home, "big");
    assert.equal(followShim(big), big);
    const orphan = path.join(home, "npm", "orphan");
    assert.equal(followShim(orphan), orphan, "a target that does not exist is not a resolution");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the fingerprint changes when the file does", () => {
  const home = fakeHome({ "bin": "one" });
  try {
    const file = path.join(home, "bin");
    const before = fingerprint(file);
    fs.writeFileSync(file, "two different");
    assert.notEqual(fingerprint(file), before, "a changed binary must become a different cache key");
    assert.equal(fingerprint(path.join(home, "absent")), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
