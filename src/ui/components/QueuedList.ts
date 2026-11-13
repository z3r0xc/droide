/**
 * The pending queued-message list (B10): the rows directly above the
 * mode/model row.
 *
 * Oldest first, one row per message: `<bar> <n>. <text>`, the bar in
 * `text.queuedSymbol` (`│` for a queued turn, `↳` for a steering line), the
 * position and text in `text.queuedText`, collapsed to one line and
 * tail-truncated to the row's width. At most three rows are printed; the
 * overflow row reads `... N more queued` in `text.muted`. An empty queue takes
 * no rows, so the idle frame is exactly the unqueued frame.
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import { truncateToWidth } from "../text.ts";
import { BORDERS, GLYPHS, foreground } from "../tokens.ts";

/** B10 — how many queued lines are printed before the overflow row. */
export const QUEUED_VISIBLE_ROWS = 3;

/** One queued line, as the shell paints it. */
export interface QueuedRow {
  /** 1-based position in the queue. */
  readonly position: number;
  readonly text: string;
  /** `steer` rides the next turn; `queue` starts one when the current ends. */
  readonly mode: "steer" | "queue";
}

export interface QueuedListProps {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly rows: readonly QueuedRow[];
}

/** Rows the list occupies; 0 when the queue is empty. */
export function queuedListHeight(rows: readonly QueuedRow[]): number {
  if (rows.length === 0) return 0;
  const visible = Math.min(rows.length, QUEUED_VISIBLE_ROWS);
  return visible + (rows.length > QUEUED_VISIBLE_ROWS ? 1 : 0);
}

export function QueuedList(props: QueuedListProps): ReactNode {
  const { capabilities, width, rows } = props;
  if (rows.length === 0) return null;
  const visible = rows.slice(0, QUEUED_VISIBLE_ROWS);
  const hidden = rows.length - visible.length;
  const bodyWidth = Math.max(1, width - 2);

  return h(
    Box,
    { flexDirection: "column", width },
    ...visible.map((row) =>
      h(
        Box,
        {
          key: `queued-${String(row.position)}`,
          width,
          flexDirection: "row",
        },
        h(
          Text,
          { ...foreground("text.queuedSymbol", capabilities) },
          `${row.mode === "steer" ? GLYPHS.resultPrefix : BORDERS.round.vertical} `,
        ),
        h(
          Text,
          {
            ...foreground("text.queuedText", capabilities),
            wrap: "truncate-end",
          },
          truncateToWidth(
            `${String(row.position)}. ${row.text.replace(/\s+/gu, " ").trim()}`,
            bodyWidth,
          ),
        ),
      ),
    ),
    hidden === 0
      ? null
      : h(
          Text,
          {
            ...foreground("text.muted", capabilities),
            wrap: "truncate-end",
          },
          truncateToWidth(
            `  ${GLYPHS.ellipsisAscii} ${String(hidden)} more queued`,
            width,
          ),
        ),
  );
}
