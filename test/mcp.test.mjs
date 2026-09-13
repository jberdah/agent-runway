// The MCP server's protocol behaviour.
//
// scripts/smoke-mcp.mjs drives this server with the official SDK client, which
// is the right check for "does a real client accept our framing" — but it needs
// a dev dependency, so it is not part of `npm test` and it only exercises the
// happy path. These cover what a hand-rolled JSON-RPC loop gets wrong: a line
// that is not JSON, a method nobody implemented, a notification with no id.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { makeWindow } from "../src/providers/shared.mjs";

const SERVER = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runway-mcptest-"));
after(() => fs.rmSync(CACHE_DIR, { recursive: true, force: true }));

for (const provider of ["claude", "codex", "copilot", "antigravity"]) {
  fs.writeFileSync(
    path.join(CACHE_DIR, `${provider}.json`),
    JSON.stringify({
      at: Date.now(),
      value: {
        provider,
        label: provider,
        status: "ok",
        plan: null,
        allowed: null,
        windows: [makeWindow({ kind: "session", percentUsed: 5 })],
        detail: null,
        checkedAt: new Date().toISOString(),
      },
    })
  );
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

/**
 * Feed the server a script of lines and collect `expect` responses.
 * A string is written verbatim, so a test can send something that is not JSON.
 */
function rpc(lines, { env = {}, expect = 1, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, AGENT_RUNWAY_CACHE_DIR: CACHE_DIR, AGENT_RUNWAY_CACHE_MS: "600000", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const received = [];
    let buffer = "";
    let stderr = "";

    const done = (fn, value) => {
      clearTimeout(timer);
      child.kill();
      fn(value);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`timed out with ${received.length}/${expect} replies. stderr: ${stderr}`)),
      timeoutMs
    );

    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        try {
          received.push(JSON.parse(line));
        } catch (error) {
          return done(reject, new Error(`server wrote a non-JSON line to stdout: ${line}`));
        }
        if (received.length >= expect) return done(resolve, received);
      }
    });
    child.on("error", (error) => done(reject, error));

    for (const line of lines) {
      child.stdin.write(typeof line === "string" ? `${line}\n` : `${JSON.stringify(line)}\n`);
    }
  });
}

test("every tool declares the envelope in its output schema", async () => {
  const [, list] = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }], { expect: 2 });

  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_capacity", "diagnose_setup", "get_usage", "list_models"]);

  for (const tool of list.result.tools) {
    // A client that validates structuredContent against this schema is the
    // only thing standing between a renamed field and a silent contract break.
    assert.ok(tool.outputSchema, `${tool.name} has no output schema`);
    for (const key of ["tool", "toolVersion", "kind"]) {
      assert.ok(tool.outputSchema.required.includes(key), `${tool.name} does not require ${key}`);
    }
  }
});

test("a line that is not JSON is a parse error, and the session continues", async () => {
  const replies = await rpc(
    [INIT, "this is not json at all", "{ broken", { jsonrpc: "2.0", id: 3, method: "tools/list" }],
    { expect: 4 }
  );

  // JSON-RPC has a prescribed answer for unparseable input, and a null id is
  // part of it: there is no request id to echo back.
  for (const reply of replies.slice(1, 3)) {
    assert.equal(reply.id, null);
    assert.equal(reply.error.code, -32700);
  }

  // And the point of the test: the work after the garbage still happens.
  assert.equal(replies.at(-1).id, 3);
  assert.ok(Array.isArray(replies.at(-1).result.tools));
});

test("an unimplemented method is an error reply, not a crash", async () => {
  const [, reply] = await rpc([INIT, { jsonrpc: "2.0", id: 4, method: "resources/list" }], { expect: 2 });
  assert.equal(reply.id, 4);
  assert.ok(reply.error, "a method we do not implement must answer with an error");
});

test("a notification is not answered, and does not stall what follows", async () => {
  // No id means no reply is owed. Answering one is a protocol violation that
  // some clients treat as fatal.
  const replies = await rpc(
    [INIT, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 5, method: "tools/list" }],
    { expect: 2 }
  );
  assert.deepEqual(replies.map((r) => r.id), [1, 5]);
});

test("diagnose_setup answers with the doctor envelope and no credential", async () => {
  // A cookie in the environment and no token: the Claude read fails before it
  // reaches the network, while the cookie is still resolved and reported. So
  // there is a real secret present for the redaction check to be about.
  const COOKIE = "sk-ant-sid01-MCPTESTCOOKIEVALUE";
  const [, reply] = await rpc(
    [INIT, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "diagnose_setup", arguments: {} } }],
    {
      expect: 2,
      env: {
        AGENT_RUNWAY_CLAUDE_COOKIE: COOKIE,
        CLAUDE_CODE_OAUTH_TOKEN: "",
        AGENT_RUNWAY_TOKEN: "",
        ANTHROPIC_AUTH_TOKEN: "",
        AGENT_RUNWAY_NO_LOCAL_CREDENTIALS: "1",
      },
    }
  );

  const structured = reply.result.structuredContent;
  assert.equal(structured.tool, "agent-runway");
  assert.equal(structured.kind, "doctor");
  assert.equal(structured.claude.cookie.found, true, "the cookie was resolved, so it could have leaked");
  assert.equal(structured.claude.cookie.source, "env AGENT_RUNWAY_CLAUDE_COOKIE");

  const whole = JSON.stringify(reply);
  assert.ok(!whole.includes(COOKIE), "the MCP reply leaks a credential");
  assert.ok(!whole.includes(COOKIE.slice(0, 20)), "a credential prefix survives in the MCP reply");
});

test("the tool schema offers every agent the tool can actually answer for", async () => {
  const [, list] = await rpc([INIT, { jsonrpc: "2.0", id: 7, method: "tools/list" }], { expect: 2 });
  const listModels = list.result.tools.find((t) => t.name === "list_models");

  const { SPAWNABLE } = await import("../src/models.mjs");

  // These two lists drifted once. Gemini was spawnable everywhere except in
  // this enum, so list_models({}) returned a Gemini catalogue while
  // list_models({agent: "gemini"}) was refused by the schema before the handler
  // ever ran. The duplication is deliberate - importing models.mjs to list
  // tools would pull binary scanning into startup - so this asserts it instead.
  assert.deepEqual(
    [...listModels.inputSchema.properties.agent.enum].sort(),
    [...SPAWNABLE].sort(),
    "the MCP enum and models.SPAWNABLE must name the same agents"
  );
});
