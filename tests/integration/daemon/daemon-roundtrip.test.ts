/**
 * The daemon end to end: a real socket, the real client, the real server.
 * Clauses: `specs/70` B5, B7, B8, B12, B15–B19, B33.
 *
 * Every server binds port 0 (never a fixed port) and every test stops its
 * server in `finally`; the unix-socket case skips on Windows.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DaemonAuthRejectedError,
  DaemonConnectionClosedError,
  DaemonRequestAbortedError,
  DaemonRpcError,
} from "../../../src/daemon/errors.ts";
import {
  DaemonClient,
  type DaemonClientOptions,
} from "../../../src/daemon/client.ts";
import { runDaemon, type DaemonLogger } from "../../../src/daemon/server.ts";
import {
  createRequest,
  type DaemonEnvelope,
} from "../../../src/daemon/protocol.ts";
import {
  Peer,
  TEST_API_KEY,
  TEST_IDENTITY,
  TEST_TOKEN,
  countActiveResources,
  nextTick,
  startServer,
} from "../../unit/daemon/helpers.ts";

const AUTH_ID = "0b8f2f0e-9b1a-4c3d-8e4f-1a2b3c4d5e6f";
const SOCKET_RESOURCES = ["TCPSocketWrap", "TCPServerWrap", "Timeout"];

function clientOptions(
  target:
    | { readonly host: string; readonly port: number }
    | { readonly path: string },
  credential: { readonly token?: string; readonly apiKey?: string },
): DaemonClientOptions {
  return { target, credential };
}

async function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    body: string;
  }>();
  const request = httpRequest(
    { host: "127.0.0.1", port, path, method: "GET" },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    },
  );
  request.on("error", reject);
  request.end();
  return await promise;
}

test("a real client authenticates, requests, receives notifications and closes cleanly", async () => {
  const baseline = countActiveResources(SOCKET_RESOURCES);
  const notifications: string[] = [];
  const running = await startServer({
    port: 0,
    methods: { "daemon.echo": (params) => params },
  });
  try {
    if (running.endpoint.kind !== "tcp") return;
    const client = await DaemonClient.connect({
      target: running.target,
      credential: { apiKey: TEST_API_KEY },
      onNotification: (method) => notifications.push(method),
    });
    try {
      assert.deepEqual(client.identity, TEST_IDENTITY);
      assert.deepEqual(await client.request("daemon.echo", { value: 1 }), {
        value: 1,
      });
      await nextTick();
      assert.deepEqual(notifications, ["daemon.connection_status"]);
      await assert.rejects(client.request("daemon.nope"), (error: unknown) => {
        assert.ok(error instanceof DaemonRpcError);
        assert.equal(error.code, -32601);
        assert.equal(error.message, "Method not found: daemon.nope");
        return true;
      });
      assert.equal(client.pendingCount, 0);
    } finally {
      await client.close();
    }
  } finally {
    await running.close();
  }
  for (let turn = 0; turn < 200; turn += 1) {
    if (countActiveResources(SOCKET_RESOURCES) <= baseline) break;
    await nextTick();
  }
  assert.ok(
    countActiveResources(SOCKET_RESOURCES) <= baseline,
    "a closed client and server must not leave sockets or timers behind",
  );
});

test("a token is accepted and a wrong credential is refused as an auth rejection", async () => {
  const running = await startServer({ port: 0 });
  try {
    const accepted = await DaemonClient.connect(
      clientOptions(running.target, { token: TEST_TOKEN }),
    );
    await accepted.close();

    await assert.rejects(
      DaemonClient.connect(
        clientOptions(running.target, { apiKey: "fk-wrong" }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof DaemonAuthRejectedError);
        assert.equal(error.message, "Invalid API key");
        return true;
      },
    );
    await assert.rejects(
      DaemonClient.connect(clientOptions(running.target, { token: "wrong" })),
      (error: unknown) => {
        assert.ok(error instanceof DaemonAuthRejectedError);
        assert.equal(error.message, "Invalid authentication token");
        return true;
      },
    );
  } finally {
    await running.close();
  }
});

test("deflate-raw is negotiated and the daemon answers in binary frames", async () => {
  const running = await startServer({ port: 0 });
  const peer = await Peer.connect(running.target);
  try {
    peer.send(
      createRequest(
        "daemon.authenticate",
        { apiKey: TEST_API_KEY, acceptEncodings: ["deflate-raw"] },
        { id: AUTH_ID },
      ),
    );
    const response = await peer.next();
    assert.equal(response.type, "response");
    assert.deepEqual(
      response.type === "response" && "result" in response
        ? response.result
        : undefined,
      { ...TEST_IDENTITY, encoding: "deflate-raw" },
    );
    assert.ok(peer.binaryFrames >= 1);
  } finally {
    await peer.close();
    await running.close();
  }
});

test("a unix socket daemon serves the same protocol", async (context) => {
  if (process.platform === "win32") {
    context.skip("named pipes are not part of the documented Unix path");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "droide-daemon-"));
  const socketPath = join(directory, "daemon.sock");
  const running = await startServer({
    unixPath: socketPath,
    methods: { "daemon.echo": () => "unix" },
  });
  try {
    assert.deepEqual(running.endpoint, { kind: "unix", unixPath: socketPath });
    const client = await DaemonClient.connect(
      clientOptions({ path: socketPath }, { token: TEST_TOKEN }),
    );
    try {
      assert.equal(await client.request("daemon.echo"), "unix");
    } finally {
      await client.close();
    }
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness, request handling, ordered shutdown with a pending request and exit 0", async () => {
  const lines: string[] = [];
  const order: string[] = [];
  const banner = Promise.withResolvers<number>();
  const controller = new AbortController();
  const exiting = runDaemon({
    port: 0,
    bindRetryDelaysMs: [],
    signal: controller.signal,
    homedir: tmpdir(),
    auth: { identity: TEST_IDENTITY, apiKey: TEST_API_KEY },
    methods: { "daemon.wait": () => new Promise(() => {}) },
    stdout: (line) => {
      lines.push(line);
      if (line === "Press Ctrl+C to stop") {
        const endpoint = lines.find((entry) =>
          entry.startsWith("WebSocket endpoint: "),
        );
        banner.resolve(Number(endpoint?.split(":").pop() ?? 0));
      }
    },
    onShutdownStep: (name) => order.push(name),
  });
  const port = await banner.promise;
  assert.ok(port > 0);
  assert.equal(lines[0], "Daemon running");

  const client = await DaemonClient.connect({
    target: { host: "127.0.0.1", port },
    credential: { apiKey: TEST_API_KEY },
  });
  try {
    const pending = client.request("daemon.wait");
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof DaemonConnectionClosedError);
      return true;
    });
    await nextTick();
    controller.abort();
    assert.equal(await exiting, 0);
    await rejected;
    assert.deepEqual(order, [
      "liveness-monitor",
      "ipc-server",
      "web-socket-server",
    ]);
  } finally {
    controller.abort();
    await client.close();
  }
});

test("a second daemon on the same address exits 1 and the first keeps answering /health", async () => {
  const first = await startServer({ port: 0, bindRetryDelaysMs: [] });
  const stderr: string[] = [];
  const log: string[] = [];
  const logger: DaemonLogger = {
    debug() {},
    info() {},
    error: (line) => log.push(line),
  };
  try {
    if (first.endpoint.kind !== "tcp") return;
    const code = await runDaemon({
      port: first.endpoint.port,
      bindRetryDelaysMs: [],
      homedir: tmpdir(),
      auth: { identity: TEST_IDENTITY },
      stderr: (line) => stderr.push(line),
      logger,
    });
    assert.equal(code, 1);
    assert.match(stderr[0] ?? "", /^Startup failed: .*EADDRINUSE/);
    assert.deepEqual(log, ["CLI daemon startup failed"]);

    assert.deepEqual(await httpGet(first.endpoint.port, "/health"), {
      status: 200,
      body: "droide-daemon ok",
    });
  } finally {
    await first.close();
  }
});

test("reconnect rejects the in-flight request and the new connection works", async () => {
  const running = await startServer({
    port: 0,
    methods: {
      "daemon.echo": () => "after",
      "daemon.wait": () => new Promise(() => {}),
    },
  });
  try {
    const client = await DaemonClient.connect({
      target: running.target,
      credential: { apiKey: TEST_API_KEY },
    });
    try {
      const pending = client.request("daemon.wait");
      const rejected = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof DaemonConnectionClosedError);
        assert.equal(error.code, 1000);
        assert.equal(error.reason, "Connection reopened");
        return true;
      });
      await client.reconnect();
      await rejected;
      assert.equal(await client.request("daemon.echo"), "after");
    } finally {
      await client.close();
    }
  } finally {
    await running.close();
  }
});

test("aborting a request over a real socket leaves no pending entry", async () => {
  const running = await startServer({
    port: 0,
    methods: { "daemon.wait": () => new Promise(() => {}) },
  });
  try {
    const client = await DaemonClient.connect({
      target: running.target,
      credential: { apiKey: TEST_API_KEY },
    });
    try {
      const controller = new AbortController();
      const pending = client.request("daemon.wait", undefined, {
        signal: controller.signal,
      });
      controller.abort();
      await assert.rejects(pending, DaemonRequestAbortedError);
      assert.equal(client.pendingCount, 0);
      assert.deepEqual(
        await client.request("daemon.authenticate"),
        TEST_IDENTITY,
      );
    } finally {
      await client.close();
    }
  } finally {
    await running.close();
  }
});

test("a stray response frame never disturbs the connection", async () => {
  const running = await startServer({ port: 0 });
  const peer = await Peer.connect(running.target);
  try {
    peer.send(
      createRequest(
        "daemon.authenticate",
        { apiKey: TEST_API_KEY },
        { id: AUTH_ID },
      ),
    );
    await peer.next(); // success
    await peer.next(); // connection status
    const stray: DaemonEnvelope = {
      type: "response",
      jsonrpc: "2.0",
      droideApiVersion: "1.0.0",
      id: AUTH_ID,
      result: "stray",
    };
    peer.send(stray);
    peer.send(
      createRequest(
        "daemon.authenticate",
        { token: TEST_TOKEN },
        { id: AUTH_ID },
      ),
    );
    const answer = await peer.next();
    assert.equal(answer.type, "response");
    assert.deepEqual(
      answer.type === "response" && "result" in answer
        ? answer.result
        : undefined,
      TEST_IDENTITY,
    );
  } finally {
    await peer.close();
    await running.close();
  }
});
