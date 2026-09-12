---
name: agent-runway
description: Check the remaining quota on the current Claude subscription - the 5-hour session window, the weekly windows, how much of each is consumed and when they reset. Use when the user asks "how much usage do I have left", "am I close to the limit", "when does my quota reset", "check my usage", "am I rate limited", or before starting a long task or a fan-out of subagents, to confirm there is enough headroom.
---

# Agent runway

Reports the rate-limit windows of the signed-in Claude subscription.

## How to run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs"
```

If the skill was copied manually instead of installed as a plugin,
`${CLAUDE_PLUGIN_ROOT}` is not set. Use the path where the repository was
cloned, or the globally installed binary:

```bash
agent-runway
```

| Flag | Output |
| --- | --- |
| *(none)* | Readable table: one bar per window, percentage, reset time |
| `--short` | One line, e.g. `session=12%  weekly_all=78%  weekly_scoped=52%` |
| `--json` | Raw API response |

Prefer `--short` when the answer feeds a decision rather than the user's eyes,
for example checking headroom before a long task.

## Reading the result

- `session` is the 5-hour window, the one that bites first during a working
  session.
- `weekly_all` covers every model over 7 days.
- `weekly_scoped` is the per-model weekly window; its label names the model.
- A `*` marks the window currently being counted against.
- `warning` and `critical` markers come from the API, not from a local
  threshold.

Report the windows that matter to the question rather than all of them. If the
user asks whether a long task will fit, compare the peak window against the
work ahead and say so plainly.

## Authentication

The tool resolves a token in this order:

1. `CLAUDE_CODE_OAUTH_TOKEN` — from `claude setup-token`, the recommended source
2. `AGENT_RUNWAY_TOKEN`
3. `ANTHROPIC_AUTH_TOKEN`
4. `~/.claude/usage-token` — a file holding the token on one line
5. `~/.claude/.credentials.json` — Claude Code's own session token, frequently
   stale or absent, since the live store is the macOS Keychain or the Windows
   Credential Manager

## Rules

- Never print, log or copy a token, not even a prefix. The tool does not emit
  one; do not work around that with `cat`, `echo` or a grep over credential
  files.
- Never run `claude setup-token` on the user's behalf. It opens a browser and
  prints a year-long account secret: the user runs it themselves.
- Exit code 3 means the token was rejected. Ask the user to regenerate it. Do
  not fall back to any other credential source, such as browser cookies or the
  OS keychain.
- Exit code 4 means the usage endpoint itself is throttling requests, which is
  not the account quota. Wait, and never poll in a loop.

## Caveat

The underlying endpoints are internal and undocumented, so the response shape
can change without notice. The tool degrades rather than breaking: it prefers
the canonical `limits` array, falls back to scanning the top-level windows, and
prints raw JSON if it recognises nothing.
