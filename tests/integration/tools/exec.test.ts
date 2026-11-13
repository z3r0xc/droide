import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Environment, Platform } from "../../../src/config/paths.ts";
import { OutputLimitError, ToolFailure } from "../../../src/tools/errors.ts";
import { executeCommand, executeTool } from "../../../src/tools/shell/exec.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";

function platform(): Platform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

interface ExecFixture {
  readonly root: string;
  readonly environment: Environment;
  cleanup(): void;
}

function makeExecFixture(): ExecFixture {
  const root = mkdtempSync(join(tmpdir(), "droide-exec-"));
  return {
    root,
    environment: {
      env: { ...process.env },
      home: root,
      platform: platform(),
      cwd: root,
    },
    // Windows keeps a directory handle briefly after a killed child exits;
    // `maxRetries`/`retryDelay` exist exactly for that EPERM/EBUSY window, and
    // a background tree released by the exit hook is the slowest case.
    cleanup: () =>
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 60,
        retryDelay: 100,
      }),
  };
}

function contextFor(fixture: ExecFixture): {
  root: string;
  environment: Environment;
} {
  return { root: fixture.root, environment: fixture.environment };
}

function nodeCommand(root: string, script: string): string {
  const file = join(root, `script-${randomUUID()}.cjs`);
  writeFileSync(file, script);
  return `node "${file}"`;
}

test("a successful command returns its output and exit code 0", async () => {
  const fixture = makeExecFixture();
  try {
    const result = await executeCommand(
      { command: 'node -e "console.log(1 + 1)"', riskLevel: "low" },
      contextFor(fixture),
    );
    assert.equal(result.output.trim(), "2");
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stoppedProcesses, 0);
    assert.equal(result.timedOut, false);
  } finally {
    fixture.cleanup();
  }
});

test("a failing command reports a non-zero exit code", async () => {
  const fixture = makeExecFixture();
  try {
    const result = await executeCommand(
      { command: 'node -e "process.exit(1)"', riskLevel: "low" },
      contextFor(fixture),
    );
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  } finally {
    fixture.cleanup();
  }
});

test("the child receives the non-interactive environment", async () => {
  const fixture = makeExecFixture();
  try {
    const result = await executeCommand(
      {
        command: 'node -e "console.log(process.env.PYTHONUNBUFFERED)"',
        riskLevel: "low",
      },
      contextFor(fixture),
    );
    assert.equal(result.output.trim(), "1");
  } finally {
    fixture.cleanup();
  }
});

test("a missing command is refused before anything runs", async () => {
  const fixture = makeExecFixture();
  try {
    await assert.rejects(
      executeCommand({ command: "", riskLevel: "low" }, contextFor(fixture)),
      (error: unknown) =>
        error instanceof ToolFailure &&
        error.message === "command is required and must be a string",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a missing riskLevel is denied with guidance naming the field", async () => {
  const fixture = makeExecFixture();
  try {
    const registry = new ToolRegistry();
    registry.register(executeTool);
    const outcome = await registry.dispatch(
      "execute-cli",
      { summary: "Check the field", command: 'node -e "process.exit(0)"' },
      contextFor(fixture),
    );
    assert.equal(outcome.ok, false);
    assert.match(
      outcome.ok ? "" : outcome.error,
      /missing required parameter "riskLevel"/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("output over 32 MiB is refused, not truncated", async () => {
  const fixture = makeExecFixture();
  try {
    await assert.rejects(
      executeCommand(
        {
          command: nodeCommand(
            fixture.root,
            "process.stdout.write('x'.repeat(33 * 1024 * 1024));\n",
          ),
          riskLevel: "low",
        },
        contextFor(fixture),
      ),
      (error: unknown) =>
        error instanceof OutputLimitError &&
        error.limit === 32 * 1024 * 1024 &&
        error.bytes > error.limit,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a timeout kills the whole tree, leaving no survivor", async () => {
  const fixture = makeExecFixture();
  try {
    const result = await executeCommand(
      {
        command: nodeCommand(
          fixture.root,
          [
            'const { spawn } = require("node:child_process");',
            'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
            "console.log(`child=${process.pid}`);",
            "console.log(`grandchild=${grandchild.pid}`);",
            "setInterval(() => {}, 1000);",
            "",
          ].join("\n"),
        ),
        riskLevel: "low",
        // Headroom matters more than speed: under a loaded full-suite run,
        // node startup plus the first two writes can exceed three seconds on
        // Windows, which made this test flaky. The helper prints its pids
        // immediately, so a longer timeout does not weaken the assertion.
        timeout: 8,
      },
      contextFor(fixture),
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(result.stoppedProcesses >= 1);
    const pids = [...result.output.matchAll(/(?:child|grandchild)=(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    assert.equal(pids.length, 2, result.output);
    for (const pid of pids) {
      assert.equal(
        await waitForExit(pid),
        true,
        `process ${pid} survived the kill`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function waitFor<T>(
  probe: () => T | undefined,
  attempts = 400,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let remaining = attempts;
    const tick = (): void => {
      const value = probe();
      if (value !== undefined || remaining === 0) {
        resolve(value);
        return;
      }
      remaining -= 1;
      setTimeout(tick, 25);
    };
    tick();
  });
}

function killTreeForTest(pid: number): void {
  if (platform() === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

test("a background command reports its log and dies with the CLI", async (t) => {
  if (platform() !== "win32") {
    const bash = spawnSync("bash", ["-c", "true"], { stdio: "ignore" });
    if (bash.status !== 0) {
      t.skip("no bash on this host; the background launch needs one");
      return;
    }
  }
  const fixture = makeExecFixture();
  const workerFile = join(fixture.root, "background-worker.cjs");
  const workerPidFile = join(fixture.root, "background-worker.pid");
  const runnerFile = join(fixture.root, "background-cli.mjs");
  const resultFile = join(fixture.root, "result.json");
  const releaseFile = join(fixture.root, "release");
  writeFileSync(
    workerFile,
    [
      'const fs = require("node:fs");',
      'console.log("background-started");',
      `fs.writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    runnerFile,
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      `import { executeCommand } from ${JSON.stringify(
        new URL("../../../src/tools/shell/exec.ts", import.meta.url).href,
      )};`,
      "const [command, root, resultFile, releaseFile] = process.argv.slice(2);",
      "const result = await executeCommand(",
      '  { command, riskLevel: "low", fireAndForget: true },',
      "  {",
      "    root,",
      "    environment: { env: process.env, home: root, platform: process.platform, cwd: root },",
      "  },",
      ");",
      "writeFileSync(resultFile, JSON.stringify(result));",
      // Hold the CLI open until the parent has looked at the log and the
      // background process, so the exit hook is what ends that process.
      "const deadline = Date.now() + 20_000;",
      "while (!existsSync(releaseFile) && Date.now() < deadline) {",
      "  await new Promise((resolve) => setTimeout(resolve, 25));",
      "}",
      "",
    ].join("\n"),
  );
  const cli = spawn(
    process.execPath,
    [runnerFile, `node "${workerFile}"`, fixture.root, resultFile, releaseFile],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostics = "";
  cli.stdout.setEncoding("utf8");
  cli.stderr.setEncoding("utf8");
  cli.stdout.on("data", (chunk: string) => {
    diagnostics += chunk;
  });
  cli.stderr.on("data", (chunk: string) => {
    diagnostics += chunk;
  });
  const ended = new Promise<void>((resolve) => {
    cli.once("exit", () => resolve());
  });
  let workerPid: number | undefined;
  try {
    const reported = await waitFor(() =>
      existsSync(resultFile)
        ? JSON.parse(readFileSync(resultFile, "utf8"))
        : undefined,
    );
    assert.ok(
      reported !== undefined,
      `the CLI reported nothing: ${diagnostics}`,
    );
    const result = reported as { pid?: number; outputFile?: string };
    assert.equal(typeof result.outputFile, "string");
    assert.equal(typeof result.pid, "number");
    const logFile = result.outputFile!;
    const reportedPid = result.pid!;
    const log = await waitFor(() => {
      const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      return text.includes("background-started") ? text : undefined;
    });
    assert.match(String(log), /background-started/, "the log stayed empty");
    const pidText = await waitFor(() =>
      existsSync(workerPidFile)
        ? readFileSync(workerPidFile, "utf8")
        : undefined,
    );
    assert.ok(pidText !== undefined, "the background command never started");
    workerPid = Number.parseInt(String(pidText), 10);
    assert.equal(Number.isNaN(workerPid), false);
    assert.doesNotThrow(
      () => process.kill(workerPid!, 0),
      "the background process was not running while the CLI was",
    );
    writeFileSync(releaseFile, "");
    await ended;
    assert.equal(
      await waitForExit(reportedPid),
      true,
      `the reported process ${reportedPid} outlived the CLI`,
    );
    assert.equal(
      await waitForExit(workerPid),
      true,
      `the background process ${workerPid} outlived the CLI`,
    );
  } finally {
    writeFileSync(releaseFile, "");
    if (workerPid !== undefined) killTreeForTest(workerPid);
    cli.stdout.destroy();
    cli.stderr.destroy();
    cli.kill("SIGKILL");
    fixture.cleanup();
  }
});
