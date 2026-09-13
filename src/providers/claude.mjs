// Claude Code / claude.ai subscription.
//
// Verified shape: a `limits` array of {kind, percent, severity, resets_at,
// scope, is_active}. Window durations are NOT reported, so they are inferred
// from the kind and marked as derived.

import { fetchUsage, UsageError } from "../core.mjs";
import { fromUsedPercent, makeWindow, ok, unavailable } from "./shared.mjs";

export const id = "claude";
export const label = "Claude";

// Not reported by the API. The field names (five_hour, seven_day) and the
// observed reset cadence support these, but they remain an inference.
const DERIVED_SECONDS = { session: 5 * 3600, weekly_all: 7 * 86400, weekly_scoped: 7 * 86400 };
const LABELS = { session: "Session (5h)", weekly_all: "Weekly - all models", weekly_scoped: "Weekly" };

/**
 * Core's reading, expressed in the shared window contract.
 *
 * Exported because the single-provider CLI path needs the same normalization
 * the registry gets: a caller parsing `--json` and one parsing `--gate` must
 * not receive two different descriptions of the same account.
 */
export function toWindows(usage) {
  return usage.windows.map((w) => {
    const seconds = DERIVED_SECONDS[w.id] ?? null;
    return makeWindow({
      kind: w.id,
      label: LABELS[w.id] ?? w.label,
      percentUsed: fromUsedPercent(w.percent),
      resetsAt: w.resetsAt,
      windowSeconds: seconds,
      windowSource: seconds ? "derived" : null,
      severity: w.severity,
      model: w.model,
    });
  });
}

export async function read({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000, signal } = {}) {
  let usage;
  try {
    usage = await fetchUsage({ env, fetchImpl, timeoutMs, signal });
  } catch (error) {
    if (error instanceof UsageError) {
      const status =
        error.code === "NO_TOKEN" ? "no_credentials"
        : error.code === "AUTH" ? "no_credentials"
        : "unreachable";
      return unavailable(id, status, error.message);
    }
    return unavailable(id, "error", String(error?.message ?? error));
  }

  const windows = toWindows(usage);

  // Extra credits mean a window at 100% is not necessarily a wall.
  const detail = usage.extraUsage?.enabled ? "extra usage credits enabled" : null;

  return ok(id, { windows, detail });
}
