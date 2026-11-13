import assert from "node:assert/strict";
import { test } from "node:test";

import type { Environment } from "../../../src/config/paths.ts";
import {
  backgroundPreserved,
  backgroundStopper,
  installBackgroundWatchdog,
  parseWindowsBackgroundLaunch,
  PRESERVE_BACKGROUND_PROCESSES_ENV,
} from "../../../src/tools/shell/exec.ts";

function environmentFor(
  platform: Environment["platform"],
  env: Record<string, string | undefined> = {},
): Environment {
  return { env, home: "/tmp/home", platform, cwd: "/tmp/home" };
}

test("the watchdog kills the background process group when the CLI exits", () => {
  const handlers: Array<() => void> = [];
  const signals: Array<[number, string]> = [];
  const stop = installBackgroundWatchdog({
    environment: environmentFor("linux"),
    pid: 4242,
    preserve: false,
    onExit: (handler) => {
      handlers.push(handler);
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  assert.equal(typeof stop, "function");
  assert.equal(handlers.length, 1);
  assert.deepEqual(signals, [], "nothing is signalled before the CLI exits");
  handlers[0]!();
  assert.deepEqual(signals, [[-4242, "SIGKILL"]]);
});

test("a preserved background process installs no watchdog", () => {
  const handlers: Array<() => void> = [];
  const signals: Array<[number, string]> = [];
  const stop = installBackgroundWatchdog({
    environment: environmentFor("linux"),
    pid: 4242,
    preserve: true,
    onExit: (handler) => {
      handlers.push(handler);
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  assert.equal(stop, undefined);
  assert.deepEqual(handlers, []);
  assert.deepEqual(signals, []);
});

test("preserveBackgroundProcesses is the option, else the environment flag", () => {
  const environment = environmentFor("linux");
  assert.equal(
    backgroundPreserved({ preserveBackgroundProcesses: true }, environment),
    true,
  );
  assert.equal(backgroundPreserved({}, environment), false);
  assert.equal(
    backgroundPreserved(
      {},
      environmentFor("linux", { [PRESERVE_BACKGROUND_PROCESSES_ENV]: "1" }),
    ),
    true,
  );
  assert.equal(
    backgroundPreserved(
      {},
      environmentFor("linux", { [PRESERVE_BACKGROUND_PROCESSES_ENV]: "TRUE" }),
    ),
    true,
  );
  assert.equal(
    backgroundPreserved(
      {},
      environmentFor("linux", { [PRESERVE_BACKGROUND_PROCESSES_ENV]: "0" }),
    ),
    false,
  );
  assert.equal(
    backgroundPreserved(
      { preserveBackgroundProcesses: false },
      environmentFor("linux", {
        [PRESERVE_BACKGROUND_PROCESSES_ENV]: "1",
      }),
    ),
    false,
    "an explicit false wins over the environment",
  );
});

test("on Windows the watchdog sweeps the inner process tree", () => {
  const handlers: Array<() => void> = [];
  const swept: number[] = [];
  const signals: Array<[number, string]> = [];
  installBackgroundWatchdog({
    environment: environmentFor("win32"),
    pid: 900,
    preserve: false,
    onExit: (handler) => {
      handlers.push(handler);
    },
    stopTree: (pid) => {
      swept.push(pid);
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  handlers[0]!();
  assert.deepEqual(swept, [900]);
  assert.deepEqual(signals, [], "Windows has no group signal to send");
});

test("a group signal that fails falls back to the leader's own PID", () => {
  const killed: Array<[number, string]> = [];
  const stop = backgroundStopper(77, environmentFor("darwin"), {
    kill: (pid, signal) => {
      if (pid < 0) throw new Error("ESRCH");
      killed.push([pid, signal]);
    },
  });
  assert.equal(stop(), true);
  assert.deepEqual(killed, [[77, "SIGKILL"]]);
});

test("the Windows launch line is parsed, garbage and all", () => {
  const stdout = [
    "$p = Start-Process : a warning the shell printed first",
    "not a pid at all",
    "1234 133760000000000000",
    "",
  ].join("\r\n");
  assert.deepEqual(parseWindowsBackgroundLaunch(stdout, true), {
    pid: 1234,
    startToken: "133760000000000000",
  });
});

test("a truncated Windows launch line is not a launch", () => {
  assert.equal(parseWindowsBackgroundLaunch("1234 133760", true), null);
  assert.deepEqual(parseWindowsBackgroundLaunch("1234 133760", false), {
    pid: 1234,
    startToken: "133760",
  });
});

test("a Windows launch line that is not exactly two numbers is rejected", () => {
  assert.equal(parseWindowsBackgroundLaunch("1234\n", true), null);
  assert.equal(parseWindowsBackgroundLaunch("pid=1234 start=99\n", true), null);
  assert.equal(parseWindowsBackgroundLaunch("1234 99 extra\n", true), null);
  assert.equal(
    parseWindowsBackgroundLaunch("0 133760000000000000\n", true),
    null,
  );
});
