# agent-runway

How much runway is left before your coding agent hits a rate limit — which
windows are consumed, and when each one resets.

Same answer three ways: a **CLI**, a **Claude Code skill**, and an **MCP tool**
any client can call, so the reasoning happens once instead of in every model.

> **Unofficial.** This reads undocumented Anthropic endpoints. It can stop
> working without notice and is not a compatibility contract with anyone.

**Claude works today. Codex and GitHub Copilot are next** — the provider
adapters are the next piece of work, not a promise already delivered.

*Part of the [brainclaw](https://brainclaw.dev) toolkit.*

```
$ agent-runway

Runway - Claude

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

### Quickest path

```bash
npm install -g agent-runway
agent-runway setup
```

Or without installing anything globally:

```bash
git clone https://github.com/jberdah/agent-runway && cd agent-runway
node src/cli.mjs setup
```

`setup` is one guided pass, identical on Windows, macOS and Linux. It checks
whether a token already works, runs `claude setup-token` for you if you want it
to (you complete the browser sign-in), reads the token back without echoing it,
**validates it against the API before saving anything**, then writes it to
`~/.claude/usage-token` with mode 0600 and prints your current usage.

Re-running it is safe: it reports that things already work and changes nothing
unless you pass `--force`.

### As a Claude Code plugin (skill + MCP tool)

```
/plugin marketplace add jberdah/agent-runway
/plugin install agent-runway@agent-runway
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
    "agent-runway": {
      "command": "node",
      "args": ["/absolute/path/to/agent-runway/src/mcp.mjs"]
    }
  }
}
```

For Claude Code specifically:

```bash
claude mcp add agent-runway -- node /absolute/path/to/agent-runway/src/mcp.mjs
```

### As a CLI

```bash
npm install -g agent-runway    # or: git clone && npm link
agent-runway --short
```

Cloning is enough to run it — `node src/cli.mjs` needs nothing installed.

## Authentication

`agent-runway setup` handles this. What follows is what it does, for anyone who
would rather do it by hand or automate it.

A long-lived token comes from `claude setup-token`, which opens a browser and
prints an account secret. Setup can launch it for you, but **you** complete the
sign-in — no tool should authenticate on your behalf.

"Long-lived" is that command's own wording; its exact lifetime is not something
this project has measured. What matters here is the contrast with the last
fallback source below, which is a session token that expires within hours unless
Claude Code is running to refresh it.

### Why a file rather than an environment variable

Setup writes the token to `~/.claude/usage-token` (mode 0600) instead of
exporting it. On macOS and Linux, a persistent environment variable means
writing the secret into a shell rc file, which is commonly mode 644 and
sometimes committed to a dotfiles repository. One 0600 file is safer, behaves
identically on all three platforms, is picked up by every invocation whatever
your shell, and is revoked by deleting it.

`agent-runway setup --env` still wires up the variable if you want it. On POSIX
it appends an indirection rather than a second copy of the secret:

```sh
export AGENT_RUNWAY_TOKEN="$(cat $HOME/.claude/usage-token 2>/dev/null)"
```

On Windows it sets a user-level variable, passing the value through stdin so the
token never appears in a process list.

Environment variables remain the right mechanism in CI, where the secret comes
from the platform's own secret store.

Sources are tried in this order, first match wins:

| Source | Notes |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token`, recommended |
| `AGENT_RUNWAY_TOKEN` | if you want a variable scoped to this tool |
| `ANTHROPIC_AUTH_TOKEN` | already set in many setups |
| `~/.claude/usage-token` | a file holding the token on one line |
| `~/.claude/.credentials.json` | Claude Code's own session token |

The last one makes the tool work with no setup at all, but it is a convenience
rather than a contract: on macOS the live token lives in the Keychain and on
Windows in the Credential Manager, so that file is often absent or stale. Set
`AGENT_RUNWAY_NO_LOCAL_CREDENTIALS=1` to skip it entirely.

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
src/setup.mjs    guided cross-platform first-time setup
src/mcp.mjs      MCP stdio server
skills/          the Claude Code skill
.claude-plugin/  plugin and marketplace manifests
```

## License

MIT
