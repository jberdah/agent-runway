---
name: agent-runway
description: Answers two questions about the coding agents installed on this machine - how much rate-limit quota each has left, and which model slugs each installed binary will actually accept. Use when the user asks how much usage or quota is left, whether they are near a limit, when a window resets, or which models are available; and before delegating work to another agent, to pick a binary and a model argument that will not be rejected. Covers Claude, Codex, GitHub Copilot, Gemini CLI and Antigravity.
---

# Agent runway

Two questions, one tool: **is there room to work**, and **what can actually be
run**.

## Commands

All of these are safe, read-only, and print to stdout.

```bash
agent-runway --all            # quota for every provider found
agent-runway --models         # what each install accepts, and where installs disagree
agent-runway --gate 90        # decision + exit code: 0 proceed, 10 defer, 11 unknown
agent-runway resolve codex --model gpt-6-astra   # one answer before spawning
```

Add `--json` to `--models` and `resolve` for machine-readable output. Bare
`agent-runway` reads Claude only and is the fastest path when that is all you
need.

If the command is not on PATH, run it from the checkout: `node src/cli.mjs …`.

## Reading a quota answer

- A `*` marks the window **closest to its limit**, which is not the one being
  consumed right now: a session at 3% in active use goes unmarked while an
  untouched weekly at 87% carries it. Report it as the constraint, never as
  "the window you are using".
- `not included in this plan` means the account has no entitlement to that
  quota. It is not an exhausted quota, and must never be reported as one.
- A provider may come back `unreachable` or `no_credentials`. That is
  information: say the provider could not be read rather than omitting it,
  because silently showing three of four invites a delegation to the missing
  one. Antigravity in particular only answers while its IDE is running.

## Reading a model answer

Every catalogue says how it was obtained, and the difference matters:

| Authority | Meaning |
| --- | --- |
| `declared` | the binary was asked and answered — trust it |
| `inferred` | identifiers were read out of the binary — strong evidence, not a contract |

An `inferred` list can contain plausible-looking rubbish, so when a spawn is
built from one, be ready for it to fail anyway and say so up front.

The same agent usually has several installs — a CLI on PATH, one inside a VS
Code extension, one inside a desktop app — **and they disagree**. A slug the
editor accepts may be unknown to the binary a delegation would spawn. Always
name the install an answer came from.

## Before delegating to another agent

`resolve` is the single call that prevents the common failure:

```bash
agent-runway resolve codex --model gpt-6-astra --json
```

It returns the binary to invoke, its version, the slugs it accepts, and for a
requested model: whether it is valid, which other installs would accept it, and
a suggested substitute. Exit 1 when the agent cannot be resolved or the slug is
refused, so a script can branch on it.

**Offer the substitute, never apply it silently.** Running a different model
than the user asked for, without saying so, is worse than failing.

## Rules

- Never print, log or copy a credential, not even a prefix. The tool never
  emits one; do not work around that with `cat`, `echo` or a grep over
  credential files.
- Never run `claude setup-token`, `codex login` or `gh auth login` on the
  user's behalf. They open a browser and print account secrets; the user runs
  them.
- Do not poll. Readings are cached for 60 seconds and the endpoints rate-limit
  reads; a 429 there is the endpoint throttling, not the account quota.
- Exit 3 means a token was rejected. If the message mentions a scope, the token
  is valid but minted for another purpose and regenerating it will not help.

## Caveat

Quota comes from endpoints that are internal and undocumented, so the shape can
change without notice. Model lists come from each binary, which is more stable
but version-specific. When something looks wrong, `--json` shows exactly what
was read.
