/**
 * `Execute` — the command runner.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B26 (input, defaults, the
 * `command` refusal), B27 (result shape, the 32 MiB inline cap), B28 (bash on
 * POSIX, PowerShell with its flags on Windows, stdin ignored), B29 (the
 * non-interactive environment), B30 (timeout accounting and tree kill) and B31
 * (fire-and-forget). Spec text that this build cannot honour carries a TODO.
 *
 * `TODO(spec 90 B15)`: `Execute` keeps a pipe child. The pinned pseudo-terminal
 * surface (B13-B22: login-shell environment, its blocklist and the PTY session
 * lifecycle) belongs to the daemon terminal, which this build does not spawn,
 * so there is no terminal to hand this command to.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";

import type { Environment } from "../../config/paths.ts";
import { isAbsolutePath } from "../../config/paths.ts";
import type { ToolContext } from "../context.ts";
import { OutputLimitError, ToolFailure } from "../errors.ts";
import { defineTool, type ToolDefinition } from "../registry.ts";
import { MAX_INLINE_OUTPUT_BYTES } from "../result.ts";
import type { ObjectSchema } from "../validate.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const SIGKILL_GRACE_MS = 250;

/** B29: the environment that stops interactive prompts launching. */
const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  SSH_ASKPASS: "",
  GIT_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  SUDO_ASKPASS: "",
};

const WINDOWS_PYTHON_UTF8_ENV: Readonly<Record<string, string>> = {
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
};

const POSIX_SHELL_ENV: Readonly<Record<string, string>> = {
  TERM: "dumb",
  PS1: "",
  DEBIAN_FRONTEND: "noninteractive",
};

export const executeInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    summary: {
      kind: "any",
      description: "A short sentence-case summary of what the command does.",
    },
    command: {
      kind: "string",
      description: "The command line to run in the platform shell.",
    },
    timeout: {
      kind: "number",
      optional: true,
      description: "Timeout in seconds (default 60).",
    },
    riskLevelReason: {
      kind: "any",
      optional: true,
      description: "Why the command carries its declared risk.",
    },
    riskLevel: {
      kind: "any",
      optional: true,
      description: "The model's declared impact: low, medium or high.",
    },
    fireAndForget: {
      kind: "boolean",
      optional: true,
      default: false,
      description: "Start the command in the background and return its PID.",
    },
  },
};

export interface ExecuteInput {
  readonly summary?: unknown;
  readonly command: string;
  readonly timeout?: number;
  readonly riskLevelReason?: unknown;
  readonly riskLevel?: unknown;
  readonly fireAndForget?: boolean;
}

export interface ExecResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stoppedProcesses: number;
  readonly timedOut: boolean;
  readonly pid?: number;
  readonly outputBytes?: number;
  readonly outputFile?: string;
}

export interface ExecOptions {
  /** Injected for tests; defaults to the OS temporary directory. */
  readonly tmpDir?: string;
  readonly now?: () => number;
}

function executablePath(environment: Environment): string {
  const root = environment.env.SystemRoot ?? "C:\\Windows";
  return nodePath.win32.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function taskkillPath(environment: Environment): string {
  const root = environment.env.SystemRoot ?? "C:\\Windows";
  return nodePath.win32.join(root, "System32", "taskkill.exe");
}

/** B28/B29: the environment the child receives. */
export function childEnvironment(
  environment: Environment,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment.env)) {
    if (value !== undefined) base[key] = value;
  }
  const platformEnv =
    environment.platform === "win32"
      ? WINDOWS_PYTHON_UTF8_ENV
      : POSIX_SHELL_ENV;
  return {
    ...base,
    PYTHONUNBUFFERED: "1",
    ...NON_INTERACTIVE_ENV,
    ...platformEnv,
  };
}

function killTree(child: ChildProcess, environment: Environment): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (environment.platform === "win32") {
    // Synchronous so the whole tree is gone before the caller treats the call
    // as finished; a surviving grandchild would keep the output pipe open.
    spawnSync(taskkillPath(environment), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    return true;
  }
  try {
    // The child leads its own process group, so the group signal reaches
    // every descendant (B30).
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, SIGKILL_GRACE_MS);
  escalation.unref();
  return true;
}

function startChild(
  input: ExecuteInput,
  context: ToolContext,
  outputFile?: string,
): ChildProcess {
  const environment = context.environment;
  const env = childEnvironment(environment);
  const outputHandle =
    outputFile === undefined ? undefined : fs.openSync(outputFile, "a");
  const stdio: Array<"ignore" | "pipe" | number> =
    outputHandle === undefined
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", outputHandle, outputHandle];
  try {
    if (environment.platform === "win32") {
      return spawn(
        executablePath(environment),
        [
          "-NoLogo",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          input.command,
        ],
        {
          cwd: context.root,
          env,
          stdio,
          shell: false,
          windowsHide: true,
          detached: outputFile !== undefined,
        },
      );
    }
    return spawn(input.command, [], {
      cwd: context.root,
      env,
      stdio,
      shell: "bash",
      windowsHide: true,
      // A detached leader owns its process group, which is what the tree kill
      // signals. `TODO(spec B28)`: the contract keeps `detached:false` on POSIX.
      detached: true,
    });
  } finally {
    if (outputHandle !== undefined) fs.closeSync(outputHandle);
  }
}

async function runForeground(
  input: ExecuteInput,
  context: ToolContext,
  timeoutSeconds: number,
): Promise<ExecResult> {
  const child = startChild(input, context);
  const pid = child.pid;
  const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
  let output = "";
  let outputBytes = 0;
  let stoppedProcesses = 0;
  let settled = false;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const stopChild = (): void => {
    if (killTree(child, context.environment)) stoppedProcesses += 1;
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    stopChild();
    reject(error);
  };

  timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    stopChild();
  }, timeoutSeconds * 1000);
  timer.unref();

  const collect = (chunk: Buffer): void => {
    if (settled) return;
    outputBytes += chunk.length;
    if (outputBytes > MAX_INLINE_OUTPUT_BYTES) {
      fail(new OutputLimitError(outputBytes, MAX_INLINE_OUTPUT_BYTES));
      return;
    }
    output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("error", (error: Error) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    reject(new ToolFailure(`Failed to start command: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    // A killed tree can leave a descendant holding the output pipe; once the
    // leader is gone the call is over, so do not wait for stdio to drain.
    if (settled || !timedOut) return;
    setTimeout(() => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        output,
        exitCode: null,
        signal: signal ?? "SIGKILL",
        stoppedProcesses,
        timedOut,
        ...(pid === undefined ? {} : { pid }),
      });
    }, 100).unref();
    void code;
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    resolve({
      output,
      exitCode: timedOut ? null : code,
      signal: timedOut ? (signal ?? "SIGKILL") : signal,
      stoppedProcesses,
      timedOut,
      ...(pid === undefined ? {} : { pid }),
    });
  });
  return await promise;
}

async function runBackground(
  input: ExecuteInput,
  context: ToolContext,
  options: ExecOptions,
): Promise<ExecResult> {
  const now = options.now ?? Date.now;
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const outputFile = nodePath.join(
    tmpDir,
    `droide-bg-${now()}-${randomUUID()}.out`,
  );
  const child = startChild(input, context, outputFile);
  child.unref();
  const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
  // `TODO(spec B31)`: no watchdog and no inner-PID/creation-time report yet;
  // the wrapper PID and the log path are what this build returns.
  child.once("error", (error: Error) => {
    reject(new ToolFailure(`Failed to start command: ${error.message}`));
  });
  child.once("spawn", () => {
    resolve({
      output: "",
      exitCode: 0,
      signal: null,
      stoppedProcesses: 0,
      timedOut: false,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      outputFile,
    });
  });
  return await promise;
}

/** Runs one command and returns B27's result. */
export async function executeCommand(
  input: ExecuteInput,
  context: ToolContext,
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new ToolFailure("command is required and must be a string");
  }
  if (!isAbsolutePath(context.environment.platform, context.root)) {
    throw new ToolFailure(
      `Working directory must be absolute: ${context.root}`,
    );
  }
  if (input.riskLevel === undefined) {
    // B9: an omitted risk level is denied separately, with its own guidance.
    // `TODO(spec B9)`: the exact wording is not quoted by the spec.
    throw new ToolFailure(
      'Execute call rejected: missing required parameter "riskLevel". ' +
        "Declare the command's impact as low, medium or high.",
    );
  }
  const timeoutSeconds = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ToolFailure("timeout must be a positive number of seconds");
  }
  return input.fireAndForget === true
    ? await runBackground(input, context, options)
    : await runForeground(input, context, timeoutSeconds);
}

export const executeTool: ToolDefinition = defineTool<
  ExecuteInput,
  ToolContext
>({
  id: "execute-cli",
  llmId: "Execute",
  displayName: "Execute",
  description: "Run a shell command.",
  inputSchema: executeInputSchema,
  sideEffects: ["process"],
  requiresConfirmation: false,
  visibleToUser: false,
  run: (input, context) => executeCommand(input, context),
});

/** Exported for the background tests: the same start path, no waiting. */
export { startChild };
