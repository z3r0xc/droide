import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECK_NAMES,
  UnknownCheckError,
  parseChecks,
  parseTimeout,
} from "../../../src/doctor/registry.ts";
import { renderJson, renderText, runDoctor } from "../../../src/doctor/run.ts";
import type {
  CheckResult,
  DoctorCheck,
  DoctorContext,
} from "../../../src/doctor/types.ts";

function context(): DoctorContext {
  return {
    settings: {},
    paths: { stateDir: "/tmp/factory" },
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

function check(
  name: string,
  result: CheckResult | (() => Promise<CheckResult>),
): DoctorCheck {
  return {
    name,
    title: name,
    async run() {
      return typeof result === "function" ? result() : result;
    },
  };
}

test("the default selection excludes exactly the four expensive checks", () => {
  const selected = parseChecks(undefined);
  assert.deepEqual(
    [...selected],
    CHECK_NAMES.filter(
      (name) => !["custom-models", "inference", "mcp", "exec"].includes(name),
    ),
  );
  assert.equal(selected.includes("updates"), true);
  assert.equal(selected.includes("proxy"), true);
});

test("all selects every check, in catalogue order", () => {
  assert.deepEqual([...parseChecks("all")], [...CHECK_NAMES]);
});

test("an explicit list is validated, deduplicated and ordered", () => {
  assert.deepEqual([...parseChecks("git,config,git")], ["config", "git"]);
  assert.deepEqual([...parseChecks("mcp exec")], ["mcp", "exec"]);
});

test("an unknown check name is refused with the documented message", () => {
  assert.throws(
    () => parseChecks("nope"),
    (error: unknown) => {
      assert.equal(error instanceof UnknownCheckError, true);
      assert.match(
        error instanceof Error ? error.message : "",
        /`nope` is invalid\. Unknown doctor check\./,
      );
      return true;
    },
  );
});

test("timeouts are bounded to a safe integer range", () => {
  assert.equal(parseTimeout(undefined), 10_000);
  assert.equal(parseTimeout("1"), 1);
  assert.equal(parseTimeout("2147483647"), 2_147_483_647);
  assert.throws(() => parseTimeout("0"), RangeError);
  assert.throws(() => parseTimeout("-5"), RangeError);
  assert.throws(() => parseTimeout("abc"), RangeError);
  assert.throws(() => parseTimeout("1.5"), RangeError);
});

test("the report fails when any check fails, warns on skip, and stays ok otherwise", async () => {
  const catalogue = [
    check("a", { status: "ok", summary: "fine" }),
    check("b", { status: "skip", summary: "not here" }),
  ];
  const warned = await runDoctor({
    checks: ["a", "b"],
    context: context(),
    catalogue,
  });
  assert.equal(warned.status, "warn");

  const failed = await runDoctor({
    checks: ["a", "b"],
    context: context(),
    catalogue: [
      check("a", { status: "ok", summary: "fine" }),
      check("b", { status: "fail", summary: "broken" }),
    ],
  });
  assert.equal(failed.status, "fail");
});

test("a check that throws becomes a failure with its message, not a crash", async () => {
  const report = await runDoctor({
    checks: ["boom"],
    context: context(),
    catalogue: [
      check("boom", async () => {
        throw new Error("kaboom");
      }),
    ],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.checks[0]?.result.summary, "kaboom");
});

test("checks run in catalogue order and record durations", async () => {
  const order: string[] = [];
  const catalogue: DoctorCheck[] = ["one", "two"].map((name) => ({
    name,
    title: name,
    async run() {
      order.push(name);
      return { status: "ok", summary: name };
    },
  }));

  const report = await runDoctor({
    checks: ["two", "one"],
    context: context(),
    catalogue,
  });

  assert.deepEqual(order, ["one", "two"]);
  assert.equal(report.checks.length, 2);
  assert.equal(typeof report.checks[0]?.result.durationMs, "number");
});

test("the JSON renderer emits a stable shape", async () => {
  const report = await runDoctor({
    checks: ["a"],
    context: context(),
    catalogue: [
      check("a", { status: "ok", summary: "fine", metadata: { k: 1 } }),
    ],
  });

  const parsed: unknown = JSON.parse(renderJson(report));
  assert.equal(typeof parsed, "object");
  assert.equal(JSON.stringify(parsed).includes('"checks"'), true);
  assert.equal(JSON.stringify(parsed).includes('"status":"ok"'), true);
});

test("the text renderer hides details unless verbose", async () => {
  const report = await runDoctor({
    checks: ["a"],
    context: context(),
    catalogue: [
      check("a", {
        status: "warn",
        summary: "hmm",
        details: ["detail"],
        fixes: ["do it"],
      }),
    ],
  });

  const quiet = renderText(report, { verbose: false });
  assert.match(quiet, /^doctor: warn/m);
  assert.equal(quiet.includes("detail"), false);

  const verbose = renderText(report, { verbose: true });
  assert.equal(verbose.includes("detail"), true);
  assert.equal(verbose.includes("fix: do it"), true);
});
