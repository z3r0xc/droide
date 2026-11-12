/**
 * The composer state machine (spec B10, B15, B16).
 *
 * Pure reducers with an injected clock: history bounds, multi-line editing,
 * paste thresholds and placeholders, the 100 ms paste guard, escape press
 * counting and the completion popup.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CTRL_C_NOTICE,
  HISTORY_LIMIT,
  PASTE_MAX_CHARS,
  advanceComposer,
  applyComposerAction,
  deleteRange,
  expandPastes,
  initialComposerState,
  insertPaste,
  insertText,
  moveCursor,
  openCompletion,
  pastePlaceholder,
  sanitizePaste,
  submitDraft,
  visualRowCount,
  type ComposerState,
} from "../../../src/ui/input.ts";
import type { KeyAction } from "../../../src/ui/keys.ts";

function type(state: ComposerState, text: string): ComposerState {
  return applyComposerAction(state, { kind: "insert", text }, 0).state;
}

function press(
  state: ComposerState,
  action: KeyAction,
  nowMs = 0,
): ReturnType<typeof applyComposerAction> {
  return applyComposerAction(state, action, nowMs);
}

test("submitting appends a transcript entry and clears the composer", () => {
  const typed = type(initialComposerState(), "hello");
  const submitted = submitDraft(typed, 0);
  assert.equal(submitted.submitted, "hello");
  assert.equal(submitted.state.draft, "");
  assert.equal(submitted.state.cursor, 0);
});

test("Enter on an empty draft submits nothing", () => {
  const submitted = submitDraft(initialComposerState(), 0);
  assert.equal(submitted.submitted, undefined);
});

test("history keeps the newest entries and is bounded", () => {
  let state = initialComposerState();
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
    state = submitDraft(type(state, `message ${index}`), 0).state;
  }
  assert.equal(state.history.length, HISTORY_LIMIT);
  assert.equal(state.history[0], "message 5");
  assert.equal(
    state.history[HISTORY_LIMIT - 1],
    `message ${HISTORY_LIMIT + 4}`,
  );
});

test("history navigation restores the live draft at the end", () => {
  let state = initialComposerState();
  state = submitDraft(type(state, "one"), 0).state;
  state = submitDraft(type(state, "two"), 0).state;
  state = type(state, "live");

  state = press(state, { kind: "history", direction: "previous" }).state;
  assert.equal(state.draft, "two");
  state = press(state, { kind: "history", direction: "previous" }).state;
  assert.equal(state.draft, "one");
  state = press(state, { kind: "history", direction: "previous" }).state;
  assert.equal(state.draft, "one");

  state = press(state, { kind: "history", direction: "next" }).state;
  assert.equal(state.draft, "two");
  state = press(state, { kind: "history", direction: "next" }).state;
  assert.equal(state.draft, "live");
  assert.equal(state.historyIndex, undefined);
});

test("Shift+Enter inserts a newline and keeps the cursor on the last row", () => {
  let state = type(initialComposerState(), "a");
  state = press(state, { kind: "newline" }).state;
  state = type(state, "b");
  assert.equal(state.draft, "a\nb");
  assert.equal(state.cursor, 3);
});

test("a trailing backslash turns Enter into a newline", () => {
  const typed = type(initialComposerState(), "line\\");
  const submitted = submitDraft(typed, 0);
  assert.equal(submitted.submitted, undefined);
  assert.equal(submitted.state.draft, "line\n");

  const escaped = type(initialComposerState(), "line\\\\");
  assert.equal(submitDraft(escaped, 0).submitted, "line\\\\");
});

test("a paste above 400 characters becomes a placeholder", () => {
  const text = "x".repeat(PASTE_MAX_CHARS + 1);
  const state = insertPaste(initialComposerState(), text, {
    nowMs: 0,
    bracketed: true,
    width: 80,
  });
  assert.equal(
    state.draft,
    `[${"x".repeat(50)}... ${Math.ceil(text.length / 80)} lines]`,
  );
  assert.equal(state.pastes.length, 1);
  assert.equal(state.pastes[0]?.text, text);
});

test("a paste above 8 lines becomes a placeholder", () => {
  const text = "a\n".repeat(9);
  const state = insertPaste(initialComposerState(), text, {
    nowMs: 0,
    bracketed: true,
  });
  const rows = visualRowCount(text);
  assert.equal(rows, 10);
  assert.equal(state.draft, pastePlaceholder(text, rows, 1));
  assert.match(state.draft, /10 lines\]/u);
});

test("a second identical large paste is numbered", () => {
  const text = "z".repeat(PASTE_MAX_CHARS + 1);
  let state = insertPaste(initialComposerState(), text, {
    nowMs: 0,
    bracketed: true,
    width: 40,
  });
  state = insertPaste(state, text, { nowMs: 1, bracketed: true, width: 40 });
  assert.match(state.draft, /, paste 2\]|paste 2$/u);
  assert.equal(state.pastes.length, 2);
});

test("a small paste is inserted verbatim", () => {
  const state = insertPaste(initialComposerState(), "plain", {
    nowMs: 0,
    bracketed: true,
  });
  assert.equal(state.draft, "plain");
  assert.equal(state.pastes.length, 0);
});

test("submission expands placeholders back to the pasted text", () => {
  const text = "p".repeat(PASTE_MAX_CHARS + 1);
  const state = insertPaste(initialComposerState(), text, {
    nowMs: 0,
    bracketed: true,
    width: 80,
  });
  assert.equal(expandPastes(state), text);
  const submitted = submitDraft(state, 1000);
  assert.equal(submitted.submitted, text);
});

test("Alt+Shift+V expands placeholders in the draft", () => {
  const text = "q".repeat(PASTE_MAX_CHARS + 1);
  const state = insertPaste(initialComposerState(), text, {
    nowMs: 0,
    bracketed: true,
    width: 80,
  });
  const expanded = press(state, { kind: "pasteExpand" }).state;
  assert.equal(expanded.draft, text);
  assert.equal(expanded.pastes.length, 0);
});

test("Enter inside the paste guard belongs to the paste", () => {
  const unframed = insertPaste(initialComposerState(), "hi", {
    nowMs: 1000,
    bracketed: false,
  });
  const dropped = submitDraft(unframed, 1050);
  assert.equal(dropped.submitted, undefined);
  assert.equal(dropped.state.draft, "hi");

  const framed = insertPaste(initialComposerState(), "hi", {
    nowMs: 1000,
    bracketed: true,
  });
  const deferred = submitDraft(framed, 1050);
  assert.equal(deferred.deferredSubmitAtMs, 1100);
  const fired = advanceComposer(deferred.state, 1100);
  assert.equal(fired.submitted, "hi");
});

test("paste sanitisation drops ANSI and C0 controls, keeping tabs and newlines", () => {
  assert.equal(sanitizePaste("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizePaste("a\u0000b\tc\nd"), "ab\tc\nd");
});

test("visual rows wrap by display width", () => {
  assert.equal(visualRowCount("abcdef", 3), 2);
  assert.equal(visualRowCount("a\nb"), 2);
  assert.equal(visualRowCount("abc", 0), 1);
});

test("the first Escape press is onEscape, the second clears, the third rewinds", () => {
  let state = type(initialComposerState(), "draft");
  let transition = press(state, { kind: "escape" }, 0);
  state = transition.state;
  assert.equal(state.draft, "draft");
  assert.equal(state.escapeCount, 1);

  transition = press(state, { kind: "escape" }, 100);
  state = transition.state;
  assert.equal(state.draft, "");
  assert.equal(state.clearedDraft, "draft");

  transition = press(state, { kind: "escape" }, 200);
  state = transition.state;
  assert.equal(state.draft, "draft");
  assert.equal(transition.rewind, true);
});

test("Escape presses stop counting after the 200 ms window", () => {
  let state = type(initialComposerState(), "draft");
  state = press(state, { kind: "escape" }, 0).state;
  state = press(state, { kind: "escape" }, 500).state;
  assert.equal(state.escapeCount, 1);
  assert.equal(state.draft, "draft");
});

test("under tmux the Escape press window is 700 ms", () => {
  let state = type(initialComposerState({ tmux: true }), "draft");
  state = press(state, { kind: "escape" }, 0).state;
  state = press(state, { kind: "escape" }, 600).state;
  assert.equal(state.escapeCount, 2);
  assert.equal(state.draft, "");
});

test("the first Ctrl+C clears the draft and prints the notice", () => {
  const typed = type(initialComposerState(), "hello");
  const transition = press(typed, { kind: "interrupt", armedUntilMs: 2000 }, 0);
  assert.equal(transition.state.draft, "");
  assert.equal(transition.notice, CTRL_C_NOTICE);
  assert.equal(transition.exit, undefined);
});

test("the second Ctrl+C quits with the interrupt exit", () => {
  const transition = press(initialComposerState(), { kind: "quit" }, 0);
  assert.equal(transition.exit, "interrupt");
});

test("/quit exits cleanly without a transcript entry", () => {
  const transition = submitDraft(type(initialComposerState(), "/quit"), 0);
  assert.equal(transition.exit, "quit");
  assert.equal(transition.submitted, undefined);
});

test("cursor moves and deletions stay on code-point boundaries", () => {
  let state = type(initialComposerState(), "🙂ab");
  state = moveCursor(state, "left");
  assert.equal(state.cursor, 3);
  state = deleteRange(state, "charBefore");
  assert.equal(state.draft, "🙂b");
  state = deleteRange(state, "charAfter");
  assert.equal(state.draft, "🙂");
  state = deleteRange(state, "charBefore");
  assert.equal(state.draft, "");
});

test("word and line deletions use the draft's own boundaries", () => {
  let state = type(initialComposerState(), "one two three");
  state = deleteRange(state, "wordBefore");
  assert.equal(state.draft, "one two ");
  state = press(state, { kind: "cursor", move: "lineStart" }).state;
  assert.equal(state.cursor, 0);
  state = press(state, { kind: "delete", range: "wordAfter" }).state;
  assert.equal(state.draft, " two ");

  state = type(initialComposerState(), "abc\ndef");
  state = press(state, { kind: "cursor", move: "lineStart" }).state;
  assert.equal(state.cursor, 4);
  state = press(state, { kind: "delete", range: "toLineEnd" }).state;
  assert.equal(state.draft, "abc\n");
});

test("the completion popup cycles, accepts and cancels", () => {
  let state = openCompletion(initialComposerState(), "command", [
    "model",
    "mcp",
  ]);
  state = press(state, { kind: "completion", direction: "next" }).state;
  assert.equal(state.completion.selected, 1);
  state = press(state, { kind: "completion", direction: "next" }).state;
  assert.equal(state.completion.selected, 0);
  state = press(state, { kind: "completion", direction: "previous" }).state;
  assert.equal(state.completion.selected, 1);

  state = press(state, { kind: "completion", direction: "accept" }).state;
  assert.equal(state.draft, "/mcp");
  assert.equal(state.completion.open, false);

  const open = openCompletion(initialComposerState(), "file", ["a.ts"]);
  const cancelled = press(open, {
    kind: "completion",
    direction: "cancel",
  }).state;
  assert.equal(cancelled.completion.open, false);
});

test("insertText replaces at the cursor, not at the end", () => {
  const state = insertText(initialComposerState(), "ab");
  const atStart = { ...state, cursor: 0 };
  assert.equal(insertText(atStart, "X").draft, "Xab");
});
