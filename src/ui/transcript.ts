/**
 * Transcript items and their row budgets (B5, B6, B7, R4, R5).
 *
 * Renderers receive *wire* entries: plain objects whose `kind` is a string. An
 * entry this vertical does not understand normalises to `undefined` and renders
 * nothing, so a later slice's item (a diff, a todo panel, …) can appear in the
 * transcript without crashing the shell.
 */

import { splitLines } from "./text.ts";
import { GLYPHS } from "./tokens.ts";

export const TOOL_PREVIEW_MAX_LINES = 4;
export const TOOL_PREVIEW_MAX_CHARS = 1024;
export const TOOL_DETAIL_MAX_LINES = 200;
export const TOOL_DETAIL_MAX_CHARS = 16 * 1024;

/** A tool parameter row: `key: "value"`. */
export type ToolParam = readonly [key: string, value: string];

export interface UserTranscriptItem {
  readonly kind: "user";
  readonly text: string;
  readonly specMode: boolean;
}

export interface AssistantTranscriptItem {
  readonly kind: "assistant";
  readonly text: string;
}

export type ToolState = "pending" | "success" | "error";

export interface ToolTranscriptItem {
  readonly kind: "tool";
  readonly name: string;
  readonly params: readonly ToolParam[];
  readonly suffix: string | undefined;
  readonly state: ToolState;
  readonly result: string | undefined;
  readonly interrupted: boolean;
}

/** The three item kinds this vertical renders. */
export type TranscriptItem =
  UserTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem;

/** An untrusted transcript entry, as delivered by the session layer. */
export interface TranscriptEntry {
  readonly kind: string;
  readonly [field: string]: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readParams(value: unknown): readonly ToolParam[] {
  if (!Array.isArray(value)) return [];
  const params: ToolParam[] = [];
  for (const param of value) {
    if (!Array.isArray(param) || param.length < 2) continue;
    const key = readString(param[0]);
    const valueText = readString(param[1]);
    if (key === undefined || valueText === undefined) continue;
    params.push([key, valueText]);
  }
  return params;
}

function readState(value: unknown): ToolState {
  return value === "pending" || value === "error" ? value : "success";
}

/**
 * Validate one wire entry into a renderable item.
 * Unknown kinds, and known kinds missing their required text, render nothing.
 */
export function toTranscriptItem(
  entry: TranscriptEntry,
): TranscriptItem | undefined {
  switch (entry.kind) {
    case "user": {
      const text = readString(entry.text);
      return text === undefined
        ? undefined
        : { kind: "user", text, specMode: entry.specMode === true };
    }
    case "assistant": {
      const text = readString(entry.text);
      return text === undefined ? undefined : { kind: "assistant", text };
    }
    case "tool": {
      const name = readString(entry.name);
      if (name === undefined || name.length === 0) return undefined;
      return {
        kind: "tool",
        name,
        params: readParams(entry.params),
        suffix: readString(entry.suffix),
        state: readState(entry.state),
        result: readString(entry.result),
        interrupted: entry.interrupted === true,
      };
    }
    default:
      return undefined;
  }
}

/** Trim a parameter value at 50 characters, with the spec's ellipsis. */
export function clampParamValue(value: string): string {
  return value.length > 50 ? `${value.slice(0, 50)}${GLYPHS.ellipsis}` : value;
}

/** A collapsed preview: the lines to print and how many were withheld. */
export interface ResultPreview {
  readonly lines: readonly string[];
  readonly hidden: number;
}

/**
 * Collapse a tool result to the preview caps (B7): 4 lines and 1024
 * characters, with a notice row counted separately by the renderer.
 */
export function previewResult(text: string): ResultPreview {
  const allLines = splitLines(text);
  const characterCapped = text.slice(0, TOOL_PREVIEW_MAX_CHARS);
  const cappedLines = splitLines(characterCapped).slice(
    0,
    TOOL_PREVIEW_MAX_LINES,
  );
  const hidden = Math.max(0, allLines.length - cappedLines.length);
  return { lines: cappedLines, hidden };
}
