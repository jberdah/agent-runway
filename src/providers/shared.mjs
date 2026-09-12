// The normalized contract every provider adapter must produce.
//
// Four providers were probed to design this, and each reports "how full is it"
// differently: Claude and Codex give a percentage consumed, Copilot gives a
// percentage remaining plus raw counts, Antigravity gives a 0-1 fraction
// remaining plus credits. Adapters convert into one direction — percentUsed —
// and keep the raw numbers when a provider supplies them, because "200 of 2000
// chat requests" says more than "90%".

/** @typedef {"ok"|"no_credentials"|"not_installed"|"unreachable"|"error"} ProviderStatus */

export const UNKNOWN = null;

// ---------------------------------------------------------------- percentages

export const fromUsedPercent = (n) => clampPercent(n);
export const fromRemainingPercent = (n) => clampPercent(100 - n);
export const fromRemainingFraction = (f) => clampPercent(100 - f * 100);

/** Copilot-style: remaining out of an entitlement. */
export function fromCounts(remaining, entitlement) {
  if (!Number.isFinite(remaining) || !Number.isFinite(entitlement) || entitlement <= 0) return UNKNOWN;
  return clampPercent(100 - (remaining / entitlement) * 100);
}

function clampPercent(n) {
  if (!Number.isFinite(n)) return UNKNOWN;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// -------------------------------------------------------------------- windows

/**
 * One quota window, whatever its cadence.
 *
 * `kind` is an open string on purpose. Codex already exposes a field called
 * `additional_rate_limits`, and providers state they may add model- or
 * feature-scoped caps, so an unrecognised kind must survive to the caller
 * rather than be dropped.
 *
 * `startsAt` is only ever computed when `windowSeconds` is known, and
 * `windowSource` records whether the provider reported that duration (Codex) or
 * whether we inferred it (Claude). A caller can then choose to trust it or not.
 */
export function makeWindow({
  kind,
  label,
  percentUsed,
  resetsAt = null,
  windowSeconds = null,
  windowSource = null,
  remaining = null,
  entitlement = null,
  entitled = true,
  severity = null,
  model = null,
  unit = "requests",
}) {
  const startsAt =
    resetsAt && Number.isFinite(windowSeconds)
      ? new Date(Date.parse(resetsAt) - windowSeconds * 1000).toISOString()
      : null;

  return {
    kind,
    label: label ?? kind,
    percentUsed,
    remaining,
    entitlement,
    entitled,
    unit,
    resetsAt,
    windowSeconds,
    windowSource,
    startsAt,
    severity,
    model,
  };
}

/** Seconds until a window resets; null when unknown or already elapsed. */
export function secondsUntilReset(window, now = Date.now()) {
  if (!window?.resetsAt) return UNKNOWN;
  const delta = Math.round((Date.parse(window.resetsAt) - now) / 1000);
  return Number.isFinite(delta) ? delta : UNKNOWN;
}

/**
 * The window that will bite first: the most consumed one among those the
 * account is actually entitled to. A quota the plan does not include is not a
 * constraint, it is an absence — Copilot's free tier reports
 * premium_interactions at 0 of 0, which a naive reading calls "exhausted".
 */
export function bindingWindow(windows = []) {
  const real = windows.filter((w) => w.entitled && Number.isFinite(w.percentUsed));
  if (!real.length) return null;
  return real.reduce((worst, w) => (w.percentUsed > worst.percentUsed ? w : worst));
}

// ------------------------------------------------------------------- results

export function ok(provider, { plan = null, allowed = null, windows = [], detail = null }) {
  return { provider, status: "ok", plan, allowed, windows, detail, checkedAt: new Date().toISOString() };
}

export function unavailable(provider, status, detail) {
  return {
    provider,
    status,
    plan: null,
    allowed: null,
    windows: [],
    detail,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Identity fields travel in three of the four payloads (name, email, user id).
 * Adapters must never copy them into a result: `--json` output ends up in CI
 * logs and shared terminals.
 */
export const IDENTITY_KEYS = /^(email|name|user_?id|account_?id|login|analytics_tracking_id)$/i;
