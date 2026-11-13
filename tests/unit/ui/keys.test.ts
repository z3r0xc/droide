/**
 * Key resolution (spec B15, B16).
 *
 * Every row of the key table resolves from the bytes a terminal sends (or from
 * a tokenised event where the byte form does not exist), the escape windows
 * close at the documented timestamps, unknown input never throws, and the
 * double-`Ctrl+C` window is measured against the injected clock.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_KEY_STATE,
  KEY_BINDINGS,
  createKeyState,
  resolveInput,
  resolveKey,
  type KeyAction,
  type KeyInput,
  type KeyState,
} from "../../../src/ui/keys.ts";
import { TIMINGS } from "../../../src/ui/tokens.ts";

const BYTES: Readonly<Record<string, KeyInput>> = {
  enter: "\r",
  newline: "\n",
  tab: "\t",
  backspace: "\u007f",
  delete: "\u001b[3~",
  home: "\u001b[H",
  end: "\u001b[F",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  "shift+tab": "\u001b[Z",
  "ctrl+a": "\u0001",
  "ctrl+c": "\u0003",
  "ctrl+d": "\u0004",
  "ctrl+e": "\u0005",
  "ctrl+g": "\u0007",
  "ctrl+h": "\u0008",
  "ctrl+k": "\u000b",
  "ctrl+l": "\u000c",
  "ctrl+n": "\u000e",
  "ctrl+o": "\u000f",
  "ctrl+p": "\u0010",
  "ctrl+r": "\u0012",
  "ctrl+t": "\u0014",
  "ctrl+u": "\u0015",
  "ctrl+v": "\u0016",
  "ctrl+w": "\u0017",
  "ctrl+y": "\u0019",
  "ctrl+/": "\u001f",
  "ctrl+left": "\u001b[1;5D",
  "ctrl+right": "\u001b[1;5C",
  "ctrl+delete": "\u001b[3;5~",
  "alt+b": "\u001bb",
  "alt+d": "\u001bd",
  "alt+e": "\u001be",
  "alt+f": "\u001bf",
  "alt+p": "\u001bp",
  "alt+s": "\u001bs",
  "alt+v": "\u001bv",
  "alt+x": "\u001bx",
  "alt+backspace": "\u001b\u007f",
  "alt+up": "\u001b[1;3A",
  "alt+down": "\u001b[1;3B",
  "alt+pageup": "\u001b[5;3~",
  "alt+pagedown": "\u001b[6;3~",
  "alt+shift+up": "\u001b[1;4A",
  "alt+shift+down": "\u001b[1;4B",
  "alt+shift+v": "\u001bV",
  // Kitty's CSI-u form, which is how a modern terminal reports Ctrl+Enter.
  "ctrl+enter": "\u001b[13;5u",
  // The legacy Meta-Enter a terminal sends when it cannot encode Ctrl+Enter.
  "alt+enter": "\u001b\r",
};

const EVENTS: Readonly<Record<string, KeyInput>> = {
  "ctrl+enter": { key: "enter", ctrl: true },
  "shift+enter": { key: "enter", shift: true },
  "ctrl+shift+c": { key: "c", ctrl: true, shift: true },
  // Terminals send 0x0a for Ctrl+J, which B15 assigns to a raw LF newline.
  "ctrl+j": { key: "j", ctrl: true },
};

function inputFor(key: string): KeyInput {
  const event = EVENTS[key];
  if (event !== undefined) return event;
  const bytes = BYTES[key];
  assert.ok(bytes !== undefined, `no input form for ${key}`);
  return bytes;
}

function state(overrides: Partial<KeyState> = {}): KeyState {
  return createKeyState({ draftLength: 1, ...overrides });
}

test("every unconditional binding resolves from its key", () => {
  for (const binding of KEY_BINDINGS) {
    if (binding.context !== undefined) continue;
    for (const key of binding.keys) {
      const action = resolveKey(inputFor(key), state(), 0);
      assert.deepEqual(action, binding.action, `binding ${key}`);
    }
  }
});

test("a suggestion menu owns the navigation and accept keys", () => {
  const menu = state({ suggestionsOpen: true });
  assert.deepEqual(resolveKey("\u001b[A", menu, 0), {
    kind: "completion",
    direction: "previous",
  });
  assert.deepEqual(resolveKey("\u001b[B", menu, 0), {
    kind: "completion",
    direction: "next",
  });
  assert.deepEqual(resolveKey("\t", menu, 0), {
    kind: "completion",
    direction: "accept",
  });
  assert.deepEqual(resolveKey("\r", menu, 0), {
    kind: "completion",
    direction: "accept",
  });
  assert.deepEqual(resolveKey("\u001b", state({ suggestionsOpen: true }), 0), {
    kind: "pending",
    buffer: "\u001b",
    sinceMs: 0,
    deadlineMs: TIMINGS.escapeSequenceMs,
  });
});

test("an empty draft binds ?, ! and the left arrow to commands", () => {
  const empty = state({ draftLength: 0 });
  assert.deepEqual(resolveKey("?", empty, 0), {
    kind: "app",
    command: "open-help",
  });
  assert.deepEqual(resolveKey("!", empty, 0), {
    kind: "app",
    command: "toggle-bash",
  });
  assert.deepEqual(resolveKey("\u001b[D", empty, 0), {
    kind: "app",
    command: "open-droids-view",
  });
  assert.deepEqual(resolveKey("?", state(), 0), { kind: "insert", text: "?" });
});

test("typed text arrives as one insert and never splits a chunk", () => {
  assert.deepEqual(resolveKey("hello world", state(), 0), {
    kind: "insert",
    text: "hello world",
  });
  assert.deepEqual(resolveKey("héllo 🙂", state(), 0), {
    kind: "insert",
    text: "héllo 🙂",
  });
});

test("a lone ESC waits the 400 ms window before counting as Escape", () => {
  const first = resolveInput("\u001b", state(), 1000);
  assert.deepEqual(first.actions, [
    {
      kind: "pending",
      buffer: "\u001b",
      sinceMs: 1000,
      deadlineMs: 1000 + TIMINGS.escapeSequenceMs,
    },
  ]);

  const early = resolveInput("", first.state, 1399);
  assert.equal(early.actions[0]?.kind, "pending");
  assert.deepEqual(early.actions, [
    {
      kind: "pending",
      buffer: "\u001b",
      sinceMs: 1000,
      deadlineMs: 1400,
    },
  ]);

  const closed = resolveInput("", early.state, 1400);
  assert.deepEqual(closed.actions, [{ kind: "escape" }]);
  assert.equal(closed.state.buffer, "");
});

test("an ESC run flushes 150 ms after its first byte, 650 ms under tmux", () => {
  const run = resolveInput("\u001b\u001b", DEFAULT_KEY_STATE, 0);
  assert.deepEqual(run.actions, [
    {
      kind: "pending",
      buffer: "\u001b\u001b",
      sinceMs: 0,
      deadlineMs: TIMINGS.escapeRunFlushMs,
    },
  ]);
  assert.deepEqual(
    resolveInput("", run.state, TIMINGS.escapeRunFlushMs).actions,
    [{ kind: "escape" }, { kind: "escape" }],
  );

  const tmux = resolveInput("\u001b\u001b", createKeyState({ tmux: true }), 0);
  assert.deepEqual(tmux.actions, [
    {
      kind: "pending",
      buffer: "\u001b\u001b",
      sinceMs: 0,
      deadlineMs: TIMINGS.tmuxEscapeGraceMs,
    },
  ]);
});

test("an incomplete CSI closes 250 ms after its last byte", () => {
  const open = resolveInput("\u001b[1;5", DEFAULT_KEY_STATE, 10);
  assert.deepEqual(open.actions, [
    {
      kind: "pending",
      buffer: "\u001b[1;5",
      sinceMs: 10,
      deadlineMs: 10 + TIMINGS.incompleteCsiMs,
    },
  ]);
  const closed = resolveInput("", open.state, 10 + TIMINGS.incompleteCsiMs);
  assert.deepEqual(closed.actions, [{ kind: "ignore" }]);
  assert.equal(closed.state.buffer, "");
});

test("a split sequence completes when the rest arrives", () => {
  const open = resolveInput("\u001b", state(), 0);
  const completed = resolveInput("[D", open.state, 20);
  assert.deepEqual(completed.actions, [{ kind: "cursor", move: "left" }]);
});

test("an ESC followed by a letter is Alt+letter", () => {
  assert.deepEqual(resolveInput("\u001bx", state(), 0).actions, [
    { kind: "app", command: "toggle-auto-compaction" },
  ]);
  const lone = resolveInput("\u001b", state(), 0);
  assert.deepEqual(lone.actions, [
    { kind: "pending", buffer: "\u001b", sinceMs: 0, deadlineMs: 400 },
  ]);
  const completed = resolveInput("x", lone.state, 10);
  assert.deepEqual(completed.actions, [
    { kind: "app", command: "toggle-auto-compaction" },
  ]);
});

test("SS3 arrows resolve like CSI arrows", () => {
  assert.deepEqual(resolveKey("\u001bOA", state(), 0), {
    kind: "history",
    direction: "previous",
  });
  assert.deepEqual(resolveKey("\u001bOD", state(), 0), {
    kind: "cursor",
    move: "left",
  });
});

test("a bracketed paste frame becomes one paste action", () => {
  const pasted = resolveInput("\u001b[200~pasted text\u001b[201~", state(), 50);
  assert.deepEqual(pasted.actions, [
    {
      kind: "paste",
      text: "pasted text",
      bracketed: true,
      guardUntilMs: 50 + TIMINGS.pasteKeyGuardMs,
    },
  ]);
});

test("a paste frame spanning chunks keeps the body", () => {
  const open = resolveInput("\u001b[200~hel", state(), 0);
  assert.deepEqual(open.actions, [
    { kind: "pending", buffer: "\u001b[200~hel", sinceMs: 0, deadlineMs: 0 },
  ]);
  const closed = resolveInput("lo\u001b[201~", open.state, 10);
  assert.deepEqual(closed.actions, [
    { kind: "paste", text: "hello", bracketed: true, guardUntilMs: 110 },
  ]);
});

test("a large unframed chunk is treated as a paste", () => {
  const text = "x".repeat(401);
  assert.deepEqual(resolveKey(text, DEFAULT_KEY_STATE, 0), {
    kind: "paste",
    text,
    bracketed: false,
    guardUntilMs: TIMINGS.pasteKeyGuardMs,
  });
  const lines = "a\n".repeat(9);
  assert.equal(resolveKey(lines, DEFAULT_KEY_STATE, 0).kind, "paste");
});

test("Ctrl+C never exits on the first press", () => {
  const first = resolveKey("\u0003", DEFAULT_KEY_STATE, 0);
  assert.deepEqual(first, {
    kind: "interrupt",
    armedUntilMs: TIMINGS.doubleCtrlCWindowMs,
  });
  const armed = createKeyState({
    ctrlCArmedUntilMs: TIMINGS.doubleCtrlCWindowMs,
  });
  assert.deepEqual(
    resolveKey("\u0003", armed, TIMINGS.doubleCtrlCWindowMs - 1),
    { kind: "quit" },
  );
  assert.deepEqual(
    resolveKey("\u0003", armed, TIMINGS.doubleCtrlCWindowMs + 1),
    { kind: "interrupt", armedUntilMs: 2001 + TIMINGS.doubleCtrlCWindowMs },
  );
});

test("the event form resolves the bindings with no byte form", () => {
  assert.deepEqual(resolveKey({ key: "enter", ctrl: true }, state(), 0), {
    kind: "submit",
    queue: true,
  });
  assert.deepEqual(resolveKey({ key: "enter", shift: true }, state(), 0), {
    kind: "newline",
  });
  assert.deepEqual(resolveKey({ key: "tab", shift: true }, state(), 0), {
    kind: "app",
    command: "cycle-mode",
  });
  assert.deepEqual(resolveKey({ key: "upArrow", alt: true }, state(), 0), {
    kind: "app",
    command: "scroll-transcript",
    detail: "up",
  });
});

test("unknown input resolves to ignore and never throws", () => {
  const samples: readonly KeyInput[] = [
    "\u0000",
    "\u001b[?25h",
    "\u001b[99~",
    "\u001b[201~",
    "\u0002",
  ];
  for (const sample of samples) {
    assert.doesNotThrow(() => resolveKey(sample, state(), 0));
    assert.deepEqual(
      resolveKey(sample, state(), 0),
      { kind: "ignore" },
      String(sample),
    );
  }
  assert.deepEqual(resolveKey({ key: "f13" }, state(), 0), { kind: "ignore" });
  assert.deepEqual(resolveKey(new Uint8Array([0x00]), state(), 0), {
    kind: "ignore",
  });
});

test("resolveInput reports every action a chunk carries", () => {
  const resolved = resolveInput("ab\u001b[A", state(), 0);
  const kinds = resolved.actions.map((action: KeyAction) => action.kind);
  // Adjacent printable bytes are one text run, so they are one insert.
  assert.deepEqual(kinds, ["insert", "history"]);
  assert.equal(resolved.state.buffer, "");
});
