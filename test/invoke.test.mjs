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

test("every install has a descriptor, whatever kind it is", () => {
  // Not just the ones on PATH. The desktop branch built its record by hand and
  // forgot the field, so two Claude installs on this machine answered
  // `invoke: null` - and `resolve` will choose a desktop build when no usable
  // CLI is on PATH, which is exactly when a caller has no fallback.
  //
  // The first version of the test below filtered to kind === "path", so it
  // could not have caught that. This one cannot miss a kind.
  for (const install of discoverInstalls({ withVersions: false })) {
    assert.ok(install.invoke, `${install.agent} (${install.kind}) has no invocation`);
    assert.equal(typeof install.invoke.command, "string");
    assert.ok(Array.isArray(install.invoke.args));
  }
});

test("every install found on this machine can be started from its descriptor", async (t) => {
  const installs = discoverInstalls({ withVersions: false }).filter((i) => i.invoke);

  if (!installs.length) {
    // CI runners have none of these agents. The descriptor's logic is covered
    // above; this test proves it against reality when reality is present.
    return t.skip("no agent CLI installed here");
  }

  for (const install of installs) {
    const result = await trySpawn(install.invoke.command, [...install.invoke.args, "--version"]);
    assert.ok(
      result.ok,
      `${install.agent} (${install.kind}): spawning the descriptor failed (${result.why}) - ` +
        `command=${path.basename(install.invoke.command)} via=${install.invoke.via}`
    );
  }
});

test("resolve carries the invocation into its alternatives too", async () => {
  const { resolveAgent } = await import("../src/models.mjs");

  const installs = discoverInstalls({ withVersions: false });
  const agents = [...new Set(installs.map((i) => i.agent))];
  const agent = agents.find((a) => installs.filter((i) => i.agent === a).length > 1);
  if (!agent) return; // one install each here, nothing to compare

  const answer = await resolveAgent(agent, { installs });

  // The README's own example is a model the PATH build refuses and the VS Code
  // build accepts. Saying where it works without saying how to start it there
  // is half an answer, and 0.6.0 had just established that a path alone is not
  // something you can spawn.
  for (const alternative of answer.alternatives ?? []) {
    if (alternative.error) continue;
    assert.ok(alternative.invoke, `alternative ${alternative.kind} has no invocation`);
  }
});

test("the help names the command the project is built around", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  // fileURLToPath, not pathname: stripping a leading slash is a Windows-only
  // trick that would hand CI a relative path on Linux and macOS.
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout ?? "";

  // resolve was absent from --help for four releases while the README, the
  // skill and the npm description all described it as central.
  assert.match(help, /resolve/, "--help does not mention resolve");
  assert.match(help, /--stdin/, "--help does not mention setup --stdin");
  assert.match(help, /doctor/);
});

test("a path with shell metacharacters is not a command line", async () => {
  const { probeVersion } = await import("../src/installs.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");

  // Windows forbids < > : " / \ | ? * in filenames, so a payload cannot
  // redirect, and cannot close the quote the old implementation wrapped the
  // path in. `&` is legal, and was the interesting case: tested against the
  // pre-fix code it did NOT execute, because the quoting held. Fixed anyway -
  // it was the last place interpolating a path into a command line, and being
  // safe by accident is not a property to depend on.
  const dir = fs.default.mkdtempSync(path.join(os.default.tmpdir(), "agent-runway-meta-"));
  try {
    const name = process.platform === "win32" ? "tool& mkdir INJECTED &rem .cmd" : "tool; mkdir INJECTED; :";
    const file = path.join(dir, name);
    fs.default.writeFileSync(file, process.platform === "win32" ? "@echo 1.2.3\r\n" : "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });

    const previous = process.cwd();
    process.chdir(dir);
    try {
      probeVersion(file);
    } finally {
      process.chdir(previous);
    }

    assert.ok(!fs.default.existsSync(path.join(dir, "INJECTED")), "the chained command ran");
  } finally {
    fs.default.rmSync(dir, { recursive: true, force: true });
  }
});

test("a path cmd.exe would act on is refused, not described", () => {
  // There is no cmd.exe form that is both injection-safe and shaped like
  // {command, args}: the only safe one needs windowsVerbatimArguments and a
  // single command string, which a caller cannot append its own arguments to.
  // So the descriptor declines rather than handing back something that might
  // run a second command.
  const refused = invocationFor({ path: "C:/npm/tool& mkdir X &rem .cmd" }, "win32");
  assert.equal(refused.via, "unsafe");
  assert.equal(refused.command, null, "a refused descriptor must not be spawnable");
  assert.match(refused.reason, /cmd\.exe/);

  // And an ordinary path is still described normally.
  const fine = invocationFor({ path: "C:/npm/gemini.cmd" }, "win32");
  assert.equal(fine.via, "cmd");
  assert.ok(fine.command);
});
