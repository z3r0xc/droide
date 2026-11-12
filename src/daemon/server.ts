/**
 * The daemon server: transport selection, bind, readiness and ordered
 * shutdown. Contract: `specs/70-daemon-and-remote-control.md` B3, B5–B8,
 * B10, B11, B15–B18, B31.
 *
 * One server owns one endpoint. Exclusivity is the bind itself — there is no
 * lock file and no discovery file (B4) — so a second server on the same
 * endpoint loses after the retry budget and reports a startup failure. Every
 * connection authenticates on its own first request; the version comparison is
 * advisory and only decorates failures.
 */

import type { Server } from "node:http";

import { PRODUCT_VERSION } from "../cli/brand.ts";

import {
  AUTHENTICATE_METHOD,
  CONNECTION_STATUS_METHOD,
  LOGOUT_METHOD,
  DaemonConnectionAuth,
  gateEnvelope,
  isPipelineMethod,
  parseAuthenticateRequest,
  type AuthenticateRequest,
  type DaemonAuthPolicy,
  type DaemonConnectionStatus,
  type DaemonIdentity,
  type PipelinedRequest,
} from "./auth.ts";
import {
  DaemonAuthenticationError,
  DaemonProtocolError,
  DaemonStartupError,
} from "./errors.ts";
import {
  DAEMON_BIND_RETRY_DELAYS_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  FACTORY_PROTOCOL_VERSION,
  JSON_RPC_ERRORS,
  attachVersionMismatch,
  createErrorObject,
  createErrorResponse,
  createNotification,
  createSuccessResponse,
  encodeBinaryFrame,
  envelopeVersionMismatch,
  negotiateEncoding,
  parseBinaryFrame,
  parseIpcFrame,
  parseTextFrame,
  serializeEnvelope,
  type DaemonEnvelope,
  type DaemonRequestEnvelope,
  type ProtocolVersionMismatch,
} from "./protocol.ts";
import {
  PARENT_PID_POLL_INTERVAL_MS,
  isProcessAlive,
  watchParentPid,
  watchLivenessPipe,
  type LivenessPipeOpener,
  type LivenessWatcher,
} from "./liveness.ts";
import { systemTimers, type DaemonTimers } from "./timers.ts";
import {
  WS_CLOSE,
  attachWebSocketServer,
  createDaemonHttpServer,
  type DaemonTarget,
  type DaemonTransport,
  type DaemonTransportHandlers,
  type ServerWebSocketTransport,
} from "./web-socket.ts";

/** Daemon product version carried in the ready message and banner. */
export const DAEMON_VERSION = PRODUCT_VERSION;
/** Loopback default (B1, B31). */
export const DEFAULT_HOST = "127.0.0.1";

export interface DaemonLogger {
  debug(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

const silentLogger: DaemonLogger = {
  debug() {},
  info() {},
  error() {},
};

export type ParentChannelMessageListener = (message: unknown) => void;
export type ParentChannelDisconnectListener = () => void;

/**
 * The Node parent/child IPC channel as this server needs it. Tests inject a
 * fake; `process` satisfies the shape in the entrypoint.
 */
export interface DaemonParentChannel {
  readonly connected?: boolean;
  send(message: string): void;
  onMessage(listener: ParentChannelMessageListener): void;
  onDisconnect(listener: ParentChannelDisconnectListener): void;
  offMessage?(listener: ParentChannelMessageListener): void;
  offDisconnect?(listener: ParentChannelDisconnectListener): void;
}

/** Where the daemon ended up listening. */
export type DaemonEndpoint =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "unix"; readonly unixPath: string }
  | { readonly kind: "ipc" }
  | { readonly kind: "none" };

/** What a bound endpoint lets a supervisor report without guessing. */
export interface DaemonMethodContext {
  readonly connectionId: number;
  readonly identity: DaemonIdentity | undefined;
  notify(method: string, params?: unknown): void;
}

export type DaemonMethodHandler = (
  params: unknown,
  context: DaemonMethodContext,
) => unknown | Promise<unknown>;

/** One ordered shutdown participant (B8). */
export interface DaemonShutdownStep {
  readonly name: string;
  stop(): void | Promise<void>;
}

export interface DaemonServerOptions {
  /** `ipc` opens no socket; defaults to `websocket` (B1, B3). */
  readonly listen?: "websocket" | "ipc";
  readonly host?: string;
  /** `0` asks the OS for a port; the bound port is what is advertised. */
  readonly port?: number;
  /** Wins over `--port` (B3). */
  readonly unixPath?: string;
  readonly auth: DaemonAuthPolicy;
  readonly version?: string;
  /** Defaults to {@link FACTORY_PROTOCOL_VERSION}. */
  readonly protocolVersion?: string;
  readonly pid?: number;
  readonly platform?: string;
  readonly homedir: string;
  readonly logsPath?: string;
  readonly connectionStatus?: Partial<DaemonConnectionStatus>;
  readonly methods?: Readonly<Record<string, DaemonMethodHandler>>;
  readonly onNotification?: (
    method: string,
    params: unknown,
    context: DaemonMethodContext,
  ) => void;
  readonly parentChannel?: DaemonParentChannel;
  /** `--parent-pid`: polled for liveness (B10). */
  readonly parentPid?: number;
  /** `--liveness-fd`: the inherited pipe that ends when the parent is gone. */
  readonly livenessFd?: number;
  /** Defaults to 2000 ms (B10). */
  readonly parentPollIntervalMs?: number;
  /** Defaults to {@link watchLivenessPipe}; a test seam. */
  readonly openLiveness?: LivenessPipeOpener;
  /** Defaults to {@link isProcessAlive}; a test seam. */
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly remoteControl?: boolean;
  /** Injected `sd_notify`; called with `READY=1` after the bind (B5). */
  readonly notifyReady?: (state: string) => void;
  /** The banner sink. The CLI supplies stdout; tests collect lines. */
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly logger?: DaemonLogger;
  readonly timers?: DaemonTimers;
  /** Defaults to 500/1000/2000/4000/8000 ms (B7). */
  readonly bindRetryDelaysMs?: readonly number[];
  readonly shutdownTimeoutMs?: number;
  /** Pre-transport services, stopped before the servers (B8 order). */
  readonly shutdownSteps?: readonly DaemonShutdownStep[];
  readonly onShutdownStep?: (name: string) => void;
  /** Wired by the entrypoint; `runDaemon` also listens for signals. */
  readonly signal?: AbortSignal;
}

export interface DaemonStopResult {
  readonly timedOut: boolean;
}

/** What the transport precedence resolves to before anything is opened. */
export type TransportSelection =
  | { readonly kind: "ipc" }
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "none" };

/**
 * B3: `--listen ipc` opens no socket; otherwise `--unix` wins over `--port`;
 * with neither there is no inbound transport.
 */
export function selectDaemonTransport(options: {
  readonly listen?: "websocket" | "ipc" | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly unixPath?: string | undefined;
}): TransportSelection {
  if (options.listen === "ipc") return { kind: "ipc" };
  if (options.unixPath !== undefined) {
    return { kind: "unix", path: options.unixPath };
  }
  if (options.port !== undefined) {
    return {
      kind: "tcp",
      host: options.host ?? DEFAULT_HOST,
      port: options.port,
    };
  }
  return { kind: "none" };
}

export interface ReadinessBannerOptions {
  readonly version: string;
  readonly pid: number;
  readonly logsPath?: string;
  readonly remoteControl: boolean;
}

/**
 * The fixed readiness banner (B5). The message catalogues are absent from the
 * recovered tree, so the copy is literal English; the line order and the
 * endpoint/relay keys are pinned.
 *
 * TODO(spec B5): the i18n catalogues are absent, so the banner uses literal
 * English with the documented line order instead of `commands:daemon.*` keys.
 */
export function formatReadinessBanner(
  endpoint: DaemonEndpoint,
  options: ReadinessBannerOptions,
): readonly string[] {
  const lines = [
    "Daemon running",
    `Version: ${options.version}`,
    `PID: ${options.pid}`,
    `Logs: ${options.logsPath ?? "(not configured)"}`,
  ];
  switch (endpoint.kind) {
    case "tcp":
      lines.push(`WebSocket endpoint: ws://${endpoint.host}:${endpoint.port}`);
      break;
    case "unix":
      lines.push(`Unix socket: ${endpoint.unixPath}`);
      break;
    case "ipc":
      lines.push("IPC transport: parent process");
      break;
    case "none":
      lines.push(
        "No inbound transport: the daemon is reachable only through Remote Control",
      );
      break;
  }
  if (options.remoteControl) lines.push("Remote Control: enabled");
  lines.push("Press Ctrl+C to stop");
  return lines;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

/** Resolve when the listening event fires, or reject with the bind error. */
async function listenOn(server: Server, target: DaemonTarget): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onError = (error: Error): void => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = (): void => {
    server.off("error", onError);
    resolve();
  };
  server.once("error", onError);
  server.once("listening", onListening);
  if ("port" in target) {
    server.listen(target.port, target.host);
  } else {
    server.listen(target.path);
  }
  await promise;
}

/** One parent/child IPC connection: each frame is one JSON string (B12). */
class IpcTransport implements DaemonTransport {
  private readonly channel: DaemonParentChannel;
  private readonly closedSignal = Promise.withResolvers<void>();
  private handlers: DaemonTransportHandlers | undefined;
  private didClose = false;

  constructor(channel: DaemonParentChannel) {
    this.channel = channel;
  }

  get closed(): boolean {
    return this.didClose;
  }

  setHandlers(handlers: DaemonTransportHandlers): void {
    this.handlers = handlers;
  }

  send(text: string): void {
    if (this.didClose || this.channel.connected === false) return;
    this.channel.send(text);
  }

  close(code: number = WS_CLOSE.normal, reason = ""): void {
    if (this.didClose) return;
    this.didClose = true;
    this.handlers?.onClose(code, reason);
    this.closedSignal.resolve();
  }

  waitForClose(): Promise<void> {
    return this.closedSignal.promise;
  }
}

/** One authenticated JSON-RPC connection, socket or IPC. */
class DaemonConnection {
  readonly id: number;
  private readonly server: DaemonServer;
  private readonly transport: DaemonTransport;
  private readonly auth: DaemonConnectionAuth;
  private encoding: string | undefined;
  private closed = false;

  constructor(server: DaemonServer, transport: DaemonTransport, id: number) {
    this.server = server;
    this.transport = transport;
    this.id = id;
    this.auth = new DaemonConnectionAuth(server.authPolicy);
  }

  get authenticated(): boolean {
    return this.auth.authenticated;
  }

  markClosed(): void {
    this.closed = true;
  }

  close(code: number = WS_CLOSE.normal, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close(code, reason);
  }

  /** Forced teardown: drop the transport without a closing handshake. */
  terminate(): void {
    this.closed = true;
    this.transport.terminate?.();
  }

  waitForClose(): Promise<void> {
    return this.transport.waitForClose();
  }

  /** Handle one text frame from a socket. */
  async receive(text: string): Promise<void> {
    await this.parseAndHandle(() => parseTextFrame(text));
  }

  /** Handle one binary frame; the protocol layer knows the `0x01` tag. */
  async receiveBinary(bytes: Uint8Array): Promise<void> {
    await this.parseAndHandle(() => parseBinaryFrame(bytes));
  }

  /** Handle one parent/child IPC frame. */
  async receiveIpc(value: unknown): Promise<void> {
    await this.parseAndHandle(() => parseIpcFrame(value));
  }

  private async parseAndHandle(parse: () => DaemonEnvelope): Promise<void> {
    if (this.closed) return;
    let envelope: DaemonEnvelope;
    try {
      envelope = parse();
    } catch (error) {
      if (error instanceof DaemonProtocolError) {
        this.sendFailure(null, error.code, error.message, error.data);
      } else {
        this.server.logger.error(
          `[Daemon] frame parse failed: ${messageOf(error)}`,
        );
        this.sendFailure(
          null,
          JSON_RPC_ERRORS.internal,
          "Internal server error",
        );
      }
      return;
    }
    await this.handleEnvelope(envelope);
  }

  private async handleEnvelope(envelope: DaemonEnvelope): Promise<void> {
    if (this.closed) return;
    if (envelope.type === "response") {
      // This daemon sends no server-to-client requests, so a response has no
      // pending slot; drop it with a diagnostic instead of failing (B18).
      this.server.logger.debug(
        `[Daemon] dropped response for unknown id ${String(envelope.id)}`,
      );
      return;
    }
    if (envelope.type === "notification") {
      if (!this.auth.authenticated) return;
      this.server.handleClientNotification(
        envelope.method,
        envelope.params,
        this.context(),
      );
      return;
    }
    const gate = gateEnvelope(this.auth, envelope);
    if (gate.kind === "drop") return;
    if (gate.kind === "reject") {
      this.sendFailure(envelope.id, gate.code, gate.message, gate.data);
      return;
    }
    if (envelope.method === AUTHENTICATE_METHOD) {
      await this.handleAuthenticate(envelope);
      return;
    }
    if (envelope.method === LOGOUT_METHOD) {
      this.sendSuccess(envelope.id, { accepted: true });
      this.close(WS_CLOSE.normal, "logout");
      return;
    }
    await this.dispatchMethod(
      envelope.id,
      envelope.method,
      envelope.params,
      envelope,
    );
  }

  private async handleAuthenticate(
    request: DaemonRequestEnvelope,
  ): Promise<void> {
    const existing = this.auth.identity;
    if (existing !== undefined) {
      // B17: re-authentication answers the connection identity without
      // re-verifying the credential.
      this.sendSuccess(request.id, {
        userId: existing.userId,
        orgId: existing.orgId,
      });
      return;
    }

    let params: AuthenticateRequest;
    try {
      params = parseAuthenticateRequest(request.params);
    } catch (error) {
      if (error instanceof DaemonAuthenticationError) {
        // Invalid schema refinements fail as PARSE_ERROR (B15).
        this.sendFailure(request.id, JSON_RPC_ERRORS.parse, error.message);
        return;
      }
      throw error;
    }

    let identity: DaemonIdentity;
    try {
      identity = this.auth.authenticate(params);
    } catch (error) {
      if (error instanceof DaemonAuthenticationError) {
        this.sendFailure(
          request.id,
          JSON_RPC_ERRORS.authentication,
          error.message,
          error.reason === undefined ? undefined : { reason: error.reason },
        );
        return;
      }
      throw error;
    }

    const pipeline = params.pipeline ?? [];
    if (this.transport.sendBinary !== undefined) {
      this.encoding = negotiateEncoding(params.acceptEncodings);
    }
    this.sendSuccess(request.id, {
      userId: identity.userId,
      orgId: identity.orgId,
      ...(this.encoding === undefined ? {} : { encoding: this.encoding }),
      ...(pipeline.length === 0 ? {} : { pipelined: true }),
    });
    this.sendNotification(
      CONNECTION_STATUS_METHOD,
      this.server.connectionStatus,
    );
    for (const entry of pipeline) {
      await this.dispatchPipelineEntry(entry, request);
    }
  }

  private async dispatchPipelineEntry(
    entry: PipelinedRequest,
    source: DaemonRequestEnvelope,
  ): Promise<void> {
    if (!isPipelineMethod(entry.method)) {
      this.sendFailure(
        entry.id,
        JSON_RPC_ERRORS.invalidRequest,
        "Method is not allowed in the authentication pipeline",
      );
      return;
    }
    await this.dispatchMethod(entry.id, entry.method, entry.params, source);
  }

  private async dispatchMethod(
    id: string,
    method: string,
    params: unknown,
    source: DaemonRequestEnvelope,
  ): Promise<void> {
    const mismatch = envelopeVersionMismatch(
      source,
      this.server.protocolVersion,
    );
    const handler = this.server.methods[method];
    if (handler === undefined) {
      this.sendFailure(
        id,
        JSON_RPC_ERRORS.methodNotFound,
        `Method not found: ${method}`,
        undefined,
        mismatch,
      );
      return;
    }
    try {
      const result = await handler(params, this.context());
      this.sendSuccess(id, result);
    } catch (error) {
      if (error instanceof DaemonProtocolError) {
        this.sendFailure(id, error.code, error.message, error.data);
        return;
      }
      this.server.logger.error(
        `[Daemon] method ${method} failed: ${messageOf(error)}`,
      );
      this.sendFailure(id, JSON_RPC_ERRORS.internal, "Internal server error");
    }
  }

  private context(): DaemonMethodContext {
    return {
      connectionId: this.id,
      identity: this.auth.identity,
      notify: (method, params) => this.sendNotification(method, params),
    };
  }

  private sendSuccess(id: string, result: unknown): void {
    this.sendEnvelope(
      createSuccessResponse(id, result, {
        protocolVersion: this.server.protocolVersion,
      }),
    );
  }

  private sendNotification(method: string, params?: unknown): void {
    this.sendEnvelope(
      createNotification(method, params, {
        protocolVersion: this.server.protocolVersion,
      }),
    );
  }

  private sendFailure(
    id: string | null,
    code: number,
    message: string,
    data?: unknown,
    mismatch?: ProtocolVersionMismatch,
  ): void {
    let error = createErrorObject(code, message, data);
    if (mismatch !== undefined) {
      error = attachVersionMismatch(error, mismatch);
    }
    this.sendEnvelope(
      createErrorResponse(id, error.code, error.message, error.data, {
        protocolVersion: this.server.protocolVersion,
      }),
    );
  }

  private sendEnvelope(envelope: DaemonEnvelope): void {
    if (this.closed) return;
    if (
      this.encoding !== undefined &&
      this.transport.sendBinary !== undefined
    ) {
      this.transport.sendBinary(encodeBinaryFrame(envelope));
      return;
    }
    this.transport.send(serializeEnvelope(envelope));
  }
}

export class DaemonServer {
  readonly authPolicy: DaemonAuthPolicy;
  readonly version: string;
  readonly protocolVersion: string;
  readonly pid: number;
  readonly connectionStatus: DaemonConnectionStatus;
  readonly methods: Readonly<Record<string, DaemonMethodHandler>>;
  readonly logger: DaemonLogger;

  private readonly listen: "websocket" | "ipc";
  private readonly host: string;
  private readonly port: number | undefined;
  private readonly unixPath: string | undefined;
  private readonly logsPath: string | undefined;
  private readonly parentChannel: DaemonParentChannel | undefined;
  private readonly remoteControl: boolean;
  private readonly notifyReady: ((state: string) => void) | undefined;
  private readonly stdout: ((line: string) => void) | undefined;
  private readonly timers: DaemonTimers;
  private readonly bindRetryDelaysMs: readonly number[];
  private readonly shutdownTimeoutMs: number;
  private readonly shutdownSteps: readonly DaemonShutdownStep[];
  private readonly onShutdownStep: ((name: string) => void) | undefined;
  private readonly onNotification:
    | ((method: string, params: unknown, context: DaemonMethodContext) => void)
    | undefined;
  private readonly parentPid: number | undefined;
  private readonly livenessFd: number | undefined;
  private readonly parentPollIntervalMs: number;
  private readonly openLiveness: LivenessPipeOpener;
  private readonly isAlive: (pid: number) => boolean;
  private livenessWatchers: LivenessWatcher[] = [];

  private httpServer: Server | undefined;
  private ipcTransport: IpcTransport | undefined;
  private readonly connections = new Set<DaemonConnection>();
  private nextConnectionId = 1;
  private endpointValue: DaemonEndpoint | undefined;
  private started = false;
  private stopPromise: Promise<DaemonStopResult> | undefined;
  private readonly closedSignal = Promise.withResolvers<void>();
  private readonly trail: string[] = [];
  private ipcListeners:
    | {
        readonly message: ParentChannelMessageListener;
        readonly disconnect: ParentChannelDisconnectListener;
      }
    | undefined;

  constructor(options: DaemonServerOptions) {
    this.authPolicy = options.auth;
    this.listen = options.listen ?? "websocket";
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port;
    this.unixPath = options.unixPath;
    this.logsPath = options.logsPath;
    this.parentChannel = options.parentChannel;
    this.remoteControl = options.remoteControl ?? false;
    this.version = options.version ?? DAEMON_VERSION;
    this.protocolVersion = options.protocolVersion ?? FACTORY_PROTOCOL_VERSION;
    this.pid = options.pid ?? process.pid;
    this.methods = options.methods ?? {};
    this.logger = options.logger ?? silentLogger;
    this.notifyReady = options.notifyReady;
    this.stdout = options.stdout;
    this.timers = options.timers ?? systemTimers;
    this.bindRetryDelaysMs =
      options.bindRetryDelaysMs ?? DAEMON_BIND_RETRY_DELAYS_MS;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
    this.shutdownSteps = options.shutdownSteps ?? [];
    this.onShutdownStep = options.onShutdownStep;
    this.onNotification = options.onNotification;
    this.parentPid = options.parentPid;
    this.livenessFd = options.livenessFd;
    this.parentPollIntervalMs =
      options.parentPollIntervalMs ?? PARENT_PID_POLL_INTERVAL_MS;
    this.openLiveness = options.openLiveness ?? watchLivenessPipe;
    this.isAlive = options.isProcessAlive ?? isProcessAlive;
    this.connectionStatus = {
      supportsRequestCwd: true,
      supportsPullRequestRecords: true,
      supportsRemoteDesktop: true,
      supportsReadOnlySideChats: true,
      supportsSharedSessionSideChats: true,
      supportsSessionPresence: true,
      isDroidCLIInPath: true,
      droidCLIVersion: this.version,
      homedir: options.homedir,
      platform: options.platform ?? process.platform,
      ...options.connectionStatus,
    };
  }

  /** The endpoint once started, `undefined` before then. */
  get endpoint(): DaemonEndpoint | undefined {
    return this.endpointValue;
  }

  /** Connections currently open, for tests and diagnostics. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Steps already stopped, in order, for tests and diagnostics. */
  get shutdownTrail(): readonly string[] {
    return this.trail;
  }

  get stopped(): boolean {
    return this.stopPromise !== undefined;
  }

  /** Bind and announce. Rejects with a startup error and rolls back. */
  async start(): Promise<DaemonEndpoint> {
    if (this.started) {
      throw new Error("daemon server is already started");
    }
    this.assertStartupPreconditions();

    try {
      if (this.parentChannel !== undefined) {
        this.startIpc(this.parentChannel);
      }
      let endpoint: DaemonEndpoint = { kind: "none" };
      if (this.listen !== "ipc") {
        const selection = selectDaemonTransport({
          listen: this.listen,
          host: this.host,
          port: this.port,
          unixPath: this.unixPath,
        });
        if (selection.kind === "tcp" || selection.kind === "unix") {
          endpoint = await this.bind(selection);
        } else if (this.parentChannel !== undefined) {
          endpoint = { kind: "ipc" };
        }
      } else {
        endpoint = { kind: "ipc" };
      }
      this.endpointValue = endpoint;
      this.startLiveness();
      this.started = true;
      this.announce(endpoint);
      return endpoint;
    } catch (error) {
      await this.stop("startup-failed");
      throw error;
    }
  }

  private assertStartupPreconditions(): void {
    if (this.listen === "ipc") {
      if (this.remoteControl) {
        throw new DaemonStartupError(
          "--listen ipc cannot be combined with --remote-control",
          { code: "droide.daemon.ipc-remote-access" },
        );
      }
      if (this.parentChannel === undefined) {
        throw new DaemonStartupError(
          "--listen ipc requires the daemon to be spawned with an inherited IPC channel",
          { code: "droide.daemon.ipc-unavailable" },
        );
      }
    }
    if (this.parentChannel?.connected === false) {
      throw new DaemonStartupError(
        "The inherited IPC channel is already disconnected",
        { code: "droide.daemon.ipc-disconnected" },
      );
    }
  }

  private startIpc(channel: DaemonParentChannel): void {
    const transport = new IpcTransport(channel);
    this.ipcTransport = transport;
    const connection = new DaemonConnection(
      this,
      transport,
      this.nextConnectionId,
    );
    this.nextConnectionId += 1;
    this.connections.add(connection);
    transport.setHandlers({
      onText: (text) => {
        this.guardReceive(() => connection.receive(text));
      },
      onClose: () => {
        connection.markClosed();
        this.connections.delete(connection);
      },
    });
    const message: ParentChannelMessageListener = (value) => {
      this.guardReceive(() => connection.receiveIpc(value));
    };
    const disconnect: ParentChannelDisconnectListener = () => {
      connection.close(WS_CLOSE.goingAway, "parent channel disconnected");
      this.connections.delete(connection);
      void this.stop("ipc-disconnected");
    };
    this.ipcListeners = { message, disconnect };
    channel.onMessage(message);
    channel.onDisconnect(disconnect);
  }

  private async bind(
    selection:
      | { readonly kind: "tcp"; readonly host: string; readonly port: number }
      | { readonly kind: "unix"; readonly path: string },
  ): Promise<DaemonEndpoint> {
    const delays = this.bindRetryDelaysMs;
    for (let attempt = 0; ; attempt += 1) {
      const server = createDaemonHttpServer();
      attachWebSocketServer(server, (transport) =>
        this.acceptTransport(transport),
      );
      try {
        const target: DaemonTarget =
          selection.kind === "tcp"
            ? { host: selection.host, port: selection.port }
            : { path: selection.path };
        await listenOn(server, target);
        if (attempt > 0) {
          this.logger.info(`[Daemon] bind succeeded after ${attempt} retries`);
        }
        server.on("error", (error: Error) => {
          this.logger.error(`[Daemon] server error: ${error.message}`);
        });
        this.httpServer = server;
        return this.describeEndpoint(server, selection);
      } catch (error) {
        if (server.listening) server.close();
        if (errorCodeOf(error) !== "EADDRINUSE" || attempt >= delays.length) {
          throw new DaemonStartupError(messageOf(error), { cause: error });
        }
        this.logger.info(
          `[Daemon] Port in use, retrying bind (${attempt + 1}/${delays.length})`,
        );
        await this.delay(delays[attempt] ?? 0);
      }
    }
  }

  private describeEndpoint(
    server: Server,
    selection:
      | { readonly kind: "tcp"; readonly host: string; readonly port: number }
      | { readonly kind: "unix"; readonly path: string },
  ): DaemonEndpoint {
    if (selection.kind === "unix") {
      return { kind: "unix", unixPath: selection.path };
    }
    const address = server.address();
    const port =
      typeof address === "object" && address !== null
        ? address.port
        : selection.port;
    return { kind: "tcp", host: selection.host, port };
  }

  private acceptTransport(transport: ServerWebSocketTransport): void {
    const connection = new DaemonConnection(
      this,
      transport,
      this.nextConnectionId,
    );
    this.nextConnectionId += 1;
    this.connections.add(connection);
    transport.setHandlers({
      onText: (text) => {
        this.guardReceive(() => connection.receive(text));
      },
      onBinary: (bytes) => {
        this.guardReceive(() => connection.receiveBinary(bytes));
      },
      onClose: () => {
        connection.markClosed();
        this.connections.delete(connection);
      },
    });
  }

  private guardReceive(run: () => Promise<void>): void {
    void run().catch((error: unknown) => {
      this.logger.error(
        `[Daemon] connection handler failed: ${messageOf(error)}`,
      );
    });
  }

  handleClientNotification(
    method: string,
    params: unknown,
    context: DaemonMethodContext,
  ): void {
    try {
      this.onNotification?.(method, params, context);
    } catch (error) {
      this.logger.error(
        `[Daemon] notification ${method} failed: ${messageOf(error)}`,
      );
    }
  }

  /** B10: the parent-death monitors start once the endpoint exists. */
  private startLiveness(): void {
    if (this.parentPid !== undefined) {
      this.livenessWatchers.push(
        watchParentPid({
          pid: this.parentPid,
          intervalMs: this.parentPollIntervalMs,
          timers: this.timers,
          isAlive: this.isAlive,
          onDead: () => this.requestShutdown("parent-process-gone"),
        }),
      );
    }
    if (this.livenessFd !== undefined) {
      this.livenessWatchers.push(
        this.openLiveness(this.livenessFd, () =>
          this.requestShutdown("liveness-pipe-closed"),
        ),
      );
    }
  }

  private stopLiveness(): void {
    for (const watcher of this.livenessWatchers) watcher.stop();
    this.livenessWatchers = [];
  }

  private announce(endpoint: DaemonEndpoint): void {
    if (this.notifyReady !== undefined) {
      try {
        this.notifyReady("READY=1");
      } catch (error) {
        // A failed READY=1 marks startup failed but never aborts (B5).
        this.logger.error(
          `[Daemon] sd_notify READY=1 failed: ${messageOf(error)}`,
        );
      }
    }
    this.parentChannel?.send(
      JSON.stringify({
        type: "factory.daemon.ready",
        pid: this.pid,
        version: this.version,
      }),
    );
    if (this.stdout === undefined) return;
    for (const line of formatReadinessBanner(endpoint, {
      version: this.version,
      pid: this.pid,
      ...(this.logsPath === undefined ? {} : { logsPath: this.logsPath }),
      remoteControl: this.remoteControl,
    })) {
      this.stdout(line);
    }
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.timers.set(resolve, ms);
    return promise;
  }

  /** Ask the daemon to stop; idempotent and safe before `start`. */
  stop(reason = "requested"): Promise<DaemonStopResult> {
    if (this.stopPromise === undefined) {
      this.stopPromise = this.runShutdown(reason);
    }
    return this.stopPromise;
  }

  /** Resolves once shutdown has finished (B8). */
  waitForShutdown(): Promise<void> {
    return this.closedSignal.promise;
  }

  requestShutdown(reason = "requested"): void {
    void this.stop(reason);
  }

  private async runShutdown(reason: string): Promise<DaemonStopResult> {
    this.logger.info(`[Daemon] shutting down: ${reason}`);
    const steps: DaemonShutdownStep[] = [
      ...this.shutdownSteps,
      ...this.internalSteps(),
    ];
    const runSteps = async (): Promise<void> => {
      for (const step of steps) {
        this.trail.push(step.name);
        this.onShutdownStep?.(step.name);
        await step.stop();
      }
    };
    let timedOut = false;
    const deadline = Promise.withResolvers<void>();
    const cancelDeadline = this.timers.set(() => {
      timedOut = true;
      deadline.resolve();
    }, this.shutdownTimeoutMs);
    await Promise.race([
      runSteps().catch((error: unknown) => {
        this.logger.error(`[Daemon] shutdown step failed: ${messageOf(error)}`);
      }),
      deadline.promise,
    ]);
    cancelDeadline();
    if (timedOut) {
      this.logger.error(
        `[Daemon] shutdown exceeded ${this.shutdownTimeoutMs}ms`,
      );
    }
    this.forceClose();
    this.closedSignal.resolve();
    return { timedOut };
  }

  private internalSteps(): readonly DaemonShutdownStep[] {
    return [
      { name: "liveness-monitor", stop: () => this.stopLiveness() },
      { name: "ipc-server", stop: () => this.closeIpc() },
      { name: "web-socket-server", stop: () => this.closeWebSocketServer() },
    ];
  }

  private async closeIpc(): Promise<void> {
    this.removeIpcListeners();
    const transport = this.ipcTransport;
    this.ipcTransport = undefined;
    if (transport === undefined) return;
    transport.close(WS_CLOSE.goingAway, "daemon shutting down");
    await transport.waitForClose();
  }

  private async closeWebSocketServer(): Promise<void> {
    const server = this.httpServer;
    const closing = [...this.connections].map((connection) => {
      connection.close(WS_CLOSE.goingAway, "daemon shutting down");
      return connection.waitForClose();
    });
    await Promise.all(closing);
    if (server === undefined) return;
    this.httpServer = undefined;
    if (!server.listening) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }

  private removeIpcListeners(): void {
    const channel = this.parentChannel;
    const listeners = this.ipcListeners;
    this.ipcListeners = undefined;
    if (channel === undefined || listeners === undefined) return;
    channel.offMessage?.(listeners.message);
    channel.offDisconnect?.(listeners.disconnect);
  }

  private forceClose(): void {
    this.stopLiveness();
    this.removeIpcListeners();
    for (const connection of this.connections) {
      connection.terminate();
    }
    this.connections.clear();
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server?.listening) server.close();
  }
}

/**
 * Wire the signals the daemon answers (B8) and the caller's abort signal.
 * Returns the cleanup that removes every listener it added.
 */
function registerSignals(
  server: DaemonServer,
  signal: AbortSignal | undefined,
): () => void {
  const cleanups: (() => void)[] = [];
  const names: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];
  for (const name of names) {
    const handler = (): void => {
      void server.stop(name);
    };
    try {
      process.on(name, handler);
      cleanups.push(() => process.off(name, handler));
    } catch {
      // The platform does not expose this signal; the rest still apply.
    }
  }
  if (signal !== undefined) {
    const onAbort = (): void => {
      void server.stop("aborted");
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Run one daemon to completion and return the process exit code.
 *
 * A startup failure prints `Startup failed: <message>` and exits 1 (B7,
 * B11); a signal-driven or requested stop exits 0 (B8). The caller owns
 * stdout/stderr so the CLI presentation layer stays the only writer.
 */
export async function runDaemon(options: DaemonServerOptions): Promise<number> {
  const server = new DaemonServer(options);
  const cleanupSignals = registerSignals(server, options.signal);
  try {
    await server.start();
  } catch (error) {
    await server.stop("startup-failed");
    cleanupSignals();
    options.stderr?.(`Startup failed: ${messageOf(error)}`);
    options.logger?.error("CLI daemon startup failed");
    return 1;
  }
  await server.waitForShutdown();
  cleanupSignals();
  return 0;
}
