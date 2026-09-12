// The diagnostic's own contract: it has to say enough to fix a broken setup,
// and it has to be safe to paste into a public issue. Those two pull against
// each other, so the second is asserted rather than trusted.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-doctortest-"));
process.env.AGENT_RUNWAY_CACHE_DIR = CACHE_DIR;
after(() => fs.rmSync(CACHE_DIR, { recursive: true, force: true }));

const { diagnose, renderDoctor } = await import("../src/doctor.mjs");
const { makeWindow } = await import("../src/providers/shared.mjs");

// Distinctive enough that a substring search cannot miss them, and shaped like
// the real thing so the resolvers accept them.
const TOKEN = "sk-ant-oat01-DOCTORTESTTOKENVALUE";
const COOKIE = "sk-ant-sid01-DOCTORTESTCOOKIEVALUE";

const ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
  AGENT_RUNWAY_CLAUDE_COOKIE: COOKIE,
  CLAUDE_ORG_ID: "00000000-0000-0000-0000-000000000000",
  AGENT_RUNWAY_CACHE_DIR: CACHE_DIR,
};

const ok = (body) => async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
const PAYLOAD = {
  limits: [{ kind: "session", percent: 12, severity: "normal", resets_at: "2026-09-12T20:00:00Z", is_active: true }],
};

// Seed the other providers so the diagnostic never touches gh, a live IDE or
// the network for them.
for (const provider of ["codex", "copilot", "antigravity"]) {
  fs.writeFileSync(
    path.join(CACHE_DIR, `${provider}.json`),
    JSON.stringify({
      at: Date.now(),
      value: {
        provider,
        label: provider,
        status: "ok",
        plan: null,
        allowed: null,
        windows: [makeWindow({ kind: "session", percentUsed: 5 })],
        detail: null,
        checkedAt: new Date().toISOString(),
      },
    })
  );
}

test("a report never contains the credential it used", async () => {
  const report = await diagnose({ env: ENV, fetchImpl: ok(PAYLOAD) });

  const asJson = JSON.stringify(report);
  const asText = renderDoctor(report);

  for (const secret of [TOKEN, COOKIE]) {
    assert.ok(!asJson.includes(secret), "the structured report leaks a credential");
    assert.ok(!asText.includes(secret), "the printed report leaks a credential");
    // Not even a prefix: enough of a token to identify an account is enough to
    // matter, and a diagnostic gets pasted into issues.
    assert.ok(!asJson.includes(secret.slice(0, 20)), "a credential prefix survives in the report");
  }
});

test("it names the source that won, which is the whole point", async () => {
  const report = await diagnose({ env: ENV, fetchImpl: ok(PAYLOAD) });

  assert.equal(report.claude.token.found, true);
  assert.equal(report.claude.token.source, "env CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(report.claude.cookie.found, true);
  assert.equal(report.claude.cookie.source, "env AGENT_RUNWAY_CLAUDE_COOKIE");
  assert.equal(report.claude.attempt.ok, true);
  assert.equal(report.claude.attempt.endpoint, "oauth/usage");
});

test("it says which half of the claude.ai credential is missing", async () => {
  const noCookie = await diagnose({
    env: { ...ENV, AGENT_RUNWAY_CLAUDE_COOKIE: "" },
    fetchImpl: ok(PAYLOAD),
  });
  assert.equal(noCookie.claude.claudeAiEligible, false);
  assert.match(renderDoctor(noCookie), /not offered - no cookie/);

  const noOrg = await diagnose({ env: { ...ENV, CLAUDE_ORG_ID: "" }, fetchImpl: ok(PAYLOAD) });
  // The org id also has a file fallback, so only assert the branch that the
  // rendering has to distinguish when it is genuinely absent.
  if (!noOrg.claude.orgId.known) assert.match(renderDoctor(noOrg), /no org id/);
});

test("a rejection is reported with the API's own words, not a status word", async () => {
  const refuse = async () => ({
    status: 403,
    ok: false,
    text: async () => JSON.stringify({ error: { message: "OAuth token does not meet scope requirement user:profile" } }),
  });

  const report = await diagnose({ env: ENV, fetchImpl: refuse });
  assert.equal(report.claude.attempt.ok, false);
  assert.equal(report.claude.attempt.code, "AUTH");
  assert.match(report.claude.attempt.message, /user:profile/);
  assert.match(renderDoctor(report), /user:profile/);
});

test("a diagnostic never throws, whatever it finds", async () => {
  const explode = async () => {
    throw new Error("network is down");
  };
  const report = await diagnose({
    env: { AGENT_RUNWAY_CACHE_DIR: CACHE_DIR, AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1" },
    fetchImpl: explode,
  });
  assert.equal(report.claude.attempt.ok, false);
  assert.ok(renderDoctor(report).length > 0, "it still renders something usable");
});

test("a cached reading served after a failure is not shown as live", () => {
  // renderDoctor is pure, so the case the registry produces on a real failure
  // can be asserted without arranging that failure.
  const text = renderDoctor({
    tool: { version: "0.0.0", node: "v24", platform: "linux", home: "/home/x" },
    claude: {
      token: { found: true, source: "env X", expiredAt: null },
      cookie: { found: false, source: null },
      orgId: { known: true },
      claudeAiEligible: false,
      attempt: { ok: true, endpoint: "oauth/usage", tokenSource: "env X", windows: 3 },
    },
    providers: [
      { provider: "codex", status: "ok", stale: true, ageMs: 209_000, detail: "chatgpt.com unreachable" },
      { provider: "copilot", status: "ok", stale: false, ageMs: null, detail: null },
    ],
    cache: { dir: "/tmp/x", readings: [{ key: "codex", ageMs: 209_000 }], derivedCount: 17 },
  });

  assert.match(text, /codex\s+ok \[stale, 3m old\]/, "a stale reading must announce itself");
  assert.match(text, /copilot\s+ok$/m, "a live one must not");
  // The fingerprint-keyed caches are counted, not listed: twenty of them buried
  // the four that matter.
  assert.match(text, /17\s+model and version entries/);
});
