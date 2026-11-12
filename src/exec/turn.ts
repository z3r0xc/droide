/**
 * One-shot exec turn orchestration. Contract:
 * `specs/80-exec-and-streaming.md` B26-B32, B54-B56.
 *
 * `TurnRunner` is the seam the agent loop fills; this module owns everything
 * around it: the `system/init` record first, the user echo, the record
 * expansion order, exactly one `completion` on success or one terminal `error`
 * on failure, and the exit-code mapping with signal precedence.
 */

import type { Message } from "../agent/messages.ts";
import { ExecAbortedError } from "./errors.ts";
import {
  buildAssistantRecords,
  buildCompletionRecord,
  buildErrorRecord,
  buildFailureSummaryRecord,
  buildSystemInitRecord,
  buildSummaryRecord,
  buildToolResultRecord,
  buildUserEchoRecords,
  type AssistantMessageEvent,
  type ExecUsage,
  type StreamRecord,
} from "./records.ts";
import type { JsonLineWriter } from "./writer.ts";

/** What the runner is asked to do for one user message. */
export interface TurnRequest {
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly tools: readonly string[];
  /**
   * B35: messages already in the session's transcript. They are sent to the
   * provider but never echoed on stdout, and this turn appends after them.
   */
  readonly history?: readonly Message[];
  /** The user message id; absent means the runner asks `nextMessageId`. */
  readonly messageId?: string;
  /** B46: an outer cancellation, e.g. SIGINT during streaming input. */
  readonly signal?: AbortSignal;
}

/** Where a runner reports transcript content as it happens. */
export interface TurnEventSink {
  assistant(message: AssistantMessageEvent): Promise<void>;
  toolResult(result: {
    readonly toolUseId: string;
    readonly messageId: string;
    readonly isError: boolean;
    readonly text: string;
  }): Promise<void>;
  agentError(message: string): Promise<void>;
}

export type TurnOutcome =
  | {
      readonly kind: "completed";
      readonly finalText: string;
      readonly numTurns: number;
      readonly usage: ExecUsage;
    }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled"; readonly message: string };

/** The agent loop's side of the seam. */
export interface TurnRunner {
  run(request: TurnRequest, sink: TurnEventSink): Promise<TurnOutcome>;
}

export interface OneShotOptions extends TurnRequest {
  /** Id echoed on the user `message` record; the session store owns the real one. */
  readonly messageId: string;
  /** Injected so records and durations are replayable in tests. */
  readonly clock: () => number;
  readonly signal?: AbortSignal;
}

/** B56: a signal outranks every turn outcome. */
function abortedExit(signal: AbortSignal | undefined): number | undefined {
  if (signal === undefined || !signal.aborted) return undefined;
  const { reason } = signal;
  return reason instanceof ExecAbortedError ? reason.exitCode : 1;
}

function abortExitFrom(
  error: unknown,
  signal?: AbortSignal,
): number | undefined {
  const fromSignal = abortedExit(signal);
  if (fromSignal !== undefined) return fromSignal;
  return error instanceof ExecAbortedError ? error.exitCode : undefined;
}

function requestOf(options: OneShotOptions): TurnRequest {
  return {
    prompt: options.prompt,
    cwd: options.cwd,
    sessionId: options.sessionId,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    tools: options.tools,
    messageId: options.messageId,
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

const SILENT_SINK: TurnEventSink = {
  assistant: async () => {},
  toolResult: async () => {},
  agentError: async () => {},
};

/** One record per transcript event, in the order the loop settled it (B26-B31). */
export interface EventSinkOptions {
  readonly sessionId: string;
  readonly clock: () => number;
  /** Resolves `false` once stdout is gone; no further record is attempted. */
  readonly write: (record: StreamRecord) => Promise<boolean>;
  /** Tool ids learned from calls emitted in this process (B30). */
  readonly toolNames?: Map<string, string>;
}

export function createEventSink(options: EventSinkOptions): TurnEventSink {
  const toolNames = options.toolNames ?? new Map<string, string>();
  return {
    async assistant(message) {
      const timestamp = options.clock();
      for (const record of buildAssistantRecords(
        message,
        options.sessionId,
        timestamp,
      )) {
        if (record.type === "tool_call")
          toolNames.set(record.id, record.toolId);
        if (!(await options.write(record))) return;
      }
    },
    async toolResult(result) {
      await options.write(
        buildToolResultRecord({
          id: result.toolUseId,
          messageId: result.messageId,
          toolId: toolNames.get(result.toolUseId) ?? "",
          isError: result.isError,
          text: result.text,
          timestamp: options.clock(),
          sessionId: options.sessionId,
        }),
      );
    },
    async agentError(message) {
      await options.write(
        buildErrorRecord({
          source: "agent_loop",
          message,
          timestamp: options.clock(),
          sessionId: options.sessionId,
        }),
      );
    },
  };
}

/**
 * Runs one turn in `stream-json`. Returns the process exit code and never
 * throws for a turn failure, a cancellation or a broken pipe.
 */
export async function runOneShot(
  runner: TurnRunner,
  options: OneShotOptions,
  writer: JsonLineWriter,
): Promise<number> {
  const startedAt = options.clock();
  let pipeClosed = false;

  const write = async (record: StreamRecord): Promise<boolean> => {
    if (pipeClosed) return false;
    const accepted = await writer.write(record);
    if (!accepted) pipeClosed = true;
    return accepted;
  };

  const sink = createEventSink({
    sessionId: options.sessionId,
    clock: options.clock,
    write,
  });

  const init = buildSystemInitRecord({
    cwd: options.cwd,
    sessionId: options.sessionId,
    tools: options.tools,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });
  if (!(await write(init))) return abortedExit(options.signal) ?? 0;

  for (const record of buildUserEchoRecords({
    id: options.messageId,
    text: options.prompt,
    timestamp: options.clock(),
    sessionId: options.sessionId,
  })) {
    if (!(await write(record))) return abortedExit(options.signal) ?? 0;
  }

  let outcome: TurnOutcome;
  try {
    outcome = await runner.run(requestOf(options), sink);
  } catch (error) {
    const exit = abortExitFrom(error, options.signal);
    if (exit !== undefined) return exit;
    await write(
      buildErrorRecord({
        source: "cli",
        message: error instanceof Error ? error.message : String(error),
        timestamp: options.clock(),
        sessionId: options.sessionId,
      }),
    );
    return 1;
  }

  const aborted = abortedExit(options.signal);
  if (aborted !== undefined) return aborted;

  if (outcome.kind === "completed") {
    await write(
      buildCompletionRecord({
        finalText: outcome.finalText,
        numTurns: outcome.numTurns,
        durationMs: Math.max(0, options.clock() - startedAt),
        sessionId: options.sessionId,
        timestamp: options.clock(),
        usage: outcome.usage,
      }),
    );
    return 0;
  }

  await write(
    buildErrorRecord({
      source: "cli",
      message: outcome.message,
      timestamp: options.clock(),
      sessionId: options.sessionId,
    }),
  );
  return 1;
}

/**
 * Runs one turn in `-o json`: exactly one summary object, no streaming
 * records. B21-B23.
 */
export async function runOneShotSummary(
  runner: TurnRunner,
  options: OneShotOptions,
  writer: JsonLineWriter,
): Promise<number> {
  const startedAt = options.clock();

  let outcome: TurnOutcome;
  try {
    outcome = await runner.run(requestOf(options), SILENT_SINK);
  } catch (error) {
    const exit = abortExitFrom(error, options.signal);
    if (exit !== undefined) return exit;
    await writer.write(
      buildFailureSummaryRecord({
        durationMs: Math.max(0, options.clock() - startedAt),
        result: error instanceof Error ? error.message : String(error),
        sessionId: options.sessionId,
      }),
    );
    return 1;
  }

  const aborted = abortedExit(options.signal);
  if (aborted !== undefined) return aborted;

  if (outcome.kind === "completed") {
    await writer.write(
      buildSummaryRecord({
        isError: false,
        durationMs: Math.max(0, options.clock() - startedAt),
        numTurns: outcome.numTurns,
        result: outcome.finalText,
        sessionId: options.sessionId,
        usage: outcome.usage,
      }),
    );
    return 0;
  }

  await writer.write(
    buildFailureSummaryRecord({
      durationMs: Math.max(0, options.clock() - startedAt),
      result: outcome.message,
      sessionId: options.sessionId,
    }),
  );
  return 1;
}
