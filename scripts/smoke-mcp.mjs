#!/usr/bin/env node
// Manual smoke test: drives the MCP server over stdio with a real client.
// Needs network access and a working token, so it is not part of `npm test`.
//
//   node scripts/smoke-mcp.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "mcp.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
console.log("connected:", JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
console.log("\ntools:");
for (const tool of tools) {
  console.log(`  ${tool.name}`);
  console.log(`    input : ${JSON.stringify(tool.inputSchema?.properties ?? {})}`);
  console.log(`    output: ${Object.keys(tool.outputSchema?.properties ?? {}).join(", ") || "(none)"}`);
}

for (const format of ["short", "summary"]) {
  const result = await client.callTool({
    name: "get_claude_usage",
    arguments: { format },
  });
  console.log(`\n--- format=${format} isError=${Boolean(result.isError)} ---`);
  console.log(result.content.map((c) => c.text).join("\n"));
  if (result.structuredContent) {
    console.log("structured:", JSON.stringify({
      peakPercent: result.structuredContent.peakPercent,
      endpoint: result.structuredContent.endpoint,
      windows: result.structuredContent.windows.length,
    }));
  }
}

await client.close();
console.log("\nok");
