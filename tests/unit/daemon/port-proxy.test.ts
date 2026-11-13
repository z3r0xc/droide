/**
 * The port proxy's pure half: URL validation, the token/cookie state machine,
 * the registry and the peer limiter. Clause: `specs/70` B33.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PORT_PROXY_COOKIE,
  PORT_PROXY_MAX_BODY_BYTES,
  PORT_PROXY_MAX_PORT,
  PORT_PROXY_MIN_PORT,
  PortProxyRateLimiter,
  PortProxyRegistry,
  createPortProxyToken,
  decideProxyAuth,
  isForwardablePort,
  isLoopbackPeer,
  isPortProxyUrl,
  isProxyHost,
  parsePortProxyUrl,
  proxyCookieHeader,
  proxyTokensMatch,
  readCookieToken,
  readQueryToken,
  stripProxyCookie,
  stripProxyTokenQuery,
} from "../../../src/daemon/port-proxy.ts";

const TOKEN = "a".repeat(43);

function routeOf(url: string) {
  const parsed = parsePortProxyUrl(url);
  assert.equal(parsed?.kind, "route");
  if (parsed?.kind !== "route") throw new Error("expected a route");
  return parsed.route;
}

function reasonOf(url: string): string {
  const parsed = parsePortProxyUrl(url);
  assert.equal(parsed?.kind, "invalid");
  if (parsed?.kind !== "invalid") throw new Error("expected a refusal");
  return parsed.reason;
}

test("the proxy token is 32 random base64url bytes", () => {
  const first = createPortProxyToken();
  const second = createPortProxyToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(proxyTokensMatch(first, first), true);
  assert.equal(proxyTokensMatch(first, second), false);
  assert.equal(proxyTokensMatch(first, `${first}x`), false);
  assert.equal(proxyTokensMatch(first, undefined), false);
});

test("the registry accepts only 1024-65535 and lists a sorted snapshot", () => {
  assert.equal(isForwardablePort(PORT_PROXY_MIN_PORT), true);
  assert.equal(isForwardablePort(PORT_PROXY_MAX_PORT), true);
  assert.equal(isForwardablePort(PORT_PROXY_MIN_PORT - 1), false);
  assert.equal(isForwardablePort(PORT_PROXY_MAX_PORT + 1), false);
  assert.equal(isForwardablePort(80.5), false);

  const registry = new PortProxyRegistry();
  registry.register(8080);
  registry.register(3000);
  assert.deepEqual(registry.list(), [3000, 8080]);
  assert.equal(registry.has(3000), true);
  assert.equal(registry.unregister(3000), true);
  assert.equal(registry.unregister(3000), false);
  assert.deepEqual(registry.list(), [8080]);
  assert.throws(() => registry.register(80), RangeError);
});

test("a valid target yields the normalised upstream path and query", () => {
  assert.deepEqual(routeOf("/port-proxy/3000/api/items?q=1&page=2"), {
    port: 3000,
    requestPath: "/port-proxy/3000/api/items",
    upstreamPath: "/api/items",
    query: "q=1&page=2",
  });
  assert.equal(routeOf("/port-proxy/3000").upstreamPath, "/");
  assert.equal(routeOf("/port-proxy/3000/").upstreamPath, "/");
  assert.equal(routeOf("/port-proxy/3000/a/b?x").query, "x");
  assert.equal(isPortProxyUrl("/port-proxy/3000/a"), true);
  assert.equal(isPortProxyUrl("/port-proxy"), true);
  assert.equal(isPortProxyUrl("/port-proxyx/3000"), false);
  assert.equal(isPortProxyUrl("/health"), false);
  assert.equal(isPortProxyUrl(undefined), false);
});

test("a path is normalised: duplicate slashes, dot segments and a trailing slash", () => {
  assert.equal(routeOf("/port-proxy/3000/a//b").upstreamPath, "/a/b");
  assert.equal(routeOf("/port-proxy/3000/a/./b/").upstreamPath, "/a/b/");
  assert.equal(routeOf("/port-proxy/3000/%61%62").upstreamPath, "/ab");
});

test("traversal, backslash, absolute and encoded-separator paths are refused", () => {
  assert.match(reasonOf("/port-proxy/3000/a/../b"), /\.\./);
  assert.match(reasonOf("/port-proxy/3000/%2e%2e/b"), /\.\./);
  assert.match(reasonOf("/port-proxy/3000/a%5Cb"), /backslash/);
  assert.match(reasonOf("/port-proxy/3000//etc/passwd"), /absolute/);
  assert.match(reasonOf("/port-proxy/3000/C:/Windows"), /drive-letter/);
  assert.match(reasonOf("/port-proxy/3000/a%2Fb"), /encoded path separator/);
  assert.match(reasonOf("/port-proxy/3000/a%00b"), /control/);
  assert.match(reasonOf("/port-proxy/3000/%zz"), /percent-escape/);
});

test("an ineligible or non-decimal port is refused", () => {
  assert.match(
    reasonOf("/port-proxy/80/x"),
    new RegExp(`outside ${PORT_PROXY_MIN_PORT}-${PORT_PROXY_MAX_PORT}`),
  );
  assert.match(reasonOf("/port-proxy/70000/x"), /outside/);
  assert.match(reasonOf("/port-proxy/abc/x"), /not a decimal port/);
  assert.match(reasonOf("/port-proxy/"), /port is required/);
  assert.match(reasonOf("/port-proxy"), /port is required/);
});

test("a target outside the prefix is not this surface", () => {
  assert.equal(parsePortProxyUrl("/health"), null);
  assert.equal(parsePortProxyUrl("/port-proxyx/3000"), null);
  assert.equal(parsePortProxyUrl("http://127.0.0.1/port-proxy/3000"), null);
  assert.equal(parsePortProxyUrl(undefined), null);
});

test("the token query parameter is stripped and other parameters survive", () => {
  assert.equal(
    stripProxyTokenQuery("daemonToken=secret&q=1&page=2"),
    "q=1&page=2",
  );
  assert.equal(
    stripProxyTokenQuery("q=1&daemonToken=secret&page=2"),
    "q=1&page=2",
  );
  assert.equal(stripProxyTokenQuery("daemonToken=only"), "");
  assert.equal(stripProxyTokenQuery("daemonToken=a&daemonToken=b"), "");
  assert.equal(stripProxyTokenQuery("q=1"), "q=1");
  assert.equal(stripProxyTokenQuery(""), "");
});

test("the token is read from the query and the cookie", () => {
  assert.equal(readQueryToken("daemonToken=abc"), "abc");
  assert.equal(readQueryToken("a=1&daemonToken=abc&b=2"), "abc");
  assert.equal(readQueryToken("daemonToken="), "");
  assert.equal(readQueryToken("a=1"), undefined);
  assert.equal(readQueryToken(""), undefined);

  assert.equal(readCookieToken(`${PORT_PROXY_COOKIE}=abc`), "abc");
  assert.equal(readCookieToken(`a=1; ${PORT_PROXY_COOKIE}=abc; b=2`), "abc");
  assert.equal(readCookieToken("a=1"), undefined);
  assert.equal(readCookieToken(undefined), undefined);
  assert.equal(readCookieToken(`${PORT_PROXY_COOKIE}=`), undefined);

  assert.equal(stripProxyCookie(`${PORT_PROXY_COOKIE}=secret; app=1`), "app=1");
  assert.equal(stripProxyCookie(`${PORT_PROXY_COOKIE}=secret`), undefined);
  assert.equal(stripProxyCookie("app=1"), "app=1");
});

test("the cookie is exchanged only for GET/HEAD and then wins over the query token", () => {
  const token = TOKEN;
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: undefined,
      cookieToken: undefined,
      method: "GET",
    }),
    { kind: "refuse", reason: "a daemon token is required" },
  );
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: "wrong",
      cookieToken: undefined,
      method: "GET",
    }),
    { kind: "refuse", reason: "the daemon token is not valid" },
  );
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: token,
      cookieToken: undefined,
      method: "GET",
    }),
    { kind: "exchange" },
  );
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: token,
      cookieToken: undefined,
      method: "HEAD",
    }),
    { kind: "exchange" },
  );
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: token,
      cookieToken: undefined,
      method: "POST",
    }),
    { kind: "query" },
  );
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: undefined,
      cookieToken: token,
      method: "GET",
    }),
    { kind: "cookie" },
  );
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: token,
      cookieToken: token,
      method: "GET",
    }),
    {
      kind: "refuse",
      reason: "the daemon token is refused in the URL once the cookie is set",
    },
  );
  assert.deepEqual(
    decideProxyAuth({
      token,
      queryToken: undefined,
      cookieToken: "stale",
      method: "GET",
    }),
    { kind: "refuse", reason: "the daemon cookie is not valid" },
  );
  assert.deepEqual(
    proxyCookieHeader(3000, token),
    `daemon_proxy=${token}; Path=/port-proxy/3000; HttpOnly; SameSite=Strict`,
  );
});

test("a stale cookie is discarded in favour of a valid query token", () => {
  assert.deepEqual(
    decideProxyAuth({
      token: TOKEN,
      queryToken: TOKEN,
      cookieToken: "stale",
      method: "GET",
    }),
    { kind: "exchange" },
  );
  assert.deepEqual(
    decideProxyAuth({
      token: TOKEN,
      queryToken: TOKEN,
      cookieToken: "stale",
      method: "PUT",
    }),
    { kind: "query" },
  );
});

test("the per-peer limiter resets on its window", () => {
  let clock = 1_000;
  const limiter = new PortProxyRateLimiter(2, 1_000, () => clock);
  assert.equal(limiter.take("127.0.0.1"), true);
  assert.equal(limiter.take("127.0.0.1"), true);
  assert.equal(limiter.take("127.0.0.1"), false);
  assert.equal(limiter.take("::1"), true);
  clock += 1_000;
  assert.equal(limiter.take("127.0.0.1"), true);
});

test("only loopback peers are local", () => {
  assert.equal(isLoopbackPeer("127.0.0.1"), true);
  assert.equal(isLoopbackPeer("127.8.9.10"), true);
  assert.equal(isLoopbackPeer("::1"), true);
  assert.equal(isLoopbackPeer("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackPeer(undefined), true);
  assert.equal(isLoopbackPeer("10.0.0.5"), false);
  assert.equal(isLoopbackPeer("192.168.1.2"), false);
  assert.equal(isLoopbackPeer("8.8.8.8"), false);
  assert.equal(isLoopbackPeer("::ffff:10.0.0.5"), false);
  assert.equal(isLoopbackPeer("2001:db8::1"), false);
});

test("only a loopback Host names this daemon", () => {
  assert.equal(isProxyHost("127.0.0.1"), true);
  assert.equal(isProxyHost("127.0.0.1:8080"), true);
  assert.equal(isProxyHost("localhost"), true);
  assert.equal(isProxyHost("LOCALHOST:5173"), true);
  assert.equal(isProxyHost("[::1]"), true);
  assert.equal(isProxyHost("[::1]:8080"), true);
  assert.equal(isProxyHost("attacker.example"), false);
  assert.equal(isProxyHost("attacker.example:8080"), false);
  assert.equal(isProxyHost("localhost.attacker.example"), false);
  assert.equal(isProxyHost("127.0.0.1.attacker.example"), false);
  assert.equal(isProxyHost("[::2]:8080"), false);
  assert.equal(isProxyHost("[::1"), false);
  assert.equal(isProxyHost(undefined), false);
});

test("the cookie is scoped to one port prefix", () => {
  const first = proxyCookieHeader(3000, TOKEN);
  const second = proxyCookieHeader(4000, TOKEN);
  assert.match(first, /; Path=\/port-proxy\/3000; /);
  assert.doesNotMatch(first, /Path=\/port-proxy;/);
  assert.notEqual(first, second);
});

test("the body ceiling is the protocol frame ceiling", () => {
  assert.equal(PORT_PROXY_MAX_BODY_BYTES, 8 * 1024 * 1024);
});
