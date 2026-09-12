// Google Antigravity, through the IDE's local language server.
//
// The odd one out, and the reason an adapter must be "produce windows" rather
// than "call a URL": there is no cloud endpoint. The IDE runs
// language_server.exe, which serves a Connect RPC on loopback. Both the port
// and the CSRF token change on every launch, so each read rediscovers them, and
// nothing works at all while the IDE is closed — which is reported as unknown
// rather than as empty.
//
// The header name is x-codeium-csrf-token; the product descends from Codeium.

import { spawnSync } from "node:child_process";

import { fromRemainingFraction, makeWindow, ok, unavailable } from "./shared.mjs";

export const id = "antigravity";
export const label = "Antigravity";

const IS_WINDOWS = process.platform === "win32";
const METHOD = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const PROC = "language_server";

const run = (cmd, args, timeout) =>
  spawnSync(cmd, args, { encoding: "utf-8", timeout, windowsHide: true });

/** The CSRF token is an argument of the running server; read it from the process table. */
function findCsrfToken(timeoutMs) {
  const r = IS_WINDOWS
    ? run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "Name='${PROC}.exe'").CommandLine`], timeoutMs)
    : run("ps", ["-eo", "args="], timeoutMs);

  const line = (r.stdout ?? "").split(/\r?\n/).find((l) => l.includes("--csrf_token")) ?? "";
  return line.match(/--csrf_token[= ]+(\S+)/)?.[1] ?? null;
}

/** The server listens on two loopback ports; only one speaks plain HTTP. */
function findPorts(timeoutMs) {
  if (IS_WINDOWS) {
    const r = run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-Process ${PROC} -ErrorAction SilentlyContinue | ForEach-Object { ` +
      `Get-NetTCPConnection -State Listen -OwningProcess $_.Id -ErrorAction SilentlyContinue } | ` +
      `Select-Object -ExpandProperty LocalPort`], timeoutMs);
    return [...new Set((r.stdout ?? "").split(/\r?\n/).map((l) => Number(l.trim())).filter(Boolean))];
  }
  // POSIX: lsof is the portable-enough option. Untested on macOS and Linux.
  const r = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-c", PROC], timeoutMs);
  return [...new Set(
    [...(r.stdout ?? "").matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => Number(m[1]))
  )];
}

export async function read({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const csrf = findCsrfToken(timeoutMs);
  const ports = findPorts(timeoutMs);

  if (!csrf || !ports.length) {
    // Not "no quota left" — genuinely not knowable right now.
    return unavailable(id, "unreachable", "the Antigravity IDE is not running, so its quota cannot be read");
  }

  let body = null;
  for (const port of ports) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}${METHOD}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrf,
        },
        body: "{}",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue; // the sibling port serves HTTPS and 400s here
      body = await response.json();
      break;
    } catch {
      /* try the next port */
    }
  }

  if (!body) return unavailable(id, "unreachable", "the local language server did not answer");

  const status = body.userStatus ?? {};
  const plan = status.planStatus ?? {};
  const info = plan.planInfo ?? {};
  const windows = [];

  // Per-model weekly quotas. Every model config repeats the same reset time, so
  // collapse them rather than emitting one window per model.
  const quotas = (status.cascadeModelConfigData?.clientModelConfigs ?? [])
    .map((c) => c.quotaInfo)
    .filter((q) => q && Number.isFinite(q.remainingFraction));

  if (quotas.length) {
    const worst = quotas.reduce((a, b) => (a.remainingFraction <= b.remainingFraction ? a : b));
    windows.push(
      makeWindow({
        kind: "model_quota",
        label: "Model quota",
        percentUsed: fromRemainingFraction(worst.remainingFraction),
        resetsAt: worst.resetTime ?? null,
      })
    );
  }

  // Credits are a separate currency from the window above.
  const credits = [
    ["prompt_credits", "Prompt credits", plan.availablePromptCredits, info.monthlyPromptCredits],
    ["flow_credits", "Flow credits", plan.availableFlowCredits, info.monthlyFlowCredits],
  ];
  for (const [kind, label_, available, monthly] of credits) {
    if (!Number.isFinite(available) || !Number.isFinite(monthly) || monthly <= 0) continue;
    windows.push(
      makeWindow({
        kind,
        label: label_,
        percentUsed: Math.max(0, Math.min(100, Math.round(100 - (available / monthly) * 100))),
        remaining: available,
        entitlement: monthly,
        unit: "credits",
      })
    );
  }

  return ok(id, {
    plan: info.planName ?? null,
    windows,
    detail: info.canBuyMoreCredits ? "more credits can be purchased" : null,
  });
}
