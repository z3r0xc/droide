/**
 * Headless integration of the interactive entry point (spec B1, B15).
 *
 * The shell is mounted on fake streams, keystrokes arrive as terminal bytes,
 * and the rendered frames are the debug-mode appends. Each session is closed
 * through a real key path, and the test then proves nothing was left behind: no
 * stdin/stdout listener, no raw mode, no scheduled timer, no signal hook.
 */

import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import type { AppContext } from "../../../src/app/context.ts";
import {
  INTERRUPT_EXIT_CODE,
  InteractiveUnavailableError,
  runInteractiveShell,
  systemTimers,
  type TimerApi,
} from "../../../src/app/interactive.ts";
import type { SignalSource } from "../../../src/ui/setup.ts";
import { STARTUP_PLACEHOLDER } from "../../../src/ui/strings.ts";
import { frameLines, stripAnsi } from "../../unit/ui/harness.ts";

interface FakeTerminal {
  readonly stdin: NodeJS.ReadStream & { readonly rawModes: boolean[] };
  readonly stdout: NodeJS.WriteStream;
  readonly chunks: string[];
  write(text: string): void;
  text(): string;
  lastFrame(): string[];
}

function fakeTerminal(tty = true): FakeTerminal {
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
    isTTY: tty,
  }) as unknown as NodeJS.WriteStream;

  const rawModes: boolean[] = [];
  const input = new PassThrough();
  const stdin = Object.assign(input, {
    isTTY: tty,
    rawModes,
    setRawMode(mode: boolean) {
      rawModes.push(mode);
    },
  }) as unknown as FakeTerminal["stdin"];

  return {
    stdin,
    stdout,
    chunks,
    write(text) {
      input.write(text);
    },
    text() {
      return stripAnsi(chunks.join(""));
    },
    lastFrame() {
      for (let index = chunks.length - 1; index >= 0; index -= 1) {
        const lines = frameLines(chunks[index] ?? "");
        if (lines.length > 0) return lines;
      }
      return [];
    },
  };
}

interface FakeClock {
  readonly clock: () => number;
  readonly timers: TimerApi;
  readonly size: () => number;
  advanceTo(ms: number): void;
}

function fakeClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; run: () => void }>();
  return {
    clock: () => now,
    timers: {
      setTimeout: (callback, ms) => {
        const id = nextId;
        nextId += 1;
        scheduled.set(id, { at: now + ms, run: callback });
        return id;
      },
      clearTimeout: (handle) => {
        if (typeof handle === "number") scheduled.delete(handle);
      },
    },
    size: () => scheduled.size,
    advanceTo(ms) {
      now = ms;
      for (const [id, entry] of [...scheduled]) {
        if (entry.at > now) continue;
        scheduled.delete(id);
        entry.run();
      }
    },
  };
}

interface FakeSignals {
  readonly source: SignalSource;
  readonly added: string[];
  readonly removed: string[];
  live(): number;
}

function fakeSignals(): FakeSignals {
  const added: string[] = [];
  const removed: string[] = [];
  const live = new Set<string>();
  return {
    source: {
      on(event, listener) {
        added.push(event);
        live.add(`${event}:${String(listener)}`);
      },
      off(event, listener) {
        removed.push(event);
        live.delete(`${event}:${String(listener)}`);
      },
    },
    added,
    removed,
    live: () => live.size,
  };
}

const context: AppContext = {
  environment: {
    env: { TERM: "xterm-256color" },
    home: "/home/test",
    platform: "linux",
    cwd: "/project",
  },
  paths: {
    factoryDir: "/home/test/.factory",
    userSettingsFile: "/home/test/.factory/settings.json",
    projectDir: "/project",
    projectSettingsFile: "/project/.factory/settings.json",
    sessionsDir: "/home/test/.factory/sessions",
    sessionIndexDir: "/home/test/.factory/index",
    sessionIndexDatabase: "/home/test/.factory/index/sessions.db",
    cacheDir: "/home/test/.factory/cache",
    logsDir: "/home/test/.factory/logs",
    worktreesRoot: "/home/test/.factory/worktrees",
  },
  settings: {},
  layers: [],
  droppedOverlays: [],
};

/** Yield to the task queue, never to the clock; the test's own timeout bounds it. */
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Session {
  readonly terminal: FakeTerminal;
  readonly exits: Promise<number>;
  readonly signals: FakeSignals;
  readonly clock: FakeClock;
  ready(): Promise<void>;
}

function start(): Session {
  const terminal = fakeTerminal();
  const clock = fakeClock();
  const signals = fakeSignals();
  const exits = runInteractiveShell({
    context,
    stdout: terminal.stdout,
    stdin: terminal.stdin,
    columns: 80,
    rows: 24,
    debug: true,
    clock: clock.clock,
    timers: clock.timers,
    signals: signals.source,
  });
  return {
    terminal,
    exits,
    signals,
    clock,
    ready: () =>
      waitFor(() => terminal.stdin.listenerCount("data") === 1, "mount"),
  };
}

function assertNoLeaks(
  terminal: FakeTerminal,
  signals: FakeSignals,
  clock: FakeClock,
): void {
  assert.equal(terminal.stdin.listenerCount("data"), 0, "stdin data listener");
  assert.equal(terminal.stdout.listenerCount("resize"), 0, "resize listener");
  assert.equal(terminal.stdin.rawModes.at(-1), false, "raw mode restored");
  assert.equal(clock.size(), 0, "no timer left scheduled");
  assert.equal(signals.live(), 0, "no signal hook left");
}

test(
  "typing and Enter update the rendered transcript",
  { timeout: 8000 },
  async () => {
    const session = start();
    try {
      await session.ready();
      await waitFor(() => session.terminal.chunks.length > 0, "first frame");
      assert.ok(session.terminal.text().includes(STARTUP_PLACEHOLDER));

      session.terminal.write("hi");
      await waitFor(() => session.terminal.text().includes("hi"), "draft");

      session.terminal.write("\r");
      await waitFor(
        () => session.terminal.lastFrame().some((line) => line.trim() === "hi"),
        "user row",
      );

      const frame = session.terminal.lastFrame();
      assert.ok(
        frame.some((line) => line.trim() === "hi"),
        "user row kept",
      );
      assert.ok(
        frame.some((line) => line.includes(STARTUP_PLACEHOLDER)),
        "composer cleared back to the placeholder",
      );
    } finally {
      session.terminal.write("/quit\r");
      assert.equal(await session.exits, 0);
    }
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);

test(
  "a lone Escape waits for its window and typing continues",
  { timeout: 8000 },
  async () => {
    const session = start();
    try {
      await session.ready();
      session.terminal.write("\u001b");
      await waitFor(() => session.clock.size() > 0, "escape timer");

      session.clock.advanceTo(400);
      session.terminal.write("a");
      session.terminal.write("\r");
      await waitFor(
        () => session.terminal.lastFrame().some((line) => line.trim() === "a"),
        "submitted a",
      );
    } finally {
      session.terminal.write("/quit\r");
      assert.equal(await session.exits, 0);
    }
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);

test(
  "two Ctrl+C presses inside the window exit with 130",
  { timeout: 8000 },
  async () => {
    const session = start();
    await session.ready();
    session.terminal.write("\u0003");
    await waitFor(
      () => session.terminal.text().includes("Press Ctrl+C again to exit."),
      "notice",
    );
    session.terminal.write("\u0003");
    assert.equal(await session.exits, INTERRUPT_EXIT_CODE);
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);

test(
  "a bracketed paste becomes a placeholder row and submits in full",
  { timeout: 8000 },
  async () => {
    const session = start();
    try {
      await session.ready();
      const text = "p".repeat(430);
      session.terminal.write(`\u001b[200~${text}\u001b[201~`);
      await waitFor(
        () => session.terminal.text().includes("... 6 lines]"),
        "placeholder",
      );
      session.terminal.write("\r");
      session.clock.advanceTo(100);
      await waitFor(
        () => session.terminal.text().replace(/\s/gu, "").includes(text),
        "expanded paste",
      );
    } finally {
      session.terminal.write("/quit\r");
      assert.equal(await session.exits, 0);
    }
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);

test(
  "non-TTY streams are refused before anything is mounted",
  { timeout: 8000 },
  async () => {
    const terminal = fakeTerminal(false);
    await assert.rejects(
      runInteractiveShell({
        context,
        stdout: terminal.stdout,
        stdin: terminal.stdin,
        columns: 80,
        rows: 24,
        debug: true,
        timers: systemTimers,
      }),
      InteractiveUnavailableError,
    );
    assert.deepEqual(terminal.chunks, []);
    assert.deepEqual(terminal.stdin.rawModes, []);
  },
);
