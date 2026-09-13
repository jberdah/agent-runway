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
    // The desktop app keeps its own copies under a directory named for each
    // version, so the version comes free from the path. Two sit side by side
    // here, distinct from both the npm install and the VS Code extensions.
    //
    // These are the app's user-data directories, which is where the embedded
    // binaries live whatever the install source: a Microsoft Store package and
    // an installer put the app itself in different places, but both write their
    // agent builds here, so the install method does not have to be detected.
    //
    // No Linux entry, and that is a finding rather than an omission: there is no
    // Claude desktop app for Linux, so an earlier guess at ~/.config/Claude was
    // a path that could never match. (Established in brainclaw's surface
    // inventory, which classifies Claude on Linux as a web surface.)
    //
    // Only the Windows layout has been observed here; macOS follows Electron's
    // user-data convention and says so.
    desktop: {
      win32: ["AppData", "Roaming", "Claude", "claude-code"],
      darwin: ["Library", "Application Support", "Claude", "claude-code"],
      verifiedOn: ["win32"],
    },
  },
  codex: {
    label: "OpenAI Codex",
    binary: "codex",
    vscode: { publisher: "openai.chatgpt", bundled: null },
    // `codex app` launches a desktop build. Not installed on the machine this
    // was written against — it conflicts with the VS Code extension over MCP
    // definitions — so no layout is guessed at here rather than shipping a path
    // nobody has verified.
    desktop: null,
  },
  copilot: {
    label: "GitHub Copilot",
    binary: "copilot",
    vscode: null, // Copilot Chat ships inside VS Code rather than as an extension
    desktop: null,
  },
  // Spawnable with a model argument, which is what earns an entry
  // even though its quota is not read separately: it shares Google's.
  gemini: {
    label: "Gemini CLI",
    binary: "gemini",
    vscode: null,
    desktop: null,
  },
};

/**
 * Where each CLI sits when PATH cannot be consulted.
 *
 * An MCP server is spawned by its client with a deliberately minimal
 * environment — the official SDK passes only a small set of variables through —
 * so `where` finds nothing and every PATH install disappears. Editor and
 * desktop installs survive because they are found by absolute path; these give
 * the CLIs the same footing.
 *
 * Every entry here was observed on a real machine rather than guessed.
 */
const KNOWN_LOCATIONS = {
  win32: {
    claude: ["AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"],
    codex: ["AppData/Local/Programs/OpenAI/Codex/bin/codex.exe"],
    copilot: ["AppData/Roaming/npm/copilot.cmd"],
    gemini: ["AppData/Roaming/npm/gemini.cmd"],
  },
  // Unverified: this project has only ever run on Windows. The paths follow the
  // usual global-npm and application conventions, and a miss simply yields no
  // install rather than a wrong one.
  darwin: {
    claude: [".npm-global/bin/claude", "/usr/local/bin/claude"],
    codex: [".codex/bin/codex", "/usr/local/bin/codex"],
    copilot: [".npm-global/bin/copilot", "/usr/local/bin/copilot"],
    gemini: [".npm-global/bin/gemini", "/usr/local/bin/gemini"],
  },
  linux: {
    claude: [".npm-global/bin/claude", "/usr/local/bin/claude"],
    codex: [".codex/bin/codex", "/usr/local/bin/codex"],
    copilot: [".npm-global/bin/copilot", "/usr/local/bin/copilot"],
    gemini: [".npm-global/bin/gemini", "/usr/local/bin/gemini"],
  },
};

function knownLocation(agent, home, platform) {
  for (const candidate of KNOWN_LOCATIONS[platform]?.[agent] ?? []) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(home, candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Resolve a binary on PATH without launching it.
 *
 * `where` returns every match, and the first is not always the usable one:
 * `where codex` lists the real executable, an extensionless sh script and a
 * .cmd launcher, and their order changes with PATH — under `npm run` the sh
 * script came first, which Windows cannot spawn at all (EFTYPE). Rank by what
 * can actually be executed rather than trusting the order.
 */
function onPath(binary) {
  try {
    const r = spawnSync(IS_WINDOWS ? "where" : "which", [binary], { ...SPAWN, timeout: 3000 });
    if (r.status !== 0) return null;

    const matches = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!IS_WINDOWS) return matches[0] ?? null;

    const rank = (file) => (/\.exe$/i.test(file) ? 0 : /\.(cmd|bat)$/i.test(file) ? 1 : 2);
    return [...matches].sort((a, b) => rank(a) - rank(b))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * How to actually start this program: a command and its arguments, spawnable
 * with no shell.
 *
 * A path is not an answer. Measured on Windows, of the four agents this tool
 * resolves, two cannot be spawned from the path it reports:
 *
 *   claude   claude.exe        spawns
 *   codex    codex.exe         spawns
 *   copilot  npm-loader.js     EFTYPE
 *   gemini   gemini.js         EFTYPE
 *
 * The `.cmd` launcher npm installs alongside them is no better: Node refuses to
 * spawn a .bat or .cmd without a shell since the fix for CVE-2024-27980, so it
 * raises EINVAL. `resolve` was handing callers a path that throws, while the
 * tool itself quietly used `shell: true` to run the very same program.
 *
 * `shell: true` is not the fix either. It concatenates arguments into one
 * string rather than passing an argv array — Node deprecated that for exactly
 * the reason it sounds like — and on Windows it masks a missing binary, because
 * cmd.exe starts successfully and exits 1. brainclaw had to write a sentinel
 * file to tell "agent absent" from "agent failed"; a caller given a command
 * that spawns directly needs no such thing.
 *
 * So: run a .js through this Node, a .cmd through an explicit cmd.exe with an
 * argv array, and anything natively executable directly.
 */
export function invocationFor({ path: file, launcher = null }, platform = process.platform) {
  const describe = (target) => {
    const ext = (target.match(/\.[^.\\/]+$/) ?? [""])[0].toLowerCase();

    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return { command: process.execPath, args: [target], via: "node" };
    }
    if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
      // cmd.exe re-parses what follows /c, and a path is not a safe thing to
      // put there. Measured, with a file legally named `tool& mkdir X &rem
      // .cmd`:
      //
      //   cmd /d /s /c <path> <args>          the mkdir RAN
      //   cmd /d /c <path>                    the mkdir RAN
      //   cmd /d /s /c "call" "<path>"        the mkdir RAN
      //   cmd /d /s /c ""<path>" <args>"      safe - but only verbatim, which
      //                                       means one string, which breaks
      //                                       the args array a caller appends to
      //
      // There is no form that is both safe and shaped like {command, args}. So
      // a path carrying characters cmd would act on is refused rather than
      // described: this descriptor's whole promise is that spawning it works,
      // and handing back something that might run a second command is worse
      // than admitting we cannot express it.
      if (/[&|<>^"%()]/.test(target)) {
        return { command: null, args: [], via: "unsafe", reason: "path contains characters cmd.exe would interpret" };
      }
      // /d skips AutoRun, /s fixes the quoting rules, /c runs and exits.
      const comspec = process.env.ComSpec?.trim() || "cmd.exe";
      return { command: comspec, args: ["/d", "/s", "/c", target], via: "cmd" };
    }
    return { command: target, args: [], via: "direct" };
  };

  const primary = describe(file);
  // A program we cannot start directly, but with a launcher beside it: prefer
  // whichever needs no shell. `node <file>` beats cmd.exe when both would work.
  if (primary.via === "direct" || primary.via === "node") return primary;
  return launcher ? describe(launcher) : primary;
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
    // Through the same descriptor the rest of the tool uses, with no shell.
    //
    // This was `spawnSync(\`"${file}" --version\`, { shell: true })`. Tested:
    // the quoting does hold, because `"` is not a legal character in a Windows
    // filename, so nothing can break out of it — a file named
    // `tool& mkdir X &rem .cmd` runs as one token and the `&` stays literal.
    // Fixed anyway: it was the one place still interpolating a path into a
    // command line, and being safe by accident is not a property to rely on.
    const invoke = invocationFor({ path: file });
    if (!invoke.command) return null; // refused as unsafe to express
    const r = spawnSync(invoke.command, [...invoke.args, "--version"], SPAWN);
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

/**
 * Desktop apps that keep one directory per version of the agent they embed.
 *
 * Claude Desktop does this under its user-data directory, which means a machine
 * can carry several more copies than PATH and the editor extensions reveal —
 * five for Claude here, against the three found before this was added.
 */
function desktopInstalls(spec, home, platform, binaryName) {
  const segments = spec?.[platform];
  if (!segments) return [];

  const root = path.join(home, ...segments);
  let versions;
  try {
    versions = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return []; // app not installed, or a layout this has never seen
  }

  const exe = platform === "win32" ? `${binaryName}.exe` : binaryName;
  const found = [];
  for (const dir of versions) {
    const file = path.join(root, dir.name, exe);
    if (!fs.existsSync(file)) continue;
    found.push({
      path: file,
      invoke: invocationFor({ path: file }, platform),
      // The directory is named for the version, so no probe is needed.
      version: /^\d+\.\d+\.\d+/.test(dir.name) ? dir.name : null,
      verified: (spec.verifiedOn ?? []).includes(platform),
    });
  }
  return found;
}

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
    // The entrypoint is written as "bin/codex.exe" but the platform directory
    // IS that bin: joining the two produced bin/windows-x86_64/bin/codex.exe,
    // which does not exist, and made a binary that was present look missing.
    // Resolve by filename inside the platform directory, keeping the literal
    // join as a fallback in case a future layout means it.
    const name = manifest.entrypoint ? path.basename(manifest.entrypoint) : null;
    const entry = [
      name ? path.join(base, name) : null,
      manifest.entrypoint ? path.join(base, manifest.entrypoint) : null,
    ].find((candidate) => candidate && fs.existsSync(candidate));

    return {
      path: entry ?? base,
      version: manifest.version ?? null,
      resolved: Boolean(entry),
    };
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.withVersions] probe PATH binaries for a version string; costs seconds
 * @returns {Array<{agent, label, kind, path, version, fingerprint}>}
 */
export function discoverInstalls({
  home = os.homedir(),
  platform = process.platform,
  withVersions = false,
  agents,
} = {}) {
  const wanted = agents?.length ? agents : Object.keys(AGENTS);
  const found = [];

  for (const id of wanted) {
    const spec = AGENTS[id];
    if (!spec) continue;

    for (const app of desktopInstalls(spec.desktop, home, platform, spec.binary)) {
      found.push({
        agent: id,
        label: spec.label,
        kind: "desktop",
        path: app.path,
        invoke: app.invoke,
        version: app.version,
        layoutVerified: app.verified,
        fingerprint: fingerprint(app.path),
      });
    }

    // A PATH match is not automatically usable. On Windows an extensionless
    // entry is a POSIX shell script that Windows cannot spawn at all (EFTYPE),
    // and `where codex` lists one alongside the real executable. Prefer a known
    // location over a match that cannot be launched, rather than only falling
    // back when PATH finds nothing.
    const fromPath = onPath(spec.binary);
    const launchable = !fromPath || platform !== "win32" || /\.(exe|cmd|bat)$/i.test(fromPath);
    const shim = (launchable ? fromPath : null) ?? knownLocation(id, home, platform) ?? fromPath;

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
        invoke: invocationFor({ path: real, launcher: real === shim ? null : shim }, platform),
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
        invoke: binary ? invocationFor({ path: binary }, platform) : null,
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
