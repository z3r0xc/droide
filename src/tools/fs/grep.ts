/**
 * `Grep` — regular-expression search over discovered files.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B20: the input matrix, `file_paths`
 * by default, per-file match limits in content mode (500 when no limit, 1 for a
 * non-positive one), multiline auto-enabled for a pattern containing a newline,
 * the two empty-result strings, and the 20 MB buffer refusal.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import type { ToolContext } from "../context.ts";
import { ToolFailure } from "../errors.ts";
import {
  NATIVE_FILE_BYTES_LIMIT,
  type LiteralQuery,
} from "../native-backend.ts";
import { defineTool, type ToolDefinition } from "../registry.ts";
import type { ObjectSchema } from "../validate.ts";
import { matchesGlob } from "./glob-match.ts";
import { isCredentialFile, isInside, resolveInputPath } from "./paths.ts";
import { walkFiles, type WalkEntry } from "./walk.ts";

const MAX_CONTENT_MATCHES_PER_FILE = 500;
const MAX_GREP_RESULT_BYTES = 20 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;

/** The `type` table spec 30 B20 lists; adding a name is a spec change. */
const TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  js: [".js", ".mjs", ".cjs", ".jsx"],
  ts: [".ts", ".mts", ".cts", ".tsx"],
  py: [".py", ".pyi"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  c: [".c", ".h"],
  csharp: [".cs"],
  ruby: [".rb"],
  php: [".php"],
  shell: [".sh", ".bash", ".zsh"],
  html: [".html", ".htm"],
  css: [".css", ".scss", ".sass"],
  json: [".json", ".jsonc"],
  yaml: [".yaml", ".yml"],
  toml: [".toml"],
  md: [".md", ".mdx"],
};

export const grepInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    pattern: {
      kind: "string",
      description:
        "A search pattern: a literal string or a regular expression.",
    },
    path: {
      kind: "string",
      optional: true,
      description:
        "Absolute path to a file or directory; defaults to the workspace root.",
    },
    glob_pattern: {
      kind: "string",
      optional: true,
      description: 'Glob filter for file paths, e.g. "*.ts".',
    },
    output_mode: {
      kind: "enum",
      values: ["file_paths", "content"],
      optional: true,
      default: "file_paths",
      description:
        "`file_paths` lists matching files; `content` returns matching lines.",
    },
    case_insensitive: {
      kind: "boolean",
      optional: true,
      default: false,
      description: "Match case-insensitively.",
    },
    type: {
      kind: "string",
      optional: true,
      description: 'File type filter, e.g. "js" or "py".',
    },
    context_before: {
      kind: "number",
      optional: true,
      description: "Context lines before each match (content mode).",
    },
    context_after: {
      kind: "number",
      optional: true,
      description: "Context lines after each match (content mode).",
    },
    context: {
      kind: "number",
      optional: true,
      description: "Context lines before and after each match (content mode).",
    },
    line_numbers: {
      kind: "boolean",
      optional: true,
      default: false,
      description: "Include line numbers in content output.",
    },
    head_limit: {
      kind: "number",
      optional: true,
      description:
        "Limit entries; in content mode it caps matches per file (default 500).",
    },
    multiline: {
      kind: "boolean",
      optional: true,
      default: false,
      description: "Let `.` match newlines and patterns span lines.",
    },
    fixed_string: {
      kind: "boolean",
      optional: true,
      default: false,
      description: "Treat the pattern as a literal string.",
    },
  },
};

export interface GrepInput {
  readonly pattern: string;
  readonly path?: string;
  readonly glob_pattern?: string;
  readonly output_mode?: string;
  readonly case_insensitive?: boolean;
  readonly type?: string;
  readonly context_before?: number;
  readonly context_after?: number;
  readonly context?: number;
  readonly line_numbers?: boolean;
  readonly head_limit?: number;
  readonly multiline?: boolean;
  readonly fixed_string?: boolean;
}

export interface GrepContentLine {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly kind: "match" | "context";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0);
}

async function candidateFiles(
  input: GrepInput,
  context: ToolContext,
): Promise<{
  readonly target: string;
  readonly entries: readonly WalkEntry[];
  /** A directory walk the backend can narrow; a single named file cannot. */
  readonly canNarrow: boolean;
}> {
  const target =
    input.path === undefined
      ? context.root
      : resolveInputPath(context, input.path, { requireAbsolute: true });
  const backend = context.nativeBackend;
  // Defence in depth, exactly as in `Glob`: a contained path is confirmed by
  // the helper; an absolute path outside the root is allowed by this tool.
  if (backend !== undefined && isInside(context.root, target)) {
    await backend.contain(context.root, target);
  }
  const stats = await fs.promises.stat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolFailure(`Path does not exist: ${target}`);
    }
    throw error;
  });
  const extensions =
    input.type === undefined ? undefined : TYPE_EXTENSIONS[input.type];
  if (input.type !== undefined && extensions === undefined) {
    throw new ToolFailure(`Unrecognized file type: ${input.type}`);
  }
  const allowed = (absolute: string, relative: string): boolean => {
    if (isCredentialFile(absolute, context.environment)) return false;
    if (
      input.glob_pattern !== undefined &&
      !matchesGlob(relative, input.glob_pattern)
    ) {
      return false;
    }
    if (extensions !== undefined) {
      const extension = nodePath.extname(absolute).toLowerCase();
      return extensions.includes(extension);
    }
    return true;
  };
  if (stats.isFile()) {
    return {
      target,
      entries: allowed(target, nodePath.basename(target))
        ? [{ absolute: target, relative: nodePath.basename(target) }]
        : [],
      canNarrow: false,
    };
  }
  const walked =
    backend === undefined
      ? await walkFiles(target)
      : await backend.discover(target);
  return {
    target,
    entries: walked.filter((entry) => allowed(entry.absolute, entry.relative)),
    canNarrow: true,
  };
}

/**
 * The literal query the helper can pre-filter exactly, or `null` when the
 * pattern needs the regex engine (metacharacters, multiline) and the local
 * matcher must see every candidate.
 */
function literalQuery(input: GrepInput): LiteralQuery | null {
  if (input.pattern.length === 0) return null;
  // The helper reads text line by line with the CR stripped, so a pattern that
  // encodes a newline or a carriage return is the regex engine's job.
  if (
    input.multiline === true ||
    input.pattern.includes("\n") ||
    input.pattern.includes("\r")
  ) {
    return null;
  }
  if (input.fixed_string !== true && /[.*+?^${}()|[\]\\]/.test(input.pattern)) {
    return null;
  }
  return {
    query: input.pattern,
    caseSensitive: input.case_insensitive !== true,
  };
}

/**
 * Drops candidates a helper-backed search proved do not contain the pattern.
 * Order is the discovery order either way, so the result list is unchanged;
 * a candidate the helper did not read stays, because the helper skips files
 * above its per-file budget and a match could live only there.
 */
async function narrowCandidates(
  input: GrepInput,
  target: string,
  entries: readonly WalkEntry[],
  context: ToolContext,
): Promise<readonly WalkEntry[]> {
  const backend = context.nativeBackend;
  if (backend === undefined) return entries;
  const query = literalQuery(input);
  if (query === null) return entries;
  const hits = await backend.text(target, query);
  if (hits === null) return entries;
  const matched = new Set(hits.map((hit) => hit.path));
  const narrowed: WalkEntry[] = [];
  for (const entry of entries) {
    if (matched.has(entry.relative)) {
      narrowed.push(entry);
      continue;
    }
    const size = await fs.promises.stat(entry.absolute).then(
      (stats) => stats.size,
      () => NATIVE_FILE_BYTES_LIMIT + 1,
    );
    if (size > NATIVE_FILE_BYTES_LIMIT) narrowed.push(entry);
  }
  return narrowed;
}

function searchExpression(
  pattern: string,
  caseInsensitive: boolean,
  multiline: boolean,
  fixedString: boolean,
): RegExp {
  const source = fixedString ? escapeRegExp(pattern) : pattern;
  const flags = `${multiline || pattern.includes("\n") ? "ms" : "m"}${caseInsensitive ? "i" : ""}`;
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new ToolFailure(
      `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface FileMatches {
  readonly path: string;
  readonly lines: readonly string[];
  /** 1-based line numbers that matched. */
  readonly matchedLines: readonly number[];
}

function matchLines(
  filePath: string,
  content: string,
  expression: RegExp,
  multiline: boolean,
): FileMatches {
  const lines = content.split("\n");
  const matchedLines: number[] = [];
  if (multiline || expression.source.includes("\n")) {
    const global = new RegExp(expression.source, `${expression.flags}g`);
    for (const match of content.matchAll(global)) {
      const index = match.index ?? 0;
      const line = content.slice(0, index).split("\n").length;
      if (!matchedLines.includes(line)) matchedLines.push(line);
      if (match[0].length === 0) global.lastIndex += 1;
    }
    return { path: filePath, lines, matchedLines };
  }
  for (const [index, line] of lines.entries()) {
    if (expression.test(line)) matchedLines.push(index + 1);
  }
  return { path: filePath, lines, matchedLines };
}

function account(budget: { used: number }, text: string): void {
  budget.used += Buffer.byteLength(text, "utf8");
  if (budget.used > MAX_GREP_RESULT_BYTES) {
    throw new ToolFailure(
      "Grep matched more than the 20 MB ripgrep buffer holds, so the list would " +
        "be incomplete. Narrow the pattern or the search path before retrying.",
    );
  }
}

/** Grep over the discovered files (B20). */
export async function grepFiles(
  input: GrepInput,
  context: ToolContext,
): Promise<string[] | GrepContentLine[] | string> {
  const outputMode = input.output_mode ?? "file_paths";
  const expression = searchExpression(
    input.pattern,
    input.case_insensitive === true,
    input.multiline === true,
    input.fixed_string === true,
  );
  const budget = { used: 0 };
  const { target, entries, canNarrow } = await candidateFiles(input, context);
  const files = canNarrow
    ? await narrowCandidates(input, target, entries, context)
    : entries;
  const matches: FileMatches[] = [];
  for (const entry of files) {
    const buffer = await fs.promises.readFile(entry.absolute);
    if (isBinary(buffer)) continue;
    const found = matchLines(
      entry.absolute,
      buffer.toString("utf8"),
      expression,
      input.multiline === true,
    );
    if (found.matchedLines.length === 0) continue;
    matches.push(found);
    account(budget, entry.absolute);
  }

  if (outputMode === "file_paths") {
    const limit =
      input.head_limit === undefined
        ? matches.length
        : input.head_limit <= 0
          ? 1
          : input.head_limit;
    const paths = matches.slice(0, limit).map((match) => match.path);
    return paths.length === 0 ? "No matching files found" : paths;
  }

  const perFileLimit =
    input.head_limit === undefined
      ? MAX_CONTENT_MATCHES_PER_FILE
      : input.head_limit <= 0
        ? 1
        : input.head_limit;
  const before = Math.max(0, input.context ?? input.context_before ?? 0);
  const after = Math.max(0, input.context ?? input.context_after ?? 0);
  const records: GrepContentLine[] = [];
  for (const match of matches) {
    const selected = new Set<number>();
    for (const line of match.matchedLines.slice(0, perFileLimit)) {
      for (
        let candidate = Math.max(1, line - before);
        candidate <= Math.min(match.lines.length, line + after);
        candidate += 1
      ) {
        selected.add(candidate);
      }
    }
    for (const line of [...selected].sort((left, right) => left - right)) {
      const text = match.lines[line - 1] ?? "";
      const kind = match.matchedLines.includes(line) ? "match" : "context";
      records.push({ path: match.path, line, text, kind });
      account(budget, text);
    }
  }
  return records.length === 0 ? "No matches found" : records;
}

export const grepTool: ToolDefinition = defineTool<GrepInput, ToolContext>({
  id: "grep_tool_cli",
  llmId: "Grep",
  displayName: "Grep",
  description: "Search file contents with a regular expression.",
  inputSchema: grepInputSchema,
  sideEffects: ["filesystem-read"],
  requiresConfirmation: false,
  visibleToUser: true,
  run: (input, context) => grepFiles(input, context),
});
