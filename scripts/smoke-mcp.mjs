#!/usr/bin/env node
// Manual smoke test: drives the MCP server over stdio with the official SDK
// client, so the hand-rolled JSON-RPC framing is checked against the real
// implementation rather than against itself.
//
// Needs network access and working credentials, so it is not part of `npm test`.
//
//   node scripts/smoke-mcp.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "mcp.mjs");

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
console.log("connected:", JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
console.log("\ntools:");
for (const tool of tools) {
  console.log("  " + tool.name);
  console.log("    input : " + Object.keys(tool.inputSchema?.properties ?? {}).join(", "));
  console.log("    output: " + Object.keys(tool.outputSchema?.properties ?? {}).join(", "));
}

const calls = [
  { name: "get_usage", arguments: { provider: "codex" } },
  { name: "check_capacity", arguments: { threshold: 90 } },
  { name: "list_models", arguments: { agent: "codex" } },
];

for (const call of calls) {
  const result = await client.callTool(call);
  console.log("\n--- " + call.name + " isError=" + Boolean(result.isError) + " ---");
  console.log(result.content.map((c) => c.text).join("\n").slice(0, 400));
  if (result.structuredContent) {
    console.log("structured keys: " + Object.keys(result.structuredContent).join(", "));
  }
}

await client.close();
console.log("\nok");
