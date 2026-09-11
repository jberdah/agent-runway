#!/usr/bin/env node
// Command line entry point. Also what the Claude Code skill shells out to.

import { fetchUsage, UsageError, VERSION } from "./core.mjs";
import { renderShort, renderTable } from "./render.mjs";

const HELP = `claude-usage ${VERSION}

Show the rate-limit windows of your Claude subscription.

Usage:
  claude-usage [options]

Options:
  --short      One line, machine friendly: session=79%  weekly_all=76%
  --json       Raw API response, unformatted
  --plain      Skip the header, print only the windows
  -h, --help   Show this help
  -v, --version

Authentication, first match wins:
  CLAUDE_CODE_OAUTH_TOKEN     token from \`claude setup-token\` (recommended)
  CLAUDE_USAGE_TOKEN
  ANTHROPIC_AUTH_TOKEN
  ~/.claude/usage-token       file containing the token on a single line
  ~/.claude/.credentials.json Claude Code's own session token, often stale

  Set CLAUDE_USAGE_NO_LOCAL_CREDENTIALS=1 to never read the last source.

Exit codes:
  0 success   1 error   2 no token   3 auth rejected   4 endpoint rate limited
`;

const EXIT = { NO_TOKEN: 2, AUTH: 3, RATE_LIMITED: 4 };

async function main(argv) {
  const has = (...names) => names.some((n) => argv.includes(n));

  if (has("-h", "--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (has("-v", "--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const usage = await fetchUsage();

  if (has("--json")) {
    process.stdout.write(`${JSON.stringify(usage.raw, null, 2)}\n`);
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
    process.stdout.write(`\nClaude usage\n\n${body}\n`);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`claude-usage: ${error.message}\n`);
      if (error.hint) process.stderr.write(`\n${error.hint}\n`);
      process.exitCode = EXIT[error.code] ?? 1;
      return;
    }
    process.stderr.write(`claude-usage: unexpected error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
