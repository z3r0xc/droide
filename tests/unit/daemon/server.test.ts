/**
 * Server lifecycle and dispatch. Clauses: `specs/70` B3–B8, B11, B14–B18,
 * B31: transport precedence, readiness, the auth gate, ordered shutdown and
 * the bind-as-mutex rule.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCT_VERSION } from "../../../src/cli/brand.ts";
import { AUTHENTICATION_REQUIRED_MESSAGE } from "../../../src/daemon/auth.ts";
import { DaemonStartupError } from "../../../src/daemon/errors.ts";
import {
  FACTORY_PROTOCOL_VERSION,
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isJsonObject,
  serializeEnvelope,
  type DaemonEnvelope,
  type DaemonErrorResponse,
  type DaemonRequestEnvelope,
  type DaemonSuccessResponse,
} from "../../../src/daemon/protocol.ts";
import {
  DAEMON_VERSION,
  DaemonServer,
  formatReadinessBanner,
  runDaemon,
  selectDaemonTransport,
} from "../../../src/daemon/server.ts";
import {
  FakeParentChannel,
  ManualTimers,
  Peer,
  TEST_API_KEY,
  TEST_IDENTITY,
  TEST_TOKEN,
  nextTick,
  startServer,
  toServerOptions,
} from "./helpers.ts";

const AUTH_ID = "0b8f2f0e-9b1a-4c3d-8e4f-1a2b3c4d5e6f";
const SECOND_ID = "1c9f3f1e-0a2b-4d4e-9f5a-2b3c4d5e6f70";

function responseOf(
  envelope: DaemonEnvelope,
): DaemonSuccessResponse | DaemonErrorResponse {
  if (envelope.type !== "response") {
    throw new assert.AssertionError({
      message: `expected a response, got ${envelope.type}`,
    });
  }
  return envelope;
}

function resultOf(envelope: DaemonEnvelope): unknown {
  const response = responseOf(envelope);
  if (!("result" in response)) {
    throw new assert.AssertionError({
      message: "expected a successful response",
    });
  }
  return response.result;
}

function errorOf(envelope: DaemonEnvelope) {
  const response = responseOf(envelope);
  if (!("error" in response)) {
    throw new assert.AssertionError({ message: "expected a failure response" });
  }
  return response.error;
}

function requestOf(envelope: DaemonEnvelope): DaemonRequestEnvelope {
  if (envelope.type !== "request") {
    throw new assert.AssertionError({ message: "expected a request" });
  }
  return envelope;
}

/** Authenticate over a raw peer and consume the status notification. */
async function authenticate(peer: Peer): Promise<void> {
  peer.send(
    createRequest(
      "daemon.authenticate",
      { apiKey: TEST_API_KEY },
      { id: AUTH_ID },
    ),
  );
  assert.deepEqual(resultOf(await peer.next()), TEST_IDENTITY);
  const status = await peer.next();
  assert.equal(status.type, "notification");
  assert.equal(
    status.type === "notification" ? status.method : "",
    "daemon.connection_status",
  );
}

test("transport selection: ipc wins, then unix, then tcp, then none", () => {
  assert.deepEqual(selectDaemonTransport({ listen: "ipc", port: 1 }), {
    kind: "ipc",
  });
  assert.deepEqual(
    selectDaemonTransport({ unixPath: "/tmp/sock", port: 1, host: "h" }),
    { kind: "unix", path: "/tmp/sock" },
  );
  assert.deepEqual(selectDaemonTransport({ port: 0, host: "h" }), {
    kind: "tcp",
    host: "h",
    port: 0,
  });
  assert.deepEqual(selectDaemonTransport({ port: 7 }), {
    kind: "tcp",
    host: "127.0.0.1",
    port: 7,
  });
  assert.deepEqual(selectDaemonTransport({}), { kind: "none" });
});

test("the readiness banner lists the endpoint and, when on, Remote Control", () => {
  const base = {
    version: PRODUCT_VERSION,
    pid: 42,
    logsPath: "/logs/the daemon.log",
    remoteControl: false,
  };
  assert.deepEqual(
    formatReadinessBanner({ kind: "tcp", host: "127.0.0.1", port: 1234 }, base),
    [
      "Daemon running",
      `Version: ${PRODUCT_VERSION}`,
      "PID: 42",
      "Logs: /logs/the daemon.log",
      "WebSocket endpoint: ws://127.0.0.1:1234",
      "Press Ctrl+C to stop",
    ],
  );
  assert.deepEqual(
    formatReadinessBanner({ kind: "unix", unixPath: "/tmp/s" }, base).slice(4),
    ["Unix socket: /tmp/s", "Press Ctrl+C to stop"],
  );
  assert.deepEqual(formatReadinessBanner({ kind: "ipc" }, base).slice(4), [
    "IPC transport: parent process",
    "Press Ctrl+C to stop",
  ]);
  assert.deepEqual(
    formatReadinessBanner(
      { kind: "none" },
      { ...base, remoteControl: true },
    ).slice(4),
    [
      "No inbound transport: the daemon is reachable only through Remote Control",
      "Remote Control: enabled",
      "Press Ctrl+C to stop",
    ],
  );
});

test("--listen ipc requires an inherited channel", async () => {
  const server = new DaemonServer(toServerOptions({ listen: "ipc" }));
  await assert.rejects(server.start(), (error: unknown) => {
    assert.ok(error instanceof DaemonStartupError);
    assert.equal(error.code, "droide.daemon.ipc-unavailable");
    assert.equal(
      error.message,
      "--listen ipc requires the daemon to be spawned with an inherited IPC channel",
    );
    return true;
  });
  assert.equal(server.endpoint, undefined);
  await server.stop();
});

test("--listen ipc cannot be combined with --remote-control", async () => {
  const channel = new FakeParentChannel();
  const server = new DaemonServer(
    toServerOptions({
      listen: "ipc",
      parentChannel: channel,
      remoteControl: true,
    }),
  );
  await assert.rejects(server.start(), (error: unknown) => {
    assert.ok(error instanceof DaemonStartupError);
    assert.equal(error.code, "droide.daemon.ipc-remote-access");
    assert.equal(
      error.message,
      "--listen ipc cannot be combined with --remote-control",
    );
    return true;
  });
  await server.stop();
});

test("an inherited channel that is already gone is refused", async () => {
  const channel = new FakeParentChannel();
  channel.connected = false;
  const server = new DaemonServer(toServerOptions({ parentChannel: channel }));
  await assert.rejects(server.start(), (error: unknown) => {
    assert.ok(error instanceof DaemonStartupError);
    assert.equal(error.code, "droide.daemon.ipc-disconnected");
    return true;
  });
  await server.stop();
});

test("start on port 0 advertises the bound port and announces readiness in order", async () => {
  const order: string[] = [];
  const channel = new FakeParentChannel();
  const server = new DaemonServer(
    toServerOptions({
      port: 0,
      pid: 4242,
      parentChannel: channel,
      notifyReady: (state) => order.push(state),
      stdout: (line) => order.push(line),
    }),
  );
  try {
    const endpoint = await server.start();
    assert.equal(endpoint.kind, "tcp");
    if (endpoint.kind !== "tcp") return;
    assert.ok(endpoint.port > 0);
    assert.notEqual(endpoint.port, 0);

    assert.equal(order[0], "READY=1");
    assert.ok(order.includes("Daemon running"));
    assert.ok(order.includes(`Version: ${PRODUCT_VERSION}`));
    assert.ok(order.includes("PID: 4242"));
    assert.ok(
      order.includes(`WebSocket endpoint: ws://127.0.0.1:${endpoint.port}`),
    );
    assert.equal(order[order.length - 1], "Press Ctrl+C to stop");

    const ready = channel.sent.map((text) => JSON.parse(text) as unknown);
    assert.deepEqual(ready, [
      { type: "factory.daemon.ready", pid: 4242, version: DAEMON_VERSION },
    ]);
    await assert.rejects(server.start(), /already started/);
  } finally {
    await server.stop();
  }
});

test("a websocket daemon with no port and no unix path opens no inbound transport", async () => {
  const lines: string[] = [];
  const server = new DaemonServer(
    toServerOptions({ stdout: (line) => lines.push(line) }),
  );
  try {
    assert.deepEqual(await server.start(), { kind: "none" });
    assert.ok(
      lines.includes(
        "No inbound transport: the daemon is reachable only through Remote Control",
      ),
    );
  } finally {
    await server.stop();
  }
});

test("the gate rejects a non-auth first request with the fixed sentence", async () => {
  const running = await startServer({ port: 0 });
  const peer = await Peer.connect(running.target);
  try {
    // An unauthenticated notification is dropped, never answered: the first
    // frame the peer sees is the answer to the request that follows it.
    peer.send({
      type: "notification",
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      method: "daemon.session_cancel",
    });
    peer.send(
      createRequest("list_opened_sessions", undefined, { id: AUTH_ID }),
    );
    const response = responseOf(await peer.next());
    assert.deepEqual(response, {
      type: "response",
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
      id: AUTH_ID,
      error: { code: -32001, message: AUTHENTICATION_REQUIRED_MESSAGE },
    });

    peer.send(
      createRequest(
        "daemon.authenticate",
        { token: TEST_TOKEN },
        { id: SECOND_ID },
      ),
    );
    assert.deepEqual(resultOf(await peer.next()), TEST_IDENTITY);
  } finally {
    await peer.close();
    await running.close();
  }
});

test("a malformed frame before authentication is a parse error with id null and keeps the connection", async () => {
  const running = await startServer({ port: 0 });
  const peer = await Peer.connect(running.target);
  try {
    peer.sendRaw("{not json");
    const error = responseOf(await peer.next());
    assert.equal(error.id, null);
    assert.deepEqual(errorOf(await Promise.resolve(error)), {
      code: -32700,
      message: "Parse error",
    });
    peer.send(
      createRequest(
        "daemon.authenticate",
        { token: TEST_TOKEN },
        { id: AUTH_ID },
      ),
    );
    assert.deepEqual(responseOf(await peer.next()).id, AUTH_ID);
  } finally {
    await peer.close();
    await running.close();
  }
});

test("authenticate answers the identity, then the connection status, then the pipeline", async () => {
  const running = await startServer({
    port: 0,
    connectionStatus: { platform: "linux", hostId: "host-1" },
    methods: {
      list_opened_sessions: () => ({ sessions: ["one"] }),
    },
  });
  const peer = await Peer.connect(running.target);
  try {
    peer.send(
      createRequest(
        "daemon.authenticate",
        {
          apiKey: TEST_API_KEY,
          pipeline: [
            { id: AUTH_ID, method: "list_opened_sessions" },
            { id: SECOND_ID, method: "daemon.send_message" },
          ],
        },
        { id: "2d0a4f2e-1b3c-4e5f-8a6b-3c4d5e6f7081" },
      ),
    );
    assert.deepEqual(resultOf(await peer.next()), {
      ...TEST_IDENTITY,
      pipelined: true,
    });

    const status = await peer.next();
    assert.equal(status.type, "notification");
    if (status.type !== "notification") return;
    assert.equal(status.method, "daemon.connection_status");
    const params: unknown = status.params;
    assert.ok(isJsonObject(params));
    assert.equal(params["platform"], "linux");
    assert.equal(params["hostId"], "host-1");
    assert.equal(params["supportsRequestCwd"], true);

    const first = responseOf(await peer.next());
    assert.equal(first.id, AUTH_ID);
    assert.deepEqual(resultOf(first), { sessions: ["one"] });

    const refused = responseOf(await peer.next());
    assert.equal(refused.id, SECOND_ID);
    assert.deepEqual(errorOf(refused), {
      code: -32600,
      message: "Method is not allowed in the authentication pipeline",
    });
  } finally {
    await peer.close();
    await running.close();
  }
});

test("a version mismatch never blocks authenticate; it decorates a later failure", async () => {
  const running = await startServer({ port: 0 });
  const peer = await Peer.connect(running.target);
  try {
    peer.send(
      createRequest(
        "daemon.authenticate",
        { apiKey: TEST_API_KEY },
        { id: AUTH_ID, protocolVersion: "1.300.0" },
      ),
    );
    assert.ok("result" in responseOf(await peer.next()));
    await peer.next(); // connection status

    peer.send(
      createRequest("daemon.unknown", undefined, {
        id: SECOND_ID,
        protocolVersion: "1.300.0",
      }),
    );
    const failure = errorOf(await peer.next());
    assert.equal(failure.code, -32601);
    assert.equal(failure.message, "Method not found: daemon.unknown");
    assert.deepEqual(failure.data, {
      protocolVersionMismatch: {
        localFactoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
        peerFactoryProtocolVersion: "1.300.0",
        messageType: "request",
        method: "daemon.unknown",
        requestId: SECOND_ID,
      },
    });
  } finally {
    await peer.close();
    await running.close();
  }
});

test("an unknown method answers METHOD_NOT_FOUND and a handler throw answers INTERNAL_ERROR", async () => {
  const running = await startServer({
    port: 0,
    methods: {
      "daemon.explode": () => {
        throw new Error("boom");
      },
      "daemon.echo": (params) => params,
    },
  });
  const peer = await Peer.connect(running.target);
  try {
    await authenticate(peer);
    peer.send(createRequest("daemon.echo", { value: 1 }, { id: AUTH_ID }));
    assert.deepEqual(resultOf(await peer.next()), { value: 1 });

    peer.send(createRequest("daemon.nope", undefined, { id: SECOND_ID }));
    assert.equal(
      errorOf(await peer.next()).message,
      "Method not found: daemon.nope",
    );

    peer.send(createRequest("daemon.explode", undefined, { id: AUTH_ID }));
    assert.deepEqual(errorOf(await peer.next()), {
      code: -32603,
      message: "Internal server error",
    });
  } finally {
    await peer.close();
    await running.close();
  }
});

test("re-authenticate returns the connection identity and logout closes it", async () => {
  const running = await startServer({ port: 0 });
  const peer = await Peer.connect(running.target);
  try {
    await authenticate(peer);
    peer.send(
      createRequest(
        "daemon.authenticate",
        { token: "a-different-token" },
        {
          id: SECOND_ID,
        },
      ),
    );
    assert.deepEqual(resultOf(await peer.next()), TEST_IDENTITY);

    peer.send(createRequest("daemon.logout", undefined, { id: AUTH_ID }));
    assert.deepEqual(resultOf(await peer.next()), { accepted: true });
    await peer.transport.waitForClose();
    assert.deepEqual(peer.closeInfo, { code: 1000, reason: "logout" });
  } finally {
    await running.close();
  }
});

test("shutdown is ordered, bounded and closes open clients", async () => {
  const steps: string[] = [];
  const running = await startServer({
    port: 0,
    shutdownSteps: [
      { name: "relay", stop: () => {} },
      { name: "heartbeat", stop: () => {} },
    ],
    onShutdownStep: (name) => steps.push(name),
    methods: {
      "daemon.wait": () => new Promise(() => {}),
    },
  });
  const peer = await Peer.connect(running.target);
  try {
    await authenticate(peer);
    peer.send(createRequest("daemon.wait", undefined, { id: AUTH_ID }));
    await nextTick();

    const result = await running.server.stop("test signal");
    assert.deepEqual(result, { timedOut: false });
    assert.deepEqual(steps, [
      "relay",
      "heartbeat",
      "liveness-monitor",
      "ipc-server",
      "web-socket-server",
    ]);
    assert.equal(running.server.connectionCount, 0);
    await peer.transport.waitForClose();
    // stop is idempotent: a second call returns the same result object.
    assert.equal(await running.server.stop("again"), result);
  } finally {
    await running.close();
  }
});

test("a second server on the same address fails with a startup error and leaves the first listening", async () => {
  const first = await startServer({ port: 0, bindRetryDelaysMs: [] });
  try {
    assert.equal(first.endpoint.kind, "tcp");
    if (first.endpoint.kind !== "tcp") return;
    const second = new DaemonServer(
      toServerOptions({ port: first.endpoint.port, bindRetryDelaysMs: [] }),
    );
    await assert.rejects(second.start(), (error: unknown) => {
      assert.ok(error instanceof DaemonStartupError);
      assert.match(error.message, /EADDRINUSE/);
      return true;
    });
    assert.equal(second.endpoint, undefined);
    await second.stop();

    const peer = await Peer.connect(first.target);
    await authenticate(peer);
    await peer.close();
  } finally {
    await first.close();
  }
});

test("runDaemon prints the banner, stops on its signal and returns exit 0", async () => {
  const lines: string[] = [];
  const bannerComplete = Promise.withResolvers<void>();
  const controller = new AbortController();
  const exiting = runDaemon(
    toServerOptions({
      port: 0,
      bindRetryDelaysMs: [],
      signal: controller.signal,
      stdout: (line) => {
        lines.push(line);
        if (line === "Press Ctrl+C to stop") bannerComplete.resolve();
      },
    }),
  );
  await bannerComplete.promise;
  assert.equal(lines[0], "Daemon running");
  controller.abort();
  assert.equal(await exiting, 0);
  assert.equal(lines[lines.length - 1], "Press Ctrl+C to stop");
});

test("runDaemon reports a refused startup on stderr and returns exit 1", async () => {
  const first = await startServer({ port: 0, bindRetryDelaysMs: [] });
  const stderr: string[] = [];
  const errors: string[] = [];
  try {
    if (first.endpoint.kind !== "tcp") return;
    const code = await runDaemon(
      toServerOptions({
        port: first.endpoint.port,
        bindRetryDelaysMs: [],
        stderr: (line) => stderr.push(line),
        logger: {
          debug() {},
          info() {},
          error: (line) => errors.push(line),
        },
      }),
    );
    assert.equal(code, 1);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0] ?? "", /^Startup failed: .*EADDRINUSE/);
    assert.deepEqual(errors, ["CLI daemon startup failed"]);
  } finally {
    await first.close();
  }
});

test("runDaemon refuses --listen ipc without a channel and exits 1", async () => {
  const stderr: string[] = [];
  const code = await runDaemon(
    toServerOptions({ listen: "ipc", stderr: (line) => stderr.push(line) }),
  );
  assert.equal(code, 1);
  assert.deepEqual(stderr, [
    "Startup failed: --listen ipc requires the daemon to be spawned with an inherited IPC channel",
  ]);
});

test("the parent IPC transport frames requests as JSON strings and announces readiness", async () => {
  const channel = new FakeParentChannel();
  const server = new DaemonServer(
    toServerOptions({
      listen: "ipc",
      parentChannel: channel,
      methods: { "daemon.echo": (params) => params },
    }),
  );
  try {
    assert.deepEqual(await server.start(), { kind: "ipc" });
    assert.deepEqual(
      channel.sent.map((text) => JSON.parse(text) as unknown),
      [
        {
          type: "factory.daemon.ready",
          pid: process.pid,
          version: DAEMON_VERSION,
        },
      ],
    );

    channel.emitMessage(
      serializeEnvelope(
        createRequest(
          "daemon.authenticate",
          { token: TEST_TOKEN },
          { id: AUTH_ID },
        ),
      ),
    );
    for (let turn = 0; turn < 50 && channel.sent.length < 3; turn += 1) {
      await nextTick();
    }
    const answer = JSON.parse(channel.sent[1] ?? "{}") as DaemonEnvelope;
    assert.equal(responseOf(answer).id, AUTH_ID);
    assert.equal(channel.sent.length, 3);

    channel.emitMessage(
      serializeEnvelope(createRequest("daemon.echo", 1, { id: SECOND_ID })),
    );
    for (let turn = 0; turn < 50 && channel.sent.length < 4; turn += 1) {
      await nextTick();
    }
    const echoed = JSON.parse(channel.sent[3] ?? "{}") as DaemonEnvelope;
    assert.deepEqual(resultOf(echoed), 1);
  } finally {
    await server.stop();
  }
});

test("a parent disconnect stops an IPC-only daemon", async () => {
  const channel = new FakeParentChannel();
  const server = new DaemonServer(
    toServerOptions({ listen: "ipc", parentChannel: channel }),
  );
  try {
    await server.start();
    channel.emitDisconnect();
    await server.waitForShutdown();
    assert.equal(server.stopped, true);
    assert.equal(server.connectionCount, 0);
  } finally {
    await server.stop();
  }
});

test("--parent-pid polls every 2000 ms and shuts down when the parent disappears", async () => {
  const timers = new ManualTimers();
  const polls: number[] = [];
  const server = new DaemonServer(
    toServerOptions({
      port: 0,
      parentPid: 999_999,
      timers,
      isProcessAlive: (pid) => {
        polls.push(pid);
        return polls.length < 2;
      },
    }),
  );
  try {
    await server.start();
    timers.advance(1_999);
    assert.deepEqual(polls, []);
    timers.advance(1);
    assert.deepEqual(polls, [999_999]);
    assert.equal(server.stopped, false);
    timers.advance(2_000);
    assert.deepEqual(polls, [999_999, 999_999]);
    await server.waitForShutdown();
    assert.equal(server.stopped, true);
    assert.ok(server.shutdownTrail.includes("liveness-monitor"));
    assert.equal(timers.activeCount, 0);
  } finally {
    await server.stop();
  }
});

test("--liveness-fd stops the daemon when the inherited pipe closes", async () => {
  const opened: number[] = [];
  const stops: number[] = [];
  const pipeClose = Promise.withResolvers<() => void>();
  const server = new DaemonServer(
    toServerOptions({
      port: 0,
      livenessFd: 3,
      openLiveness: (fd, onClose) => {
        opened.push(fd);
        pipeClose.resolve(onClose);
        return {
          stop() {
            stops.push(fd);
          },
        };
      },
    }),
  );
  try {
    await server.start();
    assert.deepEqual(opened, [3]);
    const onClose = await pipeClose.promise;
    onClose();
    await server.waitForShutdown();
    assert.equal(server.stopped, true);
    assert.deepEqual(stops, [3]);
  } finally {
    await server.stop();
  }
});

test("a pending request is answered when the method resolves later", async () => {
  const resolveMethod = Promise.withResolvers<unknown>();
  const running = await startServer({
    port: 0,
    methods: { "daemon.late": () => resolveMethod.promise },
  });
  const peer = await Peer.connect(running.target);
  try {
    await authenticate(peer);
    peer.send(createRequest("daemon.late", undefined, { id: AUTH_ID }));
    await nextTick();
    assert.equal(peer.envelopes.length, 2);
    resolveMethod.resolve({ late: true });
    assert.deepEqual(resultOf(await peer.next()), { late: true });
  } finally {
    await peer.close();
    await running.close();
  }
});

test("the server reports the configured connection status and CLI version", async () => {
  const options = toServerOptions({ port: 0 });
  const server = new DaemonServer(options);
  try {
    await server.start();
    assert.equal(server.connectionStatus.droidCLIVersion, server.version);
    assert.equal(server.connectionStatus.homedir, options.homedir);
    assert.equal(server.pid, process.pid);
  } finally {
    await server.stop();
  }
});

test("a client response frame for an unknown id is dropped, not answered", async () => {
  const running = await startServer({ port: 0 });
  const peer = await Peer.connect(running.target);
  try {
    await authenticate(peer);
    peer.send(createErrorResponse(AUTH_ID, -32603, "stray"));
    peer.send(
      createRequest(
        "daemon.authenticate",
        { token: TEST_TOKEN },
        { id: SECOND_ID },
      ),
    );
    assert.equal(responseOf(await peer.next()).id, SECOND_ID);
  } finally {
    await peer.close();
    await running.close();
  }
});

test("an authenticated notification reaches the injected sink", async () => {
  const seen: { method: string; params: unknown }[] = [];
  const running = await startServer({
    port: 0,
    onNotification: (method, params) => seen.push({ method, params }),
  });
  const peer = await Peer.connect(running.target);
  try {
    await authenticate(peer);
    peer.send({
      type: "notification",
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      method: "daemon.session_cancel",
      params: { sessionId: "s" },
    });
    await nextTick();
    await nextTick();
    assert.deepEqual(seen, [
      { method: "daemon.session_cancel", params: { sessionId: "s" } },
    ]);
  } finally {
    await peer.close();
    await running.close();
  }
});

test("a response keeps the envelope shape of the protocol, not the request's version", async () => {
  const running = await startServer({
    port: 0,
    protocolVersion: "1.400.0",
    methods: { "daemon.echo": () => "value" },
  });
  const peer = await Peer.connect(running.target);
  try {
    await authenticate(peer);
    peer.send(createRequest("daemon.echo", undefined, { id: AUTH_ID }));
    const response = responseOf(await peer.next());
    assert.deepEqual(
      response,
      createSuccessResponse(AUTH_ID, "value", { protocolVersion: "1.400.0" }),
    );
    assert.equal(requestOf(createRequest("x")).method, "x");
  } finally {
    await peer.close();
    await running.close();
  }
});
