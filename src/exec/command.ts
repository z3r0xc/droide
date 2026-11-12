/**
 * `exec` orchestration: parsed command line in, process exit code out.
 *
 * Contract: `specs/80-exec-and-streaming.md` B1-B14, B18-B26, B32, B54-B55 and
 * `specs/10-cli-surface.md` E9-E15.
 *
 * Resolution order, fixed and observable:
 *
 * 1. flags are validated (`validate.ts`) before any prompt, context or model
 *    work; only the unimplemented modes are refused later, also before I/O;
 * 2. the prompt comes from `--file`, then the positional argument, then piped
 *    stdin (a positional prompt suppresses stdin); `--file` with a positional
 *    prompt is refused first;
 * 3. the app context supplies settings and the effective working directory;
 * 4. the model target supplies model, endpoint, headers and dialect. A
 *    `custom:<id>` selector reads `customModels[]`; a managed model reads
 *    `FACTORY_API_KEY`. Missing credentials fail here, before a provider
 *    exists, so no socket is opened;
 * 5. tools are selected from the autonomy level, the provider is built, and
 *    the turn runs.
 *
 * Everything external — streams, clock, ids, fetch, context, registry — is
 * injected, so the module is testable without a process or a network.
 */
import { readFile } from "node:fs/promises";
import type { Writable } from "node:stream";

import { createLlmProvider } from "../agent/adapters/llm-provider.ts";
import type { LoopClock } from "../agent/ports.ts";
import {
  createAppContext,
  type AppContext,
  type CreateAppContextOptions,
} from "../app/context.ts";
import { buildStartupPrompt } from "../app/prompt.ts";
import { resolvePath, type Environment } from "../config/paths.ts";
import type {
  CustomModelProvider,
  CustomModelSettings,
} from "../config/schema.ts";
import type { Settings } from "../config/schema.ts";
import { buildHeaders } from "../transport/headers.ts";
import type { LlmDialect } from "../transport/llm.ts";
import { joinApiPath, parseApiBaseUrl } from "../transport/urls.ts";
import { createSessionTooling } from "../app/tooling.ts";
import { renderToolList } from "./list-tools.ts";
import type { SearchBackend } from "../tools/native-backend.ts";
import type { AutonomyLevel } from "../tools/permissions.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { ExecError, ExecUsageError } from "./errors.ts";
import {
  createExecToolRunner,
  createExecTurnRunner,
  createToolCatalogue,
  DEFAULT_EXEC_MAX_TURNS,
  selectExecTools,
} from "./runner.ts";
import {
  openExecSession,
  type ExecSession,
  type TurnTranscript,
} from "./session.ts";
import { runStreamingInput } from "./streaming.ts";
import {
  runOneShot,
  runOneShotSummary,
  type TurnEventSink,
  type TurnOutcome,
  type TurnRequest,
  type TurnRunner,
} from "./turn.ts";
import {
  assertFilePromptConflict,
  assertInputOutputPair,
  assertNoPromptInStreamingInput,
  assertSessionFlagConflicts,
  FILE_PROMPT_CONFLICT,
  isStreamJsonOutput,
  parseInputFormat,
  parseOutputFormat,
  STREAM_JSON_INPUT_DEPRECATION_WARNING,
  type ExecInputFormat,
  type ExecOutputFormat,
} from "./validate.ts";
import { createJsonLineWriter, isBrokenPipeError } from "./writer.ts";

import type { SessionStore, SessionStoreOptions } from "../session/store.ts";

/** The default model when neither `-m` nor `droidCoreModel` names one. */
export const DEFAULT_MODEL_ID = "gpt-6.1-sol";

/** B23/B56: the managed model's cost ceiling is a provider concern, not ours. */
const DEFAULT_MAX_TOKENS = 8192;

/** The recorded unauthenticated managed-run message. */
export const AUTHENTICATION_REQUIRED =
  "Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.";

const CUSTOM_MODEL_PREFIX = "custom:";

/** The baked managed base URL; `FACTORY_API_BASE_URL` overrides it (50 B3). */
const DEFAULT_API_BASE_URL = "https://api.factory.ai";

/** B20: the one failure prefix for a turn, in `text` mode. */
export const EXEC_FAILURE_PREFIX = "Error during droid execution: ";

/** The options Commander has already parsed, normalised for this module. */
export interface ExecArgv {
  readonly prompt: string | undefined;
  readonly file: string | undefined;
  readonly outputFormat: string | undefined;
  readonly inputFormat: string | undefined;
  readonly model: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly auto: string | undefined;
  readonly skipPermissionsUnsafe: boolean;
  readonly cwd: string | undefined;
  readonly settings: string | undefined;
  readonly sessionId: string | undefined;
  readonly fork: string | undefined;
  readonly mission: boolean;
  readonly useSpec: boolean;
  readonly disableBuiltinSkills: boolean;
  readonly specModel: string | undefined;
  readonly listTools: boolean;
  readonly onlyTools: readonly string[];
  readonly addTools: readonly string[];
  readonly removeTools: readonly string[];
  readonly appendSystemPrompt: string | undefined;
  readonly appendSystemPromptFile: string | undefined;
  readonly worktree: string | boolean | undefined;
  readonly worktreeDir: string | undefined;
  readonly tags: readonly string[];
}

export interface ExecCommandDeps {
  /** Product name used in usage and error text (`cli/brand.ts` owns it). */
  readonly program: string;
  readonly environment: Environment;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly stdinIsTTY: boolean;
  readonly readStdin: () => Promise<string>;
  /**
   * `--input-format stream-json` lines. Defaults to splitting `readStdin` on
   * newlines; the CLI streams them as they arrive.
   */
  readonly readStdinLines?: () => AsyncIterable<string>;
  readonly clock: () => number;
  readonly nextId: () => string;
  /** Defaults to `createAppContext`; tests inject a fixture. */
  readonly createContext?: (
    options: CreateAppContextOptions,
  ) => Promise<AppContext>;
  /** Defaults to the global `fetch`; tests inject a recording fake. */
  readonly fetch?: typeof fetch;
  /** Defaults to the built-in tool registry. */
  readonly registry?: ToolRegistry;
  /** Defaults to `openSessionStore`; tests inject a fixture-backed store. */
  readonly openStore?: (options: SessionStoreOptions) => SessionStore;
  readonly sessionId?: string;
  readonly messageId?: string;
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
}

/** A setup failure whose message is printed as-is (no program prefix). */
export class ExecCommandError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ExecCommandError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

/**
 * Writes text and resolves once flushed. A broken pipe is not a failure: the
 * run's result was already chosen (B34).
 */
async function writeText(stream: Writable, text: string): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onError = (error: unknown): void => {
    if (!(error instanceof Error) || isBrokenPipeError(error)) resolve();
    else reject(error);
  };
  const finish = (error?: Error | null): void => {
    stream.off("error", onError);
    if (error === undefined || error === null || isBrokenPipeError(error)) {
      resolve();
      return;
    }
    reject(error);
  };
  stream.once("error", onError);
  try {
    stream.write(text, finish);
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
  }
  return await promise;
}

/* -------------------------------------------------------------------------- */
/* Prompt sources                                                             */
/* -------------------------------------------------------------------------- */

export interface ResolvePromptOptions {
  readonly program: string;
  readonly promptArg: string | undefined;
  readonly file: string | undefined;
  readonly stdinIsTTY: boolean;
  readonly readStdin: () => Promise<string>;
  /** Effective environment: its `cwd` anchors `--file` (B2). */
  readonly environment: Environment;
}

function noPromptMessage(program: string): string {
  return (
    "No prompt provided. Usage:\n" +
    `  ${program} exec "your prompt"\n` +
    `  ${program} exec -f prompt.txt\n` +
    `  echo "prompt" | ${program} exec`
  );
}

function dashSyntaxMessage(program: string): string {
  return (
    'The "-" syntax is no longer supported. Use one of:\n' +
    `  • ${program} exec -f prompt.txt (for file input)\n` +
    `  • cat prompt.txt | ${program} exec (for piped input)\n` +
    `  • ${program} exec < prompt.txt (for redirected input)`
  );
}

async function readPromptFile(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new ExecUsageError(`Prompt file not found: ${path}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new ExecUsageError(
        `Permission denied reading prompt file: ${path}`,
      );
    }
    throw new ExecUsageError(
      `Could not read prompt file ${path}: ${messageOf(error)}`,
    );
  }
  if (text.trim() === "") {
    throw new ExecUsageError(`Prompt file is empty: ${path}`);
  }
  return text;
}

/**
 * B2-B6: `--file` first, then the positional argument, then piped stdin. A
 * positional prompt suppresses stdin, so stdin is never both read and ignored.
 */
export async function resolvePrompt(
  options: ResolvePromptOptions,
): Promise<string> {
  if (options.file !== undefined) {
    return await readPromptFile(resolvePath(options.environment, options.file));
  }
  if (options.promptArg !== undefined) {
    if (options.promptArg === "-") {
      throw new ExecUsageError(dashSyntaxMessage(options.program));
    }
    return options.promptArg;
  }
  if (!options.stdinIsTTY) {
    let text: string;
    try {
      text = await options.readStdin();
    } catch (error) {
      throw new ExecUsageError(
        `Could not read the prompt from stdin: ${messageOf(error)}`,
      );
    }
    if (text.trim() === "") {
      throw new ExecUsageError(
        "No prompt received on stdin (the input was empty). Pass a prompt " +
          "argument, use -f <file>, or pipe non-empty text.",
      );
    }
    return text;
  }
  throw new ExecUsageError(noPromptMessage(options.program));
}

/* -------------------------------------------------------------------------- */
/* Model and credentials                                                      */
/* -------------------------------------------------------------------------- */

export interface ExecModelTarget {
  /** The selector reported in records (`custom:mock` or a managed model id). */
  readonly model: string;
  /** The id the provider receives on the wire. */
  readonly wireModel: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly dialect: LlmDialect;
  readonly maxTokens: number;
  readonly reasoningEffort: string;
}

export interface ResolveModelTargetInput {
  readonly model: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly settings: Settings;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const CUSTOM_MODEL_DIALECTS: Readonly<
  Record<CustomModelProvider, LlmDialect | null>
> = {
  anthropic: "anthropic",
  openai: "chat",
  "generic-chat-completion-api": "chat",
  "bedrock-converse": null,
};

function customModelTarget(
  selector: string,
  name: string,
  custom: CustomModelSettings,
  reasoningEffort: string | undefined,
): ExecModelTarget {
  const dialect = CUSTOM_MODEL_DIALECTS[custom.provider];
  if (dialect === null) {
    throw new ExecCommandError(
      `Custom model "${name}" uses a provider this build cannot call.`,
    );
  }
  if (custom.baseUrl === undefined || custom.baseUrl.trim() === "") {
    throw new ExecCommandError(
      `Custom model "${name}" has no baseUrl configured.`,
    );
  }
  let base: URL;
  try {
    base = new URL(custom.baseUrl);
  } catch (error) {
    throw new ExecCommandError(
      `Custom model "${name}" has an invalid baseUrl: ${custom.baseUrl}`,
      { cause: error },
    );
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ExecCommandError(
      `Custom model "${name}" has an invalid baseUrl: ${custom.baseUrl}`,
    );
  }
  const root = base.href.endsWith("/") ? base.href : `${base.href}/`;
  const url = new URL(
    dialect === "anthropic" ? "messages" : "chat/completions",
    root,
  );

  const headers: Record<string, string> = { ...(custom.extraHeaders ?? {}) };
  if (custom.apiKey !== undefined) {
    if (dialect === "anthropic") {
      headers["x-api-key"] = custom.apiKey;
      headers["anthropic-version"] ??= "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${custom.apiKey}`;
    }
  }

  return {
    model: selector,
    wireModel: custom.model,
    url,
    headers,
    dialect,
    maxTokens: custom.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    reasoningEffort: reasoningEffort ?? custom.reasoningEffort ?? "off",
  };
}

function managedModelTarget(
  modelId: string,
  reasoningEffort: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ExecModelTarget {
  const apiKey = env["FACTORY_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new ExecCommandError(AUTHENTICATION_REQUIRED);
  }
  const configured = env["FACTORY_API_BASE_URL"]?.trim();
  const baseValue =
    configured === undefined || configured === ""
      ? DEFAULT_API_BASE_URL
      : configured;
  let base: URL;
  try {
    base = parseApiBaseUrl(baseValue, "FACTORY_API_BASE_URL");
  } catch (error) {
    throw new ExecCommandError(messageOf(error), { cause: error });
  }
  return {
    model: modelId,
    wireModel: modelId,
    url: joinApiPath(base, "/api/llm/o/v1/chat/completions"),
    headers: buildHeaders({
      token: apiKey,
      organization: null,
      purpose: "usage",
    }),
    dialect: "chat",
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoningEffort: reasoningEffort ?? "off",
  };
}

/**
 * Model, endpoint, headers and dialect for one run. A `custom:<id>` selector
 * resolves through `customModels[]` and uses that entry's base URL; anything
 * else is a managed model using `FACTORY_API_KEY`.
 */
export function resolveModelTarget(
  input: ResolveModelTargetInput,
): ExecModelTarget {
  const modelId =
    input.model ?? input.settings.droidCoreModel ?? DEFAULT_MODEL_ID;
  if (modelId.startsWith(CUSTOM_MODEL_PREFIX)) {
    const name = modelId.slice(CUSTOM_MODEL_PREFIX.length);
    const models = input.settings.customModels ?? [];
    const custom =
      models.find((entry) => entry.id === name) ??
      models.find((entry) => entry.model === name);
    if (custom === undefined) {
      throw new ExecCommandError(`Invalid model: ${modelId}`);
    }
    return customModelTarget(modelId, name, custom, input.reasoningEffort);
  }
  return managedModelTarget(modelId, input.reasoningEffort, input.env);
}

/* -------------------------------------------------------------------------- */
/* Flag validation                                                            */
/* -------------------------------------------------------------------------- */

const AUTO_LEVELS: readonly AutonomyLevel[] = ["low", "medium", "high"];

/** B10: only the three documented levels; anything else is a usage error. */
export function parseAutoLevel(
  value: string | undefined,
): AutonomyLevel | undefined {
  if (value === undefined) return undefined;
  const level = AUTO_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new ExecUsageError(
      "Invalid --auto value. Allowed values: low, medium, high.",
    );
  }
  return level;
}

const IMPLEMENTED_OUTPUT_FORMATS: Readonly<Record<ExecOutputFormat, boolean>> =
  {
    text: true,
    json: true,
    "stream-json": true,
    "stream-jsonrpc": false,
    acp: false,
    "acp-daemon": false,
    debug: true,
  };

function assertImplemented(
  argv: ExecArgv,
  outputFormat: ExecOutputFormat,
  inputFormat: ExecInputFormat | undefined,
): void {
  if (inputFormat === "stream-jsonrpc") {
    throw new ExecCommandError(
      "--input-format stream-jsonrpc is not implemented in this build.",
    );
  }
  if (IMPLEMENTED_OUTPUT_FORMATS[outputFormat] !== true) {
    throw new ExecCommandError(
      `--output-format ${outputFormat} is not implemented in this build.`,
    );
  }
  if (argv.mission) {
    throw new ExecCommandError("--mission is not implemented in this build.");
  }
  if (argv.useSpec || argv.specModel !== undefined) {
    throw new ExecCommandError(
      "--use-spec and --spec-model are not implemented in this build.",
    );
  }
  if (
    argv.onlyTools.length > 0 ||
    argv.addTools.length > 0 ||
    argv.removeTools.length > 0
  ) {
    throw new ExecCommandError(
      "Tool selection flags (--only-tools, --add-tools, --remove-tools) are " +
        "not implemented in this build.",
    );
  }
  if (argv.worktree !== undefined || argv.worktreeDir !== undefined) {
    throw new ExecCommandError(
      "Worktree options are not implemented in this build.",
    );
  }
  if (argv.tags.length > 0) {
    throw new ExecCommandError("--tag is not implemented in this build.");
  }
}

function withPromptOptions(error: unknown, program: string): unknown {
  if (
    error instanceof ExecUsageError &&
    error.message === FILE_PROMPT_CONFLICT
  ) {
    return new ExecUsageError(
      `${FILE_PROMPT_CONFLICT}\nUse one of:\n` +
        `  • ${program} exec -f prompt.txt\n` +
        `  • ${program} exec "your prompt"\n` +
        `  • cat prompt.txt | ${program} exec`,
    );
  }
  return error;
}

/* -------------------------------------------------------------------------- */
/* Turn plumbing                                                              */
/* -------------------------------------------------------------------------- */

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(abortError());
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(abortError());
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

const SILENT_SINK: TurnEventSink = {
  assistant: async () => {},
  toolResult: async () => {},
  agentError: async () => {},
};

/** B18/B20: the final answer plus one newline, or the failure prefix. */
async function runTextTurn(
  runner: TurnRunner,
  request: TurnRequest,
  deps: ExecCommandDeps,
): Promise<number> {
  let outcome: TurnOutcome;
  try {
    outcome = await runner.run(request, SILENT_SINK);
  } catch (error) {
    await writeText(deps.stderr, `${EXEC_FAILURE_PREFIX}${messageOf(error)}\n`);
    return 1;
  }
  if (outcome.kind === "completed") {
    await writeText(deps.stdout, `${outcome.finalText}\n`);
    return 0;
  }
  await writeText(deps.stderr, `${EXEC_FAILURE_PREFIX}${outcome.message}\n`);
  return 1;
}

/** B42: stdin as lines, for callers that did not supply a streaming reader. */
function linesFrom(read: () => Promise<string>): AsyncIterable<string> {
  return (async function* (): AsyncGenerator<string> {
    let text: string;
    try {
      text = await read();
    } catch (error) {
      throw new ExecUsageError(
        `Could not read the prompt from stdin: ${messageOf(error)}`,
      );
    }
    for (const line of text.split("\n")) yield line;
  })();
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Validates, resolves, runs one turn and returns the process exit code. Every
 * expected failure is reported exactly once on `deps.stderr`; the returned code
 * is what the CLI assigns to `process.exitCode`.
 */
export async function runExecCommand(
  argv: ExecArgv,
  deps: ExecCommandDeps,
): Promise<number> {
  try {
    return await execute(argv, deps);
  } catch (error) {
    const text = messageOf(error);
    const line =
      error instanceof ExecError || error instanceof ExecCommandError
        ? text
        : `${deps.program}: ${text}`;
    try {
      await writeText(deps.stderr, `${line}\n`);
    } catch {
      // stderr is gone; the exit code is all that is left to report.
    }
    return 1;
  }
}

async function execute(argv: ExecArgv, deps: ExecCommandDeps): Promise<number> {
  // B1/B7/B10/B11/B41: every flag check happens before prompt or model work.
  const outputFormat = parseOutputFormat(argv.outputFormat);
  const inputFormat = parseInputFormat(argv.inputFormat);
  try {
    assertFilePromptConflict({ promptArg: argv.prompt, file: argv.file });
  } catch (error) {
    throw withPromptOptions(error, deps.program);
  }
  assertNoPromptInStreamingInput(
    { promptArg: argv.prompt, file: argv.file },
    inputFormat,
  );
  assertInputOutputPair(inputFormat, outputFormat);
  const autonomy = parseAutoLevel(argv.auto);
  if (autonomy !== undefined && argv.skipPermissionsUnsafe) {
    throw new ExecUsageError(
      "Invalid flags: --auto and --skip-permissions-unsafe cannot be used together.",
    );
  }
  assertSessionFlagConflicts({
    sessionId: argv.sessionId,
    fork: argv.fork,
    useSpec: argv.useSpec,
    specModel: argv.specModel,
    mission: argv.mission,
    worktree: argv.worktree,
    worktreeDir: argv.worktreeDir,
    inputFormat,
    outputFormat,
  });
  assertImplemented(argv, outputFormat, inputFormat);

  // B41: the deprecated spelling warns once, before any session or model work.
  if (inputFormat === "stream-json") {
    await writeText(deps.stderr, `${STREAM_JSON_INPUT_DEPRECATION_WARNING}\n`);
  }

  // B2-B6: the context supplies the effective directory, then the prompt is
  // resolved before any model, tool or provider work exists. Streaming input
  // takes its prompts from stdin instead (B7/B42).
  const createContext = deps.createContext ?? createAppContext;
  const context = await createContext({
    environment: deps.environment,
    ...(argv.cwd === undefined ? {} : { cwd: argv.cwd }),
    ...(argv.settings === undefined ? {} : { settingsFlag: argv.settings }),
  });

  let prompt = "";
  // B9: `--list-tools` answers without a prompt, a session or a socket.
  if (inputFormat !== "stream-json" && !argv.listTools) {
    prompt = await resolvePrompt({
      program: deps.program,
      promptArg: argv.prompt,
      file: argv.file,
      stdinIsTTY: deps.stdinIsTTY,
      readStdin: deps.readStdin,
      environment: context.environment,
    });
  }

  // B55: a missing model or credential fails here, before any socket exists.
  const target = resolveModelTarget({
    model: argv.model,
    reasoningEffort: argv.reasoningEffort,
    settings: context.settings,
    env: context.environment.env,
  });

  // B9/B10: the advertised set follows the autonomy level. When the caller did
  // not inject a registry, this is the real one: core tools plus every MCP
  // server that is configured and reachable (specs/60 §B1–B24).
  let registry: ToolRegistry;
  let closeTooling: (() => Promise<void>) | undefined;
  let nativeBackend: SearchBackend | undefined;
  if (deps.registry === undefined) {
    const tooling = await createSessionTooling({ context });
    registry = tooling.registry;
    nativeBackend = tooling.searchBackend;
    closeTooling = () => tooling.close();
  } else {
    registry = deps.registry;
  }
  const allowed = selectExecTools(registry, {
    ...(autonomy === undefined ? {} : { autonomy }),
    skipPermissionsUnsafe: argv.skipPermissionsUnsafe,
  });
  const catalogue = createToolCatalogue(registry, allowed);

  // B9: `--list-tools` answers and exits before a prompt, a session or a
  // provider request exists.
  if (argv.listTools) {
    await writeText(
      deps.stdout,
      renderToolList(registry.all(), catalogue, {
        model: target.wireModel,
        autonomy: autonomy ?? "off",
        offered: catalogue.length,
        withheld: Math.max(0, registry.all().length - catalogue.length),
      }),
    );
    return 0;
  }

  const toolRunner = createExecToolRunner({
    registry,
    root: context.environment.cwd,
    environment: context.environment,
    permission: {
      autonomy: autonomy ?? "low",
      interactionMode: "auto",
      skipConfirmations: argv.skipPermissionsUnsafe,
      interactive: false,
    },
    ...(nativeBackend === undefined ? {} : { nativeBackend }),
    allowed,
  });

  // B14/20 B35: the prompt is composed by the one builder that owns identity,
  // environment, the skills listing and project instructions.
  const systemPrompt = await buildStartupPrompt({
    context,
    ...(argv.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: argv.appendSystemPrompt }),
    ...(argv.appendSystemPromptFile === undefined
      ? {}
      : { appendSystemPromptFile: argv.appendSystemPromptFile }),
    ...(argv.disableBuiltinSkills ? { disableBuiltinSkills: true } : {}),
  });

  const provider = createLlmProvider({
    url: target.url,
    headers: target.headers,
    dialect: target.dialect,
    model: target.wireModel,
    system: systemPrompt,
    tools: catalogue,
    maxTokens: target.maxTokens,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    operation: target.url.pathname,
  });

  const clock: LoopClock = {
    now: deps.clock,
    sleep: sleepFor,
  };

  const sessionOptions = {
    context,
    clock: deps.clock,
    nextId: deps.nextId,
    ...(deps.sessionId === undefined ? {} : { newSessionId: deps.sessionId }),
    ...(argv.sessionId === undefined
      ? {}
      : { continueSessionId: argv.sessionId }),
    ...(argv.fork === undefined ? {} : { forkSessionId: argv.fork }),
    ...(deps.openStore === undefined ? {} : { openStore: deps.openStore }),
  };

  const makeRunner = (transcript: TurnTranscript): TurnRunner =>
    createExecTurnRunner({
      provider,
      tools: toolRunner,
      clock,
      maxTurns: deps.maxTurns ?? DEFAULT_EXEC_MAX_TURNS,
      nextMessageId: () => deps.nextId(),
      transcript,
    });

  // B40-B47: streaming input creates (or loads) the session on the first
  // message and keeps it for every later one.
  if (inputFormat === "stream-json") {
    let session: ExecSession | undefined;
    const openSession = (): ExecSession => {
      session = openExecSession(sessionOptions);
      return session;
    };
    try {
      return await runStreamingInput({
        cwd: context.environment.cwd,
        model: target.model,
        reasoningEffort: target.reasoningEffort,
        tools: allowed,
        clock: deps.clock,
        writer: createJsonLineWriter(deps.stdout),
        lines: deps.readStdinLines?.() ?? linesFrom(deps.readStdin),
        eager: argv.sessionId !== undefined || argv.fork !== undefined,
        openSession,
        runnerFor: makeRunner,
        nextMessageId: deps.nextId,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
    } finally {
      session?.close();
    }
  }

  // B35/B36: one session per run; a continued or forked transcript is loaded
  // before the turn so the loop sees its messages and nothing is replayed.
  const session = openExecSession(sessionOptions);
  try {
    const messageId = deps.messageId ?? deps.nextId();
    const turnRunner = makeRunner(session);
    const request: TurnRequest = {
      prompt,
      cwd: context.environment.cwd,
      sessionId: session.sessionId,
      model: target.model,
      reasoningEffort: target.reasoningEffort,
      tools: allowed,
      messageId,
      history: session.messages(),
    };

    if (outputFormat === "text") {
      return await runTextTurn(turnRunner, request, deps);
    }

    const writer = createJsonLineWriter(deps.stdout);
    const oneShot = {
      ...request,
      messageId,
      clock: deps.clock,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    };
    if (isStreamJsonOutput(outputFormat)) {
      return await runOneShot(turnRunner, oneShot, writer);
    }
    return await runOneShotSummary(turnRunner, oneShot, writer);
  } finally {
    session.close();
    await closeTooling?.();
  }
}
