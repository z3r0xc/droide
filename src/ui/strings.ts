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

/** B3 — version row prefix (`v1.9.0`). */
export const VERSION_PREFIX = "v";

/** B3 — tip row prefix. */
export const TIP_PREFIX = "TIP: ";

/** B10 — the pinned startup placeholder used by the 80×24 reference frame. */
export const STARTUP_PLACEHOLDER =
  'Try "How do I handle errors in async functions?"';

/** D1 — the default mode/autonomy row (autonomy off). */
export const MODE_ROW_AUTONOMY_OFF = "Auto (Off) · all actions require approval";

/** B13 — footer primary label. */
export const FOOTER_HELP = `${GLYPHS.help} for help`;

/** B7 — truncation notice in the collapsed tool preview. */
export function toolMoreLines(lines: number): string {
  return (
    `${GLYPHS.ellipsisAscii} ${lines} more ` +
    `lines, press Ctrl+O to expand`
  );
}

/** B7 — detailed-view truncation notice. */
export function toolShowingFirst(shown: number, total: number): string {
  return `${GLYPHS.resultPrefix} showing first ${shown}/${total} lines`;
}

/** B6 — aborted invocation notice body (the glyph is added by the renderer). */
export const INTERRUPTED = "Interrupted";

/** B4 — clipped live-tail header (pluralised like the locale bundle). */
export function hiddenLines(lines: number): string {
  const noun = lines === 1 ? "line" : "lines";
  return `---- ${lines} more ${noun} hidden ----`;
}

/** R7 — suffix for a failed call inside a collapsed group. */
export const TOOL_ERROR_SUFFIX = "(error)";