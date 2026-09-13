// `resolve` exists to hand a caller a command that works. It was handing back a
// path that throws.
//
// Measured on Windows, of the four agents this tool resolves, two could not be
// spawned from the path it reported: copilot and gemini are npm packages whose
// entry point is a .js file, and spawn answers EFTYPE. The .cmd launcher beside
// them is no better - Node refuses .bat and .cmd without a shell since the fix
// for CVE-2024-27980, so it answers EINVAL.
//
// These tests cover the descriptor that replaced the bare path, and then spawn
// whatever this machine actually has, because the whole claim is that it runs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { discoverInstalls, invocationFor } from "../src/installs.mjs";

// --------------------------------------------------------------- the descriptor

test("a natively executable program is started directly", () => {
  const win = invocationFor({ path: "C:/tools/codex.exe" }, "win32");
  assert.deepEqual(win, { command: "C:/tools/codex.exe", args: [], via: "direct" });

  const posix = invocationFor({ path: "/usr/local/bin/codex" }, "linux");
  assert.equal(posix.via, "direct");
  assert.equal(posix.command, "/usr/local/bin/codex");
});

test("a JavaScript entry point runs through this Node, on every platform", () => {
  // The npm-installed agents. Spawning the .js directly is EFTYPE on Windows
  // and "permission denied" or a shebang guess elsewhere; naming the runtime
  // removes the guess.
  for (const platform of ["win32", "darwin", "linux"]) {
    const invoke = invocationFor({ path: "/opt/copilot/npm-loader.js" }, platform);
    assert.equal(invoke.via, "node");
    assert.equal(invoke.command, process.execPath);
    assert.deepEqual(invoke.args, ["/opt/copilot/npm-loader.js"]);
  }

  assert.equal(invocationFor({ path: "/opt/x/cli.mjs" }, "linux").via, "node");
  assert.equal(invocationFor({ path: "/opt/x/cli.cjs" }, "linux").via, "node");
});

test("a Windows batch launcher goes through cmd.exe with an argv array", () => {
  const invoke = invocationFor({ path: "C:/npm/gemini.cmd" }, "win32");

  assert.equal(invoke.via, "cmd");
  assert.match(invoke.command, /cmd\.exe$/i);
  // /d skips AutoRun, /s fixes the quoting rules, /c runs and exits. The target
  // is an argument, not text concatenated into a command line - which is what
  // `shell: true` does, and what Node deprecated it for.
  assert.deepEqual(invoke.args, ["/d", "/s", "/c", "C:/npm/gemini.cmd"]);
});

test("a .cmd is not special outside Windows", () => {
  // A file that happens to end in .cmd on Linux is just a file.
  assert.equal(invocationFor({ path: "/opt/x/thing.cmd" }, "linux").via, "direct");
});

test("the launcher is used only when the program itself cannot be started", () => {
  // A .js beside a .cmd: prefer node, which needs no shell at all.
  const npmish = invocationFor(
    { path: "C:/npm/node_modules/@github/copilot/npm-loader.js", launcher: "C:/npm/copilot.cmd" },
    "win32"
  );
  assert.equal(npmish.via, "node");

  // An .exe beside a .cmd: the .exe wins, the launcher is redundant.
  const native = invocationFor({ path: "C:/tools/claude.exe", launcher: "C:/npm/claude.cmd" }, "win32");
  assert.equal(native.via, "direct");
  assert.equal(native.command, "C:/tools/claude.exe");
});

// ------------------------------------------------------- and it actually runs

/** Spawn and report what happened, without ever throwing. */
const trySpawn = (command, args) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      return resolve({ ok: false, why: `threw ${error.code}` });
    }
    child.on("error", (error) => resolve({ ok: false, why: `error ${error.code}` }));
    child.on("close", (code) => resolve({ ok: true, code }));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      resolve({ ok: false, why: "timeout" });
    }, 25_000).unref?.();
  });

test("every install found on this machine can be started from its descriptor", async (t) => {
  const installs = discoverInstalls({ withVersions: false }).filter((i) => i.kind === "path" && i.invoke);

  if (!installs.length) {
    // CI runners have none of these agents. The descriptor's logic is covered
    // above; this test proves it against reality when reality is present.
    return t.skip("no agent CLI installed here");
  }

  for (const install of installs) {
    const result = await trySpawn(install.invoke.command, [...install.invoke.args, "--version"]);
    assert.ok(
      result.ok,
      `${install.agent}: spawning the descriptor failed (${result.why}) - ` +
        `command=${path.basename(install.invoke.command)} via=${install.invoke.via}`
    );
  }
});
