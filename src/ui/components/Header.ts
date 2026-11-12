/**
 * Header (B3): logo, version, tip, shortcuts and the status row, painted once
 * above the transcript. Geometry is expressed in explicit rows so the shell can
 * budget the transcript region without measuring React output.
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import { displayWidth, truncateToWidth } from "../text.ts";
import {
  BORDERS,
  GLYPHS,
  LOGO_FULL_ROWS,
  LOGO_MINI_ROWS,
  LOGO_MINI_WIDTH,
  SPACING,
  foreground,
} from "../tokens.ts";
import { TIP_PREFIX, VERSION_PREFIX } from "../strings.ts";

/** `COMPACT_HEADER_MAX_HEIGHT` (B3). */
export const COMPACT_HEADER_MAX_HEIGHT = 24;

/** Width at which the changelog column appears (B3). */
export const CHANGELOG_MIN_WIDTH = 100;

/** Left column width at which the full logo is used (B3). */
export const FULL_LOGO_MIN_WIDTH = 58;

/** One header status item: `Skills (3) ✓`, or `AGENTS.md ✗`. */
export interface HeaderStatus {
  readonly label: string;
  readonly count: number | undefined;
  readonly ok: boolean;
}

/** Everything the header prints, owned by the caller (B3). */
export interface HeaderContent {
  readonly version: string;
  readonly tip: string;
  readonly statuses: readonly HeaderStatus[];
  readonly shortcuts: readonly string[];
  readonly changelog?: readonly string[];
  readonly dev?: boolean;
}

export interface HeaderProps {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly height: number;
  readonly content: HeaderContent;
}

/** Whether a frame of this size carries the changelog column and full logo. */
export interface HeaderGeometry {
  readonly compact: boolean;
  readonly changelog: boolean;
  readonly leftColWidth: number;
  readonly logoRows: readonly string[];
  readonly logoWidth: number;
}

/** Resolve the header grid for a terminal size (B3). */
export function headerGeometry(
  width: number,
  height: number,
  content: HeaderContent,
): HeaderGeometry {
  const compact = height <= COMPACT_HEADER_MAX_HEIGHT;
  const changelog =
    width >= CHANGELOG_MIN_WIDTH && (content.changelog?.length ?? 0) > 0;
  const leftColWidth = changelog ? Math.floor(width * 0.55) : width;
  const full = !compact && leftColWidth >= FULL_LOGO_MIN_WIDTH;
  const logoRows = full ? LOGO_FULL_ROWS : LOGO_MINI_ROWS;
  const logoWidth = full
    ? logoRows.reduce((widest, row) => Math.max(widest, displayWidth(row)), 0)
    : LOGO_MINI_WIDTH;
  return { compact, changelog, leftColWidth, logoRows, logoWidth };
}

/** Rows the header occupies, margins included. Used to size the transcript. */
export function headerHeight(
  width: number,
  height: number,
  content: HeaderContent,
): number {
  const { compact, logoRows } = headerGeometry(width, height, content);
  const topMargin = compact ? 0 : SPACING.headerLeftMargin;
  const dev = content.dev === true ? 1 : 0;
  // logo, blank, [DEV], version, blank, tip, blank, two shortcuts, blank, status
  return topMargin + logoRows.length + 9 + dev;
}

function centeredRow(
  leftColWidth: number,
  offset: number,
  node: ReactNode,
  key: string,
): ReactNode {
  return h(
    Box,
    { key, width: leftColWidth, paddingLeft: Math.max(0, offset) },
    node,
  );
}

function blankLeft(leftColWidth: number, key: string): ReactNode {
  return h(Box, { key, width: leftColWidth, height: 1 });
}

export function Header(props: HeaderProps): ReactNode {
  const { capabilities, width, height, content } = props;
  const { compact, changelog, leftColWidth, logoRows, logoWidth } =
    headerGeometry(width, height, content);
  const topMargin = compact ? 0 : SPACING.headerLeftMargin;
  const logoCol = Math.floor((leftColWidth - logoWidth) / 2);
  const rightWidth = Math.max(0, width - leftColWidth - 1);
  const muted = foreground("text.muted", capabilities);
  const secondary = foreground("text.secondary", capabilities);
  const logo = foreground("headerLogo", capabilities);
  const art = foreground("asciiArt", capabilities);
  const okColor = foreground("statusActive", capabilities);
  const errorColor = foreground("error", capabilities);
  const bold = capabilities.style ? { bold: true } : {};

  const underLogo = (textWidth: number): number =>
    Math.min(
      Math.max(0, logoCol + Math.floor((logoWidth - textWidth) / 2)),
      Math.max(0, leftColWidth - textWidth),
    );

  const rows: ReactNode[] = [];
  for (let index = 0; index < topMargin; index += 1) {
    rows.push(blankLeft(leftColWidth, `top-${index}`));
  }

  for (const [index, row] of logoRows.entries()) {
    rows.push(
      centeredRow(
        leftColWidth,
        logoCol,
        h(Text, { key: "logo", ...logo }, row.trimEnd()),
        `logo-${index}`,
      ),
    );
  }

  rows.push(blankLeft(leftColWidth, "gap-after-logo"));

  if (content.dev === true) {
    rows.push(
      centeredRow(
        leftColWidth,
        underLogo(displayWidth(GLYPHS.devTag)),
        h(Text, { key: "dev", ...art, ...bold }, GLYPHS.devTag),
        "dev",
      ),
    );
  }

  const version = `${VERSION_PREFIX}${content.version}`;
  rows.push(
    centeredRow(
      leftColWidth,
      underLogo(displayWidth(version)),
      h(Text, { key: "version", ...secondary, ...bold }, version),
      "version",
    ),
  );

  rows.push(blankLeft(leftColWidth, "gap-after-version"));

  const tipLimit = Math.max(0, leftColWidth - 4);
  const tip = truncateToWidth(`${TIP_PREFIX}${content.tip}`, tipLimit);
  rows.push(
    centeredRow(
      leftColWidth,
      underLogo(displayWidth(tip)),
      h(Text, { key: "tip", ...muted }, tip),
      "tip",
    ),
  );

  rows.push(blankLeft(leftColWidth, "gap-after-tip"));

  for (const [index, shortcut] of content.shortcuts.entries()) {
    const line = truncateToWidth(shortcut, leftColWidth);
    rows.push(
      centeredRow(
        leftColWidth,
        underLogo(displayWidth(line)),
        h(Text, { key: `shortcut-${index}`, ...muted }, line),
        `shortcut-${index}`,
      ),
    );
  }

  rows.push(blankLeft(leftColWidth, "gap-after-shortcuts"));

  const statusChildren: ReactNode[] = [];
  for (const [index, status] of content.statuses.entries()) {
    if (index > 0) {
      statusChildren.push(h(Text, { key: `space-${index}` }, "  "));
    }
    const count =
      status.count === undefined ? "" : ` (${String(status.count)})`;
    statusChildren.push(
      h(
        Text,
        { key: `label-${index}`, ...secondary },
        `${status.label}${count} `,
      ),
    );
    statusChildren.push(
      h(
        Text,
        { key: `mark-${index}`, ...(status.ok ? okColor : errorColor) },
        status.ok ? GLYPHS.statusOk : GLYPHS.statusMissing,
      ),
    );
  }
  rows.push(
    h(
      Box,
      { key: "status", width: leftColWidth, flexDirection: "row" },
      h(Text, { key: "status-line" }, statusChildren),
    ),
  );

  const headerColumn = h(
    Box,
    { flexDirection: "column", width },
    rows.map((row, index) => {
      const right = changelog
        ? content.changelog?.[index - topMargin]
        : undefined;
      return h(
        Box,
        { key: `row-${index}`, flexDirection: "row", width },
        row,
        right === undefined
          ? null
          : h(Text, { key: "divider", ...art }, BORDERS.changelogDivider),
        right === undefined
          ? null
          : h(
              Box,
              { key: "changelog", width: rightWidth, paddingLeft: 1 },
              h(Text, { key: "text", ...muted, wrap: "truncate-end" }, right),
            ),
      );
    }),
  );

  return headerColumn;
}
