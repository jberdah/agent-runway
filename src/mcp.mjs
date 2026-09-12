#!/usr/bin/env node
// MCP stdio server: the same three questions the CLI answers, exposed as tools
// an agent can call for itself.
//
// Deliberately dependency-free: a Claude Code plugin installed from git is not
// npm-installed, so anything imported here would have to be vendored. The
// protocol surface needed is small, and scripts/smoke-mcp.mjs drives it with
// the official SDK client so the hand-rolled framing stays honest.
//
// stdout carries the JSON-RPC stream. Nothing else may ever be written to it;
// diagnostics go to stderr.

import { createInterface } from "node:readline";

import { VERSION } from "./core.mjs";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = SUPPORTED_PROTOCOLS[0];

const PROVIDERS = ["claude", "codex", "copilot", "antigravity"];
const SPAWNABLE_AGENTS = ["claude", "codex", "copilot"];

// Permissive on purpose: these payloads describe undocumented upstreams that
// can grow a field without warning, and a strict schema would turn that into a
// client-side validation error rather than an extra key nobody reads.
const LOOSE = { type: "object", additionalProperties: true };

const TOOLS = [
  {
    name: "get_usage",
    title: "Read remaining runway",
    description:
      "How much quota is left on each coding agent signed in on this machine: " +
      "percentage consumed of every rate-limit window, and when each resets. " +
      "Covers Claude, Codex, GitHub Copilot and Antigravity, each read with the " +
      "credentials that agent already keeps. One provider failing never stops " +
      "the others. Use before a long task or a fan-out of subagents. Returns no " +
      "credentials.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...PROVIDERS, "all"],
          description: "Which agent to read. Defaults to all of them.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { providers: { type: "array", items: LOOSE } },
      required: ["providers"],
      additionalProperties: true,
    },
  },
  {
    name: "check_capacity",
    title: "Decide whether there is room to work",
    description:
      "Answers whether work can start now, rather than reporting numbers to " +
      "interpret. Each provider comes back as proceed, defer or unknown - three " +
      "outcomes because an agent that cannot be read has not got room, it is " +
      "simply unknown. Defer carries the time its binding window resets, which " +
      "is when the window rolls over and not a promise that service resumes " +
      "exactly then. The recommendation states its own rule and whether the " +
      "candidates were comparable at all: 0% of a five-hour window is not 0% of " +
      "a monthly allowance.",
    inputSchema: {
      type: "object",
      properties: {
        threshold: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Percent consumed above which to defer. A policy, not a fact: at 92% " +
            "the provider is not blocked, your rule says do not start. Default 90.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        threshold: { type: "number" },
        providers: { type: "array", items: LOOSE },
        anyUnknown: { type: "boolean" },
      },
      required: ["threshold", "providers", "anyUnknown"],
      additionalProperties: true,
    },
  },
  {
    name: "list_models",
    title: "Which models an installed agent will accept",
    description:
      "Before spawning another agent, the slug its binary actually accepts. A " +
      "machine carries several builds of the same agent - a CLI on PATH, one " +
      "inside a VS Code extension, one inside a desktop app - and they disagree: " +
      "a model offered by one is rejected by another. Each catalogue says how it " +
      "was obtained, declared when the binary was asked and answered, inferred " +
      "when identifiers were read out of it. Treat inferred as strong evidence " +
      "rather than a contract, and be ready for a spawn to fail anyway. Also " +
      "reports which installs disagree.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: SPAWNABLE_AGENTS,
          description:
            "Restrict to one agent. Only agents that can be spawned with a model " +
            "argument are covered; an IDE is not one of them.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        catalogues: { type: "array", items: LOOSE },
        skew: { type: "array", items: LOOSE },
      },
      required: ["catalogues", "skew"],
      additionalProperties: true,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const answer = (text, structuredContent) => ({ content: [{ type: "text", text }], structuredContent });

// ------------------------------------------------------------------ handlers

async function getUsage(args) {
  const { readAll } = await import("./providers/index.mjs");
  const { renderProviders } = await import("./render.mjs");

  const wanted = args?.provider && args.provider !== "all" ? [args.provider] : undefined;
  const providers = await readAll(wanted ? { providers: wanted } : {});

  return answer(renderProviders(providers), { providers });
}

async function checkCapacity(args) {
  const { readAll, capacity } = await import("./providers/index.mjs");
  const decision = capacity(await readAll(), { threshold: args?.threshold ?? 90 });

  const lines = decision.providers.map(
    (p) => `${p.provider}: ${p.decision}${p.binding ? ` (${p.binding.label} ${p.binding.percentUsed}%)` : ""}` +
      `${p.retryAt ? ` - retry at ${p.retryAt}` : ""}`
  );
  if (decision.recommended) {
    lines.push("");
    lines.push(
      `recommended: ${decision.recommended.provider}, ${decision.recommended.percentUsed}% of ` +
        `${decision.recommended.window}` +
        (decision.recommended.comparable ? "" : " (candidates are not directly comparable)")
    );
  }
  return answer(lines.join("\n"), decision);
}

async function listModels(args) {
  const [{ discoverInstalls }, models, { renderModels }] = await Promise.all([
    import("./installs.mjs"),
    import("./models.mjs"),
    import("./render.mjs"),
  ]);

  const installs = discoverInstalls({ withVersions: true }).filter(
    (i) => models.SPAWNABLE.includes(i.agent) && (!args?.agent || i.agent === args.agent)
  );
  const catalogues = await models.modelsForAll(installs);
  const skew = models.modelSkew(catalogues);

  return answer(renderModels(catalogues, skew), { catalogues, skew });
}

const HANDLERS = { get_usage: getUsage, check_capacity: checkCapacity, list_models: listModels };

async function callTool(params) {
  const handler = HANDLERS[params?.name];
  if (!handler) return null;

  try {
    return await handler(params.arguments ?? {});
  } catch (error) {
    // A failed lookup is a tool-level error, not a protocol one: the client
    // should surface it to the model rather than tear down the connection.
    return { content: [{ type: "text", text: `Failed: ${error?.message ?? error}` }], isError: true };
  }
}

// ------------------------------------------------------------------ protocol

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-runway", version: VERSION },
      });
      return;
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications take no response

    case "ping":
      reply(id, {});
      return;

    case "tools/list":
      reply(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const result = await callTool(params);
      if (!result) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
      reply(id, result);
      return;
    }

    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const input = createInterface({ input: process.stdin });

// A tools/call does network and process work, so a request can still be in
// flight when stdin closes. Track them and drain before exiting, otherwise
// piped input loses the response.
const inFlight = new Set();

input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const pending = handle(message)
    .catch((error) => {
      process.stderr.write(`agent-runway-mcp: ${error?.stack ?? error}\n`);
      if (message?.id != null) replyError(message.id, -32603, "Internal error");
    })
    .finally(() => inFlight.delete(pending));

  inFlight.add(pending);
});

input.on("close", async () => {
  await Promise.allSettled([...inFlight]);
  // No process.exit() here: it tears down stdout mid-write, which aborts the
  // process on Windows. With stdin closed and nothing pending, the event loop
  // empties and Node exits once the last write has flushed.
  process.exitCode = 0;
});
