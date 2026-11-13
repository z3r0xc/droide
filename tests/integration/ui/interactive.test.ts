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

import type {
  Provider,
  ProviderDelta,
  ToolRunner,
} from "../../../src/agent/ports.ts";
import type { AppContext } from "../../../src/app/context.ts";
import {
  INTERRUPT_EXIT_CODE,
  InteractiveUnavailableError,
  TERMINATE_EXIT_CODE,
  runInteractiveShell,
  systemTimers,
  type ShellAgent,
  type TimerApi,
} from "../../../src/app/interactive.ts";
import {
  TERMINAL_SEQUENCES,
  type SignalSource,
} from "../../../src/ui/setup.ts";
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
  /** Advance relative to the current fake time, firing every due timer once. */
  advanceBy(ms: number): void;
}

function fakeClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; run: () => void }>();
  const fireDue = (): void => {
    for (const [id, entry] of [...scheduled]) {
      if (entry.at > now) continue;
      scheduled.delete(id);
      entry.run();
    }
  };
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
      fireDue();
    },
    advanceBy(ms) {
      now += ms;
      fireDue();
    },
  };
}

interface FakeSignals {
  readonly source: SignalSource;
  readonly added: string[];
  readonly removed: string[];
  live(): number;
  emit(event: string): void;
}

function fakeSignals(): FakeSignals {
  const added: string[] = [];
  const removed: string[] = [];
  const live = new Set<string>();
  const listeners = new Map<string, Array<() => void>>();
  return {
    source: {
      on(event, listener) {
        added.push(event);
        live.add(`${event}:${String(listener)}`);
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      off(event, listener) {
        removed.push(event);
        live.delete(`${event}:${String(listener)}`);
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== listener),
        );
      },
    },
    added,
    removed,
    live: () => live.size,
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

/** A provider the test drives: one script per call, or a stream held open. */
interface ScriptedProvider {
  readonly provider: Provider;
  /** Calls started so far. */
  calls: number;
  /** Streams still open. */
  active: number;
  /** Streams that observed the abort signal. */
  aborts: number;
}

function scriptedProvider(
  script: (call: number) => readonly ProviderDelta[] | "hold",
): ScriptedProvider {
  const state: ScriptedProvider = {
    provider: {
      async *stream(_messages, { signal }) {
        const call = state.calls;
        state.calls += 1;
        state.active += 1;
        try {
          const plan = script(call);
          const deltas: readonly ProviderDelta[] =
            plan === "hold" ? [{ type: "text", text: "partial" }] : plan;
          for (const delta of deltas) {
            if (signal.aborted) {
              state.aborts += 1;
              throw Object.assign(new Error("aborted"), { name: "AbortError" });
            }
            yield delta;
          }
          if (plan === "hold") {
            if (signal.aborted) {
              state.aborts += 1;
              throw Object.assign(new Error("aborted"), { name: "AbortError" });
            }
            const aborted = Promise.withResolvers<never>();
            const onAbort = (): void => {
              state.aborts += 1;
              aborted.reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            };
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              await aborted.promise;
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          }
        } finally {
          state.active -= 1;
        }
      },
    },
    calls: 0,
    active: 0,
    aborts: 0,
  };
  return state;
}

/** A tool port that answers immediately; these tests never touch a tool. */
function silentToolRunner(): ToolRunner {
  return {
    async execute() {
      return { content: "ok", isError: false };
    },
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
    stateDir: "/home/test/.droide",
    userSettingsFile: "/home/test/.droide/settings.json",
    projectDir: "/project",
    projectSettingsFile: "/project/.droide/settings.json",
    sessionsDir: "/home/test/.droide/sessions",
    sessionIndexDir: "/home/test/.droide/index",
    sessionIndexDatabase: "/home/test/.droide/index/sessions.db",
    cacheDir: "/home/test/.droide/cache",
    logsDir: "/home/test/.droide/logs",
    worktreesRoot: "/home/test/.droide/worktrees",
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

function start(agent?: () => ShellAgent): Session {
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
    ...(agent === undefined ? {} : { agent }),
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

/** How many times `needle` occurs in the raw captured output. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
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

test(
  "backspace edits the draft and Up recalls a submitted line",
  { timeout: 8000 },
  async () => {
    const session = start();
    try {
      await session.ready();
      await waitFor(() => session.terminal.chunks.length > 0, "first frame");

      session.terminal.write("hellp");
      session.terminal.write("\u007f");
      session.terminal.write("o");
      await waitFor(
        () =>
          session.terminal.lastFrame().some((line) => line.includes("hello")),
        "edited draft",
      );

      session.terminal.write("\r");
      await waitFor(
        () =>
          session.terminal.lastFrame().some((line) => line.trim() === "hello"),
        "submitted hello",
      );

      // Up recalls the submitted line into the composer: two rows now name it.
      session.terminal.write("\u001b[A");
      await waitFor(
        () =>
          session.terminal.lastFrame().filter((line) => line.includes("hello"))
            .length >= 2,
        "history recall",
      );

      for (let press = 0; press < 5; press += 1) {
        session.terminal.write("\u007f");
      }
      session.terminal.write("bye");
      session.terminal.write("\r");
      await waitFor(
        () =>
          session.terminal.lastFrame().some((line) => line.trim() === "bye"),
        "submitted bye",
      );

      const frame = session.terminal.lastFrame();
      assert.ok(
        frame.some((line) => line.trim() === "hello"),
        "first row",
      );
      assert.ok(
        frame.some((line) => line.trim() === "bye"),
        "second row",
      );
    } finally {
      session.terminal.write("/quit\r");
      assert.equal(await session.exits, 0);
    }
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);

test(
  "a failing mount restores the terminal exactly once and leaks nothing",
  { timeout: 8000 },
  async () => {
    const terminal = fakeTerminal();
    const signals = fakeSignals();
    const mounts: number[] = [];
    await assert.rejects(
      runInteractiveShell({
        context,
        stdout: terminal.stdout,
        stdin: terminal.stdin,
        columns: 80,
        rows: 24,
        debug: true,
        timers: fakeClock().timers,
        signals: signals.source,
        mount: async () => {
          mounts.push(1);
          throw new Error("mount failed");
        },
      }),
      /mount failed/u,
    );

    assert.equal(mounts.length, 1);
    // Only the terminal lifecycle ran: each enabling sequence once, then each
    // matching disabling sequence once, in reverse.
    assert.deepEqual(terminal.chunks, [
      TERMINAL_SEQUENCES.alternateScreenOn,
      TERMINAL_SEQUENCES.focusOn,
      TERMINAL_SEQUENCES.bracketedPasteOn,
      TERMINAL_SEQUENCES.colorSchemeOn,
      TERMINAL_SEQUENCES.mouseOff,
      TERMINAL_SEQUENCES.hideCursor,
      TERMINAL_SEQUENCES.showCursor,
      TERMINAL_SEQUENCES.colorSchemeOff,
      TERMINAL_SEQUENCES.bracketedPasteOff,
      TERMINAL_SEQUENCES.focusOff,
      TERMINAL_SEQUENCES.alternateScreenOff,
    ]);
    assert.deepEqual(terminal.stdin.rawModes, [true, false]);
    assert.equal(terminal.stdin.listenerCount("data"), 0, "stdin listener");
    assert.equal(terminal.stdout.listenerCount("resize"), 0, "resize listener");
    assert.equal(signals.live(), 0, "signal hooks");
  },
);

test(
  "a failing repaint rejects the session after restoring the terminal",
  { timeout: 8000 },
  async () => {
    const terminal = fakeTerminal();
    const signals = fakeSignals();
    const clock = fakeClock();
    let unmounts = 0;
    const session = runInteractiveShell({
      context,
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      columns: 80,
      rows: 24,
      debug: true,
      clock: clock.clock,
      timers: clock.timers,
      signals: signals.source,
      mount: async () => ({
        unmount: async () => {
          unmounts += 1;
        },
        rerender: async () => {
          throw new Error("render failed");
        },
      }),
    });

    await waitFor(() => terminal.stdin.listenerCount("data") === 1, "mount");
    terminal.write("a");

    await assert.rejects(session, /render failed/u);
    assert.equal(unmounts, 1);
    assert.deepEqual(terminal.stdin.rawModes, [true, false]);
    assert.equal(terminal.stdin.listenerCount("data"), 0, "stdin listener");
    assert.equal(terminal.stdout.listenerCount("resize"), 0, "resize listener");
    assert.equal(clock.size(), 0, "no timer left scheduled");
    assert.equal(signals.live(), 0, "signal hooks");
  },
);

test(
  "a signal during mount still resolves and leaves nothing behind",
  { timeout: 8000 },
  async () => {
    const terminal = fakeTerminal();
    const signals = fakeSignals();
    const clock = fakeClock();
    let unmounts = 0;
    const session = runInteractiveShell({
      context,
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      columns: 80,
      rows: 24,
      debug: true,
      clock: clock.clock,
      timers: clock.timers,
      signals: signals.source,
      mount: async () => {
        signals.emit("SIGTERM");
        return {
          unmount: async () => {
            unmounts += 1;
          },
          rerender: async () => {},
        };
      },
    });

    assert.equal(await session, TERMINATE_EXIT_CODE);
    assert.equal(unmounts, 1);
    assert.equal(
      countOf(terminal.chunks.join(""), TERMINAL_SEQUENCES.alternateScreenOff),
      1,
    );
    assert.deepEqual(terminal.stdin.rawModes, [true, false]);
    assert.equal(terminal.stdin.listenerCount("data"), 0, "stdin listener");
    assert.equal(terminal.stdout.listenerCount("resize"), 0, "resize listener");
    assert.equal(clock.size(), 0, "no timer left scheduled");
    assert.equal(signals.live(), 0, "signal hooks");
  },
);

test(
  "a normal quit restores the terminal exactly once",
  { timeout: 8000 },
  async () => {
    const session = start();
    await session.ready();
    session.terminal.write("/quit\r");
    assert.equal(await session.exits, 0);

    const raw = session.terminal.chunks.join("");
    assert.equal(countOf(raw, TERMINAL_SEQUENCES.alternateScreenOff), 1);
    assert.equal(countOf(raw, TERMINAL_SEQUENCES.focusOff), 1);
    assert.equal(countOf(raw, TERMINAL_SEQUENCES.bracketedPasteOff), 1);
    assert.equal(countOf(raw, TERMINAL_SEQUENCES.colorSchemeOff), 1);
    // Ink unmounts first and restores its own cursor; the shell's teardown is
    // the last thing written, once, in reverse entry order.
    assert.deepEqual(session.terminal.chunks.slice(-5), [
      TERMINAL_SEQUENCES.showCursor,
      TERMINAL_SEQUENCES.colorSchemeOff,
      TERMINAL_SEQUENCES.bracketedPasteOff,
      TERMINAL_SEQUENCES.focusOff,
      TERMINAL_SEQUENCES.alternateScreenOff,
    ]);
    assert.deepEqual(session.terminal.stdin.rawModes, [true, false]);
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);

test(
  "SIGINT and SIGTERM resolve the shell after restoring the terminal once",
  { timeout: 8000 },
  async () => {
    for (const [signal, code] of [
      ["SIGINT", INTERRUPT_EXIT_CODE],
      ["SIGTERM", TERMINATE_EXIT_CODE],
    ] as const) {
      const session = start();
      await session.ready();
      session.signals.emit(signal);

      assert.equal(await session.exits, code, signal);

      const raw = session.terminal.chunks.join("");
      assert.equal(
        countOf(raw, TERMINAL_SEQUENCES.alternateScreenOff),
        1,
        signal,
      );
      assert.equal(countOf(raw, TERMINAL_SEQUENCES.focusOff), 1, signal);
      assert.equal(
        countOf(raw, TERMINAL_SEQUENCES.bracketedPasteOff),
        1,
        signal,
      );
      assert.equal(countOf(raw, TERMINAL_SEQUENCES.colorSchemeOff), 1, signal);
      assert.deepEqual(session.terminal.stdin.rawModes, [true, false], signal);
      assertNoLeaks(session.terminal, session.signals, session.clock);
    }
  },
);

test(
  "Esc cancels a streaming turn and the composer still answers",
  { timeout: 8000 },
  async () => {
    const scripted = scriptedProvider((call) =>
      call === 0
        ? "hold"
        : [{ type: "text", text: "second answer" }, { type: "done" }],
    );
    const session = start(() => ({
      provider: scripted.provider,
      tools: () => silentToolRunner(),
    }));
    try {
      await session.ready();
      session.terminal.write("first");
      session.terminal.write("\r");
      await waitFor(
        () => session.terminal.text().includes("first"),
        "user row",
      );

      // The first delta lands only after its coalescing frame fires.
      session.clock.advanceBy(16);
      await waitFor(
        () => session.terminal.text().includes("partial"),
        "streamed text",
      );
      assert.equal(scripted.active, 1, "stream open");
      const streamingFrame = session.terminal.lastFrame().join("\n");
      assert.match(streamingFrame, /Streaming\.\.\./u, "status line text");
      assert.match(streamingFrame, /\(Press ESC to stop\)/u);

      // A lone Escape waits for its window, then cancels the turn.
      session.terminal.write("\u001b");
      session.clock.advanceBy(400);
      await waitFor(
        () => session.terminal.text().includes("Cancelled"),
        "cancel notice",
      );
      assert.equal(scripted.active, 0, "aborted stream closed");
      assert.equal(scripted.aborts, 1, "the provider observed the abort");
      assert.equal(
        session.terminal.lastFrame().join("\n").includes("Streaming..."),
        false,
        "the status line clears when the turn ends",
      );

      // The composer kept its draft and does not need a remount.
      session.terminal.write("again");
      session.terminal.write("\r");
      await waitFor(
        () => session.terminal.text().includes("second answer"),
        "second turn answered",
      );
      assert.equal(scripted.calls, 2);
    } finally {
      session.terminal.write("/quit\r");
      assert.equal(await session.exits, 0);
    }
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);

test(
  "quitting during a turn aborts it and restores the terminal once",
  { timeout: 8000 },
  async () => {
    const scripted = scriptedProvider(() => "hold");
    const session = start(() => ({
      provider: scripted.provider,
      tools: () => silentToolRunner(),
    }));
    await session.ready();
    session.terminal.write("work");
    session.terminal.write("\r");
    await waitFor(
      () => scripted.active === 1,
      "turn streaming before the quit",
    );
    await waitFor(() => session.terminal.text().includes("work"), "user row");

    session.terminal.write("\u0003");
    session.terminal.write("\u0003");
    assert.equal(await session.exits, INTERRUPT_EXIT_CODE);

    assert.equal(scripted.active, 0, "no provider stream outlives the shell");
    assert.equal(scripted.aborts, 1, "the in-flight request was aborted");
    assert.equal(
      countOf(
        session.terminal.chunks.join(""),
        TERMINAL_SEQUENCES.alternateScreenOff,
      ),
      1,
      "the alternate screen was left exactly once",
    );
    assertNoLeaks(session.terminal, session.signals, session.clock);
  },
);
