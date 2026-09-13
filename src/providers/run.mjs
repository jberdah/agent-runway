// Run an external command without freezing everything else.
//
// Copilot shells out to `gh` for it, and a since-removed provider read the
// process table and the listening sockets the same way.
//
// Both used spawnSync, which was the obvious choice and the wrong one. It blocks
// the thread until the child exits, so the "parallel" read in readAll was not
// parallel: whichever adapter reached its spawnSync first stopped the others,
// and the event loop with them. Measured on a real machine, reading four
// providers took 16.7s and the loop was frozen for 16.4s of it — a 100ms
// heartbeat running alongside fired twice where it should have fired 167 times.
//
// It also made the hard timeout in readOne unreachable in the case it existed
// for. That timeout is a setTimeout, and a timer cannot fire while the thread is
// blocked, so the guard could only ever run after the work it was meant to
// interrupt had already finished.
//
// Hence spawn, plus a kill on timeout or on the caller's abort. Cancelling is
// only possible once nothing is blocking.

import { spawn } from "node:child_process";

/**
 * @returns {Promise<{ok: boolean, status: number|null, stdout: string,
 *   stderr: string, error: Error|null, timedOut: boolean, aborted: boolean}>}
 *
 * Never rejects: a failed command is a result to read, not an exception to
 * catch, and every caller here has to carry on with the other providers.
 */
// A child that ignores SIGTERM would otherwise outlive every deadline above it.
const KILL_GRACE_MS = 400;

// Output is read to decide something small - a version, a JSON payload, a list
// of model slugs. A child that decides to print a gigabyte should be cut off
// rather than held in memory.
const MAX_OUTPUT_BYTES = 8 << 20;

export function run(command, args = [], { timeoutMs = 8000, signal, shell = false, maxBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, status: null, stdout: "", stderr: "", error, timedOut: false, aborted: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let killTimer = null;

    const stop = () => {
      try {
        child.kill();
      } catch {
        return; // already gone
      }
      // SIGTERM asks; it does not compel. A child that ignores it would sit
      // there past every deadline above this one, so escalate after a grace
      // period rather than trusting it to leave.
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone in the meantime */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, truncated });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length >= maxBytes) {
        // Keep what was read and stop the child, rather than growing a string
        // until the process dies of it.
        if (!truncated) {
          truncated = true;
          stop();
        }
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk;
    });

    child.on("error", (error) =>
      finish({ ok: false, status: null, stdout, stderr, error, timedOut, aborted })
    );
    child.on("close", (status) =>
      finish({
        ok: status === 0 && !timedOut && !aborted,
        status,
        stdout,
        stderr,
        error: null,
        timedOut,
        aborted,
      })
    );
  });
}
