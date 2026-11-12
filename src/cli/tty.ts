/**
 * Non-interactive refusal.
 *
 * Contract: `specs/10-cli-surface.md`. A launch that carries a prompt while
 * stdin is not a terminal must refuse: the interactive UI would start a session
 * nobody can steer, and a mistyped command word lands here as a prompt.
 *
 * Strings are the subject's English catalogue entries (`commands:tui.*`), which
 * the recorded goldens pin byte-for-byte.
 */
export interface RefusalContext {
  /** The first token that was interpreted as prompt text, when there was one. */
  readonly promptWord?: string;
  /** `TERM_PROGRAM`, used to add the mintty hint. */
  readonly termProgram?: string;
}

export const REQUIRES_TERMINAL = [
  "droid requires a terminal for interactive mode, but stdin is not one.",
  "  • Over SSH, add -t to allocate one: ssh -t <host> droid",
  '  • To run a prompt without a terminal, use droid exec: droid exec "<prompt>"',
].join("\n");

export function refusalLines(context: RefusalContext): string[] {
  const lines: string[] = [REQUIRES_TERMINAL];
  if (context.termProgram === "mintty") {
    lines.push("  • In mintty, run droid through winpty: winpty droid");
  }
  if (context.promptWord !== undefined) {
    lines.push(
      `  • "${context.promptWord}" is not a droid command, so droid read it as a prompt.` +
        " Run droid --help to list commands.",
    );
  }
  return lines;
}

export function writeRefusal(context: RefusalContext, write: (text: string) => void): void {
  write(`${refusalLines(context).join("\n")}\n`);
}