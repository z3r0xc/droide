/**
 * Spawn helper for tests that observe the CLI as a process.
 *
 * Calls use an argument array (never a shell string) and a pinned environment,
 * so nothing about the host terminal leaks into an assertion. Piped stdin is
 * what the non-TTY refusal depends on, so every call supplies empty `input`.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** Repository root, three levels above `tests/unit/cli`. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** The entry point under test; the same file `bin/droide.mjs` runs. */
export const MAIN_ENTRY = resolve(REPO_ROOT, "src/main.ts");

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Environment pinned for every spawn. `TERM_PROGRAM` and `CLI_VERSION` are
 * absent on purpose: the refusal and the version string must not depend on them.
 */
const PINNED_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  TERM: "dumb",
  COLUMNS: "80",
  TZ: "UTC",
};

/**
 * Windows cannot start a child without its system directory. These values
 * differ per host but never reach the CLI's output, so they do not make a test
 * depend on where it runs.
 */
function hostSystemDirs(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of ["SYSTEMROOT", "windir"] as const) {
    const value = process.env[name];
    if (value !== undefined) vars[name] = value;
  }
  return vars;
}

/** Run `node` with the given arguments and the pinned environment. */
export function runNode(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...PINNED_ENV, ...hostSystemDirs() },
    input: "",
    timeout: 60_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null) {
    throw new Error(
      `node exited by signal ${String(result.signal)} for ${args.join(" ")}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Run the CLI entry point with the given arguments. */
export function runCli(args: readonly string[]): CliResult {
  return runNode([MAIN_ENTRY, ...args]);
}
