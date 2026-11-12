/**
 * `--input-format stream-json`: one user message per stdin line, processed in
 * arrival order. Contract: `specs/80-exec-and-streaming.md` B40-B47, B57.
 *
 * The loop owns the protocol's shape:
 * - the session is created (or loaded) on the first message and its id is
 *   reported once, in the `system/init` record written before that message's
 *   records (B40, B47);
 * - messages are strictly serial and each ends with exactly one `completion` or
 *   `error` record (B44);
 * - a blank line is ignored; a malformed, non-user or text-less line produces
 *   one `error` record and the stream continues (B42, B43);
 * - stdin EOF drains what was received and exits `0` (B45);
 * - SIGINT stops the stream, writes one final `error` record and exits `0`,
 *   writing nothing afterwards (B46, B57).
 *
 * Nothing here touches a process-wide stream: stdin lines, the sink writer and
 * the clock are injected.
 */

import type { ExecSession } from "./session.ts";
import {
  buildCompletionRecord,
  buildErrorRecord,
  buildSystemInitRecord,
  buildUserEchoRecords,
  parseStreamInputLine,
  type StreamInputMessage,
  type StreamRecord,
} from "./records.ts";
import {
  createEventSink,
  type TurnOutcome,
  type TurnRequest,
  type TurnRunner,
} from "./turn.ts";
import type { JsonLineWriter } from "./writer.ts";

/** B46: the one final record an interrupted stream writes. */
export const STREAM_INTERRUPTED = "Streaming session interrupted by user";

export interface StreamingInputOptions {
  readonly cwd: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly tools: readonly string[];
  readonly clock: () => number;
  readonly writer: JsonLineWriter;
  /** stdin, one line per yield; the trailing newline is not included. */
  readonly lines: AsyncIterable<string>;
  /**
   * True when `-s`/`--fork` supplied the session: it is opened and its id is
   * reported before the first line is read. Otherwise it is created lazily.
   */
  readonly eager: boolean;
  readonly openSession: () => ExecSession;
  readonly runnerFor: (session: ExecSession) => TurnRunner;
  readonly nextMessageId: () => string;
  /** B46/B57: SIGINT aborts the running turn and closes the stream. */
  readonly signal?: AbortSignal;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Yields the input's lines until it ends or the signal aborts. On abort the
 * underlying iterator is closed, so a blocked stdin read does not outlive the
 * stream.
 */
async function* abortableLines(
  lines: AsyncIterable<string>,
  signal: AbortSignal | undefined,
): AsyncGenerator<string> {
  if (signal === undefined) {
    yield* lines;
    return;
  }

  const iterator = lines[Symbol.asyncIterator]();
  const aborted = Promise.withResolvers<undefined>();
  const onAbort = (): void => aborted.resolve(undefined);
  if (signal.aborted) aborted.resolve(undefined);
  else signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const next: IteratorResult<string> | undefined = await Promise.race([
        iterator.next(),
        aborted.promise,
      ]);
      if (next === undefined || next.done === true) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await iterator.return?.(undefined);
  }
}

/**
 * Runs the streaming input loop. Returns the process exit code: `0` for EOF,
 * interruption and a closed pipe, `1` only when session setup itself fails
 * (which throws through the caller instead).
 */
export async function runStreamingInput(
  options: StreamingInputOptions,
): Promise<number> {
  let session: ExecSession | undefined;
  let runner: TurnRunner | undefined;
  let initWritten = false;
  let stopped = false;
  const toolNames = new Map<string, string>();

  // A method call keeps the compiler from freezing `signal.aborted` at its
  // value from an earlier check: the abort can land at any await.
  const aborted = (): boolean => options.signal?.aborted === true;

  const write = async (record: StreamRecord): Promise<boolean> => {
    if (stopped) return false;
    const accepted = await options.writer.write(record);
    if (!accepted) stopped = true;
    return accepted;
  };

  const ensureSession = (): ExecSession => {
    if (session === undefined) {
      session = options.openSession();
      runner = options.runnerFor(session);
    }
    return session;
  };

  const writeInit = async (sessionId: string): Promise<boolean> => {
    if (initWritten) return true;
    initWritten = true;
    return await write(
      buildSystemInitRecord({
        cwd: options.cwd,
        sessionId,
        tools: options.tools,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
    );
  };

  // B40: a continued or forked session exists before the first message, so its
  // id can be reported immediately.
  if (options.eager) {
    const active = ensureSession();
    if (!(await writeInit(active.sessionId))) return 0;
  }

  for await (const line of abortableLines(options.lines, options.signal)) {
    if (stopped || aborted()) break;

    let message: StreamInputMessage | undefined;
    try {
      message = parseStreamInputLine(line);
    } catch (error) {
      // B43: one record, then the next line; no session exists yet for a
      // failure before the first message, so the id is empty.
      await write(
        buildErrorRecord({
          source: "cli",
          message: messageOf(error),
          timestamp: options.clock(),
          sessionId: session?.sessionId ?? "",
        }),
      );
      continue;
    }
    if (message === undefined) continue;

    const active = ensureSession();
    if (!(await writeInit(active.sessionId))) return 0;
    const activeRunner = runner;
    if (activeRunner === undefined) return 0;

    const messageId = options.nextMessageId();
    for (const record of buildUserEchoRecords({
      id: messageId,
      text: message.prompt,
      timestamp: options.clock(),
      sessionId: active.sessionId,
    })) {
      if (!(await write(record))) return 0;
    }

    const startedAt = options.clock();
    const request: TurnRequest = {
      prompt: message.prompt,
      cwd: options.cwd,
      sessionId: active.sessionId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      tools: options.tools,
      messageId,
      history: active.messages(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };

    let outcome: TurnOutcome;
    try {
      outcome = await activeRunner.run(
        request,
        createEventSink({
          sessionId: active.sessionId,
          clock: options.clock,
          write,
          toolNames,
        }),
      );
    } catch (error) {
      if (aborted()) break;
      await write(
        buildErrorRecord({
          source: "cli",
          message: messageOf(error),
          timestamp: options.clock(),
          sessionId: active.sessionId,
        }),
      );
      continue;
    }
    if (aborted()) break;

    // B44: exactly one terminal record per message.
    if (outcome.kind === "completed") {
      await write(
        buildCompletionRecord({
          finalText: outcome.finalText,
          numTurns: outcome.numTurns,
          durationMs: Math.max(0, options.clock() - startedAt),
          sessionId: active.sessionId,
          timestamp: options.clock(),
          usage: outcome.usage,
        }),
      );
    } else {
      await write(
        buildErrorRecord({
          source: "cli",
          message: outcome.message,
          timestamp: options.clock(),
          sessionId: active.sessionId,
        }),
      );
    }
  }

  if (aborted() && !stopped) {
    // B46: the single final record; nothing is written after it.
    await write(
      buildErrorRecord({
        source: "cli",
        message: STREAM_INTERRUPTED,
        timestamp: options.clock(),
        sessionId: session?.sessionId ?? "",
      }),
    );
  }
  return 0;
}
