/**
 * `Edit` — exact-text replacement.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B22: exact matching (no fuzzy
 * matching is specified), the five refusals with their exact wording, the
 * read-before-edit and external-change guards, the trailing-newline convention,
 * and B25's atomic write.
 */
import * as fs from "node:fs";

import type { ToolContext } from "../context.ts";
import { ToolFailure } from "../errors.ts";
import { defineTool, type ToolDefinition } from "../registry.ts";
import type { ObjectSchema } from "../validate.ts";
import { decodeText, encodeText, normalizeToLF } from "./encoding.ts";
import {
  assertNoSymlinkEscape,
  assertWritablePath,
  resolveInputPath,
} from "./paths.ts";
import { writeFileAtomic } from "./write.ts";

export const editInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    file_path: {
      kind: "string",
      description: "The path of the file to edit.",
    },
    old_str: {
      kind: "string",
      description:
        "The exact text to replace, including whitespace and line breaks.",
    },
    new_str: {
      kind: "string",
      description: "The replacement text.",
    },
    change_all: {
      kind: "boolean",
      optional: true,
      default: false,
      description:
        "Replace every occurrence instead of requiring a unique match (default false).",
    },
  },
};

export interface EditInput {
  readonly file_path: string;
  readonly old_str: string;
  readonly new_str: string;
  readonly change_all?: boolean;
}

export interface EditResult {
  readonly success: true;
  readonly file_path: string;
  readonly replacements: number;
}

const NOT_READ = (filePath: string): string =>
  `Error: Cannot edit file that has not been read first. Please use the Read tool on ` +
  `"${filePath}" before attempting to edit it.`;

const EXTERNAL_CHANGE = (filePath: string): string =>
  `Error: File "${filePath}" has been modified externally since it was last read. ` +
  "Please use the Read tool to get the latest version before editing.";

const EMPTY_OLD_STR =
  "Error: old_str is empty, but the file is not empty. Provide the exact text to " +
  "replace; an empty old_str only writes content into an empty file.";

const NOT_FOUND =
  "Error: The text to replace was not found in the file. Please ensure the old_str " +
  "parameter matches the exact text in the file, including whitespace and line breaks.";

const AMBIGUOUS = (occurrences: number): string =>
  `Error: Found ${occurrences} occurrences of the specified text, but change_all is ` +
  "false. Either:\n1. Provide more context in old_str to make it unique\n" +
  `2. Set change_all to true if you want to replace all ${occurrences} occurrences`;

const LINE_JOIN =
  "Error: old_str ends with a line break but new_str does not, so the line after " +
  "the match would be joined onto the last line of new_str. End new_str with a " +
  "line break (in a Script input block, leave an empty line before the tag line), " +
  "or extend both strings over the text you mean to join.";

function occurrencesOf(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

/** B22's line-join guard: never glue the following line onto `new_str`. */
function checkLineJoin(content: string, oldStr: string, newStr: string): void {
  const match = content.indexOf(oldStr);
  if (
    oldStr.endsWith("\n") &&
    newStr !== "" &&
    !newStr.endsWith("\n") &&
    match + oldStr.length < content.length
  ) {
    throw new ToolFailure(LINE_JOIN);
  }
}

/** Applies the change, preserving the file's final-newline convention (B22). */
function applyChange(
  content: string,
  oldStr: string,
  newStr: string,
  changeAll: boolean,
): string {
  const match = content.indexOf(oldStr);
  const next = changeAll
    ? content.split(oldStr).join(newStr)
    : content.slice(0, match) + newStr + content.slice(match + oldStr.length);
  const originalHadNewline = content.endsWith("\n");
  const nextHasNewline = next.endsWith("\n");
  if (originalHadNewline && !nextHasNewline) return `${next}\n`;
  if (!originalHadNewline && nextHasNewline) return next.slice(0, -1);
  return next;
}

/** Edits `file_path` with exact string replacement (B22). */
export async function editFile(
  input: EditInput,
  context: ToolContext,
): Promise<EditResult> {
  const resolved = resolveInputPath(context, input.file_path);
  assertWritablePath(context, input.file_path, resolved);
  assertNoSymlinkEscape(context, input.file_path, resolved);

  const stats = await fs.promises.stat(resolved).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolFailure(NOT_READ(resolved));
    }
    throw error;
  });
  if (stats.isDirectory()) {
    throw new ToolFailure(
      `Error: Cannot edit "${resolved}": it is a directory.`,
    );
  }
  const previous = context.reads?.check(resolved);
  if (previous === undefined) throw new ToolFailure(NOT_READ(resolved));
  if (previous.mtimeMs !== stats.mtimeMs || previous.size !== stats.size) {
    throw new ToolFailure(EXTERNAL_CHANGE(resolved));
  }

  const decoded = decodeText(await fs.promises.readFile(resolved));
  const content = decoded.text;
  const oldStr = normalizeToLF(input.old_str);
  const newStr = normalizeToLF(input.new_str);
  const changeAll = input.change_all === true;

  let next: string;
  let replacements: number;
  if (oldStr === "" && content === "") {
    next = newStr;
    replacements = 1;
  } else {
    if (oldStr === "") throw new ToolFailure(EMPTY_OLD_STR);
    if (!content.includes(oldStr)) throw new ToolFailure(NOT_FOUND);
    const occurrences = occurrencesOf(content, oldStr);
    if (occurrences > 1 && !changeAll) {
      throw new ToolFailure(AMBIGUOUS(occurrences));
    }
    checkLineJoin(content, oldStr, newStr);
    next = applyChange(content, oldStr, newStr, changeAll);
    replacements = changeAll ? occurrences : 1;
  }

  // `TODO(spec B22)`: the match runs against the secret-scrubbed view; this
  // build has no scrubber yet, so the raw content is matched.
  await writeFileAtomic(
    resolved,
    encodeText(next, decoded.encoding, decoded.hadBom, decoded.lineEnding),
    stats.mode,
  );
  const written = await fs.promises.stat(resolved);
  context.reads?.record(resolved, {
    mtimeMs: written.mtimeMs,
    size: written.size,
  });
  return { success: true, file_path: resolved, replacements };
}

export const editTool: ToolDefinition = defineTool<EditInput, ToolContext>({
  id: "edit-cli",
  llmId: "Edit",
  displayName: "Edit",
  description: "Replace exact text in an existing file.",
  inputSchema: editInputSchema,
  sideEffects: ["filesystem-read", "filesystem-write"],
  requiresConfirmation: false,
  visibleToUser: false,
  run: (input, context) => editFile(input, context),
});
