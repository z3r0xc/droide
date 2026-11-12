/** `doctor` command. Contract: `specs/10-cli-surface.md` §B49–B51, B74. */
import { Command } from "commander";

import { createAppContext } from "../../app/context.ts";
import { ConfigError } from "../../config/errors.ts";
import { parseChecks, parseTimeout } from "../../doctor/registry.ts";
import {
  exitCodeForReport,
  renderJson,
  renderText,
  runDoctor,
} from "../../doctor/run.ts";
import type { DoctorContext } from "../../doctor/types.ts";

const DEFAULT_NOTE = [
  "By default, doctor runs every check except inference, custom-models, mcp, and exec.",
  "MCP checks can start configured servers but call no tools.",
  "Model checks can use FSC or provider money. Exec also runs normal startup hooks.",
  "Example: droide doctor --checks config,connectivity,mcp",
].join("\n");

export interface DoctorCommandOptions {
  readonly json?: boolean;
  readonly verbose?: boolean;
  readonly timeout?: string;
  readonly checks?: string;
}

export interface DoctorCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  /** Injected for tests; defaults to the real context builder. */
  readonly loadContext?: () => Promise<DoctorContext>;
}

function timeoutError(label: string, timeoutMs: number): Error {
  const error = new Error(`${label} timed out after ${timeoutMs} ms`);
  error.name = "TimeoutError";
  return error;
}

async function defaultContext(): Promise<DoctorContext> {
  const app = await createAppContext();
  return {
    settings: {
      general: {
        theme: app.settings.theme,
        locale: app.settings.locale,
        worktreeDirectory: app.settings.worktreeDirectory,
      },
      mcp: app.settings.mcp,
      hooks: app.settings.hooks,
      skills: app.settings.skills,
    },
    paths: { ...app.paths },
    environment: {
      platform: process.platform,
      nodeVersion: process.versions.node,
      cwd: app.environment.cwd,
      home: app.environment.home,
      env: app.environment.env,
    },
    timeoutMs: 10_000,
    withTimeout: async (label, run) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        return await run(controller.signal);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Run the command with explicit dependencies so tests never spawn a process. */
export async function runDoctorCommand(
  options: DoctorCommandOptions,
  deps: DoctorCommandDeps,
): Promise<void> {
  let checks;
  let timeoutMs;
  try {
    checks = parseChecks(options.checks);
    timeoutMs = parseTimeout(options.timeout);
  } catch (error) {
    deps.writeError(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    deps.setExitCode(1);
    return;
  }

  let base: DoctorContext;
  try {
    base = await (deps.loadContext ?? defaultContext)();
  } catch (error) {
    if (error instanceof ConfigError) {
      deps.writeError(`${error.message}\n`);
      deps.setExitCode(1);
      return;
    }
    throw error;
  }

  const report = await runDoctor({
    checks,
    context: {
      ...base,
      timeoutMs,
      withTimeout: (label, run) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const timedOut = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(timeoutError(label, timeoutMs)),
            { once: true },
          );
        });
        return Promise.race([run(controller.signal), timedOut]).finally(() =>
          clearTimeout(timer),
        );
      },
    },
  });

  deps.write(
    options.json === true
      ? renderJson(report)
      : renderText(report, { verbose: options.verbose === true }),
  );
  deps.setExitCode(exitCodeForReport(report));
}

export function makeDoctorCommand(): Command {
  return new Command("doctor")
    .description(
      "Diagnose configuration, connectivity, certificate, proxy, auth, and daemon issues",
    )
    .option("--json", "Output results as JSON")
    .option(
      "--verbose",
      "Expand all checks with details, fixes, timings, and metadata",
    )
    .option(
      "--timeout <ms>",
      "Per-probe timeout in milliseconds, cleanup included (default: 10000; MCP server: 36000; exec full turn: 60000)",
    )
    .option(
      "--checks <names>",
      "Run only these comma-separated checks: config, environment, system, binaries, updates, filesystem, git, custom-models, proxy, certs, connectivity, auth, daemon, inference, mcp, exec. Use all to include checks that start servers or cost FSC or provider money",
    )
    .addHelpText("after", `\n${DEFAULT_NOTE}\n`)
    .action((options: DoctorCommandOptions) => {
      void runDoctorCommand(options, {
        write: (text) => process.stdout.write(text),
        writeError: (text) => process.stderr.write(text),
        setExitCode: (code) => {
          process.exitCode = code;
        },
      });
    });
}
