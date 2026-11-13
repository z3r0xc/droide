/**
 * `Execute`'s PTY decision and its seam. Contract:
 * `specs/30-tools-and-sandbox.md` B26 (the one condition), B27 (the transport
 * report and the fallback reason), B29 (the spec 90 B15 blocklist) and B30
 * (timeout/kill).
 *
 * Nothing here needs the native helper: the backend is the seam, so every
 * branch is proven with a fake session and an injected clock.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Environment } from "../../../src/config/paths.ts";
import { executeCommand, usesPty } from "../../../src/tools/shell/exec.ts";
import type {
  PtyBackend,
  PtyChunk,
  PtySession,
  PtySpawnRequest,
} from "../../../src/tools/shell/pty.ts";
import {
  makeExecEnvironment,
  makeToolFixture,
  type ToolFixture,
} from "./helpers.ts";

function nodeCommand(root: string, script: string): string {
  const file = join(root, `script-${randomUUID()}.cjs`);
  writeFileSync(file, script);
  return `node "${file}"`;
}

const IS_TTY = "process.stdout.isTTY && console.log('tty');";

/** A session that answers scripted chunks and records its lifecycle. */
function fakeSession(
  chunks: readonly PtyChunk[],
  records: { stopped: number; terminated: number },
): PtySession {
  let index = 0;
  return {
    read: async () => {
      const chunk = chunks[Math.min(index, chunks.length - 1)]!;
      index += 1;
      return chunk;
    },
    write: async () => undefined,
    stop: async () => {
      records.stopped += 1;
      return chunks[chunks.length - 1]?.exitCode ?? null;
    },
    terminate: () => {
      records.terminated += 1;
    },
  };
}

function fakeBackend(
  spawn: (request: PtySpawnRequest) => Promise<PtySession>,
): PtyBackend & { requests: PtySpawnRequest[]; closed: number } {
  const requests: PtySpawnRequest[] = [];
  const backend = {
    requests,
    closed: 0,
    spawn: async (request: PtySpawnRequest) => {
      requests.push(request);
      return await spawn(request);
    },
    close: async () => {
      backend.closed += 1;
    },
  };
  return backend;
}

function execEnvironment(fixture: ToolFixture): Environment {
  return makeExecEnvironment(fixture);
}

test("the decision grants a PTY only for pty:true on a foreground call", () => {
  assert.equal(usesPty({ pty: true }), true);
  assert.equal(usesPty({ pty: true, fireAndForget: false }), true);
  assert.equal(usesPty({ pty: false }), false);
  assert.equal(usesPty({}), false);
  assert.equal(usesPty({ fireAndForget: true }), false);
  assert.equal(usesPty({ pty: true, fireAndForget: true }), false);
});

test("a granted PTY returns the session's output and exit code", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    const records = { stopped: 0, terminated: 0 };
    const backend = fakeBackend(async () =>
      fakeSession(
        [{ data: Buffer.from("pty-out\n"), exited: true, exitCode: 7 }],
        records,
      ),
    );
    const result = await executeCommand(
      { command: "ignored", pty: true, riskLevel: "low" },
      { root: fixture.root, environment: execEnvironment(fixture) },
      { pty: backend },
    );
    assert.equal(result.transport, "pty");
    assert.equal(result.ptyFallbackReason, undefined);
    assert.equal(result.output, "pty-out\n");
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0]?.cwd, fixture.root);
    assert.equal(backend.closed, 1, "the helper is released");
    assert.equal(records.stopped, 1, "the session is released");
  } finally {
    fixture.cleanup();
  }
});

test("a backend that refuses a PTY falls back to the pipe child, with the reason", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    const backend = fakeBackend(async () => {
      throw new Error("pty sessions are not implemented for plan9");
    });
    const result = await executeCommand(
      {
        command: nodeCommand(fixture.root, IS_TTY),
        pty: true,
        riskLevel: "low",
      },
      { root: fixture.root, environment: execEnvironment(fixture) },
      { pty: backend },
    );
    assert.equal(result.transport, "pipe");
    assert.match(result.ptyFallbackReason ?? "", /not implemented for plan9/);
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.output, /^tty$/m);
    assert.equal(backend.closed, 1);
  } finally {
    fixture.cleanup();
  }
});

test("an uninstalled helper falls back without spawning anything", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    const environment: Environment = {
      ...execEnvironment(fixture),
      env: { ...process.env, DROIDE_NATIVE_BIN: "" },
    };
    const result = await executeCommand(
      {
        command: nodeCommand(fixture.root, IS_TTY),
        pty: true,
        riskLevel: "low",
      },
      { root: fixture.root, environment },
    );
    assert.equal(result.transport, "pipe");
    assert.match(result.ptyFallbackReason ?? "", /not installed at/);
    assert.doesNotMatch(result.output, /^tty$/m);
  } finally {
    fixture.cleanup();
  }
});

test("a background launch reports why its PTY request was not granted", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    const result = await executeCommand(
      { command: "exit 0", pty: true, riskLevel: "low", fireAndForget: true },
      { root: fixture.root, environment: execEnvironment(fixture) },
      { tmpDir: fixture.dir },
    );
    assert.equal(result.transport, "pipe");
    assert.match(result.ptyFallbackReason ?? "", /background launch/);
    assert.equal(typeof result.pid, "number");
  } finally {
    // Windows holds the background log briefly after the wrapper exits.
    rmSync(fixture.dir, {
      recursive: true,
      force: true,
      maxRetries: 60,
      retryDelay: 100,
    });
  }
});

test("the session environment carries the blocklist out of both layers", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    const environment: Environment = {
      ...fixture.environment,
      env: {
        ...process.env,
        LD_PRELOAD: "/tmp/evil.so",
        LD_LIBRARY_PATH: "/tmp/evil",
        HOME: "/tmp/elsewhere",
        SHELL: "/bin/zsh",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        PATH: process.env["PATH"] ?? "/usr/bin",
      },
    };
    const backend = fakeBackend(async () => {
      const records = { stopped: 0, terminated: 0 };
      return fakeSession(
        [{ data: Buffer.alloc(0), exited: true, exitCode: 0 }],
        records,
      );
    });
    await executeCommand(
      { command: "ignored", pty: true, riskLevel: "low" },
      { root: fixture.root, environment },
      { pty: backend },
    );
    const env = backend.requests[0]?.env;
    assert.notEqual(env, undefined);
    for (const blocked of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "HOME",
      "SHELL",
      "SSH_AUTH_SOCK",
    ]) {
      assert.equal(env?.[blocked], undefined, `${blocked} must be dropped`);
    }
    assert.equal(env?.["PATH"], process.env["PATH"] ?? "/usr/bin");
    if (fixture.environment.platform !== "win32") {
      assert.equal(env?.["TERM"], "xterm-256color");
    }
  } finally {
    fixture.cleanup();
  }
});

test("a session that never exits is killed at the deadline", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    const records = { stopped: 0, terminated: 0 };
    const backend = fakeBackend(async () =>
      fakeSession(
        [{ data: Buffer.alloc(0), exited: false, exitCode: null }],
        records,
      ),
    );
    let clock = 0;
    const result = await executeCommand(
      { command: "ignored", pty: true, riskLevel: "low", timeout: 5 },
      { root: fixture.root, environment: execEnvironment(fixture) },
      {
        pty: backend,
        now: () => {
          clock += 1_000;
          return clock;
        },
      },
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.stoppedProcesses, 1);
    assert.equal(records.stopped, 1, "the timeout kills once");
    assert.equal(result.transport, "pty");
  } finally {
    fixture.cleanup();
  }
});

test("the exit hook terminates a live session and is removed when the call settles", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    const records = { stopped: 0, terminated: 0 };
    const handlers: Array<() => void> = [];
    const firstRead = Promise.withResolvers<void>();
    const resumeRead = Promise.withResolvers<void>();
    let reads = 0;
    const session: PtySession = {
      read: async () => {
        reads += 1;
        if (reads === 1) {
          firstRead.resolve();
          await resumeRead.promise;
        }
        return reads === 1
          ? { data: Buffer.alloc(0), exited: false, exitCode: null }
          : { data: Buffer.from("done\n"), exited: true, exitCode: 0 };
      },
      write: async () => undefined,
      stop: async () => {
        records.stopped += 1;
        return 0;
      },
      terminate: () => {
        records.terminated += 1;
      },
    };
    const backend = fakeBackend(async () => session);
    const running = executeCommand(
      { command: "ignored", pty: true, riskLevel: "low" },
      { root: fixture.root, environment: execEnvironment(fixture) },
      {
        pty: backend,
        onExit: (handler) => {
          handlers.push(handler);
        },
        offExit: (handler) => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        },
      },
    );
    await firstRead.promise;
    assert.equal(handlers.length, 1, "one exit hook covers the session");
    handlers[0]!();
    assert.equal(records.terminated, 1);
    resumeRead.resolve();
    const result = await running;
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "done\n");
    assert.deepEqual(handlers, [], "the hook is removed when the call settles");
  } finally {
    fixture.cleanup();
  }
});

test("a read failure after spawn is a failure, never a second run", async () => {
  const fixture = makeToolFixture("droide-exec-pty-");
  try {
    let spawns = 0;
    const backend = fakeBackend(async () => {
      spawns += 1;
      return {
        read: async () => {
          throw new Error("the helper exited");
        },
        write: async () => undefined,
        stop: async () => null,
        terminate: () => undefined,
      };
    });
    await assert.rejects(
      executeCommand(
        { command: "ignored", pty: true, riskLevel: "low" },
        { root: fixture.root, environment: execEnvironment(fixture) },
        { pty: backend },
      ),
      /pseudo-terminal: the helper exited/,
    );
    assert.equal(spawns, 1, "the command is not run again through the pipe");
  } finally {
    fixture.cleanup();
  }
});
