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
  assert.equal(fromRemainingFraction(1), 0, "a 0-1 fraction remaining, as Antigravity reported");
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

test("no recommendation is made across cadences that cannot be compared", () => {
  const decision = capacity(
    [
      reading("codex", [makeWindow({ kind: "session", percentUsed: 0, windowSeconds: 18000 })]),
      reading("copilot", [makeWindow({ kind: "monthly", percentUsed: 5 })]),
    ],
    { threshold: 90 }
  );

  // 0% of five hours is not 0% of a month. This used to name codex and set
  // comparable:false beside it, which is a caveat next to an answer - and a
  // field called `recommended` gets acted on while the caveat gets skimmed.
  assert.equal(decision.recommended, null);

  // The material is still there, one per cadence, so a caller that knows what
  // its own work will burn can choose.
  assert.equal(decision.candidates.length, 2);
  assert.deepEqual(decision.candidates.map((c) => c.provider).sort(), ["codex", "copilot"]);
});

test("a recommendation is made when the candidates really are comparable", () => {
  const decision = capacity(
    [
      reading("codex", [makeWindow({ kind: "session", percentUsed: 40, windowSeconds: 18000 })]),
      reading("claude", [makeWindow({ kind: "session", percentUsed: 8, windowSeconds: 18000 })]),
    ],
    { threshold: 90 }
  );

  assert.equal(decision.recommended.provider, "claude");
  assert.equal(decision.recommended.comparable, true);
  assert.match(decision.recommended.rule, /least consumed/);
  // One cadence, so one candidate: the best of that class.
  assert.equal(decision.candidates.length, 1);
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
      { provider: "copilot", label: "GitHub Copilot", status: "unreachable", windows: [], detail: "gh failed" },
    ],
    { threshold: 90 }
  );

  // The rule says "every READABLE provider", and a closed IDE is not a
  // readable provider under the threshold - it is outside the set.
  assert.equal(decision.overall.decision, "proceed");
  // But it is never silently dropped: a caller can see the answer rests on
  // three providers rather than four.
  assert.deepEqual(decision.overall.unreadable, ["copilot"]);
  assert.equal(decision.anyUnknown, true);
});

test("a known blocker outranks a provider that could not be read", () => {
  const decision = capacity(
    [
      reading("claude", [makeWindow({ kind: "session", percentUsed: 96 })]),
      { provider: "copilot", label: "GitHub Copilot", status: "unreachable", windows: [], detail: "gh failed" },
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

// ------------------------------------------- a cached reading after a failure

const stale = (provider, windows, ageMs = 59 * 60_000, extra = {}) =>
  reading(provider, windows, { stale: true, ageMs, detail: "serving a cached reading", ...extra });

test("a stale reading can never produce proceed", () => {
  // The scenario: read at 15% at 10:00, provider unreachable at 11:00, and by
  // then it is actually at 94%. The gate used to answer proceed from an
  // hour-old number, which is the one answer it must never give from data it
  // knows to be out of date.
  const decision = capacity(
    [
      stale("codex", [
        makeWindow({
          kind: "session",
          percentUsed: 15,
          windowSeconds: 18000,
          resetsAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      ]),
    ],
    { threshold: 90 }
  );

  const [only] = decision.providers;
  assert.equal(only.decision, "unknown");
  assert.equal(only.reason, "stale_cannot_show_room");
  assert.equal(only.staleMs, 59 * 60_000, "how far out of date it is travels with the answer");
  assert.equal(decision.overall.decision, "unknown");
});

test("a stale reading over the threshold still defers, and says when to retry", () => {
  // Deliberately NOT unknown. Consumption only rises inside a window, so an
  // hour-old 94% is still at least 94%: the constraint is real and the reset
  // time is actionable. Downgrading it to unknown would discard a true answer
  // in the name of caution.
  const resetsAt = new Date(Date.now() + 3600_000).toISOString();
  const decision = capacity(
    [stale("codex", [makeWindow({ kind: "session", percentUsed: 94, windowSeconds: 18000, resetsAt })])],
    { threshold: 90 }
  );

  const [only] = decision.providers;
  assert.equal(only.decision, "defer");
  assert.equal(only.stale, true, "still labelled, so a caller knows what it rests on");
  assert.equal(only.retryAt, resetsAt);
  assert.equal(only.retryAtBasis, "window_reset");
});

test("a stale reading whose window has since reset is unknown, not a defer", () => {
  // The number describes a window that no longer exists, so even the "it can
  // only have gone up" argument does not hold: it may well be at zero.
  const decision = capacity(
    [
      stale(
        "codex",
        [
          makeWindow({
            kind: "session",
            percentUsed: 94,
            windowSeconds: 18000,
            resetsAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ],
        6 * 3600_000
      ),
    ],
    { threshold: 90 }
  );

  const [only] = decision.providers;
  assert.equal(only.decision, "unknown");
  assert.equal(only.reason, "stale_window_already_reset");
});

test("a provider's own limit flag still counts when the reading is stale", () => {
  const decision = capacity(
    [
      stale(
        "codex",
        [makeWindow({ kind: "session", percentUsed: 4, resetsAt: new Date(Date.now() + 600_000).toISOString() })],
        5 * 60_000,
        { allowed: false }
      ),
    ],
    { threshold: 90 }
  );

  const [only] = decision.providers;
  assert.equal(only.decision, "defer", "the provider said no, and that does not expire upward");
  assert.equal(only.reason, "provider_says_limit_reached");
});

test("a stale provider is never recommended over a live one", () => {
  const decision = capacity(
    [
      stale("codex", [makeWindow({ kind: "session", percentUsed: 2, windowSeconds: 18000 })]),
      reading("claude", [makeWindow({ kind: "session", percentUsed: 40, windowSeconds: 18000 })]),
    ],
    { threshold: 90 }
  );

  // codex looks better on paper and cannot be vouched for.
  assert.equal(decision.recommended.provider, "claude");
  assert.deepEqual(decision.overall.unreadable, ["codex"]);
});

// --------------------------------------------------- the timeout that cancels

const { ADAPTERS } = await import("../src/providers/index.mjs");

test("the hard timeout cancels the adapter rather than abandoning it", async () => {
  let received = null;
  let cancelled = false;

  // An adapter that would take half a minute, and that honours its signal.
  ADAPTERS.slowtest = {
    label: "Slow test",
    read: async ({ signal }) => {
      received = signal;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
      return { provider: "slowtest", status: "ok", plan: null, allowed: null, windows: [], detail: null };
    },
  };

  try {
    const started = Date.now();
    const [result] = await readAll({ ...NO_CACHE, providers: ["slowtest"], hardTimeoutMs: 200 });
    const elapsed = Date.now() - started;

    assert.ok(received, "the adapter is handed a signal to honour");
    assert.equal(cancelled, true, "the timeout aborted the work, it did not merely stop waiting for it");
    assert.equal(result.status, "unreachable");
    assert.ok(elapsed < 5000, `returned in ${elapsed}ms`);
  } finally {
    delete ADAPTERS.slowtest;
  }
});

test("an answer that arrives in time still releases whatever is left running", async () => {
  let cancelled = false;

  // Answers immediately, then keeps something pending: an adapter can still be
  // trying a fallback endpoint after the first one replied.
  ADAPTERS.leaky = {
    label: "Leaky",
    read: async ({ signal }) => {
      signal?.addEventListener("abort", () => {
        cancelled = true;
      }, { once: true });
      return { provider: "leaky", status: "ok", plan: null, allowed: null, windows: [], detail: null };
    },
  };

  try {
    const [result] = await readAll({ ...NO_CACHE, providers: ["leaky"], hardTimeoutMs: 10_000 });
    assert.equal(result.status, "ok");
    assert.equal(cancelled, true, "success aborts too, so nothing is left holding a socket");
  } finally {
    delete ADAPTERS.leaky;
  }
});

test("every provider whose quota is read is one a caller can actually invoke", async () => {
  const { PROVIDER_IDS } = await import("../src/providers/index.mjs");
  const { SPAWNABLE } = await import("../src/models.mjs");

  // Antigravity was the counter-example, and it was worse than dead weight.
  // It is an IDE: not spawnable, and readable only while it is open - so the
  // number was available exactly when the IDE was already showing it, and
  // absent whenever a scheduled read would have needed it. Meanwhile capacity()
  // was free to name it as `recommended`, which is to say, to send work to
  // something that cannot take any.
  //
  // Reading quota for an agent nobody can delegate to is not extra coverage.
  // If a future provider genuinely warrants an exception, this test is where
  // that argument has to be made.
  for (const provider of PROVIDER_IDS) {
    assert.ok(SPAWNABLE.includes(provider), `${provider} has quota but cannot be spawned`);
  }
});
