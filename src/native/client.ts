/**
 * Client for the native helper process. Contract: `specs/90-native-layer.md`
 * and `crates/README.md` (protocol v1, one response per request).
 *
 * The helper is started once, spoken to over JSON lines, and never trusted:
 * every line it sends is parsed by `protocol.ts` before use. Ids are allocated
 * monotonically by this client and matched on arrival, so requests may be in
 * flight concurrently; the helper answers each with exactly one frame.
 *
 * The child is started from an argument array (never a shell string), its
 * stderr is drained and kept as a short diagnostic tail, and `close()` always
 * leaves no live process behind: end stdin, wait `closeGraceMs`, kill.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  NativeError,
  NativeProtocolError,
  NativeTimeoutError,
  NativeUnavailableError,
} from "./errors.ts";
import {
  MAX_LINE_BYTES,
  MAX_PARAMS_BYTES,
  NATIVE_VERSION_METHOD,
  PROTOCOL_VERSION,
  parseResponseLine,
  parseVersionResult,
  type NativeResponse,
} from "./protocol.ts";

/** Injected timer so timeout behaviour is testable without sleeping. */
export interface NativeTimers {
  /** Run `callback` after `ms`; the returned function cancels it. */
  set(callback: () => void, ms: number): () => void;
}

export interface NativeClientOptions {
  /** Absolute path of the helper executable. */
  readonly helperPath: string;
  /** Extra argv, used by the fake helper in tests; the real helper takes none. */
  readonly helperArgs?: readonly string[];
  /** Default per-request timeout. */
  readonly requestTimeoutMs?: number;
  /** Time allowed for the startup handshake. */
  readonly handshakeTimeoutMs?: number;
  /** Time allowed for a graceful exit before the child is killed. */
  readonly closeGraceMs?: number;
  readonly timers?: NativeTimers;
  /** Child environment; the process environment is inherited when absent. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Time a single request may take before it fails as `NativeTimeoutError`. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Time the `native.version` handshake may take. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
/** Time `close()` gives the helper to exit after stdin ends. */
export const DEFAULT_CLOSE_GRACE_MS = 500;

const STDERR_TAIL_BYTES = 4_096;

const systemTimers: NativeTimers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancelTimeout: () => void;
}

interface ResolvedOptions {
  readonly helperPath: string;
  readonly helperArgs: readonly string[];
  readonly requestTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly closeGraceMs: number;
  readonly timers: NativeTimers;
  readonly env: NodeJS.ProcessEnv | undefined;
}

function resolveOptions(options: NativeClientOptions): ResolvedOptions {
  return {
    helperPath: options.helperPath,
    helperArgs: options.helperArgs ?? [],
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    closeGraceMs: options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
    timers: options.timers ?? systemTimers,
    env: options.env,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One helper process. Create it with `createNativeClient`, which also performs
 * the protocol handshake; a client that failed its handshake is never returned,
 * and its child is already closed.
 */
export class NativeClient {
  readonly helperPath: string;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timers: NativeTimers;
  private readonly defaultTimeoutMs: number;
  private readonly closeGraceMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** Ids whose request timed out: a late answer for one is dropped, not fatal. */
  private readonly abandoned = new Set<number>();
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;
  private exited = false;
  private exitDescription = "";
  private readonly exitWaiters = new Set<() => void>();

  private constructor(options: ResolvedOptions) {
    this.helperPath = options.helperPath;
    this.timers = options.timers;
    this.defaultTimeoutMs = options.requestTimeoutMs;
    this.closeGraceMs = options.closeGraceMs;

    const args = [...options.helperArgs];
    let child: ChildProcessWithoutNullStreams;
    try {
      child =
        options.env === undefined
          ? spawn(options.helperPath, args, {
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
              shell: false,
            })
          : spawn(options.helperPath, args, {
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
              shell: false,
              env: options.env,
            });
    } catch (error) {
      throw new NativeUnavailableError(`could not be started: ${messageOf(error)}`, {
        helperPath: options.helperPath,
        cause: error,
      });
    }
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleChunk(chunk);
    });
    child.stdout.on("error", (error: Error) => {
      this.handleStreamFailure(error);
    });
    child.stdin.on("error", (error: Error) => {
      this.handleStreamFailure(error);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.captureStderr(chunk);
    });
    child.stderr.on("error", () => {
      // Diagnostics only: a stderr failure never changes a request's outcome.
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleExit(code, signal);
    });
    child.on("error", (error: Error) => {
      this.handleStreamFailure(error);
    });
  }

  /** Process id of the helper, or `undefined` if it never started. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether the helper process has exited. */
  get finished(): boolean {
    return this.exited;
  }

  /**
   * Send one request and resolve with its raw `result`. The result is
   * unvalidated JSON: call a parser from `protocol.ts` before using a field.
   */
  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { readonly timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.state !== "open") {
      return Promise.reject(
        new NativeUnavailableError("the client is closed", {
          helperPath: this.helperPath,
          method,
        }),
      );
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    let paramsJson: string;
    try {
      const serialised = JSON.stringify(params);
      if (serialised === undefined) {
        throw new TypeError("params serialise to undefined");
      }
      paramsJson = serialised;
    } catch (error) {
      return Promise.reject(
        new NativeProtocolError("request params are not serialisable as JSON", {
          helperPath: this.helperPath,
          method,
          cause: error,
        }),
      );
    }

    const paramsBytes = Buffer.byteLength(paramsJson, "utf8");
    if (paramsBytes > MAX_PARAMS_BYTES) {
      return Promise.reject(
        new NativeProtocolError(
          `request params are ${paramsBytes} bytes, over the ${MAX_PARAMS_BYTES}-byte cap`,
          { helperPath: this.helperPath, method },
        ),
      );
    }

    const id = this.nextId;
    this.nextId += 1;
    const line = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const cancelTimeout = this.timers.set(() => {
        if (!this.pending.delete(id)) return;
        this.abandoned.add(id);
        reject(new NativeTimeoutError(method, timeoutMs, this.helperPath));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, cancelTimeout });

      try {
        this.child.stdin.write(line);
      } catch (error) {
        if (this.pending.delete(id)) {
          cancelTimeout();
          reject(
            new NativeUnavailableError(
              `could not send method ${method}: ${messageOf(error)}`,
              { helperPath: this.helperPath, method, cause: error },
            ),
          );
        }
      }
    });
  }

  /**
   * Close the helper. Idempotent: every call returns the same promise. Pending
   * requests are rejected immediately, stdin is ended, and the process is
   * killed if it has not exited within `closeGraceMs`.
   */
  close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (this.state === "open") this.state = "closing";
    this.rejectPending(
      (method) =>
        new NativeUnavailableError("the client was closed before answering", {
          helperPath: this.helperPath,
          method,
        }),
    );

    if (!this.exited) {
      if (this.state !== "closed") this.child.stdin.end();
      const exitedGracefully = await this.waitForExit(this.closeGraceMs);
      if (!exitedGracefully) {
        this.killChild();
        await this.waitForExit(this.closeGraceMs);
      }
    }

    this.state = "closed";
  }

  /** Spawn the helper; a spawn failure is `NativeUnavailableError`. */
  private static start(options: ResolvedOptions): NativeClient {
    return new NativeClient(options);
  }

  private captureStderr(chunk: Buffer): void {
    this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`;
    if (this.stderrTail.length > STDERR_TAIL_BYTES) {
      this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_BYTES);
    }
  }

  private handleChunk(chunk: Buffer): void {
    if (this.state === "closed") return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > MAX_LINE_BYTES) {
        this.failWith(
          () =>
            new NativeProtocolError(
              `response line is ${line.length} bytes, over the ${MAX_LINE_BYTES}-byte cap`,
              { helperPath: this.helperPath },
            ),
        );
        return;
      }
      this.consumeLine(line);
      if (this.state === "closed") return;
      newline = this.buffer.indexOf(0x0a);
    }

    if (this.buffer.length > MAX_LINE_BYTES) {
      this.failWith(
        () =>
          new NativeProtocolError(
            `response line is ${this.buffer.length} bytes, over the ${MAX_LINE_BYTES}-byte cap`,
            { helperPath: this.helperPath },
          ),
      );
    }
  }

  private consumeLine(bytes: Buffer): void {
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
    const line = bytes.subarray(0, end).toString("utf8");

    let response: NativeResponse;
    try {
      response = parseResponseLine(line, { helperPath: this.helperPath });
    } catch (error) {
      this.failWith(() =>
        error instanceof Error
          ? error
          : new NativeProtocolError("unreadable response line", {
              helperPath: this.helperPath,
            }),
      );
      return;
    }

    if (response.kind === "error") {
      if (response.id === null) {
        this.failWith(
          () =>
            new NativeProtocolError(
              `reported an error it could not attribute (code ${response.code}): ${response.message}`,
              { helperPath: this.helperPath },
            ),
        );
        return;
      }
      this.settleError(response.id, response.code, response.message);
      return;
    }

    this.settleResult(response.id, response.result);
  }

  private settleResult(id: number, result: unknown): void {
    const request = this.pending.get(id);
    if (request === undefined) {
      this.handleUnexpectedId(id);
      return;
    }
    this.pending.delete(id);
    request.cancelTimeout();
    request.resolve(result);
  }

  private settleError(id: number, code: number, message: string): void {
    const request = this.pending.get(id);
    if (request === undefined) {
      this.handleUnexpectedId(id);
      return;
    }
    this.pending.delete(id);
    request.cancelTimeout();
    request.reject(new NativeError(code, message, request.method, this.helperPath));
  }

  private handleUnexpectedId(id: number): void {
    if (this.abandoned.delete(id)) return;
    this.failWith(
      () =>
        new NativeProtocolError(`answered request id ${id}, which is not pending`, {
          helperPath: this.helperPath,
        }),
    );
  }

  private handleStreamFailure(error: unknown): void {
    let code: string | undefined;
    if (typeof error === "object" && error !== null && "code" in error) {
      const raw = error.code;
      if (typeof raw === "string") code = raw;
    }
    this.failWith(
      () =>
        new NativeUnavailableError(
          `the stream failed${code === undefined ? "" : ` (${code})`}: ${messageOf(error)}`,
          { helperPath: this.helperPath, cause: error },
        ),
    );
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.exitDescription =
      code === null ? `after signal ${signal ?? "unknown"}` : `with code ${code}`;
    const waiters = [...this.exitWaiters];
    this.exitWaiters.clear();
    for (const waiter of waiters) waiter();

    const tail = this.stderrTail.trim();
    const detail = `exited ${this.exitDescription}${tail === "" ? "" : `, stderr: ${tail}`}`;
    this.failWith(
      (method) =>
        new NativeUnavailableError(`the client is closed: helper ${detail}`, {
          helperPath: this.helperPath,
          method,
        }),
    );
  }

  /**
   * Fail every pending request and the boundary itself. One unreadable frame
   * leaves the stream untrustworthy, so no further request is accepted.
   */
  private failWith(makeError: (method: string) => Error): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.rejectPending(makeError);
    this.killChild();
  }

  private rejectPending(makeError: (method: string) => Error): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) {
      request.cancelTimeout();
      request.reject(makeError(request.method));
    }
  }

  private killChild(): void {
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Already gone; `exit` (or the spawn failure) has already been handled.
    }
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const cancel = this.timers.set(() => {
        if (settled) return;
        settled = true;
        this.exitWaiters.delete(finish);
        resolve(false);
      }, ms);
      const finish = () => {
        if (settled) return;
        settled = true;
        cancel();
        this.exitWaiters.delete(finish);
        resolve(true);
      };
      this.exitWaiters.add(finish);
    });
  }
}

/**
 * Start the helper and perform the `native.version` handshake. Rejects with
 * `NativeUnavailableError` when the process cannot start, `NativeTimeoutError`
 * when it does not answer, and `NativeProtocolError` when the answer is
 * malformed or speaks a different protocol. The child is closed on any failure,
 * so a rejected call never leaves a process behind.
 */
export async function createNativeClient(
  options: NativeClientOptions,
): Promise<NativeClient> {
  const resolved = resolveOptions(options);
  const client = NativeClient.start(resolved);

  try {
    const result = await client.request(NATIVE_VERSION_METHOD, {}, {
      timeoutMs: resolved.handshakeTimeoutMs,
    });
    const version = parseVersionResult(result, {
      helperPath: resolved.helperPath,
      method: NATIVE_VERSION_METHOD,
    });
    if (version.protocol !== PROTOCOL_VERSION) {
      throw new NativeProtocolError(
        `speaks protocol ${version.protocol} (helper version ${version.version}) but this build requires ${PROTOCOL_VERSION}`,
        { helperPath: resolved.helperPath, method: NATIVE_VERSION_METHOD },
      );
    }
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}