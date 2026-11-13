/**
 * MCP transports. Contract: `specs/60-extensions-mcp-and-skills.md` B3 (the
 * transport union and its credential channels), B10 (connect budgets), B21
 * (a closed stdio transport reports `not_sent` or `in_flight`) and B9 (the
 * child inherits a caller-supplied environment, never a global).
 *
 * Two implementations, one interface: a stdio child process spoken to in
 * newline-delimited JSON-RPC 2.0, and a streamable-HTTP endpoint spoken to with
 * `fetch`. Neither trusts a byte it receives: every frame is parsed before use,
 * every buffer has a bound, and `close()` always leaves no process behind.
 */

import { spawn, type ChildProcess } from "node:child_process";

import type { McpServerConfig } from "./config.ts";
import {
  McpCancelledError,
  McpConnectError,
  McpProtocolError,
  type McpCancelStage,
} from "./errors.ts";

/** Injected timer so close and exit behaviour is testable without sleeping. */
export interface McpTimers {
  /** Run `callback` after `ms`; the returned function cancels it. */
  set(callback: () => void, ms: number): () => void;
}

export const systemMcpTimers: McpTimers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface McpTransportRequestOptions {
  /**
   * Caller cancellation. Rejecting with `McpCancelledError` carries whether the
   * request had already left this process (`stage`).
   */
  readonly signal?: AbortSignal;
}

/**
 * One connection to one server. `request` settles exactly once; `notify` is
 * fire-and-forget on the wire but still reports a transport that is closed.
 */
export interface McpTransport {
  request(
    method: string,
    params?: unknown,
    options?: McpTransportRequestOptions,
  ): Promise<unknown>;
  notify(
    method: string,
    params?: unknown,
    options?: McpTransportRequestOptions,
  ): Promise<void>;
  close(): Promise<void>;
  /**
   * Optional inbound channel. Server notifications are advisory (the client
   * only clears its listing cache on `tools/list_changed`), so a transport that
   * has no inbound stream simply never calls the handler. Subscribing is also
   * what opens an `sse` transport's stream: the client subscribes once the
   * handshake has completed (B72).
   */
  setNotificationHandler?(
    handler: (notification: McpServerNotification) => void,
  ): void;
}

/** The server notifications this build acts on; everything else is ignored. */
export type McpServerNotificationMethod =
  | "notifications/tools/list_changed"
  | "notifications/resources/list_changed"
  | "notifications/resources/updated";

export interface McpServerNotification {
  readonly method: McpServerNotificationMethod;
  /**
   * The frame's `params`, unvalidated beyond the JSON-RPC frame shape: a
   * `resources/updated` carries `{ uri }`, the list notifications carry none.
   */
  readonly params: unknown;
}

/** Whether a notification method is one the client acts on (B72). */
export function isMcpServerNotificationMethod(
  method: string,
): method is McpServerNotificationMethod {
  return (
    method === "notifications/tools/list_changed" ||
    method === "notifications/resources/list_changed" ||
    method === "notifications/resources/updated"
  );
}

/** One frame's ceiling, matching the 4 MiB catalog cap (B19). */
export const MAX_MCP_FRAME_BYTES = 4 * 1024 * 1024;

/** The bound on what a server's stderr can contribute to an error message. */
export const STDERR_TAIL_BYTES = 4_096;

/** Time `close()` gives a server to exit after stdin ends. */
export const DEFAULT_MCP_CLOSE_GRACE_MS = 500;

/** The JSON-RPC version every frame must carry. */
export const JSON_RPC_VERSION = "2.0";

export type McpIncomingFrame =
  | { readonly kind: "response"; readonly id: number; readonly result: unknown }
  | {
      readonly kind: "error";
      readonly id: number | null;
      readonly code: number;
      readonly message: string;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params?: unknown;
    }
  | { readonly kind: "request"; readonly id: number; readonly method: string };

export interface McpFrameContext {
  readonly server: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parse one inbound line. A frame is a response (an `id` and `result` or
 * `error`), a server request (an `id` and a `method`) or a notification (a
 * `method` alone). Anything else is a `McpProtocolError`: the stream is no
 * longer trustworthy, so transports fail the whole connection rather than
 * skipping the line.
 */
export function parseMcpFrame(
  line: string,
  context: McpFrameContext,
): McpIncomingFrame {
  const fail = (detail: string): never => {
    throw new McpProtocolError(detail, { server: context.server });
  };
  if (line === "") return fail("sent an empty frame");

  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch (error) {
    throw new McpProtocolError("sent a frame that is not JSON", {
      server: context.server,
      cause: error,
    });
  }
  if (!isJsonObject(payload)) return fail("sent a frame that is not an object");

  const version = payload["jsonrpc"];
  if (version !== undefined && version !== JSON_RPC_VERSION) {
    return fail(`sent JSON-RPC version "${String(version)}", not 2.0`);
  }

  const rawId = payload["id"];
  const method = payload["method"];
  if (typeof method === "string") {
    // A notification carries no id (B72 relies on this for the inbound stream);
    // a request carries one.
    if (!Object.hasOwn(payload, "id") || rawId === null) {
      return { kind: "notification", method, params: payload["params"] };
    }
    if (!isRequestId(rawId)) {
      return fail("sent a frame whose id is not a non-negative integer");
    }
    return { kind: "request", id: rawId, method };
  }
  if (rawId === null) {
    const body = payload["error"];
    if (!isJsonObject(body)) return fail("sent a null-id frame with no error");
    return errorFrame(body, null, context);
  }
  if (!isRequestId(rawId)) {
    return fail("sent a frame whose id is not a non-negative integer");
  }

  const hasResult = Object.hasOwn(payload, "result");
  const hasError = Object.hasOwn(payload, "error");
  if (hasResult && hasError) return fail("sent both result and error");
  if (!hasResult && !hasError) return fail("sent neither result nor error");
  if (hasError) {
    const body = payload["error"];
    if (!isJsonObject(body)) return fail("sent an error that is not an object");
    return errorFrame(body, rawId, context);
  }
  return { kind: "response", id: rawId, result: payload["result"] };
}

function errorFrame(
  body: Readonly<Record<string, unknown>>,
  id: number | null,
  context: McpFrameContext,
): McpIncomingFrame {
  const code = body["code"];
  if (typeof code !== "number" || !Number.isInteger(code)) {
    throw new McpProtocolError("sent an error code that is not an integer", {
      server: context.server,
    });
  }
  const message = body["message"];
  if (typeof message !== "string") {
    throw new McpProtocolError("sent an error message that is not a string", {
      server: context.server,
    });
  }
  return { kind: "error", id, code, message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A child's environment: the caller's base plus the server's `env` channel. */
function childEnvironment(
  server: string,
  base: Readonly<Record<string, string | undefined>> | undefined,
  configured: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv | undefined {
  const configuredKeys = Object.keys(configured);
  if (base === undefined) {
    if (configuredKeys.length === 0) return undefined;
    throw new McpConnectError(
      `MCP server "${server}" configures env but no base environment was supplied for the child`,
      { server },
    );
  }
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const key of configuredKeys) {
    const value = configured[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Whether a caller's signal has fired. A function (not an inline comparison)
 * so one abort check never narrows a later one: the signal changes underneath.
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export function abortReason(signal: AbortSignal | undefined): unknown {
  const reason: unknown = signal?.reason;
  return reason;
}

export interface McpStdioTransportOptions {
  readonly server: string;
  readonly command: string;
  readonly args: readonly string[];
  /** The child's complete environment; `undefined` inherits. */
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string;
  readonly timers?: McpTimers;
  readonly platform?: NodeJS.Platform;
  readonly closeGraceMs?: number;
  readonly maxFrameBytes?: number;
}

interface PendingRequest {
  readonly method: string;
  /** Set once the frame has been handed to stdin: the `not_sent` boundary. */
  written: boolean;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly detachAbort: () => void;
}

/**
 * A stdio server: one child process per transport, spoken to in JSON-RPC 2.0
 * lines. The command runs from an argument array with `shell: false`, so no
 * config value is ever interpreted by a shell.
 */
export class StdioMcpTransport implements McpTransport {
  readonly server: string;
  readonly transport = "stdio" as const;

  private readonly child: ChildProcess;
  private readonly timers: McpTimers;
  private readonly platform: NodeJS.Platform;
  private readonly closeGraceMs: number;
  private readonly maxFrameBytes: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** Ids already settled by cancellation: a late answer is dropped, not fatal. */
  private readonly abandoned = new Set<number>();
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;
  private exited = false;
  private exitDescription = "";
  private killPromise: Promise<void> | undefined;
  private notificationHandler:
    ((notification: McpServerNotification) => void) | undefined;
  private readonly exitWaiters = new Set<() => void>();

  constructor(options: McpStdioTransportOptions) {
    this.server = options.server;
    this.timers = options.timers ?? systemMcpTimers;
    this.platform = options.platform ?? process.platform;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_MCP_CLOSE_GRACE_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_MCP_FRAME_BYTES;

    try {
      this.child = spawn(options.command, [...options.args], {
        stdio: ["pipe", "pipe", "pipe"],
        // POSIX needs a process group so `close()` can kill the whole tree;
        // Windows gets a job-level kill through `taskkill /T` instead.
        detached: this.platform !== "win32",
        windowsHide: true,
        shell: false,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      throw new McpConnectError(
        `MCP server "${options.server}" could not be started: ${messageOf(error)}`,
        { server: options.server, cause: error },
      );
    }

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.handleChunk(chunk);
    });
    this.child.stdout?.on("error", (error: Error) => {
      this.failWith(
        (pending) =>
          new McpCancelledError(
            pending.written ? "in_flight" : "not_sent",
            "transport_closed",
            {
              server: this.server,
              method: pending.method,
              transport: "stdio",
              cause: error,
            },
          ),
      );
    });
    this.child.stdin?.on("error", (error: Error) => {
      this.failWith(
        (pending) =>
          new McpCancelledError(
            pending.written ? "in_flight" : "not_sent",
            "transport_closed",
            {
              server: this.server,
              method: pending.method,
              transport: "stdio",
              cause: error,
            },
          ),
      );
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.captureStderr(chunk);
    });
    this.child.stderr?.on("error", () => {
      // Diagnostics only: stderr never changes a request's outcome.
    });
    this.child.on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        this.handleExit(code, signal);
      },
    );
    this.child.on("error", (error: Error) => {
      this.failWith(
        () =>
          new McpConnectError(
            `MCP server "${this.server}" could not be started: ${messageOf(error)}`,
            { server: this.server, cause: error },
          ),
      );
    });
  }

  /** Process id of the server, or `undefined` when it never started. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The bounded tail of what the server wrote to stderr. */
  get stderr(): string {
    return this.stderrTail;
  }

  /**
   * Whether frames can still be read. A getter, so each read is live: an await
   * inside the loop lets the state change underneath it.
   */
  private get streamInactive(): boolean {
    return this.state !== "open";
  }

  setNotificationHandler(
    handler: (notification: McpServerNotification) => void,
  ): void {
    this.notificationHandler = handler;
  }

  request(
    method: string,
    params?: unknown,
    options: McpTransportRequestOptions = {},
  ): Promise<unknown> {
    const closed = this.closedError(method, "not_sent");
    if (closed !== undefined) return Promise.reject(closed);

    const signal = options.signal;
    if (isAborted(signal)) {
      return Promise.reject(
        new McpCancelledError("not_sent", "aborted", {
          server: this.server,
          method,
          transport: "stdio",
          reason: abortReason(signal),
        }),
      );
    }

    const id = this.nextId;
    this.nextId += 1;
    let line: string;
    try {
      const body = JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
      line = `${body}\n`;
    } catch (error) {
      return Promise.reject(
        new McpProtocolError(`request ${method} params are not serialisable`, {
          server: this.server,
          method,
          cause: error,
        }),
      );
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxFrameBytes) {
      return Promise.reject(
        new McpProtocolError(
          `request ${method} is ${bytes} bytes, over the ${this.maxFrameBytes}-byte frame cap`,
          { server: this.server, method },
        ),
      );
    }

    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const detachAbort = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (!this.pending.delete(id)) return;
      this.abandoned.add(id);
      detachAbort();
      reject(
        new McpCancelledError(
          pending.written ? "in_flight" : "not_sent",
          "aborted",
          {
            server: this.server,
            method,
            transport: "stdio",
            reason: signal === undefined ? undefined : abortReason(signal),
          },
        ),
      );
    };
    const pending: PendingRequest = {
      method,
      written: false,
      resolve,
      reject,
      detachAbort,
    };
    this.pending.set(id, pending);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted(signal)) {
      onAbort();
      return promise;
    }

    try {
      pending.written = true;
      this.child.stdin?.write(line);
    } catch (error) {
      pending.written = false;
      if (this.pending.delete(id)) {
        detachAbort();
        reject(
          new McpConnectError(
            `MCP server "${this.server}" could not be sent ${method}: ${messageOf(error)}`,
            { server: this.server, method, cause: error },
          ),
        );
      }
    }
    return promise;
  }

  notify(
    method: string,
    params?: unknown,
    options: McpTransportRequestOptions = {},
  ): Promise<void> {
    const closed = this.closedError(method, "not_sent");
    if (closed !== undefined) return Promise.reject(closed);
    const signal = options.signal;
    if (isAborted(signal)) {
      return Promise.reject(
        new McpCancelledError("not_sent", "aborted", {
          server: this.server,
          method,
          transport: "stdio",
          reason: abortReason(signal),
        }),
      );
    }

    let line: string;
    try {
      line = `${JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`;
    } catch (error) {
      return Promise.reject(
        new McpProtocolError(
          `notification ${method} params are not serialisable`,
          { server: this.server, method, cause: error },
        ),
      );
    }
    try {
      this.child.stdin?.write(line);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        new McpConnectError(
          `MCP server "${this.server}" could not be sent ${method}: ${messageOf(error)}`,
          { server: this.server, method, cause: error },
        ),
      );
    }
  }

  close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (this.state === "open") this.state = "closing";
    this.rejectPending(
      (pending) =>
        new McpCancelledError(
          pending.written ? "in_flight" : "not_sent",
          "client_closed",
          {
            server: this.server,
            method: pending.method,
            transport: "stdio",
          },
        ),
    );

    if (!this.exited) {
      try {
        this.child.stdin?.end();
      } catch {
        // The pipe is already gone; the kill below is what matters.
      }
      const graceful = await this.waitForExit(this.closeGraceMs);
      if (graceful) await this.killTree();
      else {
        await this.killTree();
        await this.waitForExit(this.closeGraceMs);
      }
    } else {
      await this.killTree();
    }

    this.state = "closed";
  }

  private closedError(
    method: string,
    stage: McpCancelStage,
  ): McpCancelledError | undefined {
    if (this.state === "open") return undefined;
    return new McpCancelledError(stage, "client_closed", {
      server: this.server,
      method,
      transport: "stdio",
    });
  }

  private captureStderr(chunk: Buffer): void {
    this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`;
    if (this.stderrTail.length > STDERR_TAIL_BYTES) {
      this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_BYTES);
    }
  }

  private handleChunk(chunk: Buffer): void {
    if (this.streamInactive) return;
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > this.maxFrameBytes) {
        this.failWith(
          () =>
            new McpProtocolError(
              `frame is ${line.length} bytes, over the ${this.maxFrameBytes}-byte cap`,
              { server: this.server },
            ),
        );
        return;
      }
      this.consumeLine(line);
      if (this.streamInactive) return;
      newline = this.buffer.indexOf(0x0a);
    }

    if (this.buffer.length > this.maxFrameBytes) {
      this.failWith(
        () =>
          new McpProtocolError(
            `frame is ${this.buffer.length} bytes, over the ${this.maxFrameBytes}-byte cap`,
            { server: this.server },
          ),
      );
    }
  }

  private consumeLine(bytes: Buffer): void {
    const end =
      bytes.length > 0 && bytes[bytes.length - 1] === 0x0d
        ? bytes.length - 1
        : bytes.length;
    const line = bytes.subarray(0, end).toString("utf8");

    let frame: McpIncomingFrame;
    try {
      frame = parseMcpFrame(line, { server: this.server });
    } catch (error) {
      this.failWith(() =>
        error instanceof Error
          ? error
          : new McpProtocolError("sent an unreadable frame", {
              server: this.server,
            }),
      );
      return;
    }

    switch (frame.kind) {
      case "notification": {
        if (isMcpServerNotificationMethod(frame.method)) {
          this.notificationHandler?.({
            method: frame.method,
            params: frame.params,
          });
        }
        return;
      }
      case "request": {
        // We advertise no client capabilities, so the only honest answer is
        // "method not found" (JSON-RPC -32601). A dead pipe is not fatal here:
        // the exit or stream handler owns that report.
        try {
          this.child.stdin?.write(
            `${JSON.stringify({
              jsonrpc: JSON_RPC_VERSION,
              id: frame.id,
              error: { code: -32601, message: "Method not found" },
            })}\n`,
          );
        } catch {
          // The boundary is already failing elsewhere.
        }
        return;
      }
      case "error": {
        if (frame.id === null) {
          this.failWith(
            () =>
              new McpProtocolError(
                `reported an error it could not attribute (code ${frame.code}): ${frame.message}`,
                { server: this.server },
              ),
          );
          return;
        }
        this.settleError(frame.id, frame.code, frame.message);
        return;
      }
      case "response": {
        this.settleResult(frame.id, frame.result);
      }
    }
  }

  private settleResult(id: number, result: unknown): void {
    const request = this.pending.get(id);
    if (request === undefined) {
      this.handleUnexpectedId(id);
      return;
    }
    this.pending.delete(id);
    request.detachAbort();
    request.resolve(result);
  }

  private settleError(id: number, code: number, message: string): void {
    const request = this.pending.get(id);
    if (request === undefined) {
      this.handleUnexpectedId(id);
      return;
    }
    this.pending.delete(id);
    request.detachAbort();
    request.reject(
      new McpProtocolError(
        `rejected ${request.method}: ${message} (code ${code})`,
        { server: this.server, method: request.method, code },
      ),
    );
  }

  private handleUnexpectedId(id: number): void {
    if (this.abandoned.delete(id)) return;
    this.failWith(
      () =>
        new McpProtocolError(
          `answered request id ${id}, which is not pending`,
          {
            server: this.server,
          },
        ),
    );
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.exitDescription =
      code === null
        ? `after signal ${signal ?? "unknown"}`
        : `with code ${code}`;
    const waiters = [...this.exitWaiters];
    this.exitWaiters.clear();
    for (const waiter of waiters) waiter();

    const tail = this.stderrTail.trim();
    const cause = new Error(
      `the server exited ${this.exitDescription}${tail === "" ? "" : `, stderr: ${tail}`}`,
    );
    this.failWith(
      (pending) =>
        new McpCancelledError(
          pending.written ? "in_flight" : "not_sent",
          "transport_closed",
          {
            server: this.server,
            method: pending.method,
            transport: "stdio",
            cause,
          },
        ),
    );
  }

  /**
   * Fail every pending request and the boundary itself. One unreadable frame
   * leaves the stream untrustworthy, so no further request is accepted.
   */
  private failWith(makeError: (pending: PendingRequest) => Error): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.rejectPending(makeError);
    void this.killTree();
  }

  private rejectPending(makeError: (pending: PendingRequest) => Error): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) {
      request.detachAbort();
      request.reject(makeError(request));
    }
  }

  /**
   * Kill the child and every process it started: the process group on POSIX,
   * `taskkill /T /F` on Windows. Idempotent, and awaited by `close()` so no
   * descendant outlives the transport.
   */
  private killTree(): Promise<void> {
    if (this.killPromise === undefined) {
      this.killPromise = this.performKillTree();
    }
    return this.killPromise;
  }

  private async performKillTree(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (this.platform === "win32") {
      // A reused pid is a real risk once the process has exited, so the tree is
      // only targeted while the leader is alive.
      if (!this.exited) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
        await promise;
      }
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      return;
    }

    // The child is a process-group leader (`detached`), so a negative pid
    // reaches every descendant, including ones orphaned by the leader's exit.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is already empty.
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    const cancel = this.timers.set(() => {
      if (settled) return;
      settled = true;
      this.exitWaiters.delete(finish);
      resolve(false);
    }, ms);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cancel();
      this.exitWaiters.delete(finish);
      resolve(true);
    };
    this.exitWaiters.add(finish);
    return promise;
  }
}

export type McpFetch = typeof fetch;

/** One dispatched server-sent event (B72). */
export interface McpSseEvent {
  /** The `event:` field; `message` when the frame named none. */
  readonly type: string;
  /** Every `data:` line of the frame, joined with `\n`. */
  readonly data: string;
  /** The resume id in effect when the frame dispatched. */
  readonly id: string | undefined;
}

const SSE_LINE_END = /\r\n|\r|\n/;

/**
 * An incremental server-sent-events parser: `push` takes what a byte stream
 * decoded to and returns the frames completed by it. Field parsing follows the
 * SSE grammar — `event:`, `data:` (repeatable, joined with newlines), `id:`
 * (kept for `Last-Event-ID`), `:` comments, blank-line dispatch — and only
 * `data:` payloads are size-bounded, so a comment flood cannot grow memory
 * either: a single line over the cap is an unreadable frame.
 *
 * A frame that never sees its blank line is dropped by `end()`: a truncated
 * stream delivers nothing rather than half an event.
 */
export class McpSseParser {
  private readonly server: string;
  private readonly maxFrameBytes: number;
  private buffer = "";
  private type: string | undefined;
  private data: string[] = [];
  private dataSize = 0;
  private pendingId: string | undefined;
  private lastEventIdValue: string | undefined;

  constructor(options: {
    readonly server: string;
    readonly maxFrameBytes: number;
  }) {
    this.server = options.server;
    this.maxFrameBytes = options.maxFrameBytes;
  }

  /** The last id the stream delivered, for the next `Last-Event-ID`. */
  get lastEventId(): string | undefined {
    return this.lastEventIdValue;
  }

  /** Feed the next decoded chunk; returns every frame it completed. */
  push(chunk: string): McpSseEvent[] {
    this.buffer += chunk;
    const events: McpSseEvent[] = [];
    for (;;) {
      const match = SSE_LINE_END.exec(this.buffer);
      if (match === null) break;
      // A trailing `\r` may be the first half of a `\r\n`: wait for the rest.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line, events);
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw new McpProtocolError(
        `inbound event stream sent a line over the ${this.maxFrameBytes}-byte cap`,
        { server: this.server },
      );
    }
    return events;
  }

  /** A stream that ended without its terminating blank line dispatches nothing. */
  end(): void {
    this.buffer = "";
    this.reset();
    this.pendingId = undefined;
  }

  private line(line: string, events: McpSseEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event": {
        this.type = value;
        return;
      }
      case "data": {
        this.dataSize += value.length + (this.data.length === 0 ? 0 : 1);
        if (this.dataSize > this.maxFrameBytes) {
          throw new McpProtocolError(
            `inbound event frame is over the ${this.maxFrameBytes}-byte cap`,
            { server: this.server },
          );
        }
        this.data.push(value);
        return;
      }
      case "id": {
        // The SSE grammar disallows NUL in an id; a value that has one is ignored.
        if (!value.includes("\u0000")) this.pendingId = value;
        return;
      }
      default: {
        // `retry:` and unknown fields carry nothing this build consumes.
        return;
      }
    }
  }

  private dispatch(events: McpSseEvent[]): void {
    if (this.pendingId !== undefined) {
      this.lastEventIdValue = this.pendingId;
    }
    if (this.data.length > 0) {
      events.push({
        type: this.type ?? "message",
        data: this.data.join("\n"),
        id: this.lastEventIdValue,
      });
    }
    this.reset();
  }

  private reset(): void {
    this.type = undefined;
    this.data = [];
    this.dataSize = 0;
    this.pendingId = undefined;
  }
}

/** How long to wait before reconnect attempt N; `undefined` stops retrying. */
export interface McpSseReconnectPolicy {
  /** `attempt` counts from 1. Return `undefined` to leave the stream closed. */
  delayMs(attempt: number): number | undefined;
}

/**
 * This build's reconnect policy: five attempts, 1 s doubling to a 30 s cap.
 * A drop triggers it; a stream that opens resets the attempt count, and a
 * protocol failure (a redirect off-origin, an oversized frame) does not
 * reconnect at all.
 */
export const DEFAULT_MCP_SSE_RECONNECT_POLICY: McpSseReconnectPolicy = {
  delayMs(attempt: number): number | undefined {
    if (attempt > 5) return undefined;
    return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  },
};

/** Redirects one inbound `GET` may follow, all staying on the configured origin. */
export const MAX_MCP_SSE_REDIRECTS = 3;

export interface McpHttpTransportOptions {
  readonly server: string;
  readonly kind: "http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: McpFetch;
  readonly maxFrameBytes?: number;
  /** Injected so reconnect delays are testable without sleeping. */
  readonly timers?: McpTimers;
  /** Replaces {@link DEFAULT_MCP_SSE_RECONNECT_POLICY} (B72). */
  readonly reconnect?: McpSseReconnectPolicy;
}

/** Where the inbound stream stands; `idle` until the client subscribes. */
export type McpInboundStreamState =
  "idle" | "connecting" | "open" | "waiting" | "failed" | "closed";

/**
 * A streamable-HTTP server: one POST per request, one JSON-RPC frame in the
 * body. An `sse` server additionally has a server-initiated channel: a `GET`
 * that stays open, opened when the client subscribes after the handshake, and
 * resumed with `Last-Event-ID` after a drop (B72).
 */
export class HttpMcpTransport implements McpTransport {
  readonly server: string;
  readonly transport = "http" as const;

  private readonly kind: "http" | "sse";
  private readonly url: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImpl: McpFetch;
  private readonly maxFrameBytes: number;
  private readonly timers: McpTimers;
  private readonly reconnect: McpSseReconnectPolicy;
  private nextId = 1;
  private readonly inFlight = new Set<AbortController>();
  private state: "open" | "closed" = "open";
  private notificationHandler:
    ((notification: McpServerNotification) => void) | undefined;
  private inbound: Promise<void> | undefined;
  private inboundDone: Promise<void> = Promise.resolve();
  private inboundController: AbortController | undefined;
  private cancelReconnect: (() => void) | undefined;
  private reconnectAttempt = 0;
  private lastEventIdValue: string | undefined;
  private ignoredCount = 0;
  private inboundStateValue: McpInboundStreamState = "idle";
  private inboundErrorValue: Error | undefined;

  constructor(options: McpHttpTransportOptions) {
    this.server = options.server;
    this.kind = options.kind;
    this.url = options.url;
    this.headers = options.headers;
    this.fetchImpl = options.fetch;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_MCP_FRAME_BYTES;
    this.timers = options.timers ?? systemMcpTimers;
    this.reconnect = options.reconnect ?? DEFAULT_MCP_SSE_RECONNECT_POLICY;
  }

  /** Where the inbound stream stands (B72). */
  get inboundState(): McpInboundStreamState {
    return this.inboundStateValue;
  }

  /** Why the stream stopped for good, when it did. */
  get inboundError(): Error | undefined {
    return this.inboundErrorValue;
  }

  /** Notifications the stream could not use: unknown methods, events, payloads. */
  get ignoredNotifications(): number {
    return this.ignoredCount;
  }

  /** The id a reconnect would resume from. */
  get lastEventId(): string | undefined {
    return this.lastEventIdValue;
  }

  /** Settles when the inbound stream stops, whether it opened or not. */
  get inboundSettled(): Promise<void> {
    return this.inboundDone;
  }

  async request(
    method: string,
    params?: unknown,
    options: McpTransportRequestOptions = {},
  ): Promise<unknown> {
    if (this.state === "closed") {
      throw new McpCancelledError("not_sent", "client_closed", {
        server: this.server,
        method,
        transport: "http",
      });
    }
    const signal = options.signal;
    if (isAborted(signal)) {
      throw new McpCancelledError("not_sent", "aborted", {
        server: this.server,
        method,
        transport: "http",
        reason: abortReason(signal),
      });
    }

    const id = this.nextId;
    this.nextId += 1;
    const frame = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    let body: string;
    try {
      body = JSON.stringify(frame);
    } catch (error) {
      throw new McpProtocolError(
        `request ${method} params are not serialisable`,
        { server: this.server, method, cause: error },
      );
    }

    const controller = new AbortController();
    this.inFlight.add(controller);
    const onAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body,
        signal: controller.signal,
      });
      const text = await this.readBody(response);
      return this.decodeResponse(response, text, id, method);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new McpCancelledError("in_flight", "aborted", {
          server: this.server,
          method,
          transport: "http",
          reason: signal === undefined ? undefined : abortReason(signal),
          cause: error,
        });
      }
      if (
        error instanceof McpProtocolError ||
        error instanceof McpConnectError ||
        error instanceof McpCancelledError
      ) {
        throw error;
      }
      throw new McpConnectError(
        `MCP server "${this.server}" could not be reached at ${this.url}: ${messageOf(error)}`,
        { server: this.server, method, cause: error },
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.inFlight.delete(controller);
    }
  }

  async notify(
    method: string,
    params?: unknown,
    options: McpTransportRequestOptions = {},
  ): Promise<void> {
    if (this.state === "closed") {
      throw new McpCancelledError("not_sent", "client_closed", {
        server: this.server,
        method,
        transport: "http",
      });
    }
    const signal = options.signal;
    if (isAborted(signal)) {
      throw new McpCancelledError("not_sent", "aborted", {
        server: this.server,
        method,
        transport: "http",
        reason: abortReason(signal),
      });
    }
    const body = JSON.stringify({
      jsonrpc: JSON_RPC_VERSION,
      method,
      ...(params === undefined ? {} : { params }),
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new McpCancelledError("in_flight", "aborted", {
          server: this.server,
          method,
          transport: "http",
          ...(signal === undefined ? {} : { reason: abortReason(signal) }),
          cause: error,
        });
      }
      throw new McpConnectError(
        `MCP server "${this.server}" could not be reached at ${this.url}: ${messageOf(error)}`,
        { server: this.server, method, cause: error },
      );
    }
    if (response.status >= 400) {
      throw new McpProtocolError(
        `rejected notification ${method} with HTTP ${response.status}`,
        { server: this.server, method },
      );
    }
    await response.body?.cancel().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.state = "closed";
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.cancelReconnect?.();
    this.cancelReconnect = undefined;
    this.inboundController?.abort();
    this.inboundStateValue = "closed";
    await this.inbound;
  }

  /**
   * Register the client's callback and open the inbound stream. Idempotent:
   * only the first call (or a call after the stream stopped for good) opens a
   * `GET`; the POST path is unaffected either way.
   */
  setNotificationHandler(
    handler: (notification: McpServerNotification) => void,
  ): void {
    this.notificationHandler = handler;
    if (this.kind !== "sse" || this.state === "closed") return;
    if (this.inbound !== undefined) return;
    this.reconnectAttempt = 0;
    this.inbound = this.runInbound();
    this.inboundDone = this.inbound;
  }

  /** Whether `close()` has run; a getter, so no `await` narrows it stale. */
  private get closed(): boolean {
    return this.state === "closed";
  }

  /**
   * Read the stream until it ends. A drop reconnects through the injected
   * policy; a protocol failure (off-origin redirect, oversized frame, non-SSE
   * answer) stops for good. `close()` ends it without an error.
   */
  private async runInbound(): Promise<void> {
    try {
      for (;;) {
        const outcome = await this.readInbound();
        if (this.closed || outcome !== "dropped") return;
        const delay = this.reconnect.delayMs((this.reconnectAttempt += 1));
        if (delay === undefined) {
          this.inboundStateValue = "failed";
          return;
        }
        this.inboundStateValue = "waiting";
        await this.waitForReconnect(delay);
        if (this.closed) return;
      }
    } finally {
      if (this.closed) this.inboundStateValue = "closed";
      this.inbound = undefined;
      this.inboundController = undefined;
    }
  }

  /** One `GET` and its frames. `dropped` means reconnecting is allowed. */
  private async readInbound(): Promise<"dropped" | "ended"> {
    const controller = new AbortController();
    this.inboundController = controller;
    this.inboundStateValue = "connecting";
    try {
      let url = this.url;
      let response: Response | undefined;
      for (let hop = 0; hop <= MAX_MCP_SSE_REDIRECTS; hop += 1) {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: this.streamHeaders(),
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status < 300 || response.status >= 400) break;
        try {
          url = this.redirectTarget(url, response);
        } finally {
          // A refused redirect must not leave the socket holding a body open.
          await response.body?.cancel().catch(() => undefined);
        }
        response = undefined;
      }
      if (response === undefined) {
        throw new McpProtocolError(
          `inbound event stream redirected more than ${MAX_MCP_SSE_REDIRECTS} times`,
          { server: this.server },
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpProtocolError(
          `inbound event stream answered HTTP ${response.status}`,
          { server: this.server },
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpProtocolError(
          `inbound event stream answered with content-type "${contentType}", not text/event-stream`,
          { server: this.server },
        );
      }

      this.reconnectAttempt = 0;
      this.inboundStateValue = "open";
      await this.pump(response, controller);
      return "dropped";
    } catch (error) {
      if (this.state === "closed" || controller.signal.aborted) return "ended";
      if (error instanceof McpProtocolError) {
        this.inboundErrorValue = error;
        this.inboundStateValue = "failed";
        return "ended";
      }
      // A socket that died under us is a drop, not a verdict.
      return "dropped";
    } finally {
      if (this.inboundController === controller) {
        this.inboundController = undefined;
      }
    }
  }

  private async pump(
    response: Response,
    controller: AbortController,
  ): Promise<void> {
    const body = response.body;
    if (body === null) return;
    const parser = new McpSseParser({
      server: this.server,
      maxFrameBytes: this.maxFrameBytes,
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          parser.end();
          return;
        }
        const chunk = decoder.decode(value, { stream: true });
        for (const event of parser.push(chunk)) this.deliver(event);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /** Hand a frame to the client, or count it as something this build ignores. */
  private deliver(event: McpSseEvent): void {
    if (event.id !== undefined) this.lastEventIdValue = event.id;
    if (event.type !== "message") {
      this.ignoredCount += 1;
      return;
    }
    let frame: McpIncomingFrame;
    try {
      frame = parseMcpFrame(event.data, { server: this.server });
    } catch {
      this.ignoredCount += 1;
      return;
    }
    if (
      frame.kind !== "notification" ||
      !isMcpServerNotificationMethod(frame.method)
    ) {
      this.ignoredCount += 1;
      return;
    }
    this.notificationHandler?.({
      method: frame.method,
      params: frame.params,
    });
  }

  private streamHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.headers)) {
      headers[name] = value;
    }
    headers["accept"] = "text/event-stream";
    if (this.lastEventIdValue !== undefined) {
      headers["last-event-id"] = this.lastEventIdValue;
    }
    return headers;
  }

  /** The URL a redirect may continue at, or a refusal when the origin moved. */
  private redirectTarget(from: string, response: Response): string {
    const location = response.headers.get("location");
    if (location === null || location === "") {
      throw new McpProtocolError(
        `inbound event stream answered HTTP ${response.status} without a location`,
        { server: this.server },
      );
    }
    let base: URL;
    let next: URL;
    try {
      base = new URL(from);
      next = new URL(location, from);
    } catch (error) {
      throw new McpProtocolError(
        "inbound event stream redirected to an unreadable location",
        { server: this.server, cause: error },
      );
    }
    if (next.origin !== base.origin) {
      throw new McpProtocolError(
        `inbound event stream redirected from ${base.origin} to a different origin ${next.origin}`,
        { server: this.server },
      );
    }
    return next.href;
  }

  private waitForReconnect(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const cancel = this.timers.set(() => {
      this.cancelReconnect = undefined;
      resolve();
    }, ms);
    this.cancelReconnect = () => {
      cancel();
      this.cancelReconnect = undefined;
      resolve();
    };
    return promise;
  }

  private requestHeaders(): Record<string, string> {
    // Configured headers first (they are the credential channel, B3), then the
    // protocol headers, which a config value must not be able to break.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.headers)) {
      headers[name] = value;
    }
    headers["content-type"] = "application/json";
    headers["accept"] =
      this.kind === "sse"
        ? "text/event-stream, application/json"
        : "application/json, text/event-stream";
    return headers;
  }

  private async readBody(response: Response): Promise<string> {
    const text = await response.text();
    if (text.length > this.maxFrameBytes) {
      throw new McpProtocolError(
        `response body is ${text.length} characters, over the ${this.maxFrameBytes}-byte cap`,
        { server: this.server },
      );
    }
    return text;
  }

  private decodeResponse(
    response: Response,
    text: string,
    id: number,
    method: string,
  ): unknown {
    if (!response.ok) {
      const tail = text.trim().slice(0, 512);
      throw new McpProtocolError(
        `answered ${method} with HTTP ${response.status}${
          tail === "" ? "" : `: ${tail}`
        }`,
        { server: this.server, method },
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("text/event-stream")
      ? firstEventStreamFrame(text, this.server)
      : text;

    const frame = parseMcpFrame(payload, { server: this.server });
    switch (frame.kind) {
      case "response": {
        if (frame.id !== id) {
          throw new McpProtocolError(
            `answered request id ${frame.id}, not ${id}`,
            { server: this.server, method },
          );
        }
        return frame.result;
      }
      case "error": {
        throw new McpProtocolError(
          `rejected ${method}: ${frame.message} (code ${frame.code})`,
          { server: this.server, method, code: frame.code },
        );
      }
      case "notification":
      case "request": {
        throw new McpProtocolError(
          `answered ${method} with a ${frame.kind} frame, not a response`,
          { server: this.server, method },
        );
      }
    }
  }
}

/**
 * The first JSON-RPC payload in an event-stream body. A streamable-HTTP
 * response carries one frame per `data:` line; a bounded scan is enough for the
 * POST path, and an empty stream is a protocol error.
 */
function firstEventStreamFrame(body: string, server: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data !== "") return data;
  }
  throw new McpProtocolError(
    "answered with an event stream that carried no data frame",
    { server },
  );
}

export interface McpTransportDeps {
  /** Canonical server name; every error identity carries it. */
  readonly server: string;
  readonly timers?: McpTimers;
  readonly fetch?: McpFetch;
  /** The session environment a stdio child starts from. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly closeGraceMs?: number;
  readonly maxFrameBytes?: number;
  /** Replaces the `sse` inbound reconnect policy (B72). */
  readonly sseReconnect?: McpSseReconnectPolicy;
}

/**
 * Build the transport a server's config names (B3): `stdio` spawns a child,
 * `http` and `sse` post to the configured URL. No shell is ever involved.
 */
export function createMcpTransport(
  config: McpServerConfig,
  deps: McpTransportDeps,
): McpTransport {
  if (config.type === "stdio") {
    return new StdioMcpTransport({
      server: deps.server,
      command: config.command,
      args: config.args,
      env: childEnvironment(deps.server, deps.baseEnv, config.env),
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      ...(deps.timers === undefined ? {} : { timers: deps.timers }),
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      ...(deps.closeGraceMs === undefined
        ? {}
        : { closeGraceMs: deps.closeGraceMs }),
      ...(deps.maxFrameBytes === undefined
        ? {}
        : { maxFrameBytes: deps.maxFrameBytes }),
    });
  }

  if (deps.fetch === undefined) {
    throw new McpConnectError(
      `MCP server "${deps.server}" needs the HTTP transport but no fetch implementation was supplied`,
      { server: deps.server },
    );
  }
  return new HttpMcpTransport({
    server: deps.server,
    kind: config.type,
    url: config.url,
    headers: config.headers,
    fetch: deps.fetch,
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
    ...(deps.sseReconnect === undefined
      ? {}
      : { reconnect: deps.sseReconnect }),
    ...(deps.maxFrameBytes === undefined
      ? {}
      : { maxFrameBytes: deps.maxFrameBytes }),
  });
}
