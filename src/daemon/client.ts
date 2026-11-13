/**
 * The daemon client: connect, authenticate, request, notify. Contract:
 * `specs/70-daemon-and-remote-control.md` B13, B14, B19.
 *
 * One client owns one connection. Request ids are fresh UUID v4 values; each
 * pending request carries its own timeout (per method when the table names
 * one) and an option to abort. A close rejects everything still pending with
 * the transport's close code, a reconnect rejects everything still pending
 * with code 1000 and `Connection reopened`, and an aborted request is dropped
 * locally so a late response is discarded rather than delivered.
 */

import { randomUUID } from "node:crypto";

import {
  AUTHENTICATE_METHOD,
  parseAuthenticateResult,
  type AuthenticateSuccess,
  type DaemonIdentity,
} from "./auth.ts";
import {
  DaemonAuthRejectedError,
  DaemonConnectionClosedError,
  DaemonInvalidResponseError,
  DaemonProtocolError,
  DaemonRequestAbortedError,
  DaemonRpcError,
  DaemonTimeoutError,
} from "./errors.ts";
import {
  DROIDE_PROTOCOL_VERSION,
  JSON_RPC_ERRORS,
  createErrorResponse,
  createNotification,
  createRequest,
  createSuccessResponse,
  parseBinaryFrame,
  parseTextFrame,
  serializeEnvelope,
  type DaemonEnvelope,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
} from "./protocol.ts";
import { systemTimers, type DaemonTimers } from "./timers.ts";
import {
  WS_CLOSE,
  connectWebSocket,
  type DaemonTarget,
  type DaemonTransport,
  type DaemonTransportHandlers,
} from "./web-socket.ts";

/** Default request budget (B19). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Session init/resume budget. */
export const SESSION_INIT_TIMEOUT_MS = 120_000;
/** Session send budget. */
export const SESSION_SEND_TIMEOUT_MS = 240_000;
/** Worktree cleanup budget. */
export const WORKTREE_CLEANUP_TIMEOUT_MS = 900_000;

/**
 * Timeouts that override the default for one method (B19).
 *
 * The four `daemon.*` spellings are quoted by spec 70 B19; callers may still
 * replace the map through `methodTimeouts`.
 */
export const METHOD_TIMEOUTS: Readonly<Record<string, number>> = {
  "daemon.init_session": SESSION_INIT_TIMEOUT_MS,
  "daemon.resume_session": SESSION_INIT_TIMEOUT_MS,
  "daemon.send_message": SESSION_SEND_TIMEOUT_MS,
  "daemon.cleanup_worktree": WORKTREE_CLEANUP_TIMEOUT_MS,
};

/** A token or an `fk-` API key (B15). */
export interface DaemonCredential {
  readonly token?: string;
  readonly apiKey?: string;
}

export interface DaemonClientOptions {
  /** Loopback TCP address or Unix socket path. */
  readonly target: DaemonTarget;
  readonly credential: DaemonCredential;
  /** Sent in every envelope; defaults to the current protocol version. */
  readonly protocolVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly methodTimeouts?: Readonly<Record<string, number>>;
  /** Offered to the daemon; `deflate-raw` is the only supported value. */
  readonly acceptEncodings?: readonly string[];
  readonly timers?: DaemonTimers;
  /** A pre-built transport, for tests; reconnecting still dials the target. */
  readonly transport?: DaemonTransport;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** Answers a daemon→client request; unanswered requests get -32601. */
  readonly onServerRequest?: (
    method: string,
    params: unknown,
  ) => unknown | Promise<unknown>;
  readonly onClose?: (code: number, reason: string) => void;
  /** Rejects a result that does not match the method's contract (B19). */
  readonly validateResult?: (method: string, result: unknown) => void;
}

export interface DaemonRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Defaults to a fresh UUID v4. */
  readonly id?: string;
}

interface PendingRequest {
  readonly method: string;
  readonly succeed: (result: unknown) => void;
  readonly fail: (error: Error) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authReasonFrom(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("reason" in data)) {
    return undefined;
  }
  return typeof data.reason === "string" ? data.reason : undefined;
}

export class DaemonClient {
  readonly protocolVersion: string;

  private readonly target: DaemonTarget;
  private readonly credential: DaemonCredential;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly methodTimeouts: Readonly<Record<string, number>>;
  private readonly timers: DaemonTimers;
  private readonly acceptEncodings: readonly string[] | undefined;
  private readonly onNotification:
    ((method: string, params: unknown) => void) | undefined;
  private readonly onServerRequest:
    | ((method: string, params: unknown) => unknown | Promise<unknown>)
    | undefined;
  private readonly onCloseCallback:
    ((code: number, reason: string) => void) | undefined;
  private readonly validateResult:
    ((method: string, result: unknown) => void) | undefined;
  private readonly makeTransport: () => Promise<DaemonTransport>;
  private readonly handlers: DaemonTransportHandlers;
  private readonly pending = new Map<string, PendingRequest>();

  private transportValue: DaemonTransport | undefined;
  private identityValue: AuthenticateSuccess | undefined;
  private closedValue = false;
  private closeCodeValue = 1000;
  private closeReasonValue = "";

  constructor(options: DaemonClientOptions) {
    this.target = options.target;
    this.credential = options.credential;
    this.protocolVersion = options.protocolVersion ?? DROIDE_PROTOCOL_VERSION;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.methodTimeouts = {
      ...METHOD_TIMEOUTS,
      ...options.methodTimeouts,
    };
    this.timers = options.timers ?? systemTimers;
    this.acceptEncodings = options.acceptEncodings;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onCloseCallback = options.onClose;
    this.validateResult = options.validateResult;
    const injected = options.transport;
    this.makeTransport =
      injected === undefined
        ? async () =>
            await connectWebSocket(this.target, this.handlers, {
              timeoutMs: this.handshakeTimeoutMs,
              timers: this.timers,
            })
        : async () => injected;
    this.handlers = {
      onText: (text) => this.receiveText(text),
      onBinary: (bytes) => this.receiveBinary(bytes),
      onClose: (code, reason) => this.handleTransportClose(code, reason),
    };
  }

  /** The authenticated identity, once the handshake succeeded. */
  get identity(): DaemonIdentity | undefined {
    return this.identityValue;
  }

  get connected(): boolean {
    return !this.closedValue && this.transportValue !== undefined;
  }

  /** Requests still waiting for a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Connect and authenticate. Rejects with the handshake failure. */
  static async connect(options: DaemonClientOptions): Promise<DaemonClient> {
    const client = new DaemonClient(options);
    await client.open();
    return client;
  }

  /** Send one request and wait for its response (B19). */
  async request(
    method: string,
    params?: unknown,
    options: DaemonRequestOptions = {},
  ): Promise<unknown> {
    if (this.closedValue || this.transportValue === undefined) {
      throw new DaemonConnectionClosedError(
        this.closeCodeValue,
        this.closeReasonValue,
      );
    }
    const signal = options.signal;
    if (signal?.aborted === true) {
      throw new DaemonRequestAbortedError(method);
    }
    const id = options.id ?? randomUUID();
    const timeoutMs =
      options.timeoutMs ?? this.methodTimeouts[method] ?? this.requestTimeoutMs;
    const envelope: DaemonRequestEnvelope = createRequest(method, params, {
      id,
      protocolVersion: this.protocolVersion,
    });
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    let settled = false;
    let cancelTimeout = (): void => {};
    const onAbort = (): void => {
      fail(new DaemonRequestAbortedError(method, id));
    };
    const clear = (): void => {
      cancelTimeout();
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clear();
      this.pending.delete(id);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clear();
      this.pending.delete(id);
      reject(error);
    };
    cancelTimeout = this.timers.set(() => {
      fail(new DaemonTimeoutError(method, id, timeoutMs));
    }, timeoutMs);
    this.pending.set(id, { method, succeed, fail });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.transportValue.send(serializeEnvelope(envelope));
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new DaemonProtocolError(JSON_RPC_ERRORS.internal, messageOf(error)),
      );
    }
    return await promise;
  }

  /** Send one notification; nothing is tracked and no response is expected. */
  notify(method: string, params?: unknown): void {
    if (this.closedValue || this.transportValue === undefined) {
      throw new DaemonConnectionClosedError(
        this.closeCodeValue,
        this.closeReasonValue,
      );
    }
    this.transportValue.send(
      serializeEnvelope(
        createNotification(method, params, {
          protocolVersion: this.protocolVersion,
        }),
      ),
    );
  }

  /**
   * Reconnect and re-authenticate. Requests pending on the old connection
   * reject with `ConnectionClosedError(1000, "Connection reopened")` first
   * (B19).
   */
  async reconnect(): Promise<void> {
    this.rejectPending(
      new DaemonConnectionClosedError(1000, "Connection reopened"),
    );
    const previous = this.transportValue;
    this.closedValue = true;
    this.transportValue = undefined;
    if (previous !== undefined) {
      previous.close(1000, "Connection reopened");
      await previous.waitForClose();
    }
    await this.open();
  }

  /** Close the connection; pending requests reject with `code`/`reason`. */
  async close(code = 1000, reason = "client closed"): Promise<void> {
    if (this.closedValue && this.transportValue === undefined) return;
    const transport = this.transportValue;
    this.closedValue = true;
    this.closeCodeValue = code;
    this.closeReasonValue = reason;
    this.transportValue = undefined;
    this.rejectPending(new DaemonConnectionClosedError(code, reason));
    if (transport === undefined) return;
    transport.close(code, reason);
    await transport.waitForClose();
  }

  private async open(): Promise<void> {
    this.closedValue = false;
    this.transportValue = await this.makeTransport();
    this.transportValue.setHandlers(this.handlers);
    try {
      const result = await this.request(
        AUTHENTICATE_METHOD,
        this.authenticateParams(),
        { timeoutMs: this.handshakeTimeoutMs },
      );
      this.identityValue = parseAuthenticateResult(result);
    } catch (error) {
      const transport = this.transportValue;
      this.closedValue = true;
      this.transportValue = undefined;
      this.rejectPending(
        new DaemonConnectionClosedError(1000, "Authentication failed"),
      );
      transport?.close(1000, "Authentication failed");
      if (error instanceof DaemonRpcError) {
        const reason = authReasonFrom(error.data);
        throw new DaemonAuthRejectedError(error.message, {
          ...(reason === undefined ? {} : { reason }),
          cause: error,
        });
      }
      throw error;
    }
  }

  private authenticateParams(): Record<string, unknown> {
    return {
      ...(this.credential.token === undefined
        ? {}
        : { token: this.credential.token }),
      ...(this.credential.apiKey === undefined
        ? {}
        : { apiKey: this.credential.apiKey }),
      ...(this.acceptEncodings === undefined
        ? {}
        : { acceptEncodings: this.acceptEncodings }),
    };
  }

  private receiveText(text: string): void {
    let envelope: DaemonEnvelope;
    try {
      envelope = parseTextFrame(text);
    } catch (error) {
      this.handleMalformedFrame(error);
      return;
    }
    this.dispatch(envelope);
  }

  private receiveBinary(bytes: Uint8Array): void {
    let envelope: DaemonEnvelope;
    try {
      envelope = parseBinaryFrame(bytes);
    } catch (error) {
      this.handleMalformedFrame(error);
      return;
    }
    this.dispatch(envelope);
  }

  private handleMalformedFrame(error: unknown): void {
    const detail =
      error instanceof DaemonProtocolError ? error.message : messageOf(error);
    // B19: pending work rejects with the close code the transport uses.
    const failure = new DaemonConnectionClosedError(
      WS_CLOSE.invalidPayload,
      `unparseable frame: ${detail}`,
    );
    const transport = this.transportValue;
    this.closedValue = true;
    this.transportValue = undefined;
    this.rejectPending(failure);
    transport?.close(1007, "unparseable frame");
  }

  private dispatch(envelope: DaemonEnvelope): void {
    if (envelope.type === "response") {
      this.handleResponse(envelope);
      return;
    }
    if (envelope.type === "notification") {
      try {
        this.onNotification?.(envelope.method, envelope.params);
      } catch {
        // A subscriber's failure is not the connection's failure.
      }
      return;
    }
    this.answerServerRequest(envelope);
  }

  private handleResponse(response: DaemonResponseEnvelope): void {
    if (response.id === null) {
      // A parse error answer cannot be matched to a request; the connection
      // already reported the malformed frame when it was sent.
      return;
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    if ("error" in response) {
      pending.fail(
        new DaemonRpcError(
          response.error.code,
          response.error.message,
          pending.method,
          response.error.data,
        ),
      );
      return;
    }
    try {
      this.validateResult?.(pending.method, response.result);
    } catch (error) {
      pending.fail(
        new DaemonInvalidResponseError(
          pending.method,
          response.id,
          messageOf(error),
          { cause: error },
        ),
      );
      return;
    }
    pending.succeed(response.result);
  }

  private answerServerRequest(request: DaemonRequestEnvelope): void {
    if (this.onServerRequest === undefined) {
      this.replyToServerRequest(
        createErrorResponse(
          request.id,
          JSON_RPC_ERRORS.methodNotFound,
          `Method not found: ${request.method}`,
          undefined,
          { protocolVersion: this.protocolVersion },
        ),
      );
      return;
    }
    void Promise.resolve()
      .then(() => this.onServerRequest?.(request.method, request.params))
      .then((result) => {
        this.replyToServerRequest({
          type: "response",
          jsonrpc: "2.0",
          droideApiVersion: "1.0.0",
          droideProtocolVersion: this.protocolVersion,
          id: request.id,
          result,
        });
      })
      .catch((error: unknown) => {
        this.replyToServerRequest(
          createErrorResponse(
            request.id,
            JSON_RPC_ERRORS.internal,
            messageOf(error),
            undefined,
            { protocolVersion: this.protocolVersion },
          ),
        );
      });
  }

  private replyToServerRequest(envelope: DaemonEnvelope): void {
    if (this.closedValue || this.transportValue === undefined) return;
    this.transportValue.send(serializeEnvelope(envelope));
  }

  private handleTransportClose(code: number, reason: string): void {
    if (this.closedValue) return;
    this.closedValue = true;
    this.closeCodeValue = code;
    this.closeReasonValue = reason;
    this.transportValue = undefined;
    this.rejectPending(new DaemonConnectionClosedError(code, reason));
    this.onCloseCallback?.(code, reason);
  }

  private rejectPending(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      pending.fail(error);
    }
  }
}

/** Connect and authenticate in one call. */
export async function createDaemonClient(
  options: DaemonClientOptions,
): Promise<DaemonClient> {
  return await DaemonClient.connect(options);
}
