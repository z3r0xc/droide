/**
 * The ACP agent server: NDJSON over stdin/stdout.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §ACP B60-B71.
 *
 * The server owns framing, dispatch and the lifetime of a turn. It never
 * writes anything but JSON-RPC frames to its output: no banner, no log line,
 * no partially serialised object. Frames are answered in the order they
 * complete, `session/update` notifications are flushed before the `session/prompt`
 * response (B65), and `session/cancel` overtakes a running prompt because
 * request handling is asynchronous (B61, B67).
 */

import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import { PRODUCT_VERSION, PROGRAM } from "../cli/brand.ts";
import {
  createAcpTurnSink,
  runAcpTurn,
  type AcpPermissionResponse,
  type AcpTurnRequest,
  type AcpTurnRunner,
  type AcpTurnSink,
} from "../exec/acp-runner.ts";
import { isBrokenPipeError } from "../exec/writer.ts";
import {
  ACP_ERROR_CODES,
  ACP_MAX_FRAME_BYTES,
  ACP_METHODS,
  AcpProtocolError,
  authMethodsFor,
  buildInitializeResult,
  createAcpFailure,
  createAcpRequest,
  createAcpSuccess,
  createSessionUpdateNotification,
  extractImagesFromPrompt,
  formatPromptForExec,
  parseAcpFrame,
  parseAuthenticateParams,
  parseCancelParams,
  parseCancelRequestParams,
  parseInitializeParams,
  parseNewSessionParams,
  parsePermissionResponse,
  parsePromptParams,
  parseSessionIdParams,
  serializeAcpMessage,
  type AcpDeployment,
  type AcpInboundMessage,
  type AcpNewSessionResult,
  type AcpPromptParams,
  type AcpRequestId,
  type AcpRequestMessage,
  type AcpRequestPermissionParams,
  type AcpResponseMessage,
  type AcpSessionMcpServer,
  type AcpSessionUpdate,
  type AcpStopReason,
} from "./protocol.ts";

/* -------------------------------------------------------------------------- */
/* Public seams                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the session store an ACP session needs: create one and remove
 * it. `SessionStore` satisfies this structurally.
 */
export interface AcpSessionStore {
  registerSession(input: {
    readonly sessionId?: string;
    readonly cwd?: string | null;
    readonly projectKey?: string;
    readonly firstEventAt?: number | null;
  }): { readonly sessionId: string };
  deleteSession(sessionId: string): boolean;
}

export interface AcpServerOptions {
  readonly stdin: AsyncIterable<string | Uint8Array>;
  readonly stdout: Writable;
  readonly turnRunner: AcpTurnRunner;
  readonly store: AcpSessionStore;
  readonly clock: () => number;
  /** `agentInfo.name`; defaults to this build's program name. */
  readonly name?: string;
  readonly version?: string;
  readonly title?: string;
  readonly deployment?: AcpDeployment;
  /** Start already authenticated, for an embedding that resolved a token. */
  readonly authenticated?: boolean;
  /** Resolves a client's `authenticate`; `false` refuses with auth-required. */
  readonly authenticate?: (methodId: string) => boolean | Promise<boolean>;
  readonly nextSessionId?: () => string;
  readonly nextMessageId?: () => string;
  readonly nextRequestId?: () => AcpRequestId;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly tools?: readonly string[];
  readonly maxFrameBytes?: number;
  readonly isModerationRefusal?: (message: string) => boolean;
}

export interface AcpServer {
  /** Reads until EOF, then cancels turns, settles them and flushes frames. */
  run(): Promise<void>;
  /** Stops early: aborts turns and answers pending permissions as cancelled. */
  close(): Promise<void>;
}

const DEFAULT_REASONING_EFFORT = "medium";

/* -------------------------------------------------------------------------- */
/* NDJSON framing                                                             */
/* -------------------------------------------------------------------------- */

const NEWLINE = 0x0a;

interface LineRead {
  readonly oversized: boolean;
  readonly text: string;
}

/**
 * Incremental newline splitter with a hard ceiling. A line above the ceiling
 * is discarded as its bytes arrive, so a hostile client cannot grow memory by
 * never sending a newline; one parse-error frame answers it when the line
 * eventually ends.
 */
export class NdjsonLines {
  readonly #max: number;
  #parts: Uint8Array[] = [];
  #size = 0;
  #oversized = false;

  constructor(max: number) {
    this.#max = max;
  }

  push(chunk: Uint8Array): LineRead[] {
    const lines: LineRead[] = [];
    let start = 0;
    let newline = chunk.indexOf(NEWLINE, start);
    while (newline !== -1) {
      this.#append(chunk.subarray(start, newline));
      lines.push(this.#take());
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    this.#append(chunk.subarray(start));
    return lines;
  }

  flush(): LineRead | undefined {
    if (this.#size === 0 && !this.#oversized) return undefined;
    return this.#take();
  }

  #append(segment: Uint8Array): void {
    if (segment.byteLength === 0 || this.#oversized) return;
    if (this.#size + segment.byteLength > this.#max) {
      this.#oversized = true;
      this.#parts = [];
      this.#size = 0;
      return;
    }
    this.#parts.push(segment);
    this.#size += segment.byteLength;
  }

  #take(): LineRead {
    const oversized = this.#oversized;
    const parts = this.#parts;
    const size = this.#size;
    this.#parts = [];
    this.#size = 0;
    this.#oversized = false;
    return {
      oversized,
      text: oversized ? "" : Buffer.concat(parts, size).toString("utf8").trim(),
    };
  }
}

/** Serialises and writes frames, one per line, preserving call order. */
class FrameWriter {
  readonly #stream: Writable;
  readonly #max: number;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(stream: Writable, max: number) {
    this.#stream = stream;
    this.#max = max;
    // A Writable with no error listener throws; a broken pipe means the peer
    // is gone, which is a clean shutdown rather than a crash.
    stream.on("error", (error: unknown) => {
      if (isBrokenPipeError(error)) this.#closed = true;
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  write(message: AcpInboundMessage): Promise<boolean> {
    const text = serializeAcpMessage(message, this.#max);
    const result = this.#tail.then(async () => this.#writeLine(`${text}\n`));
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  #writeLine(line: string): Promise<boolean> {
    if (this.#closed || this.#stream.destroyed || this.#stream.writableEnded) {
      this.#closed = true;
      return Promise.resolve(false);
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined && error !== null) {
        this.#closed = true;
        resolve(false);
        return;
      }
      resolve(true);
    };
    try {
      this.#stream.write(line, settle);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }
}

/* -------------------------------------------------------------------------- */
/* Turn and session state                                                     */
/* -------------------------------------------------------------------------- */

interface ActiveTurn {
  readonly requestId: AcpRequestId;
  readonly controller: AbortController;
  cancelled: boolean;
}

interface ServerSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers: readonly AcpSessionMcpServer[];
  turn: ActiveTurn | null;
}

interface PendingPermission {
  readonly turn: ActiveTurn;
  readonly resolve: (response: AcpPermissionResponse) => void;
}

const CANCELLED: AcpPermissionResponse = { outcome: "cancelled" };

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

class AcpServerImpl implements AcpServer {
  readonly #options: AcpServerOptions;
  readonly #writer: FrameWriter;
  readonly #lines: NdjsonLines;
  readonly #maxFrameBytes: number;
  readonly #sessions = new Map<string, ServerSession>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #tasks = new Set<Promise<void>>();
  #authenticated: boolean;
  #permissionRequestCounter = 0;
  #accepting = true;
  #shutdown: Promise<void> | undefined;

  constructor(options: AcpServerOptions) {
    this.#options = options;
    this.#maxFrameBytes = options.maxFrameBytes ?? ACP_MAX_FRAME_BYTES;
    this.#writer = new FrameWriter(options.stdout, this.#maxFrameBytes);
    this.#lines = new NdjsonLines(this.#maxFrameBytes);
    this.#authenticated = options.authenticated === true;
  }

  async run(): Promise<void> {
    try {
      for await (const chunk of this.#options.stdin) {
        if (!this.#accepting) break;
        const bytes =
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        for (const line of this.#lines.push(bytes)) {
          await this.#dispatchLine(line);
          if (!this.#accepting) break;
        }
      }
      if (this.#accepting) {
        const tail = this.#lines.flush();
        if (tail !== undefined) await this.#dispatchLine(tail);
      }
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.#shutdown ??= this.#shutdownOnce();
    await this.#shutdown;
  }

  async #shutdownOnce(): Promise<void> {
    this.#accepting = false;
    for (const session of this.#sessions.values()) {
      const turn = session.turn;
      if (turn === null) continue;
      turn.cancelled = true;
      turn.controller.abort();
    }
    for (const pending of this.#pendingPermissions.values()) {
      pending.resolve(CANCELLED);
    }
    this.#pendingPermissions.clear();
    await Promise.allSettled([...this.#tasks]);
    await this.#writer.drain();
  }

  async #dispatchLine(line: LineRead): Promise<void> {
    if (line.oversized) {
      await this.#writer.write(
        createAcpFailure(
          null,
          ACP_ERROR_CODES.parse,
          `Parse error: frame is above the ${this.#maxFrameBytes}-byte limit`,
        ),
      );
      return;
    }
    if (line.text === "") return;
    let message: AcpInboundMessage;
    try {
      message = parseAcpFrame(line.text, this.#maxFrameBytes);
    } catch (error) {
      const protocol =
        error instanceof AcpProtocolError
          ? error
          : new AcpProtocolError(ACP_ERROR_CODES.parse, "Parse error");
      await this.#writer.write(
        createAcpFailure(null, protocol.code, protocol.message, protocol.data),
      );
      return;
    }
    if ("method" in message) {
      if ("id" in message) {
        this.#track(this.#handleRequest(message));
      } else {
        await this.#handleNotification(message);
      }
      return;
    }
    this.#handleResponse(message);
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.then(
      () => this.#tasks.delete(task),
      () => this.#tasks.delete(task),
    );
  }

  /* ----------------------------- requests ------------------------------- */

  async #handleRequest(request: AcpRequestMessage): Promise<void> {
    // TODO(spec B70): session/set_mode, session/set_config_option and the
    // legacy session/set_model are not served, and no current_mode_update or
    // config_option_update is ever emitted.
    try {
      switch (request.method) {
        case ACP_METHODS.initialize: {
          parseInitializeParams(request.params);
          await this.#writer.write(
            createAcpSuccess(
              request.id,
              buildInitializeResult({
                name: this.#options.name ?? PROGRAM,
                version: this.#options.version ?? PRODUCT_VERSION,
                title: this.#options.title ?? "Factory Droid",
                ...(this.#options.deployment === undefined
                  ? {}
                  : { deployment: this.#options.deployment }),
              }),
            ),
          );
          return;
        }
        case ACP_METHODS.authenticate: {
          await this.#authenticate(request);
          return;
        }
        case ACP_METHODS.logout: {
          this.#authenticated = false;
          await this.#writer.write(createAcpSuccess(request.id, {}));
          return;
        }
        case ACP_METHODS.sessionNew: {
          const result = await this.#newSession(request.params);
          await this.#writer.write(createAcpSuccess(request.id, result));
          return;
        }
        case ACP_METHODS.sessionPrompt: {
          const result = await this.#prompt(request.id, request.params);
          await this.#writer.write(createAcpSuccess(request.id, result));
          return;
        }
        case ACP_METHODS.sessionClose: {
          this.#closeSession(parseSessionIdParams(request.params).sessionId);
          await this.#writer.write(createAcpSuccess(request.id, {}));
          return;
        }
        default:
          // TODO(spec B61): session/load, session/resume, session/fork and
          // session/list are advertised by initialize but this slice does not
          // serve them. They answer method-not-found rather than pretending
          // to succeed.
          await this.#writer.write(
            createAcpFailure(
              request.id,
              ACP_ERROR_CODES.methodNotFound,
              `"Method not found": ${request.method}`,
              { method: request.method },
            ),
          );
      }
    } catch (error) {
      const protocol =
        error instanceof AcpProtocolError
          ? error
          : new AcpProtocolError(
              ACP_ERROR_CODES.internal,
              error instanceof Error ? error.message : "Internal error",
              { method: request.method },
            );
      await this.#writer.write(
        createAcpFailure(
          request.id,
          protocol.code,
          protocol.message,
          protocol.data,
        ),
      );
    }
  }

  async #authenticate(request: AcpRequestMessage): Promise<void> {
    const params = parseAuthenticateParams(request.params);
    const known = authMethodsFor(this.#options.deployment ?? "cloud").map(
      (method) => method.id,
    );
    if (!known.includes(params.methodId) && params.methodId !== "api-key") {
      throw new AcpProtocolError(
        ACP_ERROR_CODES.invalidParams,
        `Invalid params: Unsupported authentication method: ${params.methodId}`,
        { methodId: params.methodId },
      );
    }
    if (this.#options.authenticate !== undefined) {
      const accepted = await this.#options.authenticate(params.methodId);
      if (!accepted) {
        throw new AcpProtocolError(
          ACP_ERROR_CODES.authRequired,
          "Authentication required",
        );
      }
    }
    this.#authenticated = true;
    await this.#writer.write(createAcpSuccess(request.id, {}));
  }

  async #newSession(params: unknown): Promise<AcpNewSessionResult> {
    if (!this.#authenticated) {
      throw new AcpProtocolError(
        ACP_ERROR_CODES.authRequired,
        "Authentication required",
      );
    }
    const parsed = parseNewSessionParams(params);
    const sessionId = (this.#options.nextSessionId ?? (() => randomUUID()))();
    // TODO(spec B63): the session is registered with its cwd and converted
    // MCP servers, but this store has no loading state and no
    // sessionOriginHint column; a reload therefore cannot distinguish a
    // cli_acp session from any other, and the filesystem MCP config the
    // session would merge those servers with is resolved by the caller.
    const row = this.#options.store.registerSession({
      sessionId,
      cwd: parsed.cwd,
      projectKey: "",
      firstEventAt: this.#options.clock(),
    });
    const session: ServerSession = {
      sessionId: row.sessionId,
      cwd: parsed.cwd,
      mcpServers: parsed.mcpServers,
      turn: null,
    };
    this.#sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId };
  }

  #closeSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new AcpProtocolError(
        ACP_ERROR_CODES.invalidParams,
        "Invalid params: Unknown session identifier",
        { sessionId },
      );
    }
    this.#sessions.delete(sessionId);
    const turn = session.turn;
    if (turn !== null) {
      turn.cancelled = true;
      turn.controller.abort();
      this.#resolvePermissions(turn);
    }
    this.#options.store.deleteSession(sessionId);
  }

  async #prompt(
    requestId: AcpRequestId,
    rawParams: unknown,
  ): Promise<{ readonly stopReason: AcpStopReason }> {
    const params: AcpPromptParams = parsePromptParams(rawParams);
    const session = this.#sessions.get(params.sessionId);
    if (session === undefined) {
      throw new AcpProtocolError(
        ACP_ERROR_CODES.invalidParams,
        "Invalid params: Unknown session identifier",
        { sessionId: params.sessionId },
      );
    }
    if (session.turn !== null) {
      throw new AcpProtocolError(
        ACP_ERROR_CODES.invalidRequest,
        "Invalid request: A prompt is already running for this session",
        { sessionId: params.sessionId },
      );
    }

    const controller = new AbortController();
    const turn: ActiveTurn = { requestId, controller, cancelled: false };
    session.turn = turn;

    const prompt =
      formatPromptForExec(params.prompt).trim() || "Process request";
    const request: AcpTurnRequest = {
      prompt,
      cwd: session.cwd,
      sessionId: session.sessionId,
      model: this.#options.model ?? "",
      reasoningEffort:
        this.#options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      tools: this.#options.tools ?? [],
      messageId: (this.#options.nextMessageId ?? (() => randomUUID()))(),
      images: extractImagesFromPrompt(params.prompt),
      signal: controller.signal,
    };
    const sink: AcpTurnSink = createAcpTurnSink({
      sessionId: session.sessionId,
      update: (update) => this.#sendUpdate(session, update),
      requestPermission: (permissionParams) =>
        this.#requestPermission(session, turn, permissionParams),
      signal: controller.signal,
    });

    try {
      return await runAcpTurn({
        runner: this.#options.turnRunner,
        request,
        sink,
        ...(this.#options.isModerationRefusal === undefined
          ? {}
          : { isModerationRefusal: this.#options.isModerationRefusal }),
      });
    } finally {
      if (session.turn === turn) session.turn = null;
      this.#resolvePermissions(turn);
    }
  }

  async #sendUpdate(
    session: ServerSession,
    update: AcpSessionUpdate,
  ): Promise<void> {
    // A closed session must not be revived by a turn that outlives it (B71).
    if (this.#sessions.get(session.sessionId) !== session) return;
    await this.#writer.write(
      createSessionUpdateNotification(session.sessionId, update),
    );
  }

  /* --------------------------- notifications ----------------------------- */

  async #handleNotification(message: {
    readonly method: string;
    readonly params?: unknown;
  }): Promise<void> {
    switch (message.method) {
      case ACP_METHODS.sessionCancel: {
        let sessionId: string;
        try {
          sessionId = parseCancelParams(message.params).sessionId;
        } catch {
          return;
        }
        this.#cancelSession(sessionId);
        return;
      }
      case ACP_METHODS.cancelRequest: {
        let requestId: AcpRequestId;
        try {
          requestId = parseCancelRequestParams(message.params).requestId;
        } catch {
          return;
        }
        this.#cancelRequest(requestId);
        return;
      }
      default:
        // A notification has no response, so an unknown one is ignored.
        return;
    }
  }

  #cancelSession(sessionId: string): void {
    const turn = this.#sessions.get(sessionId)?.turn;
    if (turn === undefined || turn === null) return;
    turn.cancelled = true;
    turn.controller.abort();
    this.#resolvePermissions(turn);
  }

  #cancelRequest(requestId: AcpRequestId): void {
    for (const session of this.#sessions.values()) {
      const turn = session.turn;
      if (turn === null || turn.requestId !== requestId) continue;
      turn.cancelled = true;
      turn.controller.abort();
      this.#resolvePermissions(turn);
      return;
    }
  }

  /* ---------------------------- permissions ------------------------------ */

  async #requestPermission(
    session: ServerSession,
    turn: ActiveTurn,
    params: AcpRequestPermissionParams,
  ): Promise<AcpPermissionResponse> {
    if (turn.cancelled || turn.controller.signal.aborted) return CANCELLED;
    const id = (
      this.#options.nextRequestId ??
      (() => {
        this.#permissionRequestCounter += 1;
        return this.#permissionRequestCounter;
      })
    )();
    const key = String(id);
    const { promise, resolve } = Promise.withResolvers<AcpPermissionResponse>();
    this.#pendingPermissions.set(key, { turn, resolve });

    const onAbort = (): void => {
      const pending = this.#pendingPermissions.get(key);
      if (pending === undefined) return;
      this.#pendingPermissions.delete(key);
      pending.resolve(CANCELLED);
    };
    turn.controller.signal.addEventListener("abort", onAbort, { once: true });

    const accepted = await this.#writer.write(
      createAcpRequest(id, ACP_METHODS.requestPermission, params),
    );
    if (!accepted) {
      this.#pendingPermissions.delete(key);
      turn.controller.signal.removeEventListener("abort", onAbort);
      return CANCELLED;
    }
    const response = await promise;
    turn.controller.signal.removeEventListener("abort", onAbort);
    return response;
  }

  #resolvePermissions(turn: ActiveTurn): void {
    for (const [key, pending] of this.#pendingPermissions) {
      if (pending.turn !== turn) continue;
      this.#pendingPermissions.delete(key);
      pending.resolve(CANCELLED);
    }
  }

  #handleResponse(message: AcpResponseMessage): void {
    if (message.id === null) return;
    const key = String(message.id);
    const pending = this.#pendingPermissions.get(key);
    if (pending === undefined) return;
    this.#pendingPermissions.delete(key);
    if ("error" in message) {
      pending.resolve(CANCELLED);
      return;
    }
    try {
      pending.resolve(parsePermissionResponse(message.result));
    } catch {
      pending.resolve(CANCELLED);
    }
  }
}

/** Build the ACP server; `run()` starts reading. */
export function createAcpServer(options: AcpServerOptions): AcpServer {
  return new AcpServerImpl(options);
}
