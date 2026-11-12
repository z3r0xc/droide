/**
 * The daemon's socket transport: WebSocket text frames over TCP or a Unix
 * socket. Contract: `specs/70-daemon-and-remote-control.md` B12, B31.
 *
 * Only what the daemon needs is implemented: the RFC 6455 opening handshake,
 * masked client frames / unmasked server frames, fragmented text and binary
 * messages, ping/pong, close and the 8 MiB frame ceiling. Frames are delivered
 * as text; binary frames are handed to the protocol layer, which knows the
 * `0x01` compressed-payload tag. No extension negotiation is offered, so the
 * local channel stays plaintext JSON (B31).
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as connectSocket, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { MAX_FRAME_BYTES } from "./protocol.ts";
import { systemTimers, type DaemonTimers } from "./timers.ts";

/** The RFC 6455 accept-key salt. */
export const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Close codes this transport uses; 4012/4013 are the relay codes (B8). */
export const WS_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  invalidPayload: 1007,
  messageTooBig: 1009,
  internalError: 1011,
  daemonShuttingDown: 4012,
  daemonUpdating: 4013,
} as const;

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** Where a client may connect: a loopback TCP address or a Unix socket. */
export type DaemonTarget =
  { readonly host: string; readonly port: number } | { readonly path: string };

/** Narrow a target to its TCP shape. */
export function isTcpTarget(
  target: DaemonTarget,
): target is { readonly host: string; readonly port: number } {
  return "port" in target;
}

export interface DaemonTransportHandlers {
  onText(text: string): void;
  onBinary?(bytes: Uint8Array): void;
  onClose(code: number, reason: string): void;
}

/** One framed connection, independent of which end opened it. */
export interface DaemonTransport {
  send(text: string): void;
  sendBinary?(bytes: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Drop the connection without the closing handshake (forced shutdown). */
  terminate?(): void;
  readonly closed: boolean;
  waitForClose(): Promise<void>;
  setHandlers(handlers: DaemonTransportHandlers): void;
}

/** The server end additionally accepts bytes that arrived with the upgrade. */
export interface ServerWebSocketTransport extends DaemonTransport {
  feed(bytes: Buffer): void;
}

/** Encode one frame; clients mask, servers do not. */
export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  options: { readonly mask: boolean; readonly fin?: boolean },
): Buffer {
  const fin = options.fin ?? true;
  const length = payload.length;
  const extended = Buffer.alloc(length < 126 ? 0 : length <= 0xffff ? 2 : 8);
  if (length >= 126 && length <= 0xffff) {
    extended.writeUInt16BE(length, 0);
  } else if (length > 0xffff) {
    extended.writeBigUInt64BE(BigInt(length), 0);
  }
  const maskKey = options.mask ? randomBytes(4) : undefined;
  const header = Buffer.alloc(2 + extended.length + (maskKey ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  const lengthMarker = length < 126 ? length : length <= 0xffff ? 126 : 127;
  header[1] = (maskKey ? 0x80 : 0) | lengthMarker;
  extended.copy(header, 2);
  if (maskKey) maskKey.copy(header, 2 + extended.length);
  const body =
    maskKey === undefined ? Buffer.from(payload) : applyMask(payload, maskKey);
  return Buffer.concat([header, body]);
}

function applyMask(payload: Uint8Array, key: Uint8Array): Buffer {
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (key[index % 4] ?? 0);
  }
  return masked;
}

export interface FrameReaderOptions {
  /** Servers require masked input; clients require unmasked input. */
  readonly requireMasked: boolean;
  readonly maxMessageBytes?: number;
  readonly onMessage: (opcode: "text" | "binary", payload: Buffer) => void;
  readonly onControl: (opcode: number, payload: Buffer) => void;
  readonly onProtocolError: (code: number, reason: string) => void;
}

interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/**
 * Incremental frame reader. A chunk boundary may fall anywhere, so it buffers
 * until a whole frame is present and reports a protocol failure once.
 */
export class FrameReader {
  private readonly options: FrameReaderOptions;
  private buffer: Buffer = Buffer.alloc(0);
  private fragmentedOpcode: "text" | "binary" | undefined;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private failed = false;

  constructor(options: FrameReaderOptions) {
    this.options = options;
  }

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    while (!this.failed) {
      const frame = this.readFrame();
      if (frame === undefined) return;
      this.handleFrame(frame);
    }
  }

  private readFrame(): Frame | undefined {
    if (this.buffer.length < 2) return undefined;
    const first = this.buffer[0] ?? 0;
    const second = this.buffer[1] ?? 0;
    if ((first & 0x70) !== 0) {
      this.fail(WS_CLOSE.protocolError, "RSV bits must be zero");
      return undefined;
    }
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (masked !== this.options.requireMasked) {
      this.fail(
        WS_CLOSE.protocolError,
        masked
          ? "server frames must not be masked"
          : "client frames must be masked",
      );
      return undefined;
    }
    const shortLength = second & 0x7f;
    let offset = 2;
    let length = shortLength;
    if (shortLength === 126) {
      if (this.buffer.length < 4) return undefined;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (shortLength === 127) {
      if (this.buffer.length < 10) return undefined;
      const wide = this.buffer.readBigUInt64BE(2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.fail(WS_CLOSE.messageTooBig, "frame length is not addressable");
        return undefined;
      }
      length = Number(wide);
      offset = 10;
    }
    if (length > (this.options.maxMessageBytes ?? MAX_FRAME_BYTES)) {
      this.fail(WS_CLOSE.messageTooBig, "frame exceeds the message ceiling");
      return undefined;
    }
    let maskKey: Buffer | undefined;
    if (masked) {
      if (this.buffer.length < offset + 4) return undefined;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + length) return undefined;
    const raw = this.buffer.subarray(offset, offset + length);
    const payload =
      maskKey === undefined ? Buffer.from(raw) : applyMask(raw, maskKey);
    this.buffer = this.buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  private handleFrame(frame: Frame): void {
    const { fin, opcode, payload } = frame;
    if (opcode >= 0x8) {
      if (!fin) {
        this.fail(WS_CLOSE.protocolError, "control frames must not fragment");
        return;
      }
      if (payload.length > 125) {
        this.fail(WS_CLOSE.protocolError, "control frame payload is too large");
        return;
      }
      this.options.onControl(opcode, payload);
      return;
    }
    if (opcode === OPCODE.continuation) {
      if (this.fragmentedOpcode === undefined) {
        this.fail(WS_CLOSE.protocolError, "unexpected continuation frame");
        return;
      }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.ceiling) {
        this.fail(WS_CLOSE.messageTooBig, "message exceeds the ceiling");
        return;
      }
      this.fragments.push(payload);
      if (!fin) return;
      const merged = Buffer.concat(this.fragments);
      const kind = this.fragmentedOpcode;
      this.fragmentedOpcode = undefined;
      this.fragments = [];
      this.fragmentBytes = 0;
      this.options.onMessage(kind, merged);
      return;
    }
    if (opcode !== OPCODE.text && opcode !== OPCODE.binary) {
      this.fail(WS_CLOSE.protocolError, `unsupported opcode ${opcode}`);
      return;
    }
    if (this.fragmentedOpcode !== undefined) {
      this.fail(
        WS_CLOSE.protocolError,
        "data frame inside a fragmented message",
      );
      return;
    }
    const kind = opcode === OPCODE.text ? "text" : "binary";
    if (fin) {
      this.options.onMessage(kind, payload);
      return;
    }
    this.fragmentedOpcode = kind;
    this.fragments = [payload];
    this.fragmentBytes = payload.length;
  }

  private get ceiling(): number {
    return this.options.maxMessageBytes ?? MAX_FRAME_BYTES;
  }

  private fail(code: number, reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.options.onProtocolError(code, reason);
  }
}

function parseClosePayload(payload: Buffer): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1005, reason: "" };
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString("utf8"),
  };
}

class SocketTransport implements ServerWebSocketTransport {
  private readonly socket: Duplex;
  private readonly maskOutbound: boolean;
  private readonly reader: FrameReader;
  private readonly closeSignal = Promise.withResolvers<void>();
  private handlers: DaemonTransportHandlers | undefined;
  private closeInfo: { code: number; reason: string } | undefined;
  private didClose = false;
  private closeSent = false;

  constructor(socket: Duplex, maskOutbound: boolean) {
    this.socket = socket;
    this.maskOutbound = maskOutbound;
    this.reader = new FrameReader({
      requireMasked: !maskOutbound,
      onMessage: (opcode, payload) => {
        if (opcode === "text") {
          this.handlers?.onText(payload.toString("utf8"));
        } else {
          this.handlers?.onBinary?.(payload);
        }
      },
      onControl: (opcode, payload) => this.handleControl(opcode, payload),
      onProtocolError: (code, reason) => this.close(code, reason),
    });
    socket.on("data", (chunk: Buffer) => this.reader.push(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => {
      // A socket error is always followed by "close"; nothing to report here.
    });
  }

  get closed(): boolean {
    return this.didClose;
  }

  setHandlers(handlers: DaemonTransportHandlers): void {
    this.handlers = handlers;
  }

  feed(bytes: Buffer): void {
    this.reader.push(bytes);
  }

  send(text: string): void {
    this.writeFrame(OPCODE.text, Buffer.from(text, "utf8"));
  }

  sendBinary(bytes: Uint8Array): void {
    this.writeFrame(OPCODE.binary, Buffer.from(bytes));
  }

  close(code: number = WS_CLOSE.normal, reason = ""): void {
    if (this.closeInfo === undefined) {
      this.closeInfo = { code, reason };
    }
    if (this.socket.destroyed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, "utf8");
      if (this.socket.writable) {
        this.socket.write(
          encodeFrame(OPCODE.close, payload, { mask: this.maskOutbound }),
        );
      }
    }
    // `finish` fires once the close frame is flushed; destroying then keeps a
    // peer that never answers from holding the process open.
    this.socket.end(() => this.socket.destroy());
  }

  terminate(): void {
    this.socket.destroy();
  }

  waitForClose(): Promise<void> {
    return this.closeSignal.promise;
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.didClose || this.socket.destroyed || !this.socket.writable) {
      return;
    }
    this.socket.write(
      encodeFrame(opcode, payload, { mask: this.maskOutbound }),
    );
  }

  private handleControl(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE.ping) {
      this.writeFrame(OPCODE.pong, payload);
      return;
    }
    if (opcode === OPCODE.pong) return;
    if (opcode === OPCODE.close) {
      const info = parseClosePayload(payload);
      if (this.closeInfo === undefined) {
        this.closeInfo =
          info.code === 1005
            ? { code: WS_CLOSE.normal, reason: "" }
            : { code: info.code, reason: info.reason };
      }
      this.closeSent = true;
      if (this.socket.writable) {
        this.socket.write(
          encodeFrame(OPCODE.close, payload, { mask: this.maskOutbound }),
        );
      }
      this.socket.end(() => this.socket.destroy());
    }
  }

  private finish(): void {
    if (this.didClose) return;
    this.didClose = true;
    const info = this.closeInfo ?? { code: 1006, reason: "" };
    this.handlers?.onClose(info.code, info.reason);
    this.closeSignal.resolve();
  }
}

/**
 * Accept WebSocket upgrades on an existing HTTP server. A request that is not
 * a valid RFC 6455 opening handshake is refused by destroying the socket.
 */
export function attachWebSocketServer(
  server: Server,
  onConnection: (
    transport: ServerWebSocketTransport,
    request: IncomingMessage,
  ) => void,
): void {
  server.on("upgrade", (request, socket, head) => {
    const key = request.headers["sec-websocket-key"];
    const upgrade = request.headers.upgrade;
    const version = request.headers["sec-websocket-version"];
    if (
      typeof key !== "string" ||
      typeof upgrade !== "string" ||
      upgrade.toLowerCase() !== "websocket" ||
      version !== "13"
    ) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}${WEB_SOCKET_GUID}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    const transport = new SocketTransport(socket, false);
    onConnection(transport, request);
    if (head.length > 0) transport.feed(head);
  });
}

/** How long the client waits for the opening handshake. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Open one client connection. The socket is created from an address object,
 * never a URL string, so a Unix path and a TCP address take the same path.
 */
export async function connectWebSocket(
  target: DaemonTarget,
  handlers: DaemonTransportHandlers,
  options: {
    readonly timeoutMs?: number;
    readonly timers?: DaemonTimers;
  } = {},
): Promise<DaemonTransport> {
  const timers = options.timers ?? systemTimers;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1")
    .update(`${key}${WEB_SOCKET_GUID}`)
    .digest("base64");
  const hostHeader = isTcpTarget(target)
    ? `${target.host}:${target.port}`
    : "localhost";
  const socket = isTcpTarget(target)
    ? connectSocket({ host: target.host, port: target.port })
    : connectSocket({ path: target.path });

  const { promise, resolve, reject } = Promise.withResolvers<DaemonTransport>();
  let buffer = Buffer.alloc(0);
  let settled = false;
  let cancelTimeout = () => {};
  const settle = (error?: Error): boolean => {
    if (settled) return false;
    settled = true;
    cancelTimeout();
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("close", onClose);
    if (error !== undefined) {
      socket.destroy();
      reject(error);
      return false;
    }
    return true;
  };
  const onError = (error: Error): void => {
    settle(error);
  };
  const onClose = (): void => {
    settle(new Error("daemon closed the connection during the handshake"));
  };
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buffer.length > 64 * 1024) {
        settle(new Error("daemon handshake headers are too large"));
      }
      return;
    }
    const head = buffer.subarray(0, end).toString("latin1");
    const rest = buffer.subarray(end + 4);
    if (!handshakeAccepted(head, expected)) {
      settle(
        new Error(`daemon handshake was refused: ${head.split("\r\n")[0]}`),
      );
      return;
    }
    if (!settle()) return;
    const transport = new SocketTransport(socket, true);
    transport.setHandlers(handlers);
    if (rest.length > 0) transport.feed(rest);
    resolve(transport);
  };
  cancelTimeout = timers.set(() => {
    settle(new Error(`daemon handshake timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.write(
    [
      "GET /daemon HTTP/1.1",
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  return promise;
}

function handshakeAccepted(head: string, expected: string): boolean {
  const lines = head.split("\r\n");
  if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? "")) return false;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (
      line.slice(0, colon).trim().toLowerCase() === "sec-websocket-accept" &&
      line.slice(colon + 1).trim() === expected
    ) {
      return true;
    }
  }
  return false;
}

/** The body the desktop's pre-kill probe reads (B33). */
export const HEALTH_BODY = "factory-daemon ok";

/**
 * Create the HTTP server a daemon binds. `GET /health` answers `200` with
 * {@link HEALTH_BODY} without authenticating; everything else is `404`.
 *
 * TODO(spec B33): the token-gated `/port-proxy/<port>` surface (query token,
 * cookie exchange, traversal refusal) is not implemented, so those requests
 * answer 404 instead of proxying or refusing with 401.
 */
export function createDaemonHttpServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(HEALTH_BODY);
      return;
    }
    response.statusCode = 404;
    response.end("Not Found");
  });
}
