# agent-runway

How much runway is left before your coding agent hits a rate limit — which
windows are consumed, and when each one resets.

Same answer three ways: a **CLI**, a **Claude Code skill**, and an **MCP tool**
any client can call, so the reasoning happens once instead of in every model.

> **Unofficial.** This reads undocumented Anthropic endpoints. It can stop
> working without notice and is not a compatibility contract with anyone.

Covers **Claude, Codex, GitHub Copilot, Gemini CLI and Antigravity**, each read
with the credentials that agent already keeps. One provider failing never costs
the others their answer.

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

  * = closest to its limit, as the API flags it
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

`setup` is one guided pass, identical on Windows, macOS and Linux. It reads a
token back without echoing it, **validates it against the API before saving
anything**, then writes it to `~/.claude/usage-token` with mode 0600 and prints
your current usage. `setup --stdin` takes the token from a pipe instead, so it
never has to be displayed or pasted.

Most of the tool needs no credential at all: `--models` and `resolve` read local
binaries. Only quota requires signing in.

Re-running it is safe: it reports that things already work and changes nothing
unless you pass `--force`.

### As a Claude Code plugin (skill + MCP tool)

```
/plugin marketplace add https://github.com/jberdah/agent-runway.git
/plugin install agent-runway@agent-runway
```

The full HTTPS URL rather than the `owner/repo` shorthand: the shorthand
resolves to SSH, which fails on any machine that has not accepted GitHub's host
key. If the clone then fails with *"self signed certificate in certificate
chain"*, a proxy is inspecting TLS; on Windows, `git config --global
http.sslBackend schannel` makes git trust the certificate store the rest of the
system already uses.

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
| `CLAUDE_CODE_OAUTH_TOKEN` | a token carrying `user:profile` — note that `claude setup-token` does not mint one |
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

### When it does not work: `doctor`

Five credential sources, two endpoints that take different credentials, and a
cache that can serve a last-good reading add up to one recurring question — *it
says no token, but I have one*. `doctor` answers it in one pass:

```bash
agent-runway doctor
```

```
Claude credentials
  Token       found - ~/.claude/.credentials.json
              expired at 2026-09-12T18:11:42.397Z
  Cookie      absent (~/.claude/session-cookie)
  Org id      known
  claude.ai   not offered - no cookie
  Answered    no - AUTH
              oauth/usage: HTTP 401 - OAuth access token has expired.

Providers
  claude      unreachable - Token rejected (source: ~/.claude/.credentials.json)
  codex       ok [stale, 3m old] - serving a cached reading: chatgpt.com unreachable
  copilot     ok
```

Two things it deliberately does. It **names sources, never values** — no token,
no cookie, not even a prefix, so the output is safe to paste into an issue, and
a test asserts that against a report built from planted credentials. And it
marks a reading as `[stale]` when the registry served a cached answer after a
live read failed: that fallback is right for a quota question and wrong for a
diagnostic, where it would hide the failure being diagnosed.

Exit 0 once anything could be read, 1 when nothing could.

## Two questions, one tool

Before delegating work, an agent needs both halves of the answer, and getting
them from two different tools defeats the point:

### What is covered, and what is not

Not every agent answers both questions. Antigravity reports a quota and cannot
be spawned; Gemini can be spawned and publishes no usage endpoint. Reading a
missing cell as zero would be worse than reading nothing.

| Agent | Runway | Model list | `resolve` |
| --- | --- | --- | --- |
| Claude | yes — token, or session cookie | inferred, by scanning the binary | yes |
| Codex | yes | declared, from `codex app-server` | yes |
| GitHub Copilot | yes — through `gh` | declared, from shell completion | yes |
| Gemini | **no endpoint** | inferred, by scanning the binary | yes |
| Antigravity | yes — only while its IDE runs | **not covered** | **not spawnable** |

*Declared* means the binary was asked and answered. *Inferred* means slugs were
recovered from the binary itself: indicative, not authoritative — a spawn can
still be refused, and every inferred catalogue is labelled as such in the
output.

**How much runway is left, per provider.**

```bash
agent-runway --all
```

```
Claude              Session (5h)   4 %   |  Weekly - all models  87 %
OpenAI Codex plus   Session        0 %   |  Weekly                0 %
GitHub Copilot      Chat  200/200 requests | Premium: not included in this plan
Antigravity Pro     Flow credits 100 %
```

**Which models each install will actually accept.**

```bash
agent-runway --models
```

```
codex path      0.149.1              4 models  [declared]
    gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5
codex vscode    0.154.0-alpha.6.1    5 models  [declared]
    gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5

Disagreements between installs of the same agent:
  codex path 0.149.1 does not offer: gpt-6-astra
```

That last line is the point. A machine carries several builds of the same agent
— five of Claude here — and they do not agree. `gpt-6-astra` is what this
machine's `config.toml` selects: it runs under the editor extension and does not
exist for the CLI a delegation would spawn.

Each catalogue says how it was obtained. **declared** means the binary was asked
and answered, through `codex app-server`'s `model/list` or the Copilot CLI's own
shell completion. **inferred** means identifiers were read out of the binary,
which Claude Code requires because it exposes no list: strong evidence, not a
contract, and occasionally plausible-looking rubbish.

## Before spawning another agent

One call returns everything needed to build a command that works:

```bash
agent-runway resolve codex --model gpt-6-astra
```

```jsonc
{
  "contract": 1,
  "binary": "…/OpenAI/Codex/bin/codex.exe",
  "version": "0.149.1",
  "models": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  "model": {
    "requested": "gpt-6-astra",
    "valid": false,
    "availableIn": [{ "kind": "vscode", "version": "0.154.0-alpha.6.1", "path": "…" }],
    "suggestion": "gpt-5.6-sol"
  }
}
```

Exit 1 when the agent cannot be resolved or the slug is refused, so a script can
branch. The substitute is **offered, never applied**: running a different model
than was asked for, silently, is worse than failing.

This is meant to compose with tools that already know how to build command
lines. It deliberately does not spawn anything.

## Deciding, rather than reporting

```bash
agent-runway --gate 90
```

Prints JSON and answers in the exit code: **0** proceed, **10** defer, **11**
unknown. Three outcomes rather than two, because a provider that could not be
read has not got room — it is simply unknown, and must never be counted as
either.

### Two questions that are easy to confuse

*Can I keep working?* and *could anything on this machine take this job?* are
not the same question, and answering the second when the first was asked is how
an agent talks itself into a fan-out it has no room for. Claude at 96% beside
Codex at 10% is **not** a green light.

```bash
agent-runway --gate 90 --provider claude   # about one agent: yours
agent-runway --gate 90                     # defers unless every provider has room
agent-runway --gate 90 --any               # the fan-out question, asked by name
```

The answer carries the rule that produced it, so `proceed` can never be read as
more than it claims:

```json
"overall": {
  "decision": "defer",
  "rule": "all",
  "ruleText": "every readable provider is under the threshold",
  "scoped": null,
  "unreadable": ["antigravity"]
}
```

`unreadable` is the rest of that sentence. A provider that could not be read is
neither under the threshold nor over it — a closed Antigravity IDE is not a
verdict on the machine — so it is left out of the rule and **named** instead.
A `proceed` resting on three providers out of four says so.

`--gate` refuses an input it cannot use: `--gate foo`, `--gate 150` and
`--gate -1` exit 1 rather than quietly falling back to 90. On a command whose
entire output is a decision, a guessed threshold answers a question nobody
asked.

The recommendation likewise states its own rule and whether the candidates were
even comparable: 0% of a five-hour window is not 0% of a monthly allowance.

## CLI reference

| Flag | Output |
| --- | --- |
| *(none)* | Claude only, readable table |
| `doctor` | Which credential won, which endpoint replied, what failed |
| `--all` | Every provider found on this machine |
| `--provider <id>` | One provider only — use it when asking about yourself |
| `--models` | What each install accepts, and where installs disagree |
| `resolve <agent>` | Binary, valid slugs and a verdict on one model |
| `--gate <N>` | Decision as JSON plus an exit code |
| `--any` | With `--gate`: proceed if any one provider has room |
| `--short` | One line: `session=15%  weekly_all=79%  weekly_scoped=52%` |
| `--json` | Normalized JSON, always carrying `tool` / `toolVersion` / `kind` |
| `--raw` | The provider's own payload, unwrapped — not a stable contract |
| `--plain` | Table without the header |

Everything printed under `--json` declares which question it answers, so a
parser never has to know what was asked to read the answer:

| `kind` | Produced by |
| --- | --- |
| `usage` | *(none)*, `--all` |
| `capacity` | `--gate` |
| `models` | `--models` |
| `resolve` | `resolve <agent>` |

| Exit code | Meaning |
| --- | --- |
| 0 | success, or a gate that says proceed |
| 1 | unexpected error, or an unusable argument |
| 2 | no token found |
| 3 | token rejected — regenerate it |
| 4 | the usage endpoint is throttling; not your quota |
| 10 | gate: defer |
| 11 | gate: unknown — a provider could not be read |

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
rather than importing the MCP SDK, and `scripts/smoke-mcp.mjs` connects the
official SDK client to it so the hand-rolled framing is checked against the real
implementation.

That choice was originally justified by a belief that a Claude Code plugin
installed from git is never `npm install`ed. **That is wrong**: installing this
plugin produced 91 packages in the plugin cache, devDependencies included. The
constraint is kept anyway, for reasons that survive the correction — nobody
installing a CLI that makes one HTTP request should wait on 91 packages, the
supply-chain surface stays at zero, and it keeps working where `npm install`
does not, which on a corporate network is not hypothetical.

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
