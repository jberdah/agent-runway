# claude-usage

Check how much of your Claude subscription quota is left — the 5-hour session
window, the weekly windows, how much of each is consumed, and when they reset.

Same data three ways: a **CLI**, a **Claude Code skill**, and an **MCP tool** any
client can call.

```
$ claude-usage

Claude usage

  Session (5h)                    [###.................]  15 %
                                  resets 2026-09-12 02:40Z (in 4h 44m)
* Weekly - all models             [################....]  79 %  <-- warning
                                  resets 2026-09-15 03:00Z (in 3d 5h)
  Weekly - Opus                   [##########..........]  52 %
                                  resets 2026-09-15 03:00Z (in 3d 5h)

  Extra usage credits: disabled

  * = window currently being counted against
```

## Why

Claude Code shows this behind `/usage`, interactively. That does not help an
agent decide whether a long task or a fan-out of subagents will fit in the
remaining budget, and it does not help a script. This exposes the same numbers
to the terminal, to a skill, and to any MCP client.

## Install

### As a Claude Code plugin (skill + MCP tool)

```
/plugin marketplace add jberdah/claude-usage
/plugin install claude-usage@claude-usage
```

Claude then reads your usage whenever it is relevant — ask "how much quota do I
have left?" or let it check before a long task.

### As an MCP server, in any client

No install step: it has no dependencies, so pointing a client at the file is
enough.

```jsonc
// Claude Desktop: claude_desktop_config.json
{
  "mcpServers": {
    "claude-usage": {
      "command": "node",
      "args": ["/absolute/path/to/claude-usage/src/mcp.mjs"]
    }
  }
}
```

For Claude Code specifically:

```bash
claude mcp add claude-usage -- node /absolute/path/to/claude-usage/src/mcp.mjs
```

### As a CLI

```bash
npm install -g claude-usage    # or: git clone && npm link
claude-usage --short
```

Cloning is enough to run it — `node src/cli.mjs` needs nothing installed.

## Authentication

Generate a long-lived token **yourself** — it opens a browser and prints a
year-long account secret, so no tool should do it for you:

```bash
claude setup-token
```

Then export it:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..."
```

Sources are tried in this order, first match wins:

| Source | Notes |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token`, recommended |
| `CLAUDE_USAGE_TOKEN` | if you want a variable scoped to this tool |
| `ANTHROPIC_AUTH_TOKEN` | already set in many setups |
| `~/.claude/usage-token` | a file holding the token on one line |
| `~/.claude/.credentials.json` | Claude Code's own session token |

The last one makes the tool work with no setup at all, but it is a convenience
rather than a contract: on macOS the live token lives in the Keychain and on
Windows in the Credential Manager, so that file is often absent or stale. Set
`CLAUDE_USAGE_NO_LOCAL_CREDENTIALS=1` to skip it entirely.

`CLAUDE_ORG_ID` overrides the organization UUID, which is only needed by the
claude.ai fallback endpoint.

## CLI reference

| Flag | Output |
| --- | --- |
| *(none)* | Readable table |
| `--short` | One line: `session=15%  weekly_all=79%  weekly_scoped=52%` |
| `--json` | Raw API response |
| `--plain` | Table without the header |

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | unexpected error |
| 2 | no token found |
| 3 | token rejected — regenerate it |
| 4 | the usage endpoint is throttling; not your quota |

## Security

- **No token is ever printed, logged or returned**, not even a prefix. A unit
  test asserts this against every rendered output.
- The MCP tool returns usage numbers only, never credentials.
- The tool never runs `claude setup-token` for you, and never reads browser
  cookies or an OS keychain.
- Read-only: every request is a `GET`.

## How it works

Two internal endpoints, tried in order, both authenticated with
`Authorization: Bearer sk-ant-oat01-...` and `anthropic-beta: oauth-2025-04-20`:

1. `https://api.anthropic.com/api/oauth/usage`
2. `https://claude.ai/api/organizations/{org}/usage`

**These endpoints are internal and undocumented. They can change or disappear
without notice.** Parsing is written to degrade rather than break: it prefers
the canonical `limits` array, falls back to scanning top-level window objects,
and prints raw JSON if it recognises nothing. If the output ever looks wrong,
`--json` shows exactly what the API returned.

## Development

```bash
npm install     # dev only: the MCP SDK, used to test the server as a real client
npm test        # unit tests, no network
npm run smoke   # drives the MCP server over stdio; needs network and a token
```

The runtime has **zero dependencies**. `src/mcp.mjs` speaks JSON-RPC directly
rather than importing the MCP SDK, because a Claude Code plugin installed from
git is never `npm install`ed — an imported dependency would have to be vendored.
`scripts/smoke-mcp.mjs` connects the official SDK client to it, so the
hand-rolled framing is checked against the real implementation.

```
src/core.mjs     token resolution, HTTP, response normalization
src/render.mjs   text rendering
src/cli.mjs      CLI entry point, also what the skill shells out to
src/mcp.mjs      MCP stdio server
skills/          the Claude Code skill
.claude-plugin/  plugin and marketplace manifests
```

## License

MIT
