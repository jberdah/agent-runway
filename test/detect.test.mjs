import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { detectProviders, formatProvider, PROVIDERS } from "../src/detect.mjs";

/** A throwaway home directory with the given relative paths created. */
function fakeHome(entries = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-detect-test-"));
  for (const entry of entries) {
    const target = path.join(home, entry);
    if (entry.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "x");
    }
  }
  return home;
}

const find = (list, id) => list.find((p) => p.id === id);

test("a config directory is enough to call a provider installed", () => {
  const home = fakeHome([".claude/", ".codex/"]);
  try {
    const found = detectProviders({ home, env: {}, platform: "linux" });
    assert.equal(find(found, "claude").installed, true);
    assert.equal(find(found, "claude").how, "~/.claude directory");
    assert.equal(find(found, "codex").installed, true);
    assert.equal(find(found, "codex").how, "~/.codex directory");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installed and credentials are separate answers", () => {
  const home = fakeHome([".codex/"]);
  try {
    const codex = find(detectProviders({ home, env: {}, platform: "linux" }), "codex");
    assert.equal(codex.installed, true, "the agent is here");
    assert.equal(codex.credentials, null, "but nothing to authenticate with");
    assert.equal(codex.credentialHint, "codex login");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("codex credentials come from auth.json", () => {
  const home = fakeHome([".codex/auth.json"]);
  try {
    const codex = find(detectProviders({ home, env: {}, platform: "linux" }), "codex");
    assert.equal(codex.credentials, "~/.codex/auth.json");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("claude prefers an explicit env token over the stale credentials file", () => {
  const home = fakeHome([".claude/.credentials.json"]);
  try {
    const withFile = find(detectProviders({ home, env: {}, platform: "linux" }), "claude");
    assert.match(withFile.credentials, /credentials\.json/);

    const withEnv = find(
      detectProviders({ home, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-x" }, platform: "linux" }),
      "claude"
    );
    assert.equal(withEnv.credentials, "CLAUDE_CODE_OAUTH_TOKEN env");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("copilot is detected from a VS Code extension folder", () => {
  const home = fakeHome([".vscode/extensions/github.copilot-1.2.3/"]);
  try {
    const copilot = find(detectProviders({ home, env: {}, platform: "linux" }), "copilot");
    assert.equal(copilot.installed, true);
    assert.equal(copilot.how, "VS Code extension");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("gh hosts.yml lives in a different place per platform", () => {
  // POSIX: $XDG_CONFIG_HOME/gh, defaulting to ~/.config/gh
  const posixHome = fakeHome([".config/gh/hosts.yml"]);
  try {
    const copilot = find(detectProviders({ home: posixHome, env: {}, platform: "linux" }), "copilot");
    assert.equal(copilot.credentials, "gh hosts.yml");
  } finally {
    fs.rmSync(posixHome, { recursive: true, force: true });
  }

  // Windows: %APPDATA%/GitHub CLI
  const winHome = fakeHome(["AppData/Roaming/GitHub CLI/hosts.yml"]);
  try {
    const env = { APPDATA: path.join(winHome, "AppData", "Roaming") };
    const copilot = find(detectProviders({ home: winHome, env, platform: "win32" }), "copilot");
    assert.equal(copilot.credentials, "gh hosts.yml");
  } finally {
    fs.rmSync(winHome, { recursive: true, force: true });
  }
});

test("XDG_CONFIG_HOME is honoured when set", () => {
  const home = fakeHome(["custom-config/gh/hosts.yml"]);
  try {
    const env = { XDG_CONFIG_HOME: path.join(home, "custom-config") };
    const copilot = find(detectProviders({ home, env, platform: "linux" }), "copilot");
    assert.equal(copilot.credentials, "gh hosts.yml");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an unreadable extensions directory is not fatal", () => {
  const home = fakeHome([".vscode/extensions"]); // a file where a directory is expected
  try {
    assert.doesNotThrow(() => detectProviders({ home, env: {}, platform: "linux" }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("formatProvider states read clearly", () => {
  assert.match(
    formatProvider({ label: "OpenAI Codex", installed: false }, 0),
    /1\).*OpenAI Codex.*not found/
  );
  assert.match(
    formatProvider({ label: "OpenAI Codex", installed: true, credentials: "~/.codex/auth.json" }, 1),
    /2\).*ready - ~\/\.codex\/auth\.json/
  );
  assert.match(
    formatProvider(
      { label: "OpenAI Codex", installed: true, credentials: null, credentialHint: "codex login" },
      2
    ),
    /no credentials.*codex login/
  );
});

test("every provider declares what its quota looks like", () => {
  for (const provider of PROVIDERS) {
    assert.ok(provider.id && provider.label && provider.quota, `${provider.id} is incomplete`);
    assert.equal(typeof provider.detect, "function");
    assert.equal(typeof provider.credentials, "function");
  }
});
