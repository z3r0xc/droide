import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  HttpClient,
  type FetchLike,
} from "../../../src/transport/client.ts";
import {
  ResponseTooLargeError,
  TransportTimeoutError,
} from "../../../src/transport/errors.ts";
import {
  chunkBytes,
  parseSse,
  type SseEvent,
} from "../../../src/transport/sse.ts";

interface Loopback {
  readonly origin: string;
  close(): Promise<void>;
}

async function startServer(): Promise<Loopback> {
  const server = createServer((request, response) => {
    switch (request.url) {
      case "/stream": {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('event: delta\ndata: {"n":1}\n\n');
        response.write('data: {"n":2}\n\n');
        response.end();
        return;
      }
      case "/big": {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(100));
        return;
      }
      case "/hang": {
        // Deliberately never answers.
        return;
      }
      default: {
        response.writeHead(404);
        response.end();
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not bind a TCP port");
  }
  const port = (address as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

function client(): HttpClient {
  const fetchImpl: FetchLike = (url, init) => fetch(url, init);
  return new HttpClient({
    fetch: fetchImpl,
    sleep: async () => {},
    clock: { now: () => Date.now() },
  });
}

test("a real HTTP stream frames into SSE events end to end", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const response = await client().request({
    operation: "stream",
    method: "GET",
    url: new URL(`${server.origin}/stream`),
    timeoutMs: 2000,
  });
  assert.equal(response.status, 200);

  const bytes = Buffer.from(response.body, "utf8");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunkBytes(bytes, 1)) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const events: SseEvent[] = [];
  for await (const event of parseSse(stream, { operation: "stream" })) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { kind: "data", event: "delta", data: '{"n":1}' },
    { kind: "data", event: null, data: '{"n":2}' },
  ]);
});

test("a body over the cap is refused across a real socket", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await assert.rejects(
    client().request({
      operation: "big",
      method: "GET",
      url: new URL(`${server.origin}/big`),
      timeoutMs: 2000,
      maxResponseBytes: 10,
    }),
    ResponseTooLargeError,
  );
});

test("a server that never answers hits the request deadline", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await assert.rejects(
    client().request({
      operation: "hang",
      method: "GET",
      url: new URL(`${server.origin}/hang`),
      timeoutMs: 50,
    }),
    (error: unknown) =>
      error instanceof TransportTimeoutError && error.timeoutMs === 50,
  );
});