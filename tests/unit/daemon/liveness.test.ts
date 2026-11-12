/**
 * Parent-death monitors. Clause: `specs/70` B10 (`--parent-pid` polls at
 * 2000 ms; `--liveness-fd` reports once when the inherited pipe ends).
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  PARENT_PID_POLL_INTERVAL_MS,
  isProcessAlive,
  watchParentPid,
  watchStreamClose,
} from "../../../src/daemon/liveness.ts";
import { ManualTimers } from "./helpers.ts";

test("the poll interval is the documented 2000 ms", () => {
  assert.equal(PARENT_PID_POLL_INTERVAL_MS, 2_000);
});

test("the parent is polled only after the interval, and shutdown fires once", () => {
  const timers = new ManualTimers();
  const polls: number[] = [];
  const deaths: string[] = [];
  const watcher = watchParentPid({
    pid: 4242,
    timers,
    isAlive: (pid) => {
      polls.push(pid);
      return polls.length < 2;
    },
    onDead: () => deaths.push("dead"),
  });
  timers.advance(1_999);
  assert.deepEqual(polls, []);
  timers.advance(1);
  assert.deepEqual(polls, [4242]);
  assert.deepEqual(deaths, []);
  timers.advance(2_000);
  assert.deepEqual(polls, [4242, 4242]);
  assert.deepEqual(deaths, ["dead"]);
  assert.equal(timers.activeCount, 0);
  timers.advance(10_000);
  assert.deepEqual(deaths, ["dead"]);
  watcher.stop();
});

test("stop cancels the pending poll", () => {
  const timers = new ManualTimers();
  const polls: number[] = [];
  const watcher = watchParentPid({
    pid: 1,
    timers,
    isAlive: () => {
      polls.push(1);
      return true;
    },
    onDead: () => polls.push(-1),
  });
  watcher.stop();
  assert.equal(timers.activeCount, 0);
  timers.advance(10_000);
  assert.deepEqual(polls, []);
});

test("an injected interval replaces the default", () => {
  const timers = new ManualTimers();
  let polls = 0;
  watchParentPid({
    pid: 1,
    intervalMs: 25,
    timers,
    isAlive: () => {
      polls += 1;
      return true;
    },
    onDead: () => {},
  });
  timers.advance(24);
  assert.equal(polls, 0);
  timers.advance(1);
  assert.equal(polls, 1);
});

test("the real liveness probe reports this process as alive", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("a pipe that ends reports once, and only once", async () => {
  const pipe = new PassThrough();
  const reports: string[] = [];
  const reported = Promise.withResolvers<void>();
  watchStreamClose(pipe, () => {
    reports.push("closed");
    reported.resolve();
  });
  pipe.resume();
  pipe.end("last breath");
  await reported.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, ["closed"]);
});

test("stopping a stream watcher suppresses the report", () => {
  const pipe = new PassThrough();
  const reports: string[] = [];
  const watcher = watchStreamClose(pipe, () => reports.push("closed"));
  watcher.stop();
  pipe.destroy();
  assert.deepEqual(reports, []);
});
