/** Command router. Contract: `specs/10-cli-surface.md`. */
import { Command } from "commander";

import { makeRootCommand } from "./commands/root.ts";

/**
 * Commander signals normal termination (`--help`, `--version`) and parse errors
 * by throwing an error that carries a numeric `exitCode`. Anything else is a
 * real failure and must propagate.
 */
function exitCodeOf(error: unknown): number | undefined {
  if (error !== null && typeof error === "object" && "exitCode" in error) {
    const { exitCode } = error;
    return typeof exitCode === "number" ? exitCode : undefined;
  }
  return undefined;
}

export async function run(argv: readonly string[]): Promise<void> {
  const program = makeRootCommand(new Command());
  program.exitOverride();

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    const code = exitCodeOf(error);
    if (code === undefined) throw error;
    process.exitCode = code;
  }
}
