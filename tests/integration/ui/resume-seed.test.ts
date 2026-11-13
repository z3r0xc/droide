/**
 * A resumed interactive shell, end to end inside the process
 * (`specs/10-cli-surface.md` B22).
 *
 * The store is a real SQLite index and real transcript files under a temporary
 * home; only the terminal, the clock and the model are fakes. What this proves
 * is the seam `resume` hands the shell: the stored turns are the first screen,
 * and the next request carries them plus the newly typed prompt — no call is
 * replayed to rebuild them.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import type {
  Provider,
  ProviderDelta,
  ToolRunner,
} from "../../../src/agent/ports.ts";
import type { AppContext } from "../../../src/app/context.ts";
import {
  runInteractiveShell,
  type ShellAgent,
  type TimerApi,
} from "../../../src/app/interactive.ts";
import { seedFromRecords, type SessionSeed } from "../../../src/app/session-seed.ts";
import type { Platform } from "../../../src/config/paths.ts";
import { openSessionStore } from "../../../src/session/store.ts";
import type { SignalSource } from "../../../src/ui/setup.ts";
import { stripAnsi } from "../../unit/ui/harness.ts";

const SESSION_ID = "4f0e0d0c-0b0a-4a09-8807-060504030201";

interface FakeTerminal {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  write(text: string): void;
  text(): string;
}

function fakeTerminal(): FakeTerminal {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const stdout = Object.assign(sink, {
    columns: 80,
    rows: 24,
    isTTY: true,
  }) as unknown as NodeJS.WriteStream;

  const input = new PassThrough();
  const stdin = Object.assign(input, {
    isTTY: true,
    setRawMode() {},
  }) as unknown as NodeJS.ReadStream;

  return {
    stdin,
    stdout,
    write(text) {
      input.write(text);
    },
    text() {
      return stripAnsi(chunks.join(""));
    },
  };
}

function fakeTimers(): TimerApi {
  return {
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
}

const noSignals: SignalSource = {
  on: () => {},
  off: () => {},
};

function platformOf(): Platform {
  switch (process.platform) {
    case "win32":
      return "win32";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      throw new Error(`unsupported test platform: ${process.platform}`);
  }
}

function contextFor(directory: string): AppContext {
  return {
    environment: {
      env: { TERM: "xterm-256color" },
      home: directory,
      platform: platformOf(),
      cwd: join(directory, "project"),
    },
    paths: {
      stateDir: join(directory, "managed"),
      userSettingsFile: join(directory, "managed", "settings.json"),
      projectDir: join(directory, "project"),
      projectSettingsFile: join(
        directory,
        "project",
        ".droide",
        "settings.json",
      ),
      sessionsDir: join(directory, "managed", "sessions"),
      sessionIndexDir: join(directory, "managed", "index"),
      sessionIndexDatabase: join(directory, "managed", "index", "sessions.db"),
      cacheDir: join(directory, "managed", "cache"),
      logsDir: join(directory, "managed", "logs"),
      worktreesRoot: join(directory, "managed", "worktrees"),
    },
    settings: {},
    layers: [],
    droppedOverlays: [],
  };
}

/** A provider that records every request and answers with one short line. */
interface RecordingProvider {
  readonly provider: Provider;
  readonly requests: readonly (readonly string[])[];
  calls(): number;
}

function recordingProvider(): RecordingProvider {
  const requests: string[][] = [];
  const provider: Provider = {
    async *stream(messages): AsyncIterable<ProviderDelta> {
      requests.push(
        messages.map((message) =>
          message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        ),
      );
      yield { type: "text", text: "noted." };
      yield { type: "done" };
    },
  };
  return { provider, requests, calls: () => requests.length };
}

const toolRunner: ToolRunner = {
  async execute() {
    return { content: "ok", isError: false };
  },
};

function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A stored session built the way `exec` writes one. */
async function storedSeed(directory: string): Promise<{
  readonly context: AppContext;
  readonly seed: SessionSeed;
}> {
  const context = contextFor(directory);
  const store = openSessionStore({
    dbPath: context.paths.sessionIndexDatabase,
    sessionsDir: context.paths.sessionsDir,
    clock: { now: () => 1_000 },
  });
  try {
    store.registerSession({
      sessionId: SESSION_ID,
      projectKey: "",
      cwd: context.environment.cwd,
      firstEventAt: 1_000,
    });
    for (const record of [
      {
        type: "message",
        message: {
          id: "old-user",
          role: "user",
          content: [{ type: "text", text: "what is this repo?" }],
        },
        timestamp: 1_000,
      },
      {
        type: "message",
        message: {
          id: "old-assistant",
          role: "assistant",
          content: [{ type: "text", text: "a TypeScript product layer." }],
        },
        timestamp: 2_000,
      },
    ]) {
      store.appendTranscriptRecord(SESSION_ID, record);
    }
    return { context, seed: seedFromRecords(store.readSession(SESSION_ID)) };
  } finally {
    store.close();
  }
}

test(
  "the resumed shell opens on the stored turns and sends them with the prompt",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "droide-resume-shell-"));
    try {
      const { context, seed } = await storedSeed(directory);
      const terminal = fakeTerminal();
      const model = recordingProvider();
      const agent: ShellAgent = {
        provider: model.provider,
        tools: () => toolRunner,
      };

      const exit = runInteractiveShell({
        context,
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        columns: 80,
        rows: 24,
        debug: true,
        clock: () => 0,
        timers: fakeTimers(),
        signals: noSignals,
        installSafetyNet: false,
        seed,
        agent: () => agent,
      });

      try {
        await waitFor(
          () => terminal.stdin.listenerCount("data") === 1,
          "mount",
        );
        // The first screen is the conversation that was stored, not a replay.
        await waitFor(
          () => terminal.text().includes("what is this repo?"),
          "stored user row",
        );
        assert.ok(terminal.text().includes("a TypeScript product layer."));
        assert.equal(model.calls(), 0, "no model call to rebuild the screen");

        terminal.write("and the next step?");
        terminal.write("\r");
        await waitFor(() => model.calls() === 1, "the turn's request");

        // B22: the context is the stored history plus the new prompt.
        assert.deepEqual(model.requests[0], [
          "what is this repo?",
          "a TypeScript product layer.",
          "and the next step?",
        ]);
        await waitFor(
          () => terminal.text().includes("noted."),
          "the streamed answer",
        );
      } finally {
        terminal.write("/quit\r");
        assert.equal(await exit, 0);
      }
      assert.equal(terminal.stdin.listenerCount("data"), 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
