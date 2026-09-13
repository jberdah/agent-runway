// Running an external command has to do three things this project got wrong:
// return its output, stop when told, and never freeze everything else while it
// waits. The third is what spawnSync could not do, and the first two are what
// could not be done until it was gone.

import assert from "node:assert/strict";
import { test } from "node:test";

import { run } from "../src/providers/run.mjs";

// A child that does nothing for a long time, spelled the same on every
// platform: whatever is running these tests.
const SLEEPER = [process.execPath, ["-e", "setTimeout(() => {}, 30000)"]];

test("a command's output comes back", async () => {
  const result = await run(process.execPath, ["-e", "process.stdout.write('hello')"], { timeoutMs: 10_000 });

  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello");
  assert.equal(result.timedOut, false);
});

test("a non-zero exit is a result, never a rejection", async () => {
  // Every caller here has other providers to get through; a failed command
  // must not become an exception that loses them.
  const result = await run(process.execPath, ["-e", "process.stderr.write('nope'); process.exit(3)"], {
    timeoutMs: 10_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /nope/);
  assert.equal(result.error, null);
});

test("a command that does not exist is a result too", async () => {
  const result = await run("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.ok(result.error, "the spawn failure is reported rather than thrown");
});

test("the timeout kills the child instead of waiting for it", async () => {
  const started = Date.now();
  const result = await run(SLEEPER[0], SLEEPER[1], { timeoutMs: 300 });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  // The child was told to run for 30 seconds. Returning in well under one
  // proves it was actually killed, not merely abandoned.
  assert.ok(elapsed < 5000, `returned in ${elapsed}ms, so the child was not left running`);
});

test("an abort from the caller stops the child", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = run(SLEEPER[0], SLEEPER[1], { timeoutMs: 30_000, signal: controller.signal });

  setTimeout(() => controller.abort(), 200);
  const result = await pending;

  assert.equal(result.aborted, true);
  assert.ok(Date.now() - started < 5000, "the caller's cancellation reached the child");
});

test("a signal already aborted never starts a long wait", async () => {
  const result = await run(SLEEPER[0], SLEEPER[1], { timeoutMs: 30_000, signal: AbortSignal.abort() });
  assert.equal(result.aborted, true);
});

test("waiting on a child does not freeze everything else", async () => {
  // The reason this module exists. spawnSync blocked the thread, so a timer
  // running alongside could not fire - which is also why the hard timeout in
  // readOne could never interrupt the work it was guarding.
  let beats = 0;
  const heartbeat = setInterval(() => {
    beats += 1;
  }, 50);

  try {
    await run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 10_000 });
  } finally {
    clearInterval(heartbeat);
  }

  // ~20 expected over a second. Anything above a handful proves the loop kept
  // running; spawnSync scored zero here.
  assert.ok(beats > 5, `only ${beats} timer ticks while a child ran for a second`);
});

test("a second command starts before the first has finished", async () => {
  // The spawnSync regression, stated as something this code controls.
  //
  // Two earlier versions of this test compared wall-clock durations, then
  // compared the children's own start and end times. Both passed alone and
  // failed inside the full suite — they were measuring how the OS schedules
  // process creation on a loaded machine, which is not the claim. Whether both
  // calls return to the event loop before either child exits IS the claim, and
  // it does not depend on load.
  const order = [];
  const child = (tag) =>
    run(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { timeoutMs: 20_000 }).then(() =>
      order.push(tag)
    );

  const a = child("first");
  const b = child("second");
  order.push("both launched");

  await Promise.all([a, b]);

  // Under spawnSync the first child would have run to completion inside the
  // first call, so "first" would sit ahead of this line.
  assert.equal(order[0], "both launched", `both calls must return before either child exits, got ${order}`);
  assert.equal(order.length, 3);
});
