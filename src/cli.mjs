#!/usr/bin/env node
// Command line entry point. Also what the Claude Code skill shells out to.

import { envelope, fetchUsage, UsageError, VERSION } from "./core.mjs";
import { renderModels, renderProviders, renderShort, renderTable } from "./render.mjs";

const HELP = `agent-runway ${VERSION}

Show how much runway is left before you hit a rate limit, and which models
each installed agent will actually accept.

Usage:
  agent-runway [options]
  agent-runway setup [--env] [--force] [--stdin]
  agent-runway doctor [--json]
  agent-runway resolve <agent> [--model <slug>] [--with-capacity] [--json]

Commands:
  setup        Guided first-time setup: find a credential, check it against
               the API, save it. It cannot mint one - no command does, for
               Claude - so it detects what exists and explains the options.
               --env    also export it from your shell profile, as the
                        variable that credential is actually read from
               --force  replace a credential that already works
               --stdin  read the credential from a pipe instead of a prompt,
                        so it is never displayed or pasted
  doctor       Why a provider is not answering: which credential source won,
               which endpoint replied, what each one said, cache ages. Prints
               no secret, so it is safe to paste into an issue.
  resolve <agent>
               Everything needed to start one agent correctly: the command to
               spawn (not just a path - an npm-installed CLI cannot be spawned
               from its path on Windows), the install it came from, its
               version, and the model slugs it accepts.
               --model <slug>    check a slug against it, and say which other
                                 installs would accept it
               --with-capacity   also ask whether that agent has room
               Exit 1 when the agent cannot be resolved or the slug is refused.

Options:
  --all           Every provider found on this machine, not just Claude
  --provider <id> Read one provider only: claude, codex or copilot.
                  Use this when asking about yourself rather than the machine.
  --models        What each installed agent will accept as a model, and
                  where two installs of the same agent disagree
  --gate <N>      Decide: is there room to start work, at threshold N percent?
                  Prints JSON. Exit 0 proceed, 10 defer, 11 unknown.
                  Defers unless every provider read is under the threshold.
  --any           With --gate, proceed when any one provider has room. This is
                  the fan-out question, and it is not the same as "can I go on".
  --short         One line, machine friendly: session=79%  weekly_all=76%
  --json          Normalized JSON. Every answer carries tool, toolVersion,
                  schemaVersion and kind, so a parser can tell what it is
                  holding and whether it can still read it.
  --raw           The provider's own payload, unwrapped. Not a stable contract.
  --plain         Skip the header, print only the windows
  -h, --help      Show this help
  -v, --version

Providers: claude, codex, copilot. Each is read with the credentials that
provider already keeps, and one failing never stops the rest. Every one of them
is also an agent you can invoke - quota is not reported for anything you
cannot delegate to.

Authentication. Two credentials can read Claude usage, and \`claude setup-token\`
mints neither - its token lacks the user:profile scope the endpoint requires.

  A token, for api.anthropic.com (first match wins):
    CLAUDE_CODE_OAUTH_TOKEN     a token carrying user:profile
    AGENT_RUNWAY_TOKEN          the same, scoped to this tool
    ANTHROPIC_AUTH_TOKEN
    ~/.claude/usage-token       a file holding the token on a single line
    ~/.claude/.credentials.json Claude Code's own session token, often stale

  A cookie, for claude.ai (which refuses any Bearer):
    AGENT_RUNWAY_CLAUDE_COOKIE  the claude.ai sessionKey value
    ~/.claude/session-cookie    the durable path: it keeps working while
                                Claude Code is closed. Needs an org id too,
                                which is read from Claude Code's credentials
                                or set with CLAUDE_ORG_ID.

  Either one alone is enough. \`agent-runway doctor\` shows what was found.

  Set AGENT_RUNWAY_NO_LOCAL_CREDENTIALS=1 to never read the last source.

Exit codes:
  0 success, or a gate that says proceed    3 credential rejected
  1 error, or an unusable argument          4 endpoint rate limited (not you)
  2 no credential found                    10 gate: defer
                                           11 gate: unknown
`;

const EXIT = { NO_TOKEN: 2, AUTH: 3, RATE_LIMITED: 4 };

// A gate is a decision, so it answers in exit codes as well as on stdout, and
// it has three outcomes rather than two: a provider that cannot be read is not
// the same as one with room, and must never be treated as one.
const GATE_EXIT = { proceed: 0, defer: 10, unknown: 11 };

/**
 * Every `--json` answer, wrapped by the one envelope both transports share.
 *
 * The flag used to mean three unrelated things depending on which other flag it
 * sat beside — a raw Anthropic payload, a decision, a model catalogue — so
 * nothing could parse it without first knowing what had been asked. `--raw`
 * stays outside it: that flag exists to be the unwrapped provider payload, and
 * promising it a shape would be promising something we do not control.
 */
const emit = (kind, payload) => `${JSON.stringify(envelope(kind, payload), null, 2)}\n`;

/** `--name value` or `--name=value`; null when absent. */
function flagValue(argv, name) {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return null;
  return argv[i].split("=")[1] ?? argv[i + 1] ?? null;
}

const GATE_DEFAULT = 90;

/**
 * `--gate 90`, `--gate=90`, or `--gate` for the default.
 *
 * @returns {null | {value: number} | {invalid: string}} null when absent.
 *
 * A gate that silently falls back to 90 when handed nonsense answers a question
 * nobody asked: `--gate 150` and `--gate foo` are mistakes, and on a command
 * whose whole output is a decision they have to be refused rather than guessed
 * past. A bare `--gate`, or one followed by another flag, still means 90.
 */
function gateThreshold(argv) {
  const index = argv.findIndex((a) => a === "--gate" || a.startsWith("--gate="));
  if (index === -1) return null;

  // A leading dash alone does not mean "a flag follows": `--gate -1` is a value
  // and a bad one, and treating it as an absent value quietly produced 90 —
  // exactly the silent fallback this function exists to stop.
  const looksLikeFlag = (a) => a.startsWith("--") || (a.startsWith("-") && !/^-\d/.test(a));

  const inline = argv[index].split("=")[1];
  const next = argv[index + 1];
  const raw = inline ?? (next !== undefined && !looksLikeFlag(next) ? next : undefined);
  if (raw === undefined || raw === "") return { value: GATE_DEFAULT };

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return { invalid: raw };
  return { value };
}

async function main(argv) {
  const has = (...names) => names.some((n) => argv.includes(n));

  // Loaded on demand: setup pulls in child_process and readline, which the
  // common path (a single GET) has no use for.
  if (argv[0] === "setup") {
    const { setup } = await import("./setup.mjs");
    return setup(argv.slice(1));
  }

  if (argv[0] === "doctor") {
    const { diagnose, renderDoctor } = await import("./doctor.mjs");
    const report = await diagnose();
    process.stdout.write(has("--json") ? emit("doctor", report) : `\n${renderDoctor(report)}\n`);
    // A diagnostic's job is to report, so a broken setup is still a successful
    // run. It fails only when nothing at all could be read, which is the one
    // case where the report itself has nothing to say.
    return report.providers.some((p) => p.status === "ok") ? 0 : 1;
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
  // A Codex token expires, gh may be absent, a network is a network.
  const gate = gateThreshold(argv);
  if (gate?.invalid !== undefined) {
    process.stderr.write(
      `agent-runway: --gate takes a number from 0 to 100, got "${gate.invalid}"\n`
    );
    return 1;
  }
  const threshold = gate ? gate.value : null;

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
