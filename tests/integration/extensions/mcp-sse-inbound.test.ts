/**
 * The `sse` server-initiated stream against a real `node:http` server on an
 * ephemeral port. Contract: `specs/60-extensions-mcp-and-skills.md` B72 (the
 * `GET`, `Accept: text/event-stream`, `Last-Event-ID` resume, which
 * notifications are delivered, the bounded reconnect, the off-origin redirect
 * refusal, and a clean `close()`), plus B13's listing invalidation.
 *
 * Nothing here sleeps: every wait is a promise the server settles, and the
 * reconnect delay is injected.
 */

import assert from "node:assert/strict";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { McpClient } from "../../../src/extensions/mcp/client.ts";
import type { McpRemoteServerConfig } from "../../../src/extensions/mcp/config.ts";
import {
  HttpMcpTransport,
  type McpServerNotification,
  type McpSseReconnectPolicy,
} from "../../../src/extensions/mcp/transport.ts";

const FETCH = globalThis.fetch;

interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

type Respond = (request: IncomingMessage, response: ServerResponse) => void;

/** Listen on an ephemeral loopback port; `close` also drops open sockets. */
async function serve(respond: Respond): Promise<TestServer> {
  const server = createServer(respond);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      const closed = Promise.withResolvers<void>();
      server.close((error) => {
        if (error === undefined) closed.resolve();
        else closed.reject(error);
      });
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

/** Start an event stream: headers, then one comment so the client knows. */
function openStream(response: ServerResponse): ServerResponse {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.write(": open\n\n");
  return response;
}

function streamTransport(
  url: string,
  options: { readonly reconnect?: McpSseReconnectPolicy } = {},
): HttpMcpTransport {
  return new HttpMcpTransport({
    server: "unit",
    kind: "sse",
    url,
    headers: { authorization: "Bearer test" },
    fetch: FETCH,
    ...(options.reconnect === undefined
      ? {}
      : { reconnect: options.reconnect }),
  });
}

test("an sse stream delivers only the three notifications, in order", async (t) => {
  let stream: ServerResponse | undefined;
  const opened = Promise.withResolvers<void>();
  const last = Promise.withResolvers<void>();
  const notifications: McpServerNotification[] = [];
  const server = await serve((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(202).end();
      return;
    }
    stream = openStream(response);
    opened.resolve();
  });
  t.after(() => server.close());

  const transport = streamTransport(server.url);
  transport.setNotificationHandler((notification) => {
    notifications.push(notification);
    if (notification.method === "notifications/tools/list_changed") {
      last.resolve();
    }
  });
  await opened.promise;

  stream?.write(
    'event: message\nid: 7\ndata: {"jsonrpc":"2.0","method":"notifications/resources/updated",\ndata: "params":{"uri":"file:///a"}}\n\n' +
      "event: ping\ndata: {}\n\n" +
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
  );
  await last.promise;

  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ["notifications/resources/updated", "notifications/tools/list_changed"],
  );
  assert.deepEqual(notifications[0]?.params, { uri: "file:///a" });
  assert.equal(transport.lastEventId, "7");
  assert.equal(
    transport.ignoredNotifications,
    2,
    "the ping and progress frames",
  );
  await transport.close();
});

test("a dropped stream reconnects with Last-Event-ID", async (t) => {
  const gets: IncomingHttpHeaders[] = [];
  const secondOpen = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let attempts = 0;
  const server = await serve((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(202).end();
      return;
    }
    gets.push(request.headers);
    attempts += 1;
    if (attempts === 1) {
      openStream(response).end(
        'id: 42\ndata: {"jsonrpc":"2.0","method":"notifications/resources/list_changed"}\n\n',
      );
      return;
    }
    openStream(response);
    secondOpen.resolve();
    response.write(
      'data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"file:///b"}}\n\n',
    );
  });
  t.after(() => server.close());

  const transport = streamTransport(server.url, {
    reconnect: { delayMs: () => 0 },
  });
  transport.setNotificationHandler((notification) => {
    if (notification.method === "notifications/resources/updated") {
      delivered.resolve();
    }
  });
  await secondOpen.promise;
  assert.equal(gets.length, 2);
  assert.equal(gets[1]?.["last-event-id"], "42");
  await delivered.promise;
  assert.equal(
    transport.lastEventId,
    "42",
    "an id-less frame keeps the resume id",
  );
  await transport.close();
});

test("a same-origin redirect is followed, a different origin is refused", async (t) => {
  const target = await serve((_request, response) => {
    openStream(response);
  });
  const redirected = await serve((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(302, { location: target.url }).end();
  });
  const directUrls: string[] = [];
  const followedOpen = Promise.withResolvers<void>();
  const followedFrame = Promise.withResolvers<void>();
  let followedStream: ServerResponse | undefined;
  const sameOrigin = await serve((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(202).end();
      return;
    }
    directUrls.push(request.url ?? "");
    if (!(request.url ?? "").includes("resumed=1")) {
      response.writeHead(307, { location: "/mcp?resumed=1" }).end();
      return;
    }
    followedStream = openStream(response);
    followedOpen.resolve();
  });
  t.after(async () => {
    await Promise.all([redirected.close(), target.close(), sameOrigin.close()]);
  });

  const refusedTransport = streamTransport(redirected.url);
  t.after(() => refusedTransport.close());
  refusedTransport.setNotificationHandler(() => undefined);
  await refusedTransport.inboundSettled;
  assert.equal(refusedTransport.inboundState, "failed");
  assert.match(
    refusedTransport.inboundError?.message ?? "",
    /redirected from http:\/\/127\.0\.0\.1:\d+ to a different origin/,
  );

  const followed = streamTransport(sameOrigin.url);
  t.after(() => followed.close());
  followed.setNotificationHandler(() => {
    followedFrame.resolve();
  });
  await followedOpen.promise;
  assert.deepEqual(directUrls, ["/mcp", "/mcp?resumed=1"]);
  followedStream?.write(
    'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
  );
  await followedFrame.promise;
  assert.equal(followed.inboundState, "open");
});

test("reconnect stops at the policy's bound and the POST path still works", async (t) => {
  const gets: IncomingHttpHeaders[] = [];
  const delays: number[] = [];
  const posts: string[] = [];
  const server = await serve((request, response) => {
    if (request.method !== "GET") {
      posts.push(request.method ?? "");
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"jsonrpc":"2.0","id":1,"result":{}}');
      return;
    }
    gets.push(request.headers);
    response.destroy();
  });
  t.after(() => server.close());

  const transport = streamTransport(server.url, {
    reconnect: {
      delayMs(attempt) {
        delays.push(attempt);
        return attempt > 2 ? undefined : 0;
      },
    },
  });
  transport.setNotificationHandler(() => undefined);
  await transport.inboundSettled;

  assert.equal(transport.inboundState, "failed");
  assert.equal(gets.length, 3, "the first open plus two retries");
  assert.deepEqual(delays, [1, 2, 3]);

  const result = await transport.request("ping");
  assert.deepEqual(result, {});
  assert.equal(posts.length, 1, "a failed stream never disables requests");
  await transport.close();
});

test("close() ends the stream and the server sees the socket go", async (t) => {
  const opened = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const server = await serve((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(202).end();
      return;
    }
    const stream = openStream(response);
    opened.resolve();
    stream.on("close", () => {
      ended.resolve();
    });
  });
  t.after(() => server.close());

  const transport = streamTransport(server.url);
  transport.setNotificationHandler(() => undefined);
  await opened.promise;
  await transport.close();
  await ended.promise;
  assert.equal(transport.inboundState, "closed");
});

test("tools/list_changed invalidates the cached listing exactly once", async (t) => {
  const config: McpRemoteServerConfig = {
    type: "sse",
    url: "",
    headers: {},
    disabled: false,
  };
  let stream: ServerResponse | undefined;
  const opened = Promise.withResolvers<void>();
  const notified = Promise.withResolvers<void>();
  let listings = 0;
  const server = await serve((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "GET") {
        stream = openStream(response);
        opened.resolve();
        return;
      }
      if (body === "") {
        response.writeHead(202).end();
        return;
      }
      const frame = JSON.parse(body) as {
        id?: number;
        method: string;
      };
      if (frame.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "sse-fixture", version: "0.0.0" },
            },
          }),
        );
        return;
      }
      if (frame.method === "tools/list") {
        listings += 1;
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              tools: [
                {
                  name: `tool-${listings}`,
                  description: "a tool",
                  inputSchema: { type: "object" },
                },
              ],
            },
          }),
        );
        return;
      }
      response.writeHead(202).end();
    })();
  });
  t.after(() => server.close());

  const client = new McpClient({
    server: "sse-fixture",
    config: { ...config, url: server.url },
    fetch: FETCH,
    onServerNotification: () => {
      notified.resolve();
    },
  });
  await client.connect();
  await opened.promise;

  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-1"],
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-1"],
  );
  assert.equal(listings, 1, "the second call reused the cached listing");

  stream?.write(
    'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
  );
  await notified.promise;
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-2"],
    "the listing was re-read once",
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-2"],
  );
  assert.equal(listings, 2, "not once per call");
  await client.close();
});
