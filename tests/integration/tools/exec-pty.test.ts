/**
 * `Execute` under a pseudo-terminal, end to end. Contract:
 * `specs/30-tools-and-sandbox.md` B26-B30 (the decision, the transport report,
 * the blocklist, timeout/kill) and `specs/90-native-layer.md` B13-B22 (the
 * session environment and lifecycle rules the daemon terminal pins).
 *
 * The PTY cases need the compiled Rust helper; they skip with the reason when
 * it is not built, so `npm test` stays hermetic on a checkout without Cargo
 * output. The pipe and fallback cases need nothing.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  nativeHelperFile,
  type Environment,
  type Platform,
} from "../../../src/config/paths.ts";
import { executeCommand } from "../../../src/tools/shell/exec.ts";
import {
  createNativePtyBackend,
  withoutBlockedVariables,
  type PtyBackend,
} from "../../../src/tools/shell/pty.ts";

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

const PLATFORM = platform();

/** The installed helper, or the one `DROIDE_NATIVE_BIN` names. */
function realHelper(): string | undefined {
  const environment: Environment = {
    env: process.env,
    home: homedir(),
    platform: PLATFORM,
    cwd: process.cwd(),
  };
  const override = process.env["DROIDE_NATIVE_BIN"]?.trim();
  const candidate =
    override === undefined || override === ""
      ? nativeHelperFile(environment)
      : override;
  return existsSync(candidate) ? candidate : undefined;
}

const HELPER = realHelper();
const NO_HELPER =
  HELPER === undefined
    ? "native helper not built: run `cargo build -p droide-native` (or " +
      "`npm run native:build`) and point DROIDE_NATIVE_BIN at the binary"
    : false;

interface ExecFixture {
  readonly root: string;
  readonly environment: Environment;
  cleanup(): void;
}

function makeFixture(): ExecFixture {
  const root = mkdtempSync(join(tmpdir(), "droide-exec-pty-"));
  const helper = realHelper();
  return {
    root,
    environment: {
      env: {
        ...process.env,
        ...(helper === undefined ? {} : { DROIDE_NATIVE_BIN: helper }),
      },
      home: root,
      platform: PLATFORM,
      cwd: root,
    },
    cleanup: () =>
      rmSync(root, { recursive: true, force: true, maxRetries: 20 }),
  };
}

/** The literal call the clause's acceptance test runs. */
const IS_TTY = "node -e \"process.stdout.isTTY && console.log('tty')\"";

test(
  "a granted PTY gives the command a terminal",
  { skip: NO_HELPER },
  async () => {
    const fixture = makeFixture();
    try {
      const result = await executeCommand(
        {
          command: IS_TTY,
          pty: true,
          riskLevel: "low",
        },
        { root: fixture.root, environment: fixture.environment },
      );
      assert.equal(result.transport, "pty");
      // ConPTY prefixes its setup/teardown escapes; the marker is what matters.
      assert.match(result.output, /tty/);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
    } finally {
      fixture.cleanup();
    }
  },
);

test("the pipe child never sees a terminal", async () => {
  const fixture = makeFixture();
  try {
    const result = await executeCommand(
      {
        command: IS_TTY,
        riskLevel: "low",
      },
      { root: fixture.root, environment: fixture.environment },
    );
    assert.equal(result.transport, undefined);
    assert.doesNotMatch(result.output, /^tty\r?$/m);
    assert.equal(result.exitCode, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a refused PTY falls back to the pipe child and says why", async () => {
  const fixture = makeFixture();
  try {
    const backend: PtyBackend = {
      spawn: async () => {
        throw new Error("pty sessions are not implemented for this platform");
      },
      close: async () => undefined,
    };
    const result = await executeCommand(
      {
        command: IS_TTY,
        pty: true,
        riskLevel: "low",
      },
      { root: fixture.root, environment: fixture.environment },
      { pty: backend },
    );
    assert.equal(result.transport, "pipe");
    assert.match(
      result.ptyFallbackReason ?? "",
      /not implemented for this platform/,
    );
    assert.doesNotMatch(result.output, /^tty\r?$/m);
    assert.equal(result.exitCode, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a missing helper names the path it looked for", async () => {
  const fixture = makeFixture();
  try {
    const environment: Environment = {
      ...fixture.environment,
      env: {
        ...process.env,
        DROIDE_NATIVE_BIN: join(fixture.root, "not-built"),
      },
    };
    const result = await executeCommand(
      {
        command: IS_TTY,
        pty: true,
        riskLevel: "low",
      },
      { root: fixture.root, environment },
    );
    assert.equal(result.transport, "pipe");
    assert.match(
      result.ptyFallbackReason ?? "",
      /not installed at .*not-built/,
    );
    assert.doesNotMatch(result.output, /^tty\r?$/m);
  } finally {
    fixture.cleanup();
  }
});

test(
  "an interactive session echoes stdin and runs the command it is given",
  { skip: NO_HELPER },
  async (t) => {
    const fixture = makeFixture();
    const backend = createNativePtyBackend({
      helperPath: HELPER!,
      env: withoutBlockedVariables({ ...process.env }),
    });
    t.after(async () => {
      await backend.close();
      fixture.cleanup();
    });

    const windows = PLATFORM === "win32";
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const session = await backend.spawn({
      program: windows ? join(systemRoot, "System32", "cmd.exe") : "/bin/sh",
      args: [],
      cwd: fixture.root,
      env: { TERM: "xterm-256color", PATH: process.env["PATH"] ?? "" },
      cols: 80,
      rows: 24,
    });
    // The terminal echoes the line (proving echo is on) and the shell prints
    // the result, which does not contain the expression text.
    await session.write(
      Buffer.from(windows ? "set /a 6*7\r\n" : "echo $((6*7))\n"),
    );

    let text = "";
    let exited = false;
    for (let attempt = 0; attempt < 50 && !/42/.test(text); attempt += 1) {
      const chunk = await session.read(200);
      text += chunk.data.toString("utf8");
      exited = chunk.exited;
      if (exited) break;
    }
    await session.stop();

    assert.match(text, windows ? /set \/a 6\*7/ : /echo \$\(\(6\*7\)\)/);
    assert.match(text, /42/);
  },
);
