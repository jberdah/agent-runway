// The CLI's own wiring: which exit code a decision becomes, and whether a
// caller parsing --json can tell what it is holding.
//
// These ran only at the capacity() level before, which left the part that
// actually misleads a caller untested: a gate that answers "somebody has room"
// to an agent asking "have I got room". The cache is the seam that makes this
// testable offline — a pre-seeded reading is served without any adapter
// running, so no network and no gh.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { makeWindow } from "../src/providers/shared.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-clitest-"));
after(() => fs.rmSync(CACHE_DIR, { recursive: true, force: true }));

/** Seed a provider reading so the adapter is never reached. */
function seed(provider, percentUsed, { kind = "session", allowed = null } = {}) {
  const value = {
    provider,
    label: provider,
    status: "ok",
    plan: null,
    allowed,
    windows: [makeWindow({ kind, percentUsed })],
    detail: null,
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(CACHE_DIR, `${provider}.json`), JSON.stringify({ at: Date.now(), value }));
}

/** Trailing object argument, when present, overrides environment variables. */
function run(...args) {
  const extraEnv = typeof args.at(-1) === "object" ? args.pop() : {};
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_RUNWAY_CACHE_DIR: CACHE_DIR,
      // The seeded readings are written once at module load and this file takes
      // minutes to run. Without a long TTL the later tests would fall through
      // to real adapters and start depending on gh, a live IDE and the network.
      AGENT_RUNWAY_CACHE_MS: "600000",
      ...extraEnv,
    },
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// No credential anywhere, and forbidden from reading the machine's own: enough
// for the Claude path to fail before it reaches the network.
const OFFLINE = {
  CLAUDE_CODE_OAUTH_TOKEN: "",
  AGENT_RUNWAY_TOKEN: "",
  ANTHROPIC_AUTH_TOKEN: "",
  AGENT_RUNWAY_CLAUDE_COOKIE: "",
  AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1",
};

// Claude nearly out, Codex nearly untouched: the exact pair that used to be
// reported as room to work.
seed("claude", 96);
seed("codex", 10);
seed("copilot", 20, { kind: "monthly" });

test("a gate on everything defers when one provider is out, rather than reporting the best", () => {
  const { code, stdout } = run("--gate", "90");
  assert.equal(code, 10, "Claude at 96% must not be masked by Codex at 10%");

  const answer = JSON.parse(stdout);
  assert.equal(answer.overall.decision, "defer");
  assert.equal(answer.overall.rule, "all");
  assert.match(answer.overall.ruleText, /every readable provider/);
});

test("the fan-out question gives the permissive answer, but has to be asked", () => {
  const { code, stdout } = run("--gate", "90", "--any");
  assert.equal(code, 0, "one provider with room is enough for a fan-out");
  assert.equal(JSON.parse(stdout).overall.rule, "any");
});

test("scoping to one provider answers about that provider alone", () => {
  assert.equal(run("--provider", "claude", "--gate", "90").code, 10);
  assert.equal(run("--provider", "codex", "--gate", "90").code, 0);

  const scoped = JSON.parse(run("--provider", "codex", "--gate", "90").stdout);
  assert.equal(scoped.overall.scoped, "codex");
  assert.equal(scoped.providers.length, 1, "the others are not even read");
});

test("--provider=id is accepted as well as --provider id", () => {
  assert.equal(run("--provider=claude", "--gate", "90").code, 10);
});

test("a gate refuses an input it cannot use rather than inventing a threshold", () => {
  for (const bad of ["foo", "150", "-1", "NaN"]) {
    const { code, stderr } = run("--gate", bad, "--provider", "codex");
    assert.equal(code, 1, `--gate ${bad} must not silently become 90`);
    assert.match(stderr, /number from 0 to 100/);
  }
});

test("a bare --gate still means the default, including before another flag", () => {
  // `--gate` with nothing after it, and `--gate --provider x`, are both the
  // documented default rather than a malformed value.
  assert.equal(JSON.parse(run("--gate", "--provider", "codex").stdout).threshold, 90);
  assert.equal(JSON.parse(run("--provider", "codex", "--gate").stdout).threshold, 90);
  assert.equal(JSON.parse(run("--gate=75", "--provider", "codex").stdout).threshold, 75);
  // 0 and 100 are usable thresholds, not falsy input to be replaced.
  assert.equal(JSON.parse(run("--gate", "0", "--provider", "codex").stdout).threshold, 0);
});

test("an unknown provider is refused by name, not silently ignored", () => {
  const { code, stderr } = run("--provider", "nope", "--gate", "90");
  assert.equal(code, 1);
  assert.match(stderr, /claude, codex, copilot/);
});

test("a provider that cannot be read is unknown, never room to work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-empty-"));
  try {
    const result = spawnSync(process.execPath, [CLI, "--provider", "claude", "--gate", "90"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_RUNWAY_CACHE_DIR: dir,
        // No token anywhere, and forbidden from reading the machine's own.
        CLAUDE_CODE_OAUTH_TOKEN: "",
        AGENT_RUNWAY_TOKEN: "",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_SESSION_KEY: "",
        AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1",
      },
    });
    assert.equal(result.status, 11, "exit 11 is neither proceed nor defer");
    assert.equal(JSON.parse(result.stdout).overall.decision, "unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- json contract

test("every --json answer says which question it is answering", () => {
  const capacity = JSON.parse(run("--gate", "90").stdout);
  assert.equal(capacity.kind, "capacity");
  assert.equal(capacity.tool, "agent-runway");
  assert.ok(capacity.toolVersion, "a parser needs to know which contract it got");

  const usage = JSON.parse(run("--all", "--json").stdout);
  assert.equal(usage.kind, "usage");
  assert.ok(Array.isArray(usage.providers));
});

test("the envelope survives on every kind, whatever the payload holds", () => {
  // Written after the second collision, not the first. `version` was caught by
  // remembering that resolve reports a binary's version; `tool` was not, and
  // shipped - doctor's report had a `tool` object of its own that flattened
  // over the envelope's string. Checking one field on one command is what let
  // that through, so this checks every kind.
  const cases = [
    ["capacity", run("--gate", "90")],
    ["usage", run("--all", "--json")],
    ["models", run("--models", "--json")],
    ["doctor", run("doctor", "--json", OFFLINE)],
  ];

  for (const [kind, { stdout }] of cases) {
    const answer = JSON.parse(stdout);
    assert.equal(answer.kind, kind);
    assert.equal(answer.tool, "agent-runway", `${kind} lost the envelope's tool field`);
    assert.equal(typeof answer.toolVersion, "string", `${kind} lost toolVersion`);
    // The contract's own version, which is what a parser should gate on:
    // toolVersion moves whenever the code does, and says nothing about shape.
    assert.equal(answer.schemaVersion, 1, `${kind} lost schemaVersion`);
  }
});

test("the envelope never overwrites a version the payload was reporting", () => {
  // resolve answers with the version of the binary it found. An envelope field
  // called `version` flattened over it would turn "Codex 0.149.1" into the
  // version of this tool, which is the kind of wrong that reads as right.
  const { stdout } = run("resolve", "codex", "--json");
  const answer = JSON.parse(stdout);
  assert.equal(answer.kind, "resolve");
  assert.equal(answer.tool, "agent-runway");
  assert.notEqual(answer.toolVersion, undefined);
  if (answer.resolved) {
    assert.notEqual(answer.version, answer.toolVersion, "that is the binary's version, not ours");
  }
});

test("reading one provider and reading four describe a window the same way", () => {
  const many = JSON.parse(run("--all", "--json").stdout);
  const codex = many.providers.find((p) => p.provider === "codex");
  // The single-provider path used to dump the provider's own payload here,
  // which has none of these fields.
  for (const key of ["kind", "percentUsed", "entitled", "windowSource", "startsAt"]) {
    assert.ok(key in codex.windows[0], `normalized windows carry ${key}`);
  }
});

test("--help and --version stay plain text and exit clean", () => {
  const help = run("--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--provider/, "the new flag is documented");
  assert.match(help.stdout, /--any/);
  assert.equal(run("--version").code, 0);
});
