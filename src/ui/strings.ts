/**
 * English strings owned by the terminal shell.
 *
 * The spec pins these literally (B3, B7, B13, R5). Everything else the surface
 * prints arrives as props from its owner, so which random tip or placeholder a
 * launch shows is not baked into a component.
 */

import { GLYPHS } from "./tokens.ts";

/** B3 — header status labels, in row order. */
export const HEADER_STATUS_LABELS = {
  skills: "Skills",
  mcps: "MCPs",
  connectors: "Connectors",
  agentsMd: "AGENTS.md",
} as const;

/** B3 — the two centred shortcut rows. */
export const HEADER_SHORTCUTS = [
  "shift+tab to cycle modes · ctrl+N to cycle models",
  "ctrl+L for autonomy · tab for reasoning",
] as const;

/** B3 — version row prefix (`v`, as in `v1.2.3`). */
export const VERSION_PREFIX = "v";

/** B3 — tip row prefix. */
export const TIP_PREFIX = "TIP: ";

/** B10 — the pinned startup placeholder used by the 80×24 reference frame. */
export const STARTUP_PLACEHOLDER =
  'Try "How do I handle errors in async functions?"';

/** D1 — the default mode/autonomy row (autonomy off). */
export const MODE_ROW_AUTONOMY_OFF =
  "Auto (Off) · all actions require approval";

/** B13 — footer primary label. */
export const FOOTER_HELP = `${GLYPHS.help} for help`;

/** B13 — separator between footer blocks and hint segments. */
export const BLOCK_SEPARATOR = " | ";

/** B7 — truncation notice in the collapsed tool preview. */
export function toolMoreLines(lines: number): string {
  return `${GLYPHS.ellipsisAscii} ${lines} more lines, press Ctrl+O to expand`;
}

/** B6 — aborted invocation notice body (the glyph is added by the renderer). */
export const INTERRUPTED = "Interrupted";

/** B12 — the status texts a running turn shows, in the spec's exact wording. */
export const STATUS_TEXTS = {
  thinking: "Thinking...",
  streaming: "Streaming...",
  invoking: "Invoking tools...",
  confirmation: "Waiting for tool confirmation...",
  cancelling: "Cancelling tools...",
} as const;

/** B12 — the stop hint appended to a running status. */
export const STOP_HINT = "(Press ESC to stop)";

/** Compose one status-line row: the status then the stop hint. */
export function withStopHint(text: string): string {
  return `${text}  ${STOP_HINT}`;
}

/** R11 — the approval row's header word. */
export const APPROVAL_TITLE = "Approval";

/** R11 — the one-row help line under the options. */
export const APPROVAL_HELP = `${GLYPHS.arrowUp}${GLYPHS.arrowDown} navigate ${GLYPHS.separator} Enter select ${GLYPHS.separator} Esc cancel`;

/** R11 — the three options, in the recorded order. */
export const APPROVAL_OPTION_LABELS = {
  once: "Yes, allow",
  session: "Yes, and always allow this session",
  deny: "No, cancel",
} as const;

/** R11 — how a decided approval reads in place of the options. */
export const APPROVAL_DECISION_TEXTS = {
  once: "allowed",
  session: "allowed for the rest of the session",
  deny: "denied",
} as const;

/** B10 — the notice a submit at the queue's bound appends (the draft stays). */
export function queuedFullNotice(bound: number): string {
  return `The queue is full (${String(bound)} messages). Press Esc to cancel the turn and clear the queue.`;
}

/** B12/R? — the notice a cancelled or failed turn appends. */
export const TURN_CANCELLED = "Cancelled";
