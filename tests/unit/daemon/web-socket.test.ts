/**
 * The socket transport. Clauses: `specs/70` B12 and B31: RFC 6455 handshake,
 * masked client frames vs unmasked server frames, fragmentation, ping/pong,
 * close codes and the 8 MiB frame ceiling.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import { test } from "node:test";

import { MAX_FRAME_BYTES } from "../../../src/daemon/protocol.ts";
import { PORT_PROXY_DISABLED_REASON } from "../../../src/daemon/port-proxy.ts";
import {
  FrameReader,
  HEALTH_BODY,
  WEB_SOCKET_GUID,
  WS_CLOSE,
  attachWebSocketServer,
  connectWebSocket,
  createDaemonHttpServer,
  encodeFrame,
  type ServerWebSocketTransport,
} from "../../../src/daemon/web-socket.ts";
import { ManualTimers } from "./helpers.ts";

const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

interface Received {
  readonly opcode: "text" | "binary";
  readonly payload: Buffer;
}

interface Control {
  readonly opcode: number;
  readonly payload: Buffer;
}

interface Waiter<T> {
  readonly take: (value: T) => void;
}

/** A raw WebSocket client: it controls framing byte for byte. */
class RawClient {
  readonly key: string;
  readonly messages: Received[] = [];
  readonly controls: Control[] = [];
  readonly protocolErrors: { code: number; reason: string }[] = [];
  closeInfo: { code: number; reason: string } | undefined;
  private readonly socket: Socket;
  private readonly reader: FrameReader;
  private readonly headSignal = Promise.withResolvers<string>();
  private headBuffer = Buffer.alloc(0);
  private headSeen = false;
  private readonly messageWaiters: Waiter<Received>[] = [];
  private readonly controlWaiters: Waiter<Control>[] = [];
  private readonly closeSignal = Promise.withResolvers<void>();

  private constructor(socket: Socket, key: string) {
    this.socket = socket;
    this.key = key;
    this.reader = new FrameReader({
      requireMasked: false,
      onMessage: (opcode, payload) => {
        const received = { opcode, payload };
        this.messages.push(received);
        this.messageWaiters.shift()?.take(received);
      },
      onControl: (opcode, payload) => {
        if (opcode === OPCODE.close) {
          this.closeInfo =
            payload.length < 2
              ? { code: 1005, reason: "" }
              : {
                  code: payload.readUInt16BE(0),
                  reason: payload.subarray(2).toString("utf8"),
                };
          this.closeSignal.resolve();
        }
        const control = { opcode, payload };
        this.controls.push(control);
        this.controlWaiters.shift()?.take(control);
      },
      onProtocolError: (code, reason) => {
        this.protocolErrors.push({ code, reason });
      },
    });
    socket.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on("close", () => {
      this.closeSignal.resolve();
    });
  }

  static async connect(port: number): Promise<RawClient> {
    const socket = connect({ host: "127.0.0.1", port });
    const key = randomBytes(16).toString("base64");
    const client = new RawClient(socket, key);
    const connected = Promise.withResolvers<void>();
    socket.once("connect", () => connected.resolve());
    socket.once("error", (error) => connected.reject(error));
    await connected.promise;
    socket.write(
      [
        "GET /daemon HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const head = await client.headSignal.promise;
    assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/m);
    return client;
  }

  get head(): string {
    return this.headBuffer.toString("latin1");
  }

  private onData(chunk: Buffer): void {
    if (!this.headSeen) {
      this.headBuffer = Buffer.concat([this.headBuffer, chunk]);
      const end = this.headBuffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      this.headSeen = true;
      this.headSignal.resolve(
        this.headBuffer.subarray(0, end + 4).toString("latin1"),
      );
      const rest = this.headBuffer.subarray(end + 4);
      if (rest.length > 0) this.reader.push(rest);
      return;
    }
    this.reader.push(chunk);
  }

  sendFrame(opcode: number, payload: Buffer, fin = true): void {
    this.socket.write(encodeFrame(opcode, payload, { mask: true, fin }));
  }

  sendUnmasked(opcode: number, payload: Buffer): void {
    this.socket.write(encodeFrame(opcode, payload, { mask: false }));
  }

  sendRaw(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  async message(timeoutMs = 2_000): Promise<Received> {
    const queued = this.messages.shift();
    if (queued !== undefined) return queued;
    const { promise, resolve, reject } = Promise.withResolvers<Received>();
    const handle = setTimeout(() => {
      reject(new Error(`no message within ${timeoutMs}ms`));
    }, timeoutMs);
    this.messageWaiters.push({
      take: (value) => {
        clearTimeout(handle);
        resolve(value);
      },
    });
    return await promise;
  }

  async control(opcode: number, timeoutMs = 2_000): Promise<Control> {
    const queued = this.controls.find((entry) => entry.opcode === opcode);
    if (queued !== undefined) return queued;
    const { promise, resolve, reject } = Promise.withResolvers<Control>();
    const handle = setTimeout(() => {
      reject(new Error(`no control frame ${opcode} within ${timeoutMs}ms`));
    }, timeoutMs);
    this.controlWaiters.push({
      take: (value) => {
        if (value.opcode !== opcode) return;
        clearTimeout(handle);
        resolve(value);
      },
    });
    return await promise;
  }

  async closed(): Promise<void> {
    await this.closeSignal.promise;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

interface Harness {
  readonly port: number;
  readonly transports: ServerWebSocketTransport[];
  close(): Promise<void>;
}

async function startHarness(
  onConnection?: (transport: ServerWebSocketTransport) => void,
): Promise<Harness> {
  const server = createDaemonHttpServer();
  const transports: ServerWebSocketTransport[] = [];
  attachWebSocketServer(server, (transport) => {
    transports.push(transport);
    onConnection?.(transport);
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
  await promise;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    port: address.port,
    transports,
    async close() {
      for (const transport of transports) transport.terminate?.();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    },
  };
}

/** One connected raw client against a harness, with the harness stopped after. */
async function withRaw(
  run: (client: RawClient, harness: Harness) => Promise<void>,
  onConnection?: (transport: ServerWebSocketTransport) => void,
): Promise<void> {
  const harness = await startHarness(onConnection);
  const client = await RawClient.connect(harness.port);
  try {
    await run(client, harness);
  } finally {
    client.destroy();
    await harness.close();
  }
}

test("the handshake answers with the RFC 6455 accept key", async () => {
  await withRaw(async (client) => {
    const expected = createHash("sha1")
      .update(`${client.key}${WEB_SOCKET_GUID}`)
      .digest("base64");
    assert.match(client.head, /HTTP\/1\.1 101 Switching Protocols/);
    assert.match(client.head, /Upgrade: websocket/i);
    assert.ok(client.head.includes(`Sec-WebSocket-Accept: ${expected}`));
  });
});

test("an opening request without the upgrade headers is refused", async () => {
  const server = createDaemonHttpServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  if (address === null || typeof address === "string") return;
  const socket = connect({ host: "127.0.0.1", port: address.port });
  const closed = Promise.withResolvers<string>();
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    text += chunk;
  });
  socket.on("close", () => closed.resolve(text));
  socket.on("error", () => closed.resolve(text));
  await new Promise<void>((resolveConnect) =>
    socket.once("connect", () => resolveConnect()),
  );
  socket.write("GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
  const response = await closed.promise;
  assert.match(response, /^HTTP\/1\.1 200/);
  assert.ok(response.endsWith(HEALTH_BODY));
  socket.destroy();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

test("masked client text frames are accepted and unmasked ones close the connection", async () => {
  const delivered = Promise.withResolvers<string>();
  await withRaw(
    async (client) => {
      client.sendFrame(OPCODE.text, Buffer.from("hello"));
      assert.equal(await delivered.promise, "hello");

      client.sendUnmasked(OPCODE.text, Buffer.from("unmasked"));
      const closed = await client.control(OPCODE.close);
      assert.equal(closed.payload.readUInt16BE(0), WS_CLOSE.protocolError);
      assert.equal(
        closed.payload.subarray(2).toString("utf8"),
        "client frames must be masked",
      );
    },
    (transport) => {
      transport.setHandlers({
        onText: (text) => delivered.resolve(text),
        onClose: () => {},
      });
    },
  );
});

test("server frames are unmasked and carry the payload as text", async () => {
  await withRaw(
    async (client, harness) => {
      const transport = harness.transports[0];
      assert.ok(transport !== undefined);
      transport.send("from the server");
      const message = await client.message();
      assert.equal(message.opcode, "text");
      assert.equal(message.payload.toString("utf8"), "from the server");
    },
    (transport) => {
      transport.setHandlers({ onText: () => {}, onClose: () => {} });
    },
  );
});

test("a fragmented text message is reassembled before it is delivered", async () => {
  const delivered = Promise.withResolvers<string>();
  await withRaw(
    async (client) => {
      client.sendFrame(OPCODE.text, Buffer.from("he"), false);
      client.sendFrame(0x0, Buffer.from("ll"), false);
      client.sendFrame(0x0, Buffer.from("o"), true);
      assert.equal(await delivered.promise, "hello");
    },
    (transport) => {
      transport.setHandlers({
        onText: (text) => delivered.resolve(text),
        onClose: () => {},
      });
    },
  );
});

test("a ping is answered with a pong carrying the same payload", async () => {
  await withRaw(
    async (client) => {
      client.sendFrame(OPCODE.ping, Buffer.from("beat"));
      const pong = await client.control(OPCODE.pong);
      assert.equal(pong.payload.toString("utf8"), "beat");
    },
    (transport) => {
      transport.setHandlers({ onText: () => {}, onClose: () => {} });
    },
  );
});

test("a client close frame is echoed and reported with its code and reason", async () => {
  const closed = Promise.withResolvers<{
    readonly code: number;
    readonly reason: string;
  }>();
  await withRaw(
    async (client) => {
      const payload = Buffer.alloc(5);
      payload.writeUInt16BE(4001, 0);
      payload.write("bye", 2, "utf8");
      client.sendFrame(OPCODE.close, payload);
      const echoed = await client.control(OPCODE.close);
      assert.equal(echoed.payload.readUInt16BE(0), 4001);
      assert.deepEqual(await closed.promise, { code: 4001, reason: "bye" });
      await client.closed();
    },
    (transport) => {
      transport.setHandlers({
        onText: () => {},
        onClose: (code, reason) => closed.resolve({ code, reason }),
      });
    },
  );
});

test("a frame with a reserved bit set closes the connection instead of throwing", async () => {
  await withRaw(
    async (client) => {
      // FIN + RSV1 + text, masked, empty payload.
      client.sendRaw(Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]));
      const closed = await client.control(OPCODE.close);
      assert.equal(closed.payload.readUInt16BE(0), WS_CLOSE.protocolError);
      assert.equal(
        closed.payload.subarray(2).toString("utf8"),
        "RSV bits must be zero",
      );
    },
    (transport) => {
      transport.setHandlers({ onText: () => {}, onClose: () => {} });
    },
  );
});

test("an unsupported opcode closes with 1002", async () => {
  await withRaw(
    async (client) => {
      client.sendFrame(0x3, Buffer.from("x"));
      const closed = await client.control(OPCODE.close);
      assert.equal(closed.payload.readUInt16BE(0), WS_CLOSE.protocolError);
      assert.match(closed.payload.subarray(2).toString("utf8"), /opcode 3/);
    },
    (transport) => {
      transport.setHandlers({ onText: () => {}, onClose: () => {} });
    },
  );
});

test("a continuation frame without a start closes with 1002", async () => {
  await withRaw(
    async (client) => {
      client.sendFrame(0x0, Buffer.from("orphan"));
      const closed = await client.control(OPCODE.close);
      assert.equal(closed.payload.readUInt16BE(0), WS_CLOSE.protocolError);
    },
    (transport) => {
      transport.setHandlers({ onText: () => {}, onClose: () => {} });
    },
  );
});

test("a declared frame above 8 MiB closes with 1009 before the body arrives", async () => {
  await withRaw(
    async (client) => {
      const header = Buffer.alloc(14);
      header[0] = 0x80 | OPCODE.text;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES + 1), 2);
      header.writeUInt32BE(0, 10);
      client.sendRaw(header);
      const closed = await client.control(OPCODE.close);
      assert.equal(closed.payload.readUInt16BE(0), WS_CLOSE.messageTooBig);
    },
    (transport) => {
      transport.setHandlers({ onText: () => {}, onClose: () => {} });
    },
  );
});

test("a client reader requires unmasked frames from the server", () => {
  const errors: { code: number; reason: string }[] = [];
  const reader = new FrameReader({
    requireMasked: false,
    onMessage: () => {},
    onControl: () => {},
    onProtocolError: (code, reason) => errors.push({ code, reason }),
  });
  reader.push(encodeFrame(OPCODE.text, Buffer.from("masked"), { mask: true }));
  assert.deepEqual(errors, [
    {
      code: WS_CLOSE.protocolError,
      reason: "server frames must not be masked",
    },
  ]);
});

test("the reader handles chunk boundaries and both extended length forms", () => {
  const messages: string[] = [];
  const reader = new FrameReader({
    requireMasked: true,
    onMessage: (_opcode, payload) => messages.push(payload.toString("utf8")),
    onControl: () => {},
    onProtocolError: () => {},
  });
  const short = encodeFrame(OPCODE.text, Buffer.from("a"), { mask: true });
  const medium = encodeFrame(OPCODE.text, Buffer.from("b".repeat(200)), {
    mask: true,
  });
  const long = encodeFrame(OPCODE.text, Buffer.from("c".repeat(70_000)), {
    mask: true,
  });
  const joined = Buffer.concat([short, medium, long]);
  for (let index = 0; index < joined.length; index += 7) {
    reader.push(joined.subarray(index, index + 7));
  }
  assert.deepEqual(messages, ["a", "b".repeat(200), "c".repeat(70_000)]);
});

test("connectWebSocket upgrades, exchanges text and closes cleanly", async () => {
  const harness = await startHarness((transport) => {
    transport.setHandlers({
      onText: (text) => transport.send(`echo:${text}`),
      onClose: () => {},
    });
  });
  try {
    const transport = await connectWebSocket(
      { host: "127.0.0.1", port: harness.port },
      { onText: () => {}, onClose: () => {} },
    );
    const received = Promise.withResolvers<string>();
    transport.setHandlers({
      onText: (text) => received.resolve(text),
      onClose: () => {},
    });
    transport.send("ping");
    assert.equal(await received.promise, "echo:ping");
    transport.close(1000, "done");
    await transport.waitForClose();
    assert.equal(transport.closed, true);
  } finally {
    await harness.close();
  }
});

test("the handshake times out through the injected timers and releases the socket", async () => {
  // A server that accepts the TCP connection and never answers the upgrade.
  const sockets: Socket[] = [];
  const silent = createTcpServer((socket) => {
    sockets.push(socket);
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  silent.once("error", reject);
  silent.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = silent.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  if (address === null || typeof address === "string") return;
  const timers = new ManualTimers();
  const attempt = connectWebSocket(
    { host: "127.0.0.1", port: address.port },
    { onText: () => {}, onClose: () => {} },
    { timeoutMs: 5_000, timers },
  );
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  timers.advance(5_000);
  await assert.rejects(attempt, /handshake timed out after 5000ms/);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolveClose) => silent.close(() => resolveClose()));
});

test("the HTTP server answers /health without authentication and 404 elsewhere", async () => {
  const server: Server = createDaemonHttpServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  if (address === null || typeof address === "string") return;
  const fetchText = (path: string): Promise<{ status: number; body: string }> =>
    new Promise((resolveFetch, rejectFetch) => {
      const socket = connect({ host: "127.0.0.1", port: address.port });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.on("end", () => {
        const status = Number(text.split(" ")[1] ?? 0);
        resolveFetch({ status, body: text.split("\r\n\r\n")[1] ?? "" });
      });
      socket.on("error", rejectFetch);
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
    });
  try {
    assert.deepEqual(await fetchText("/health"), {
      status: 200,
      body: HEALTH_BODY,
    });
    assert.deepEqual(await fetchText("/port-proxy/1234/x"), {
      status: 404,
      body: PORT_PROXY_DISABLED_REASON,
    });
    assert.deepEqual(await fetchText("/unknown"), {
      status: 404,
      body: "Not Found",
    });
  } finally {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
});

test("the server module exposes the documented close codes", () => {
  assert.equal(WS_CLOSE.normal, 1000);
  assert.equal(WS_CLOSE.goingAway, 1001);
  assert.equal(WS_CLOSE.protocolError, 1002);
  assert.equal(WS_CLOSE.invalidPayload, 1007);
  assert.equal(WS_CLOSE.messageTooBig, 1009);
  assert.equal(WS_CLOSE.daemonShuttingDown, 4012);
  assert.equal(WS_CLOSE.daemonUpdating, 4013);
});
