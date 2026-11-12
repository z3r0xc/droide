/**
 * Display-width helpers (spec B20).
 *
 * Widths are counted in terminal cells over grapheme clusters, so a double-width
 * glyph occupies two columns and a cluster is never split by truncation. The
 * East-Asian width table is a compact approximation of the Unicode wide ranges;
 * it is enough for the shell's own strings and is replaced wholesale when the
 * sanitisation slice lands.
 */

import { GLYPHS } from "./tokens.ts";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xff6f],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

function codePointWidth(codePoint: number): number {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return 2;
  }
  return 1;
}

/** Width of one grapheme cluster in terminal cells. */
export function clusterWidth(cluster: string): number {
  let width = 0;
  for (const character of cluster) {
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}

/** Width of a string in display cells. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    width += clusterWidth(segment);
  }
  return width;
}

/**
 * Clamp a string to `width` display cells. A clamped string ends in the
 * spec's single-cell ellipsis, which is included in the returned width.
 */
export function truncateToWidth(
  text: string,
  width: number,
  ellipsis: string = GLYPHS.ellipsis,
): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const ellipsisWidth = displayWidth(ellipsis);
  const budget = Math.max(0, width - ellipsisWidth);
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const segmentWidth = clusterWidth(segment);
    if (used + segmentWidth > budget) break;
    result += segment;
    used += segmentWidth;
  }
  return `${result}${ellipsis}`;
}

/** Split a text block into physical lines, normalising CRLF. */
export function splitLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

/** One visible composer row, and whether it is a scroll indicator. */
export interface WindowedLine {
  readonly text: string;
  readonly indicator: boolean;
}

/**
 * Bottom-anchored window over the draft lines (B10): the cursor stays visible,
 * and hidden rows above/below become `↑ N more` / `↓ N more`.
 */
export function windowLines(
  lines: readonly string[],
  visibleRows: number,
  cursorLine: number,
): WindowedLine[] {
  const rows = Math.max(1, visibleRows);
  if (lines.length <= rows) {
    return lines.map((text) => ({ text, indicator: false }));
  }
  const cursor = Math.min(Math.max(cursorLine, 0), lines.length - 1);
  let start = Math.max(0, cursor - rows + 1);
  start = Math.min(start, lines.length - rows);
  const end = start + rows;
  const windowed: WindowedLine[] = [];
  if (start > 0) {
    windowed.push({ text: `${GLYPHS.arrowUp} ${start} more`, indicator: true });
  }
  const contentStart = start > 0 ? start + 1 : start;
  for (let index = contentStart; index < end && index < lines.length; index += 1) {
    windowed.push({ text: lines[index] ?? "", indicator: false });
  }
  const hiddenBelow = lines.length - end;
  if (hiddenBelow > 0) {
    windowed.push({ text: `${GLYPHS.arrowDown} ${hiddenBelow} more`, indicator: true });
  }
  return windowed.slice(0, rows);
}