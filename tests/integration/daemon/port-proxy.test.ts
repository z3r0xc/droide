/**
 * The port proxy end to end: a real daemon on `:0`, a real loopback echo
 * service and every refusal. Clause: `specs/70` B33.
 *
 * Nothing binds a fixed port, nothing sleeps, and the temp state directory is
 * removed in `finally`.
 */

import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DaemonClient } from "../../../src/daemon/client.ts";
import {
  PORT_PROXY_DISABLED_REASON,
  PORT_PROXY_MAX_BODY_BYTES,
  PortProxyRegistry,
  createPortProxyOptions,
} from "../../../src/daemon/port-proxy.ts";
import { DaemonServer } from "../../../src/daemon/server.ts";
import { createDaemonHttpServer } from "../../../src/daemon/web-socket.ts";
import { TEST_API_KEY, testAuthPolicy } from "../../unit/daemon/helpers.ts";

interface Exchange {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function exchange(
  port: number,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
): Promise<Exchange> {
  const { promise, resolve, reject } = Promise.withResolvers<Exchange>();
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
    },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }),
      );
    },
  );
  request.on("error", reject);
  request.end(options.body);
  return promise;
}

interface EchoHttp {
  readonly port: number;
  readonly requests: EchoRequest[];
  close(): Promise<void>;
}

interface UpgradeEcho {
  readonly port: number;
  readonly heads: string[];
  close(): Promise<void>;
}

async function listen(server: NetServer): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    server.off("error", reject);
    resolve(address.port);
  });
  return promise;
}

async function closeServer(server: NetServer): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.off("error", reject);
      resolve(address.port);
    });
  });
  await closeServer(server);
  return port;
}

interface EchoRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A loopback HTTP service that reports exactly what the proxy forwarded. */
async function startEchoHttp(): Promise<EchoHttp> {
  const requests: EchoRequest[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const seen: EchoRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      requests.push(seen);
      response.writeHead(200, {
        "content-type": "application/json",
        "x-echo": "port-proxy",
        ...(request.url?.includes("trap=1")
          ? { "set-cookie": ["daemon_proxy=evil", "app=2"] }
          : {}),
      });
      response.end(JSON.stringify(seen));
    });
  });
  const port = await listen(server);
  return { port, requests, close: () => closeServer(server) };
}

/** A raw TCP service that completes a WebSocket handshake and echoes bytes. */
async function startUpgradeEcho(): Promise<UpgradeEcho> {
  const heads: string[] = [];
  const server = createTcpServer((socket) => {
    let pending = Buffer.alloc(0);
    let handshook = false;
    socket.on("data", (chunk: Buffer) => {
      if (handshook) {
        socket.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      handshook = true;
      heads.push(pending.subarray(0, end).toString("utf8"));
      const rest = pending.subarray(end + 4);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: dummy\r\n\r\n",
      );
      if (rest.byteLength > 0) socket.write(rest);
    });
  });
  const port = await listen(server);
  return { port, heads, close: () => closeServer(server) };
}

function readUntilHead(
  socket: Socket,
): Promise<{ readonly head: string; readonly rest: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    readonly head: string;
    readonly rest: string;
  }>();
  let data = "";
  const onData = (chunk: Buffer): void => {
    data += chunk.toString("utf8");
    const end = data.indexOf("\r\n\r\n");
    if (end < 0) return;
    socket.off("data", onData);
    resolve({ head: data.slice(0, end), rest: data.slice(end + 4) });
  };
  socket.on("data", onData);
  return promise;
}

async function upgrade(
  port: number,
  path: string,
  headers: readonly string[] = [],
): Promise<{
  readonly statusLine: string;
  readonly head: string;
  readonly socket: Socket;
  readonly rest: string;
}> {
  const socket = connectTcp({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...headers,
      "",
      "",
    ].join("\r\n"),
  );
  const { head, rest } = await readUntilHead(socket);
  return { statusLine: head.split("\r\n")[0] ?? "", head, socket, rest };
}

interface Fixture {
  readonly daemon: DaemonServer;
  readonly daemonPort: number;
  readonly token: string;
  readonly echo: EchoHttp;
  readonly upgradeEcho: UpgradeEcho;
  readonly registry: PortProxyRegistry;
  readonly stateDir: string;
  close(): Promise<void>;
}

async function startFixture(
  options: { readonly withRegistry?: boolean } = {},
): Promise<Fixture> {
  const stateDir = await mkdtemp(join(tmpdir(), "droide-port-proxy-"));
  const registry = new PortProxyRegistry();
  const echo = await startEchoHttp();
  const upgradeEcho = await startUpgradeEcho();
  registry.register(echo.port);
  registry.register(upgradeEcho.port);
  const daemon = new DaemonServer({
    auth: testAuthPolicy(),
    homedir: stateDir,
    host: "127.0.0.1",
    port: 0,
    ...(options.withRegistry === false ? {} : { portProxy: registry }),
  });
  const endpoint = await daemon.start();
  if (endpoint.kind !== "tcp") throw new Error("expected a TCP endpoint");
  return {
    daemon,
    daemonPort: endpoint.port,
    token: daemon.proxyToken,
    echo,
    upgradeEcho,
    registry,
    stateDir,
    async close() {
      await daemon.stop("test complete");
      await echo.close();
      await upgradeEcho.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

function cookie(token: string): string {
  return `daemon_proxy=${token}`;
}

test("the daemon keeps /health and 404s outside the proxy prefix", async () => {
  const fixture = await startFixture();
  try {
    const health = await exchange(fixture.daemonPort, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body, "droide-daemon ok");
    const unknown = await exchange(fixture.daemonPort, "/nope");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body, "Not Found");
  } finally {
    await fixture.close();
  }
});

test("a query token is exchanged for the scoped cookie and the redirect strips it", async () => {
  const fixture = await startFixture();
  try {
    const path = `/port-proxy/${fixture.echo.port}/echo?daemonToken=${fixture.token}&keep=1`;
    const response = await exchange(fixture.daemonPort, path);
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.location,
      `/port-proxy/${fixture.echo.port}/echo?keep=1`,
    );
    assert.equal(
      response.headers["set-cookie"]?.[0],
      `${cookie(fixture.token)}; Path=/port-proxy/${fixture.echo.port}; HttpOnly; SameSite=Strict`,
    );
    assert.equal(response.body, "");
    assert.equal(
      fixture.echo.requests.length,
      0,
      "the exchange is not proxied",
    );
  } finally {
    await fixture.close();
  }
});

test("the cookie proxies the request and the upstream never sees the token", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo?x=1`,
      {
        headers: {
          cookie: `${cookie(fixture.token)}; app=1`,
          host: `localhost:${fixture.daemonPort}`,
        },
      },
    );
    assert.equal(response.status, 200);
    const seen = JSON.parse(response.body) as EchoRequest;
    assert.equal(seen.method, "GET");
    assert.equal(seen.url, "/echo?x=1");
    assert.equal(seen.headers.cookie, "app=1");
    assert.equal(seen.headers.host, `127.0.0.1:${fixture.echo.port}`);
  } finally {
    await fixture.close();
  }
});

test("a non-GET with the query token is proxied with Set-Cookie and a stripped query", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo?daemonToken=${fixture.token}&keep=1`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "app=1" },
        body: '{"hello":"world"}',
      },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers["set-cookie"]?.[0],
      `${cookie(fixture.token)}; Path=/port-proxy/${fixture.echo.port}; HttpOnly; SameSite=Strict`,
    );
    const seen = JSON.parse(response.body) as EchoRequest;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/echo?keep=1");
    assert.equal(seen.body, '{"hello":"world"}');
    assert.equal(seen.headers.cookie, "app=1");
  } finally {
    await fixture.close();
  }
});

test("a WebSocket upgrade is tunneled and the token is stripped from the upstream path", async () => {
  const fixture = await startFixture();
  try {
    const path = `/port-proxy/${fixture.upgradeEcho.port}/ws?daemonToken=${fixture.token}&room=1`;
    const opened = await upgrade(fixture.daemonPort, path);
    try {
      assert.equal(opened.statusLine, "HTTP/1.1 101 Switching Protocols");
      assert.match(
        opened.head,
        new RegExp(
          `Set-Cookie: ${cookie(fixture.token)}; Path=/port-proxy/${fixture.upgradeEcho.port}; HttpOnly; SameSite=Strict`,
        ),
      );
      assert.equal(fixture.upgradeEcho.heads.length, 1);
      const upstreamHead = fixture.upgradeEcho.heads[0] ?? "";
      assert.match(upstreamHead, /^GET \/ws\?room=1 HTTP\/1\.1/);
      assert.doesNotMatch(upstreamHead, /daemonToken/);
      assert.doesNotMatch(upstreamHead, new RegExp(cookie(fixture.token)));

      const echoed = Promise.withResolvers<string>();
      opened.socket.once("data", (chunk: Buffer) =>
        echoed.resolve(chunk.toString("utf8")),
      );
      opened.socket.write("ping");
      assert.equal(await echoed.promise, "ping");
    } finally {
      opened.socket.destroy();
    }
  } finally {
    await fixture.close();
  }
});

test("a request with no token is 401", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo`,
    );
    assert.equal(response.status, 401);
    assert.match(response.body, /a daemon token is required/);
    assert.equal(fixture.echo.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a request with a wrong token is 401", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo?daemonToken=wrong`,
    );
    assert.equal(response.status, 401);
    assert.match(response.body, /the daemon token is not valid/);
    const stale = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo`,
      { headers: { cookie: cookie("stale") } },
    );
    assert.equal(stale.status, 401);
    assert.match(stale.body, /the daemon cookie is not valid/);
    assert.equal(fixture.echo.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a query token beside a valid cookie is 401", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo?daemonToken=${fixture.token}`,
      { headers: { cookie: cookie(fixture.token) } },
    );
    assert.equal(response.status, 401);
    assert.match(response.body, /refused in the URL once the cookie is set/);
    assert.equal(fixture.echo.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a port that is not registered is 403", async () => {
  const fixture = await startFixture();
  try {
    const port = await freePort();
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${port}/echo?daemonToken=${fixture.token}`,
    );
    assert.equal(response.status, 403);
    assert.match(response.body, new RegExp(`port ${port} is not registered`));
  } finally {
    await fixture.close();
  }
});

test("a registered port with no listener is 502", async () => {
  const fixture = await startFixture();
  try {
    const port = await freePort();
    fixture.registry.register(port);
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${port}/echo`,
      { headers: { cookie: cookie(fixture.token) } },
    );
    assert.equal(response.status, 502);
    assert.match(response.body, /could not be reached/);
  } finally {
    await fixture.close();
  }
});

test("an upstream cannot clobber the proxy cookie", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo?trap=1`,
      { headers: { cookie: cookie(fixture.token) } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers["set-cookie"], ["app=2"]);
  } finally {
    await fixture.close();
  }
});

test("a foreign Host header is 421", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo`,
      {
        headers: {
          cookie: cookie(fixture.token),
          host: "attacker.example",
        },
      },
    );
    assert.equal(response.status, 421);
    assert.match(response.body, /Host header must name this loopback daemon/);
    assert.equal(fixture.echo.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a client abort destroys the upstream request", async () => {
  const fixture = await startFixture();
  const started = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const held = createHttpServer((_request, response) => {
    started.resolve();
    response.on("close", () => closed.resolve());
  });
  const heldPort = await listen(held);
  fixture.registry.register(heldPort);
  try {
    const client = httpRequest({
      host: "127.0.0.1",
      port: fixture.daemonPort,
      path: `/port-proxy/${heldPort}/held`,
      headers: { cookie: cookie(fixture.token) },
    });
    client.on("error", () => {});
    client.end();
    await started.promise;
    client.destroy();
    await closed.promise;
  } finally {
    await closeServer(held);
    await fixture.close();
  }
});

test("a path with a .. segment is 400", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/a/../b?daemonToken=${fixture.token}`,
    );
    assert.equal(response.status, 400);
    assert.match(response.body, /\.\./);
    assert.equal(fixture.echo.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("an absolute path is 400", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}//etc/passwd?daemonToken=${fixture.token}`,
    );
    assert.equal(response.status, 400);
    assert.match(response.body, /absolute paths are refused/);
  } finally {
    await fixture.close();
  }
});

test("a backslash path is 400", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/a%5Cb?daemonToken=${fixture.token}`,
    );
    assert.equal(response.status, 400);
    assert.match(response.body, /backslashes are refused/);
  } finally {
    await fixture.close();
  }
});

test("an encoded path separator is 400", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/a%2Fb?daemonToken=${fixture.token}`,
    );
    assert.equal(response.status, 400);
    assert.match(response.body, /encoded path separator/);
  } finally {
    await fixture.close();
  }
});

test("an ineligible port is 400", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/80/x?daemonToken=${fixture.token}`,
    );
    assert.equal(response.status, 400);
    assert.match(response.body, /outside 1024-65535/);
  } finally {
    await fixture.close();
  }
});

test("a method outside the allowed set is 405 with Allow", async () => {
  const fixture = await startFixture();
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo?daemonToken=${fixture.token}`,
      { method: "TRACE" },
    );
    assert.equal(response.status, 405);
    assert.equal(
      response.headers.allow,
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    assert.match(response.body, /method TRACE is not allowed/);
    assert.equal(fixture.echo.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a body above the limit is 413", async () => {
  const fixture = await startFixture();
  try {
    const socket = connectTcp({ host: "127.0.0.1", port: fixture.daemonPort });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const response = Promise.withResolvers<string>();
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("end", () => response.resolve(data));
    socket.write(
      [
        `POST /port-proxy/${fixture.echo.port}/echo HTTP/1.1`,
        `Host: 127.0.0.1:${fixture.daemonPort}`,
        `Cookie: ${cookie(fixture.token)}`,
        `Content-Length: ${PORT_PROXY_MAX_BODY_BYTES + 1}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    assert.match(await response.promise, /^HTTP\/1\.1 413/);
    socket.destroy();
    assert.equal(fixture.echo.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a daemon without a registry is 404 with the reason", async () => {
  const fixture = await startFixture({ withRegistry: false });
  try {
    const response = await exchange(
      fixture.daemonPort,
      `/port-proxy/${fixture.echo.port}/echo?daemonToken=${fixture.token}`,
    );
    assert.equal(response.status, 404);
    assert.equal(response.body, PORT_PROXY_DISABLED_REASON);
  } finally {
    await fixture.close();
  }
});

test("the surface is rate-limited per peer", async () => {
  const registry = new PortProxyRegistry();
  const echo = await startEchoHttp();
  registry.register(echo.port);
  const token = "b".repeat(43);
  const server = createDaemonHttpServer({
    portProxy: createPortProxyOptions({
      token,
      registry,
      limit: 1,
      windowMs: 60_000,
      now: () => 5_000,
    }),
  });
  const port = await listen(server);
  try {
    const first = await exchange(
      port,
      `/port-proxy/${echo.port}/echo?daemonToken=${token}`,
    );
    assert.equal(first.status, 302);
    const second = await exchange(
      port,
      `/port-proxy/${echo.port}/echo?daemonToken=${token}`,
    );
    assert.equal(second.status, 429);
    assert.match(second.body, /too many requests/);
    assert.equal(echo.requests.length, 0);
  } finally {
    await closeServer(server);
    await echo.close();
  }
});

test("the registration methods fill the same table the proxy reads", async () => {
  const fixture = await startFixture();
  try {
    const client = await DaemonClient.connect({
      target: { host: "127.0.0.1", port: fixture.daemonPort },
      credential: { apiKey: TEST_API_KEY },
    });
    try {
      assert.deepEqual(await client.request("daemon.get_proxy_token"), {
        token: fixture.token,
      });
      const initial = (await client.request("daemon.list_port_forwards")) as {
        ports: number[];
      };
      assert.deepEqual(
        initial.ports,
        [fixture.echo.port, fixture.upgradeEcho.port].sort(
          (left, right) => left - right,
        ),
      );

      const port = await freePort();
      const registered = (await client.request("daemon.register_port_forward", {
        port,
      })) as { ports: number[] };
      assert.ok(registered.ports.includes(port));

      const unregistered = (await client.request(
        "daemon.unregister_port_forward",
        { port },
      )) as { ports: number[] };
      assert.ok(!unregistered.ports.includes(port));

      await assert.rejects(
        client.request("daemon.register_port_forward", { port: 80 }),
        /port must be between 1024 and 65535/,
      );
    } finally {
      await client.close();
    }
  } finally {
    await fixture.close();
  }
});
