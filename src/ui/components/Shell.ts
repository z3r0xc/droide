/**
 * Shell (B2): header, transcript, input-area stack and footer, in that order.
 *
 * The input-area stack starts with the row reserved for the idle status banner
 * (B12), then the mode/model row, the composer and the footer. A short terminal
 * (height ≤ 24) switches the header to its compact variant and the composer
 * keeps its reduced draft window. The transcript itself is not capped here: the
 * static region and the live-tail budget are the streaming slice (B4).
 */

import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";

import type { Capabilities } from "../capabilities.ts";
import { displayWidth, truncateToWidth } from "../text.ts";
import { foreground } from "../tokens.ts";
import type { TranscriptEntry } from "../transcript.ts";
import { Composer, type ComposerContent } from "./Composer.ts";
import { Footer, type FooterContent } from "./Footer.ts";
import { Header, type HeaderContent } from "./Header.ts";
import { StatusLine, type StatusLineContent } from "./StatusLine.ts";
import { Transcript } from "./Transcript.ts";

/** The mode/autonomy + model row above the composer (B2). */
export interface ModeRowContent {
  readonly autonomy: string;
  readonly model: string;
}

export interface ShellProps {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly height: number;
  readonly header: HeaderContent;
  readonly transcript: readonly TranscriptEntry[];
  readonly composer: ComposerContent;
  readonly modeRow: ModeRowContent;
  readonly footer: FooterContent;
  readonly statusLine?: StatusLineContent;
}

function ModeRow(props: {
  readonly capabilities: Capabilities;
  readonly width: number;
  readonly content: ModeRowContent;
}): ReactNode {
  const { capabilities, width, content } = props;
  const left = truncateToWidth(
    content.autonomy,
    Math.max(0, width - displayWidth(content.model) - 1),
  );
  const gap = Math.max(
    1,
    width - displayWidth(left) - displayWidth(content.model),
  );
  return h(
    Box,
    { width, flexDirection: "row" },
    h(Text, { ...foreground("text.secondary", capabilities) }, left),
    h(Text, null, " ".repeat(gap)),
    h(
      Text,
      { ...foreground("text.muted", capabilities), wrap: "truncate-end" },
      content.model,
    ),
  );
}

export function Shell(props: ShellProps): ReactNode {
  const { capabilities, width, height } = props;
  return h(
    Box,
    { flexDirection: "column", width },
    h(Header, {
      capabilities,
      width,
      height,
      content: props.header,
    }),
    h(Transcript, {
      capabilities,
      width,
      entries: props.transcript,
    }),
    h(Box, { height: 1 }),
    h(ModeRow, {
      capabilities,
      width,
      content: props.modeRow,
    }),
    h(Composer, {
      capabilities,
      width,
      height,
      content: props.composer,
    }),
    h(Footer, {
      capabilities,
      width,
      content: props.footer,
    }),
    props.statusLine === undefined
      ? null
      : h(StatusLine, { capabilities, width, content: props.statusLine }),
  );
}