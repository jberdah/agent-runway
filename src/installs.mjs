// Which copies of each agent exist on this machine.
//
// "Claude" or "Codex" is not a precise enough answer for an agent about to
// spawn one: the same machine carries several, and they disagree. Measured
// here, all four diverge — the Claude CLI on PATH is 2.1.241 while its VS Code
// extension bundles 2.1.269, and the Codex CLI is 0.149.1 while its extension
// runs 0.153.4. A model the extension offers may be unknown to the binary a
// delegation would actually invoke.
//
// So the unit is the install, identified by its path, and a fingerprint that
// changes whenever the file does.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as cache from "./cache.mjs";

const IS_WINDOWS = process.platform === "win32";
const SPAWN = { encoding: "utf-8", windowsHide: true, timeout: 8000 };

export const AGENTS = {
  claude: {
    label: "Claude Code",
    binary: "claude",
    vscode: { publisher: "anthropic.claude-code", bundled: ["resources", "native-binary"] },
  },
  codex: {
    label: "OpenAI Codex",
    binary: "codex",
    vscode: { publisher: "openai.chatgpt", bundled: null },
  },
  copilot: {
    label: "GitHub Copilot",
    binary: "copilot",
    vscode: null, // Copilot Chat ships inside VS Code rather than as an extension
  },
  antigravity: {
    label: "Antigravity",
    binary: "antigravity",
    vscode: null,
  },
};

/** Resolve a binary on PATH without launching it. */
function onPath(binary) {
  try {
    const r = spawnSync(IS_WINDOWS ? "where" : "which", [binary], { ...SPAWN, timeout: 3000 });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * PATH usually hands back an npm shim, not the program.
 *
 * `where claude` returns a 308-byte shell script; the binary it launches is
 * 337MB. Fingerprinting or scanning the shim would describe the wrong file
 * entirely — and the shim never changes when the package is upgraded, so it is
 * also useless as a cache key. The script names its target, so follow it.
 */
export function followShim(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return file;
  }
  if (size > 64 * 1024) return file; // already a real binary

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return file;
  }

  const target = text.match(/node_modules[\/\\][^\s"'`]+?\.(?:exe|js|cjs|mjs)/)?.[0];
  if (!target) return file;

  const resolved = path.resolve(path.dirname(file), target.replace(/\\/g, "/"));
  return fs.existsSync(resolved) ? resolved : file;
}

/**
 * Identity of a file, cheap enough to call on every lookup.
 *
 * Used as the cache key for anything derived from a binary: size and mtime
 * change on every upgrade, and also on a reinstall of the same version, which a
 * reported version string would miss.
 */
export function fingerprint(file) {
  try {
    const s = fs.statSync(file);
    return `${s.size}-${Math.round(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/**
 * A version, cached against the file's fingerprint.
 *
 * Probing costs seconds — these binaries are hundreds of megabytes — but the
 * answer only changes when the file does, whether that is a CLI upgrade or a
 * new VS Code extension build. The fingerprint is the invalidation: a changed
 * binary is a different key, so nothing expires and nothing goes stale.
 */
export function versionOf(file, { launcher = null, fp = fingerprint(file) } = {}) {
  if (!fp) return probeVersion(launcher ?? file);

  const key = `version-${path.basename(file)}-${fp}`;
  const hit = cache.read(key, Infinity, Infinity);
  if (hit) return hit.value;

  // Probe through the launcher, because that is how the program is meant to be
  // started — a loader script will not answer --version on its own — but key
  // the result on the program, which is what actually changes on upgrade.
  const version = probeVersion(launcher ?? file) ?? probeVersion(file);
  // A null is cached too: without it, an agent that never reports a version
  // would be re-probed on every call, which is the cost this exists to avoid.
  cache.write(key, version ?? null);
  return version;
}

/** Only spawn when a version is actually wanted: these binaries are hundreds of MB. */
export function probeVersion(file) {
  try {
    const r = IS_WINDOWS
      ? spawnSync(`"${file}" --version`, { ...SPAWN, shell: true })
      : spawnSync(file, ["--version"], SPAWN);
    if (r.status !== 0) return null;
    return (r.stdout ?? "").trim().match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const vscodeDirs = (home) => {
  const roots = [path.join(home, ".vscode", "extensions"), path.join(home, ".vscode-insiders", "extensions")];
  const out = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root)) out.push({ root, entry });
    } catch {
      /* no such editor installed */
    }
  }
  return out;
};

/** `anthropic.claude-code-2.1.269-win32-x64` -> "2.1.269" */
function versionFromFolder(name, publisher) {
  return name.startsWith(publisher + "-")
    ? name.slice(publisher.length + 1).match(/^(\d+\.\d+\.\d+)/)?.[1] ?? null
    : null;
}

function bundledBinary(dir, segments, binary) {
  if (!segments) return null;
  for (const name of [binary + ".exe", binary]) {
    const candidate = path.join(dir, ...segments, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The Codex extension ships per-platform binaries under bin/<target>/ with a
 * manifest naming the version and entrypoint, which beats guessing at both.
 * Its version is its own: 0.154.0-alpha.6.1 here, against 0.149.1 on PATH.
 */
function codexExtensionBinary(dir) {
  const platforms = IS_WINDOWS ? ["windows-x86_64"] : ["linux-x86_64", "darwin-arm64", "darwin-x86_64"];
  for (const platform of platforms) {
    const base = path.join(dir, "bin", platform);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(base, "codex-package.json"), "utf8"));
    } catch {
      continue;
    }
    const entry = manifest.entrypoint ? path.join(base, manifest.entrypoint) : null;
    return {
      path: entry && fs.existsSync(entry) ? entry : base,
      version: manifest.version ?? null,
      // The manifest may name an entrypoint the extension unpacks on first use.
      resolved: Boolean(entry && fs.existsSync(entry)),
    };
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.withVersions] probe PATH binaries for a version string; costs seconds
 * @returns {Array<{agent, label, kind, path, version, fingerprint}>}
 */
export function discoverInstalls({ home = os.homedir(), withVersions = false, agents } = {}) {
  const wanted = agents?.length ? agents : Object.keys(AGENTS);
  const found = [];

  for (const id of wanted) {
    const spec = AGENTS[id];
    if (!spec) continue;

    const shim = onPath(spec.binary);
    if (shim) {
      // Fingerprint the program, not the launcher: the shim is unchanged by an
      // upgrade, so keying a cache on it would never invalidate.
      const real = followShim(shim);
      found.push({
        agent: id,
        label: spec.label,
        kind: "path",
        path: real,
        launcher: real === shim ? null : shim,
        version: withVersions ? versionOf(real, { launcher: shim }) : null,
        fingerprint: fingerprint(real),
      });
    }

    if (!spec.vscode) continue;
    for (const { root, entry } of vscodeDirs(home)) {
      const version = versionFromFolder(entry, spec.vscode.publisher);
      if (!version) continue;
      const dir = path.join(root, entry);
      const codex = id === "codex" ? codexExtensionBinary(dir) : null;
      const binary = codex?.path ?? bundledBinary(dir, spec.vscode.bundled, spec.binary);
      found.push({
        agent: id,
        label: spec.label,
        kind: "vscode",
        path: binary ?? dir,
        // Free: the extension folder carries a version, and Codex's manifest
        // carries the more precise one for the binary it actually ships.
        version: codex?.version ?? version,
        extensionVersion: version,
        fingerprint: binary && codex?.resolved !== false ? fingerprint(binary) : null,
      });
    }
  }

  return found;
}

/** Group by agent, so a caller can see the disagreement at a glance. */
export function byAgent(installs) {
  const map = new Map();
  for (const i of installs) {
    if (!map.has(i.agent)) map.set(i.agent, []);
    map.get(i.agent).push(i);
  }
  return map;
}

/** True when an agent has installs that do not agree on a version. */
export function hasVersionSkew(installs) {
  const versions = new Set(installs.map((i) => i.version).filter(Boolean));
  return versions.size > 1;
}
