import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Isolate the cache before anything imports it: readAll writes on success, and
// these tests feed adapters fabricated payloads.
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-provtest-"));
process.env.AGENT_RUNWAY_CACHE_DIR = CACHE_DIR;
after(() => fs.rmSync(CACHE_DIR, { recursive: true, force: true }));

const { bindingWindow, fromCounts, fromRemainingFraction, fromRemainingPercent, fromUsedPercent, makeWindow } =
  await import("../src/providers/shared.mjs");
const { capacity, readAll } = await import("../src/providers/index.mjs");
const codex = await import("../src/providers/codex.mjs");
const copilot = await import("../src/providers/copilot.mjs");
const claude = await import("../src/providers/claude.mjs");

const NO_CACHE = { cacheMs: 0 };
const ok = (body) => async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });

// ------------------------------------------------- the four percent dialects

test("every provider's way of saying how full it is converges on percent used", () => {
  assert.equal(fromUsedPercent(78), 78, "Claude and Codex report consumption");
  assert.equal(fromRemainingPercent(100), 0, "Copilot reports what is left");
  assert.equal(fromRemainingPercent(10), 90);
  assert.equal(fromRemainingFraction(1), 0, "Antigravity reports a 0-1 fraction left");
  assert.equal(fromRemainingFraction(0.25), 75);
  assert.equal(fromCounts(200, 2000), 90, "raw counts, when that is all there is");
});

test("a nonsensical input is null, never a misleading zero", () => {
  assert.equal(fromUsedPercent(undefined), null);
  assert.equal(fromCounts(5, 0), null, "no entitlement is not an empty quota");
  assert.equal(fromCounts(NaN, 10), null);
  assert.equal(fromUsedPercent(140), 100, "clamped rather than reported as over");
});

test("startsAt is derived only when the window length is known", () => {
  const reported = makeWindow({
    kind: "session", percentUsed: 10,
    resetsAt: "2026-09-12T14:00:00.000Z", windowSeconds: 18000, windowSource: "reported",
  });
  assert.equal(reported.startsAt, "2026-09-12T09:00:00.000Z");

  const unknown = makeWindow({ kind: "monthly", percentUsed: 10, resetsAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(unknown.startsAt, null, "a calendar month has no fixed number of seconds");
});

test("the binding window ignores quotas the plan does not include", () => {
  const windows = [
    makeWindow({ kind: "session", percentUsed: 12 }),
    // Copilot's free tier: 0 of 0 premium requests. Read naively this is the
    // fullest window on the account, and it is not a constraint at all.
    makeWindow({ kind: "premium", percentUsed: null, entitled: false }),
    makeWindow({ kind: "weekly", percentUsed: 87 }),
  ];
  assert.equal(bindingWindow(windows).kind, "weekly");
  assert.equal(bindingWindow([]), null);
  assert.equal(bindingWindow(windows.filter((w) => !w.entitled)), null);
});

// ------------------------------------------------------------------ adapters

test("codex keeps the window length the provider reports", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "x", account_id: "y" } })
  );
  try {
    const result = await codex.read({
      home,
      fetchImpl: ok({
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1789222687 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1789700000 },
        },
      }),
    });

    assert.equal(result.status, "ok");
    assert.equal(result.plan, "plus");
    assert.equal(result.allowed, true, "Codex answers the gate question itself");
    const session = result.windows.find((w) => w.kind === "session");
    assert.equal(session.percentUsed, 12);
    assert.equal(session.windowSeconds, 18000);
    assert.equal(session.windowSource, "reported", "not inferred from a field name");
    assert.ok(session.startsAt, "a reported length makes the start computable");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("codex says no_credentials rather than failing obscurely", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
  try {
    const result = await codex.read({ home, fetchImpl: ok({}) });
    assert.equal(result.status, "no_credentials");
    assert.match(result.detail, /codex login/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("copilot distinguishes a quota not included from one exhausted", async () => {
  const gh = () => ({
    ok: true,
    body: {
      copilot_plan: "individual",
      quota_reset_date: "2026-10-01",
      quota_snapshots: {
        chat: { percent_remaining: 100, quota_remaining: 200, entitlement: 200, has_quota: true },
        completions: { percent_remaining: 25, quota_remaining: 500, entitlement: 2000, has_quota: true },
        // The trap: 0 of 0 on the free tier.
        premium_interactions: { percent_remaining: 0, quota_remaining: 0, entitlement: 0, has_quota: false },
      },
    },
  });

  const result = await copilot.read({ gh });
  assert.equal(result.status, "ok");

  const premium = result.windows.find((w) => w.kind === "monthly_premium_interactions");
  assert.equal(premium.entitled, false);
  assert.equal(premium.percentUsed, null, "not 100%, which would read as exhausted");

  const completions = result.windows.find((w) => w.kind === "monthly_completions");
  assert.equal(completions.percentUsed, 75, "remaining is inverted into used");
  assert.equal(completions.remaining, 500, "raw counts survive, they say more than a percentage");
  assert.equal(bindingWindow(result.windows).kind, "monthly_completions");
});

test("copilot reports a missing gh as not_installed", async () => {
  const result = await copilot.read({ gh: () => ({ ok: false, reason: "not_installed" }) });
  assert.equal(result.status, "not_installed");
});

test("claude marks its window lengths as derived, because they are", async () => {
  const result = await claude.read({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
    fetchImpl: ok({
      limits: [
        { kind: "session", percent: 3, severity: "normal", resets_at: "2026-09-12T14:00:00Z", is_active: false },
        { kind: "weekly_all", percent: 87, severity: "warning", resets_at: "2026-09-15T03:00:00Z", is_active: true },
      ],
    }),
  });

  assert.equal(result.status, "ok");
  const session = result.windows.find((w) => w.kind === "session");
  assert.equal(session.windowSource, "derived", "Claude never reports a window length");
  assert.equal(bindingWindow(result.windows).kind, "weekly_all");
});

// ------------------------------------------------------------------ registry

test("one provider's failure never costs the others their answer", async () => {
  const results = await readAll({ ...NO_CACHE, providers: ["codex", "copilot"], home: "/nonexistent" });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => typeof r.status === "string"), "a status, never a thrown error");
});

test("an unknown provider is a status, not a crash", async () => {
  const [result] = await readAll({ ...NO_CACHE, providers: ["nope"] });
  assert.equal(result.status, "error");
  assert.match(result.detail, /unknown provider/);
});

// ------------------------------------------------------------------ decision

const reading = (provider, windows, extra = {}) => ({
  provider, label: provider, status: "ok", windows, allowed: null, ...extra,
});

test("capacity answers proceed, defer or unknown", () => {
  const decision = capacity(
    [
      reading("a", [makeWindow({ kind: "session", percentUsed: 10, windowSeconds: 18000 })]),
      reading("b", [makeWindow({ kind: "weekly", percentUsed: 95, resetsAt: "2026-09-15T03:00:00Z" })]),
      { provider: "c", label: "c", status: "unreachable", windows: [], detail: "IDE closed" },
    ],
    { threshold: 90 }
  );

  const by = Object.fromEntries(decision.providers.map((p) => [p.provider, p]));
  assert.equal(by.a.decision, "proceed");
  assert.equal(by.b.decision, "defer");
  assert.equal(by.b.retryAtBasis, "window_reset", "a reset is not a promise service resumes");
  // A provider that cannot be read is not fine and is not blocked.
  assert.equal(by.c.decision, "unknown");
  assert.equal(decision.anyUnknown, true);
  assert.equal(decision.recommended.provider, "a");
});

test("a provider's own limit flag outranks our reading of a percentage", () => {
  const decision = capacity(
    [reading("codex", [makeWindow({ kind: "session", percentUsed: 4, resetsAt: "2026-09-12T14:00:00Z" })], { allowed: false })],
    { threshold: 90 }
  );
  const [only] = decision.providers;
  assert.equal(only.decision, "defer", "4% consumed, and the provider still says no");
  assert.equal(only.reason, "provider_says_limit_reached");
});

test("a recommendation across different cadences declares itself incomparable", () => {
  const decision = capacity(
    [
      reading("codex", [makeWindow({ kind: "session", percentUsed: 0, windowSeconds: 18000 })]),
      reading("copilot", [makeWindow({ kind: "monthly", percentUsed: 5 })]),
    ],
    { threshold: 90 }
  );
  assert.equal(decision.recommended.provider, "codex");
  // 0% of five hours is not 0% of a month, and the caller has to know that.
  assert.equal(decision.recommended.comparable, false);
  assert.match(decision.recommended.rule, /least consumed/);
});

test("no usable provider yields no recommendation rather than a bad one", () => {
  const decision = capacity(
    [{ provider: "a", label: "a", status: "no_credentials", windows: [], detail: "" }],
    { threshold: 90 }
  );
  assert.equal(decision.recommended, null);
});

test("a start is only derived from a window that is actually running", () => {
  const now = Date.now();

  // Codex at 0% answers with the whole window ahead: reset = now + 18000s.
  // Subtracting the duration yields "now", which would read as a window that
  // just began when none has.
  const notStarted = makeWindow({
    kind: "session", percentUsed: 0, windowSeconds: 18000,
    resetsAt: new Date(now + 18000 * 1000).toISOString(),
  });
  assert.equal(notStarted.startsAt, null, "an unknowable start is withheld, not invented");

  // A window well into its life does have a knowable start.
  const running = makeWindow({
    kind: "session", percentUsed: 40, windowSeconds: 18000,
    resetsAt: new Date(now + 3600 * 1000).toISOString(),
  });
  assert.ok(running.startsAt, "a window with time already elapsed reports its start");
  assert.ok(Date.parse(running.startsAt) < now);
});

test("the two questions a gate can be asked give different answers", () => {
  const results = [
    reading("claude", [makeWindow({ kind: "session", percentUsed: 96 })]),
    reading("codex", [makeWindow({ kind: "session", percentUsed: 10 })]),
  ];

  // "Can I keep working" - one provider out of room stops the answer.
  const conservative = capacity(results, { threshold: 90 });
  assert.equal(conservative.overall.decision, "defer");
  assert.equal(conservative.overall.rule, "all");

  // "Could anything on this machine take the job" - a different question, and
  // it has to be asked by name rather than arrived at by default.
  const fanOut = capacity(results, { threshold: 90, rule: "any" });
  assert.equal(fanOut.overall.decision, "proceed");
  assert.equal(fanOut.overall.scoped, null);
});

test("a provider that could not be read does not block the ones that could", () => {
  const decision = capacity(
    [
      reading("claude", [makeWindow({ kind: "session", percentUsed: 10 })]),
      reading("codex", [makeWindow({ kind: "session", percentUsed: 4 })]),
      // The everyday case on this machine: the IDE is simply not open.
      { provider: "antigravity", label: "Antigravity", status: "unreachable", windows: [], detail: "IDE closed" },
    ],
    { threshold: 90 }
  );

  // The rule says "every READABLE provider", and a closed IDE is not a
  // readable provider under the threshold - it is outside the set.
  assert.equal(decision.overall.decision, "proceed");
  // But it is never silently dropped: a caller can see the answer rests on
  // three providers rather than four.
  assert.deepEqual(decision.overall.unreadable, ["antigravity"]);
  assert.equal(decision.anyUnknown, true);
});

test("a known blocker outranks a provider that could not be read", () => {
  const decision = capacity(
    [
      reading("claude", [makeWindow({ kind: "session", percentUsed: 96 })]),
      { provider: "antigravity", label: "Antigravity", status: "unreachable", windows: [], detail: "IDE closed" },
    ],
    { threshold: 90 }
  );
  // Both stop the work, but "blocked until 14:00" is actionable where "could
  // not tell" is not, so the answer names the one the caller can act on.
  assert.equal(decision.overall.decision, "defer");
});

test("nothing readable at all is unknown, never proceed", () => {
  const decision = capacity(
    [{ provider: "a", label: "a", status: "no_credentials", windows: [], detail: "" }],
    { threshold: 90 }
  );
  assert.equal(decision.overall.decision, "unknown");
  assert.equal(capacity([], { threshold: 90 }).overall.decision, "unknown");
});

test("a single provider names itself as the scope of the answer", () => {
  const decision = capacity([reading("codex", [makeWindow({ kind: "session", percentUsed: 10 })])], { threshold: 90 });
  assert.equal(decision.overall.scoped, "codex");
  assert.equal(decision.overall.decision, "proceed");
});

test("capacity carries every window, not only the binding one", () => {
  const windows = [
    makeWindow({ kind: "session", percentUsed: 0 }),
    makeWindow({ kind: "weekly", percentUsed: 89 }),
  ];
  const decision = capacity([
    { provider: "claude", label: "Claude", status: "ok", allowed: null, windows },
  ], { threshold: 90 });

  const [only] = decision.providers;
  assert.equal(only.binding.kind, "weekly", "the decision still rests on the binding window");
  // A session at 0% beside a weekly at 89% is not a session at 0% alone.
  assert.equal(only.windows.length, 2);
  assert.deepEqual(only.windows.map((w) => w.kind), ["session", "weekly"]);
});
