/**
 * Non-interactive refusal.
 *
 * Contract: `specs/10-cli-surface.md` §B17 (text) and ADR 0005 (the program token
 * is ours). A launch that carries a prompt while stdin is not a terminal must
 * refuse: the interactive UI would start a session nobody can steer, and a
 * mistyped command word lands here as a prompt.
 */
import { PROGRAM } from "./brand.ts";

export interface RefusalContext {
  /** The first token that was interpreted as prompt text, when there was one. */
  readonly promptWord?: string;
  /** `TERM_PROGRAM`, used to add the mintty hint. */
  readonly termProgram?: string;
}

/** The fixed body: three lines, no trailing newline. */
export const REQUIRES_TERMINAL = [
  `${PROGRAM} requires a terminal for interactive mode, but stdin is not one.`,
  `  • Over SSH, add -t to allocate one: ssh -t <host> ${PROGRAM}`,
  `  • To run a prompt without a terminal, use ${PROGRAM} exec: ${PROGRAM} exec "<prompt>"`,
].join("\n");

export function refusalLines(context: RefusalContext): string[] {
  const lines: string[] = [REQUIRES_TERMINAL];
  if (context.termProgram === "mintty") {
    lines.push(`  • In mintty, run ${PROGRAM} through winpty: winpty ${PROGRAM}`);
  }
  if (context.promptWord !== undefined) {
    lines.push(
      `  • "${context.promptWord}" is not a ${PROGRAM} command, so ${PROGRAM} read it as a prompt.` +
        ` Run ${PROGRAM} --help to list commands.`,
    );
  }
  return lines;
}

export function writeRefusal(context: RefusalContext, write: (text: string) => void): void {
  write(`${refusalLines(context).join("\n")}\n`);
}