/**
 * Shared fakes for exec tests: no process, no timers, no model.
 */
import { Writable } from "node:stream";

import type { ExecUsage } from "../../../src/exec/records.ts";
import type {
  OneShotOptions,
  TurnEventSink,
  TurnOutcome,
  TurnRequest,
  TurnRunner,
} from "../../../src/exec/turn.ts";

/** Collects every byte written, in order. */
export class CollectingStream extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(
      chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk),
    );
    callback();
  }

  get text(): string {
    return this.chunks.join("");
  }

  get lines(): string[] {
    return this.text.split("\n").filter((line) => line.length > 0);
  }
}

/** A Writable whose downstream pipe is already gone. */
export class BrokenPipeStream extends Writable {
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  }
}

/** A Writable that fails for a reason the writer must not swallow. */
export class FailingStream extends Writable {
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  }
}

export const TEST_USAGE: ExecUsage = {
  input_tokens: 11,
  output_tokens: 7,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  droide_credits: 0,
  thinking_tokens: 0,
};

export function oneShotOptions(
  overrides: Partial<OneShotOptions> = {},
): OneShotOptions {
  return {
    prompt: "read fixture.txt",
    cwd: "/work",
    sessionId: "sid",
    messageId: "u1",
    model: "custom:mock",
    reasoningEffort: "low",
    tools: ["Read", "Execute"],
    clock: () => 0,
    ...overrides,
  };
}

export function scriptedRunner(
  script: (sink: TurnEventSink, request: TurnRequest) => Promise<TurnOutcome>,
): TurnRunner {
  return { run: (request, sink) => script(sink, request) };
}
