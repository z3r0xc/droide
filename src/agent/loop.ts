/**
 * One turn of the agent loop.
 *
 * Contract: `specs/20-agent-loop.md` §B1–B5, B12–B20, B25–B30, B46–B49. The
 * loop streams a provider response, settles every tool call exactly once, and
 * feeds one request-ordered tool message back before asking again. Before a
 * request it compacts the provider view when the threshold fires (§B47); with
 * no `compaction` dependency that branch is skipped entirely. It never throws
 * for a tool-level failure and never decides permissions itself.
 */
import {
  DEFAULT_KEEP_RECENT_TURNS,
  compact,
  estimateTokens,
  shouldCompact,
} from "./compaction.ts";
import {
  type ContentBlock,
  type Message,
  type ToolResultBlock,
  isSendableToProvider,
  toolCallId,
} from "./messages.ts";
import type {
  AssistantBlock,
  ProviderDelta,
  TurnDependencies,
  TurnEvent,
} from "./ports.ts";

export interface TurnRequest {
  /** History the turn starts from; not mutated. */
  readonly messages: readonly Message[];
  /** Stop after this many assistant responses. */
  readonly maxTurns: number;
  readonly signal?: AbortSignal;
}

export interface TurnOutcome {
  readonly messages: readonly Message[];
  readonly reason: "completed" | "max_turns" | "error" | "cancelled";
  readonly error?: string;
}

const INVALID_INPUT_NOTICE = "did not include complete, valid JSON arguments.";

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("name" in error))
    return false;
  const { name } = error;
  return name === "AbortError";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Accumulates a provider stream into assistant blocks, in slot order. */
class AssistantAccumulator {
  readonly #text: { value: string } = { value: "" };
  readonly #thinking: { value: string; signature?: string } = { value: "" };
  readonly #calls = new Map<number, { name: string; json: string }>();
  readonly #emit: (event: TurnEvent) => void;

  constructor(emit: (event: TurnEvent) => void) {
    this.#emit = emit;
  }

  accept(delta: ProviderDelta): void {
    switch (delta.type) {
      case "text":
        this.#text.value += delta.text;
        this.#emit({ type: "text_delta", text: delta.text });
        return;
      case "thinking":
        this.#thinking.value += delta.text;
        if (delta.signature !== undefined)
          this.#thinking.signature = delta.signature;
        this.#emit({ type: "thinking_delta", text: delta.text });
        return;
      case "tool_use_start":
        this.#calls.set(delta.slot, { name: delta.name, json: "" });
        return;
      case "tool_use_input": {
        const call = this.#calls.get(delta.slot);
        if (call !== undefined) call.json += delta.json;
        return;
      }
      case "usage":
      case "done":
        return;
    }
  }

  get hasToolCalls(): boolean {
    return this.#calls.size > 0;
  }

  /** Slots in ascending order, which is the order the model emitted them. */
  slots(): readonly number[] {
    return [...this.#calls.keys()].sort((left, right) => left - right);
  }

  callAt(slot: number): { name: string; json: string } | undefined {
    return this.#calls.get(slot);
  }

  build(
    messageId: string,
    at: number,
  ): { message: Message; blocks: readonly AssistantBlock[] } {
    const blocks: AssistantBlock[] = [];
    if (this.#text.value.length > 0)
      blocks.push({ type: "text", text: this.#text.value });
    if (this.#thinking.value.length > 0) {
      blocks.push({
        type: "thinking",
        thinking: this.#thinking.value,
        signature: this.#thinking.signature ?? "",
      });
    }
    for (const slot of this.slots()) {
      const call = this.#calls.get(slot);
      if (call === undefined) continue;
      blocks.push({
        type: "tool_use",
        id: toolCallId(messageId, slot),
        name: call.name,
        input: parseToolInput(call.json),
      });
    }
    return {
      message: {
        id: messageId,
        role: "assistant",
        content: blocks,
        createdAt: at,
        updatedAt: at,
      },
      blocks,
    };
  }
}

/** `null` marks input that could not be parsed as a JSON object. */
function parseToolInput(json: string): unknown {
  if (json.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
    return null;
  } catch {
    return null;
  }
}

export function isInvalidToolInput(input: unknown): boolean {
  return input === null;
}

async function streamResponse(
  deps: TurnDependencies,
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<AssistantAccumulator> {
  const accumulator = new AssistantAccumulator(deps.emit);

  for (let attempt = 1; ; attempt += 1) {
    try {
      for await (const delta of deps.provider.stream(messages, { signal })) {
        accumulator.accept(delta);
      }
      return accumulator;
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw abortError();
      if (
        attempt >= deps.retry.maxAttempts ||
        !deps.retry.shouldRetry(error, attempt)
      )
        throw error;
      const delayMs = Math.min(
        deps.retry.baseDelayMs * deps.retry.factor ** (attempt - 1),
        deps.retry.maxDelayMs ?? Number.POSITIVE_INFINITY,
      );
      deps.emit({
        type: "retry",
        attempt,
        delayMs,
        reason: describeError(error),
      });
      await deps.clock.sleep(delayMs, signal);
    }
  }
}

async function settleCall(
  deps: TurnDependencies,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
  signal: AbortSignal,
): Promise<ToolResultBlock> {
  const request = { toolName: call.name, input: call.input };

  if (isInvalidToolInput(call.input)) {
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: `Error: tool call for ${call.name} ${INVALID_INPUT_NOTICE}`,
      isError: true,
    };
  }

  const decision = deps.permissions.decide(request);
  if (decision === "deny") {
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: `Error: tool execution denied for ${call.name}`,
      isError: true,
    };
  }
  if (decision === "ask" && !(await deps.permissions.confirm(request))) {
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: "Error: Tool execution cancelled by user",
      isError: true,
    };
  }

  try {
    const result = await deps.tools.execute(call.name, call.input, { signal });
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: result.content,
      ...(result.modelContent === undefined
        ? {}
        : { modelContent: result.modelContent }),
      ...(result.isError === true ? { isError: true } : {}),
    };
  } catch (error) {
    if (signal.aborted || isAbort(error)) throw abortError();
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: `Error: ${describeError(error)}`,
      isError: true,
    };
  }
}

/** Runs one turn to completion, returning the transcript the loop produced. */
export async function runTurn(
  deps: TurnDependencies,
  request: TurnRequest,
): Promise<TurnOutcome> {
  const signal = request.signal ?? new AbortController().signal;
  const history: Message[] = [...request.messages];
  // The provider view of the transcript: `user_only` rows are dropped once and
  // never re-enter, so a compaction replacement cannot leak them (§B10).
  let requestView: readonly Message[] = history.filter(isSendableToProvider);
  // How many `history` entries `requestView` already reflects.
  let folded = request.messages.length;
  // B47: after a compaction that left the view over the limit, further
  // threshold compactions are suppressed until it fits again, so a session
  // cannot loop.
  let compactionSuppressed = false;

  for (let turn = 0; turn < request.maxTurns; turn += 1) {
    if (signal.aborted) return { messages: history, reason: "cancelled" };

    const pending = history.slice(folded);
    if (pending.length > 0) {
      requestView = [...requestView, ...pending];
      folded = history.length;
    }

    const compaction = deps.compaction;
    if (compaction !== undefined) {
      const threshold =
        compaction.ratio === undefined ? {} : { ratio: compaction.ratio };
      const overLimit = shouldCompact(requestView, compaction.limit, threshold);
      if (compactionSuppressed && !overLimit) compactionSuppressed = false;

      // B47: before the next request, when the previous iteration left the
      // context over the limit.
      if (!compactionSuppressed && overLimit) {
        const before = estimateTokens(requestView);
        try {
          const result = await compact(requestView, {
            summarizer: compaction.summarizer,
            keepRecent: compaction.keepRecent ?? DEFAULT_KEEP_RECENT_TURNS,
            signal,
            ...(compaction.maxSummaryTokens === undefined
              ? {}
              : { maxTokens: compaction.maxSummaryTokens }),
          });
          if (result.compacted) {
            requestView = result.messages;
            folded = history.length;
          }
          deps.emit({
            type: "compaction",
            before: result.beforeTokens,
            after: result.afterTokens,
            summarized: result.summarizedCount,
            compacted: result.compacted,
          });
          compactionSuppressed = shouldCompact(
            requestView,
            compaction.limit,
            threshold,
          );
        } catch (error) {
          if (signal.aborted || isAbort(error))
            return { messages: history, reason: "cancelled" };
          // B47: a failed threshold compaction does not end the turn; the
          // request proceeds with the uncompacted view and the error is
          // recorded for the caller.
          deps.emit({
            type: "compaction",
            before,
            after: before,
            summarized: 0,
            compacted: false,
            error: describeError(error),
          });
          compactionSuppressed = true;
        }
      }
    }

    const messageId = deps.nextMessageId("assistant");
    deps.emit({ type: "turn_start", messageId });

    let accumulator: AssistantAccumulator;
    try {
      accumulator = await streamResponse(deps, requestView, signal);
    } catch (error) {
      if (signal.aborted || isAbort(error))
        return { messages: history, reason: "cancelled" };
      deps.emit({
        type: "turn_complete",
        reason: "error",
        error: describeError(error),
      });
      return {
        messages: history,
        reason: "error",
        error: describeError(error),
      };
    }

    const at = deps.clock.now();
    const { message, blocks } = accumulator.build(messageId, at);
    history.push(message);
    deps.emit({ type: "assistant_message", message });

    const calls = blocks.filter(
      (block): block is Extract<AssistantBlock, { type: "tool_use" }> =>
        block.type === "tool_use",
    );
    if (calls.length === 0) {
      deps.emit({ type: "turn_complete", reason: "completed" });
      return { messages: history, reason: "completed" };
    }

    const results: ContentBlock[] = [];
    for (const call of calls) {
      deps.emit({
        type: "tool_call",
        id: call.id,
        name: call.name,
        input: call.input,
      });
      const result = await settleCall(deps, call, signal);
      deps.emit({
        type: "tool_result",
        id: call.id,
        name: call.name,
        isError: result.isError === true,
      });
      results.push(result);
    }

    const toolMessage: Message = {
      id: deps.nextMessageId("tool"),
      role: "tool",
      content: results,
      createdAt: deps.clock.now(),
      updatedAt: deps.clock.now(),
    };
    history.push(toolMessage);
    deps.emit({ type: "tool_message", message: toolMessage });

    if (signal.aborted) return { messages: history, reason: "cancelled" };
  }

  deps.emit({ type: "turn_complete", reason: "max_turns" });
  return { messages: history, reason: "max_turns" };
}
