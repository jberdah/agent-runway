#!/usr/bin/env node
// Command line entry point. Also what the Claude Code skill shells out to.

import { fetchUsage, UsageError, VERSION } from "./core.mjs";
import { renderModels, renderProviders, renderShort, renderTable } from "./render.mjs";

const HELP = `agent-runway ${VERSION}

Show how much runway is left before you hit a rate limit, and which models
each installed agent will actually accept.

Usage:
  agent-runway [options]
  agent-runway setup [--env] [--force]

Commands:
  setup        Guided first-time setup: create a token, check it, save it.
               --env    also export AGENT_RUNWAY_TOKEN from your shell profile
               --force  replace a token that already works

Options:
  --all           Every provider found on this machine, not just Claude
  --provider <id> Read one provider only: claude, codex, copilot, antigravity.
                  Use this when asking about yourself rather than the machine.
  --models        What each installed agent will accept as a model, and
                  where two installs of the same agent disagree
  --gate <N>      Decide: is there room to start work, at threshold N percent?
                  Prints JSON. Exit 0 proceed, 10 defer, 11 unknown.
                  Defers unless every provider read is under the threshold.
  --any           With --gate, proceed when any one provider has room. This is
                  the fan-out question, and it is not the same as "can I go on".
  --short         One line, machine friendly: session=79%  weekly_all=76%
  --json          Normalized JSON. Every shape carries tool/version/kind, so a
                  parser can tell which question it is looking at the answer to.
  --raw           The provider's own payload, unwrapped. Not a stable contract.
  --plain         Skip the header, print only the windows
  -h, --help      Show this help
  -v, --version

Providers: claude, codex, copilot, antigravity. Each is read with the
credentials that provider already keeps, and one failing never stops the rest.

Authentication, first match wins:
  CLAUDE_CODE_OAUTH_TOKEN     token from \`claude setup-token\` (recommended)
  AGENT_RUNWAY_TOKEN
  ANTHROPIC_AUTH_TOKEN
  ~/.claude/usage-token       file containing the token on a single line
  ~/.claude/.credentials.json Claude Code's own session token, often stale

  Set AGENT_RUNWAY_NO_LOCAL_CREDENTIALS=1 to never read the last source.

Exit codes:
  0 success   1 error   2 no token   3 auth rejected   4 endpoint rate limited
`;

const EXIT = { NO_TOKEN: 2, AUTH: 3, RATE_LIMITED: 4 };

// A gate is a decision, so it answers in exit codes as well as on stdout, and
// it has three outcomes rather than two: a provider that cannot be read is not
// the same as one with room, and must never be treated as one.
const GATE_EXIT = { proceed: 0, defer: 10, unknown: 11 };

/**
 * Every `--json` answer carries the same three fields.
 *
 * Before this the flag meant three unrelated things depending on which other
 * flag it sat beside — a raw Anthropic payload, a decision, a model catalogue —
 * so nothing could parse it without first knowing what had been asked. `kind`
 * makes that readable from the answer alone. `--raw` stays outside: it exists
 * precisely to be the unwrapped provider payload, and promising it a shape
 * would be promising something we do not control.
 *
 * `toolVersion` rather than `version` because payloads already carry versions
 * of their own that matter more than ours: `resolve` reports the version of the
 * binary it found, and flattening a field called `version` over it would
 * silently replace "Codex 0.149.1" with the version of this tool.
 */
const emit = (kind, payload) =>
  `${JSON.stringify({ tool: "agent-runway", toolVersion: VERSION, kind, ...payload }, null, 2)}\n`;

/** `--name value` or `--name=value`; null when absent. */
function flagValue(argv, name) {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return null;
  return argv[i].split("=")[1] ?? argv[i + 1] ?? null;
}

/** `--gate 90`, `--gate=90`, or `--gate` for the default. */
function gateThreshold(argv) {
  const index = argv.findIndex((a) => a === "--gate" || a.startsWith("--gate="));
  if (index === -1) return null;
  const inline = argv[index].split("=")[1];
  const value = Number(inline ?? argv[index + 1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 90;
}

async function main(argv) {
  const has = (...names) => names.some((n) => argv.includes(n));

  // Loaded on demand: setup pulls in child_process and readline, which the
  // common path (a single GET) has no use for.
  if (argv[0] === "setup") {
    const { setup } = await import("./setup.mjs");
    return setup(argv.slice(1));
  }

  // Everything needed to invoke one agent, in one answer. Meant for a caller
  // that already builds command lines and only lacks the binary and a valid
  // slug — brainclaw resolves the first with a bare `where` and never checks
  // the second.
  if (argv[0] === "resolve") {
    const agent = argv[1];
    const [{ discoverInstalls }, models] = await Promise.all([
      import("./installs.mjs"),
      import("./models.mjs"),
    ]);

    if (!models.SPAWNABLE.includes(agent)) {
      process.stderr.write(`agent-runway: resolve needs one of ${models.SPAWNABLE.join(", ")}\n`);
      return 1;
    }

    const flag = (name) => flagValue(argv, name);

    // Capacity is only consulted when asked: it costs a network round trip,
    // and "which slug" is often the whole question.
    let capacity = null;
    if (has("--with-capacity")) {
      const { readAll, capacity: decide } = await import("./providers/index.mjs");
      const decision = decide(await readAll({ providers: [agent] }), { threshold: 90 });
      capacity = decision.providers[0] ?? null;
    }

    const answer = await models.resolveAgent(agent, {
      installs: discoverInstalls({ withVersions: true }),
      model: flag("--model"),
      capacity,
    });

    process.stdout.write(emit("resolve", answer));
    // An unresolvable agent, or a slug its binary refuses, is a failed
    // precondition rather than a crash: exit 1 so a script can branch.
    return answer.resolved && answer.model?.valid !== false ? 0 : 1;
  }

  // What each install will accept as a model. A separate question from quota,
  // and the one that decides whether a delegation's -m argument is valid.
  if (has("--models")) {
    const [{ discoverInstalls }, models] = await Promise.all([
      import("./installs.mjs"),
      import("./models.mjs"),
    ]);
    const installs = discoverInstalls({ withVersions: true })
      .filter((i) => models.SPAWNABLE.includes(i.agent));
    const catalogues = await models.modelsForAll(installs);

    if (has("--json")) {
      process.stdout.write(emit("models", { catalogues, skew: models.modelSkew(catalogues) }));
      return 0;
    }
    process.stdout.write(`\n${renderModels(catalogues, models.modelSkew(catalogues))}\n`);
    return 0;
  }

  // Multi-provider paths go through the registry, which isolates failures:
  // Antigravity needs its IDE open, a Codex token expires, gh may be absent.
  const threshold = gateThreshold(argv);
  const provider = flagValue(argv, "--provider");
  if (threshold !== null || has("--all") || provider) {
    const { PROVIDER_IDS, readAll, capacity } = await import("./providers/index.mjs");

    if (provider && !PROVIDER_IDS.includes(provider)) {
      process.stderr.write(`agent-runway: --provider takes one of ${PROVIDER_IDS.join(", ")}\n`);
      return 1;
    }

    const results = await readAll(provider ? { providers: [provider] } : {});

    if (threshold === null) {
      process.stdout.write(
        has("--json") ? emit("usage", { providers: results }) : `\n${renderProviders(results)}\n`
      );
      return 0;
    }

    // The permissive reading has to be asked for. An agent checking whether it
    // can keep going should pass --provider and get an answer about itself;
    // without that, one provider over the threshold defers the whole answer.
    const decision = capacity(results, { threshold, rule: has("--any") ? "any" : "all" });
    process.stdout.write(emit("capacity", decision));
    return GATE_EXIT[decision.overall.decision] ?? GATE_EXIT.unknown;
  }

  if (has("-h", "--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (has("-v", "--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const usage = await fetchUsage();

  // The escape hatch, and the only output that promises nothing: whatever the
  // provider sent, unwrapped. Useful when the normalized view has dropped a
  // field that turns out to matter.
  if (has("--raw")) {
    process.stdout.write(`${JSON.stringify(usage.raw, null, 2)}\n`);
    return 0;
  }
  if (has("--json")) {
    // Built through the same helpers the registry uses, so reading one provider
    // and reading four produce the same description of a window.
    const [{ toWindows }, { ok }] = await Promise.all([
      import("./providers/claude.mjs"),
      import("./providers/shared.mjs"),
    ]);
    const result = ok("claude", {
      windows: toWindows(usage),
      detail: usage.extraUsage?.enabled ? "extra usage credits enabled" : null,
    });
    process.stdout.write(emit("usage", { providers: [{ ...result, label: "Claude" }] }));
    return 0;
  }
  if (has("--short")) {
    process.stdout.write(`${renderShort(usage)}\n`);
    return 0;
  }

  const body = renderTable(usage);
  if (has("--plain")) {
    process.stdout.write(`${body}\n`);
  } else {
    process.stdout.write(`\nRunway - Claude\n\n${body}\n`);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`agent-runway: ${error.message}\n`);
      if (error.hint) process.stderr.write(`\n${error.hint}\n`);
      process.exitCode = EXIT[error.code] ?? 1;
      return;
    }
    process.stderr.write(`agent-runway: unexpected error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
