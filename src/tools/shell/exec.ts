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

/** B31: how long a Windows launch waits for the wrapper's pid line. */
const WINDOWS_LAUNCH_BUDGET_MS = 2_000;
/** B31: the hard bound on a wrapper that neither answers nor exits. */
const WINDOWS_LAUNCH_HARD_CAP_MS = 10_000;
const WINDOWS_LAUNCH_POLL_MS = 50;

/** B31: set to `1`/`true` to keep background children after the CLI exits. */
export const PRESERVE_BACKGROUND_PROCESSES_ENV =
  "DROIDE_PRESERVE_BACKGROUND_PROCESSES";

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
  /** B31 (Windows): the inner process's creation time as a FILETIME token. */
  readonly startToken?: string;
}

/** B31: the CLI's exit hook, injected so a test decides when the CLI ends. */
export type ExitHook = (handler: () => void) => void;

export interface ExecOptions {
  /** Injected for tests; defaults to the OS temporary directory. */
  readonly tmpDir?: string;
  readonly now?: () => number;
  /** B31: keep background children alive after the CLI exits. */
  readonly preserveBackgroundProcesses?: boolean;
  /** B31: installs the exit hook; defaults to `process.once("exit", …)`. */
  readonly onExit?: ExitHook;
  /** B31: the signal the watchdog sends; defaults to `process.kill`. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** B31: the Windows tree stop; defaults to `taskkill /T /F`. */
  readonly stopTree?: (pid: number) => void;
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

/**
 * B31: whether a background child outlives the CLI. The option wins when the
 * caller passes it; otherwise the environment flag decides.
 */
export function backgroundPreserved(
  options: Pick<ExecOptions, "preserveBackgroundProcesses">,
  environment: Environment,
): boolean {
  if (options.preserveBackgroundProcesses !== undefined) {
    return options.preserveBackgroundProcesses;
  }
  const value =
    environment.env[PRESERVE_BACKGROUND_PROCESSES_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** The Windows tree kill: synchronous, so a dying CLI leaves nothing behind. */
function stopTreeByPid(pid: number, environment: Environment): void {
  spawnSync(taskkillPath(environment), ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 10_000,
  });
}

/**
 * B31: the stop action for one background launch. POSIX signals the process
 * group the child leads; Windows sweeps the tree, because it has no group
 * signal. Both are synchronous: the CLI's exit hook cannot await anything.
 */
export function backgroundStopper(
  pid: number,
  environment: Environment,
  seams: Pick<ExecOptions, "kill" | "stopTree"> = {},
): () => boolean {
  if (environment.platform === "win32") {
    const stopTree =
      seams.stopTree ??
      ((target: number) => stopTreeByPid(target, environment));
    return () => {
      stopTree(pid);
      return true;
    };
  }
  const signal =
    seams.kill ??
    ((target: number, name: NodeJS.Signals) => {
      process.kill(target, name);
    });
  return () => {
    try {
      signal(-pid, "SIGKILL");
    } catch {
      try {
        signal(pid, "SIGKILL");
      } catch {
        return false;
      }
    }
    return true;
  };
}

export interface BackgroundWatchdogOptions extends Pick<
  ExecOptions,
  "kill" | "stopTree" | "onExit"
> {
  readonly environment: Environment;
  /** The group leader (POSIX) or the inner process (Windows). */
  readonly pid: number | undefined;
  readonly preserve: boolean;
}

/**
 * B31: install the one exit hook that stops a background launch. Returns the
 * installed stop, or `undefined` when nothing was registered — because the
 * launch has no PID, or because background processes are preserved.
 */
export function installBackgroundWatchdog(
  options: BackgroundWatchdogOptions,
): (() => boolean) | undefined {
  const pid = options.pid;
  if (options.preserve || pid === undefined) return undefined;
  const stop = backgroundStopper(pid, options.environment, options);
  const onExit =
    options.onExit ??
    ((handler: () => void) => {
      process.once("exit", handler);
    });
  onExit(stop);
  return stop;
}

/** The inner process a Windows background wrapper started. */
export interface WindowsBackgroundLaunch {
  readonly pid: number;
  /** `$p.StartTime.ToFileTimeUtc()`: the creation time, not the start order. */
  readonly startToken: string;
}

/**
 * B31: parses the one line the Windows background wrapper prints, `<pid>
 * <filetime>`. Each line must match exactly — a warning or a half-written
 * number is not a launch — and while the wrapper still runs only a terminated
 * line counts, so a chunk that split mid-number is rejected until the rest
 * arrives. Once the wrapper has exited its stdout is complete and callers pass
 * `false` to accept a final line without a newline.
 */
export function parseWindowsBackgroundLaunch(
  stdout: string,
  requireLineTerminator: boolean,
): WindowsBackgroundLaunch | null {
  const lines = stdout.split(/\r?\n/);
  // Splitting leaves the unterminated remainder; drop it while it is short.
  const complete = requireLineTerminator ? lines.slice(0, -1) : lines;
  for (const line of complete) {
    const match = /^(\d+)[ \t]+(\d+)$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (pid > 0) return { pid, startToken: match[2]! };
  }
  return null;
}

/** PowerShell single-quoted literal: the only escaping that applies inside. */
function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface WindowsBackgroundStart {
  readonly child: ChildProcess;
  readonly launched: Promise<{
    readonly pid?: number;
    readonly startToken?: string;
  }>;
}

/**
 * B31: starts a fire-and-forget command through a PowerShell wrapper that
 * reports the inner process. The user's command is written to a temporary
 * `.ps1` file, so the wrapper's command line contains only paths this module
 * produced (each quoted), and the script merges every stream into one UTF-8
 * log before the wrapper prints `$p.Id` and the creation time.
 */
function startWindowsBackground(
  input: ExecuteInput,
  context: ToolContext,
  outputFile: string,
  tmpDir: string,
  now: () => number,
): WindowsBackgroundStart {
  const environment = context.environment;
  const powershell = executablePath(environment);
  const scriptPath = nodePath.join(
    tmpDir,
    `droide-bg-${now()}-${randomUUID()}.ps1`,
  );
  fs.writeFileSync(
    scriptPath,
    `& { ${input.command} } *>&1 | Out-File -FilePath ${powerShellQuote(
      outputFile,
    )} -Encoding utf8\n`,
    "utf8",
  );
  // Start-Process joins `-ArgumentList` with spaces without quoting, so the
  // script path carries its own double quotes.
  const scriptArgument = `"${scriptPath.replace(/"/g, '""')}"`;
  const innerArgs = [
    "-NoLogo",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptArgument,
  ]
    .map(powerShellQuote)
    .join(", ");
  const wrapper =
    `$p = Start-Process -FilePath ${powerShellQuote(powershell)} ` +
    `-ArgumentList @(${innerArgs}) -NoNewWindow -PassThru; ` +
    'Write-Output "$($p.Id) $($p.StartTime.ToFileTimeUtc())"';
  const child = spawn(
    powershell,
    [
      "-NoLogo",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      wrapper,
    ],
    {
      cwd: context.root,
      env: childEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
  );
  const { promise, resolve, reject } = Promise.withResolvers<
    WindowsBackgroundLaunch | undefined
  >();
  const startedAt = now();
  let stdout = "";
  let settled = false;
  let exited = false;
  const fallback = (): WindowsBackgroundLaunch | undefined =>
    child.pid === undefined ? undefined : { pid: child.pid, startToken: "" };
  const settle = (launch: WindowsBackgroundLaunch | undefined): void => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    // `-NoNewWindow` hands the wrapper's stdout/stderr handles to the inner
    // process, so the pipes stay open for as long as the background command
    // runs. The line has been read by now; dropping the streams is what lets
    // the CLI exit instead of waiting on a child it no longer observes.
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolve(launch);
  };
  // The budget is read on the injected clock, so a test never waits for it. A
  // wrapper that exited is complete, so its line is parsed even when it came
  // after the budget; a wrapper still starting is our own helper and gets the
  // hard cap, because settling early would leak a process nobody can stop.
  const poll = setInterval(() => {
    if (exited) {
      settle(parseWindowsBackgroundLaunch(stdout, false) ?? fallback());
      return;
    }
    const elapsed = now() - startedAt;
    if (elapsed >= WINDOWS_LAUNCH_BUDGET_MS && stdout.trim() !== "") {
      // The shell answered, but not with a complete launch line: two numbers
      // is the whole protocol, and a half-written one is not a launch.
      settle(parseWindowsBackgroundLaunch(stdout, true) ?? fallback());
      return;
    }
    if (elapsed >= WINDOWS_LAUNCH_HARD_CAP_MS) {
      settle(parseWindowsBackgroundLaunch(stdout, true) ?? fallback());
    }
  }, WINDOWS_LAUNCH_POLL_MS);
  poll.unref();
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    const launch = parseWindowsBackgroundLaunch(stdout, !exited);
    if (launch !== null) settle(launch);
  });
  child.stderr?.on("data", () => {
    // The wrapper's errors are not part of the launch line; a wrapper that
    // fails exits without one and the fallback reports the wrapper PID.
  });
  child.once("error", (error: Error) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    reject(new ToolFailure(`Failed to start command: ${error.message}`));
  });
  child.once("exit", () => {
    // Stdout can still deliver buffered chunks after `exit`, so the poll
    // parses the complete buffer one tick later instead of here.
    exited = true;
  });
  child.unref();
  return {
    child,
    launched: promise.then((launch) =>
      launch === undefined
        ? {}
        : launch.startToken === ""
          ? { pid: launch.pid }
          : { pid: launch.pid, startToken: launch.startToken },
    ),
  };
}

function killTree(child: ChildProcess, environment: Environment): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (environment.platform === "win32") {
    stopTreeByPid(pid, environment);
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
    const script =
      outputFile === undefined
        ? input.command
        : // B31: `exec` replaces the spawned shell, so the PID this build
          // tracks and stops is the command's own, and the group is its own.
          `exec nohup bash -c '${input.command.replace(/'/g, "'\\''")}'`;
    return spawn(script, [], {
      cwd: context.root,
      env,
      stdio,
      shell: "bash",
      windowsHide: true,
      // A detached leader owns its process group, which is what the tree kill
      // signals (B28's one exception to `detached:false`).
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
  const preserve = backgroundPreserved(options, context.environment);
  const watch = (pid: number | undefined): void => {
    installBackgroundWatchdog({
      environment: context.environment,
      pid,
      preserve,
      ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
      ...(options.kill === undefined ? {} : { kill: options.kill }),
      ...(options.stopTree === undefined ? {} : { stopTree: options.stopTree }),
    });
  };
  if (context.environment.platform === "win32") {
    // B31: the inner process is the one to report and to stop; the wrapper
    // is gone by the time the caller reads the result.
    const launched = await startWindowsBackground(
      input,
      context,
      outputFile,
      tmpDir,
      now,
    ).launched;
    if (launched.pid === undefined) {
      throw new ToolFailure("Failed to start command: no process was created");
    }
    watch(launched.pid);
    return {
      output: "",
      exitCode: 0,
      signal: null,
      stoppedProcesses: 0,
      timedOut: false,
      pid: launched.pid,
      outputFile,
      ...(launched.startToken === undefined
        ? {}
        : { startToken: launched.startToken }),
    };
  }
  const child = startChild(input, context, outputFile);
  child.unref();
  const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
  child.once("error", (error: Error) => {
    reject(new ToolFailure(`Failed to start command: ${error.message}`));
  });
  child.once("spawn", () => {
    watch(child.pid);
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
    // B9: an omitted risk level is denied separately; the sentence is quoted
    // by the clause.
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
  category: "Shell",
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
