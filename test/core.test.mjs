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
    CLAUDE_USAGE_TOKEN: "sk-ant-oat01-b",
  });
  assert.equal(resolved.source, "env CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(resolved.token, "sk-ant-oat01-a");
});

test("resolveToken can be told never to read local credentials", () => {
  const resolved = resolveToken({ CLAUDE_USAGE_NO_LOCAL_CREDENTIALS: "1" });
  assert.equal(resolved, null);
});

test("fetchUsage reports a missing token instead of throwing raw", async () => {
  await assert.rejects(
    () => fetchUsage({ env: { CLAUDE_USAGE_NO_LOCAL_CREDENTIALS: "1" } }),
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
  assert.equal(usage.tokenSource, "env CLAUDE_CODE_OAUTH_TOKEN");
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
