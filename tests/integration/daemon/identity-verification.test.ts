/**
 * B15's two modes against a real backend stub: a configured base verifies the
 * credential and reports that account, and nothing about a failed check may
 * degrade into the local placeholder identity. Clauses: `specs/70` B15, B16,
 * B31; the request shape is `specs/50` B13, B32–B34.
 *
 * Every server — daemon and backend — binds port 0 on loopback and is closed
 * in `finally`. The credential in every test is a recognisable sentinel so a
 * leak into an error message or a log line is asserted, not eyeballed.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DaemonClient } from "../../../src/daemon/client.ts";
import type { DaemonAuthPolicy } from "../../../src/daemon/auth.ts";
import {
  LOCAL_IDENTITY,
  environmentAuthPolicy,
} from "../../../src/daemon/command.ts";
import {
  DaemonAuthRejectedError,
  DaemonCredentialVerificationError,
} from "../../../src/daemon/errors.ts";
import {
  WHOAMI_PATH,
  verifyCredentialWithBackend,
} from "../../../src/daemon/identity.ts";
import type { Environment } from "../../../src/config/paths.ts";
import { HttpClient, type FetchLike } from "../../../src/transport/client.ts";
import { startServer, type RunningServer } from "../../unit/daemon/helpers.ts";

/** Distinctive enough that any echo of it is unambiguous. */
const GOOD_KEY = "fk-live-4c1f9ab7e2d8";
const REVOKED_KEY = "fk-revoked-9e77c0b1";
const UNAVAILABLE_KEY = "fk-backend-down-2ab3";
const GARBAGE_KEY = "fk-garbage-answer-55d0";

function listenOnLoopback(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  return promise;
}

function originOf(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(
  server: Server,
  sockets: Iterable<Socket> = [],
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}

interface Backend {
  readonly origin: string;
  readonly paths: string[];
  readonly authorizations: (string | undefined)[];
  readonly whoamiExtended: (string | undefined)[];
  close(): Promise<void>;
}

/** The account the stub answers for the good key. */
const BACKEND_ACCOUNT = { userId: "user-42", orgId: "org-7" };

/**
 * Answers `GET /api/cli/whoami` like the documented identity endpoint: the
 * account for a good key, a refusal for a revoked one, an outage for a third,
 * and an unparseable body for a fourth.
 */
async function startBackend(): Promise<Backend> {
  const paths: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const whoamiExtended: (string | undefined)[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    paths.push(request.url ?? "");
    authorizations.push(request.headers.authorization);
    whoamiExtended.push(
      typeof request.headers["x-droide-whoami-extended"] === "string"
        ? request.headers["x-droide-whoami-extended"]
        : undefined,
    );
    if ((request.url ?? "") !== WHOAMI_PATH) {
      response.writeHead(404);
      response.end();
      return;
    }
    const presented = (request.headers.authorization ?? "").replace(
      /^Bearer /u,
      "",
    );
    if (presented === GOOD_KEY) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...BACKEND_ACCOUNT, region: "us" }));
      return;
    }
    if (presented === GARBAGE_KEY) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"unexpected":');
      return;
    }
    if (presented === UNAVAILABLE_KEY) {
      response.writeHead(503);
      response.end("upstream unavailable");
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":"unauthorized"}');
  });
  await listenOnLoopback(server);
  return {
    origin: originOf(server),
    paths,
    authorizations,
    whoamiExtended,
    close: () => closeServer(server),
  };
}

/** A backend that accepts connections and never answers. */
async function startSilentBackend(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer(() => {
    // Deliberately never answers; the client's deadline must fire.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenOnLoopback(server);
  return {
    origin: originOf(server),
    close: () => closeServer(server, sockets),
  };
}

function httpClient(): HttpClient {
  const fetchImpl: FetchLike = (url, init) => fetch(url, init);
  return new HttpClient({
    fetch: fetchImpl,
    sleep: async () => {},
    clock: { now: () => Date.now() },
  });
}

function environmentOf(
  env: Readonly<Record<string, string | undefined>>,
): Environment {
  return {
    env,
    home: join(tmpdir(), "droide-daemon-identity"),
    platform: "linux",
    cwd: join(tmpdir(), "droide-daemon-identity-work"),
  };
}

function verifiedPolicy(origin: string, timeoutMs?: number): DaemonAuthPolicy {
  return {
    verify: (request) =>
      verifyCredentialWithBackend(request, {
        base: new URL(origin),
        http: httpClient(),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
  };
}

/** Everything a failed handshake exposed, as one searchable string. */
function exposedText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const data = (error as { cause?: unknown }).cause;
  return [
    error.name,
    error.message,
    JSON.stringify((error as { data?: unknown }).data),
    data instanceof Error ? data.message : "",
  ].join("\n");
}

async function expectAuthRefusal(
  running: RunningServer,
  credential: { readonly token?: string; readonly apiKey?: string },
): Promise<DaemonAuthRejectedError> {
  const rejected = await DaemonClient.connect({
    target: running.target,
    credential,
  }).then(
    (client) => {
      void client.close();
      return undefined;
    },
    (error: unknown) => error,
  );
  assert.ok(
    rejected instanceof DaemonAuthRejectedError,
    "a refused credential must reject the handshake",
  );
  return rejected;
}

test("a configured base verifies the credential and answers that account", async () => {
  const backend = await startBackend();
  const running = await startServer({
    port: 0,
    auth: environmentAuthPolicy(
      environmentOf({ DROIDE_API_BASE_URL: backend.origin }),
      httpClient(),
    ),
  });
  try {
    const client = await DaemonClient.connect({
      target: running.target,
      credential: { apiKey: GOOD_KEY },
    });
    try {
      assert.deepEqual(client.identity, { ...BACKEND_ACCOUNT, verified: true });
    } finally {
      await client.close();
    }
    assert.deepEqual(backend.paths, [WHOAMI_PATH]);
    assert.deepEqual(backend.authorizations, [`Bearer ${GOOD_KEY}`]);
    assert.deepEqual(backend.whoamiExtended, ["true"]);
  } finally {
    await running.close();
    await backend.close();
  }
});

test("an invalid credential is refused as invalid_credential, never as a local account", async () => {
  const backend = await startBackend();
  const lines: string[] = [];
  const running = await startServer({
    port: 0,
    auth: environmentAuthPolicy(
      environmentOf({ DROIDE_API_BASE_URL: backend.origin }),
      httpClient(),
    ),
    logger: {
      debug: (line) => lines.push(line),
      info: (line) => lines.push(line),
      error: (line) => lines.push(line),
    },
  });
  try {
    const error = await expectAuthRefusal(running, { apiKey: REVOKED_KEY });
    assert.equal(error.reason, "invalid_credential");
    assert.equal(error.message, "Invalid credential");
    assert.equal(exposedText(error).includes(REVOKED_KEY), false);
    assert.equal(lines.join("\n").includes(REVOKED_KEY), false);
  } finally {
    await running.close();
    await backend.close();
  }
});

test("a configured base that does not answer is verification_unavailable", async () => {
  const backend = await startBackend();
  const running = await startServer({
    port: 0,
    auth: environmentAuthPolicy(
      environmentOf({ DROIDE_API_BASE_URL: backend.origin }),
      httpClient(),
    ),
  });
  try {
    const error = await expectAuthRefusal(running, {
      apiKey: UNAVAILABLE_KEY,
    });
    assert.equal(error.reason, "verification_unavailable");
    assert.equal(error.message, "Credential verification is unavailable");
    assert.equal(exposedText(error).includes(UNAVAILABLE_KEY), false);
  } finally {
    await running.close();
    await backend.close();
  }
});

test("an unparseable backend answer is a named failure, not an identity", async () => {
  const backend = await startBackend();
  const running = await startServer({
    port: 0,
    auth: environmentAuthPolicy(
      environmentOf({ DROIDE_API_BASE_URL: backend.origin }),
      httpClient(),
    ),
  });
  try {
    const error = await expectAuthRefusal(running, { apiKey: GARBAGE_KEY });
    assert.equal(error.reason, "verification_unavailable");
    assert.equal(error.message, "Credential verification is unavailable");
  } finally {
    await running.close();
    await backend.close();
  }
});

test("a backend that never answers hits the verification deadline", async () => {
  const backend = await startSilentBackend();
  const running = await startServer({
    port: 0,
    auth: verifiedPolicy(backend.origin, 50),
  });
  try {
    const error = await expectAuthRefusal(running, { apiKey: GOOD_KEY });
    assert.equal(error.reason, "verification_unavailable");
    assert.equal(error.message, "Credential verification is unavailable");
  } finally {
    await running.close();
    await backend.close();
  }
});

test("no base configured answers the local identity marked verified:false", async () => {
  const running = await startServer({
    port: 0,
    auth: environmentAuthPolicy(
      environmentOf({ DROIDE_API_KEY: GOOD_KEY }),
      httpClient(),
    ),
  });
  try {
    const client = await DaemonClient.connect({
      target: running.target,
      credential: { apiKey: GOOD_KEY },
    });
    try {
      assert.deepEqual(client.identity, {
        userId: LOCAL_IDENTITY.userId,
        orgId: LOCAL_IDENTITY.orgId,
        verified: false,
      });
    } finally {
      await client.close();
    }
  } finally {
    await running.close();
  }
});

test("the verifier's typed failures carry no credential and no backend answer", async () => {
  const backend = await startBackend();
  try {
    for (const [key, outcome] of [
      [REVOKED_KEY, "invalid_credential"],
      [UNAVAILABLE_KEY, "verification_unavailable"],
      [GARBAGE_KEY, "verification_unavailable"],
    ] as const) {
      const error = await verifyCredentialWithBackend(
        { apiKey: key },
        { base: new URL(backend.origin), http: httpClient() },
      ).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof DaemonCredentialVerificationError);
      assert.equal(error.outcome, outcome);
      assert.equal(error.reason, outcome);
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes(backend.origin), false);
    }
  } finally {
    await backend.close();
  }
});

test("the identity request refuses a redirect instead of following it", async () => {
  let followed = 0;
  const server = createServer((request, response) => {
    if (request.url === WHOAMI_PATH) {
      response.writeHead(307, { location: "/elsewhere" });
      response.end();
      return;
    }
    followed += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(BACKEND_ACCOUNT));
  });
  await listenOnLoopback(server);
  try {
    const error = await verifyCredentialWithBackend(
      { apiKey: GOOD_KEY },
      { base: new URL(originOf(server)), http: httpClient() },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof DaemonCredentialVerificationError);
    assert.equal(error.outcome, "verification_unavailable");
    assert.equal(followed, 0);
  } finally {
    await closeServer(server);
  }
});
