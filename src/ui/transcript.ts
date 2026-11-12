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

/** How an approval was answered (R11). */
export type ApprovalChoice = "once" | "session" | "deny";

/** One selectable approval option; `label` is the caller's English string. */
export interface ApprovalOption {
  readonly choice: ApprovalChoice;
  readonly label: string;
}

/** The pending (or already answered) approval prompt (R11). */
export interface ApprovalTranscriptItem {
  readonly kind: "approval";
  readonly toolName: string;
  /** One dimmed line naming the class, risk or path the call touches. */
  readonly summary: string;
  readonly options: readonly ApprovalOption[];
  /** Index into `options`; only meaningful while `decision` is absent. */
  readonly selected: number;
  /** Set once the user chose; the option rows are then replaced by a state. */
  readonly decision?: ApprovalChoice;
}

/** A `●` system notice row (R12). */
export interface NoticeTranscriptItem {
  readonly kind: "notice";
  readonly text: string;
}

/** The item kinds this vertical renders. */
export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | ApprovalTranscriptItem
  | NoticeTranscriptItem;

/** An untrusted transcript entry, as delivered by the session layer. */
export interface TranscriptEntry {
  readonly kind: string;
  readonly [field: string]: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function readChoice(value: unknown): ApprovalChoice | undefined {
  return value === "once" || value === "session" || value === "deny"
    ? value
    : undefined;
}

function readOptions(value: unknown): readonly ApprovalOption[] {
  if (!Array.isArray(value)) return [];
  const options: ApprovalOption[] = [];
  for (const option of value) {
    if (!isRecord(option)) continue;
    const choice = readChoice(option["choice"]);
    const label = readString(option["label"]);
    if (choice === undefined || label === undefined) continue;
    options.push({ choice, label });
  }
  return options;
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
    case "approval": {
      const toolName = readString(entry.toolName);
      if (toolName === undefined || toolName.length === 0) return undefined;
      const options = readOptions(entry.options);
      const selected =
        typeof entry.selected === "number" &&
        Number.isInteger(entry.selected) &&
        entry.selected >= 0 &&
        entry.selected < options.length
          ? entry.selected
          : 0;
      const decision = readChoice(entry.decision);
      return {
        kind: "approval",
        toolName,
        summary: readString(entry.summary) ?? "",
        options,
        selected,
        ...(decision === undefined ? {} : { decision }),
      };
    }
    case "notice": {
      const text = readString(entry.text);
      return text === undefined ? undefined : { kind: "notice", text };
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
