#!/usr/bin/env node
// Portable test discovery.
//
// `node --test "test/**/*.test.mjs"` only expands the glob from Node 21, so the
// suite could not run on the oldest version package.json claims to support —
// and leaving the expansion to the shell is not a fix either, because npm
// scripts run through cmd.exe on Windows, which does not expand globs at all.
//
// Explicit file paths work on every version, so discovery happens here. No dev
// dependency for it: a directory walk is nine lines.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../test", import.meta.url));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".test.mjs") ? [full] : [];
  });
}

const files = walk(root).sort();

// An empty run must fail. A test command that passes because it found nothing
// is worse than no test command.
if (!files.length) {
  process.stderr.write(`no *.test.mjs found under ${root}\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
