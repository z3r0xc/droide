/**
 * Frame-capture harness for the shell tests.
 *
 * A shell is mounted in Ink debug mode onto a fake writable, so each commit is
 * appended whole instead of repainting with cursor sequences. A frame is the
 * chunk produced by one commit, stripped of SGR/OSC and with trailing spaces
 * removed — the spec's "ordered list of rendered lines" (Terms: frame).
 */

import { Writable } from "node:stream";

import { detectCapabilities, type Capabilities } from "../../../src/ui/capabilities.ts";
import { STARTUP_PLACEHOLDER, HEADER_SHORTCUTS, MODE_ROW_AUTONOMY_OFF } from "../../../src/ui/strings.ts";
import type { HeaderContent, HeaderStatus } from "../../../src/ui/components/Header.ts";
import type { ShellProps } from "../../../src/ui/components/Shell.ts";
import type { TranscriptEntry } from "../../../src/ui/transcript.ts";

const SGR_OR_OSC =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/gu;

export function stripAnsi(text: string): string {
  return text.replace(SGR_OR_OSC, "");
}

/** A fake terminal stream that records every write. */
export interface Capture {
  readonly stdout: NodeJS.WriteStream;
  readonly chunks: string[];
}

export function captureStream(columns: number, rows: number): Capture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const stdout = Object.assign(stream, {
    columns,
    rows,
    isTTY: false,
  }) as unknown as NodeJS.WriteStream;
  return { stdout, chunks };
}

/** One recorded frame as lines, trailing space padding removed. */
export function frameLines(text: string): string[] {
  const lines = stripAnsi(text).split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Capabilities for a fixed size on a POSIX-like host with 256 colours. */
export function capabilitiesAt(columns: number, rows: number): Capabilities {
  return detectCapabilities({
    env: {
      TERM: "xterm-256color",
      COLUMNS: String(columns),
      LINES: String(rows),
    },
    platform: "linux",
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });
}

export const STATUSES: readonly HeaderStatus[] = [
  { label: "Skills", count: 0, ok: false },
  { label: "MCPs", count: 0, ok: false },
  { label: "Connectors", count: 0, ok: false },
  { label: "AGENTS.md", count: undefined, ok: false },
];

export function headerContent(changelog: boolean): HeaderContent {
  return {
    version: "1.9.0",
    tip: "Use /model to switch models",
    statuses: STATUSES,
    shortcuts: HEADER_SHORTCUTS,
    ...(changelog
      ? {
          changelog: [
            "New features",
            "",
            "· Faster streaming",
            "· Model picker",
          ],
        }
      : {}),
  };
}

export function scriptedTranscript(): readonly TranscriptEntry[] {
  return [
    { kind: "user", text: "hello" },
    { kind: "assistant", text: "Hi there." },
    {
      kind: "tool",
      name: "Read",
      params: [["path", "src/a.ts"]],
      state: "success",
      result: "line one\nline two",
    },
  ];
}

/** A complete shell at one size. */
export function shellAt(
  columns: number,
  rows: number,
  options: {
    readonly transcript?: readonly TranscriptEntry[];
    readonly changelog?: boolean;
  } = {},
): ShellProps {
  return {
    capabilities: capabilitiesAt(columns, rows),
    width: columns,
    height: rows,
    header: headerContent(options.changelog === true),
    transcript: options.transcript ?? [],
    composer: {
      draft: "",
      placeholder: STARTUP_PLACEHOLDER,
      focused: true,
    },
    modeRow: {
      autonomy: MODE_ROW_AUTONOMY_OFF,
      model: "claude-sonnet-4-5",
    },
    footer: {},
  };
}