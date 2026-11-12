/**
 * Terminal lifecycle (spec B1, B18).
 *
 * The plan decides what may be switched on; entry writes each enabling
 * sequence once; teardown restores exactly what was written, in reverse, once —
 * from a signal, an uncaught error, the exit event, or a direct call. Nothing at
 * all is written when stdout is not a TTY.
 */

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";

import { detectCapabilities } from "../../../src/ui/capabilities.ts";
import {
  TERMINAL_SEQUENCES,
  planTerminal,
  setupTerminal,
  type SignalSource,
} from "../../../src/ui/setup.ts";
import { capabilitiesAt } from "./harness.ts";

interface FakeStreams {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly chunks: string[];
  readonly rawMode: boolean[];
}

function fakeStreams(tty: boolean): FakeStreams {
  const chunks: string[] = [];
  const rawMode: boolean[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const stdout = Object.assign(stream, {
    columns: 80,
    rows: 24,
    isTTY: tty,
  }) as unknown as NodeJS.WriteStream;
  const stdin = {
    isTTY: tty,
    setRawMode(mode: boolean) {
      rawMode.push(mode);
    },
  } as unknown as NodeJS.ReadStream;
  return { stdout, stdin, chunks, rawMode };
}

interface FakeSignals {
  readonly source: SignalSource;
  readonly added: string[];
  readonly removed: string[];
  emit(event: string): void;
  live(): number;
}

function fakeSignals(): FakeSignals {
  const listeners = new Map<string, Array<() => void>>();
  const added: string[] = [];
  const removed: string[] = [];
  const source: SignalSource = {
    on(event, listener) {
      added.push(event);
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off(event, listener) {
      removed.push(event);
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((entry) => entry !== listener),
      );
    },
  };
  return {
    source,
    added,
    removed,
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    live() {
      let count = 0;
      for (const entries of listeners.values()) count += entries.length;
      return count;
    },
  };
}

const INACTIVE_PLAN = {
  raw: false,
  alternateScreen: false,
  focus: false,
  bracketedPaste: false,
  colorScheme: false,
  mouse: "skip",
  tmuxExtendedKeys: false,
  hideCursor: false,
} as const;

test("the plan switches nothing on outside a TTY", () => {
  assert.deepEqual(
    planTerminal(capabilitiesAt(80, 24), {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      tmux: false,
    }),
    INACTIVE_PLAN,
  );
  const nonInteractive = detectCapabilities({
    env: { TERM: "xterm-256color" },
    platform: "linux",
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });
  assert.equal(nonInteractive.interactive, true);
});

test("a non-interactive capability plan writes nothing", () => {
  const capabilities = detectCapabilities({
    env: { TERM: "dumb" },
    platform: "linux",
    stdinIsTTY: false,
    stdoutIsTTY: false,
  });
  const streams = fakeStreams(false);
  const signals = fakeSignals();
  const session = setupTerminal({
    stdin: streams.stdin,
    stdout: streams.stdout,
    plan: planTerminal(capabilities, {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      tmux: false,
    }),
    signals: signals.source,
  });
  assert.deepEqual(streams.chunks, []);
  assert.deepEqual(streams.rawMode, []);
  assert.equal(session.active, false);
  session.teardown();
  assert.deepEqual(streams.chunks, []);
  assert.deepEqual(streams.rawMode, []);
});

test("entry writes the B1 sequences in order and teardown reverses them", () => {
  const streams = fakeStreams(true);
  const signals = fakeSignals();
  const session = setupTerminal({
    stdin: streams.stdin,
    stdout: streams.stdout,
    plan: planTerminal(capabilitiesAt(80, 24), {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: true,
      ownsMouse: true,
    }),
    signals: signals.source,
  });

  assert.deepEqual(streams.chunks, [
    TERMINAL_SEQUENCES.alternateScreenOn,
    TERMINAL_SEQUENCES.focusOn,
    TERMINAL_SEQUENCES.bracketedPasteOn,
    TERMINAL_SEQUENCES.colorSchemeOn,
    TERMINAL_SEQUENCES.mouseOn,
    TERMINAL_SEQUENCES.tmuxExtendedKeysOn,
    TERMINAL_SEQUENCES.hideCursor,
  ]);
  assert.deepEqual(streams.rawMode, [true]);

  streams.chunks.length = 0;
  session.teardown();
  assert.deepEqual(streams.chunks, [
    TERMINAL_SEQUENCES.showCursor,
    TERMINAL_SEQUENCES.tmuxExtendedKeysOff,
    TERMINAL_SEQUENCES.mouseOff,
    TERMINAL_SEQUENCES.colorSchemeOff,
    TERMINAL_SEQUENCES.bracketedPasteOff,
    TERMINAL_SEQUENCES.focusOff,
    TERMINAL_SEQUENCES.alternateScreenOff,
  ]);
  assert.deepEqual(streams.rawMode, [true, false]);
});

test("teardown is idempotent", () => {
  const streams = fakeStreams(true);
  const session = setupTerminal({
    stdin: streams.stdin,
    stdout: streams.stdout,
    plan: planTerminal(capabilitiesAt(80, 24), {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: false,
    }),
    installSafetyNet: false,
  });
  streams.chunks.length = 0;
  session.teardown();
  const firstWrites = [...streams.chunks];
  session.teardown();
  session.teardown();
  assert.deepEqual(streams.chunks, firstWrites);
  assert.deepEqual(streams.rawMode, [true, false]);
});

test("without a mouse owner the off-sequences are written and never restored", () => {
  const streams = fakeStreams(true);
  const session = setupTerminal({
    stdin: streams.stdin,
    stdout: streams.stdout,
    plan: planTerminal(capabilitiesAt(80, 24), {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: false,
      alternateScreen: false,
    }),
    installSafetyNet: false,
  });
  assert.ok(streams.chunks.includes(TERMINAL_SEQUENCES.mouseOff));
  streams.chunks.length = 0;
  session.teardown();
  assert.deepEqual(streams.chunks, [
    TERMINAL_SEQUENCES.showCursor,
    TERMINAL_SEQUENCES.colorSchemeOff,
    TERMINAL_SEQUENCES.bracketedPasteOff,
    TERMINAL_SEQUENCES.focusOff,
  ]);
});

test("a signal restores the terminal and removes every handler", () => {
  const streams = fakeStreams(true);
  const signals = fakeSignals();
  const seen: string[] = [];
  setupTerminal({
    stdin: streams.stdin,
    stdout: streams.stdout,
    plan: planTerminal(capabilitiesAt(80, 24), {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: false,
    }),
    signals: signals.source,
    onSignal: (signal) => seen.push(signal),
  });

  assert.deepEqual(signals.added, [
    "exit",
    "uncaughtException",
    "SIGINT",
    "SIGTERM",
  ]);
  streams.chunks.length = 0;
  signals.emit("SIGINT");

  assert.deepEqual(seen, ["SIGINT"]);
  assert.equal(streams.rawMode.at(-1), false);
  assert.ok(streams.chunks.includes(TERMINAL_SEQUENCES.alternateScreenOff));
  assert.equal(signals.live(), 0);
  assert.equal(signals.removed.length, 4);
});

test("the exit event and an uncaught error both restore the terminal", () => {
  for (const event of ["exit", "uncaughtException"]) {
    const streams = fakeStreams(true);
    const signals = fakeSignals();
    setupTerminal({
      stdin: streams.stdin,
      stdout: streams.stdout,
      plan: planTerminal(capabilitiesAt(80, 24), {
        stdoutIsTTY: true,
        stdinIsTTY: true,
        tmux: false,
      }),
      signals: signals.source,
    });
    streams.chunks.length = 0;
    signals.emit(event);
    assert.ok(
      streams.chunks.includes(TERMINAL_SEQUENCES.alternateScreenOff),
      event,
    );
    assert.equal(streams.rawMode.at(-1), false, event);
    assert.equal(signals.live(), 0, event);
  }
});

test("a disabled safety net never touches the process hooks", () => {
  const streams = fakeStreams(true);
  const signals = fakeSignals();
  const session = setupTerminal({
    stdin: streams.stdin,
    stdout: streams.stdout,
    plan: planTerminal(capabilitiesAt(80, 24), {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      tmux: false,
    }),
    signals: signals.source,
    installSafetyNet: false,
  });
  assert.deepEqual(signals.added, []);
  session.teardown();
  assert.deepEqual(signals.removed, []);
});
