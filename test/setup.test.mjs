import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { envExportLine, persistToken, shellProfilePath, tokenLooksValid } from "../src/setup.mjs";

// These tests exist because the setup path is platform-dependent and CI for
// this project realistically runs on one platform at a time. Injecting the
// platform and environment is what makes the macOS and Linux branches testable
// from anywhere.

test("shellProfilePath picks the right rc file per shell and platform", () => {
  const home = "/home/u";
  assert.equal(shellProfilePath({ SHELL: "/bin/zsh" }, home, "linux"), path.join(home, ".zshrc"));
  assert.equal(shellProfilePath({ SHELL: "/bin/zsh" }, home, "darwin"), path.join(home, ".zshrc"));

  // Login shells read .bash_profile on macOS, .bashrc on Linux.
  assert.equal(shellProfilePath({ SHELL: "/bin/bash" }, home, "linux"), path.join(home, ".bashrc"));
  assert.equal(
    shellProfilePath({ SHELL: "/bin/bash" }, home, "darwin"),
    path.join(home, ".bash_profile")
  );

  assert.equal(
    shellProfilePath({ SHELL: "/usr/bin/fish" }, home, "linux"),
    path.join(home, ".config", "fish", "config.fish")
  );
});

test("shellProfilePath returns null rather than guessing", () => {
  const home = "/home/u";
  assert.equal(shellProfilePath({ SHELL: "/bin/zsh" }, home, "win32"), null);
  assert.equal(shellProfilePath({ SHELL: "/bin/tcsh" }, home, "linux"), null);
  assert.equal(shellProfilePath({}, home, "linux"), null);
});

test("envExportLine references the token file, never a literal secret", () => {
  const posix = envExportLine("/home/u/.zshrc");
  assert.match(posix, /export CLAUDE_USAGE_TOKEN=/);
  assert.match(posix, /cat \$HOME\/\.claude\/usage-token/);
  assert.ok(!posix.includes("sk-ant-"), "the export line must not embed a token");

  const fish = envExportLine("/home/u/.config/fish/config.fish");
  assert.match(fish, /set -gx CLAUDE_USAGE_TOKEN/);
  assert.match(fish, /cat \$HOME\/\.claude\/usage-token/);
});

test("envExportLine is tagged so a rerun can detect it", () => {
  assert.ok(envExportLine("/home/u/.zshrc").includes("# agent-runway"));
  assert.ok(envExportLine("/home/u/.config/fish/config.fish").includes("# agent-runway"));
});

test("tokenLooksValid accepts real shapes and rejects junk", () => {
  assert.equal(tokenLooksValid("sk-ant-oat01-" + "A".repeat(40)), true);
  assert.equal(tokenLooksValid("  sk-ant-oat01-" + "b_9-".repeat(10) + "  "), true);

  assert.equal(tokenLooksValid(""), false);
  assert.equal(tokenLooksValid("hunter2"), false);
  assert.equal(tokenLooksValid("sk-ant-"), false, "prefix alone is not a token");
  assert.equal(tokenLooksValid("sk-ant-short"), false);
  assert.equal(tokenLooksValid(null), false);
  assert.equal(tokenLooksValid(undefined), false);
  assert.equal(tokenLooksValid(12345), false);
});

test("persistToken writes the token file, restricted on POSIX", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-test-"));
  try {
    const token = "sk-ant-oat01-" + "C".repeat(40);
    const file = persistToken(token, home);

    assert.equal(file, path.join(home, ".claude", "usage-token"));
    assert.equal(fs.readFileSync(file, "utf8").trim(), token);

    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, "the token file must not be group or world readable");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("persistToken creates the .claude directory when missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-test-"));
  try {
    assert.ok(!fs.existsSync(path.join(home, ".claude")));
    persistToken("sk-ant-oat01-" + "D".repeat(40), home);
    assert.ok(fs.existsSync(path.join(home, ".claude")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
