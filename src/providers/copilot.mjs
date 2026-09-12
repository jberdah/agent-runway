// GitHub Copilot, through the GitHub CLI's stored credentials.
//
// Different model from the other three: a monthly allowance of requests rather
// than rolling time windows, reported as a percentage REMAINING plus raw
// counts. The trap is `has_quota: false` — on the free tier
// premium_interactions reads 0 of 0, which a naive percentage call "exhausted"
// when it actually means "not included in this plan".

import { spawnSync } from "node:child_process";

import { fromCounts, fromRemainingPercent, makeWindow, ok, unavailable } from "./shared.mjs";

export const id = "copilot";
export const label = "GitHub Copilot";

const IS_WINDOWS = process.platform === "win32";

const LABELS = {
  chat: "Chat requests",
  completions: "Completions",
  premium_interactions: "Premium requests",
};

/** `gh` holds the token; shelling out avoids ever touching it ourselves. */
function ghApi(endpoint, timeoutMs) {
  const base = { encoding: "utf-8", timeout: timeoutMs, windowsHide: true };
  const r = IS_WINDOWS
    ? spawnSync(`gh api ${endpoint}`, { ...base, shell: true })
    : spawnSync("gh", ["api", endpoint], base);

  if (r.error) return { ok: false, reason: r.error.code === "ENOENT" ? "not_installed" : "error" };
  if (r.status !== 0) {
    const err = (r.stderr ?? "").toLowerCase();
    if (err.includes("auth") || err.includes("401")) return { ok: false, reason: "no_credentials" };
    return { ok: false, reason: "unreachable", detail: (r.stderr ?? "").trim().slice(0, 120) };
  }
  try {
    return { ok: true, body: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, reason: "error", detail: "gh returned non-JSON" };
  }
}

export async function read({ timeoutMs = 15000, gh = ghApi } = {}) {
  const result = gh("copilot_internal/user", timeoutMs);
  if (!result.ok) {
    const hint = {
      not_installed: "the GitHub CLI is not installed",
      no_credentials: "not signed in - run `gh auth login`",
    }[result.reason];
    return unavailable(id, result.reason, hint ?? result.detail ?? "gh api failed");
  }

  const body = result.body ?? {};
  const snapshots = body.quota_snapshots ?? {};
  // Monthly, and reported once for the account rather than per quota.
  const resetsAt = body.quota_reset_date ? `${body.quota_reset_date}T00:00:00Z` : null;

  const windows = Object.entries(snapshots).map(([key, q]) => {
    const entitled = Boolean(q.has_quota) && !(q.entitlement === 0);
    const percentUsed = q.unlimited
      ? 0
      : Number.isFinite(q.percent_remaining)
        ? fromRemainingPercent(q.percent_remaining)
        : fromCounts(q.quota_remaining, q.entitlement);

    return makeWindow({
      kind: `monthly_${key}`,
      label: LABELS[key] ?? key.replace(/_/g, " "),
      percentUsed: entitled ? percentUsed : null,
      remaining: Number.isFinite(q.quota_remaining) ? q.quota_remaining : null,
      entitlement: Number.isFinite(q.entitlement) ? q.entitlement : null,
      entitled,
      resetsAt,
      windowSeconds: null, // a calendar month, not a fixed number of seconds
      unit: "requests",
    });
  });

  const overage = Object.values(snapshots).some((q) => q.overage_permitted);

  return ok(id, {
    plan: body.copilot_plan ?? null,
    windows,
    detail: overage ? "overage permitted" : null,
  });
}
