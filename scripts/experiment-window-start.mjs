#!/usr/bin/env node
// EXPERIMENT — does calling GET /usage start a new 5h session window?
//
// The question this settles: after a session window expires, does a bare read
// of the usage endpoint open the next window, or does only a real inference
// message open it?
//
//   resets_at moves after the probes  -> reading is destructive, polling is harmful
//   resets_at stays put               -> reading is free, a watch mode is viable
//
// Protocol: take a baseline while the current window is still open, then probe
// only AFTER it expires. The validity of the result depends entirely on there
// being NO inference anywhere on the account between expiry and the last probe
// — not in Claude Code, not on the web, not on mobile. The probes themselves
// are plain HTTP GETs from this process, not agent turns, which is the whole
// point: the measurement must not be made by the thing it measures.
//
// Timing tolerates machine sleep: targets are checked against the wall clock
// rather than slept through, so an overdue probe fires late rather than never.
// A late probe still answers the question; only the resolution suffers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveToken, resolveOrgId } from "../src/core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(here, "..", "experiment-window-start.log.jsonl");

// Minutes after window expiry at which to probe.
const OFFSETS = [10, 25, 45, 90];
const TICK_MS = 30_000;

const iso = (d = new Date()) => d.toISOString();
const hhmm = (d) => iso(d).slice(11, 16) + "Z";

function record(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ at: iso(), ...entry }) + "\n", "utf8");
}

function emit(line) {
  process.stdout.write(line + "\n");
}

const resolved = resolveToken();
if (!resolved) {
  emit("ABORT: no token available, experiment cannot run");
  record({ event: "abort", reason: "no_token" });
  process.exitCode = 1;
}

const orgId = resolveOrgId();

async function probe(label) {
  let status = null;
  let body = null;
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "agent-runway-experiment/0.1",
      },
    });
    status = response.status;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (error) {
    record({ event: "probe_error", label, error: String(error?.message ?? error) });
    return { label, status: null, error: String(error?.message ?? error) };
  }

  // Full payload to disk; only a summary to stdout.
  record({ event: "probe", label, status, body });

  const session = body?.limits?.find?.((l) => l.kind === "session") ?? null;
  return {
    label,
    status,
    resetsAt: body?.five_hour?.resets_at ?? null,
    sessionPercent: session ? session.percent : null,
    fiveHourNull: body?.five_hour === null,
  };
}

// resets_at carries sub-second server jitter; compare to the second.
const sameInstant = (a, b) => {
  if (a == null || b == null) return a === b;
  return Math.abs(Date.parse(a) - Date.parse(b)) < 1000;
};

async function main() {
  record({ event: "start", org: Boolean(orgId), tokenSource: resolved.source, offsets: OFFSETS });

  const baseline = await probe("baseline");
  if (!baseline.resetsAt) {
    emit(`ABORT: no active session window at baseline (status ${baseline.status}) — rerun while a window is open`);
    record({ event: "abort", reason: "no_baseline_window", baseline });
    return;
  }

  const expiry = new Date(baseline.resetsAt);
  emit(
    `[baseline ${hhmm(new Date())}] session=${baseline.sessionPercent}% resets=${baseline.resetsAt}`
  );
  emit(
    `Window expires ${hhmm(expiry)}. ${OFFSETS.length} probes will follow. ` +
      `From expiry until the last probe, do not use Claude anywhere.`
  );

  const targets = OFFSETS.map((minutes) => ({
    minutes,
    at: new Date(expiry.getTime() + minutes * 60_000),
    done: false,
  }));

  while (targets.some((t) => !t.done)) {
    const now = Date.now();
    const due = targets.filter((t) => !t.done && now >= t.at.getTime());

    for (const target of due) {
      target.done = true;
      const result = await probe(`t+${target.minutes}m`);
      const lateBy = Math.round((Date.now() - target.at.getTime()) / 60_000);

      if (result.status !== 200) {
        emit(`[t+${target.minutes}m ${hhmm(new Date())}] HTTP ${result.status} — see log`);
        continue;
      }

      const moved = !sameInstant(result.resetsAt, baseline.resetsAt);
      const verdict = result.resetsAt == null
        ? "resets_at=null (no window reported)"
        : moved
          ? `resets_at MOVED to ${result.resetsAt}  <-- reading appears to start the window`
          : "resets_at unchanged  <-- reading did NOT start a window";

      emit(
        `[t+${target.minutes}m ${hhmm(new Date())}${lateBy > 2 ? ` late ${lateBy}m` : ""}] ` +
          `session=${result.sessionPercent}% ${verdict}`
      );
    }

    if (targets.some((t) => !t.done)) {
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  }

  record({ event: "done" });
  emit(`[done ${hhmm(new Date())}] full payloads in experiment-window-start.log.jsonl`);
}

main().catch((error) => {
  record({ event: "fatal", error: String(error?.stack ?? error) });
  emit(`FATAL: ${error?.message ?? error}`);
  process.exitCode = 1;
});
