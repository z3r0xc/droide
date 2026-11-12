/**
 * Transcript files: the append-only JSONL artefact a session owns.
 * Contract: `specs/40-sessions-and-storage.md` Terms ("Transcript") and B17.
 *
 * The index stores *where* a transcript is, never a copy of it, so every path
 * is derived from `(sessions dir, project key, session id)`. The derivation is
 * the security boundary: a stored key that resolves outside the sessions
 * directory is rejected rather than joined.
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import {
  InvalidProjectKeyError,
  InvalidSessionIdError,
  InvalidTranscriptRecordError,
  OutsideSessionsDirError,
  TranscriptCorruptError,
  TranscriptUnavailableError,
} from "./errors.ts";
import { isSessionId } from "./ids.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `''` is the global root, `btw` a fork directory, and anything else a project
 * directory, which always begins with `-` (B17 / "On-disk layout").
 */
export function validateProjectKey(projectKey: string): void {
  if (projectKey.length === 0 || projectKey === "btw") return;
  const hasSeparator = /[/\\\u0000]/.test(projectKey);
  if (!projectKey.startsWith("-") || hasSeparator || projectKey === "-") {
    throw new InvalidProjectKeyError(projectKey);
  }
}

export function transcriptPathFor(
  sessionsDir: string,
  projectKey: string,
  sessionId: string,
): string {
  if (!isSessionId(sessionId)) throw new InvalidSessionIdError(sessionId);
  validateProjectKey(projectKey);
  const base = resolve(sessionsDir);
  const target = resolve(base, projectKey, `${sessionId}.jsonl`);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  if (target !== base && !target.startsWith(prefix)) {
    throw new OutsideSessionsDirError(sessionId);
  }
  return target;
}

/** One JSONL line, newline included. Refuses anything the reader cannot use. */
export function serializeTranscriptRecord(record: JsonObject): string {
  if (!isJsonObject(record)) throw new InvalidTranscriptRecordError("expected an object");
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch (error) {
    throw new InvalidTranscriptRecordError("not serialisable as JSON", error);
  }
  if (typeof line !== "string" || line.length === 0) {
    throw new InvalidTranscriptRecordError("serialised to nothing");
  }
  return `${line}\n`;
}

export function parseTranscriptRecord(line: string, lineNumber: number): JsonObject {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TranscriptCorruptError(lineNumber, error);
  }
  if (!isJsonObject(parsed)) {
    throw new TranscriptCorruptError(lineNumber, undefined);
  }
  return parsed;
}

export function appendTranscriptLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export function transcriptSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

export function readTranscriptFile(path: string, sessionId: string): readonly JsonObject[] {
  if (!existsSync(path)) throw new TranscriptUnavailableError(sessionId);
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => parseTranscriptRecord(line, index + 1));
}