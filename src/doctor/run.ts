/**
 * `doctor` runner and renderers.
 *
 * Contract: `specs/10-cli-surface.md` §B49–B51, B74. The runner is the only
 * place that decides exit codes; the renderers are pure.
 */
import { BUILTIN_CHECKS } from "./checks.ts";
import type {
  CheckReport,
  CheckResult,
  DoctorCheck,
  DoctorContext,
  DoctorReport,
} from "./types.ts";
import { exitCodeFor, overallStatus } from "./types.ts";

export interface RunDoctorOptions {
  /** Check names to run; validation happens in `parseChecks` for the CLI. */
  readonly checks: readonly string[];
  readonly context: DoctorContext;
  readonly catalogue?: readonly DoctorCheck[];
}

/** Run the selected checks in catalogue order, bounded by the probe budget. */
export async function runDoctor(
  options: RunDoctorOptions,
): Promise<DoctorReport> {
  const catalogue = options.catalogue ?? BUILTIN_CHECKS;
  const wanted = new Set(options.checks);
  const selected = catalogue.filter((check) => wanted.has(check.name));
  const startedAt = Date.now();
  const reports: CheckReport[] = [];

  for (const check of selected) {
    const started = Date.now();
    let result: CheckResult;
    try {
      result = await check.run(options.context);
    } catch (error) {
      result = {
        status: "fail",
        summary: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.name === "TimeoutError"
          ? { fixes: ["raise --timeout"] }
          : {}),
      };
    }
    reports.push({
      name: check.name,
      title: check.title,
      result: { ...result, durationMs: Date.now() - started },
    });
  }

  return {
    checks: reports,
    status: overallStatus(reports),
    durationMs: Date.now() - startedAt,
  };
}

export function exitCodeForReport(report: DoctorReport): number {
  return exitCodeFor(report.status);
}

const MARKER: Readonly<Record<CheckResult["status"], string>> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
  skip: "skip",
};

export interface TextOptions {
  readonly verbose: boolean;
}

/** Human-readable report: one line per check, details behind `--verbose`. */
export function renderText(report: DoctorReport, options: TextOptions): string {
  const lines: string[] = [
    `doctor: ${report.status} (${report.durationMs} ms, ${report.checks.length} checks)`,
  ];
  for (const entry of report.checks) {
    const timing =
      options.verbose && entry.result.durationMs !== undefined
        ? ` (${entry.result.durationMs} ms)`
        : "";
    lines.push(
      `  ${MARKER[entry.result.status]} ${entry.name}: ${entry.result.summary}${timing}`,
    );
    if (!options.verbose) continue;
    for (const detail of entry.result.details ?? [])
      lines.push(`        ${detail}`);
    for (const fix of entry.result.fixes ?? [])
      lines.push(`        fix: ${fix}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Machine-readable report; keys are stable and ordered. */
export function renderJson(report: DoctorReport): string {
  const payload = {
    status: report.status,
    durationMs: report.durationMs,
    checks: report.checks.map((entry) => ({
      name: entry.name,
      title: entry.title,
      status: entry.result.status,
      summary: entry.result.summary,
      durationMs: entry.result.durationMs ?? 0,
      ...(entry.result.details === undefined
        ? {}
        : { details: entry.result.details }),
      ...(entry.result.fixes === undefined
        ? {}
        : { fixes: entry.result.fixes }),
      ...(entry.result.metadata === undefined
        ? {}
        : { metadata: entry.result.metadata }),
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
