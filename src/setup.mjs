// Guided, cross-platform setup: obtain a token, validate it, persist it.
//
// The token is written to ~/.claude/usage-token (0600) rather than an
// environment variable by default. An env var on macOS/Linux means writing the
// secret into a shell rc file, which is frequently mode 644 and sometimes
// committed to a dotfiles repository; a single 0600 file is safer, identical on
// all three platforms, read automatically on every invocation, and revoked by
// deleting it. `--env` remains available, but on POSIX it exports an
// indirection to that file rather than a second copy of the secret.

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
const out = (line = "") => process.stdout.write(line + "\n");

// Key handling compares byte values rather than character literals: control
// characters in source are silently mangled by copy/paste, diff tools and
// editors, and a broken Ctrl-C handler would not be obvious.
const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const DELETE = 127;

// ---------------------------------------------------------------- pure helpers

/** Shape check only. Never a substitute for asking the API. */
export function tokenLooksValid(token) {
  return typeof token === "string" && /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(token.trim());
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
export function envExportLine(profilePath, file = "$HOME/.claude/usage-token") {
  if (profilePath && profilePath.endsWith("config.fish")) {
    return `set -gx AGENT_RUNWAY_TOKEN (cat ${file} 2>/dev/null); # agent-runway`;
  }
  return `export AGENT_RUNWAY_TOKEN="$(cat ${file} 2>/dev/null)"  # agent-runway`;
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

/** Read a secret without echoing it to the terminal or the scrollback. */
function askSecret(question) {
  if (!process.stdin.isTTY) return ask(question);

  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let value = "";

    const finish = (result, exitCode) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      if (exitCode !== undefined) process.exit(exitCode);
      resolve(result);
    };

    const onData = (chunk) => {
      for (const byte of chunk) {
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
        if (byte < 32) continue; // arrow keys and other escape sequences
        value += String.fromCharCode(byte);
      }
    };

    stdin.on("data", onData);
  });
}

// -------------------------------------------------------------------- actions

function claudeCliAvailable() {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"], { stdio: "ignore", shell: IS_WINDOWS });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Run `claude setup-token` with the terminal attached so the user completes the
 * browser flow themselves. On Windows `claude` is a .cmd shim, which spawn
 * cannot exec directly, hence shell: true there.
 */
function runClaudeSetupToken() {
  return new Promise((resolve) => {
    const child = spawn("claude", ["setup-token"], { stdio: "inherit", shell: IS_WINDOWS });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Ask the API whether the token actually works. Shape checks are not enough. */
async function validateToken(token) {
  try {
    const usage = await fetchUsage({
      env: { AGENT_RUNWAY_TOKEN: token, AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1" },
    });
    return { ok: true, usage };
  } catch (error) {
    return { ok: false, error };
  }
}

export function persistToken(token, home = os.homedir()) {
  const file = tokenPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // mode is honoured on POSIX and ignored on Windows, where the user profile
  // directory is already ACL-restricted to the account.
  fs.writeFileSync(file, token + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: no-op */
  }
  return file;
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

async function configureEnv(token) {
  if (IS_WINDOWS) {
    out("");
    out("  Note: on Windows the variable holds a second copy of the token.");
    out("  The token file alone is already picked up automatically.");
    if (!(await confirm("  Set AGENT_RUNWAY_TOKEN for your user account anyway?", false))) {
      return "skipped";
    }
    const ok = await setWindowsUserEnv("AGENT_RUNWAY_TOKEN", token);
    out(ok
      ? "  Set. Open a new terminal for it to take effect."
      : "  Could not set it; the token file still works.");
    return ok ? "windows-env" : "failed";
  }

  const profile = shellProfilePath();
  if (!profile) {
    out("");
    out("  Unknown shell, so nothing was edited. Add this line yourself if you want it:");
    out(`    ${envExportLine(null)}`);
    return "manual";
  }

  let existing = "";
  try {
    existing = fs.readFileSync(profile, "utf8");
  } catch {
    /* the profile may not exist yet */
  }
  if (existing.includes("# agent-runway")) {
    out(`  ${profile} already has the line; left untouched.`);
    return "already";
  }

  const line = envExportLine(profile);
  out("");
  out(`  Append to ${profile}:`);
  out(`    ${line}`);
  out("  It reads the token file rather than storing a second copy.");
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
      out(`Already working (token from ${usage.tokenSource}).`);
      out("");
      out(renderTable(usage));
      out("");
      out("Re-run with --force to replace the token.");
      return 0;
    } catch (error) {
      if (!(error instanceof UsageError) || !["NO_TOKEN", "AUTH"].includes(error.code)) throw error;
      out(error.code === "AUTH"
        ? "A token was found but the API rejected it. Let's replace it."
        : "No token found yet. Let's create one.");
    }
  }

  // 2. Create one. This needs a real terminal: it spawns a browser sign-in and
  // reads a secret back. Piped or in CI, say so rather than blocking on a
  // prompt nobody can answer.
  if (!process.stdin.isTTY) {
    out("");
    out("Setup is interactive and there is no terminal attached.");
    out("Run it from a terminal, or provide a token another way:");
    out("");
    out("  claude setup-token                       # then either");
    out("  export AGENT_RUNWAY_TOKEN=sk-ant-...     # env var, good for CI");
    out(`  echo sk-ant-... > ${tokenPath()}   # or the token file`);
    return 1;
  }

  out("");

  // Ask before offering to create one: someone who already generated a token
  // elsewhere should not have to decline a browser sign-in to reach the prompt.
  if (!(await confirm("Do you already have a token to paste?", false))) {
    out("");
    out("`claude setup-token` opens a browser and prints a long-lived token.");
    out("You run it and complete the sign-in yourself.");
    out("");

    if (await claudeCliAvailable()) {
      if (await confirm("Run `claude setup-token` now?", true)) {
        out("");
        const completed = await runClaudeSetupToken();
        if (!completed) {
          out("");
          out("That did not complete. You can run `claude setup-token` in another");
          out("terminal and come back with the token.");
        }
      }
    } else {
      out("The `claude` CLI was not found. Install it, or generate a token elsewhere:");
      out("    npm install -g @anthropic-ai/claude-code");
      out("    claude setup-token");
    }
  }

  // 3. Take it, validate it, and only then store it.
  out("");
  const token = await askSecret("Paste the token (input hidden): ");

  if (!tokenLooksValid(token)) {
    out("");
    out("That does not look like a Claude token (expected sk-ant-...). Nothing saved.");
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

  const file = persistToken(token);
  out(`  Saved to ${file}${IS_WINDOWS ? "" : " (mode 0600)"}.`);

  if (wantsEnv) await configureEnv(token);

  out("");
  out(renderTable(result.usage));
  printNextSteps();
  return 0;
}
