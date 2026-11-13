/**
 * `Read` — text file reads with line ranges, encodings and budgets.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B14 (input), B15 (whole file,
 * outline, range note, budgets), B16 (encodings, the 8 MiB scan path and the
 * two refusals) and B11/B12 (the cut and its whole-output spill). Media reads
 * (B17) are refused rather than decoded as text: this build has no image or
 * PDF block layer.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import type { Environment } from "../../config/paths.ts";
import type { ToolContext } from "../context.ts";
import { ToolFailure } from "../errors.ts";
import { defineTool, type ToolDefinition } from "../registry.ts";
import { MODEL_TEXT_BUDGET_BYTES, boundText } from "../result.ts";
import type { ObjectSchema, Schema } from "../validate.ts";
import { decodeText, detectEncoding, normalizeToLF } from "./encoding.ts";
import {
  nodeSpillFileSystem,
  writeToolOutput,
  type SpillFileSystem,
} from "./spill.ts";
import {
  assertReadablePath,
  assertNoSymlinkEscape,
  resolveInputPath,
} from "./paths.ts";

const MIB = 1024 * 1024;
const LARGE_TEXT_FILE_BYTES = 8 * MIB;
const DIRECT_READ_WINDOW_MAX_BYTES = 5 * MIB;
const SCAN_CHUNK_BYTES = MIB;
const DEFAULT_LIMIT = 2400;
const OUTLINE_MIN_LINES = 200;
const OUTLINE_MIN_ENTRIES = 8;
const OUTLINE_MAX_SHARE = 0.4;
const OUTLINE_LINE_WIDTH = 160;

const OUTLINE_EXCLUDED_EXTENSIONS: Readonly<Record<string, true>> = {
  ".md": true,
  ".mdx": true,
};

const OUTLINE_LINE_PATTERNS: readonly RegExp[] = [
  /^(export\s+)?(default\s+)?((abstract|final|public|private|protected|internal|static|sealed|data|open|partial)\s+)*(class|interface|enum|record|struct|trait|impl|object|type|module|namespace|protocol|extension)\s+[A-Za-z_]/,
  /^(export\s+)?(default\s+)?(async\s+)?(def|fn|func|function|fun|sub|proc)\s+[A-Za-z_]/,
  /^(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*(:[^=]*)?=\s*(async\s*)?(\(.*\)(\s*:[^=]*)?\s*=>|function\b|[A-Za-z_$][\w$]*\s*=>)/,
  /^((public|private|protected|internal|static|final|abstract|synchronized|default|override|native|suspend|async|virtual)\s+)+\*?[\w<>[\],.?]+(\s+\*?[\w<>[\],.?]+)*\s*\([^;]*$/,
  /^(public|private|protected|static|async|get|set|override)?\s*\*?[A-Za-z_$][\w$]*\s*\(([^;]*\)\s*(:\s*[^{;]+)?\s*\{\s*$|$)/,
  /^[\w<>[\],.?]+\s+[A-Za-z_]\w*\s*\([^;]*\)\s*(throws\s+[\w., ]+)?\s*\{\s*$/,
  /^(@Test\b|@ParameterizedTest\b|@BeforeEach\b|@BeforeAll\b|@Nested\b|(describe|it|test|context|suite)\s*\(|def test_)/,
];

const OUTLINE_EXCLUDED_KEYWORDS =
  /^(if|else|for|while|switch|try|catch|using|return|new)\b/;

export const readInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    file_path: {
      kind: "string",
      description: "The absolute path to the file to read.",
    },
    offset: {
      kind: "number",
      optional: true,
      integer: true,
      description:
        "The 1-based line to start reading from; a negative value counts from the end (default 1).",
    },
    limit: {
      kind: "number",
      optional: true,
      integer: true,
      description: "How many lines to return (default 2400; must be > 0).",
    },
    line_numbers: {
      kind: "boolean",
      optional: true,
      description: "Render each line as `N→text` (default false).",
    },
    image_quality: {
      kind: "enum",
      values: ["default", "high"],
      optional: true,
      description: "Image quality for image reads (default `default`).",
    },
  },
};

export interface ReadInput {
  readonly file_path: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly line_numbers?: boolean;
  readonly image_quality?: string;
}

export interface ReadOptions {
  /** B14: `file_path` must be absolute. */
  readonly requireAbsolute?: boolean;
  /** A program read: no outline, no range note, acceptance of a non-finite limit. */
  readonly programmatic?: boolean;
  readonly budgetBytes?: number;
  /**
   * The spill seam (B12). Tests inject a fake so an unwritable directory is
   * provable without touching the host; the default writes under the state dir.
   */
  readonly spillFileSystem?: SpillFileSystem;
}

interface RenderedLines {
  readonly text: string;
  readonly note?: string;
}

function renderLines(
  content: string,
  offset: number,
  limit: number,
  includeLineNumbers: boolean,
  totalLines: number,
  contentOffset: number,
  programmatic: boolean,
): RenderedLines {
  const lines = content.split("\n");
  const startLine =
    offset < 0 ? Math.max(0, totalLines + offset) : Math.max(0, offset);
  const endLine = Math.min(
    totalLines,
    Number.isFinite(limit) ? startLine + limit : totalLines,
  );
  const selected = lines.slice(
    startLine - contentOffset,
    endLine - contentOffset,
  );
  if (selected.length === 0) return { text: "" };
  const rendered = includeLineNumbers
    ? selected.map((line, index) => `${startLine + index + 1}→${line}`)
    : selected;
  const text = rendered.join("\n");
  if (programmatic || (startLine === 0 && endLine === totalLines)) {
    return { text };
  }
  return {
    text,
    note: `[Showing lines ${startLine + 1}-${startLine + rendered.length} of ${totalLines} total lines]`,
  };
}

function outlineLines(content: string, filePath: string): RenderedLines | null {
  if (
    Object.hasOwn(
      OUTLINE_EXCLUDED_EXTENSIONS,
      nodePath.extname(filePath).toLowerCase(),
    )
  ) {
    return null;
  }
  const lines = content.split("\n");
  if (lines.length <= OUTLINE_MIN_LINES) return null;
  const entries: string[] = [];
  for (const [index, line] of lines.entries()) {
    const indentation = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indentation > 8 || trimmed.length === 0) continue;
    if (OUTLINE_EXCLUDED_KEYWORDS.test(trimmed)) continue;
    if (!OUTLINE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed)))
      continue;
    entries.push(`${index + 1}→${trimmed.slice(0, OUTLINE_LINE_WIDTH)}`);
  }
  if (
    entries.length < OUTLINE_MIN_ENTRIES ||
    entries.length > lines.length * OUTLINE_MAX_SHARE
  ) {
    return null;
  }
  const text = entries.join("\n");
  const note =
    `[Outline: ${entries.length} declaration lines of ${lines.length}; files over ` +
    `${OUTLINE_MIN_LINES} lines open as an outline. Read with offset (and limit) for ` +
    `the lines you need]`;
  return Buffer.byteLength(text) + Buffer.byteLength(note) >
    MODEL_TEXT_BUDGET_BYTES
    ? null
    : { text, note };
}

interface ScannedWindow {
  readonly startByte: number;
  readonly endByte: number;
  readonly totalLines: number;
}

/**
 * Byte offsets of the requested line window plus the file's line count, found
 * by scanning chunks so a large file is never held whole (B16).
 */
async function scanLineWindow(
  filePath: string,
  size: number,
  startLine: number,
  endLine: number,
  maxWindowBytes: number,
): Promise<ScannedWindow> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    let position = 0;
    let line = 0;
    let lineStartByte = 0;
    let startByte = -1;
    let endByte = -1;
    let pendingCR = false;
    const onBreak = (breakEnd: number): boolean => {
      if (line === startLine) startByte = lineStartByte;
      line += 1;
      lineStartByte = breakEnd;
      if (endLine >= 0 && line >= endLine && startByte !== -1) {
        endByte = breakEnd;
        if (endByte - startByte > maxWindowBytes) return true;
      }
      return false;
    };
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let index = 0;
      if (pendingCR && view[0] !== 0x0a) {
        if (onBreak(position)) break;
      }
      pendingCR = false;
      while (index < bytesRead) {
        const byte = view[index];
        if (byte === 0x0d) {
          if (index + 1 < bytesRead) {
            const next = view[index + 1];
            if (next === 0x0a) {
              index += 1;
              if (onBreak(position + index + 1)) {
                return { startByte, endByte, totalLines: line + 1 };
              }
            } else if (onBreak(position + index + 1)) {
              return { startByte, endByte, totalLines: line + 1 };
            }
          } else {
            pendingCR = true;
          }
        } else if (byte === 0x0a) {
          if (onBreak(position + index + 1)) {
            return { startByte, endByte, totalLines: line + 1 };
          }
        }
        index += 1;
      }
      position += bytesRead;
    }
    if (pendingCR) onBreak(size);
    if (startByte === -1) startByte = endLine === -1 ? 0 : size;
    if (endByte === -1) endByte = size;
    return { startByte, endByte, totalLines: line + 1 };
  } finally {
    await handle.close();
  }
}

function refuseMedia(filePath: string, buffer: Buffer): void {
  const isPng = buffer
    .subarray(0, 4)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isGif = buffer.subarray(0, 4).toString("latin1") === "GIF8";
  const isPdf = buffer.subarray(0, 4).toString("latin1") === "%PDF";
  if (isPng || isJpeg || isGif || isPdf) {
    // `TODO(spec B17)`: image and PDF reads are not implemented; refusing beats
    // decoding binary bytes as text.
    throw new ToolFailure(
      `Read of ${filePath}: image and PDF content is not supported by this build. ` +
        "Use Execute to extract text from it.",
    );
  }
}

/** Reads a text file and renders the requested window (B14-B16). */
export async function readText(
  input: ReadInput,
  context: ToolContext,
  options: ReadOptions = {},
): Promise<string> {
  const filePath = resolveInputPath(context, input.file_path, {
    requireAbsolute: options.requireAbsolute === true,
  });
  assertReadablePath(filePath, context.environment);
  assertNoSymlinkEscape(context, input.file_path, filePath);

  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (
    (!Number.isFinite(limit) && options.programmatic !== true) ||
    limit <= 0
  ) {
    throw new ToolFailure("limit must be a positive number");
  }
  if (!Number.isFinite(offset)) {
    throw new ToolFailure("offset must be a finite number");
  }
  const requestedRange =
    input.offset !== undefined || input.limit !== undefined;
  const includeLineNumbers = input.line_numbers === true;
  const programmatic = options.programmatic === true;
  const budget = options.budgetBytes ?? MODEL_TEXT_BUDGET_BYTES;
  const fileSystem = options.spillFileSystem ?? nodeSpillFileSystem;

  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) {
    throw new ToolFailure(`Failed to read ${filePath}: not a regular file`);
  }
  const head = await fs.promises.open(filePath, "r");
  let headBytes: Buffer;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await head.read(buffer, 0, buffer.length, 0);
    headBytes = buffer.subarray(0, bytesRead);
  } finally {
    await head.close();
  }
  refuseMedia(filePath, headBytes);

  let text: string;
  if (stats.size > LARGE_TEXT_FILE_BYTES) {
    const sizeMiB = (stats.size / MIB).toFixed(1);
    if (detectEncoding(headBytes) !== "utf-8") {
      throw new ToolFailure(
        `${filePath} is ${sizeMiB} MiB of UTF-16 text, too large to read by line; ` +
          "convert it to UTF-8 (for example with iconv) and read the copy",
      );
    }
    const zeroBasedOffset = offset > 0 ? offset - 1 : offset;
    // A negative offset needs the file's line count first; the counting pass
    // records no window, so it never loads the file.
    const counted = await scanLineWindow(filePath, stats.size, 0, -1, 0);
    const startLine =
      zeroBasedOffset < 0
        ? Math.max(0, counted.totalLines + zeroBasedOffset)
        : Math.max(0, zeroBasedOffset);
    const window = await scanLineWindow(
      filePath,
      stats.size,
      startLine,
      Number.isFinite(limit) ? startLine + limit : -1,
      DIRECT_READ_WINDOW_MAX_BYTES,
    );
    if (window.endByte - window.startByte > DIRECT_READ_WINDOW_MAX_BYTES) {
      throw new ToolFailure(
        `Read of ${filePath} (${sizeMiB} MiB) would load over ` +
          `${DIRECT_READ_WINDOW_MAX_BYTES / MIB} MiB for the requested lines, the limit ` +
          "for a file this large; request fewer lines with offset and limit, or inspect " +
          "very long lines with Execute (for example head -c or cut -c)",
      );
    }
    const handle = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(window.endByte - window.startByte);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          buffer.length - filled,
          window.startByte + filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      text = normalizeToLF(buffer.subarray(0, filled).toString("latin1"));
    } finally {
      await handle.close();
    }
    const rendered = renderLines(
      text,
      startLine,
      limit,
      includeLineNumbers,
      counted.totalLines,
      startLine,
      programmatic,
    );
    context.reads?.record(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
    return finish(rendered, filePath, budget, context.environment, fileSystem);
  }

  const decoded = decodeText(await fs.promises.readFile(filePath));
  text = decoded.text;
  context.reads?.record(filePath, { mtimeMs: stats.mtimeMs, size: stats.size });

  if (!programmatic && !requestedRange) {
    const outline = outlineLines(text, filePath);
    if (outline !== null) {
      return finish(outline, filePath, budget, context.environment, fileSystem);
    }
  }
  const totalLines = text.split("\n").length;
  const zeroBasedOffset = offset > 0 ? offset - 1 : offset;
  const startLine =
    zeroBasedOffset < 0
      ? Math.max(0, totalLines + zeroBasedOffset)
      : zeroBasedOffset;
  const rendered = renderLines(
    text,
    startLine,
    limit,
    includeLineNumbers,
    totalLines,
    0,
    programmatic,
  );
  return await finish(
    rendered,
    filePath,
    budget,
    context.environment,
    fileSystem,
  );
}

/**
 * The rendered result, or its cut with a notice naming the whole output (B12).
 * An over-budget result is spilled under `<stateDir>/tool-outputs` first; an
 * unwritable or oversized spill falls back to the offset/limit remedy.
 */
async function finish(
  rendered: RenderedLines,
  filePath: string,
  budget: number,
  environment: Environment,
  fileSystem: SpillFileSystem,
): Promise<string> {
  const text =
    rendered.note === undefined
      ? rendered.text
      : `${rendered.text}\n\n${rendered.note}`;
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  const spilled = await writeToolOutput(environment, text, fileSystem);
  const whole = spilled ?? `${filePath} (read it with offset and limit)`;
  return boundText(text, budget, whole).text;
}

export const readTool: ToolDefinition = defineTool<ReadInput, ToolContext>({
  id: "read-cli",
  llmId: "Read",
  category: "Files",
  displayName: "Read",
  description: "Read a text file from the filesystem.",
  inputSchema: readInputSchema satisfies Schema,
  sideEffects: ["filesystem-read"],
  requiresConfirmation: false,
  visibleToUser: false,
  run: (input, context) => readText(input, context, { requireAbsolute: true }),
});
