import assert from "node:assert/strict";
import { test } from "node:test";

import { runDoctorCommand } from "../../../src/cli/commands/doctor.ts";
import type { DoctorContext } from "../../../src/doctor/types.ts";

function context(): DoctorContext {
  return {
    settings: {},
    paths: { factoryDir: "/tmp/factory" },
    environment: {
      platform: "linux",
      nodeVersion: "24.0.0",
      cwd: "/work",
      home: "/home/u",
      env: {},
    },
    timeoutMs: 1_000,
    withTimeout: async (_label, run) => run(new AbortController().signal),
  };
}

interface Captured {
  readonly out: () => string;
  readonly err: () => string;
  readonly code: () => number;
}

function capture(): Captured & {
  deps: Parameters<typeof runDoctorCommand>[1];
} {
  let out = "";
  let err = "";
  let code = 0;
  const deps = {
    write: (text: string) => (out += text),
    writeError: (text: string) => (err += text),
    setExitCode: (value: number) => (code = value),
    loadContext: async () => context(),
  };
  return { deps, out: () => out, err: () => err, code: () => code };
}

test("an unknown check name reports the documented error and exits 1 without running checks", async () => {
  const captured = capture();

  await runDoctorCommand({ checks: "nope" }, captured.deps);

  assert.equal(captured.out(), "");
  assert.match(captured.err(), /Unknown doctor check/);
  assert.equal(captured.code(), 1);
});

test("--json emits one parseable object and exits 0 when nothing fails", async () => {
  const captured = capture();

  await runDoctorCommand({ json: true, checks: "config" }, captured.deps);

  const parsed: unknown = JSON.parse(captured.out());
  assert.equal(typeof parsed, "object");
  assert.equal(captured.code(), 0);
  assert.equal(captured.err(), "");
});

test("an invalid timeout is refused before any check runs", async () => {
  const captured = capture();

  await runDoctorCommand({ timeout: "0", checks: "config" }, captured.deps);

  assert.equal(captured.out(), "");
  assert.match(captured.err(), /--timeout must be a safe integer/);
  assert.equal(captured.code(), 1);
});

test("text output names the check and its status", async () => {
  const captured = capture();

  await runDoctorCommand({ checks: "config" }, captured.deps);

  assert.match(captured.out(), /^doctor: /);
  assert.match(captured.out(), /config: /);
  assert.equal(captured.code(), 0);
});
