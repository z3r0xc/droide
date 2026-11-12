/**
 * `Create` — atomic file writes.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B21 (content required, a directory
 * target is an error, an existing file is overwritten, a trailing newline is
 * ensured, line endings follow the file), B24 (protected-write guard on the
 * given and resolved paths) and B25 (temp file + rename, symlink and
 * permission preserving).
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import type { ToolContext } from "../context.ts";
import { ToolFailure } from "../errors.ts";
import { defineTool, type ToolDefinition } from "../registry.ts";
import type { ObjectSchema } from "../validate.ts";
import {
  decodeText,
  detectLineEnding,
  encodeText,
  normalizeToLF,
  type LineEnding,
  type TextEncoding,
} from "./encoding.ts";
import {
  assertNoSymlinkEscape,
  assertWritablePath,
  resolveInputPath,
} from "./paths.ts";

export const createInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    file_path: {
      kind: "string",
      description: "The path of the file to create or overwrite.",
    },
    content: {
      kind: "string",
      description: "The complete content of the file.",
    },
  },
};

export interface CreateInput {
  readonly file_path: string;
  readonly content: string;
}

export interface CreateResult {
  readonly success: true;
  readonly file_path: string;
  readonly created: boolean;
}

let temporaryCounter = 0;

/**
 * Writes `data` to `target` through a temp file in the same directory and a
 * rename, so a failed write never leaves a partial file behind. The temp file
 * is removed on any failure.
 */
export async function writeFileAtomic(
  target: string,
  data: Buffer,
  mode?: number,
): Promise<void> {
  const directory = nodePath.dirname(target);
  temporaryCounter += 1;
  const temporary = nodePath.join(
    directory,
    `.${nodePath.basename(target)}.${process.pid}.${temporaryCounter}.tmp`,
  );
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporary, target);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** The real write target: a symlink is followed so the link survives (B25). */
async function writeTarget(resolved: string): Promise<string> {
  try {
    const stats = await fs.promises.lstat(resolved);
    return stats.isSymbolicLink()
      ? await fs.promises.realpath(resolved)
      : resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
}

async function existingFile(resolved: string): Promise<
  | {
      readonly exists: true;
      readonly encoding: TextEncoding;
      readonly hadBom: boolean;
      readonly lineEnding: LineEnding;
      readonly mode: number;
    }
  | { readonly exists: false }
> {
  try {
    const stats = await fs.promises.stat(resolved);
    const decoded = decodeText(await fs.promises.readFile(resolved));
    return {
      exists: true,
      encoding: decoded.encoding,
      hadBom: decoded.hadBom,
      lineEnding: decoded.lineEnding,
      mode: stats.mode,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

/** Creates or overwrites `file_path` atomically (B21). */
export async function createFile(
  input: CreateInput,
  context: ToolContext,
): Promise<CreateResult> {
  const resolved = resolveInputPath(context, input.file_path);
  assertWritablePath(context, input.file_path, resolved);
  if (isExistingDirectory(resolved)) {
    throw new ToolFailure(
      `Error: Cannot create file at "${resolved}" because a directory already exists there.`,
    );
  }
  assertNoSymlinkEscape(context, input.file_path, resolved);

  const target = await writeTarget(resolved);
  assertWritablePath(context, input.file_path, target);
  const previous = await existingFile(target);
  // A new file keeps the model's line endings; an overwrite keeps the file's.
  const lineEnding = previous.exists
    ? previous.lineEnding
    : detectLineEnding(input.content);
  const normalized = normalizeToLF(input.content);
  const withTrailingNewline = normalized.endsWith("\n")
    ? normalized
    : `${normalized}\n`;
  const encoding: TextEncoding = previous.exists ? previous.encoding : "utf-8";
  const hadBom = previous.exists ? previous.hadBom : false;

  await writeFileAtomic(
    target,
    encodeText(withTrailingNewline, encoding, hadBom, lineEnding),
    previous.exists ? previous.mode : undefined,
  );
  const written = await fs.promises.stat(target);
  const record = { mtimeMs: written.mtimeMs, size: written.size };
  context.reads?.record(resolved, record);
  if (target !== resolved) context.reads?.record(target, record);
  return { success: true, file_path: resolved, created: !previous.exists };
}

function isExistingDirectory(resolved: string): boolean {
  try {
    return fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

export const createTool: ToolDefinition = defineTool<CreateInput, ToolContext>({
  id: "create-cli",
  llmId: "Create",
  displayName: "Create",
  description: "Create or overwrite a file with the given content.",
  inputSchema: createInputSchema,
  sideEffects: ["filesystem-write"],
  requiresConfirmation: false,
  visibleToUser: false,
  run: (input, context) => createFile(input, context),
});