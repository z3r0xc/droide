/**
 * Transcript region (B2, B5): the item renderers of this vertical — user
 * message (R1), assistant text (R2), tool call + result (R4, R5), the approval
 * prompt (R11) and the system notice (R12).
 *
 * Every other item kind normalises away in `toTranscriptItem` and renders
 * nothing. The transcript is not height-capped here: the static/dynamic split,
 * the bottom-anchored live tail and its hidden-lines header (B4) belong to the
 * streaming slice, and capping a live Ink tree would clip rendered rows.
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import { truncateToWidth } from "../text.ts";
import {
  APPROVAL_DECISION_TEXTS,
  APPROVAL_HELP,
  APPROVAL_TITLE,
  INTERRUPTED,
  toolMoreLines,
} from "../strings.ts";
import { GLYPHS, SPACING, background, foreground } from "../tokens.ts";
import {
  clampParamValue,
  previewResult,
  toTranscriptItem,
  type ApprovalTranscriptItem,
  type NoticeTranscriptItem,
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

/**
 * R11 — the approval prompt: one header row naming the tool, one dimmed summary
 * row, the options (selected bold in `text.primary`, the rest muted) and one
 * help row. A decided prompt keeps only the header, with its outcome.
 */
function renderApproval(
  item: ApprovalTranscriptItem,
  contentWidth: number,
  capabilities: Capabilities,
  key: string,
): ReactNode {
  const bold = capabilities.style ? { bold: true } : {};
  const outcome =
    item.decision === undefined
      ? ""
      : ` ${GLYPHS.separator} ${APPROVAL_DECISION_TEXTS[item.decision]}`;
  const header = `${GLYPHS.toolMarker} ${APPROVAL_TITLE} ${GLYPHS.separator} ${item.toolName}${outcome}`;
  const rows: ReactNode[] = [
    h(
      Text,
      {
        key: "header",
        ...foreground(
          item.decision === "deny" ? "error" : "text.primary",
          capabilities,
        ),
        ...bold,
      },
      truncateToWidth(header, contentWidth, GLYPHS.ellipsis),
    ),
  ];
  if (item.summary.length > 0) {
    rows.push(
      h(
        Text,
        { key: "summary", ...foreground("text.muted", capabilities) },
        truncateToWidth(`  ${item.summary}`, contentWidth, GLYPHS.ellipsis),
      ),
    );
  }
  if (item.decision === undefined) {
    for (const [index, option] of item.options.entries()) {
      const selected = index === item.selected;
      const prefix = selected ? `${GLYPHS.selected} ` : "  ";
      rows.push(
        h(
          Text,
          {
            key: `option-${index}`,
            ...foreground(
              selected ? "text.primary" : "text.muted",
              capabilities,
            ),
            ...(selected ? bold : {}),
          },
          truncateToWidth(
            `${prefix}${option.label}`,
            contentWidth,
            GLYPHS.ellipsis,
          ),
        ),
      );
    }
    rows.push(
      h(
        Text,
        { key: "help", ...foreground("text.muted", capabilities) },
        truncateToWidth(`  ${APPROVAL_HELP}`, contentWidth, GLYPHS.ellipsis),
      ),
    );
  }
  return h(
    Box,
    { key, flexDirection: "column", width: contentWidth, marginBottom: 1 },
    ...rows,
  );
}

/** R12 — a system notice: `● ` then the body, errors in `error`. */
function renderNotice(
  item: NoticeTranscriptItem,
  contentWidth: number,
  capabilities: Capabilities,
  key: string,
): ReactNode {
  return h(
    Box,
    { key, flexDirection: "row", width: contentWidth, marginBottom: 1 },
    h(
      Text,
      {
        ...foreground(
          item.text.startsWith("Error:") ? "error" : "text.muted",
          capabilities,
        ),
      },
      truncateToWidth(
        `${GLYPHS.toolMarker} ${item.text}`,
        contentWidth,
        GLYPHS.ellipsis,
      ),
    ),
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
    } else if (item.kind === "tool") {
      rendered.push(renderTool(item, contentWidth, capabilities, key));
    } else if (item.kind === "approval") {
      rendered.push(renderApproval(item, contentWidth, capabilities, key));
    } else {
      rendered.push(renderNotice(item, contentWidth, capabilities, key));
    }
  }
  if (rendered.length === 0) return null;

  return h(Box, { flexDirection: "column", width }, ...rendered);
}

/** The widest a transcript row may be, exported for the frame assertions. */
export function transcriptRowLimit(width: number): number {
  return Math.min(width, transcriptContentWidth(width));
}
