// OpenAI Codex, via the ChatGPT backend.
//
// The best-instrumented of the four: it reports the window duration
// (limit_window_seconds) rather than making us infer it, and exposes `allowed`
// and `limit_reached` directly, which is a real gate signal instead of a
// percentage we have to interpret.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deadline } from "../core.mjs";
import { fromUsedPercent, makeWindow, ok, unavailable } from "./shared.mjs";

export const id = "codex";
export const label = "OpenAI Codex";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/usage";

const WINDOW_LABELS = {
  primary_window: "Session",
  secondary_window: "Weekly",
};

function readAuth(home) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
    const token = auth?.tokens?.access_token;
    const account = auth?.tokens?.account_id;
    return token && account ? { token, account } : null;
  } catch {
    return null;
  }
}

export async function read({
  home = os.homedir(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  signal,
} = {}) {
  const auth = readAuth(home);
  if (!auth) {
    return unavailable(id, "no_credentials", "~/.codex/auth.json missing or incomplete - run `codex login`");
  }

  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "chatgpt-account-id": auth.account,
        Accept: "application/json",
        // Without a User-Agent, Cloudflare answers with an HTML challenge page
        // instead of JSON. Found the hard way.
        "User-Agent": "agent-runway",
      },
      signal: deadline(timeoutMs, signal),
    });
  } catch (error) {
    return unavailable(id, "unreachable", `chatgpt.com unreachable: ${error?.message ?? error}`);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return unavailable(id, "unreachable", `expected JSON, got ${response.status} ${text.slice(0, 60)}`);
  }

  if (response.status === 401 || response.status === 403) {
    return unavailable(id, "no_credentials", "token rejected - run `codex login`");
  }
  if (!response.ok) {
    return unavailable(id, "error", `HTTP ${response.status}`);
  }

  const rate = body.rate_limit ?? {};
  const windows = [];

  for (const key of ["primary_window", "secondary_window"]) {
    const w = rate[key];
    if (!w) continue;
    windows.push(
      makeWindow({
        kind: key === "primary_window" ? "session" : "weekly_all",
        label: WINDOW_LABELS[key],
        percentUsed: fromUsedPercent(w.used_percent),
        resetsAt: Number.isFinite(w.reset_at) ? new Date(w.reset_at * 1000).toISOString() : null,
        windowSeconds: w.limit_window_seconds ?? null,
        // Reported by the provider, not inferred from a field name.
        windowSource: w.limit_window_seconds ? "reported" : null,
      })
    );
  }

  // Any further caps the account carries. Kept rather than dropped: the field
  // exists precisely because the set is not fixed.
  for (const [key, w] of Object.entries(rate.additional_rate_limits ?? {})) {
    if (!w || !Number.isFinite(w.used_percent)) continue;
    windows.push(
      makeWindow({
        kind: key,
        label: key.replace(/_/g, " "),
        percentUsed: fromUsedPercent(w.used_percent),
        resetsAt: Number.isFinite(w.reset_at) ? new Date(w.reset_at * 1000).toISOString() : null,
        windowSeconds: w.limit_window_seconds ?? null,
        windowSource: w.limit_window_seconds ? "reported" : null,
      })
    );
  }

  return ok(id, {
    plan: body.plan_type ?? null,
    // The only provider that answers "can I proceed" without us inferring it.
    allowed: typeof rate.allowed === "boolean" ? rate.allowed : null,
    windows,
    detail: rate.limit_reached ? "limit reached" : null,
  });
}
