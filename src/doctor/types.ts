/**
 * `doctor` result model.
 *
 * Contract: `specs/10-cli-surface.md` §B49–B51, B74 and the error table entry
 * E18. A check never throws: it reports `ok`, `warn`, `fail` or `skip`, and the
 * report — not the check — decides the exit code.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  readonly status: CheckStatus;
  /** One line, shown in both renderers. */
  readonly summary: string;
  /** Extra lines, shown only with `--verbose`; ordered. */
  readonly details?: readonly string[];
  /** Actionable remedies, shown only with `--verbose`. */
  readonly fixes?: readonly string[];
  /** Machine-readable facts for `--json`. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  /** Wall-clock milliseconds, filled by the runner. */
  readonly durationMs?: number;
}

export interface DoctorContext {
  /** Resolved settings and paths for this process. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly paths: Readonly<Record<string, string>>;
  /** Injected so checks never read the process environment directly. */
  readonly environment: {
    readonly platform: string;
    readonly nodeVersion: string;
    readonly cwd: string;
    readonly home: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  /** Per-probe budget in milliseconds. */
  readonly timeoutMs: number;
  /** Runs a probe with the budget applied; rejects with a timeout error. */
  readonly withTimeout: <T>(
    label: string,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

export interface DoctorCheck {
  readonly name: string;
  readonly title: string;
  run(context: DoctorContext): Promise<CheckResult>;
}

export interface CheckReport {
  readonly name: string;
  readonly title: string;
  readonly result: CheckResult;
}

export interface DoctorReport {
  readonly checks: readonly CheckReport[];
  readonly status: CheckStatus;
  readonly durationMs: number;
}

/** Any failure, or an incomplete run, makes the report "not ok". */
export function overallStatus(results: readonly CheckReport[]): CheckStatus {
  if (results.some((entry) => entry.result.status === "fail")) return "fail";
  if (results.some((entry) => entry.result.status === "skip")) return "warn";
  if (results.some((entry) => entry.result.status === "warn")) return "warn";
  return "ok";
}

/**
 * Only a failure fails the command.
 *
 * A `warn` is an actionable finding (or an unimplemented probe, which the report
 * shows explicitly) and a `skip` is an incomplete probe; neither means the
 * environment is broken, so neither turns a health check into a non-zero exit.
 */
export function exitCodeFor(status: CheckStatus): number {
  return status === "fail" ? 1 : 0;
}
