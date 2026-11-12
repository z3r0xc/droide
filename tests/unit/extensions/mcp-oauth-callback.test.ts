import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  OAuthCallbackError,
  waitForAuthorizationCode,
} from "../../../src/extensions/mcp/oauth/callback.ts";

async function boundPort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const bound = Promise.withResolvers<number>();
  server.once("error", bound.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      bound.reject(new Error("no port"));
      return;
    }
    bound.resolve(address.port);
  });
  const port = await bound.promise;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function flow(expectedState: string, extra: Record<string, unknown> = {}) {
  const listening = Promise.withResolvers<string>();
  const result = waitForAuthorizationCode({
    expectedState,
    portStart: 0,
    onListening: (uri) => listening.resolve(uri),
    ...extra,
  });
  result.catch(() => undefined);
  return { redirect: listening.promise, result };
}

test("a matching state and code resolve the flow", async () => {
  const { redirect, result } = flow("state-1");

  const response = await fetch(`${await redirect}?code=CODE-1&state=state-1`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authorization received/);
  assert.deepEqual(await result, { code: "CODE-1" });
});

test("a wrong state is refused without ending the flow", async () => {
  const { redirect, result } = flow("right");
  const uri = await redirect;

  const refused = await fetch(`${uri}?code=C&state=wrong`);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /state mismatch/);

  const accepted = await fetch(`${uri}?code=CODE-2&state=right`);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await result, { code: "CODE-2" });
});

test("an error parameter rejects with its name", async () => {
  const { redirect, result } = flow("s");

  const response = await fetch(`${await redirect}?error=access_denied&state=s`);
  assert.equal(response.status, 400);
  await assert.rejects(result, (error: unknown) => {
    assert.equal(error instanceof OAuthCallbackError, true);
    assert.match(error instanceof Error ? error.message : "", /access_denied/);
    return true;
  });
});

test("a missing code on a matching state is refused and the flow continues", async () => {
  const { redirect, result } = flow("s");
  const uri = await redirect;

  assert.equal((await fetch(`${uri}?state=s`)).status, 400);
  assert.equal((await fetch(`${uri}?code=CODE-3&state=s`)).status, 200);
  assert.deepEqual(await result, { code: "CODE-3" });
});

test("an unrelated path is a 404 and does not end the flow", async () => {
  const { redirect, result } = flow("s");
  const uri = await redirect;

  assert.equal(
    (await fetch(uri.replace("/callback", "/favicon.ico"))).status,
    404,
  );
  assert.equal((await fetch(`${uri}?code=CODE-5&state=s`)).status, 200);
  assert.deepEqual(await result, { code: "CODE-5" });
});

test("the documented run skips a port that is already taken", async () => {
  const occupied = await boundPort();
  try {
    const listening = Promise.withResolvers<string>();
    const result = waitForAuthorizationCode({
      expectedState: "s",
      portStart: occupied.port,
      attempts: 3,
      onListening: (uri) => listening.resolve(uri),
    });
    result.catch(() => undefined);

    const uri = await listening.promise;
    assert.notEqual(uri, `http://127.0.0.1:${occupied.port}/callback`);
    assert.equal((await fetch(`${uri}?code=CODE-4&state=s`)).status, 200);
    assert.deepEqual(await result, { code: "CODE-4" });
  } finally {
    await occupied.close();
  }
});

test("the window expiring rejects with a bounded message", async () => {
  await assert.rejects(
    waitForAuthorizationCode({
      expectedState: "s",
      portStart: 0,
      timeoutMs: 20,
    }),
    /no authorization within 0 s|no authorization within/,
  );
});

test("an aborted signal cancels the wait", async () => {
  const controller = new AbortController();
  const flow = waitForAuthorizationCode({
    expectedState: "s",
    portStart: 0,
    signal: controller.signal,
    onListening: () => controller.abort(),
  });
  await assert.rejects(flow, /cancelled/);
});
