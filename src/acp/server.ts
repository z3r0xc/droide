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

import { DISPLAY, PRODUCT_VERSION, PROGRAM } from "../cli/brand.ts";
import {
  createAcpTurnSink,
  runAcpTurn,
  type AcpPermissionResponse,
  type AcpTurnRequest,
  type AcpTurnResult,
  type AcpTurnRunner,
  type AcpTurnSink,
} from "../exec/acp-runner.ts";
import type { ExecUsage } from "../exec/records.ts";
import { isBrokenPipeError } from "../exec/writer.ts";
import {
  ACP_CONFIG_IDS,
  ACP_ERROR_CODES,
  ACP_MAX_FRAME_BYTES,
  ACP_METHODS,
  ACP_REASONING_EFFORTS,
  AcpProtocolError,
  authMethodsFor,
  availableCommandsUpdate,
  buildInitializeResult,
  clampMode,
  configOptionUpdate,
  configOptionsFor,
  createAcpFailure,
  createAcpRequest,
  createAcpSuccess,
  createSessionUpdateNotification,
  currentModeUpdate,
  extractImagesFromPrompt,
  formatPromptForExec,
  parseAcpFrame,
  parseAuthenticateParams,
  parseCancelParams,
  parseCancelRequestParams,
  parseInitializeParams,
  parseListSessionsParams,
  parseNewSessionParams,
  parsePermissionResponse,
  parsePromptParams,
  parseSessionHandleParams,
  parseSessionIdParams,
  parseSetConfigOptionParams,
  parseSetModeParams,
  parseSetModelParams,
  serializeAcpMessage,
  sessionInfoUpdate,
  sessionUpdatesFromTranscript,
  usageUpdate,
  type AcpAvailableCommand,
  type AcpDeployment,
  type AcpInboundMessage,
  type AcpListSessionsResult,
  type AcpModeId,
  type AcpNewSessionResult,
  type AcpPromptParams,
  type AcpRequestId,
  type AcpRequestMessage,
  type AcpRequestPermissionParams,
  type AcpResponseMessage,
  type AcpSessionInfo,
  type AcpSessionConfigOption,
  type AcpSessionMcpServer,
  type AcpSessionSettings,
  type AcpSessionUpdate,
  type AcpStopReason,
} from "./protocol.ts";

/* -------------------------------------------------------------------------- */
/* Public seams                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the session store an ACP session needs: create one, remove it,
 * and — when the embedding keeps transcripts — list and read them so
 * `session/list`, `session/load` and `session/fork` can reach a session the
 * agent did not create in this process (B71). `SessionStore` satisfies this
 * structurally.
 */
export interface AcpSessionStore {
  registerSession(input: {
    readonly sessionId?: string;
    readonly cwd?: string | null;
    readonly projectKey?: string;
    readonly firstEventAt?: number | null;
    /** `cli_acp` for a session this agent creates (B63); absent means none. */
    readonly originHint?: string | null;
  }): { readonly sessionId: string };
  deleteSession(sessionId: string): boolean;
  /** Rows for `session/list`; absent means only live sessions are listed. */
  listSessions?(options?: {
    readonly cwd?: string | null;
    readonly limit?: number;
  }): readonly AcpStoredSession[];
  /** A session's transcript; absent or a throw means it cannot be loaded. */
  readSession?(sessionId: string): readonly Readonly<Record<string, unknown>>[];
  /**
   * A session's stored metadata, or `null` when the row is gone: the title
   * `session_info_update` reports (B68) and the producer hint `session/load`
   * and `session/resume` keep (B63). Absent means this embedding keeps
   * neither, so no info update is sent and a re-opened session reports no
   * hint. A throw is treated as "no metadata".
   */
  readSessionMeta?(sessionId: string): AcpSessionMeta | null;
}

/** The stored columns `session_info_update` and `session/list` report. */
export interface AcpSessionMeta {
  readonly title: string | null;
  readonly originHint?: string | null;
}

/** The columns `session/list` reads from a stored session row. */
export interface AcpStoredSession {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly updatedAt: number | null;
  /** The row's producer hint, reported as `_meta.droide.originHint` (B63). */
  readonly originHint?: string | null;
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
  /** The session's starting autonomy mode; defaults to `normal` (B70). */
  readonly mode?: string;
  /** The org's autonomy ceiling; modes above it are not offered (B70). */
  readonly maxAutonomyLevel?: string;
  readonly tools?: readonly string[];
  readonly maxFrameBytes?: number;
  readonly isModerationRefusal?: (message: string) => boolean;
  /**
   * The session's slash commands, resolved from the user-invocable skills
   * (B57), sent as `available_commands_update` (B68). Absent means the client
   * is offered none and no update is sent.
   */
  readonly commands?: (
    sessionId: string,
  ) => readonly AcpAvailableCommand[] | Promise<readonly AcpAvailableCommand[]>;
  /**
   * The context window of a model in tokens, for `usage_update`'s `size`
   * (B68). Absent or `null` means the size is unknown, and no usage update is
   * sent: the update says how full the window is, so a guessed denominator
   * would be a wrong percentage rather than an absent one.
   */
  readonly contextLimitFor?: (model: string) => number | null;
}

export interface AcpServer {
  /** Reads until EOF, then cancels turns, settles them and flushes frames. */
  run(): Promise<void>;
  /** Stops early: aborts turns and answers pending permissions as cancelled. */
  close(): Promise<void>;
  /**
   * The process exit status this session earned (B54/B55): `0` when every
   * prompt ended `end_turn` (or none ran), `1` when a prompt was refused,
   * cancelled or failed.
   */
  readonly exitCode: number;
}

const DEFAULT_REASONING_EFFORT = "medium";

/**
 * The producer hint an ACP session's row carries (B63). A later process reads
 * it back through `session/list`, so a `cli_acp` session stays distinguishable
 * from one another producer created.
 */
const ACP_ORIGIN_HINT = "cli_acp";

/** Ceiling for one `session/list` page; matches the store's list limit. */
const MAX_LISTED_SESSIONS = 1000;

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
  /** The row's producer hint, `cli_acp` for a session this agent made (B63). */
  readonly originHint: string | null;
  /** Per-session settings, changed by `session/set_*` (B70). */
  model: string;
  reasoningEffort: string;
  modeId: AcpModeId;
  readonly createdAt: number;
  turn: ActiveTurn | null;
  /** The title the client was last told; `undefined` means never reported. */
  reportedTitle: string | null | undefined;
  /** The command set last sent, serialised; `null` means none yet. */
  sentCommands: string | null;
  /** The usage update last sent, serialised (B68's "no repeats"). */
  sentUsage: string | null;
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
  #failed = false;
  #shutdown: Promise<void> | undefined;

  get exitCode(): number {
    return this.#failed ? 1 : 0;
  }

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
                title: this.#options.title ?? DISPLAY,
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
          const created = await this.#newSession(request.params);
          await this.#writer.write(
            createAcpSuccess(request.id, created.result),
          );
          await this.#publishSessionStart(created.session);
          return;
        }
        case ACP_METHODS.sessionLoad: {
          const session = await this.#loadSession(request.params);
          await this.#writer.write(createAcpSuccess(request.id, {}));
          await this.#publishSessionStart(session);
          return;
        }
        case ACP_METHODS.sessionResume: {
          const session = await this.#resumeSession(request.params);
          await this.#writer.write(createAcpSuccess(request.id, {}));
          await this.#publishSessionStart(session);
          return;
        }
        case ACP_METHODS.sessionFork: {
          const created = await this.#forkSession(request.params);
          await this.#writer.write(
            createAcpSuccess(request.id, created.result),
          );
          await this.#publishSessionStart(created.session);
          return;
        }
        case ACP_METHODS.sessionList: {
          await this.#writer.write(
            createAcpSuccess(request.id, this.#listSessions(request.params)),
          );
          return;
        }
        case ACP_METHODS.sessionPrompt: {
          const result = await this.#prompt(request.id, request.params);
          if (result.stopReason !== "end_turn") this.#failed = true;
          await this.#writer.write(createAcpSuccess(request.id, result));
          return;
        }
        case ACP_METHODS.sessionSetMode: {
          await this.#setMode(request.params);
          await this.#writer.write(createAcpSuccess(request.id, {}));
          return;
        }
        case ACP_METHODS.sessionSetConfigOption: {
          const result = await this.#setConfigOption(request.params);
          await this.#writer.write(createAcpSuccess(request.id, result));
          return;
        }
        case ACP_METHODS.sessionSetModel: {
          await this.#setModel(request.params);
          await this.#writer.write(createAcpSuccess(request.id, {}));
          return;
        }
        case ACP_METHODS.sessionClose: {
          this.#closeSession(parseSessionIdParams(request.params).sessionId);
          await this.#writer.write(createAcpSuccess(request.id, {}));
          return;
        }
        default:
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
      // B55: a prompt that could not be answered is a failed run.
      if (request.method === ACP_METHODS.sessionPrompt) this.#failed = true;
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
    if (!known.includes(params.methodId)) {
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

  /**
   * B63: the row records this producer, so a later process can tell a
   * `cli_acp` session from one another producer made. Nothing about "loading"
   * is stored: a load that fails must leave no mark on the row, so a load in
   * flight is this process's state alone.
   */
  async #newSession(params: unknown): Promise<{
    readonly result: AcpNewSessionResult;
    readonly session: ServerSession;
  }> {
    this.#requireAuth();
    const parsed = parseNewSessionParams(params);
    const sessionId = (this.#options.nextSessionId ?? (() => randomUUID()))();
    const row = this.#options.store.registerSession({
      sessionId,
      cwd: parsed.cwd,
      projectKey: "",
      firstEventAt: this.#options.clock(),
      originHint: ACP_ORIGIN_HINT,
    });
    const session = this.#adopt({
      sessionId: row.sessionId,
      cwd: parsed.cwd,
      mcpServers: parsed.mcpServers,
      originHint: ACP_ORIGIN_HINT,
    });
    return { result: { sessionId: session.sessionId }, session };
  }

  /**
   * Re-open a stored session and replay its transcript as `session/update`
   * notifications before the response (B71). A session this process already
   * holds is re-attached without a second replay, so a client that reloads
   * twice does not see its history twice. The row keeps its producer hint, so
   * a re-opened `cli_acp` session is still one (B63).
   */
  async #loadSession(rawParams: unknown): Promise<ServerSession> {
    this.#requireAuth();
    const params = parseSessionHandleParams(rawParams);
    const live = this.#sessions.get(params.sessionId);
    if (live !== undefined) return live;
    const { known, records } = this.#readTranscript(params.sessionId);
    if (!known) throw this.#unknownStoredSession(params.sessionId);
    const session = this.#adopt({
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      originHint: this.#storedMeta(params.sessionId)?.originHint ?? null,
    });
    for (const update of sessionUpdatesFromTranscript(records)) {
      await this.#sendUpdate(session, update);
    }
    return session;
  }

  /** Re-attach a stored session without replaying its history (B71). */
  async #resumeSession(rawParams: unknown): Promise<ServerSession> {
    this.#requireAuth();
    const params = parseSessionHandleParams(rawParams);
    const live = this.#sessions.get(params.sessionId);
    if (live !== undefined) return live;
    const { known } = this.#readTranscript(params.sessionId);
    if (!known) throw this.#unknownStoredSession(params.sessionId);
    return this.#adopt({
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      originHint: this.#storedMeta(params.sessionId)?.originHint ?? null,
    });
  }

  /**
   * Fork a session: a new id with the parent's history replayed, so the client
   * can continue down a second branch (B71). The parent may be live or stored;
   * an id the agent knows nothing about is not found.
   */
  async #forkSession(rawParams: unknown): Promise<{
    readonly result: AcpNewSessionResult;
    readonly session: ServerSession;
  }> {
    this.#requireAuth();
    const params = parseSessionHandleParams(rawParams);
    const live = this.#sessions.get(params.sessionId);
    const { known, records } = this.#readTranscript(params.sessionId);
    if (live === undefined && !known) {
      throw this.#unknownStoredSession(params.sessionId);
    }
    const sessionId = (this.#options.nextSessionId ?? (() => randomUUID()))();
    const row = this.#options.store.registerSession({
      sessionId,
      cwd: params.cwd,
      projectKey: "",
      firstEventAt: this.#options.clock(),
      originHint: ACP_ORIGIN_HINT,
    });
    const session = this.#adopt({
      sessionId: row.sessionId,
      cwd: params.cwd,
      mcpServers: live?.mcpServers ?? params.mcpServers,
      originHint: ACP_ORIGIN_HINT,
    });
    for (const update of sessionUpdatesFromTranscript(records)) {
      await this.#sendUpdate(session, update);
    }
    return { result: { sessionId: session.sessionId }, session };
  }

  /**
   * `SessionInfo` rows for the client's session picker (B71). The store is the
   * source when it can list; otherwise only the sessions this process holds
   * are listable. A row with no `cwd` cannot be re-opened (`session/load`
   * requires one), so it is not offered.
   */
  #listSessions(rawParams: unknown): AcpListSessionsResult {
    const params = parseListSessionsParams(rawParams);
    const listSessions = this.#options.store.listSessions;
    const rows: readonly AcpStoredSession[] =
      listSessions === undefined
        ? [...this.#sessions.values()].map((session) => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            title: null,
            updatedAt: session.createdAt,
            originHint: session.originHint,
          }))
        : listSessions.call(this.#options.store, {
            limit: MAX_LISTED_SESSIONS,
            ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
          });
    const sessions: AcpSessionInfo[] = [];
    for (const row of rows) {
      if (row.cwd === null || row.cwd === "") continue;
      const originHint = row.originHint ?? null;
      sessions.push({
        sessionId: row.sessionId,
        cwd: row.cwd,
        title: row.title,
        updatedAt:
          row.updatedAt === null ? null : new Date(row.updatedAt).toISOString(),
        ...(originHint === null || originHint === ""
          ? {}
          : { _meta: { droide: { originHint } } }),
      });
    }
    return { sessions };
  }

  /** `session/set_mode` (B70): clamp, store and announce the new mode. */
  async #setMode(rawParams: unknown): Promise<void> {
    const params = parseSetModeParams(rawParams);
    const session = this.#session(params.sessionId);
    const modeId = clampMode(params.modeId, this.#options.maxAutonomyLevel);
    if (modeId === session.modeId) return;
    session.modeId = modeId;
    await this.#announceSettings(session, true);
  }

  /**
   * `session/set_config_option` (B70). The response carries the full option
   * set, so a client that lost the previous one is back in sync.
   */
  async #setConfigOption(
    rawParams: unknown,
  ): Promise<{ readonly configOptions: readonly AcpSessionConfigOption[] }> {
    const params = parseSetConfigOptionParams(rawParams);
    const session = this.#session(params.sessionId);
    if (typeof params.value !== "string") {
      throw new AcpProtocolError(
        ACP_ERROR_CODES.invalidParams,
        `Invalid params: ${params.configId} takes a string value`,
        { configId: params.configId },
      );
    }
    let modeChanged = false;
    let changed = false;
    switch (params.configId) {
      case ACP_CONFIG_IDS.model:
        changed = params.value !== session.model;
        session.model = params.value;
        break;
      case ACP_CONFIG_IDS.reasoningEffort: {
        if (!ACP_REASONING_EFFORTS.includes(params.value)) {
          throw new AcpProtocolError(
            ACP_ERROR_CODES.invalidParams,
            "Invalid params: reasoning_effort must be low, medium or high",
            { value: params.value },
          );
        }
        changed = params.value !== session.reasoningEffort;
        session.reasoningEffort = params.value;
        break;
      }
      case ACP_CONFIG_IDS.autonomy: {
        const modeId = clampMode(params.value, this.#options.maxAutonomyLevel);
        modeChanged = modeId !== session.modeId;
        changed = modeChanged;
        session.modeId = modeId;
        break;
      }
      default:
        throw new AcpProtocolError(
          ACP_ERROR_CODES.invalidParams,
          `Invalid params: ${params.configId} is not a config option`,
          { configId: params.configId },
        );
    }
    if (changed) await this.#announceSettings(session, modeChanged);
    return { configOptions: this.#configOptions(session) };
  }

  /** The legacy `session/set_model`, routed through the settings path (B70). */
  async #setModel(rawParams: unknown): Promise<void> {
    const params = parseSetModelParams(rawParams);
    const session = this.#session(params.sessionId);
    if (params.modelId === session.model) return;
    session.model = params.modelId;
    await this.#announceSettings(session, false);
  }

  /**
   * B70: a mode change is `current_mode_update`, and any change to mode, model
   * or effort is the full `config_option_update`.
   */
  async #announceSettings(
    session: ServerSession,
    modeChanged: boolean,
  ): Promise<void> {
    if (modeChanged) {
      await this.#sendUpdate(session, currentModeUpdate(session.modeId));
    }
    await this.#sendUpdate(
      session,
      configOptionUpdate(this.#configOptions(session)),
    );
  }

  #configOptions(session: ServerSession): readonly AcpSessionConfigOption[] {
    return configOptionsFor(
      this.#settingsOf(session),
      this.#options.maxAutonomyLevel,
    );
  }

  #settingsOf(session: ServerSession): AcpSessionSettings {
    return {
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      modeId: session.modeId,
    };
  }

  #closeSession(sessionId: string): void {
    const session = this.#session(sessionId);
    this.#sessions.delete(sessionId);
    const turn = session.turn;
    if (turn !== null) {
      turn.cancelled = true;
      turn.controller.abort();
      this.#resolvePermissions(turn);
    }
    this.#options.store.deleteSession(sessionId);
  }

  #requireAuth(): void {
    if (this.#authenticated) return;
    throw new AcpProtocolError(
      ACP_ERROR_CODES.authRequired,
      "Authentication required",
    );
  }

  #session(sessionId: string): ServerSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new AcpProtocolError(
        ACP_ERROR_CODES.invalidParams,
        "Invalid params: Unknown session identifier",
        { sessionId },
      );
    }
    return session;
  }

  #unknownStoredSession(sessionId: string): AcpProtocolError {
    return new AcpProtocolError(
      ACP_ERROR_CODES.resourceNotFound,
      `Session ${sessionId} is not stored`,
      { sessionId },
    );
  }

  /**
   * A session's transcript through the store. `known` is false when the
   * embedding keeps no transcripts or does not have this one, which is what
   * separates "cannot load" from "loads nothing".
   */
  #readTranscript(sessionId: string): {
    readonly known: boolean;
    readonly records: readonly Readonly<Record<string, unknown>>[];
  } {
    const readSession = this.#options.store.readSession;
    if (readSession === undefined) return { known: false, records: [] };
    try {
      return {
        known: true,
        records: readSession.call(this.#options.store, sessionId),
      };
    } catch {
      return { known: false, records: [] };
    }
  }

  /** Create the live session record for an id that already has a store row. */
  #adopt(input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers: readonly AcpSessionMcpServer[];
    readonly originHint: string | null;
  }): ServerSession {
    const session: ServerSession = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: input.mcpServers,
      originHint: input.originHint,
      model: this.#options.model ?? "",
      reasoningEffort:
        this.#options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      modeId: clampMode(
        this.#options.mode ?? "normal",
        this.#options.maxAutonomyLevel,
      ),
      createdAt: this.#options.clock(),
      turn: null,
      // A session re-opened into a new client has reported nothing to it yet,
      // so the first title and command set do go out (B68).
      reportedTitle: undefined,
      sentCommands: null,
      sentUsage: null,
    };
    this.#sessions.set(session.sessionId, session);
    return session;
  }

  /** The row's title and producer hint; `null` when the row or seam is gone. */
  #storedMeta(sessionId: string): AcpSessionMeta | null {
    const readSessionMeta = this.#options.store.readSessionMeta;
    if (readSessionMeta === undefined) return null;
    try {
      return readSessionMeta.call(this.#options.store, sessionId);
    } catch {
      return null;
    }
  }

  async #prompt(
    requestId: AcpRequestId,
    rawParams: unknown,
  ): Promise<{ readonly stopReason: AcpStopReason }> {
    const params: AcpPromptParams = parsePromptParams(rawParams);
    // B65: images are validated (type, ceiling) before the session is marked
    // busy, so a refused prompt leaves no half-started turn behind.
    const images = extractImagesFromPrompt(params.prompt).map((image) => ({
      mediaType: image.mimeType,
      data: image.data,
    }));
    const session = this.#session(params.sessionId);
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
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      tools: this.#options.tools ?? [],
      messageId: (this.#options.nextMessageId ?? (() => randomUUID()))(),
      images,
      mode: session.modeId,
      signal: controller.signal,
    };
    const sink: AcpTurnSink = createAcpTurnSink({
      sessionId: session.sessionId,
      update: (update) => this.#sendUpdate(session, update),
      requestPermission: (permissionParams) =>
        this.#requestPermission(session, turn, permissionParams),
      signal: controller.signal,
    });

    // The command set is resolved as the turn starts: a skill enabled, added
    // or removed since the last prompt reaches the client's menu before the
    // turn's own updates (B68).
    await this.#announceCommands(session);
    let result: AcpTurnResult;
    try {
      result = await runAcpTurn({
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
    // Both keep their last reported value, so a turn that changed neither
    // sends neither (B68), and both flush before the prompt response (B65).
    await this.#announceUsage(session, result.usage);
    await this.#announceSessionInfo(session);
    return { stopReason: result.stopReason };
  }

  /**
   * `usage_update` when a completed turn reports token counts and the model's
   * context limit is known (B68). `used` is what the turn put in the window —
   * input, cache reads and output — and `size` is the limit the same model
   * compacts against, so a repeat of the same numbers is not re-sent.
   */
  async #announceUsage(
    session: ServerSession,
    usage: ExecUsage | null,
  ): Promise<void> {
    if (usage === null) return;
    const size = this.#options.contextLimitFor?.(session.model) ?? null;
    if (size === null || !Number.isFinite(size) || size <= 0) return;
    const used =
      usage.input_tokens + usage.cache_read_input_tokens + usage.output_tokens;
    const update = usageUpdate(used, size);
    const seen = JSON.stringify(update);
    if (seen === session.sentUsage) return;
    session.sentUsage = seen;
    await this.#sendUpdate(session, update);
  }

  /**
   * `session_info_update` when the stored title differs from the one this
   * process last told the client (B68). A session with no title has nothing to
   * report, and an unchanged title is not a change.
   */
  async #announceSessionInfo(session: ServerSession): Promise<void> {
    const meta = this.#storedMeta(session.sessionId);
    if (meta === null) return;
    if (meta.title === session.reportedTitle) return;
    const previous = session.reportedTitle;
    session.reportedTitle = meta.title;
    // A title that was never there is not news; one that was cleared is.
    if (meta.title === null && previous === undefined) return;
    await this.#sendUpdate(
      session,
      sessionInfoUpdate(
        meta.title,
        new Date(this.#options.clock()).toISOString(),
      ),
    );
  }

  /**
   * `available_commands_update` when the session's command set differs from
   * the set last sent (B68). Withheld until the `session/new` response, so a
   * client knows the session id an update belongs to.
   */
  async #announceCommands(session: ServerSession): Promise<void> {
    const commands = this.#options.commands;
    if (commands === undefined) return;
    let resolved: readonly AcpAvailableCommand[];
    try {
      resolved = await commands(session.sessionId);
    } catch {
      return;
    }
    const update = availableCommandsUpdate(resolved);
    const seen = JSON.stringify(update.availableCommands);
    if (seen === session.sentCommands) return;
    session.sentCommands = seen;
    await this.#sendUpdate(session, update);
  }

  /**
   * What a client learns about a session once its id is known: its stored
   * title and its slash commands (B68). Both are no-ops when nothing changed,
   * and both are sent after the response, so an update never names a session
   * the client has not been given yet.
   */
  async #publishSessionStart(session: ServerSession): Promise<void> {
    await this.#announceSessionInfo(session);
    await this.#announceCommands(session);
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
