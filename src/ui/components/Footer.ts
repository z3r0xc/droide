/**
 * Footer (B13), shell subset: one row with the left hint block and the right
 * status block. Hints are shed from the end until the row fits; the statuses
 * then truncate. On Windows-like hosts the right block is appended to the left
 * block instead of being right-aligned.
 *
 * The full footer composes timer, questions, droids and next-loop segments and
 * their alternative forms; those arrive with the daemon slice.
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import { BLOCK_SEPARATOR, FOOTER_HELP } from "../strings.ts";
import { displayWidth, truncateToWidth } from "../text.ts";
import { SPACING, foreground } from "../tokens.ts";

export interface FooterContent {
  readonly hints?: readonly string[];
  readonly statuses?: readonly string[];
  readonly primary?: string;
}

export interface FooterProps {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly content: FooterContent;
}

function joinLeft(primary: string, hints: readonly string[]): string {
  if (hints.length === 0) return primary;
  // No pending-question segment in this vertical, so the first hint follows the
  // primary label after a single space and the rest use the pipe separator.
  return `${primary} ${hints[0] ?? ""}${hints
    .slice(1)
    .map((hint) => `${BLOCK_SEPARATOR}${hint}`)
    .join("")}`;
}

/** Compose the footer text for a width, shedding hints then statuses. */
export function fitFooter(
  width: number,
  content: FooterContent,
  platform: Capabilities["platform"] = "posix",
): string {
  const primary = content.primary ?? FOOTER_HELP;
  const hints = [...(content.hints ?? [])];
  const statuses = [...(content.statuses ?? [])];

  const compose = (): string => {
    const left = joinLeft(primary, hints);
    const right = statuses.join(BLOCK_SEPARATOR);
    if (right.length === 0) return left;
    if (platform === "windows") return `${left}${BLOCK_SEPARATOR}${right}`;
    const gap = Math.max(
      SPACING.footerRowGap,
      width - displayWidth(left) - displayWidth(right),
    );
    return `${left}${" ".repeat(gap)}${right}`;
  };

  let text = compose();
  while (displayWidth(text) > width && hints.length > 0) {
    hints.pop();
    text = compose();
  }
  while (displayWidth(text) > width && statuses.length > 0) {
    statuses.pop();
    text = compose();
  }
  return truncateToWidth(text, width);
}

export function Footer(props: FooterProps): ReactNode {
  const { capabilities, width, content } = props;
  const text = fitFooter(width, content, capabilities.platform);
  return h(
    Box,
    { width, flexDirection: "row" },
    h(
      Text,
      { wrap: "truncate-end", ...foreground("text.muted", capabilities) },
      text,
    ),
  );
}