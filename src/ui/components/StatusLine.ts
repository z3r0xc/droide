/**
 * Configurable status line (B14): 1–3 dimmed rows below the footer, wrapped to
 * `width - 2*padding`, padded on both sides and middle-truncated.
 * With no configuration, or no output, the region takes no rows.
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import { splitLines, truncateToWidth } from "../text.ts";
import { GLYPHS, foreground } from "../tokens.ts";

export interface StatusLineContent {
  readonly text: string;
  /** Left/right padding in cells; default 0. */
  readonly padding?: number;
  /** 1–3 rows; default 1. */
  readonly maxRows?: number;
}

export interface StatusLineProps {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly content: StatusLineContent | undefined;
}

function resolveMaxRows(content: StatusLineContent): number {
  const requested = content.maxRows ?? 1;
  return Math.min(3, Math.max(1, requested));
}

function resolvePadding(content: StatusLineContent): number {
  return Math.max(0, content.padding ?? 0);
}

/** Rows the status line occupies. */
export function statusLineHeight(
  width: number,
  content: StatusLineContent | undefined,
): number {
  if (content === undefined) return 0;
  const lines = splitLines(content.text).filter((line) => line.length > 0);
  return Math.min(resolveMaxRows(content), lines.length);
}

export function StatusLine(props: StatusLineProps): ReactNode {
  const { capabilities, width, content } = props;
  if (content === undefined) return null;
  const rows = statusLineHeight(width, content);
  if (rows === 0) return null;
  const padding = resolvePadding(content);
  const innerWidth = Math.max(1, width - padding * 2);
  const lines = splitLines(content.text)
    .filter((line) => line.length > 0)
    .slice(0, rows);

  return h(
    Box,
    { flexDirection: "column", width, paddingX: padding },
    ...lines.map((line, index) =>
      h(
        Box,
        { key: `line-${index}`, width: innerWidth },
        h(
          Text,
          {
            ...foreground("text.muted", capabilities),
            dimColor: capabilities.style,
            wrap: "truncate-middle",
          },
          truncateToWidth(line, innerWidth, GLYPHS.ellipsis),
        ),
      ),
    ),
  );
}
