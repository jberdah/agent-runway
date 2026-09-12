#!/usr/bin/env node
// MCP stdio server exposing remaining runway as a native tool to any MCP client
// (Claude Desktop, Claude Code, Cursor, ...).
//
// Deliberately dependency-free: a Claude Code plugin installed from git is not
// npm-installed, so anything this file imports would have to be vendored. The
// protocol surface needed here is small, and scripts/smoke-mcp.mjs exercises it
// with the official SDK client so the hand-rolled framing stays honest.
//
// stdout carries the JSON-RPC stream. Nothing else may ever be written to it;
// diagnostics go to stderr.

import { createInterface } from "node:readline";

import { fetchUsage, UsageError, VERSION } from "./core.mjs";
import { peak, renderShort, renderTable } from "./render.mjs";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = SUPPORTED_PROTOCOLS[0];

const TOOL = {
  name: "get_usage",
  title: "Get remaining runway",
  description:
    "Read the current rate-limit windows of the signed-in coding agent subscription: " +
    "percentage consumed of the 5-hour session window and of the weekly windows, " +
    "plus when each one resets. Use it when the user asks how much quota is left, " +
    "or before starting a long task or a fan-out of subagents, to check there is " +
    "enough headroom. Reads Claude today; a provider argument will be added once " +
    "other agents are supported. Returns no credentials.",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["summary", "short", "json"],
        description:
          "summary: readable table (default). short: one line, e.g. 'session=11%  weekly_all=78%'. json: raw API response.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      windows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            percent: { type: "number" },
            severity: { type: "string" },
            resetsAt: { type: ["string", "null"] },
            active: { type: "boolean" },
            model: { type: ["string", "null"] },
          },
          required: ["id", "label", "percent", "severity", "resetsAt", "active", "model"],
          additionalProperties: false,
        },
      },
      peakPercent: { type: ["number", "null"] },
      extraUsageEnabled: { type: ["boolean", "null"] },
      endpoint: { type: "string" },
    },
    required: ["windows", "peakPercent", "extraUsageEnabled", "endpoint"],
    additionalProperties: false,
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(params) {
  const format = params?.arguments?.format ?? "summary";

  try {
    const usage = await fetchUsage();

    let text;
    if (format === "json") text = JSON.stringify(usage.raw, null, 2);
    else if (format === "short") text = renderShort(usage);
    else text = renderTable(usage);

    const highest = peak(usage);

    return {
      content: [{ type: "text", text }],
      structuredContent: {
        windows: usage.windows,
        peakPercent: highest ? Math.round(highest.percent) : null,
        extraUsageEnabled: usage.extraUsage ? usage.extraUsage.enabled : null,
        endpoint: usage.endpoint,
      },
    };
  } catch (error) {
    // A failed lookup is a tool-level error, not a protocol error: the client
    // should surface it to the model rather than tear down the connection.
    const message = error instanceof UsageError
      ? [error.message, error.hint].filter(Boolean).join("\n\n")
      : `Unexpected error: ${error?.message ?? error}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

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
      reply(id, { tools: [TOOL] });
      return;

    case "tools/call": {
      if (params?.name !== TOOL.name) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      reply(id, await callTool(params));
      return;
    }

    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const input = createInterface({ input: process.stdin });

// A tools/call does network I/O, so a request can still be in flight when stdin
// closes. Track them and drain before exiting, otherwise piped input loses the
// response.
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
  // process on Windows. With stdin closed and nothing left pending, the event
  // loop empties and Node exits on its own once the last write has flushed.
  process.exitCode = 0;
});
