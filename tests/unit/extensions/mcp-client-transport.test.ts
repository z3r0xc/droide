/**
 * The streamable-HTTP transport against an injected `fetch`. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B3 (the remote transport, its headers
 * channel and the event-stream body) and B21 (cancellation classification).
 *
 * No socket is opened: `fetch` is a seam here, and every body is synthesised.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  McpCancelledError,
  McpProtocolError,
} from "../../../src/extensions/mcp/errors.ts";
import {
  HttpMcpTransport,
  parseMcpFrame,
} from "../../../src/extensions/mcp/transport.ts";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function transportWith(
  respond: () => Response,
  kind: "http" | "sse" = "http",
  headers: Readonly<Record<string, string>> = {},
): { transport: HttpMcpTransport; calls: Call[] } {
  const calls: Call[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  const transport = new HttpMcpTransport({
    server: "remote",
    kind,
    url: "https://mcp.invalid/rpc",
    headers,
    fetch: fakeFetch,
  });
  return { transport, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: Call | undefined): unknown {
  const body = call?.init?.body;
  return typeof body === "string" ? JSON.parse(body) : undefined;
}

function headersOf(call: Call | undefined): Record<string, string> {
  const headers = call?.init?.headers;
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  const result: Record<string, string> = {};
  for (const [name, value] of Array.isArray(headers)
    ? headers
    : Object.entries(headers)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

test("a request posts JSON-RPC with the configured headers", async () => {
  const { transport, calls } = transportWith(
    () => json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    "http",
    { authorization: "Bearer token", "content-type": "text/plain" },
  );

  const result = await transport.request("tools/list", { cursor: "p1" });
  assert.deepEqual(result, { tools: [] });

  const call = calls[0];
  assert.equal(call?.url, "https://mcp.invalid/rpc");
  assert.equal(call?.init?.method, "POST");
  assert.deepEqual(bodyOf(call), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { cursor: "p1" },
  });

  const headers = headersOf(call);
  assert.equal(headers["authorization"], "Bearer token");
  assert.equal(
    headers["content-type"],
    "application/json",
    "the protocol content type wins over a configured value",
  );
  assert.match(headers["accept"] ?? "", /application\/json/);
});

test("an sse server asks for an event stream and its body is decoded", async () => {
  const { transport, calls } = transportWith(
    () =>
      new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    "sse",
  );

  const result = await transport.request("tools/list");
  assert.deepEqual(result, { ok: true });
  assert.match(headersOf(calls[0])["accept"] ?? "", /^text\/event-stream/);
});

test("a JSON-RPC error response is a typed protocol error carrying its code", async () => {
  const { transport } = transportWith(() =>
    json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } }),
  );
  await assert.rejects(
    transport.request("tools/list"),
    (error: unknown) =>
      error instanceof McpProtocolError &&
      error.code === -32601 &&
      /rejected tools\/list: nope \(code -32601\)/.test(error.message),
  );
});

test("an answer for another id is refused", async () => {
  const { transport } = transportWith(() =>
    json({ jsonrpc: "2.0", id: 99, result: {} }),
  );
  await assert.rejects(
    transport.request("tools/list"),
    (error: unknown) =>
      error instanceof McpProtocolError &&
      /answered request id 99, not 1/.test(error.message),
  );
});

test("an HTTP failure names the status and the body tail", async () => {
  const { transport } = transportWith(
    () => new Response("upstream is down", { status: 503 }),
  );
  await assert.rejects(
    transport.request("tools/list"),
    (error: unknown) =>
      error instanceof McpProtocolError &&
      /HTTP 503: upstream is down/.test(error.message),
  );
});

test("a notification posts without an id and accepts 202", async () => {
  const { transport, calls } = transportWith(
    () => new Response(null, { status: 202 }),
  );
  await transport.notify("notifications/initialized");
  const body = bodyOf(calls[0]);
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(
    Object.hasOwn(body as Record<string, unknown>, "id"),
    false,
    "a notification carries no id",
  );
});

test("cancelling a dispatched request reports that it was in flight", async () => {
  const pending = Promise.withResolvers<Response>();
  const transport = new HttpMcpTransport({
    server: "remote",
    kind: "http",
    url: "https://mcp.invalid/rpc",
    headers: {},
    fetch: (_input, init) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          pending.reject(error);
        },
        { once: true },
      );
      return pending.promise;
    },
  });

  const controller = new AbortController();
  const request = transport.request(
    "tools/call",
    {},
    {
      signal: controller.signal,
    },
  );
  controller.abort();

  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof McpCancelledError &&
      error.stage === "in_flight" &&
      error.trigger === "aborted",
  );
});

test("a closed transport refuses a request before it is sent", async () => {
  const { transport, calls } = transportWith(() => json({}));
  await transport.close();
  await assert.rejects(
    transport.request("tools/list"),
    (error: unknown) =>
      error instanceof McpCancelledError && error.stage === "not_sent",
  );
  assert.equal(calls.length, 0);
});

test("an id-less notification frame parses with its params", () => {
  assert.deepEqual(
    parseMcpFrame(
      '{"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"file:///a"}}',
      { server: "unit" },
    ),
    {
      kind: "notification",
      method: "notifications/resources/updated",
      params: { uri: "file:///a" },
    },
  );
});
