/**
 * Commands that are registered but not yet implemented.
 *
 * Contract: `docs/plan.md` — M1 covers the CLI surface; behaviour arrives in
 * later milestones behind their own specs. This is deliberately loud: an
 * unimplemented command says so and fails, it never pretends to succeed.
 */
export const NOT_IMPLEMENTED_EXIT = 64;

export function notImplemented(command: string): never {
  process.stderr.write(
    `droide: the "${command}" command is specified but not implemented in this build.\n`,
  );
  process.exit(NOT_IMPLEMENTED_EXIT);
}
