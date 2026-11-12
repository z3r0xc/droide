/**
 * Adapters that connect a non-interactive run to the agent loop and the tool
 * registry.
 *
 * Contract:
 * - `specs/80-exec-and-streaming.md` B9-B14 (tool availability, non-interactive
 *   permission behaviour, the early exit), B26-B32 (record ordering and the
 *   terminal record);
 * - `specs/20-agent-loop.md` B35-B38 (result envelope, truncation, denial);
 * - `specs/30-tools-and-sandbox.md` B5-B8 (availability, validation) and
 *   B41-B47 (the permission algebra).
 *
 * Two seams are filled here:
 * - {@link createExecToolRunner} is the agent loop's `ToolRunner`: resolve the
 *   model-facing name, apply the permission decision, dispatch through the
 *   registry (which validates first) and render the outcome as bounded text.
 * - {@link createExecTurnRunner} is exec's `TurnRunner`: run one loop turn and
 *   translate its events into the transcript records `runOneShot` writes.
 *
 * Nothing here performs I/O beyond what the injected registry, clock and sink
 * do; no clock is read for timestamps the sink owns.
 */
import type { Environment } from "../config/paths.ts";
import type { Message, Role, ToolResultBlock } from "../agent/messages.ts";
import { runTurn, type TurnOutcome as LoopTurnOutcome } from "../agent/loop.ts";
import type {
  LoopClock,
  PermissionGate,
  Provider,
  RetryPolicy,
  Summarizer,
  ToolResult as LoopToolResult,
  ToolRunner as LoopToolRunner,
  TurnDependencies,
  TurnEvent,
} from "../agent/ports.ts";
import type { LlmToolDefinition } from "../transport/llm.ts";
import { isRecord } from "../transport/schema.ts";
import type { ReadTracker, ToolContext } from "../tools/context.ts";
import {
  decide,
  mcpRefusal,
  refusal,
  type AutonomyLevel,
  type PermissionContext,
  type PermissionRequest,
  type ToolClass,
} from "../tools/permissions.ts";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.ts";
import { MODEL_RESULT_BUDGET_BYTES, boundText } from "../tools/result.ts";
import type { Schema } from "../tools/validate.ts";
import type {
  AssistantBlock,
  AssistantMessageEvent,
  ExecUsage,
} from "./records.ts";
import type { TurnTranscript } from "./session.ts";
import type {
  TurnEventSink,
  TurnOutcome,
  TurnRequest,
  TurnRunner,
} from "./turn.ts";

/* -------------------------------------------------------------------------- */
/* Tool selection                                                             */
/* -------------------------------------------------------------------------- */

export interface SelectExecToolsOptions {
  /** `--auto`'s level; absent means the read-only base set (B9). */
  readonly autonomy?: AutonomyLevel;
  /** `--skip-permissions-unsafe` widens the set like `--auto` (B11). */
  readonly skipPermissionsUnsafe?: boolean;
}

/** B9: only reads and no-effect tools, in registration order, one id per name. */
function isReadOnly(definition: ToolDefinition): boolean {
  return definition.sideEffects.every((effect) => effect === "filesystem-read");
}

/**
 * The model-facing tool names this run advertises (B9/B10). With `--auto` or
 * `--skip-permissions-unsafe` every registered tool is admissible; otherwise
 * mutating and process tools are not advertised at all.
 */
export function selectExecTools(
  registry: ToolRegistry,
  options: SelectExecToolsOptions = {},
): readonly string[] {
  const widens =
    options.autonomy !== undefined || options.skipPermissionsUnsafe === true;
  const names: string[] = [];
  for (const definition of registry.all()) {
    if (!widens && !isReadOnly(definition)) continue;
    if (!names.includes(definition.llmId)) names.push(definition.llmId);
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/* Tool catalogue                                                            */
/* -------------------------------------------------------------------------- */

/** The schema algebra as plain JSON Schema, for the provider's `tools`. */
function toJsonSchema(schema: Schema): Record<string, unknown> {
  const described: Record<string, unknown> = {};
  if (schema.description !== undefined) {
    described["description"] = schema.description;
  }
  switch (schema.kind) {
    case "any":
      return described;
    case "string":
      return { type: "string", ...described };
    case "number":
      return {
        type: schema.integer === true ? "integer" : "number",
        ...(schema.min === undefined ? {} : { minimum: schema.min }),
        ...(schema.max === undefined ? {} : { maximum: schema.max }),
        ...described,
      };
    case "boolean":
      return { type: "boolean", ...described };
    case "enum":
      return { type: "string", enum: [...schema.values], ...described };
    case "array":
      return {
        type: "array",
        items: toJsonSchema(schema.items),
        ...described,
      };
    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [name, property] of Object.entries(schema.properties)) {
        properties[name] = toJsonSchema(property);
        const hasDefault =
          "default" in property && property.default !== undefined;
        if (property.optional !== true && !hasDefault) {
          required.push(name);
        }
      }
      return {
        type: "object",
        properties,
        ...(required.length === 0 ? {} : { required }),
        ...described,
      };
    }
    case "union":
      return {
        anyOf: schema.options.map((option) => toJsonSchema(option)),
        ...described,
      };
  }
}

/** The provider-facing catalogue for the advertised names, in that order. */
export function createToolCatalogue(
  registry: ToolRegistry,
  allowed: readonly string[],
): readonly LlmToolDefinition[] {
  const catalogue: LlmToolDefinition[] = [];
  for (const name of allowed) {
    const definition = registry.byLlmId(name)[0];
    if (definition === undefined) continue;
    catalogue.push({
      name,
      description: definition.description,
      inputSchema: toJsonSchema(definition.inputSchema),
    });
  }
  return catalogue;
}

/* -------------------------------------------------------------------------- */
/* Tool runner                                                                */
/* -------------------------------------------------------------------------- */

/** A call the permission algebra refused; `immediate` ends the whole turn. */
export interface ToolDenial {
  readonly toolName: string;
  readonly message: string;
  /** B14: a denied `Execute` or MCP call takes the immediate exit. */
  readonly immediate: boolean;
}

export interface ExecToolRunner extends LoopToolRunner {
  /** The model-facing names this runner may dispatch. */
  readonly allowed: readonly string[];
  readonly denials: readonly ToolDenial[];
  /** The first denial that ends the turn, if one was recorded. */
  immediateDenial(): ToolDenial | undefined;
}

export interface CreateExecToolRunnerOptions {
  readonly registry: ToolRegistry;
  /** Absolute workspace root handed to every tool (B7). */
  readonly root: string;
  readonly environment: Environment;
  readonly permission: PermissionContext;
  /** Advertised names; omitted means every registered tool. */
  readonly allowed?: readonly string[];
  readonly reads?: ReadTracker;
  /** Resolves an interactive `ask`; absent (or `false`) cancels the call. */
  readonly confirm?: (request: PermissionRequest) => Promise<boolean>;
  /** Notified after an immediate denial is recorded. */
  readonly onDenial?: (denial: ToolDenial) => void;
}

/** The six side-effect classes collapsed into the permission matrix's classes. */
function toolClassOf(definition: ToolDefinition): ToolClass {
  const effects = new Set(definition.sideEffects);
  if (effects.has("process")) return "execute";
  if (effects.has("filesystem-write")) return "file-edit";
  if (
    effects.has("network") ||
    effects.has("external-service") ||
    effects.has("persistent-settings")
  ) {
    return "mcp";
  }
  if (effects.has("filesystem-read")) return "read";
  return "no-effect";
}

function riskLevelOf(input: unknown): unknown {
  if (!isRecord(input) || !Object.hasOwn(input, "riskLevel")) return undefined;
  return input["riskLevel"];
}

function permissionRequestOf(
  definition: ToolDefinition,
  input: unknown,
  toolClass: ToolClass,
): PermissionRequest {
  const riskLevel = riskLevelOf(input);
  return {
    toolId: definition.id,
    llmId: definition.llmId,
    toolClass,
    ...(riskLevel === undefined ? {} : { riskLevel }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** B35: a failed result's text is prefixed exactly once. */
function ensureErrorPrefix(text: string): string {
  return text.startsWith("Error: ") ? text : `Error: ${text}`;
}

function flattenValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (value === null) return "null";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/**
 * The agent loop's tool port over the registry.
 *
 * Order per call: advertised-name check, permission algebra, registry dispatch
 * (validate, then execute), render. A refusal or a tool failure is a normal
 * error result; only an abort escapes as an exception, because the loop treats
 * that as cancellation rather than a tool failure (B37/B39).
 */
export function createExecToolRunner(
  options: CreateExecToolRunnerOptions,
): ExecToolRunner {
  const allowed =
    options.allowed ?? options.registry.all().map((tool) => tool.llmId);
  const allowedSet = new Set(allowed);
  const denials: ToolDenial[] = [];
  const wholeLabel = "the tool output (not retained by this build)";

  const bounded = (text: string): string =>
    boundText(text, MODEL_RESULT_BUDGET_BYTES, wholeLabel).text;

  const errorResult = (text: string): LoopToolResult => ({
    content: bounded(ensureErrorPrefix(text)),
    isError: true,
  });

  return {
    allowed,
    denials,

    immediateDenial(): ToolDenial | undefined {
      return denials.find((denial) => denial.immediate);
    },

    async execute(
      name: string,
      input: unknown,
      executeOptions: { readonly signal: AbortSignal },
    ): Promise<LoopToolResult> {
      const definition = options.registry.byLlmId(name)[0];
      if (definition === undefined || !allowedSet.has(definition.llmId)) {
        return errorResult(
          `Tool ${name} is not permitted in this exec session. Available tools: ${
            allowed.length === 0 ? "none" : allowed.join(", ")
          }.`,
        );
      }
      if (executeOptions.signal.aborted) throw abortError();

      const toolClass = toolClassOf(definition);
      const request = permissionRequestOf(definition, input, toolClass);
      const decision = decide(request, options.permission);

      if (decision === "deny") {
        return errorResult(refusal(request, options.permission));
      }
      if (decision === "ask") {
        if (options.permission.interactive === false) {
          // B46: no permission callback, so a prompt is an auto-denial.
          const message =
            toolClass === "mcp"
              ? mcpRefusal(request, options.permission)
              : refusal(request, options.permission);
          const denial: ToolDenial = {
            toolName: name,
            message,
            immediate: toolClass === "execute" || toolClass === "mcp",
          };
          denials.push(denial);
          options.onDenial?.(denial);
          return errorResult(message);
        }
        const approved =
          options.confirm === undefined
            ? false
            : await options.confirm(request);
        if (!approved) {
          return errorResult("Tool execution cancelled by user");
        }
      }

      const context: ToolContext = {
        root: options.root,
        environment: options.environment,
        ...(options.reads === undefined ? {} : { reads: options.reads }),
      };

      let outcome;
      try {
        outcome = await options.registry.dispatch(
          definition.id,
          input,
          context,
        );
      } catch (error) {
        if (executeOptions.signal.aborted || isAbort(error)) throw abortError();
        return errorResult(messageOf(error));
      }

      if (!outcome.ok) return errorResult(outcome.error);

      const text = bounded(flattenValue(outcome.value));
      return { content: text, modelContent: text, isError: false };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Turn runner                                                                */
/* -------------------------------------------------------------------------- */

/** No retries: exec reports the first provider failure (B55). */
const NO_EXEC_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  factor: 1,
  shouldRetry: () => false,
};

/** A ceiling, not a policy: enough iterations for a tool-using answer. */
export const DEFAULT_EXEC_MAX_TURNS = 64;

export interface CreateExecTurnRunnerOptions {
  readonly provider: Provider;
  /** B46: the compaction limit for this run; defaults to {@link DEFAULT_COMPACTION_LIMIT}. */
  readonly compactionTokenLimit?: number;
  readonly tools: ExecToolRunner;
  readonly clock: LoopClock;
  readonly maxTurns: number;
  /** Assistant, tool and user message ids; injected for replayable tests. */
  readonly nextMessageId: (role: Role) => string;
  readonly retry?: RetryPolicy;
  /** B35-B36: the session transcript this run appends to. */
  readonly transcript?: TurnTranscript;
}

/** The loop's own permission gate stays out of the way: the tool runner decides. */
/** Token ceiling used when the caller does not resolve one from settings (§B46). */
export const DEFAULT_COMPACTION_LIMIT = 120_000;

/** Instruction appended to the middle of a conversation that is being compacted. */
const COMPACTION_INSTRUCTION =
  "Summarize the conversation above for continuity: decisions taken, files touched, " +
  "open questions and the next concrete step. Keep it under 400 words, no preamble.";

const ALLOW_ALL: PermissionGate = {
  decide: () => "allow",
  confirm: async () => true,
};

interface UsageTotals {
  input: number;
  output: number;
}

/** Sums the provider's usage deltas across every request in the turn. */
function trackUsage(provider: Provider, totals: UsageTotals): Provider {
  return {
    async *stream(messages, options) {
      for await (const delta of provider.stream(messages, options)) {
        if (delta.type === "usage") {
          totals.input += delta.input;
          totals.output += delta.output;
        }
        yield delta;
      }
    },
  };
}

function usageSnapshot(totals: UsageTotals): ExecUsage {
  return {
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    factory_credits: 0,
    thinking_tokens: 0,
  };
}

function toToolParameters(input: unknown): Readonly<Record<string, unknown>> {
  return isRecord(input) ? input : {};
}

/** One transcript assistant message as the record builders expect it (B27). */
function toAssistantMessageEvent(message: Message): AssistantMessageEvent {
  const blocks: AssistantBlock[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        blocks.push({ kind: "text", text: block.text });
        break;
      case "thinking":
        blocks.push({
          kind: "thinking",
          text: block.thinking,
          ...(block.progressUpdate === undefined
            ? {}
            : { progressUpdate: true }),
        });
        break;
      case "tool_use":
        blocks.push({
          kind: "tool_use",
          toolUseId: block.id,
          name: block.name,
          input: toToolParameters(block.input),
        });
        break;
      default:
        break;
    }
  }
  return { id: message.id, blocks };
}

/** B31: text verbatim, an image as `placeholder`; model-only text never enters. */
function flattenToolResult(block: ToolResultBlock): string {
  const content = block.content;
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return "placeholder";
      return "[document]";
    })
    .join("\n");
}

/** B19: the last assistant message's answer, else its progress updates. */
function finalAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    const texts: string[] = [];
    const progress: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text !== "") texts.push(block.text);
      if (
        block.type === "thinking" &&
        block.progressUpdate !== undefined &&
        block.progressUpdate.trim() !== ""
      ) {
        progress.push(block.progressUpdate);
      }
    }
    if (texts.length > 0) return texts.join("");
    return progress.join("\n\n");
  }
  return "";
}

function countAssistantMessages(messages: readonly Message[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

async function handleTurnEvent(
  event: TurnEvent,
  sink: TurnEventSink,
  transcript: TurnTranscript | undefined,
): Promise<void> {
  switch (event.type) {
    case "assistant_message":
      transcript?.assistantMessage(event.message);
      await sink.assistant(toAssistantMessageEvent(event.message));
      return;
    case "tool_message":
      transcript?.toolMessage(event.message);
      for (const block of event.message.content) {
        if (block.type !== "tool_result") continue;
        await sink.toolResult({
          toolUseId: block.toolUseId,
          messageId: event.message.id,
          isError: block.isError === true,
          text: flattenToolResult(block),
        });
      }
      return;
    case "turn_complete":
      if (event.reason === "error") {
        await sink.agentError(event.error ?? "The model request failed.");
      }
      return;
    default:
      return;
  }
}

/**
 * exec's `TurnRunner` over `runTurn`.
 *
 * Sink writes are queued so records keep transcript order even though `emit` is
 * synchronous. An immediate permission denial aborts the loop after the tool
 * result is recorded, so no further model request is made (B14).
 */
export function createExecTurnRunner(
  options: CreateExecTurnRunnerOptions,
): TurnRunner {
  return {
    async run(request: TurnRequest, sink: TurnEventSink): Promise<TurnOutcome> {
      const totals: UsageTotals = { input: 0, output: 0 };
      const controller = new AbortController();

      // B14: stop before the next request once a confirmation-class denial lands.
      const tools: LoopToolRunner = {
        async execute(name, input, executeOptions) {
          const result = await options.tools.execute(
            name,
            input,
            executeOptions,
          );
          if (options.tools.immediateDenial() !== undefined) {
            controller.abort();
          }
          return result;
        },
      };

      let chain: Promise<void> = Promise.resolve();
      let sinkFailure: unknown;
      const enqueue = (task: () => Promise<void>): void => {
        chain = chain.then(task).catch((error: unknown) => {
          sinkFailure ??= error;
        });
      };

      // B35–B45: compaction runs inside the loop, over the same provider. The
      // summariser is one extra request whose tokens are not part of the turn's
      // usage accounting (they are not the user's turn), which is why it uses
      // the untracked provider.
      const summariser: Summarizer = {
        async summarize(messages, { signal }) {
          const instruction: Message = {
            id: "compaction-instruction",
            role: "user",
            content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
            createdAt: options.clock.now(),
            updatedAt: options.clock.now(),
          };
          let summary = "";
          for await (const delta of options.provider.stream(
            [...messages, instruction],
            { signal },
          )) {
            if (delta.type === "text") summary += delta.text;
          }
          return summary;
        },
      };

      const deps: TurnDependencies = {
        provider: trackUsage(options.provider, totals),
        compaction: {
          limit: options.compactionTokenLimit ?? DEFAULT_COMPACTION_LIMIT,
          summarizer: summariser,
        },
        tools,
        permissions: ALLOW_ALL,
        clock: options.clock,
        retry: options.retry ?? NO_EXEC_RETRY,
        emit: (event) => {
          enqueue(() => handleTurnEvent(event, sink, options.transcript));
        },
        nextMessageId: options.nextMessageId,
      };

      // B46: an outer cancel (SIGINT during streaming input) stops the loop the
      // same way an immediate denial does.
      const onOuterAbort = (): void => controller.abort();
      if (request.signal !== undefined) {
        if (request.signal.aborted) controller.abort();
        else
          request.signal.addEventListener("abort", onOuterAbort, {
            once: true,
          });
      }

      const at = options.clock.now();
      const userMessage: Message = {
        id: request.messageId ?? options.nextMessageId("user"),
        role: "user",
        content: [{ type: "text", text: request.prompt }],
        createdAt: at,
        updatedAt: at,
      };
      options.transcript?.userMessage(userMessage);

      const outcome: LoopTurnOutcome =
        await (async (): Promise<LoopTurnOutcome> => {
          try {
            return await runTurn(deps, {
              messages: [...(request.history ?? []), userMessage],
              maxTurns: options.maxTurns,
              signal: controller.signal,
            });
          } finally {
            request.signal?.removeEventListener("abort", onOuterAbort);
            await chain;
          }
        })();

      if (sinkFailure !== undefined) throw sinkFailure;

      const immediate = options.tools.immediateDenial();
      if (immediate !== undefined) {
        const endedEarly: Message = {
          id: options.nextMessageId("assistant"),
          role: "assistant",
          content: [{ type: "text", text: immediate.message }],
          createdAt: at,
          updatedAt: at,
        };
        options.transcript?.assistantMessage(endedEarly);
        await sink.assistant(toAssistantMessageEvent(endedEarly));
        options.transcript?.turnFailed(immediate.message);
        return { kind: "failed", message: immediate.message };
      }

      switch (outcome.reason) {
        case "completed": {
          const finalText = finalAssistantText(outcome.messages);
          const numTurns = countAssistantMessages(outcome.messages);
          const usage = usageSnapshot(totals);
          options.transcript?.turnCompleted({
            finalText,
            numTurns,
            durationMs: options.clock.now() - at,
            usage,
          });
          return { kind: "completed", finalText, numTurns, usage };
        }
        case "error": {
          const message = outcome.error ?? "The model request failed.";
          options.transcript?.turnFailed(message);
          return { kind: "failed", message };
        }
        case "cancelled":
          options.transcript?.turnCancelled("Cancelled");
          return { kind: "cancelled", message: "Cancelled" };
        case "max_turns": {
          const message =
            "Turn ended after reaching the maximum number of turns.";
          options.transcript?.turnFailed(message);
          return { kind: "failed", message };
        }
      }
    },
  };
}
