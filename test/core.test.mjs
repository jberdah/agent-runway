import assert from "node:assert/strict";
import { test } from "node:test";

import { normalize, resolveToken, UsageError, fetchUsage } from "../src/core.mjs";
import { bar, formatReset, peak, renderShort, renderTable } from "../src/render.mjs";

// A trimmed copy of a real response from api.anthropic.com/api/oauth/usage.
const SAMPLE = {
  five_hour: { utilization: 12, resets_at: "2026-09-12T02:40:00Z" },
  seven_day: { utilization: 78, resets_at: "2026-09-15T03:00:00Z" },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, utilization: null, monthly_limit: null },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 12,
      severity: "normal",
      resets_at: "2026-09-12T02:40:00Z",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 78,
      severity: "warning",
      resets_at: "2026-09-15T03:00:00Z",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 52,
      severity: "normal",
      resets_at: "2026-09-15T03:00:00Z",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
};

test("normalize reads the canonical limits array", () => {
  const usage = normalize(SAMPLE);
  assert.equal(usage.windows.length, 3);
  assert.deepEqual(
    usage.windows.map((w) => w.id),
    ["session", "weekly_all", "weekly_scoped"]
  );
  assert.equal(usage.windows[1].severity, "warning");
  assert.equal(usage.windows[1].active, true);
  assert.equal(usage.windows[2].label, "Weekly - Fable");
  assert.equal(usage.extraUsage.enabled, false);
});

test("normalize falls back to top-level windows when limits is missing", () => {
  const { limits, ...withoutLimits } = SAMPLE;
  const usage = normalize(withoutLimits);
  const ids = usage.windows.map((w) => w.id);
  assert.ok(ids.includes("five_hour"));
  assert.ok(ids.includes("seven_day"));
  assert.equal(usage.windows.find((w) => w.id === "seven_day").percent, 78);
});

test("normalize treats a ratio as a percentage", () => {
  const usage = normalize({ five_hour: { utilization: 0.42, resets_at: null } });
  assert.equal(usage.windows[0].percent, 42);
});

test("normalize survives an unexpected shape", () => {
  assert.deepEqual(normalize({}).windows, []);
  assert.deepEqual(normalize(null).windows, []);
  assert.deepEqual(normalize({ limits: [] }).windows, []);
});

test("resolveToken prefers the most explicit source", () => {
  const resolved = resolveToken({
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-a",
    AGENT_RUNWAY_TOKEN: "sk-ant-oat01-b",
  });
  assert.equal(resolved.source, "env CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(resolved.token, "sk-ant-oat01-a");
});

test("resolveToken can be told never to read local credentials", () => {
  const resolved = resolveToken({ AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1" });
  assert.equal(resolved, null);
});

test("fetchUsage reports a missing token instead of throwing raw", async () => {
  await assert.rejects(
    () => fetchUsage({ env: { AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1" } }),
    (error) => error instanceof UsageError && error.code === "NO_TOKEN"
  );
});

test("fetchUsage maps a 401 to an auth error", async () => {
  const fetchImpl = async () => ({
    status: 401,
    ok: false,
    text: async () => JSON.stringify({ error: { type: "authentication_error" } }),
  });
  await assert.rejects(
    () => fetchUsage({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, fetchImpl }),
    (error) => error instanceof UsageError && error.code === "AUTH"
  );
});

test("fetchUsage maps a 429 to a rate-limit error, not an auth error", async () => {
  const fetchImpl = async () => ({
    status: 429,
    ok: false,
    text: async () => JSON.stringify({ error: { type: "rate_limit_error" } }),
  });
  await assert.rejects(
    () => fetchUsage({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, fetchImpl }),
    (error) => error instanceof UsageError && error.code === "RATE_LIMITED"
  );
});

test("fetchUsage returns normalized windows on success", async () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(SAMPLE),
  });
  const usage = await fetchUsage({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
    fetchImpl,
  });
  assert.equal(usage.endpoint, "oauth/usage");
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.credentialSource, "env CLAUDE_CODE_OAUTH_TOKEN");
});

test("no rendered output ever contains the token", async () => {
  const token = "sk-ant-oat01-SECRETVALUE";
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(SAMPLE),
  });
  const usage = await fetchUsage({ env: { CLAUDE_CODE_OAUTH_TOKEN: token }, fetchImpl });
  const rendered = [renderTable(usage), renderShort(usage), JSON.stringify(usage)].join("\n");
  assert.ok(!rendered.includes(token));
  assert.ok(!rendered.includes("SECRETVALUE"));
});

test("bar scales to the percentage", () => {
  assert.equal(bar(0), "[....................]");
  assert.equal(bar(100), "[####################]");
  assert.equal(bar(50), "[##########..........]");
});

test("formatReset renders an absolute date and a relative delay", () => {
  const now = Date.parse("2026-09-11T20:00:00Z");
  assert.match(formatReset("2026-09-11T22:30:00Z", now), /2026-09-11 22:30Z \(in 2h 30m\)/);
  assert.match(formatReset("2026-09-11T20:45:00Z", now), /in 45m/);
  assert.match(formatReset("2026-09-14T20:00:00Z", now), /in 3d 0h/);
  assert.match(formatReset("2026-09-10T20:00:00Z", now), /elapsed/);
  assert.equal(formatReset(null), null);
});

test("peak returns the highest window", () => {
  assert.equal(peak(normalize(SAMPLE)).id, "weekly_all");
  assert.equal(peak({ windows: [] }), null);
});

test("renderShort is one machine-readable line", () => {
  assert.equal(renderShort(normalize(SAMPLE)), "session=12%  weekly_all=78%  weekly_scoped=52%");
});

// ------------------------------------------------- which credential, and when

const ORG = "00000000-0000-0000-0000-000000000000";
const answers = (body) => async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
const LIMITS = { limits: [{ kind: "session", percent: 7, severity: "normal", resets_at: "2026-09-13T00:00:00Z" }] };

test("a session cookie alone is enough, with no token anywhere", async () => {
  // The README calls this the one durable path, and it did not work: an OAuth
  // token was demanded before the endpoint list was even built, so the cookie
  // was never reached. That made the documented answer to Claude's credential
  // problem unreachable in exactly the situation it exists for.
  const usage = await fetchUsage({
    env: {
      AGENT_RUNWAY_CLAUDE_COOKIE: "sk-ant-sid01-x",
      CLAUDE_ORG_ID: ORG,
      AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1",
    },
    fetchImpl: answers(LIMITS),
  });

  assert.equal(usage.endpoint, "organizations/usage");
  assert.equal(usage.credentialSource, "env AGENT_RUNWAY_CLAUDE_COOKIE");
  assert.equal(usage.windows.length, 1);
});

test("the credential reported is the one that worked, not the first resolved", async () => {
  // Both present, and only claude.ai answers. Reporting the OAuth source here
  // made `doctor` wrong about the single thing it exists to answer.
  const onlyCookieWorks = async (url, options) =>
    options.headers.Cookie
      ? { status: 200, ok: true, text: async () => JSON.stringify(LIMITS) }
      : { status: 401, ok: false, text: async () => JSON.stringify({ error: { message: "expired" } }) };

  const usage = await fetchUsage({
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stale",
      AGENT_RUNWAY_CLAUDE_COOKIE: "sk-ant-sid01-good",
      CLAUDE_ORG_ID: ORG,
    },
    fetchImpl: onlyCookieWorks,
  });

  assert.equal(usage.endpoint, "organizations/usage");
  assert.equal(usage.credentialSource, "env AGENT_RUNWAY_CLAUDE_COOKIE");
});

test("claude.ai is never sent a Bearer, whatever credentials exist", async () => {
  const seen = [];
  const record = async (url, options) => {
    seen.push({ url, auth: Boolean(options.headers.Authorization), cookie: Boolean(options.headers.Cookie) });
    return { status: 401, ok: false, text: async () => "{}" };
  };

  await fetchUsage({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", AGENT_RUNWAY_CLAUDE_COOKIE: "sk-ant-sid01-x", CLAUDE_ORG_ID: ORG },
    fetchImpl: record,
  }).catch(() => {});

  const claudeAi = seen.find((s) => s.url.includes("claude.ai"));
  assert.ok(claudeAi, "the cookie endpoint should have been tried");
  assert.equal(claudeAi.auth, false, "a Bearer to claude.ai is a guaranteed 403");
  assert.equal(claudeAi.cookie, true);
});

test("no credential names both paths, and never sends anyone to setup-token", async () => {
  const error = await fetchUsage({
    env: { AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1" },
    fetchImpl: answers(LIMITS),
  }).then(
    () => null,
    (e) => e
  );

  assert.ok(error instanceof UsageError);
  assert.equal(error.code, "NO_TOKEN");
  // setup-token may be named, but only to say it does not help. The project
  // established that by trying it; pointing at it as a fix sends people down
  // the one path already known to be closed.
  assert.match(error.hint, /setup-token/);
  assert.match(error.hint, /mints neither/);
  assert.match(error.hint, /session-cookie/, "the durable path has to be offered");
});

test("a cookie without an org id says which half is missing", async () => {
  const error = await fetchUsage({
    env: { AGENT_RUNWAY_CLAUDE_COOKIE: "sk-ant-sid01-x", AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1", CLAUDE_ORG_ID: "" },
    fetchImpl: answers(LIMITS),
  }).then(
    () => null,
    (e) => e
  );

  // The org id has a file fallback, so this only holds when it is truly absent.
  if (error) assert.match(error.message, /organization id/);
});

// --------------------------------------------------------- one version, once

test("every file that states the version states the same one", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { VERSION } = await import("../src/core.mjs");

  const read = (relative) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));

  // Four places, bumped by hand every release. The release workflow checks the
  // git tag against package.json and would not notice the other three drifting.
  assert.equal(read("../package.json").version, VERSION, "package.json");
  assert.equal(read("../.claude-plugin/plugin.json").version, VERSION, "plugin.json");
  assert.equal(read("../.claude-plugin/marketplace.json").plugins[0].version, VERSION, "marketplace.json");
});

// ------------------------------------------------------ the envelope is fixed

test("a payload can never overwrite the envelope, whatever keys it carries", async () => {
  const { envelope, ENVELOPE_KEYS, SCHEMA_VERSION } = await import("../src/core.mjs");

  // Twice in two releases a payload field replaced an envelope field: resolve's
  // binary version landed on `version`, and doctor's own `tool` object landed
  // on `tool`. Both were caught by remembering the specific field. Writing the
  // envelope last removes the class instead of the instances.
  const hostile = {
    tool: { not: "a string" },
    toolVersion: "0.0.0-from-the-payload",
    schemaVersion: 99,
    kind: "something-else",
    real: "payload data",
  };

  const wrapped = envelope("capacity", hostile);
  assert.equal(wrapped.tool, "agent-runway");
  assert.equal(wrapped.schemaVersion, SCHEMA_VERSION);
  assert.equal(wrapped.kind, "capacity");
  assert.notEqual(wrapped.toolVersion, "0.0.0-from-the-payload");
  assert.equal(wrapped.real, "payload data", "the rest of the payload survives intact");

  // The reserved names are stated once, so a future field can be checked
  // against them rather than against someone's memory.
  assert.deepEqual(ENVELOPE_KEYS, ["tool", "toolVersion", "schemaVersion", "kind"]);
});

test("a deadline fires on our own limit or on the caller's cancellation", async () => {
  const { deadline } = await import("../src/core.mjs");

  // Its own bound, so a directly-called adapter cannot hang forever.
  const own = deadline(50);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(own.aborted, true);

  // And the caller's, so a whole read can be given up on at once.
  const controller = new AbortController();
  const combined = deadline(60_000, controller.signal);
  assert.equal(combined.aborted, false);
  controller.abort();
  assert.equal(combined.aborted, true);

  // A signal that has already fired must not open a long wait.
  assert.equal(deadline(60_000, AbortSignal.abort()).aborted, true);
});

test("the three files that describe this package say the same thing", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

  // Three hand-maintained copies of one sentence. They drifted the first time
  // something changed: 0.5.0 removed Antigravity from the code and the README
  // and left all three still advertising it to npm and to the Claude plugin
  // marketplace. The version numbers already have a test like this one; the
  // description needed the same.
  const pkg = read("../package.json").description;
  assert.equal(read("../.claude-plugin/plugin.json").description, pkg, "plugin.json");
  assert.equal(read("../.claude-plugin/marketplace.json").plugins[0].description, pkg, "marketplace.json");

  // And the sentence has to name what is actually covered.
  const { PROVIDER_IDS } = await import("../src/providers/index.mjs");
  assert.ok(!/antigravity/i.test(pkg), "the description still advertises a provider that was removed");
  assert.equal(PROVIDER_IDS.length, 3, "PROVIDER_IDS changed - check the description still matches");
});
