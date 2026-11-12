/**
 * `Glob` — file discovery by glob pattern.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B19: patterns as a string or an
 * array, excludes, an absolute folder, hidden files included, at most 1000
 * paths, the empty-pattern refusal, the credential-floor exclusions applied
 * last, and `No matching files found` for an empty result.
 */
import * as fs from "node:fs";

import type { ToolContext } from "../context.ts";
import { ToolFailure } from "../errors.ts";
import { defineTool, type ToolDefinition } from "../registry.ts";
import { parseStringList, type ObjectSchema } from "../validate.ts";
import { matchesGlob } from "./glob-match.ts";
import { isCredentialFile, resolveInputPath } from "./paths.ts";
import { walkFiles } from "./walk.ts";

const MAX_GLOB_RESULTS = 1000;

export const globInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    patterns: {
      kind: "union",
      options: [
        { kind: "string", description: "A glob pattern." },
        {
          kind: "array",
          items: { kind: "string" },
          description: "An array of glob patterns.",
        },
      ],
      description: 'A glob pattern or array of patterns, e.g. "*.ts".',
    },
    excludePatterns: {
      kind: "union",
      optional: true,
      options: [
        { kind: "string", description: "A glob pattern to exclude." },
        {
          kind: "array",
          items: { kind: "string" },
          description: "An array of glob patterns to exclude.",
        },
      ],
      description: "Patterns to exclude from the result.",
    },
    folder: {
      kind: "string",
      optional: true,
      description:
        "Absolute path of the directory to search; defaults to the workspace root.",
    },
  },
};

export interface GlobInput {
  readonly patterns: string | readonly string[];
  readonly excludePatterns?: string | readonly string[];
  readonly folder?: string;
}

function cleanPatterns(value: string | readonly string[] | undefined): string[] {
  return (parseStringList(value) ?? [])
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/** Every file under `folder` matching the include/exclude matrix (B19). */
export async function globFiles(
  input: GlobInput,
  context: ToolContext,
): Promise<string[] | string> {
  const includes = cleanPatterns(input.patterns);
  if (includes.length === 0) {
    throw new ToolFailure(
      "At least one pattern is required for glob search. Please provide a glob " +
        "pattern string or an array of glob patterns.",
    );
  }
  const excludes = cleanPatterns(input.excludePatterns);
  const folder =
    input.folder === undefined
      ? context.root
      : resolveInputPath(context, input.folder, { requireAbsolute: true });

  const stats = await fs.promises.stat(folder).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolFailure(`Folder does not exist: ${folder}`);
    }
    throw error;
  });
  if (!stats.isDirectory()) {
    throw new ToolFailure(`Folder is not a directory: ${folder}`);
  }

  const matches: string[] = [];
  for (const entry of await walkFiles(folder)) {
    if (!includes.some((pattern) => matchesGlob(entry.relative, pattern))) {
      continue;
    }
    if (excludes.some((pattern) => matchesGlob(entry.relative, pattern))) {
      continue;
    }
    // The credential floor is applied last and cannot be re-included (B19).
    if (isCredentialFile(entry.absolute, context.environment)) continue;
    matches.push(entry.absolute);
    if (matches.length >= MAX_GLOB_RESULTS) break;
  }
  if (matches.length === 0) return "No matching files found";
  return matches;
}

/** The user-facing rendering when a caller wants text rather than paths. */
export function formatGlobResult(result: string[] | string): string {
  return Array.isArray(result) ? result.join("\n") : result;
}

export const globTool: ToolDefinition = defineTool<GlobInput, ToolContext>({
  id: "glob-search-cli",
  llmId: "Glob",
  displayName: "Glob",
  description: "Find files whose paths match a glob pattern.",
  inputSchema: globInputSchema,
  sideEffects: ["filesystem-read"],
  requiresConfirmation: false,
  visibleToUser: true,
  run: (input, context) => globFiles(input, context),
});
