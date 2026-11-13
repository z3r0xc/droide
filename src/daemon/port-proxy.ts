/**
 * The token-gated, loopback-only port proxy. Contract:
 * `specs/70-daemon-and-remote-control.md` B33.
 *
 * The surface is `/port-proxy/<port><path>`. It exists only when the daemon
 * was handed a {@link PortProxyRegistry}; without one every request under the
 * prefix answers `404` with the reason instead of pretending the path does not
 * exist. A request is authenticated by a per-process token in the
 * `daemonToken` query parameter or the `daemon_proxy` cookie; a `GET`/`HEAD`
 * that presents the query form is exchanged for an `HttpOnly;
 * SameSite=Strict` cookie scoped to the port prefix by a `302`, so the token
 * never lingers in an address bar.
 *
 * Everything the peer sends is untrusted: the path is decoded and normalised
 * before use, the upstream host is fixed at `127.0.0.1`, the peer must be
 * loopback, the token comparison is constant-time, and the surface is
 * rate-limited per peer.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  STATUS_CODES,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as connectTcp, isIPv4, isIPv6 } from "node:net";
import type { Duplex } from "node:stream";

import { DaemonProtocolError } from "./errors.ts";
import { JSON_RPC_ERRORS, MAX_FRAME_BYTES } from "./protocol.ts";

/** The path prefix the surface owns. */
export const PORT_PROXY_PREFIX = "/port-proxy";
/** Query parameter that carries the token. */
export const PORT_PROXY_TOKEN_QUERY = "daemonToken";
/** Cookie that carries the token once exchanged. */
export const PORT_PROXY_COOKIE = "daemon_proxy";
/** Entropy of the per-process token (B33). */
export const PORT_PROXY_TOKEN_BYTES = 32;
/** Eligible port range (B33). */
export const PORT_PROXY_MIN_PORT = 1024;
export const PORT_PROXY_MAX_PORT = 65535;
/** Request-body ceiling; the same 8 MiB as a protocol frame. */
export const PORT_PROXY_MAX_BODY_BYTES = MAX_FRAME_BYTES;
/** The methods the proxy answers; anything else is `405`. */
export const PORT_PROXY_METHODS: readonly string[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];
/** Per-peer budget: 600 requests in a 10 s fixed window. */
export const PORT_PROXY_RATE_LIMIT = 600;
export const PORT_PROXY_RATE_WINDOW_MS = 10_000;
/** The only host the proxy ever dials. */
export const PORT_PROXY_UPSTREAM_HOST = "127.0.0.1";

/** RPC that hands the token to an authenticated client (B33). */
export const GET_PROXY_TOKEN_METHOD = "daemon.get_proxy_token";
/** RPCs that fill and read the registry (B33). */
export const REGISTER_PORT_FORWARD_METHOD = "daemon.register_port_forward";
export const UNREGISTER_PORT_FORWARD_METHOD = "daemon.unregister_port_forward";
export const LIST_PORT_FORWARDS_METHOD = "daemon.list_port_forwards";

/** The body of the `404` when the daemon has no registry (B33). */
export const PORT_PROXY_DISABLED_REASON =
  "port proxy is not enabled: no forwardable-port registry is configured";

const HOP_BY_HOP_HEADERS: Readonly<Record<string, true>> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

/** Whether a port is eligible for the proxy (B33). */
export function isForwardablePort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= PORT_PROXY_MIN_PORT &&
    port <= PORT_PROXY_MAX_PORT
  );
}

/**
 * The daemon's forwardable-port table. Empty on construction; the session
 * manager (or `daemon.register_port_forward`) adds a port when a local
 * service starts listening and removes it when that service stops.
 */
export class PortProxyRegistry {
  private readonly ports = new Set<number>();

  /** Add a port; out-of-range values are a programming error, not input. */
  register(port: number): void {
    if (!isForwardablePort(port)) {
      throw new RangeError(
        `port ${port} is outside ${PORT_PROXY_MIN_PORT}-${PORT_PROXY_MAX_PORT}`,
      );
    }
    this.ports.add(port);
  }

  /** Remove a port; answers whether it was registered. */
  unregister(port: number): boolean {
    return this.ports.delete(port);
  }

  has(port: number): boolean {
    return this.ports.has(port);
  }

  /** A sorted snapshot, so a response never exposes live state. */
  list(): readonly number[] {
    return [...this.ports].sort((left, right) => left - right);
  }
}

/** Mint the per-process token: 32 random bytes, unpadded base64url. */
export function createPortProxyToken(): string {
  return randomBytes(PORT_PROXY_TOKEN_BYTES).toString("base64url");
}

/** Constant-time comparison; a length mismatch short-circuits. */
export function proxyTokensMatch(
  expected: string,
  provided: string | undefined,
): boolean {
  if (provided === undefined) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/**
 * A fixed-window, per-peer limiter. The clock is injected so a test never
 * sleeps (B33: 600 requests per 10 s).
 */
export class PortProxyRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(
    limit: number = PORT_PROXY_RATE_LIMIT,
    windowMs: number = PORT_PROXY_RATE_WINDOW_MS,
    now: () => number = Date.now,
  ) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Count one request; `false` means this peer is over budget. */
  take(key: string): boolean {
    const at = this.now();
    const window = this.windows.get(key);
    if (window === undefined || at - window.start >= this.windowMs) {
      this.windows.set(key, { start: at, count: 1 });
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }
}

/** One validated proxy request. */
export interface PortProxyRoute {
  readonly port: number;
  /** The request path exactly as sent (for the `302` Location). */
  readonly requestPath: string;
  /** The normalised path forwarded upstream. */
  readonly upstreamPath: string;
  /** The raw query, still carrying `daemonToken` when it arrived that way. */
  readonly query: string;
}

export type PortProxyParse =
  | { readonly kind: "route"; readonly route: PortProxyRoute }
  | { readonly kind: "invalid"; readonly reason: string };

/** Split a raw request target into its path and query (fragment dropped). */
export function splitRawUrl(rawUrl: string): {
  readonly path: string;
  readonly query: string;
} {
  const hash = rawUrl.indexOf("#");
  const withoutFragment = hash < 0 ? rawUrl : rawUrl.slice(0, hash);
  const question = withoutFragment.indexOf("?");
  return question < 0
    ? { path: withoutFragment, query: "" }
    : {
        path: withoutFragment.slice(0, question),
        query: withoutFragment.slice(question + 1),
      };
}

/** Whether a request target is owned by this surface at all. */
export function isPortProxyUrl(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined) return false;
  const { path } = splitRawUrl(rawUrl);
  return path === PORT_PROXY_PREFIX || path.startsWith(`${PORT_PROXY_PREFIX}/`);
}

const DRIVE_LETTER = /^[A-Za-z]:$/;

/**
 * Decode and normalise the part after the port. Returns `400` reasons for
 * traversal, backslashes, control characters, encoded separators, a
 * protocol-relative path and a drive-letter absolute path.
 */
function normalisePortProxyPath(rawRest: string):
  | { readonly kind: "ok"; readonly path: string }
  | {
      readonly kind: "invalid";
      readonly reason: string;
    } {
  if (rawRest === "") return { kind: "ok", path: "/" };
  if (rawRest.startsWith("//")) {
    return { kind: "invalid", reason: "absolute paths are refused" };
  }
  if (rawRest.includes("\\")) {
    return { kind: "invalid", reason: "backslashes are refused" };
  }
  const parts = rawRest.slice(1).split("/");
  const segments: string[] = [];
  let trailingSlash = false;
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index] ?? "";
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { kind: "invalid", reason: "a percent-escape does not decode" };
    }
    if (decoded.includes("\\")) {
      return { kind: "invalid", reason: "backslashes are refused" };
    }
    if (decoded.includes("/")) {
      return {
        kind: "invalid",
        reason: "an encoded path separator is refused",
      };
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded)) {
      return { kind: "invalid", reason: "control characters are refused" };
    }
    if (decoded === "..") {
      return { kind: "invalid", reason: '".." segments are refused' };
    }
    if (decoded === "" || decoded === ".") {
      if (index === parts.length - 1 && segments.length > 0)
        trailingSlash = true;
      continue;
    }
    if (segments.length === 0 && DRIVE_LETTER.test(decoded)) {
      return {
        kind: "invalid",
        reason: "drive-letter absolute paths are refused",
      };
    }
    segments.push(decoded);
  }
  const joined = segments.join("/");
  return {
    kind: "ok",
    path: `/${joined}${trailingSlash && joined !== "" ? "/" : ""}`,
  };
}

/**
 * Validate `/port-proxy/<port><path>`. `null` means the target is not on this
 * surface; `invalid` carries the exact `400` reason.
 */
export function parsePortProxyUrl(
  rawUrl: string | undefined,
): PortProxyParse | null {
  if (rawUrl === undefined || !rawUrl.startsWith("/")) return null;
  const { path, query } = splitRawUrl(rawUrl);
  if (path !== PORT_PROXY_PREFIX && !path.startsWith(`${PORT_PROXY_PREFIX}/`)) {
    return null;
  }
  const remainder = path.slice(PORT_PROXY_PREFIX.length);
  if (remainder === "" || remainder === "/") {
    return { kind: "invalid", reason: "a port is required" };
  }
  const separator = remainder.indexOf("/", 1);
  const portText =
    separator < 0 ? remainder.slice(1) : remainder.slice(1, separator);
  const rawRest = separator < 0 ? "" : remainder.slice(separator);
  if (portText === "") {
    return { kind: "invalid", reason: "a port is required" };
  }
  if (!/^[0-9]+$/.test(portText)) {
    return {
      kind: "invalid",
      reason: `"${portText}" is not a decimal port`,
    };
  }
  const port = Number(portText);
  if (!isForwardablePort(port)) {
    return {
      kind: "invalid",
      reason: `port ${portText} is outside ${PORT_PROXY_MIN_PORT}-${PORT_PROXY_MAX_PORT}`,
    };
  }
  const normalised = normalisePortProxyPath(rawRest);
  if (normalised.kind === "invalid") return normalised;
  return {
    kind: "route",
    route: {
      port,
      requestPath: path,
      upstreamPath: normalised.path,
      query,
    },
  };
}

/** Drop every `daemonToken` parameter, preserving the others and their order. */
export function stripProxyTokenQuery(rawQuery: string): string {
  if (rawQuery === "") return "";
  return rawQuery
    .split("&")
    .filter((pair) => {
      const separator = pair.indexOf("=");
      const rawKey = separator < 0 ? pair : pair.slice(0, separator);
      let key: string;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        return true;
      }
      return key !== PORT_PROXY_TOKEN_QUERY;
    })
    .join("&");
}

/** The token from the query string, if any. */
export function readQueryToken(rawQuery: string): string | undefined {
  if (rawQuery === "") return undefined;
  for (const pair of rawQuery.split("&")) {
    const separator = pair.indexOf("=");
    const rawKey = separator < 0 ? pair : pair.slice(0, separator);
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      continue;
    }
    if (key !== PORT_PROXY_TOKEN_QUERY) continue;
    if (separator < 0) return "";
    try {
      return decodeURIComponent(pair.slice(separator + 1));
    } catch {
      return "";
    }
  }
  return undefined;
}

/** The token from a `Cookie` header, if any. */
export function readCookieToken(
  header: string | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== PORT_PROXY_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value.length === 0 ? undefined : value;
  }
  return undefined;
}

export type PortProxyAuthDecision =
  | { readonly kind: "cookie" }
  | { readonly kind: "exchange" }
  | { readonly kind: "query" }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * The token/cookie state machine. A valid cookie authenticates and makes a
 * query token a refusal; without a valid cookie a valid query token is
 * exchanged by `GET`/`HEAD` (302) and reused in place by every other method
 * (proxied, with `Set-Cookie`). A cookie that does not match is discarded.
 */
export function decideProxyAuth(input: {
  readonly token: string;
  readonly queryToken: string | undefined;
  readonly cookieToken: string | undefined;
  readonly method: string;
}): PortProxyAuthDecision {
  const cookieValid = proxyTokensMatch(input.token, input.cookieToken);
  if (cookieValid) {
    if (input.queryToken !== undefined) {
      return {
        kind: "refuse",
        reason: "the daemon token is refused in the URL once the cookie is set",
      };
    }
    return { kind: "cookie" };
  }
  if (input.queryToken === undefined) {
    return {
      kind: "refuse",
      reason:
        input.cookieToken === undefined
          ? "a daemon token is required"
          : "the daemon cookie is not valid",
    };
  }
  if (!proxyTokensMatch(input.token, input.queryToken)) {
    return { kind: "refuse", reason: "the daemon token is not valid" };
  }
  return input.method === "GET" || input.method === "HEAD"
    ? { kind: "exchange" }
    : { kind: "query" };
}

/** `Set-Cookie` for the per-port exchange (B33). */
export function proxyCookieHeader(port: number, token: string): string {
  return [
    `${PORT_PROXY_COOKIE}=${token}`,
    `Path=${PORT_PROXY_PREFIX}/${port}`,
    "HttpOnly",
    "SameSite=Strict",
  ].join("; ");
}

/**
 * Whether a `Host` header names this loopback daemon. A browser tricked by
 * DNS rebinding reaches `127.0.0.1` with the attacker's host name; the token
 * still gates the request, but the mismatch is refused outright (B33).
 */
export function isProxyHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return false;
    const hostname = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest !== "" && !/^:[0-9]+$/.test(rest)) return false;
    return hostname === "::1";
  }
  const separator = value.lastIndexOf(":");
  if (separator >= 0 && !/^[0-9]+$/.test(value.slice(separator + 1))) {
    return false;
  }
  const hostname = separator < 0 ? value : value.slice(0, separator);
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/**
 * Whether a peer address is local. `undefined` is a Unix socket, which is
 * local by construction.
 */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return true;
  if (address === "::1") return true;
  if (isIPv4(address)) return address.startsWith("127.");
  if (isIPv6(address)) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped === null) return false;
    const ipv4 = mapped[1] ?? "";
    return isIPv4(ipv4) && ipv4.startsWith("127.");
  }
  return false;
}

/** Everything the HTTP handler and the upgrade handler share. */
export interface PortProxyOptions {
  readonly token: string;
  readonly registry: PortProxyRegistry;
  readonly rateLimiter: PortProxyRateLimiter;
  /** Defaults to {@link PORT_PROXY_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
}

/** Build the runtime options, with one limiter shared by both transports. */
export function createPortProxyOptions(input: {
  readonly token: string;
  readonly registry: PortProxyRegistry;
  readonly limit?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly maxBodyBytes?: number;
}): PortProxyOptions {
  return {
    token: input.token,
    registry: input.registry,
    rateLimiter: new PortProxyRateLimiter(
      input.limit ?? PORT_PROXY_RATE_LIMIT,
      input.windowMs ?? PORT_PROXY_RATE_WINDOW_MS,
      input.now ?? Date.now,
    ),
    ...(input.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: input.maxBodyBytes }),
  };
}

/** What a JSON-RPC method needs from the registry (B33). */
export function readPortForwardPort(params: unknown): number {
  const value =
    typeof params === "object" && params !== null && "port" in params
      ? params.port
      : undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DaemonProtocolError(
      JSON_RPC_ERRORS.invalidParams,
      "port must be an integer",
    );
  }
  if (!isForwardablePort(value)) {
    throw new DaemonProtocolError(
      JSON_RPC_ERRORS.invalidParams,
      `port must be between ${PORT_PROXY_MIN_PORT} and ${PORT_PROXY_MAX_PORT}`,
    );
  }
  return value;
}

function sendText(
  response: ServerResponse,
  status: number,
  reason: string,
  headers: OutgoingHttpHeaders = {},
): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  const body = Buffer.from(reason, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function sendRedirect(
  response: ServerResponse,
  route: PortProxyRoute,
  token: string,
): void {
  const query = stripProxyTokenQuery(route.query);
  response.writeHead(302, {
    location:
      query === "" ? route.requestPath : `${route.requestPath}?${query}`,
    "set-cookie": proxyCookieHeader(route.port, token),
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

type BodyResult = Buffer | "too-large" | "aborted";

/** Read the whole body, refusing past `limit` without waiting for the rest. */
function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<BodyResult> {
  const { promise, resolve } = Promise.withResolvers<BodyResult>();
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) {
      request.resume();
      resolve("too-large");
      return promise;
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  const settle = (result: BodyResult): void => {
    if (settled) return;
    settled = true;
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("error", onError);
    request.off("aborted", onAborted);
    resolve(result);
  };
  const onData = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > limit) {
      request.resume();
      settle("too-large");
      return;
    }
    chunks.push(buffer);
  };
  const onEnd = (): void => settle(Buffer.concat(chunks));
  const onError = (): void => settle("aborted");
  const onAborted = (): void => settle("aborted");
  request.on("data", onData);
  request.on("end", onEnd);
  request.on("error", onError);
  request.on("aborted", onAborted);
  return promise;
}

/** The `Cookie` header without this surface's own token. */
export function stripProxyCookie(
  header: string | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter(
      (part) => part.length > 0 && !part.startsWith(`${PORT_PROXY_COOKIE}=`),
    );
  return kept.length === 0 ? undefined : kept.join("; ");
}

function forwardRequestHeaders(
  headers: IncomingHttpHeaders,
  port: number,
  contentLength: number,
): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS[lower] === true ||
      lower === "host" ||
      lower === "content-length"
    ) {
      continue;
    }
    if (lower === "cookie") {
      const stripped = stripProxyCookie(
        Array.isArray(value) ? value.join("; ") : value,
      );
      if (stripped !== undefined) outgoing[name] = stripped;
      continue;
    }
    outgoing[name] = value;
  }
  outgoing.host = `${PORT_PROXY_UPSTREAM_HOST}:${port}`;
  outgoing["content-length"] = String(contentLength);
  return outgoing;
}

function forwardResponseHeaders(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS[name.toLowerCase()] === true) continue;
    if (name.toLowerCase() === "set-cookie") {
      // A local upstream must not clobber the proxy's own auth cookie.
      const kept = (Array.isArray(value) ? value : [value]).filter(
        (entry) =>
          !entry.trimStart().toLowerCase().startsWith(`${PORT_PROXY_COOKIE}=`),
      );
      if (kept.length > 0) outgoing[name] = kept;
      continue;
    }
    outgoing[name] = value;
  }
  return outgoing;
}

function upstreamTarget(route: PortProxyRoute): string {
  const query = stripProxyTokenQuery(route.query);
  return query === "" ? route.upstreamPath : `${route.upstreamPath}?${query}`;
}

function appendSetCookie(headers: OutgoingHttpHeaders, cookie: string): void {
  const existing = headers["set-cookie"];
  const list =
    existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing
        : [String(existing)];
  headers["set-cookie"] = [...list, cookie];
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : "unknown";
  }
  return "unknown";
}

/** Proxy one validated HTTP request once its body has been read. */
async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: PortProxyOptions,
  route: PortProxyRoute,
  cookie: string | undefined,
): Promise<void> {
  const body = await readBody(
    request,
    options.maxBodyBytes ?? PORT_PROXY_MAX_BODY_BYTES,
  );
  if (body === "aborted") return;
  if (body === "too-large") {
    sendText(
      response,
      413,
      `port proxy: the request body exceeds the ${options.maxBodyBytes ?? PORT_PROXY_MAX_BODY_BYTES}-byte limit`,
    );
    return;
  }
  const upstream = httpRequest(
    {
      host: PORT_PROXY_UPSTREAM_HOST,
      port: route.port,
      method: request.method ?? "GET",
      path: upstreamTarget(route),
      headers: forwardRequestHeaders(
        request.headers,
        route.port,
        body.byteLength,
      ),
    },
    (upstreamResponse) => {
      const headers = forwardResponseHeaders(upstreamResponse.headers);
      if (cookie !== undefined) appendSetCookie(headers, cookie);
      try {
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      } catch {
        upstreamResponse.destroy();
        sendText(
          response,
          502,
          "port proxy: the upstream sent a response this proxy cannot forward",
        );
        return;
      }
      upstreamResponse.pipe(response);
      upstreamResponse.on("error", () => response.destroy());
    },
  );
  response.on("error", () => upstream.destroy());
  upstream.on("error", (error: unknown) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendText(
      response,
      502,
      `port proxy: ${PORT_PROXY_UPSTREAM_HOST}:${route.port} could not be reached (${errorCodeOf(error)})`,
    );
  });
  response.on("close", () => upstream.destroy());
  upstream.end(body);
}

/**
 * Answer one request under `/port-proxy`. The caller has already established
 * that the target belongs to this surface.
 */
export function handlePortProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: PortProxyOptions | undefined,
): void {
  if (options === undefined) {
    request.resume();
    sendText(response, 404, PORT_PROXY_DISABLED_REASON);
    return;
  }
  if (!isLoopbackPeer(request.socket.remoteAddress)) {
    request.resume();
    sendText(response, 403, "port proxy: requests are served on loopback only");
    return;
  }
  if (!isProxyHost(request.headers.host)) {
    request.resume();
    sendText(
      response,
      421,
      "port proxy: the Host header must name this loopback daemon",
    );
    return;
  }
  if (!options.rateLimiter.take(request.socket.remoteAddress ?? "local")) {
    request.resume();
    sendText(response, 429, "port proxy: too many requests from this peer");
    return;
  }
  const parsed = parsePortProxyUrl(request.url);
  if (parsed === null) {
    request.resume();
    sendText(response, 404, "Not Found");
    return;
  }
  if (parsed.kind === "invalid") {
    request.resume();
    sendText(response, 400, `port proxy: ${parsed.reason}`);
    return;
  }
  const { route } = parsed;
  const method = request.method ?? "GET";
  const auth = decideProxyAuth({
    token: options.token,
    queryToken: readQueryToken(route.query),
    cookieToken: readCookieToken(request.headers.cookie),
    method,
  });
  if (auth.kind === "refuse") {
    request.resume();
    sendText(response, 401, `port proxy: ${auth.reason}`);
    return;
  }
  if (!options.registry.has(route.port)) {
    request.resume();
    sendText(
      response,
      403,
      `port proxy: port ${route.port} is not registered as forwardable`,
    );
    return;
  }
  if (!PORT_PROXY_METHODS.includes(method)) {
    request.resume();
    sendText(response, 405, `port proxy: method ${method} is not allowed`, {
      allow: PORT_PROXY_METHODS.join(", "),
    });
    return;
  }
  if (auth.kind === "exchange") {
    request.resume();
    sendRedirect(response, route, options.token);
    return;
  }
  void proxyRequest(
    request,
    response,
    options,
    route,
    auth.kind === "query"
      ? proxyCookieHeader(route.port, options.token)
      : undefined,
  );
}

/** Upgrades this module answered, so the daemon's own handler skips them. */
const handledUpgrades = new WeakSet<IncomingMessage>();

/** Whether an upgrade request was consumed by the proxy surface. */
export function isPortProxyUpgrade(request: IncomingMessage): boolean {
  return handledUpgrades.has(request);
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(reason, "utf8");
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${body.byteLength}`,
    "Cache-Control: no-store",
    "Connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), body]));
}

/** The raw request head sent to the upstream after the local 101. */
function upgradeRequestHead(
  request: IncomingMessage,
  route: PortProxyRoute,
): string {
  const lines = [
    `GET ${upstreamTarget(route)} HTTP/1.1`,
    `Host: ${PORT_PROXY_UPSTREAM_HOST}:${route.port}`,
  ];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === "host") continue;
    if (lower === "cookie") {
      const stripped = stripProxyCookie(
        Array.isArray(value) ? value.join("; ") : value,
      );
      if (stripped !== undefined) lines.push(`Cookie: ${stripped}`);
      continue;
    }
    for (const entry of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${entry}`);
    }
  }
  lines.push("", "");
  return lines.join("\r\n");
}

function handleProxyUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: PortProxyOptions | undefined,
): void {
  if (options === undefined) {
    rejectUpgrade(socket, 404, PORT_PROXY_DISABLED_REASON);
    return;
  }
  if (!isLoopbackPeer(request.socket.remoteAddress)) {
    rejectUpgrade(
      socket,
      403,
      "port proxy: requests are served on loopback only",
    );
    return;
  }
  if (!isProxyHost(request.headers.host)) {
    rejectUpgrade(
      socket,
      421,
      "port proxy: the Host header must name this loopback daemon",
    );
    return;
  }
  if (!options.rateLimiter.take(request.socket.remoteAddress ?? "local")) {
    rejectUpgrade(socket, 429, "port proxy: too many requests from this peer");
    return;
  }
  const parsed = parsePortProxyUrl(request.url);
  if (parsed === null || parsed.kind === "invalid") {
    rejectUpgrade(
      socket,
      400,
      `port proxy: ${parsed?.kind === "invalid" ? parsed.reason : "the upgrade target is not a port proxy path"}`,
    );
    return;
  }
  const { route } = parsed;
  const auth = decideProxyAuth({
    token: options.token,
    queryToken: readQueryToken(route.query),
    cookieToken: readCookieToken(request.headers.cookie),
    method: "GET",
  });
  if (auth.kind === "refuse") {
    rejectUpgrade(socket, 401, `port proxy: ${auth.reason}`);
    return;
  }
  if (!options.registry.has(route.port)) {
    rejectUpgrade(
      socket,
      403,
      `port proxy: port ${route.port} is not registered as forwardable`,
    );
    return;
  }
  const key = request.headers["sec-websocket-key"];
  const upgrade = request.headers.upgrade;
  const version = request.headers["sec-websocket-version"];
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    typeof upgrade !== "string" ||
    upgrade.toLowerCase() !== "websocket" ||
    version !== "13"
  ) {
    rejectUpgrade(
      socket,
      400,
      "port proxy: the upgrade is not a valid WebSocket handshake",
    );
    return;
  }
  const cookie =
    auth.kind === "cookie"
      ? undefined
      : proxyCookieHeader(route.port, options.token);
  const upstream = connectTcp({
    host: PORT_PROXY_UPSTREAM_HOST,
    port: route.port,
  });
  let upstreamHead: Buffer = Buffer.alloc(0);
  let handshakeForwarded = false;
  const abort = (): void => {
    upstream.destroy();
    if (!socket.destroyed) socket.destroy();
  };
  upstream.on("error", (error: unknown) => {
    upstream.destroy();
    if (!socket.destroyed) {
      rejectUpgrade(
        socket,
        502,
        `port proxy: ${PORT_PROXY_UPSTREAM_HOST}:${route.port} could not be reached (${errorCodeOf(error)})`,
      );
    }
  });
  socket.on("error", abort);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  upstream.on("data", (chunk: Buffer) => {
    if (handshakeForwarded) {
      socket.write(chunk);
      return;
    }
    upstreamHead = Buffer.concat([upstreamHead, chunk]);
    const end = upstreamHead.indexOf("\r\n\r\n");
    if (end < 0) {
      if (upstreamHead.byteLength > 64 * 1024) abort();
      return;
    }
    handshakeForwarded = true;
    const headText = upstreamHead.subarray(0, end).toString("utf8");
    const rest = upstreamHead.subarray(end + 4);
    const withCookie =
      cookie !== undefined && /^HTTP\/1\.1 101\b/.test(headText)
        ? `${headText}\r\nSet-Cookie: ${cookie}`
        : headText;
    socket.write(`${withCookie}\r\n\r\n`);
    if (rest.byteLength > 0) socket.write(rest);
  });
  upstream.on("connect", () => {
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    upstream.write(upgradeRequestHead(request, route));
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
  });
}

/**
 * Mount the upgrade half of the surface. Register this before
 * {@link attachWebSocketServer}; requests under the prefix are then skipped
 * by the daemon's own handshake.
 */
export function attachPortProxyUpgrade(
  server: Server,
  options: { readonly portProxy?: PortProxyOptions },
): void {
  server.on("upgrade", (request, socket, head) => {
    if (!isPortProxyUrl(request.url)) return;
    handledUpgrades.add(request);
    handleProxyUpgrade(request, socket, head, options.portProxy);
  });
}
