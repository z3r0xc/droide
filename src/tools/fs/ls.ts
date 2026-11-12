/**
 * `LS` — directory listing.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B18: `directory_path` (absolute;
 * omitted or `.` means the workspace root), `ignorePatterns`, entries sorted by
 * name without `.`/`..`, each with `name`, `type` from `lstat` and `size`.
 * Denied entries are concealed; a listing that cannot be enumerated is refused
 * rather than shown unfiltered.
 */
import * as fs from "node:fs";

import { joinPath } from "../../config/paths.ts";

import type { ToolContext } from "../context.ts";
import { ToolFailure } from "../errors.ts";
import { defineTool, type ToolDefinition } from "../registry.ts";
import type { ObjectSchema } from "../validate.ts";
import { matchesEntryPattern } from "./glob-match.ts";
import { isCredentialFile, resolveInputPath } from "./paths.ts";

export const lsInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    directory_path: {
      kind: "string",
      optional: true,
      description:
        "Absolute path of the directory to list; omitted or `.` lists the workspace root.",
    },
    ignorePatterns: {
      kind: "array",
      optional: true,
      items: { kind: "string" },
      description: 'Glob patterns to ignore, e.g. ["node_modules/**", "*.log"].',
    },
  },
};

export interface LsInput {
  readonly directory_path?: string;
  readonly ignorePatterns?: readonly string[];
}

export interface DirectoryEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
}

function entryType(dirent: fs.Dirent): DirectoryEntry["type"] {
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  return "other";
}

/** Entries of one directory, sorted, concealed and typed (B18). */
export async function listDirectory(
  input: LsInput,
  context: ToolContext,
): Promise<DirectoryEntry[]> {
  const requested = input.directory_path;
  const target =
    requested === undefined || requested === "" || requested === "."
      ? context.root
      : resolveInputPath(context, requested, { requireAbsolute: true });

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolFailure(`Directory does not exist: ${target}`);
    }
    throw new ToolFailure(
      `Failed to list ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new ToolFailure(`Not a directory: ${target}`);
  }

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(target, { withFileTypes: true });
  } catch (error) {
    // A listing that cannot be enumerated is refused, never shown unfiltered.
    throw new ToolFailure(
      `Failed to list ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const ignore = input.ignorePatterns ?? [];
  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (ignore.some((pattern) => matchesEntryPattern(dirent.name, pattern))) {
      continue;
    }
    const absolute = joinPath(context.environment.platform, target, dirent.name);
    if (isCredentialFile(absolute, context.environment)) continue;
    try {
      const entryStats = await fs.promises.lstat(absolute);
      entries.push({
        name: dirent.name,
        type: entryType(dirent),
        size: entryStats.size,
      });
    } catch (error) {
      // Removed between readdir and lstat: there is no entry to report.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return entries;
}

export const lsTool: ToolDefinition = defineTool<LsInput, ToolContext>({
  id: "ls-cli",
  llmId: "LS",
  displayName: "LS",
  description: "List the entries of a directory.",
  inputSchema: lsInputSchema,
  sideEffects: ["filesystem-read"],
  requiresConfirmation: false,
  visibleToUser: false,
  run: (input, context) => listDirectory(input, context),
});