/**
 * Key bindings and key resolution (spec B15, B16).
 *
 * The resolver is pure: it takes the bytes or the event a terminal delivered,
 * the caller's sequencing state and the caller's clock reading, and returns an
 * action. It never schedules a timer, never reads a clock and never throws — an
 * unknown key resolves to `ignore`.
 *
 * Escape sequencing (B15 rule 1) is represented as a `pending` action: the
 * resolver hands the caller the bytes still undecided and the timestamp at which
 * the decision expires. The caller stores both (`KeyState.buffer`,
 * `KeyState.bufferSinceMs`) and calls again with `""` when the deadline fires.
 * A lone `ESC` waits `TIMINGS.escapeSequenceMs` (400 ms); an ESC *run* flushes
 * `TIMINGS.escapeRunFlushMs` (150 ms) after its first byte, or
 * `TIMINGS.tmuxEscapeGraceMs` (650 ms) under tmux; an incomplete CSI closes
 * `TIMINGS.incompleteCsiMs` (250 ms) after its last byte. A bracketed-paste
 * frame has no deadline.
 *
 * Escape *press* counting (B15 rule 2) lives in the composer reducer
 * (`input.ts`, `applyComposerAction`), where the press window of
 * `TIMINGS.repeatedKeyResetMs` (200 ms) / `TIMINGS.repeatedKeyResetTmuxMs`
 * (700 ms) is applied to the `escape` actions this module resolves.
 */

import { PASTE_MAX_CHARS, PASTE_MAX_LINES } from "./input.ts";
import { TIMINGS } from "./tokens.ts";

/** A cursor move the composer applies. */
export type CursorMove =
  "left" | "right" | "wordLeft" | "wordRight" | "lineStart" | "lineEnd";

/** A deletion the composer applies. */
export type DeleteRange =
  | "charBefore"
  | "charAfter"
  | "wordBefore"
  | "wordAfter"
  | "toLineStart"
  | "toLineEnd";

/**
 * Bindings whose surface belongs to another slice. The resolver still names
 * them, so the key table is complete and a later slice consumes an action
 * instead of re-parsing bytes.
 */
export type AppCommand =
  | "cycle-mode"
  | "cycle-reasoning"
  | "cycle-model"
  | "cycle-autonomy"
  | "toggle-detailed-transcript"
  | "toggle-plan"
  | "open-help"
  | "toggle-bash"
  | "open-editor"
  | "copy-input"
  | "paste-clipboard"
  | "open-mission-control"
  | "open-side-chat"
  | "dismiss-changelog"
  | "open-droids-view"
  | "toggle-auto-compaction"
  | "inspect-approval"
  | "review-queued"
  | "pop-queued"
  | "scroll-transcript";

/** What one key press means. */
export type KeyAction =
  | { readonly kind: "ignore" }
  /**
   * Bytes whose meaning is not decided yet. `deadlineMs === 0` means "wait for
   * the rest of the frame, no timer" (a bracketed paste in flight).
   */
  | {
      readonly kind: "pending";
      readonly buffer: string;
      readonly sinceMs: number;
      readonly deadlineMs: number;
    }
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "submit"; readonly queue: boolean }
  | { readonly kind: "newline" }
  /** One Escape *press*, already past the lone-ESC window (B15 rule 2). */
  | { readonly kind: "escape" }
  | { readonly kind: "history"; readonly direction: "previous" | "next" }
  | {
      readonly kind: "completion";
      readonly direction: "next" | "previous" | "accept" | "cancel";
    }
  | {
      readonly kind: "paste";
      readonly text: string;
      readonly bracketed: boolean;
      readonly guardUntilMs: number;
    }
  | { readonly kind: "pasteExpand" }
  /** First `Ctrl+C`: clear the draft, notice, arm the window. */
  | { readonly kind: "interrupt"; readonly armedUntilMs: number }
  /** Second `Ctrl+C` inside the window: exit with the interrupt code. */
  | { readonly kind: "quit" }
  | { readonly kind: "cursor"; readonly move: CursorMove }
  | { readonly kind: "delete"; readonly range: DeleteRange }
  | {
      readonly kind: "app";
      readonly command: AppCommand;
      readonly detail?: string;
    };

/** Anything the resolver may read besides the input itself. */
export interface KeyState {
  /** Undecided bytes carried from the previous call. */
  readonly buffer: string;
  /** When the first undecided byte arrived, or the last byte of an open CSI. */
  readonly bufferSinceMs: number;
  /** `TMUX` or `STY` is set: longer escape grace, 700 ms press window. */
  readonly tmux: boolean;
  /** A suggestion menu owns ↑ ↓ Tab Enter Esc. */
  readonly suggestionsOpen: boolean;
  /** Draft length; 0 enables the empty-composer bindings (`?`, `!`, ←). */
  readonly draftLength: number;
  /** A `Ctrl+C` press armed the exit window until this timestamp. */
  readonly ctrlCArmedUntilMs?: number;
}

export const DEFAULT_KEY_STATE: KeyState = {
  buffer: "",
  bufferSinceMs: 0,
  tmux: false,
  suggestionsOpen: false,
  draftLength: 0,
};

/** Fill in the defaults; `undefined` is not a value any field accepts. */
export function createKeyState(overrides: Partial<KeyState>): KeyState {
  return { ...DEFAULT_KEY_STATE, ...overrides };
}

/** A resolved key event, for callers that already tokenise input (Ink-style). */
export interface KeyEventInput {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}

/** Raw terminal bytes, a decoded chunk, or one tokenised event. */
export type KeyInput = string | Uint8Array | KeyEventInput;

/** The actions one input chunk produced, and the state to pass next time. */
export interface KeyResolution {
  readonly actions: readonly KeyAction[];
  readonly state: KeyState;
}

/* ------------------------------------------------------------------ table -- */

/**
 * One row of the key table. `keys` are canonical chord spellings
 * (`ctrl+left`, `alt+shift+v`, `shift+tab`). `context` marks bindings whose
 * meaning depends on the composer, so the global lookup skips them.
 */
export interface KeyBinding {
  readonly keys: readonly string[];
  readonly action: KeyAction;
  readonly context?: "menuOpen" | "emptyDraft";
}

const ignore: KeyAction = { kind: "ignore" };

/** Spec "Key bindings" table, in table order. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { keys: ["enter"], action: { kind: "submit", queue: false } },
  {
    keys: ["ctrl+enter", "alt+enter"],
    action: { kind: "submit", queue: true },
  },
  { keys: ["shift+enter"], action: { kind: "newline" } },
  { keys: ["newline"], action: { kind: "newline" } },
  {
    keys: ["up"],
    action: { kind: "completion", direction: "previous" },
    context: "menuOpen",
  },
  {
    keys: ["down"],
    action: { kind: "completion", direction: "next" },
    context: "menuOpen",
  },
  {
    keys: ["tab"],
    action: { kind: "completion", direction: "accept" },
    context: "menuOpen",
  },
  {
    keys: ["enter"],
    action: { kind: "completion", direction: "accept" },
    context: "menuOpen",
  },
  {
    keys: ["escape"],
    action: { kind: "completion", direction: "cancel" },
    context: "menuOpen",
  },
  { keys: ["up"], action: { kind: "history", direction: "previous" } },
  { keys: ["down"], action: { kind: "history", direction: "next" } },
  { keys: ["shift+tab"], action: { kind: "app", command: "cycle-mode" } },
  { keys: ["tab"], action: { kind: "app", command: "cycle-reasoning" } },
  { keys: ["ctrl+n"], action: { kind: "app", command: "cycle-model" } },
  { keys: ["ctrl+l"], action: { kind: "app", command: "cycle-autonomy" } },
  {
    keys: ["ctrl+o"],
    action: { kind: "app", command: "toggle-detailed-transcript" },
  },
  { keys: ["alt+p"], action: { kind: "app", command: "toggle-plan" } },
  {
    keys: ["?"],
    action: { kind: "app", command: "open-help" },
    context: "emptyDraft",
  },
  { keys: ["ctrl+/"], action: { kind: "app", command: "open-help" } },
  {
    keys: ["!"],
    action: { kind: "app", command: "toggle-bash" },
    context: "emptyDraft",
  },
  { keys: ["ctrl+p"], action: { kind: "app", command: "open-editor" } },
  { keys: ["ctrl+shift+c"], action: { kind: "app", command: "copy-input" } },
  { keys: ["ctrl+v"], action: { kind: "app", command: "paste-clipboard" } },
  { keys: ["alt+v"], action: { kind: "app", command: "paste-clipboard" } },
  { keys: ["alt+shift+v"], action: { kind: "pasteExpand" } },
  { keys: ["ctrl+r"], action: { kind: "app", command: "review-queued" } },
  { keys: ["ctrl+g"], action: { kind: "app", command: "pop-queued" } },
  {
    keys: ["ctrl+t"],
    action: { kind: "app", command: "open-mission-control" },
  },
  { keys: ["ctrl+y"], action: { kind: "app", command: "open-side-chat" } },
  { keys: ["ctrl+j"], action: { kind: "app", command: "dismiss-changelog" } },
  { keys: ["alt+s"], action: { kind: "app", command: "open-droids-view" } },
  {
    keys: ["left"],
    action: { kind: "app", command: "open-droids-view" },
    context: "emptyDraft",
  },
  {
    keys: ["alt+x"],
    action: { kind: "app", command: "toggle-auto-compaction" },
  },
  { keys: ["alt+e"], action: { kind: "app", command: "inspect-approval" } },
  {
    keys: ["alt+up"],
    action: { kind: "app", command: "scroll-transcript", detail: "up" },
  },
  {
    keys: ["alt+down"],
    action: { kind: "app", command: "scroll-transcript", detail: "down" },
  },
  {
    keys: ["alt+pageup"],
    action: { kind: "app", command: "scroll-transcript", detail: "pageUp" },
  },
  {
    keys: ["alt+pagedown"],
    action: { kind: "app", command: "scroll-transcript", detail: "pageDown" },
  },
  {
    keys: ["alt+shift+up"],
    action: { kind: "app", command: "scroll-transcript", detail: "oldest" },
  },
  {
    keys: ["alt+shift+down"],
    action: { kind: "app", command: "scroll-transcript", detail: "newest" },
  },
  { keys: ["ctrl+left"], action: { kind: "cursor", move: "wordLeft" } },
  { keys: ["ctrl+right"], action: { kind: "cursor", move: "wordRight" } },
  { keys: ["alt+b"], action: { kind: "cursor", move: "wordLeft" } },
  { keys: ["alt+f"], action: { kind: "cursor", move: "wordRight" } },
  { keys: ["left"], action: { kind: "cursor", move: "left" } },
  { keys: ["right"], action: { kind: "cursor", move: "right" } },
  { keys: ["ctrl+a"], action: { kind: "cursor", move: "lineStart" } },
  { keys: ["home"], action: { kind: "cursor", move: "lineStart" } },
  { keys: ["ctrl+e"], action: { kind: "cursor", move: "lineEnd" } },
  { keys: ["end"], action: { kind: "cursor", move: "lineEnd" } },
  { keys: ["backspace"], action: { kind: "delete", range: "charBefore" } },
  { keys: ["ctrl+h"], action: { kind: "delete", range: "charBefore" } },
  { keys: ["delete"], action: { kind: "delete", range: "charAfter" } },
  { keys: ["ctrl+d"], action: { kind: "delete", range: "charAfter" } },
  { keys: ["ctrl+w"], action: { kind: "delete", range: "wordBefore" } },
  { keys: ["alt+backspace"], action: { kind: "delete", range: "wordBefore" } },
  { keys: ["alt+d"], action: { kind: "delete", range: "wordAfter" } },
  { keys: ["ctrl+delete"], action: { kind: "delete", range: "wordAfter" } },
  { keys: ["ctrl+u"], action: { kind: "delete", range: "toLineStart" } },
  { keys: ["ctrl+k"], action: { kind: "delete", range: "toLineEnd" } },
];

const BINDINGS_BY_KEY: ReadonlyMap<string, KeyBinding> = new Map(
  KEY_BINDINGS.filter((binding) => binding.context === undefined).flatMap(
    (binding) =>
      binding.keys.map((key): [string, KeyBinding] => [key, binding]),
  ),
);

/* ---------------------------------------------------------------- decoding -- */

type TokenType = "text" | "key" | "escapeRun" | "pasteStart" | "pasteEnd";

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly length: number;
}

type Decoded =
  | { readonly status: "token"; readonly token: Token }
  | {
      readonly status: "incomplete";
      readonly kind: "escape" | "csi" | "ss3" | "paste";
    };

const textDecoder = new TextDecoder();

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function decodeToken(buffer: string): Decoded {
  const first = buffer.codePointAt(0) ?? 0;
  const firstChar = String.fromCodePoint(first);

  if (first === 0x1b) {
    if (buffer.length === 1) return { status: "incomplete", kind: "escape" };
    const next = buffer.charAt(1);
    if (next === "[") {
      for (let index = 2; index < buffer.length; index += 1) {
        const code = buffer.charCodeAt(index);
        if (isCsiFinal(code)) {
          const body = buffer.slice(0, index + 1);
          const sequence = buffer.slice(2, index);
          const finalByte = buffer.charAt(index);
          if (sequence === "200" && finalByte === "~") {
            return {
              status: "token",
              token: { type: "pasteStart", value: body, length: body.length },
            };
          }
          if (sequence === "201" && finalByte === "~") {
            return {
              status: "token",
              token: { type: "pasteEnd", value: body, length: body.length },
            };
          }
          return {
            status: "token",
            token: {
              type: "key",
              value: keyFromCsi(sequence, finalByte),
              length: body.length,
            },
          };
        }
      }
      return { status: "incomplete", kind: "csi" };
    }
    if (next === "O") {
      if (buffer.length < 3) return { status: "incomplete", kind: "ss3" };
      return {
        status: "token",
        token: {
          type: "key",
          value: CSI_KEYS[buffer.charAt(2)] ?? "",
          length: 3,
        },
      };
    }
    if (next === "\u001b") {
      let count = 0;
      while (count < buffer.length && buffer.charAt(count) === "\u001b") {
        count += 1;
      }
      if (count === buffer.length) {
        return { status: "incomplete", kind: "escape" };
      }
      return {
        status: "token",
        token: {
          type: "escapeRun",
          value: String(count),
          length: count,
        },
      };
    }
    const upper = next >= "A" && next <= "Z";
    const alt =
      next === "\u007f"
        ? "alt+backspace"
        : next === "\r"
          ? "alt+enter"
          : upper
            ? `alt+shift+${next.toLowerCase()}`
            : `alt+${next}`;
    return {
      status: "token",
      token: { type: "key", value: alt, length: 2 },
    };
  }

  if (firstChar === "\r") {
    return {
      status: "token",
      token: { type: "key", value: "enter", length: 1 },
    };
  }
  if (firstChar === "\n") {
    return {
      status: "token",
      token: { type: "key", value: "newline", length: 1 },
    };
  }
  if (firstChar === "\t") {
    return { status: "token", token: { type: "key", value: "tab", length: 1 } };
  }
  if (first === 0x7f) {
    return {
      status: "token",
      token: { type: "key", value: "backspace", length: 1 },
    };
  }
  if (first < 0x20) {
    // 0x01–0x1a are ctrl+a…ctrl+z; the four above them spell ctrl+\ ] ^ /.
    const letter =
      first <= 0x1a
        ? String.fromCharCode(0x60 + first)
        : (["\\", "]", "^", "/"][first - 0x1c] ?? "");
    return {
      status: "token",
      token: { type: "key", value: `ctrl+${letter}`, length: 1 },
    };
  }

  let end = 0;
  while (end < buffer.length) {
    const code = buffer.charCodeAt(end);
    if (code < 0x20 || code === 0x7f || code === 0x1b) break;
    end += 1;
  }
  const text = buffer.slice(0, end);
  return {
    status: "token",
    token: { type: "text", value: text, length: end },
  };
}

const CSI_KEYS: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

/**
 * Control keys a Kitty-protocol terminal reports as `CSI <code> ; <mods> u`.
 * Only the keys the shell binds are named; every other code is decoded as the
 * character it denotes, so an unlisted key is still typed rather than dropped.
 */
const CSI_U_KEYS: Readonly<Record<number, string>> = {
  13: "enter",
  9: "tab",
  27: "escape",
  32: "space",
  127: "backspace",
};

const CSI_TILDE_KEYS: Readonly<Record<string, string>> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
};

/** `ESC [ <params> <final>` → canonical chord. Unknown forms resolve to "". */
function keyFromCsi(sequence: string, final: string): string {
  const params = sequence.startsWith("?") ? "" : sequence;
  if (final === "Z") return "shift+tab";
  const [base = "", modifierText] = params.split(";");
  if (final === "u") {
    // Kitty's CSI-u: a printable key or a control key with modifier bits.
    const code = Number.parseInt(base, 10);
    const named = CSI_U_KEYS[code];
    const modifier =
      modifierText === undefined ? 0 : Number.parseInt(modifierText, 10) - 1;
    if (named !== undefined) return `${modifierPrefix(modifier)}${named}`;
    if (Number.isFinite(code) && code >= 32 && code <= 0x10ffff) {
      const text = String.fromCodePoint(code).toLowerCase();
      return `${modifierPrefix(modifier)}${text}`;
    }
    return "";
  }
  const modifier =
    modifierText === undefined ? 0 : Number.parseInt(modifierText, 10) - 1;
  const prefix = modifierPrefix(modifier);
  if (final === "~") {
    const key = CSI_TILDE_KEYS[base];
    return key === undefined ? "" : `${prefix}${key}`;
  }
  const key = CSI_KEYS[final];
  return key === undefined ? "" : `${prefix}${key}`;
}

function modifierPrefix(modifier: number): string {
  if (!Number.isFinite(modifier) || modifier <= 0) return "";
  const shift = (modifier & 1) !== 0;
  const alt = (modifier & 2) !== 0;
  const ctrl = (modifier & 4) !== 0;
  return `${ctrl ? "ctrl+" : ""}${alt ? "alt+" : ""}${shift ? "shift+" : ""}`;
}

/** Canonical chord spelling for a tokenised event (Ink-style or synthetic). */
export function canonicalKeyOfEvent(event: KeyEventInput): string {
  const name = event.key;
  const alt = event.alt === true || event.meta === true;
  const ctrl = event.ctrl === true;
  const shift = event.shift === true ? "shift+" : "";
  const base =
    NAMED_EVENTS[name] ?? (name.length === 1 ? name.toLowerCase() : name);
  return `${ctrl ? "ctrl+" : ""}${alt ? "alt+" : ""}${shift}${base}`;
}

const NAMED_EVENTS: Readonly<Record<string, string>> = {
  return: "enter",
  enter: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  upArrow: "up",
  downArrow: "down",
  leftArrow: "left",
  rightArrow: "right",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

/* --------------------------------------------------------------- resolving -- */

/**
 * When the undecided bytes must be resolved, or `0` for "no timer" (a bracketed
 * paste frame in flight).
 */
function bufferExpiryMs(state: KeyState): number {
  const buffer = state.buffer;
  if (buffer.startsWith("\u001b[200~")) return 0;
  if (buffer.startsWith("\u001b[") || buffer.startsWith("\u001bO")) {
    return state.bufferSinceMs + TIMINGS.incompleteCsiMs;
  }
  const run = /^\u001b+/u.exec(buffer)?.[0].length ?? 1;
  const window =
    run > 1
      ? state.tmux
        ? TIMINGS.tmuxEscapeGraceMs
        : TIMINGS.escapeRunFlushMs
      : TIMINGS.escapeSequenceMs;
  return state.bufferSinceMs + window;
}

function tailAction(state: KeyState): KeyAction {
  return {
    kind: "pending",
    buffer: state.buffer,
    sinceMs: state.bufferSinceMs,
    deadlineMs: bufferExpiryMs(state),
  };
}

/** Resolve bytes whose window has closed: one press per ESC, CSI dropped. */
function expireBuffer(state: KeyState): KeyAction[] {
  if (/^\u001b+$/u.test(state.buffer)) {
    return Array.from({ length: state.buffer.length }, (): KeyAction => ({
      kind: "escape",
    }));
  }
  return [ignore];
}

function actionForKey(key: string, state: KeyState, nowMs: number): KeyAction {
  if (key === "ctrl+c") {
    if (
      state.ctrlCArmedUntilMs !== undefined &&
      nowMs <= state.ctrlCArmedUntilMs
    ) {
      return { kind: "quit" };
    }
    return {
      kind: "interrupt",
      armedUntilMs: nowMs + TIMINGS.doubleCtrlCWindowMs,
    };
  }
  if (state.suggestionsOpen) {
    switch (key) {
      case "up":
        return { kind: "completion", direction: "previous" };
      case "down":
        return { kind: "completion", direction: "next" };
      case "tab":
      case "enter":
        return { kind: "completion", direction: "accept" };
      case "escape":
        return { kind: "completion", direction: "cancel" };
      default:
        break;
    }
  }
  if (state.draftLength === 0) {
    if (key === "?") return { kind: "app", command: "open-help" };
    if (key === "!") return { kind: "app", command: "toggle-bash" };
    if (key === "left") {
      return { kind: "app", command: "open-droids-view" };
    }
  }
  if (key === "escape") return { kind: "escape" };
  const binding = BINDINGS_BY_KEY.get(key);
  return binding?.action ?? ignore;
}

/** Resolve one input chunk into every action it carries, plus the next state. */
export function resolveInput(
  input: KeyInput,
  state: KeyState,
  nowMs: number,
): KeyResolution {
  if (typeof input === "object" && !(input instanceof Uint8Array)) {
    const key = canonicalKeyOfEvent(input);
    return {
      actions: [actionForKey(key, state, nowMs)],
      state: { ...state, buffer: "", bufferSinceMs: 0 },
    };
  }
  const chunk =
    typeof input === "string"
      ? input
      : textDecoder.decode(input, { stream: true });
  // An unframed paste: one large chunk with no escape sequence in it. Nothing
  // a human types arrives this way, so the thresholds are safe at entry.
  if (
    state.buffer.length === 0 &&
    !chunk.includes("\u001b") &&
    (chunk.length > PASTE_MAX_CHARS ||
      chunk.split("\n").length > PASTE_MAX_LINES)
  ) {
    return {
      actions: [
        {
          kind: "paste",
          text: chunk,
          bracketed: false,
          guardUntilMs: nowMs + TIMINGS.pasteKeyGuardMs,
        },
      ],
      state: { ...state, buffer: "", bufferSinceMs: 0 },
    };
  }
  const text = state.buffer + chunk;
  const actions: KeyAction[] = [];
  let index = 0;
  // A chunk may hold more than one key; state one key changed (the `Ctrl+C`
  // arming window) must be visible to the next key in the same chunk.
  let current: KeyState = state;

  while (index < text.length) {
    const decoded = decodeToken(text.slice(index));
    if (decoded.status === "incomplete") {
      const carried = index < state.buffer.length;
      const nextState: KeyState = {
        ...current,
        buffer: text.slice(index),
        bufferSinceMs: carried ? state.bufferSinceMs : nowMs,
      };
      // Only the timer's own flush (an empty chunk) closes a window; new bytes
      // may still complete the sequence and must not race the deadline.
      const expiry = bufferExpiryMs(nextState);
      if (chunk.length === 0 && expiry !== 0 && nowMs >= expiry) {
        actions.push(...expireBuffer(nextState));
        return {
          actions,
          state: { ...nextState, buffer: "", bufferSinceMs: 0 },
        };
      }
      actions.push(tailAction(nextState));
      return { actions, state: nextState };
    }

    const token = decoded.token;
    const tokenStart = index;
    index += token.length;

    switch (token.type) {
      case "text": {
        if (token.value.length === 0) break;
        if (token.value.length === 1 && current.draftLength === 0) {
          const command = actionForKey(token.value, current, nowMs);
          if (command.kind === "app") {
            actions.push(command);
            break;
          }
        }
        actions.push({ kind: "insert", text: token.value });
        break;
      }
      case "escapeRun": {
        // One press per ESC byte, already past the lone-ESC window.
        const count = Number.parseInt(token.value, 10) || 1;
        for (let press = 0; press < count; press += 1) {
          actions.push({ kind: "escape" });
        }
        break;
      }
      case "pasteStart": {
        const end = text.indexOf("\u001b[201~", index);
        if (end < 0) {
          const nextState: KeyState = {
            ...current,
            buffer: text.slice(tokenStart),
            bufferSinceMs: nowMs,
          };
          return {
            actions: [
              ...actions,
              {
                kind: "pending",
                buffer: nextState.buffer,
                sinceMs: nowMs,
                deadlineMs: 0,
              },
            ],
            state: nextState,
          };
        }
        actions.push({
          kind: "paste",
          text: text.slice(index, end),
          bracketed: true,
          guardUntilMs: nowMs + TIMINGS.pasteKeyGuardMs,
        });
        index = end + "\u001b[201~".length;
        break;
      }
      case "pasteEnd":
        actions.push(ignore);
        break;
      case "key": {
        if (token.value.length === 0) {
          actions.push(ignore);
          break;
        }
        {
          const action = actionForKey(token.value, current, nowMs);
          actions.push(action);
          if (action.kind === "interrupt") {
            current = { ...current, ctrlCArmedUntilMs: action.armedUntilMs };
          }
        }
        break;
      }
    }
  }

  return { actions, state: { ...current, buffer: "", bufferSinceMs: 0 } };
}

/**
 * Resolve one key. A chunk carrying several keys yields the first action;
 * input wiring uses `resolveInput` so nothing is dropped.
 */
export function resolveKey(
  input: KeyInput,
  state: KeyState,
  nowMs: number,
): KeyAction {
  return resolveInput(input, state, nowMs).actions[0] ?? ignore;
}
