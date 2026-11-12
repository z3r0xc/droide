/**
 * Composer (B10): the input frame, wrapped draft rows and one optional hint row.
 *
 * Frame variants: Windows-like hosts draw no border (paddingX 1, paddingY 1);
 * every other host draws the `round` frame (paddingX 1, paddingY 0), dimmed
 * while unfocused. A named mode replaces the top border with the mode label.
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import {
  displayWidth,
  splitLines,
  truncateToWidth,
  windowLines,
} from "../text.ts";
import {
  BORDERS,
  GLYPHS,
  SPACING,
  foreground,
  type PaletteSlot,
} from "../tokens.ts";

export type ComposerMode = "chat" | "bash" | "bash-executing";

/** Everything the composer prints, owned by the caller (B10). */
export interface ComposerContent {
  readonly draft: string;
  readonly placeholder: string;
  readonly focused: boolean;
  readonly mode?: ComposerMode;
  readonly hint?: string;
  /** Spec/mission mode label drawn into the top border, with its colour slot. */
  readonly modeLabel?: string;
  readonly modeTitle?: string;
  readonly modeSlot?: PaletteSlot;
  readonly cursorLine?: number;
}

export interface ComposerProps {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly height: number;
  readonly content: ComposerContent;
}

/**
 * Visible draft rows (B10):
 * `viewportRows = max(3, min(height - 10, floor(height * (focused ? .33 : .9))))`,
 * minus the two border rows.
 */
export function resolveComposerVisibleRows(
  height: number,
  focused: boolean,
): number {
  const hard = height - 8 - 2;
  const ratio = Math.floor(height * (focused ? 0.33 : 0.9));
  const viewport = Math.max(3, Math.min(hard, ratio));
  return Math.max(1, viewport - 2);
}

function draftLineCount(draft: string): number {
  return Math.max(1, splitLines(draft).length);
}

/** Rows the composer occupies, borders and hint included. */
export function composerHeight(
  height: number,
  content: ComposerContent,
): number {
  const visible = Math.min(
    resolveComposerVisibleRows(height, content.focused),
    draftLineCount(content.draft),
  );
  return 2 + Math.max(1, visible) + (content.hint === undefined ? 0 : 1);
}

/**
 * The mode top border (B10): `╭── <label> · <title> ` then fill then `╮`,
 * degrading to `╭╮` at width 2 and `╭` at width 1.
 */
export function buildModeBorder(
  label: string,
  title: string | undefined,
  width: number,
): string {
  const { topLeft, topRight, horizontal } = BORDERS.round;
  if (width <= 1) return topLeft;
  if (width === 2) return `${topLeft}${topRight}`;
  const withTitle =
    title === undefined
      ? ` ${label} `
      : ` ${label} ${GLYPHS.separator} ${title} `;
  const candidates =
    title === undefined
      ? [`${topLeft}${horizontal}${horizontal}${withTitle}`]
      : [
          `${topLeft}${horizontal}${horizontal}${withTitle}`,
          `${topLeft}${horizontal}${horizontal} ${label} `,
        ];
  for (const candidate of candidates) {
    const used = displayWidth(candidate);
    if (used + 1 <= width) {
      return `${candidate}${horizontal.repeat(width - used - 1)}${topRight}`;
    }
  }
  return `${topLeft}${horizontal.repeat(width - 2)}${topRight}`;
}

function promptFor(mode: ComposerMode): string {
  switch (mode) {
    case "bash":
      return ` ${GLYPHS.bashMode} `;
    case "bash-executing":
      return ` ${GLYPHS.bashExecuting} `;
    case "chat":
      return `${GLYPHS.userMarker} `;
  }
}

function renderDraft(
  capabilities: Capabilities,
  content: ComposerContent,
  visibleRows: number,
): ReactNode[] {
  const mode = content.mode ?? "chat";
  const prompt = promptFor(mode);
  const promptColor = foreground(
    mode === "chat" ? "primary" : "success",
    capabilities,
  );
  const draftLines = splitLines(content.draft);
  const cursor = content.cursorLine ?? draftLines.length - 1;
  const windowed = windowLines(draftLines, visibleRows, cursor);
  const empty = content.draft.length === 0;

  return windowed.map((line, index) => {
    const lead = index === 0 ? prompt : "  ";
    const body = empty && index === 0 ? content.placeholder : line.text;
    const textProps = empty
      ? {
          ...foreground("text.muted", capabilities),
          dimColor: capabilities.style,
        }
      : foreground("text.primary", capabilities);
    return h(
      Text,
      {
        key: `draft-${index}`,
        ...(line.indicator && capabilities.style ? { dimColor: true } : {}),
      },
      h(Text, { key: "prompt", ...promptColor }, lead),
      h(Text, { key: "body", ...textProps }, body),
    );
  });
}

export function Composer(props: ComposerProps): ReactNode {
  const { capabilities, width, height, content } = props;
  const visibleRows = resolveComposerVisibleRows(height, content.focused);
  const windowedRows = Math.min(
    visibleRows,
    Math.max(1, draftLineCount(content.draft)),
  );
  const draft = renderDraft(capabilities, content, windowedRows);

  const hint =
    content.hint === undefined
      ? null
      : h(
          Text,
          {
            key: "hint",
            ...foreground("text.muted", capabilities),
            dimColor: capabilities.style,
            wrap: "truncate-end",
          },
          `  ${truncateToWidth(content.hint, Math.max(0, width - 2))}`,
        );

  if (capabilities.platform === "windows") {
    return h(
      Box,
      { flexDirection: "column", width },
      h(
        Box,
        {
          flexDirection: "column",
          width,
          paddingX: SPACING.composerPaddingX,
          paddingY: SPACING.composerPaddingYWindows,
        },
        ...draft,
      ),
      hint,
    );
  }

  const border = BORDERS.round;
  const borderColor = foreground("border", capabilities);
  const dim = !content.focused && capabilities.style;
  const top =
    content.modeLabel === undefined
      ? `${border.topLeft}${border.horizontal.repeat(Math.max(0, width - 2))}${border.topRight}`
      : buildModeBorder(content.modeLabel, content.modeTitle, width);
  const topColor =
    content.modeSlot === undefined
      ? borderColor
      : foreground(content.modeSlot, capabilities);

  return h(
    Box,
    { flexDirection: "column", width },
    h(
      Text,
      { key: "top", ...topColor, dimColor: dim },
      truncateToWidth(top, width, ""),
    ),
    h(
      Box,
      { key: "body", flexDirection: "row", width },
      h(Text, { key: "left", ...borderColor, dimColor: dim }, border.vertical),
      h(
        Box,
        {
          key: "inner",
          width: Math.max(1, width - 2),
          paddingX: SPACING.composerPaddingX,
          flexDirection: "column",
        },
        ...draft,
      ),
      h(Text, { key: "right", ...borderColor, dimColor: dim }, border.vertical),
    ),
    h(
      Text,
      { key: "bottom", ...borderColor, dimColor: dim },
      `${border.bottomLeft}${border.horizontal.repeat(Math.max(0, width - 2))}${border.bottomRight}`,
    ),
    hint,
  );
}
