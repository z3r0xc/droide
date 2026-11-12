/**
 * Transcript region (B2, B5): the three item renderers of this vertical —
 * user message (R1), assistant text (R2) and tool call + result (R4, R5).
 *
 * Every other item kind normalises away in `toTranscriptItem` and renders
 * nothing. The transcript is not height-capped here: the static/dynamic split,
 * the bottom-anchored live tail and its hidden-lines header (B4) belong to the
 * streaming slice, and capping a live Ink tree would clip rendered rows.
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import { INTERRUPTED, toolMoreLines } from "../strings.ts";
import { GLYPHS, SPACING, background, foreground } from "../tokens.ts";
import {
  clampParamValue,
  previewResult,
  toTranscriptItem,
  type ToolTranscriptItem,
  type TranscriptEntry,
  type UserTranscriptItem,
} from "../transcript.ts";

export interface TranscriptProps {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly entries: readonly TranscriptEntry[];
}

/** `contentWidth = max(1, terminalWidth - 6)` (B2). */
export function transcriptContentWidth(width: number): number {
  return Math.max(1, width - SPACING.transcriptInset);
}

function renderUser(
  item: UserTranscriptItem,
  contentWidth: number,
  capabilities: Capabilities,
  key: string,
): ReactNode {
  const bubble = background("text.userBg", capabilities);
  const text = foreground("text.userText", capabilities);
  return h(
    Box,
    { key, flexDirection: "row", width: contentWidth, marginBottom: 1 },
    h(Text, { key: "bar", ...bubble }, " "),
    h(
      Box,
      { key: "body", width: Math.max(1, contentWidth - SPACING.userBarWidth) },
      h(Text, { key: "text", ...bubble, ...text }, `  ${item.text} `),
    ),
  );
}

function renderAssistant(
  item: { readonly text: string },
  contentWidth: number,
  capabilities: Capabilities,
  key: string,
): ReactNode {
  const marker = foreground("primary", capabilities);
  const bold = capabilities.style ? { bold: true } : {};
  return h(
    Box,
    { key, flexDirection: "row", width: contentWidth, marginBottom: 1 },
    h(Text, { key: "marker", ...marker, ...bold }, GLYPHS.assistantMarker),
    h(Text, { key: "gap" }, " ".repeat(SPACING.assistantGap)),
    h(
      Box,
      {
        key: "body",
        width: Math.max(1, contentWidth - 1 - SPACING.assistantGap),
      },
      h(
        Text,
        { key: "text", ...foreground("text.primary", capabilities) },
        item.text,
      ),
    ),
  );
}

function renderToolResult(
  item: ToolTranscriptItem,
  capabilities: Capabilities,
): ReactNode[] {
  const indent = SPACING.toolResultIndent;
  if (item.interrupted) {
    return [
      h(
        Text,
        { key: "interrupted", ...foreground("text.muted", capabilities) },
        " ".repeat(indent) + `${GLYPHS.interrupted} ${INTERRUPTED}`,
      ),
    ];
  }
  if (item.result === undefined || item.result.length === 0) return [];
  const preview = previewResult(item.result);
  const color = foreground(
    item.state === "error" ? "error" : "text.muted",
    capabilities,
  );
  const rows: ReactNode[] = preview.lines.map((line, index) =>
    h(
      Text,
      { key: `line-${index}`, ...color },
      " ".repeat(indent) +
        (index === 0 ? `${GLYPHS.resultPrefix} ` : "  ") +
        line,
    ),
  );
  if (preview.hidden > 0) {
    rows.push(
      h(
        Text,
        { key: "more", ...foreground("text.muted", capabilities) },
        " ".repeat(indent) + toolMoreLines(preview.hidden),
      ),
    );
  }
  return rows;
}

function renderTool(
  item: ToolTranscriptItem,
  contentWidth: number,
  capabilities: Capabilities,
  key: string,
): ReactNode {
  const headerWidth = Math.max(20, contentWidth - SPACING.toolRowMargin);
  const name = foreground("toolName", capabilities);
  const bold = capabilities.style ? { bold: true } : {};
  const paramColor = foreground("toolParam", capabilities);
  const suffixColor = foreground("text.muted", capabilities);

  const params: ReactNode[] = item.params.map(([paramKey, value], index) =>
    h(
      Text,
      { key: `param-${index}`, ...paramColor },
      `, ${paramKey}: "${clampParamValue(value)}"`,
    ),
  );

  const suffix: ReactNode[] =
    item.suffix === undefined
      ? []
      : [
          h(Box, { key: "spacer", flexGrow: 1, height: 1 }),
          h(Text, { key: "suffix", ...suffixColor }, item.suffix),
        ];

  return h(
    Box,
    { key, flexDirection: "column", width: contentWidth, marginBottom: 1 },
    h(
      Box,
      {
        key: "header",
        flexDirection: "row",
        width: headerWidth,
        marginLeft: SPACING.toolRowMargin,
      },
      h(Text, { key: "name", ...name, ...bold }, item.name),
      ...params,
      ...suffix,
    ),
    ...renderToolResult(item, capabilities),
  );
}

export function Transcript(props: TranscriptProps): ReactNode {
  const { capabilities, width, entries } = props;
  const contentWidth = transcriptContentWidth(width);

  const rendered: ReactNode[] = [];
  for (const [index, entry] of entries.entries()) {
    const item = toTranscriptItem(entry);
    if (item === undefined) continue;
    const key = `item-${index}`;
    if (item.kind === "user") {
      rendered.push(renderUser(item, contentWidth, capabilities, key));
    } else if (item.kind === "assistant") {
      rendered.push(renderAssistant(item, contentWidth, capabilities, key));
    } else {
      rendered.push(renderTool(item, contentWidth, capabilities, key));
    }
  }
  if (rendered.length === 0) return null;

  return h(Box, { flexDirection: "column", width }, ...rendered);
}

/** The widest a transcript row may be, exported for the frame assertions. */
export function transcriptRowLimit(width: number): number {
  return Math.min(width, transcriptContentWidth(width));
}
