// Core logic shared by the CLI, the Claude Code skill and the MCP server.
//
// Security invariant: this module never logs, prints or returns a token.
// Callers receive usage data only. Keep it that way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.3.0";

/**
 * The shape of what this tool answers, versioned separately from the tool.
 *
 * These are two different questions. A caller needs to know whether it can
 * still read the answer, not whether the code that produced it moved on: a
 * parser written against schema 1 should keep working across 0.9 and 2.0 as
 * long as the shape holds. Bumped only when a field is removed or changes
 * meaning — additions do not break a reader.
 */
export const SCHEMA_VERSION = 1;

const USER_AGENT = `agent-runway/${VERSION} (+https://github.com/jberdah/agent-runway)`;

/** Errors this module throws, with a stable `code` so callers can branch. */
export class UsageError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = "UsageError";
    this.code = code; // NO_TOKEN | AUTH | RATE_LIMITED | NO_RESPONSE | NETWORK
    this.hint = hint;
  }
}

const claudeDir = () => path.join(os.homedir(), ".claude");

function readCredentialsFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(claudeDir(), ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

function readTokenFile(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value.startsWith("sk-ant-") ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an OAuth token, most explicit source first.
 *
 * The last source is the token Claude Code keeps for its own session. It is a
 * convenience so the tool works with no setup, but it is not a stable contract:
 * on macOS the live token lives in the Keychain and on Windows in the Credential
 * Manager, so the file is frequently absent or stale. Set
 * AGENT_RUNWAY_NO_LOCAL_CREDENTIALS=1 to skip it entirely.
 *
 * @returns {{token: string, source: string, expiredAt: string|null}|null}
 */
export function resolveToken(env = process.env) {
  const fromEnv = [
    ["CLAUDE_CODE_OAUTH_TOKEN", "env CLAUDE_CODE_OAUTH_TOKEN"],
    ["AGENT_RUNWAY_TOKEN", "env AGENT_RUNWAY_TOKEN"],
    ["ANTHROPIC_AUTH_TOKEN", "env ANTHROPIC_AUTH_TOKEN"],
  ];
  for (const [name, source] of fromEnv) {
    if (env[name]) return { token: env[name], source, expiredAt: null };
  }

  const fileToken = readTokenFile(path.join(claudeDir(), "usage-token"));
  if (fileToken) return { token: fileToken, source: "~/.claude/usage-token", expiredAt: null };

  if (env.AGENT_RUNWAY_NO_LOCAL_CREDENTIALS === "1") return null;

  const oauth = readCredentialsFile()?.claudeAiOauth;
  if (oauth?.accessToken) {
    const expired = oauth.expiresAt && oauth.expiresAt < Date.now();
    return {
      token: oauth.accessToken,
      source: "~/.claude/.credentials.json",
      expiredAt: expired ? new Date(oauth.expiresAt).toISOString() : null,
    };
  }
  return null;
}

/**
 * The claude.ai web session cookie, for the organizations endpoint.
 *
 * A separate credential from the OAuth token, and the only one that endpoint
 * takes: it answers "This endpoint does not accept OAuth access tokens" to a
 * Bearer, whatever its scopes. Supply the value of the `sessionKey` cookie.
 *
 * Never harvested from a browser profile — the user pastes it, or does not.
 */
export function resolveCookie(env = process.env) {
  if (env.AGENT_RUNWAY_CLAUDE_COOKIE) {
    return { value: env.AGENT_RUNWAY_CLAUDE_COOKIE, source: "env AGENT_RUNWAY_CLAUDE_COOKIE" };
  }
  try {
    const value = fs.readFileSync(path.join(claudeDir(), "session-cookie"), "utf8").trim();
    if (value) return { value, source: "~/.claude/session-cookie" };
  } catch {
    /* absent is the normal case */
  }
  return null;
}

/** Organization UUID, needed only by the claude.ai endpoint. */
export function resolveOrgId(env = process.env) {
  return env.CLAUDE_ORG_ID || readCredentialsFile()?.organizationUuid || null;
}

async function request(url, authHeaders, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        ...authHeaders,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": USER_AGENT,
      },
    });
  } catch (cause) {
    throw new UsageError("NETWORK", `Could not reach ${new URL(url).host}: ${cause.message}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, ok: response.ok, body };
}

const WINDOW_LABELS = {
  session: "Session (5h)",
  weekly_all: "Weekly - all models",
  weekly_scoped: "Weekly",
};

/**
 * Flatten the API payload into a shape the three surfaces can share.
 *
 * The endpoints are internal and undocumented, so the canonical `limits` array
 * is used when present and a tolerant scan of the top-level window objects is
 * the fallback. Neither path is allowed to throw on an unexpected shape.
 */
export function normalize(payload) {
  const windows = [];

  if (Array.isArray(payload?.limits) && payload.limits.length) {
    for (const limit of payload.limits) {
      const model = limit.scope?.model?.display_name ?? null;
      const base = WINDOW_LABELS[limit.kind] ?? limit.kind;
      windows.push({
        id: limit.kind,
        label: model ? `${base} - ${model}` : base,
        percent: limit.percent,
        severity: limit.severity ?? "normal",
        resetsAt: limit.resets_at ?? null,
        active: Boolean(limit.is_active),
        model,
      });
    }
  } else if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (typeof value.utilization !== "number") continue;
      const percent = value.utilization > 0 && value.utilization <= 1
        ? value.utilization * 100
        : value.utilization;
      windows.push({
        id: key,
        label: WINDOW_LABELS[key] ?? key,
        percent: Math.round(percent),
        severity: "normal",
        resetsAt: value.resets_at ?? null,
        active: false,
        model: null,
      });
    }
  }

  const order = { session: 0, weekly_all: 1, weekly_scoped: 2 };
  windows.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9) || b.percent - a.percent);

  const extra = payload?.extra_usage;
  const extraUsage = extra && typeof extra === "object"
    ? {
        enabled: Boolean(extra.is_enabled),
        percent: typeof extra.utilization === "number"
          ? Math.round(extra.utilization > 1 ? extra.utilization : extra.utilization * 100)
          : null,
        monthlyLimit: extra.monthly_limit ?? null,
        currency: extra.currency ?? null,
        spendLimitReached: Boolean(extra.spend_limit_reached),
      }
    : null;

  return { windows, extraUsage };
}

// What to say when nothing can authenticate a request. Never `claude
// setup-token`: the token it mints lacks user:profile, which this project
// established by trying it, and pointing at it sends people down the one path
// already known to be closed.
const NO_CREDENTIAL_HINT =
  "Two credentials can read Claude usage, and `claude setup-token` mints neither -\n" +
  "the token it produces lacks the user:profile scope the endpoint requires.\n\n" +
  "  - Sign in to Claude Code, which keeps a session token carrying that scope.\n" +
  "    It is refreshed only while Claude Code runs, so it goes stale when idle.\n" +
  "  - Or paste your claude.ai sessionKey cookie into ~/.claude/session-cookie.\n" +
  "    This is the durable path: it keeps working while Claude Code is closed.\n\n" +
  "`agent-runway doctor` shows which sources were found and what each replied.";

/**
 * Fetch usage for the current account.
 *
 * @returns {Promise<{windows: Array, extraUsage: object|null, endpoint: string, credentialSource: string, raw: object}>}
 */
export async function fetchUsage({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = resolveToken(env);
  const cookie = resolveCookie(env);
  const orgId = resolveOrgId(env);

  // Each endpoint takes exactly one kind of credential, and is offered only
  // when that credential exists. Sending a Bearer to claude.ai is not a
  // fallback, it is a guaranteed 403 that adds a confusing second line to every
  // failure.
  //
  // The list is built from what is available rather than gated behind an OAuth
  // token: requiring one up front made the cookie unusable on its own, which is
  // precisely the case it exists for — reading usage while Claude Code is
  // closed, when no OAuth token is fresh.
  const endpoints = [];
  if (token) {
    endpoints.push({
      name: "oauth/usage",
      url: "https://api.anthropic.com/api/oauth/usage",
      headers: { Authorization: `Bearer ${token.token}` },
      credentialSource: token.source,
      expiredAt: token.expiredAt,
    });
  }
  if (cookie && orgId) {
    endpoints.push({
      name: "organizations/usage",
      url: `https://claude.ai/api/organizations/${orgId}/usage`,
      headers: { Cookie: `sessionKey=${cookie.value}` },
      credentialSource: cookie.source,
      expiredAt: null,
    });
  }

  if (!endpoints.length) {
    // Say which half is missing when one is present: "no org id" is a fix,
    // "no credential" is a guess.
    const detail =
      cookie && !orgId
        ? "A claude.ai session cookie was found, but not the organization id that endpoint needs."
        : "No Claude credential found.";
    throw new UsageError("NO_TOKEN", detail, NO_CREDENTIAL_HINT);
  }

  const failures = [];
  for (const endpoint of endpoints) {
    let result;
    try {
      result = await request(endpoint.url, endpoint.headers, fetchImpl);
    } catch (error) {
      // A fallback that cannot be reached must not bury what the primary
      // endpoint already answered. Record it and keep going; the verdict is
      // decided once every endpoint has had its turn.
      failures.push(`${endpoint.name} (${endpoint.credentialSource}): ${error.message}`);
      continue;
    }

    if (result.ok) {
      return {
        ...normalize(result.body),
        endpoint: endpoint.name,
        // The credential that actually worked, not the first one resolved.
        // Reporting the OAuth source for a request the cookie authenticated
        // made `doctor` wrong about the one thing it exists to answer.
        credentialSource: endpoint.credentialSource,
        raw: result.body,
      };
    }

    // Carry the API's own words through. A rejection that says which scope is
    // missing is worth far more than a bare "rejected", and this endpoint is
    // undocumented enough that its reasons are the only source available.
    const apiMessage =
      (result.body && typeof result.body === "object"
        ? result.body.error?.message ?? result.body.message ?? result.body.error?.type
        : null) || null;
    const expired = endpoint.expiredAt ? ` (credential expired at ${endpoint.expiredAt})` : "";
    failures.push(
      `${endpoint.name} (${endpoint.credentialSource}): HTTP ${result.status}` +
        `${apiMessage ? ` - ${apiMessage}` : ""}${expired}`
    );

    if (result.status === 429) {
      throw new UsageError(
        "RATE_LIMITED",
        "The usage endpoint itself is rate limiting these requests. This is not your account quota.",
        "Wait a few minutes before retrying. Do not poll in a loop."
      );
    }
  }

  const authFailed = failures.some((f) => /HTTP 40[13]/.test(f));
  if (authFailed) {
    const scopeProblem = failures.some((f) => /scope|permission/i.test(f));
    const tried = endpoints.length === 1 ? "The only credential available was rejected" : "Every credential was rejected";
    throw new UsageError(
      "AUTH",
      `${tried}.\n  ` + failures.join("\n  "),
      scopeProblem
        ? "That token is valid, but not for reading usage. The endpoint requires the\n" +
          "user:profile scope, and `claude setup-token` does not grant it - regenerating\n" +
          "the token produces exactly the same refusal.\n\n" +
          "The durable alternative is the claude.ai session cookie, which that endpoint\n" +
          "takes instead of a Bearer: paste it into ~/.claude/session-cookie. Codex,\n" +
          "Copilot and Antigravity are unaffected, having durable credentials of their own."
        : NO_CREDENTIAL_HINT
    );
  }
  const reachable = failures.some((f) => /HTTP \d/.test(f));
  throw new UsageError(
    "NO_RESPONSE",
    `No usage endpoint responded (${failures.join(", ")}).`,
    reachable ? undefined : "Every endpoint failed to connect. Check the network or a proxy."
  );
}
