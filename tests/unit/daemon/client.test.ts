/**
 * The daemon client. Clauses: `specs/70` B13, B14, B19: per-method timeouts,
 * abort, pending rejection on close and reconnect, and no leaked timers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DaemonConnectionClosedError,
  DaemonInvalidResponseError,
  DaemonRequestAbortedError,
  DaemonRpcError,
  DaemonTimeoutError,
} from "../../../src/daemon/errors.ts";
import {
  DaemonClient,
  METHOD_TIMEOUTS,
  SESSION_SEND_TIMEOUT_MS,
  type DaemonClientOptions,
  type DaemonCredential,
} from "../../../src/daemon/client.ts";
import {
  createErrorResponse,
  createNotification,
  createRequest,
  createSuccessResponse,
  encodeBinaryFrame,
  parseTextFrame,
  type DaemonEnvelope,
  type DaemonRequestEnvelope,
} from "../../../src/daemon/protocol.ts";
import {
  FakeTransport,
  ManualTimers,
  TEST_ACCOUNT,
  TEST_IDENTITY,
  TEST_TOKEN,
  nextTick,
} from "./helpers.ts";

const TARGET = { host: "127.0.0.1", port: 1 } as const;
const REQUEST_ID = "0b8f2f0e-9b1a-4c3d-8e4f-1a2b3c4d5e6f";

interface Connected {
  readonly client: DaemonClient;
  readonly transport: FakeTransport;
  readonly timers: ManualTimers;
}

interface ClientOverrides {
  readonly credential?: DaemonCredential;
  readonly methodTimeouts?: Readonly<Record<string, number>>;
  readonly validateResult?: (method: string, result: unknown) => void;
  readonly onNotification?: (method: string, params: unknown) => void;
  readonly onServerRequest?: (
    method: string,
    params: unknown,
  ) => unknown | Promise<unknown>;
}

function optionsOf(
  transport: FakeTransport,
  timers: ManualTimers,
  overrides: ClientOverrides = {},
): DaemonClientOptions {
  return {
    target: TARGET,
    credential: overrides.credential ?? { token: TEST_TOKEN },
    transport,
    timers,
    ...(overrides.methodTimeouts === undefined
      ? {}
      : { methodTimeouts: overrides.methodTimeouts }),
    ...(overrides.validateResult === undefined
      ? {}
      : { validateResult: overrides.validateResult }),
    ...(overrides.onNotification === undefined
      ? {}
      : { onNotification: overrides.onNotification }),
    ...(overrides.onServerRequest === undefined
      ? {}
      : { onServerRequest: overrides.onServerRequest }),
  };
}

/** Answer the authenticate request the client sends on open. */
async function answerAuthenticate(
  transport: FakeTransport,
  identity: { readonly userId: string; readonly orgId: string } = TEST_IDENTITY,
): Promise<DaemonRequestEnvelope> {
  await nextTick();
  const request = transport.lastSent;
  assert.equal(request.type, "request");
  if (request.type !== "request") {
    throw new assert.AssertionError({ message: "expected a request" });
  }
  assert.equal(request.method, "daemon.authenticate");
  transport.deliverEnvelope(
    createSuccessResponse(request.id, { ...identity, verified: false }),
  );
  return request;
}

async function connected(overrides: ClientOverrides = {}): Promise<Connected> {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const opening = DaemonClient.connect(optionsOf(transport, timers, overrides));
  await answerAuthenticate(transport);
  const client = await opening;
  return { client, transport, timers };
}

test("connect sends daemon.authenticate first and remembers the identity", async () => {
  const { client, transport } = await connected();
  assert.deepEqual(client.identity, TEST_ACCOUNT);
  assert.equal(client.connected, true);
  const sent = parseTextFrame(transport.sent[0] ?? "");
  assert.equal(sent.type, "request");
  if (sent.type !== "request") return;
  assert.equal(sent.method, "daemon.authenticate");
  assert.equal(transport.sent.length, 1);
  await client.close();
});

test("an API key is sent instead of a token when that is the credential", async () => {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const opening = DaemonClient.connect(
    optionsOf(transport, timers, { credential: { apiKey: "fk-test" } }),
  );
  await nextTick();
  const request = transport.lastSent;
  assert.equal(
    request.type === "request" ? JSON.stringify(request.params) : "",
    JSON.stringify({ apiKey: "fk-test" }),
  );
  transport.deliverEnvelope(
    createSuccessResponse(
      request.type === "request" ? request.id : REQUEST_ID,
      { ...TEST_IDENTITY },
    ),
  );
  const client = await opening;
  await client.close();
});

test("a request resolves with the result of the response carrying its id", async () => {
  const { client, transport, timers } = await connected();
  const response = client.request("daemon.echo", { value: 7 });
  await nextTick();
  const sent = transport.lastSent;
  assert.equal(sent.type, "request");
  if (sent.type !== "request") return;
  assert.equal(sent.method, "daemon.echo");
  assert.deepEqual(sent.params, { value: 7 });
  transport.deliverEnvelope(createSuccessResponse(sent.id, { echoed: 7 }));
  assert.deepEqual(await response, { echoed: 7 });
  assert.equal(client.pendingCount, 0);
  assert.equal(timers.activeCount, 0);
  await client.close();
});

test("a response for an unknown id is dropped without settling anything", async () => {
  const { client, transport } = await connected();
  const response = client.request("daemon.echo");
  await nextTick();
  transport.deliverEnvelope(createSuccessResponse(REQUEST_ID, "stray"));
  assert.equal(client.pendingCount, 1);
  const sent = transport.lastSent;
  if (sent.type === "request") {
    transport.deliverEnvelope(createSuccessResponse(sent.id, "real"));
  }
  assert.equal(await response, "real");
  await client.close();
});

test("an error response becomes a DaemonRpcError with the code and data", async () => {
  const { client, transport } = await connected();
  const response = client.request("daemon.missing");
  await nextTick();
  const sent = transport.lastSent;
  if (sent.type === "request") {
    transport.deliverEnvelope(
      createErrorResponse(sent.id, -32601, "Method not found: daemon.missing", {
        protocolVersionMismatch: { local: "2", peer: "1" },
      }),
    );
  }
  await assert.rejects(response, (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.code, -32601);
    assert.equal(error.method, "daemon.missing");
    assert.deepEqual(error.data, {
      protocolVersionMismatch: { local: "2", peer: "1" },
    });
    return true;
  });
  await client.close();
});

test("a request times out with the method, id and budget after the injected delay", async () => {
  const { client, timers } = await connected();
  const response = client.request("daemon.slow", undefined, { id: REQUEST_ID });
  const settled = assert.rejects(response, (error: unknown) => {
    assert.ok(error instanceof DaemonTimeoutError);
    assert.equal(error.method, "daemon.slow");
    assert.equal(error.id, REQUEST_ID);
    assert.equal(error.timeoutMs, 30_000);
    return true;
  });
  timers.advance(29_999);
  assert.equal(client.pendingCount, 1);
  timers.advance(1);
  await settled;
  assert.equal(client.pendingCount, 0);
  assert.equal(timers.activeCount, 0);
  await client.close();
});

test("a method's own budget overrides the default", async () => {
  const { client, timers } = await connected();
  assert.equal(METHOD_TIMEOUTS["daemon.send_message"], SESSION_SEND_TIMEOUT_MS);
  const response = client.request("daemon.send_message");
  const settled = assert.rejects(response, (error: unknown) => {
    assert.ok(error instanceof DaemonTimeoutError);
    assert.equal(error.timeoutMs, SESSION_SEND_TIMEOUT_MS);
    return true;
  });
  timers.advance(30_000);
  assert.equal(client.pendingCount, 1);
  timers.advance(SESSION_SEND_TIMEOUT_MS - 30_000);
  await settled;
  await client.close();

  const custom = await connected({ methodTimeouts: { "x.y": 100 } });
  const fast = custom.client.request("x.y");
  const rejected = assert.rejects(fast, (error: unknown) => {
    assert.ok(error instanceof DaemonTimeoutError);
    assert.equal(error.timeoutMs, 100);
    return true;
  });
  custom.timers.advance(100);
  await rejected;
  await custom.client.close();
});

test("an abort before send drops the request unsent", async () => {
  const { client, transport } = await connected();
  const sentBefore = transport.sent.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.request("daemon.echo", undefined, { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof DaemonRequestAbortedError);
      assert.equal(error.id, undefined);
      assert.equal(error.method, "daemon.echo");
      return true;
    },
  );
  assert.equal(transport.sent.length, sentBefore);
  assert.equal(client.pendingCount, 0);
  await client.close();
});

test("an abort after send rejects locally and discards a late response", async () => {
  const { client, transport, timers } = await connected();
  const controller = new AbortController();
  const response = client.request("daemon.echo", undefined, {
    signal: controller.signal,
  });
  await nextTick();
  const sent = transport.lastSent;
  controller.abort();
  await assert.rejects(response, DaemonRequestAbortedError);
  assert.equal(client.pendingCount, 0);
  assert.equal(timers.activeCount, 0);
  if (sent.type === "request") {
    // The late answer is ignored: nothing is pending under that id.
    transport.deliverEnvelope(createSuccessResponse(sent.id, "late"));
  }
  assert.equal(client.pendingCount, 0);
  await client.close();
});

test("close rejects every pending request with the close code and reason", async () => {
  const { client, transport, timers } = await connected();
  const first = client.request("daemon.one");
  const second = client.request("daemon.two");
  const closed = Promise.all([
    assert.rejects(first, (error: unknown) => {
      assert.ok(error instanceof DaemonConnectionClosedError);
      assert.equal(error.code, 4001);
      assert.equal(error.reason, "shutting down");
      return true;
    }),
    assert.rejects(second, DaemonConnectionClosedError),
  ]);
  await client.close(4001, "shutting down");
  await closed;
  assert.equal(client.pendingCount, 0);
  assert.equal(timers.activeCount, 0);
  assert.deepEqual(transport.closeCalls, [
    { code: 4001, reason: "shutting down" },
  ]);
  await assert.rejects(
    client.request("daemon.one"),
    DaemonConnectionClosedError,
  );
});

test("reconnect rejects pending work with 1000 Connection reopened and re-authenticates", async () => {
  const { client, transport, timers } = await connected();
  const pending = client.request("daemon.slow");
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DaemonConnectionClosedError);
    assert.equal(error.code, 1000);
    assert.equal(error.reason, "Connection reopened");
    return true;
  });
  const reopening = client.reconnect();
  await rejected;
  await answerAuthenticate(transport);
  await reopening;
  assert.equal(client.connected, true);
  assert.deepEqual(client.identity, TEST_ACCOUNT);
  const after = client.request("daemon.echo");
  await nextTick();
  const sent = transport.lastSent;
  if (sent.type === "request") {
    transport.deliverEnvelope(createSuccessResponse(sent.id, "after"));
  }
  assert.equal(await after, "after");
  assert.equal(timers.activeCount, 0);
  await client.close();
});

test("a result that fails the method contract becomes an invalid-response error", async () => {
  const { client, transport } = await connected({
    validateResult: (method, result) => {
      if (method === "daemon.echo" && typeof result !== "string") {
        throw new Error("result must be a string");
      }
    },
  });
  const response = client.request("daemon.echo");
  await nextTick();
  const sent = transport.lastSent;
  if (sent.type === "request") {
    transport.deliverEnvelope(createSuccessResponse(sent.id, 7));
  }
  await assert.rejects(response, (error: unknown) => {
    assert.ok(error instanceof DaemonInvalidResponseError);
    assert.equal(error.method, "daemon.echo");
    return true;
  });
  await client.close();
});

test("a notification is delivered to the subscriber, a bare response is ignored", async () => {
  const seen: { method: string; params: unknown }[] = [];
  const { client, transport } = await connected({
    onNotification: (method, params) => seen.push({ method, params }),
  });
  transport.deliverEnvelope(
    createNotification("daemon.connection_status", { platform: "linux" }),
  );
  assert.deepEqual(seen, [
    { method: "daemon.connection_status", params: { platform: "linux" } },
  ]);
  // A response the daemon never asked for does not disturb the connection.
  transport.deliverEnvelope(createSuccessResponse(REQUEST_ID, "stray"));
  assert.equal(client.connected, true);
  await client.close();
});

test("a daemon request is answered, with -32601 when no handler is installed", async () => {
  const { client, transport } = await connected();
  transport.deliverEnvelope(
    createRequest(
      "daemon.request_permission",
      { sessionId: "s" },
      {
        id: REQUEST_ID,
      },
    ),
  );
  await nextTick();
  const reply = transport.lastSent;
  assert.equal(reply.type, "response");
  assert.equal(reply.type === "response" ? reply.id : "", REQUEST_ID);
  assert.deepEqual(
    reply.type === "response" && "error" in reply ? reply.error.code : 0,
    -32601,
  );
  await client.close();
});

test("a daemon request the client can answer returns its result under the same id", async () => {
  const { client, transport } = await connected({
    onServerRequest: (method) => ({ handled: method }),
  });
  transport.deliverEnvelope(
    createRequest("daemon.ask_user", { question: "?" }, { id: REQUEST_ID }),
  );
  await nextTick();
  await nextTick();
  const reply = transport.lastSent;
  assert.equal(reply.type, "response");
  assert.equal(reply.type === "response" ? reply.id : "", REQUEST_ID);
  assert.deepEqual(
    reply.type === "response" && "result" in reply ? reply.result : undefined,
    { handled: "daemon.ask_user" },
  );
  await client.close();
});

test("a binary response is decoded and settled like a text one", async () => {
  const { client, transport } = await connected();
  const response = client.request("daemon.echo");
  await nextTick();
  const sent = transport.lastSent;
  if (sent.type === "request") {
    transport.deliverBinary(
      encodeBinaryFrame(createSuccessResponse(sent.id, "compressed")),
    );
  }
  assert.equal(await response, "compressed");
  await client.close();
});

test("an unparseable frame closes the connection with 1007 and rejects pending work", async () => {
  const { client, transport } = await connected();
  const pending = client.request("daemon.echo");
  transport.deliverText("{not json");
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DaemonConnectionClosedError);
    assert.equal(error.code, 1007);
    assert.match(error.reason, /unparseable frame/);
    return true;
  });
  assert.equal(client.connected, false);
  assert.equal(client.pendingCount, 0);
  assert.deepEqual(transport.closeCalls, [
    { code: 1007, reason: "unparseable frame" },
  ]);
});

test("notify sends a notification without a pending slot", async () => {
  const { client, transport } = await connected();
  client.notify("daemon.ping", { at: 1 });
  const sent: DaemonEnvelope = transport.lastSent;
  assert.equal(sent.type, "notification");
  assert.equal(client.pendingCount, 0);
  await client.close();
  assert.throws(
    () => client.notify("daemon.ping"),
    DaemonConnectionClosedError,
  );
});
