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

### Claude has no durable credential today

This is the project's sharpest limitation, and it was found by trying rather
than by reading docs.

`claude setup-token` mints a long-lived token, and it does **not** work here:

```
HTTP 403 - OAuth token does not meet scope requirement user:profile
```

That command grants inference scopes. The usage endpoint wants `user:profile`,
which it does not issue, so regenerating the token produces the same refusal
every time. There is no flag to ask for a wider scope.

What does carry `user:profile` is the session credential Claude Code keeps for
itself, and that is refreshed only while Claude Code is running. So:

| Situation | Claude usage readable |
| --- | --- |
| Claude Code in active use | yes |
| Claude Code idle for hours, or signed out | no |
| A scheduled job on an otherwise quiet machine | no |

In practice this bites less than it sounds: an agent checking its own runway
mid-task is running inside Claude Code, so the credential is fresh exactly when
it is needed. What it does rule out is the unattended case — waking up at a
reset to see whether the quota came back.

**Codex, Copilot and Antigravity are unaffected.** Each has a durable credential
of its own, which is part of why this tool covers more than one provider.

Refreshing Claude Code's token ourselves is possible in principle and is
deliberately not done: the refresh token rotates on use, so a background tool
racing Claude Code for it could sign the user out of their own editor.

### The one durable path: a session cookie

There are two usage endpoints, and they take different credentials:

| Endpoint | Credential | Verified |
| --- | --- | --- |
| `api.anthropic.com/api/oauth/usage` | Bearer OAuth, needs `user:profile` | 200 with Claude Code's session token, 403 with `setup-token` |
| `claude.ai/api/organizations/{org}/usage` | **cookie only** | 403 to any Bearer: *"This endpoint does not accept OAuth access tokens"* |

So the claude.ai endpoint is not a fallback for the first — it is a different
door. Give it the `sessionKey` cookie from a signed-in claude.ai browser
session and it answers, no OAuth scope involved, and it keeps working while
Claude Code is closed:

```bash
# the value of the sessionKey cookie, pasted by you
echo "sk-ant-sid01-..." > "$HOME/.claude/session-cookie"   # or AGENT_RUNWAY_CLAUDE_COOKIE
```

Weigh it honestly before using it. A session cookie is a **broader credential
than an OAuth token** — it is the browser's full account session, not a scoped
grant. It dies when you sign out, and it cannot be narrowed. This tool will
never read it out of a browser profile: you paste it, or you go without.

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
