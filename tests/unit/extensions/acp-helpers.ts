/**
 * Shared fakes for the ACP suites. Not a test file: no assertions live here.
 * A `PassThrough` pair drives the server in-process; nothing opens a socket,
 * spawns a process or reads a clock.
 */

import { PassThrough, Writable } from "node:stream";

import type { AcpInboundMessage } from "../../../src/acp/protocol.ts";
import {
  createAcpServer,
  type AcpServer,
  type AcpServerOptions,
  type AcpSessionStore,
} from "../../../src/acp/server.ts";
import type {
  AcpTurnRequest,
  AcpTurnRunner,
  AcpTurnSink,
} from "../../../src/exec/acp-runner.ts";
import { ZERO_USAGE } from "../../../src/exec/records.ts";
import type { TurnOutcome } from "../../../src/exec/turn.ts";

export type ScriptedTurn = (
  request: AcpTurnRequest,
  sink: AcpTurnSink,
) => Promise<TurnOutcome>;

export function scriptedRunner(script: ScriptedTurn): AcpTurnRunner {
  return {
    run(request, sink) {
      return script(request, sink);
    },
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

export interface FakeSessionRow {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly deleted: boolean;
}

export class FakeSessionStore implements AcpSessionStore {
  readonly rows = new Map<string, FakeSessionRow>();

  registerSession(input: {
    readonly sessionId?: string;
    readonly cwd?: string | null;
    readonly projectKey?: string;
    readonly firstEventAt?: number | null;
  }): { readonly sessionId: string } {
    const sessionId = input.sessionId ?? `fake-${this.rows.size + 1}`;
    this.rows.set(sessionId, {
      sessionId,
      cwd: input.cwd ?? null,
      deleted: false,
    });
    return { sessionId };
  }

  deleteSession(sessionId: string): boolean {
    const row = this.rows.get(sessionId);
    if (row === undefined) return false;
    this.rows.set(sessionId, { ...row, deleted: true });
    return true;
  }
}

class CollectingWritable extends Writable {
  readonly #onText: (text: string) => void;

  constructor(onText: (text: string) => void) {
    super();
    this.#onText = onText;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#onText(chunk.toString("utf8"));
    callback();
  }
}

interface FrameWaiter {
  readonly predicate: (frame: AcpInboundMessage) => boolean;
  readonly resolve: (frame: AcpInboundMessage) => void;
}

export interface AcpHarnessOptions extends Omit<
  AcpServerOptions,
  "stdin" | "stdout" | "store" | "turnRunner" | "clock"
> {
  readonly clock?: () => number;
  readonly runner?: AcpTurnRunner;
  readonly store?: FakeSessionStore;
}

/** One server, one input stream, one frame queue. */
export class AcpHarness {
  readonly input = new PassThrough();
  readonly frames: AcpInboundMessage[] = [];
  readonly store: FakeSessionStore;
  readonly server: AcpServer;
  readonly done: Promise<void>;
  readonly #waiters: FrameWaiter[] = [];
  #pendingText = "";
  #rawLines: string[] = [];

  constructor(options: AcpHarnessOptions) {
    this.store = options.store ?? new FakeSessionStore();
    const { runner, ...serverOptions } = options;
    this.server = createAcpServer({
      ...serverOptions,
      stdin: this.input,
      stdout: new CollectingWritable((text) => {
        this.#collect(text);
      }),
      store: this.store,
      clock: options.clock ?? (() => 0),
      turnRunner: runner ?? scriptedRunner(async () => completed()),
    });
    this.done = this.server.run();
  }

  get rawLines(): readonly string[] {
    return this.#rawLines;
  }

  #collect(text: string): void {
    this.#pendingText += text;
    for (;;) {
      const newline = this.#pendingText.indexOf("\n");
      if (newline === -1) return;
      const line = this.#pendingText.slice(0, newline);
      this.#pendingText = this.#pendingText.slice(newline + 1);
      if (line.trim() === "") continue;
      this.#rawLines.push(line);
      const frame = JSON.parse(line) as AcpInboundMessage;
      this.#deliver(frame);
    }
  }

  #deliver(frame: AcpInboundMessage): void {
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index === -1) {
      this.frames.push(frame);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    waiter?.resolve(frame);
  }

  /** Queue one frame as a single line. */
  send(frame: object): void {
    this.input.write(`${JSON.stringify(frame)}\n`);
  }

  /** Queue raw text, for split-frame and malformed-input tests. */
  sendRaw(text: string): void {
    this.input.write(text);
  }

  /** Resolve with the next frame matching `predicate`, in arrival order. */
  next(
    predicate: (frame: AcpInboundMessage) => boolean = () => true,
  ): Promise<AcpInboundMessage> {
    const index = this.frames.findIndex(predicate);
    if (index !== -1) {
      const [frame] = this.frames.splice(index, 1);
      if (frame !== undefined) return Promise.resolve(frame);
    }
    const { promise, resolve } = Promise.withResolvers<AcpInboundMessage>();
    this.#waiters.push({ predicate, resolve });
    return promise;
  }

  /** A response with a matching id. */
  nextResponse(id: number | string): Promise<AcpInboundMessage> {
    return this.next((frame) => !("method" in frame) && frame.id === id);
  }

  async dispose(): Promise<void> {
    this.input.end();
    await this.done;
  }

  async disposeAfter(text: string): Promise<void> {
    this.input.end(text);
    await this.done;
  }
}

export function completed(finalText = "done"): TurnOutcome {
  return {
    kind: "completed",
    finalText,
    numTurns: 1,
    usage: ZERO_USAGE,
  };
}

export function failed(message: string): TurnOutcome {
  return { kind: "failed", message };
}

export function cancelledOutcome(message = "cancelled"): TurnOutcome {
  return { kind: "cancelled", message };
}

export const SESSION_ID = "0b8f2f0e-9b1a-4c3d-8e4f-1a2b3c4d5e6f";
export const OTHER_SESSION_ID = "1c9f3f1e-0a2b-4d4e-9f5a-2b3c4d5e6f70";

/** Build a harness with one fixed ACP session already created. */
export async function openSession(
  options: AcpHarnessOptions,
): Promise<{ readonly harness: AcpHarness; readonly sessionId: string }> {
  const harness = new AcpHarness({
    authenticated: true,
    nextSessionId: () => SESSION_ID,
    ...options,
  });
  harness.send({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/work", mcpServers: [] },
  });
  const frame = await harness.nextResponse(1);
  if (!("result" in frame)) {
    throw new Error("session/new failed in the fixture");
  }
  const result = frame.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("sessionId" in result) ||
    typeof result.sessionId !== "string"
  ) {
    throw new Error("session/new returned no session id");
  }
  return { harness, sessionId: result.sessionId };
}
