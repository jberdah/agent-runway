// Which coding agents are on this machine, and can we read their quota?
//
// Used by `setup` to offer a menu rather than making the user name providers.
// It is deliberately NOT on the read path: to fetch a quota, what matters is
// whether working credentials exist, which the provider adapter discovers by
// trying. Detection is a convenience for setup, never a precondition.
//
// The platform quirks below were solved first in brainclaw
// (https://github.com/jberdah/brainclaw, src/core/agent-inventory.ts) and are
// reimplemented here rather than imported: that package declares no public
// exports and carries runtime dependencies, while this one must keep none so a
// Claude Code plugin installed from git works without npm install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

// A cold-start CLI can take several seconds to answer --version; 3s produced
// false negatives. Version capture is slow and optional, so give it room.
const VERSION_TIMEOUT_MS = 8000;
const PATH_TIMEOUT_MS = 3000;

// windowsHide keeps a console window from flashing on every probe on Windows.
const SPAWN_BASE = { encoding: "utf-8", windowsHide: true };

/** Cheap: does the binary resolve on PATH? No process is launched. */
export function isOnPath(binary, platform = process.platform) {
  if (!binary) return false;
  try {
    const which = platform === "win32" ? "where" : "which";
    const r = spawnSync(which, [binary], { ...SPAWN_BASE, timeout: PATH_TIMEOUT_MS });
    return r.status === 0 && (r.stdout ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

// Only these may ever be handed to a shell. The list is closed so that adding a
// provider later cannot turn probeVersion into a command-injection sink.
const VERSION_PROBE_ALLOWED = new Set(["claude", "codex", "gh"]);

/** Expensive: run --version. Only for display, never for the installed decision. */
function probeVersion(binary) {
  if (!VERSION_PROBE_ALLOWED.has(binary)) return null;
  try {
    // Windows needs a shell because these are .cmd shims, and a single command
    // string rather than an args array, since passing args alongside
    // shell: true concatenates them unescaped (Node DEP0190). POSIX needs
    // neither, so it never touches a shell at all.
    const r = IS_WINDOWS
      ? spawnSync(`${binary} --version`, { ...SPAWN_BASE, timeout: VERSION_TIMEOUT_MS, shell: true })
      : spawnSync(binary, ["--version"], { ...SPAWN_BASE, timeout: VERSION_TIMEOUT_MS });

    if (r.status !== 0) return null;
    return (r.stdout ?? "").trim().match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/** VS Code extension folders are named `publisher.name-version`. */
function hasVscodeExtension(prefix, home) {
  const dir = path.join(home, ".vscode", "extensions");
  if (!exists(dir)) return false;
  try {
    return fs.readdirSync(dir).some((entry) => entry.startsWith(prefix));
  } catch {
    return false; // unreadable extensions dir is not fatal
  }
}

/** Where the GitHub CLI keeps its hosts file, per platform. */
function ghHostsPath(home, env, platform) {
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "GitHub CLI", "hosts.yml");
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, "gh", "hosts.yml");
}

/**
 * Provider definitions. `installed` answers "is the agent here", `credentials`
 * answers "can we probably read a quota" — the second is what setup acts on.
 *
 * Order matters inside each detector: cheap filesystem and env checks first,
 * process launches last.
 */
export const PROVIDERS = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    quota: "5h + weekly windows",
    detect: (home, env, platform) => {
      if (exists(path.join(home, ".claude"))) return "~/.claude directory";
      if (env.CLAUDE_CODE_VERSION) return "CLAUDE_CODE_VERSION env";
      if (isOnPath("claude", platform)) return "claude on PATH";
      return null;
    },
    credentials: (home, env) => {
      if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN env";
      if (env.AGENT_RUNWAY_TOKEN) return "AGENT_RUNWAY_TOKEN env";
      if (exists(path.join(home, ".claude", "usage-token"))) return "~/.claude/usage-token";
      if (exists(path.join(home, ".claude", ".credentials.json"))) {
        return "~/.claude/.credentials.json (often stale)";
      }
      return null;
    },
    credentialHint: "claude setup-token",
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    binary: "codex",
    quota: "5h + weekly windows",
    detect: (home, env, platform) => {
      if (exists(path.join(home, ".codex"))) return "~/.codex directory";
      if (isOnPath("codex", platform)) return "codex on PATH";
      return null;
    },
    credentials: (home) =>
      exists(path.join(home, ".codex", "auth.json")) ? "~/.codex/auth.json" : null,
    credentialHint: "codex login",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    binary: "gh",
    quota: "monthly premium requests",
    detect: (home, env, platform) => {
      if (env.GITHUB_COPILOT_TOKEN || env.GITHUB_COPILOT_PRODUCT) return "GITHUB_COPILOT_* env";
      if (hasVscodeExtension("github.copilot-", home)) return "VS Code extension";
      if (isOnPath("gh", platform)) return "gh on PATH";
      return null;
    },
    credentials: (home, env, platform) => {
      if (env.GH_TOKEN || env.GITHUB_TOKEN) return "GH_TOKEN env";
      return exists(ghHostsPath(home, env, platform)) ? "gh hosts.yml" : null;
    },
    credentialHint: "gh auth login",
  },
  // Antigravity belongs here too: its quota lives behind a local language-server
  // RPC (exa.language_server_pb / GetUserStatus) rather than a cloud endpoint,
  // so the adapter shape differs. Left out until it can actually be tested.
];

/**
 * @param {object} options
 * @param {boolean} [options.withVersions] run --version probes; slow, display only
 * @returns {Array<{id, label, installed, how, credentials, credentialHint, quota, version}>}
 */
export function detectProviders({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  withVersions = false,
} = {}) {
  return PROVIDERS.map((provider) => {
    const how = provider.detect(home, env, platform);
    const credentials = provider.credentials(home, env, platform);
    return {
      id: provider.id,
      label: provider.label,
      quota: provider.quota,
      installed: Boolean(how),
      how,
      credentials,
      credentialHint: provider.credentialHint,
      version: how && withVersions ? probeVersion(provider.binary) : null,
    };
  });
}

/** One line per provider, for the setup menu. */
export function formatProvider(p, index) {
  const number = index === undefined ? "  " : `${index + 1})`;
  const state = !p.installed
    ? "not found"
    : p.credentials
      ? `ready - ${p.credentials}`
      : `installed, no credentials - run \`${p.credentialHint}\``;
  const version = p.version ? ` v${p.version}` : "";
  return `${number} ${(p.label + version).padEnd(22)} ${state}`;
}
