/**
 * The composer state machine (spec B10, B15, B16).
 *
 * Every reducer is pure and takes the caller's clock reading; nothing here
 * schedules a timer. The composer owns the draft, the cursor, the bounded
 * history ring, the completion popup, the paste placeholders and the escape
 * press counter.
 *
 * Escape presses are counted here (B15 rule 2): the first press is the
 * `onEscape` action, a second press within the press window clears a non-empty
 * draft, and a third restores it and asks for the rewind menu. The window is
 * `TIMINGS.repeatedKeyResetMs` (200 ms), or `TIMINGS.repeatedKeyResetTmuxMs`
 * (700 ms) under a multiplexer.
 */

import type { CursorMove, DeleteRange, KeyAction } from "./keys.ts";
import { displayWidth } from "./text.ts";
import { TIMINGS } from "./tokens.ts";

/** How many submitted drafts the history ring keeps. */
export const HISTORY_LIMIT = 100;

/** B16 — a paste is replaced by a placeholder above this many characters. */
export const PASTE_MAX_CHARS = 400;

/** B16 — … or above this many lines. */
export const PASTE_MAX_LINES = 8;

/** B16 — the placeholder preview keeps this many characters of the paste. */
export const PASTE_PREVIEW_CHARS = 50;

/** B15 — the ephemeral message the first `Ctrl+C` prints. */
export const CTRL_C_NOTICE = "Press Ctrl+C again to exit.";

/** One bracketed (or large unframed) paste held for submission. */
export interface ComposerPaste {
  readonly placeholder: string;
  readonly text: string;
  readonly rows: number;
}

/** The completion popup (B11), owned by the composer while it is open. */
export interface CompletionPopup {
  readonly open: boolean;
  readonly kind: "command" | "file";
  readonly items: readonly string[];
  readonly selected: number;
}

export interface ComposerState {
  readonly draft: string;
  /** UTF-16 offset into `draft`, never inside a surrogate pair. */
  readonly cursor: number;
  /** Submitted drafts, oldest first, at most `HISTORY_LIMIT` entries. */
  readonly history: readonly string[];
  /** Position in `history` while browsing, `undefined` for the live draft. */
  readonly historyIndex: number | undefined;
  /** The draft saved when history browsing started. */
  readonly liveDraft: string;
  readonly pastes: readonly ComposerPaste[];
  readonly completion: CompletionPopup;
  /** Enter before this timestamp belongs to the paste that just landed. */
  readonly pasteGuardUntilMs: number | undefined;
  readonly pasteGuardBracketed: boolean;
  /** A bracketed paste's Enter fires when the guard window ends. */
  readonly deferredSubmitAtMs: number | undefined;
  /** The draft the second Escape press cleared. */
  readonly clearedDraft: string;
  readonly escapeCount: number;
  readonly lastEscapeAtMs: number | undefined;
  readonly tmux: boolean;
}

/** What one action did to the composer, beyond the next state. */
export interface ComposerTransition {
  readonly state: ComposerState;
  /** Text to append to the transcript, placeholders expanded. */
  readonly submitted?: string;
  /** Exit requested: `/quit` is a clean quit, `Ctrl+C` an interrupt. */
  readonly exit?: "quit" | "interrupt";
  /** Ephemeral system message for the transcript. */
  readonly notice?: string;
  /** The rewind menu should open (B15 rule 2, third press). */
  readonly rewind?: boolean;
  /** A deferred submit fires at this timestamp. */
  readonly deferredSubmitAtMs?: number;
}

const CLOSED_COMPLETION: CompletionPopup = {
  open: false,
  kind: "command",
  items: [],
  selected: 0,
};

/** A fresh composer. */
export function initialComposerState(
  overrides: Partial<ComposerState> = {},
): ComposerState {
  return {
    draft: "",
    cursor: 0,
    history: [],
    historyIndex: undefined,
    liveDraft: "",
    pastes: [],
    completion: CLOSED_COMPLETION,
    pasteGuardUntilMs: undefined,
    pasteGuardBracketed: false,
    deferredSubmitAtMs: undefined,
    clearedDraft: "",
    escapeCount: 0,
    lastEscapeAtMs: undefined,
    tmux: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ cursor -- */

/** Previous code-point boundary (never splits a surrogate pair). */
function previousIndex(text: string, index: number): number {
  if (index <= 0) return 0;
  const before = text.charCodeAt(index - 1);
  const surrogate = before >= 0xdc00 && before <= 0xdfff;
  return surrogate && index >= 2 ? index - 2 : index - 1;
}

function nextIndex(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  const surrogate = code >= 0xd800 && code <= 0xdbff;
  return surrogate && index + 2 <= text.length ? index + 2 : index + 1;
}

function isSpace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

function lineStartIndex(text: string, index: number): number {
  const found = text.lastIndexOf("\n", Math.max(0, index - 1));
  return found < 0 ? 0 : found + 1;
}

function lineEndIndex(text: string, index: number): number {
  const found = text.indexOf("\n", index);
  return found < 0 ? text.length : found;
}

function wordLeftIndex(text: string, index: number): number {
  let at = index;
  while (at > 0 && isSpace(text.charAt(at - 1))) at -= 1;
  while (at > 0 && !isSpace(text.charAt(at - 1))) at -= 1;
  return at;
}

function wordRightIndex(text: string, index: number): number {
  let at = index;
  while (at < text.length && isSpace(text.charAt(at))) at += 1;
  while (at < text.length && !isSpace(text.charAt(at))) at += 1;
  return at;
}

/** Clamp a cursor offset into the draft without landing inside a surrogate pair. */
function clampCursor(draft: string, cursor: number): number {
  const at = Math.min(Math.max(0, cursor), draft.length);
  const low = draft.charCodeAt(at);
  return at > 0 && at < draft.length && low >= 0xdc00 && low <= 0xdfff
    ? at - 1
    : at;
}

function cursorOf(state: ComposerState): number {
  return clampCursor(state.draft, state.cursor);
}

/** Replace the draft and place the cursor (end of the draft by default). */
function setDraft(
  state: ComposerState,
  draft: string,
  cursor: number = draft.length,
): ComposerState {
  return { ...state, draft, cursor: clampCursor(draft, cursor) };
}

export function moveCursor(
  state: ComposerState,
  move: CursorMove,
): ComposerState {
  const draft = state.draft;
  const cursor = cursorOf(state);
  switch (move) {
    case "left":
      return { ...state, cursor: previousIndex(draft, cursor) };
    case "right":
      return { ...state, cursor: nextIndex(draft, cursor) };
    case "wordLeft":
      return { ...state, cursor: wordLeftIndex(draft, cursor) };
    case "wordRight":
      return { ...state, cursor: wordRightIndex(draft, cursor) };
    case "lineStart":
      return { ...state, cursor: lineStartIndex(draft, cursor) };
    case "lineEnd":
      return { ...state, cursor: lineEndIndex(draft, cursor) };
  }
}

function replaceRange(
  state: ComposerState,
  from: number,
  to: number,
  text: string,
): ComposerState {
  const draft = state.draft.slice(0, from) + text + state.draft.slice(to);
  return setDraft(state, draft, from + text.length);
}

export function deleteRange(
  state: ComposerState,
  range: DeleteRange,
): ComposerState {
  const draft = state.draft;
  const cursor = cursorOf(state);
  switch (range) {
    case "charBefore": {
      const from = previousIndex(draft, cursor);
      return from === cursor ? state : replaceRange(state, from, cursor, "");
    }
    case "charAfter": {
      const to = nextIndex(draft, cursor);
      return to === cursor ? state : replaceRange(state, cursor, to, "");
    }
    case "wordBefore":
      return replaceRange(state, wordLeftIndex(draft, cursor), cursor, "");
    case "wordAfter":
      return replaceRange(state, cursor, wordRightIndex(draft, cursor), "");
    case "toLineStart":
      return replaceRange(state, lineStartIndex(draft, cursor), cursor, "");
    case "toLineEnd":
      return replaceRange(state, cursor, lineEndIndex(draft, cursor), "");
  }
}

export function insertText(state: ComposerState, text: string): ComposerState {
  if (text.length === 0) return state;
  const cursor = cursorOf(state);
  return replaceRange(state, cursor, cursor, text);
}

export function insertNewline(state: ComposerState): ComposerState {
  return insertText(state, "\n");
}

/* ----------------------------------------------------------------- history -- */

function pushHistory(
  history: readonly string[],
  entry: string,
): readonly string[] {
  if (entry.trim().length === 0) return history;
  if (history[history.length - 1] === entry) return history;
  const next = [...history, entry];
  return next.length > HISTORY_LIMIT
    ? next.slice(next.length - HISTORY_LIMIT)
    : next;
}

export function moveHistory(
  state: ComposerState,
  direction: "previous" | "next",
): ComposerState {
  const { history } = state;
  if (history.length === 0) return state;
  if (direction === "previous") {
    const index =
      state.historyIndex === undefined
        ? history.length - 1
        : Math.max(0, state.historyIndex - 1);
    const liveDraft =
      state.historyIndex === undefined ? state.draft : state.liveDraft;
    return setDraft(
      { ...state, historyIndex: index, liveDraft },
      history[index] ?? state.draft,
    );
  }
  if (state.historyIndex === undefined) return state;
  const index = state.historyIndex + 1;
  if (index >= history.length) {
    return setDraft(
      { ...state, historyIndex: undefined, liveDraft: "" },
      state.liveDraft,
    );
  }
  return setDraft(
    { ...state, historyIndex: index },
    history[index] ?? state.draft,
  );
}

/* -------------------------------------------------------------------- paste -- */

const ANSI =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/gu;

const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** B16: strip ANSI and every C0 control except tab and newline. */
export function sanitizePaste(text: string): string {
  return text.replace(ANSI, "").replace(C0, "");
}

/** Visual rows of `text` at `width`; raw line count when the width is unknown. */
export function visualRowCount(text: string, width?: number): number {
  const lines = text.split("\n");
  if (width === undefined || width <= 0) return Math.max(1, lines.length);
  let rows = 0;
  for (const line of lines) {
    rows += Math.max(1, Math.ceil(displayWidth(line) / width));
  }
  return Math.max(1, rows);
}

/** B16: `[<first 50 chars>... <N> lines]`, with `, paste <k>` on repeats. */
export function pastePlaceholder(
  text: string,
  rows: number,
  occurrence: number,
): string {
  const preview = text
    .slice(0, PASTE_PREVIEW_CHARS)
    .replace(/[\n\t]/gu, " ")
    .trim();
  const base = `[${preview}... ${rows} lines]`;
  return occurrence > 1 ? `${base}, paste ${occurrence}` : base;
}

/** Replace every placeholder in the draft with the text it stands for. */
export function expandPastes(state: ComposerState): string {
  let draft = state.draft;
  for (const paste of state.pastes) {
    draft = draft.replace(paste.placeholder, paste.text);
  }
  return draft;
}

export interface PasteOptions {
  readonly nowMs: number;
  readonly bracketed: boolean;
  /** Composer width in cells; omitted means "count raw lines". */
  readonly width?: number;
}

/** Insert a pasted chunk, replacing an oversized one with its placeholder. */
export function insertPaste(
  state: ComposerState,
  raw: string,
  options: PasteOptions,
): ComposerState {
  const text = sanitizePaste(raw);
  if (text.length === 0) return state;
  const guard: ComposerState = {
    ...state,
    pasteGuardUntilMs: options.nowMs + TIMINGS.pasteKeyGuardMs,
    pasteGuardBracketed: options.bracketed,
  };
  const large =
    text.length > PASTE_MAX_CHARS || text.split("\n").length > PASTE_MAX_LINES;
  if (!large) return insertText(guard, text);

  const rows = visualRowCount(text, options.width);
  const occurrence =
    state.pastes.filter((paste) => paste.text === text).length + 1;
  const placeholder = pastePlaceholder(text, rows, occurrence);
  const pasted: ComposerState = {
    ...guard,
    pastes: [...state.pastes, { placeholder, text, rows }],
  };
  return insertText(pasted, placeholder);
}

/* --------------------------------------------------------------- completion -- */

export function openCompletion(
  state: ComposerState,
  kind: CompletionPopup["kind"],
  items: readonly string[],
): ComposerState {
  return {
    ...state,
    completion: { open: true, kind, items: [...items], selected: 0 },
  };
}

export function closeCompletion(state: ComposerState): ComposerState {
  return state.completion.open
    ? { ...state, completion: CLOSED_COMPLETION }
    : state;
}

function moveCompletion(
  state: ComposerState,
  direction: "next" | "previous",
): ComposerState {
  const { completion } = state;
  if (!completion.open || completion.items.length === 0) return state;
  const count = completion.items.length;
  const selected =
    direction === "next"
      ? (completion.selected + 1) % count
      : (completion.selected - 1 + count) % count;
  return { ...state, completion: { ...completion, selected } };
}

function acceptCompletion(state: ComposerState): ComposerState {
  const { completion } = state;
  if (!completion.open) return state;
  const item = completion.items[completion.selected];
  if (item === undefined) return closeCompletion(state);
  const accepted = completion.kind === "command" ? `/${item}` : item;
  return setDraft({ ...state, completion: CLOSED_COMPLETION }, accepted);
}

/* ------------------------------------------------------------------ submit -- */

function clearedComposer(state: ComposerState): ComposerState {
  return {
    ...state,
    draft: "",
    cursor: 0,
    historyIndex: undefined,
    liveDraft: "",
    pastes: [],
    completion: CLOSED_COMPLETION,
    pasteGuardUntilMs: undefined,
    pasteGuardBracketed: false,
    deferredSubmitAtMs: undefined,
    clearedDraft: "",
    escapeCount: 0,
    lastEscapeAtMs: undefined,
  };
}

/**
 * Submit the draft (B15). `Enter` inside the 100 ms paste guard belongs to the
 * paste: dropped for an unframed paste, deferred for a bracketed one (B16).
 * A trailing unescaped `\` turns the Enter into a newline.
 */
export function submitDraft(
  state: ComposerState,
  nowMs: number,
): ComposerTransition {
  if (
    state.pasteGuardUntilMs !== undefined &&
    nowMs < state.pasteGuardUntilMs
  ) {
    if (!state.pasteGuardBracketed) return { state };
    return {
      state: { ...state, deferredSubmitAtMs: state.pasteGuardUntilMs },
      deferredSubmitAtMs: state.pasteGuardUntilMs,
    };
  }

  const expanded = expandPastes(state);
  const backslashes = /\\+$/u.exec(expanded)?.[0].length ?? 0;
  if (backslashes % 2 === 1) {
    const before = expanded.slice(0, expanded.length - backslashes);
    const kept = "\\".repeat(backslashes - 1);
    return { state: setDraft(state, `${before}${kept}\n`) };
  }

  const text = expanded.trim();
  if (text.length === 0) return { state };
  if (text === "/quit") {
    return { state: clearedComposer(state), exit: "quit" };
  }
  return {
    state: {
      ...clearedComposer(state),
      history: pushHistory(state.history, text),
    },
    submitted: text,
  };
}

/* ------------------------------------------------------------------- escape -- */

function escapePress(state: ComposerState, nowMs: number): ComposerTransition {
  const window = state.tmux
    ? TIMINGS.repeatedKeyResetTmuxMs
    : TIMINGS.repeatedKeyResetMs;
  const chained =
    state.lastEscapeAtMs !== undefined &&
    nowMs - state.lastEscapeAtMs <= window;
  const count = chained ? state.escapeCount + 1 : 1;
  const counted: ComposerState = {
    ...state,
    escapeCount: count,
    lastEscapeAtMs: nowMs,
  };
  if (count === 1) return { state: counted };
  if (count === 2) {
    if (state.draft.length === 0) return { state: counted };
    return {
      state: {
        ...counted,
        clearedDraft: state.draft,
        draft: "",
        cursor: 0,
      },
    };
  }
  return {
    state: setDraft(counted, state.clearedDraft),
    rewind: true,
  };
}

/* ---------------------------------------------------------------- dispatch -- */

function applyCompletion(
  state: ComposerState,
  direction: "next" | "previous" | "accept" | "cancel",
): ComposerState {
  switch (direction) {
    case "next":
      return moveCompletion(state, "next");
    case "previous":
      return moveCompletion(state, "previous");
    case "accept":
      return acceptCompletion(state);
    case "cancel":
      return closeCompletion(state);
  }
}

/** Apply one resolved key action. `width` sizes a new paste placeholder. */
export function applyComposerAction(
  state: ComposerState,
  action: KeyAction,
  nowMs: number,
  width?: number,
): ComposerTransition {
  switch (action.kind) {
    case "insert":
      return { state: insertText(state, action.text) };
    case "newline":
      return { state: insertNewline(state) };
    case "submit":
      // Nothing queues yet: a queued message is the same transcript append.
      return submitDraft(state, nowMs);
    case "escape":
      return escapePress(state, nowMs);
    case "history":
      return { state: moveHistory(state, action.direction) };
    case "completion":
      return { state: applyCompletion(state, action.direction) };
    case "cursor":
      return { state: moveCursor(state, action.move) };
    case "delete":
      return { state: deleteRange(state, action.range) };
    case "paste":
      return {
        state: insertPaste(state, action.text, {
          nowMs,
          bracketed: action.bracketed,
          ...(width === undefined ? {} : { width }),
        }),
      };
    case "pasteExpand": {
      const expanded = expandPastes(state);
      return {
        state: setDraft({ ...state, pastes: [] }, expanded),
      };
    }
    case "interrupt":
      return {
        state: {
          ...clearedComposer(state),
          clearedDraft: state.draft,
        },
        notice: CTRL_C_NOTICE,
      };
    case "quit":
      return { state, exit: "interrupt" };
    case "pending":
    case "ignore":
    case "app":
      return { state };
  }
}

/**
 * The clock tick: fires a deferred submit and lets a lapsed escape press
 * sequence restart from one.
 */
export function advanceComposer(
  state: ComposerState,
  nowMs: number,
): ComposerTransition {
  const window = state.tmux
    ? TIMINGS.repeatedKeyResetTmuxMs
    : TIMINGS.repeatedKeyResetMs;
  const lapsed =
    state.lastEscapeAtMs !== undefined && nowMs - state.lastEscapeAtMs > window;
  const base = lapsed
    ? { ...state, escapeCount: 0, lastEscapeAtMs: undefined }
    : state;
  if (
    base.deferredSubmitAtMs !== undefined &&
    nowMs >= base.deferredSubmitAtMs
  ) {
    return submitDraft({ ...base, deferredSubmitAtMs: undefined }, nowMs);
  }
  return { state: base };
}
