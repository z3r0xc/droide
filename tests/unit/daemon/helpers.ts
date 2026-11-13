/**
 * Shared fakes for the daemon suites. Not a test file: nothing here asserts,
 * it exists so the protocol, transport and lifecycle tests can drive code
 * without a real clock, a real client or a fixed port.
 */

import { tmpdir } from "node:os";

import type {
  DaemonAuthPolicy,
  DaemonConnectionStatus,
  DaemonIdentity,
} from "../../../src/daemon/auth.ts";
import {
  DaemonServer,
  type DaemonEndpoint,
  type DaemonLogger,
  type DaemonMethodContext,
  type DaemonMethodHandler,
  type DaemonParentChannel,
  type DaemonServerOptions,
  type DaemonShutdownStep,
} from "../../../src/daemon/server.ts";
import type { LivenessPipeOpener } from "../../../src/daemon/liveness.ts";
import type { PortProxyRegistry } from "../../../src/daemon/port-proxy.ts";
import type { DaemonTimers } from "../../../src/daemon/timers.ts";
import {
  connectWebSocket,
  type DaemonTarget,
  type DaemonTransport,
  type DaemonTransportHandlers,
} from "../../../src/daemon/web-socket.ts";
import {
  parseBinaryFrame,
  parseTextFrame,
  serializeEnvelope,
  type DaemonEnvelope,
} from "../../../src/daemon/protocol.ts";

/** The single account every test daemon accepts. */
export const TEST_IDENTITY: DaemonIdentity = {
  userId: "user-1",
  orgId: "org-1",
};
export const TEST_TOKEN = "workos-token-1";
export const TEST_API_KEY = "fk-test-api-key";

export function testAuthPolicy(): DaemonAuthPolicy {
  return {
    identity: TEST_IDENTITY,
    token: TEST_TOKEN,
    apiKey: TEST_API_KEY,
  };
}

interface Scheduled {
  readonly due: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/**
 * A timer seam with no wall clock: `advance` fires every callback that is due,
 * in order, so retry backoff and request timeouts are deterministic.
 */
export class ManualTimers implements DaemonTimers {
  private now = 0;
  private scheduled: Scheduled[] = [];

  set(callback: () => void, ms: number): () => void {
    const entry: Scheduled = { due: this.now + ms, callback, cancelled: false };
    this.scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Timers that have not been cancelled or fired. */
  get activeCount(): number {
    return this.scheduled.filter((entry) => !entry.cancelled).length;
  }

  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = this.scheduled
        .filter((entry) => !entry.cancelled && entry.due <= this.now)
        .sort((left, right) => left.due - right.due)[0];
      if (due === undefined) return;
      this.scheduled = this.scheduled.filter((entry) => entry !== due);
      due.callback();
    }
  }
}

/** A transport a test drives by hand: it records sends and delivers frames. */
export class FakeTransport implements DaemonTransport {
  readonly sent: string[] = [];
  readonly sentBinary: Uint8Array[] = [];
  readonly closeCalls: { readonly code: number; readonly reason: string }[] =
    [];
  closed = false;
  terminated = false;
  private handlers: DaemonTransportHandlers | undefined;
  private closeSignal = Promise.withResolvers<void>();

  setHandlers(handlers: DaemonTransportHandlers): void {
    this.handlers = handlers;
  }

  send(text: string): void {
    this.sent.push(text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.sentBinary.push(bytes);
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    if (this.closed) return;
    this.closed = true;
    this.closeSignal.resolve();
  }

  terminate(): void {
    this.terminated = true;
    this.close();
  }

  waitForClose(): Promise<void> {
    return this.closeSignal.promise;
  }

  deliverText(text: string): void {
    this.handlers?.onText(text);
  }

  deliverEnvelope(envelope: DaemonEnvelope): void {
    this.deliverText(serializeEnvelope(envelope));
  }

  deliverBinary(bytes: Uint8Array): void {
    this.handlers?.onBinary?.(bytes);
  }

  emitClose(code: number, reason: string): void {
    this.closed = true;
    this.handlers?.onClose(code, reason);
    this.closeSignal.resolve();
  }

  get lastSent(): DaemonEnvelope {
    const text = this.sent[this.sent.length - 1];
    if (text === undefined) throw new Error("no frame was sent");
    return parseTextFrame(text);
  }
}

/** A raw peer: it speaks the wire protocol without the daemon client. */
export class Peer {
  readonly envelopes: DaemonEnvelope[] = [];
  readonly raw: string[] = [];
  binaryFrames = 0;
  closeInfo: { readonly code: number; readonly reason: string } | undefined;
  private transportValue: DaemonTransport | undefined;
  private consumed = 0;
  private readonly waiters: Array<(envelope: DaemonEnvelope) => void> = [];

  private constructor() {}

  static async connect(target: DaemonTarget): Promise<Peer> {
    const peer = new Peer();
    peer.transportValue = await connectWebSocket(target, {
      onText: (text) => {
        peer.record(text);
      },
      onBinary: (bytes) => {
        peer.binaryFrames += 1;
        peer.accept(parseBinaryFrame(bytes));
      },
      onClose: (code, reason) => {
        peer.closeInfo = { code, reason };
      },
    });
    return peer;
  }

  get transport(): DaemonTransport {
    if (this.transportValue === undefined) {
      throw new Error("peer is not connected");
    }
    return this.transportValue;
  }

  private accept(envelope: DaemonEnvelope): void {
    this.envelopes.push(envelope);
    this.waiters.shift()?.(envelope);
  }

  private record(text: string): void {
    this.raw.push(text);
    this.accept(parseTextFrame(text));
  }

  send(envelope: DaemonEnvelope): void {
    this.transport.send(serializeEnvelope(envelope));
  }

  sendRaw(text: string): void {
    this.transport.send(text);
  }

  /** The next envelope, or a rejection when nothing arrives in `timeoutMs`. */
  async next(timeoutMs = 2_000): Promise<DaemonEnvelope> {
    const queued = this.envelopes[this.consumed];
    if (queued !== undefined) {
      this.consumed += 1;
      return queued;
    }
    const { promise, resolve, reject } =
      Promise.withResolvers<DaemonEnvelope>();
    const handle = setTimeout(() => {
      reject(new Error(`no envelope within ${timeoutMs}ms`));
    }, timeoutMs);
    this.waiters.push((envelope) => {
      clearTimeout(handle);
      this.consumed += 1;
      resolve(envelope);
    });
    return await promise;
  }

  async close(): Promise<void> {
    this.transport.close(1000, "test complete");
    await this.transport.waitForClose();
  }
}

/** The options a test server needs, without the `Environment` plumbing. */
export interface TestServerOptions {
  readonly auth?: DaemonAuthPolicy;
  readonly port?: number;
  readonly listen?: "websocket" | "ipc";
  readonly unixPath?: string;
  readonly methods?: Readonly<Record<string, DaemonMethodHandler>>;
  readonly connectionStatus?: Partial<DaemonConnectionStatus>;
  readonly onNotification?: (
    method: string,
    params: unknown,
    context: DaemonMethodContext,
  ) => void;
  readonly signal?: AbortSignal;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly logger?: DaemonLogger;
  readonly timers?: DaemonTimers;
  readonly parentChannel?: DaemonParentChannel;
  readonly notifyReady?: (state: string) => void;
  readonly protocolVersion?: string;
  readonly bindRetryDelaysMs?: readonly number[];
  readonly shutdownTimeoutMs?: number;
  readonly shutdownSteps?: readonly DaemonShutdownStep[];
  readonly onShutdownStep?: (name: string) => void;
  readonly remoteControl?: boolean;
  readonly livenessFd?: number;
  readonly parentPid?: number;
  readonly parentPollIntervalMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly openLiveness?: LivenessPipeOpener;
  readonly pid?: number;
  readonly portProxy?: PortProxyRegistry;
}

/** Materialise {@link TestServerOptions} as real server options. */
export function toServerOptions(
  overrides: TestServerOptions = {},
): DaemonServerOptions {
  return {
    auth: overrides.auth ?? testAuthPolicy(),
    homedir: tmpdir(),
    ...(overrides.port === undefined ? {} : { port: overrides.port }),
    ...(overrides.listen === undefined ? {} : { listen: overrides.listen }),
    ...(overrides.unixPath === undefined
      ? {}
      : { unixPath: overrides.unixPath }),
    ...(overrides.methods === undefined ? {} : { methods: overrides.methods }),
    ...(overrides.connectionStatus === undefined
      ? {}
      : { connectionStatus: overrides.connectionStatus }),
    ...(overrides.onNotification === undefined
      ? {}
      : { onNotification: overrides.onNotification }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.stdout === undefined ? {} : { stdout: overrides.stdout }),
    ...(overrides.stderr === undefined ? {} : { stderr: overrides.stderr }),
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
    ...(overrides.parentChannel === undefined
      ? {}
      : { parentChannel: overrides.parentChannel }),
    ...(overrides.notifyReady === undefined
      ? {}
      : { notifyReady: overrides.notifyReady }),
    ...(overrides.protocolVersion === undefined
      ? {}
      : { protocolVersion: overrides.protocolVersion }),
    ...(overrides.bindRetryDelaysMs === undefined
      ? {}
      : { bindRetryDelaysMs: overrides.bindRetryDelaysMs }),
    ...(overrides.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: overrides.shutdownTimeoutMs }),
    ...(overrides.shutdownSteps === undefined
      ? {}
      : { shutdownSteps: overrides.shutdownSteps }),
    ...(overrides.onShutdownStep === undefined
      ? {}
      : { onShutdownStep: overrides.onShutdownStep }),
    ...(overrides.remoteControl === undefined
      ? {}
      : { remoteControl: overrides.remoteControl }),
    ...(overrides.livenessFd === undefined
      ? {}
      : { livenessFd: overrides.livenessFd }),
    ...(overrides.parentPid === undefined
      ? {}
      : { parentPid: overrides.parentPid }),
    ...(overrides.parentPollIntervalMs === undefined
      ? {}
      : { parentPollIntervalMs: overrides.parentPollIntervalMs }),
    ...(overrides.isProcessAlive === undefined
      ? {}
      : { isProcessAlive: overrides.isProcessAlive }),
    ...(overrides.openLiveness === undefined
      ? {}
      : { openLiveness: overrides.openLiveness }),
    ...(overrides.pid === undefined ? {} : { pid: overrides.pid }),
    ...(overrides.portProxy === undefined
      ? {}
      : { portProxy: overrides.portProxy }),
  };
}

export interface RunningServer {
  readonly server: DaemonServer;
  readonly endpoint: DaemonEndpoint;
  readonly target: DaemonTarget;
  close(): Promise<void>;
}

/** The parent/child IPC channel, driven by hand. */
export class FakeParentChannel implements DaemonParentChannel {
  readonly sent: string[] = [];
  connected = true;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  send(message: string): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.add(listener);
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListeners.add(listener);
  }

  offMessage(listener: (message: unknown) => void): void {
    this.messageListeners.delete(listener);
  }

  offDisconnect(listener: () => void): void {
    this.disconnectListeners.delete(listener);
  }

  emitMessage(value: unknown): void {
    for (const listener of [...this.messageListeners]) listener(value);
  }

  emitDisconnect(): void {
    this.connected = false;
    for (const listener of [...this.disconnectListeners]) listener();
  }
}

/** The connectable address of a bound endpoint. */
export function targetOf(endpoint: DaemonEndpoint): DaemonTarget {
  switch (endpoint.kind) {
    case "tcp":
      return { host: endpoint.host, port: endpoint.port };
    case "unix":
      return { path: endpoint.unixPath };
    default:
      throw new Error(`endpoint ${endpoint.kind} is not connectable`);
  }
}

/** Start a server and always leave the caller a way to stop it. */
export async function startServer(
  overrides: TestServerOptions = {},
): Promise<RunningServer> {
  const server = new DaemonServer(toServerOptions(overrides));
  try {
    const endpoint = await server.start();
    return {
      server,
      endpoint,
      target: targetOf(endpoint),
      async close() {
        await server.stop("test complete");
      },
    };
  } catch (error) {
    await server.stop("test startup failed");
    throw error;
  }
}

/** Give the event loop one turn, so a socket event can be delivered. */
export function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Count how many resources of `names` are open right now. Sockets and timers
 * appear here, so a leak shows up as a number that never returns to baseline.
 */
export function countActiveResources(names: readonly string[]): number {
  return process.getActiveResourcesInfo().filter((name) => names.includes(name))
    .length;
}
