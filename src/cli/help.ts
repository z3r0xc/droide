/**
 * Static help blocks and shared option groups.
 *
 * Contract: `specs/10-cli-surface.md`. Commander renders usage, options and
 * commands; the subject adds two kinds of extra block, which are formatted here:
 * an aligned `Examples:` table and a literal footer paragraph.
 */
import type { Command } from "commander";

export type Row = readonly [term: string, description: string];

/**
 * Format aligned rows for a static help block.
 *
 * `gap` is the padding between the longest term and its description. The
 * recorded goldens put the examples description column four characters after
 * the longest example term.
 */
export function formatRows(rows: readonly Row[], gap = 6): string {
  let width = 0;
  for (const [term] of rows) width = Math.max(width, term.length);
  return rows
    .map(([term, description]) =>
      description.length > 0
        ? `  ${term.padEnd(width + gap)}${description}`
        : `  ${term}`,
    )
    .join("\n");
}

/** Build the `Examples:` block, including its heading. */
export function examplesBlock(rows: readonly Row[]): string {
  return `Examples:\n${formatRows(rows)}`;
}

/** Options every session-launching command shares, in the subject's order. */
export function addRuntimeOptions(command: Command): Command {
  return command
    .option(
      "--settings <path>",
      "Path to runtime settings file merged for this process only",
    )
    .option(
      "--append-system-prompt <text>",
      "Append custom text to the end of the system prompt",
    )
    .option(
      "--append-system-prompt-file <path>",
      "Append file contents to the end of the system prompt",
    )
    .option("--cwd <path>", "Working directory path")
    .option("-w, --worktree [name]", "Run in a git worktree")
    .option(
      "--worktree-dir <path>",
      "Deprecated: set the worktree directory in the Factory desktop app instead",
    )
    .option("--auto <level>", "Autonomy level: low|medium|high")
    .option("--use-spec", "Start in spec mode")
    .option(
      "--disable-builtin-skills",
      "Disable Factory-provided builtin skills",
    );
}
