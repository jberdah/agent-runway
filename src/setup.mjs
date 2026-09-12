// Guided, cross-platform setup: find a credential, validate it, persist it.
//
// It cannot mint one. No command issues a usage-scoped token for Claude today,
// so what setup does is detect what exists, explain the two credentials that
// work, and verify whichever is supplied before writing anything.
//
// Those two are not interchangeable, and every path here has to respect that: a
// token authenticates api.anthropic.com with a Bearer, a claude.ai sessionKey
// authenticates claude.ai, which refuses Bearers outright. Each is written to
// the file its resolver reads and exported under the variable its resolver
// reads — a cookie in the token's place is a credential nothing ever tries.
//
// The secret is written to a 0600 file rather than an environment variable by
// default. An env var on macOS/Linux means writing it into a shell rc file,
// frequently mode 644 and sometimes committed to a dotfiles repository; one
// 0600 file is safer, identical on all three platforms, read automatically on
// every invocation, and revoked by deleting it. `--env` remains available, but
// on POSIX it exports an indirection to that file rather than a second copy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { fetchUsage, UsageError, VERSION } from "./core.mjs";
import { renderTable } from "./render.mjs";

const IS_WINDOWS = process.platform === "win32";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tokenPath = (home = os.homedir()) => path.join(home, ".claude", "usage-token");
const cookiePath = (home = os.homedir()) => path.join(home, ".claude", "session-cookie");
const out = (line = "") => process.stdout.write(line + "\n");

// Key handling compares byte values rather than character literals: control
// characters in source are silently mangled by copy/paste, diff tools and
// editors, and a broken Ctrl-C handler would not be obvious.
const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const ESCAPE = 27;
const DELETE = 127;

const CSI = String.fromCharCode(27) + "[";
const BRACKETED_PASTE_OFF = CSI + "?2004l";
const BRACKETED_PASTE_ON = CSI + "?2004h";

// ---------------------------------------------------------------- pure helpers

/**
 * Catches an obviously mangled paste, nothing more. Deliberately permissive
 * about the character set: the token format is not published, and the
 * authoritative check is the API call that follows, so a strict charset here
 * could only ever reject a legitimate token.
 */
export function tokenLooksValid(token) {
  return typeof token === "string" && /^sk-ant-\S{16,}$/.test(token.trim());
}

/**
 * Which shell rc file to append to, given the user's shell.
 * Returns null when the shell is unknown rather than guessing wrong.
 */
export function shellProfilePath(env = process.env, home = os.homedir(), platform = process.platform) {
  if (platform === "win32") return null;
  const shell = path.basename(env.SHELL ?? "");
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") {
    // macOS bash reads .bash_profile for login shells, Linux reads .bashrc.
    return platform === "darwin" ? path.join(home, ".bash_profile") : path.join(home, ".bashrc");
  }
  if (shell === "fish") return path.join(home, ".config", "fish", "config.fish");
  return null;
}

/**
 * The line to append to a shell profile. It reads the token file rather than
 * embedding the secret, so the token exists in exactly one place on disk.
 */
export function envExportLine(
  profilePath,
  file = "$HOME/.claude/usage-token",
  varName = "AGENT_RUNWAY_TOKEN"
) {
  if (profilePath && profilePath.endsWith("config.fish")) {
    return `set -gx ${varName} (cat ${file} 2>/dev/null); # agent-runway`;
  }
  return `export ${varName}="$(cat ${file} 2>/dev/null)"  # agent-runway`;
}

/** The variable and file a given credential is read from. */
export function envTargetFor(secret) {
  return credentialKind(secret) === "cookie"
    ? { varName: "AGENT_RUNWAY_CLAUDE_COOKIE", file: "$HOME/.claude/session-cookie", label: "cookie" }
    : { varName: "AGENT_RUNWAY_TOKEN", file: "$HOME/.claude/usage-token", label: "token" };
}

// ------------------------------------------------------------------- terminal

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

async function confirm(question, defaultYes = true) {
  if (!process.stdin.isTTY) return defaultYes;
  const answer = await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
  if (!answer) return defaultYes;
  return /^(y|o)/i.test(answer);
}

/** Everything piped in, for `--stdin`. */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** Read a secret without echoing it to the terminal or the scrollback. */
function askSecret(question) {
  if (!process.stdin.isTTY) return ask(question);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    // Terminals wrap pasted text in ESC[200~ ... ESC[201~ (bracketed paste). In
    // raw mode those arrive as ordinary bytes, and only the ESC itself is below
    // 32 — "[200~" is printable and lands inside the secret. Turn the mode off
    // while reading, and parse escape sequences below rather than trusting it.
    process.stdout.write(BRACKETED_PASTE_OFF);
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();

    let value = "";
    let escape = 0; // 0 = text, 1 = saw ESC, 2 = inside a CSI sequence

    const finish = (result, exitCode) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n" + BRACKETED_PASTE_ON);
      if (exitCode !== undefined) process.exit(exitCode);
      resolve(result);
    };

    const onData = (chunk) => {
      for (const byte of chunk) {
        // Swallow a whole escape sequence, not just its first byte.
        if (escape === 1) {
          escape = byte === 0x5b ? 2 : 0; // 0x5b is "["
          continue;
        }
        if (escape === 2) {
          // A CSI sequence ends on a byte in 0x40-0x7e, e.g. "~" or "A".
          if (byte >= 0x40 && byte <= 0x7e) escape = 0;
          continue;
        }
        if (byte === ESCAPE) {
          escape = 1;
          continue;
        }

        if (byte === CARRIAGE_RETURN || byte === LINE_FEED || byte === CTRL_D) {
          finish(value.trim());
          return;
        }
        if (byte === CTRL_C) {
          finish("", 130);
          return;
        }
        if (byte === DELETE || byte === BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte < 32) continue;
        value += String.fromCharCode(byte);
      }
    };

    stdin.on("data", onData);
  });
}

// -------------------------------------------------------------------- actions

// Spawning `claude setup-token` used to live here. It was removed once the
// endpoint answered "OAuth token does not meet scope requirement user:profile":
// that command mints inference-scoped tokens, so offering to run it only led
// users into a 403 they could not fix by trying again.

/** Ask the API whether the token actually works. Shape checks are not enough. */
async function validateToken(secret) {
  try {
    // Checked in isolation: only the endpoint this credential can authenticate
    // is offered, so "accepted" means this secret works, not that something
    // else on the machine did.
    const env =
      credentialKind(secret) === "cookie"
        ? { AGENT_RUNWAY_CLAUDE_COOKIE: secret, AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1" }
        : { AGENT_RUNWAY_TOKEN: secret, AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1" };
    const usage = await fetchUsage({ env });
    return { ok: true, usage };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Which credential a pasted secret is.
 *
 * The two are not interchangeable. A token authenticates api.anthropic.com with
 * a Bearer; a sessionKey cookie authenticates claude.ai, which refuses Bearers
 * outright. Saving one into the other's file produces a credential that is
 * never tried, and a setup that reports success while changing nothing.
 */
export function credentialKind(secret) {
  // `sk-ant-sid…` is the claude.ai session key; everything else is treated as a
  // token, which is the safe default — a token is checked against the endpoint
  // that takes one, and a wrong guess fails loudly instead of being stored
  // somewhere nothing reads.
  return String(secret ?? "").trim().startsWith("sk-ant-sid") ? "cookie" : "token";
}

function writeSecret(file, secret) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // mode is honoured on POSIX and ignored on Windows, where the user profile
  // directory is already ACL-restricted to the account.
  fs.writeFileSync(file, secret + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: no-op */
  }
  return file;
}

export function persistToken(token, home = os.homedir()) {
  return writeSecret(tokenPath(home), token);
}

/** Save a token or a cookie, each to the file the resolver actually reads. */
export function persistCredential(secret, home = os.homedir()) {
  return writeSecret(
    credentialKind(secret) === "cookie" ? cookiePath(home) : tokenPath(home),
    secret
  );
}

/** Windows: pass the value on stdin so it never appears in a process list. */
function setWindowsUserEnv(name, value) {
  return new Promise((resolve) => {
    const script = `[Environment]::SetEnvironmentVariable('${name}', [Console]::In.ReadLine(), 'User')`;
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.write(value + "\n");
    child.stdin.end();
  });
}

async function configureEnv(secret) {
  // A cookie and a token are read from different variables and different files.
  // Exporting a sessionKey as AGENT_RUNWAY_TOKEN does not merely fail to help:
  // the resolver then hands it to api.anthropic.com as a Bearer, which is a
  // guaranteed 401 and a credential copied somewhere it was never meant to go.
  // On POSIX the old code was quieter and no better — it appended a line
  // reading the token file, which a cookie setup has never written.
  const { varName, file, label } = envTargetFor(secret);

  if (IS_WINDOWS) {
    out("");
    out(`  Note: on Windows the variable holds a second copy of the ${label}.`);
    out(`  The ${label} file alone is already picked up automatically.`);
    if (!(await confirm(`  Set ${varName} for your user account anyway?`, false))) {
      return "skipped";
    }
    const ok = await setWindowsUserEnv(varName, secret);
    out(ok
      ? "  Set. Open a new terminal for it to take effect."
      : `  Could not set it; the ${label} file still works.`);
    return ok ? "windows-env" : "failed";
  }

  const profile = shellProfilePath();
  if (!profile) {
    out("");
    out("  Unknown shell, so nothing was edited. Add this line yourself if you want it:");
    out(`    ${envExportLine(null, file, varName)}`);
    return "manual";
  }

  let existing = "";
  try {
    existing = fs.readFileSync(profile, "utf8");
  } catch {
    /* the profile may not exist yet */
  }
  // Keyed on the variable, not just our tag: a profile already exporting a
  // token should still gain the cookie line, and the reverse.
  if (existing.includes("# agent-runway") && existing.includes(varName)) {
    out(`  ${profile} already exports ${varName}; left untouched.`);
    return "already";
  }

  const line = envExportLine(profile, file, varName);
  out("");
  out(`  Append to ${profile}:`);
  out(`    ${line}`);
  out(`  It reads the ${label} file rather than storing a second copy.`);
  if (!(await confirm("  Append it?", true))) return "skipped";

  fs.appendFileSync(profile, "\n" + line + "\n", "utf8");
  out(`  Done. Run 'source ${profile}' or open a new terminal.`);
  return "posix-profile";
}

function printNextSteps() {
  out("");
  out("Next steps");
  out("");
  out("  Check usage any time:");
  out("    agent-runway");
  out("");
  out("  Use it from Claude Code (skill + MCP tool):");
  out("    /plugin marketplace add jberdah/agent-runway");
  out("    /plugin install agent-runway@agent-runway");
  out("");
  out("  Use it as an MCP tool in another client:");
  out(`    node ${path.join(PACKAGE_ROOT, "src", "mcp.mjs")}`);
}

// ----------------------------------------------------------------------- main

export async function setup(argv = []) {
  const wantsEnv = argv.includes("--env");
  const force = argv.includes("--force");

  out("");
  out(`agent-runway ${VERSION} - setup`);
  out("");

  // 1. Is it already working?
  if (!force) {
    try {
      const usage = await fetchUsage();
      out(`Already working (credential from ${usage.credentialSource}).`);
      out("");
      out(renderTable(usage));
      out("");
      out("Re-run with --force to replace it.");
      return 0;
    } catch (error) {
      if (!(error instanceof UsageError) || !["NO_TOKEN", "AUTH"].includes(error.code)) throw error;
      out(error.code === "AUTH"
        ? "A credential was found but the API rejected it. Let's replace it."
        : "No credential found yet. Let's find one.");
    }
  }

  // 2a. A credential arriving on stdin - a token or a claude.ai cookie. Lets
  // the secret go straight from whatever produced it into the right file,
  // without being displayed, selected or pasted. Also the sane path in CI.
  //
  //   echo $TOKEN | agent-runway setup --force --stdin
  //   pbpaste | agent-runway setup --force --stdin
  //
  // The example here used to be `claude setup-token | ...`, which the rest of
  // this file explains is a dead end: that token lacks user:profile.
  //
  // The input is scanned rather than trusted whole, because whatever produced
  // it may have printed prose around the secret.
  if (argv.includes("--stdin")) {
    const piped = await readStdin();
    const found = piped.match(/sk-ant-\S{16,}/)?.[0] ?? null;

    if (!found) {
      out("No credential found on stdin. Expected something containing sk-ant-...");
      return 1;
    }
    out(`Read a ${found.length}-character ${credentialKind(found)} from stdin. Checking it...`);

    const checked = await validateToken(found);
    if (!checked.ok) {
      const why = checked.error instanceof UsageError ? checked.error.message : String(checked.error);
      out(`  Rejected: ${why}`);
      out("  Nothing saved.");
      return 1;
    }

    out("  Accepted.");
    out(`  Saved to ${persistCredential(found)}${IS_WINDOWS ? "" : " (mode 0600)"}.`);
    out("");
    out(renderTable(checked.usage));
    return 0;
  }

  // 2b. Create one interactively. This needs a real terminal: it spawns a
  // browser sign-in and reads a secret back. Piped or in CI, say so rather than
  // blocking on a prompt nobody can answer.
  if (!process.stdin.isTTY) {
    out("");
    out("Setup is interactive and there is no terminal attached.");
    out("Run it from a terminal, or provide a token another way:");
    out("");
    out("  export AGENT_RUNWAY_TOKEN=sk-ant-...     # a token, good for CI");
    out(`  echo sk-ant-... > ${tokenPath()}   # or the token file`);
    out(`  echo sk-ant-sid01-... > ${cookiePath()}  # or a claude.ai cookie`);
    out("");
    out("`claude setup-token` is not one of the options: the token it mints lacks");
    out("the user:profile scope this endpoint requires.");
    return 1;
  }

  out("");
  out("Note: `claude setup-token` does NOT help here. The token it mints carries");
  out("inference scopes, and the usage endpoint requires user:profile, so it is");
  out("refused with a 403 no matter how many times it is regenerated.");
  out("");
  out("Two credentials do work, and setup accepts either:");
  out("");
  out("  1. A token carrying user:profile. Claude Code keeps one for its own");
  out("     session, refreshed only while it runs - so it goes stale when idle.");
  out("  2. Your claude.ai sessionKey cookie. The claude.ai endpoint takes it");
  out("     instead of a Bearer, and it keeps working while Claude Code is");
  out("     closed. This is the durable path.");
  out("");
  out("Weigh the second before using it: a session cookie is the browser's whole");
  out("account session, broader than a scoped token, and it cannot be narrowed.");
  out("Paste either one now, or stop with Ctrl-C and sign in to Claude Code.");

  // 3. Take it, validate it, and only then store it.
  out("");
  const token = await askSecret("Paste a token or a claude.ai sessionKey (input hidden): ");

  if (!tokenLooksValid(token)) {
    out("");
    out(`Read ${token.length} characters, which do not start with sk-ant-. Nothing saved.`);
    if (token.includes("sk-ant-")) {
      // Almost always a terminal wrapping the paste in escape codes.
      out("");
      out("The prefix is present but not at the start, so the paste brought");
      out("extra characters with it. Either type the token by hand, or hand it");
      out("over without the prompt:");
      out("");
      out("  AGENT_RUNWAY_TOKEN=sk-ant-... agent-runway");
    }
    return 1;
  }

  out("");
  out("Checking it against the API...");
  const result = await validateToken(token);
  if (!result.ok) {
    const reason = result.error instanceof UsageError ? result.error.message : String(result.error);
    out(`  Rejected: ${reason}`);
    out("  Nothing saved.");
    return 1;
  }
  out("  Accepted.");

  const file = persistCredential(token);
  out(`  Saved to ${file}${IS_WINDOWS ? "" : " (mode 0600)"}.`);

  if (wantsEnv) await configureEnv(token);

  out("");
  out(renderTable(result.usage));
  printNextSteps();
  return 0;
}
