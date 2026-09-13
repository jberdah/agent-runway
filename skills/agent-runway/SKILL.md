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
agent-runway --all                       # quota for every provider found
agent-runway --models                    # what each install accepts, and where they disagree
agent-runway --gate 90 --provider claude # can I keep working? 0 proceed, 10 defer, 11 unknown
agent-runway --gate 90 --any             # could any agent here take this job?
agent-runway resolve codex --model gpt-6-astra   # one answer before spawning
agent-runway doctor                      # why a provider is not answering
```

When a provider comes back `no_credentials` or `unreachable` and the user wants
to know why, use `doctor` — the `diagnose_setup` tool over MCP, the `doctor`
command otherwise — rather than guessing. It names which credential source won,
whether it has expired, which endpoint replied and what it said. It prints no
secret, so its output can be quoted in full.

**Once per failure, not as a health check.** It reads every provider live, and
repeated calls earn a 429 from the usage endpoint — which reads like an
exhausted account quota and is not one.

`--json` works on every command and always returns the same contract, tagged
with `kind` (`usage`, `capacity`, `models`, `resolve`). `--raw` returns the
provider's own payload and promises nothing. Bare `agent-runway` reads Claude
only and is the fastest path when that is all you need.

If the command is not on PATH, run it from the checkout: `node src/cli.mjs …`.

## Asking the gate the right question

**`--gate` without `--provider` is not about you.** It reads every provider on
the machine, and by default defers unless all of them have room. Two failure
modes to avoid:

- Asking the bare question and reading `proceed` as *your* runway. Pass
  `--provider claude` (or whichever agent you are running as) when the question
  is whether to continue this session.
- Asking `--any` and reading it as permission to work here. `--any` answers
  *some agent on this machine has room* — which is about delegation, not about
  you.

The answer carries `overall.ruleText`. Quote it rather than paraphrasing
`proceed`.

## Coverage is uneven, and the gaps matter

| Agent | Runway | Models | Spawnable |
| --- | --- | --- | --- |
| Claude, Codex, GitHub Copilot | yes | yes | yes |
| Gemini | **no endpoint exists** | yes | yes |
| Antigravity | only while its IDE runs | **no** | **no** |

Never report a missing cell as zero, and never suggest delegating to
Antigravity. If asked about Gemini's quota, say there is no endpoint to read
rather than implying it is at zero or unknown-but-checkable.

## Reading a quota answer

- A `*` marks the window **closest to its limit**, which is not the one being
  consumed right now: a session at 3% in active use goes unmarked while an
  untouched weekly at 87% carries it. Report it as the constraint, never as
  "the window you are using".
- **The binding window is not a task budget.** It answers "which bar is nearest
  the wall", not "does this piece of work fit". A session at 15% beside a weekly
  at 89% binds on the weekly — yet a fan-out burns the session first. Read
  `windows[]`, which every answer carries, and say which window the work will
  actually consume.
- A `proceed` can rest on fewer providers than you think. `overall.unreadable`
  names the ones that could not be read at all; mention them rather than
  presenting the answer as covering everything installed.
- **A decision marked `stale: true` rests on a cached reading**, because the
  provider could not be reached just now. A stale answer is never `proceed`: it
  can only be `defer` (consumption only rises inside a window, so an old high
  reading still proves the limit) or `unknown`. When you report one, say how old
  it is — `staleMs` — rather than presenting it as current.
- **`recommended: null` is an answer, not a gap.** It means the providers with
  room run on different cadences and cannot be ranked against each other. Read
  `candidates` — one per cadence — and pick by which window the work will
  actually consume, saying which you chose and why.
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

## When the answer is defer

The tool stops at `retryAt` and `retryAtBasis`. It does not wake anything up,
and it cannot save a conversation — a session that runs out of quota loses its
context whatever this reports.

So before proposing to wait for a reset, **write the state down**: what was
done, what is left, the files and paths involved, in a file the user can hand
to a fresh session. Offer the reset time as information the user acts on, not
as a schedule the agent will keep.

`retryAtBasis: "window_reset"` means the window rolls over then. It is not a
promise that service resumes at that moment; say so when quoting it.

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
