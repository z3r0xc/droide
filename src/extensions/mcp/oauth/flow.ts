/**
 * The interactive MCP OAuth flow.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B26–B29 and
 * `docs/adr/0008-oauth-credential-envelope.md`. One call takes a remote server
 * that needs authentication from "no credential" to a sealed credential:
 *
 *   discover the issuer → bind the loopback callback → pick (or register) a
 *   client → send the user to the authorization endpoint → exchange the code →
 *   `putCredential` with the issuer and the client metadata.
 *
 * Everything that touches the world is injected — `fetch`, `openBrowser`, the
 * clock, randomness, the signal and the status writer — so the dance is
 * reproducible in a test against a loopback authorization server. Refusals come
 * first and are typed: a misconfigured entry is a `McpOAuthError`, never a
 * half-finished browser trip.
 */
import { isRecord } from "../../guards.ts";
import type {
  McpOAuthOptions,
  McpRemoteServerConfig,
  McpServerConfig,
} from "../config.ts";
import { waitForAuthorizationCode } from "./callback.ts";
import {
  AUTHORIZATION_WINDOW_MS,
  CALLBACK_PORT_ATTEMPTS,
  CALLBACK_PORT_START,
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  type RandomSource,
} from "./pkce.ts";
import {
  putCredential,
  readCredentials,
  type CredentialSealer,
  type CredentialStoreOptions,
  type StoredCredential,
} from "./store.ts";
import { OAuthTokenError, exchangeAuthorizationCode } from "./token.ts";

/** Largest metadata or registration document this flow will read. */
const MAX_METADATA_BYTES = 64 * 1024;

/** One metadata or registration request budget. */
const METADATA_TIMEOUT_MS = 10_000;

/** Loopback hosts as WHATWG `URL` spells them (IPv6 keeps its brackets). */
const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
  "[::1]": true,
};

export type McpOAuthErrorCode =
  | "not-remote"
  | "oauth-disabled"
  | "server-disabled"
  | "policy-blocked"
  | "client-metadata-conflict"
  | "missing-issuer"
  | "unsupported-config"
  | "non-loopback-redirect"
  | "discovery"
  | "registration"
  | "authorization"
  | "token";

/** A refusal or failure of one server's flow; `code` is switchable. */
export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;
  readonly serverName: string;

  constructor(code: McpOAuthErrorCode, serverName: string, detail: string) {
    super(`MCP server "${serverName}" cannot be authenticated: ${detail}`);
    this.name = "McpOAuthError";
    this.code = code;
    this.serverName = serverName;
  }
}

/** The identity and policy verdict of the server being authenticated. */
export interface AuthorizeServerTarget {
  /** Canonical name: the credential store key (§B5, §B29). */
  readonly name: string;
  /** Org-policy verdict from the config loader (§B7); `false` refuses. */
  readonly allowedByPolicy: boolean;
}

/** The loopback callback run (§B27); defaults are the documented ports. */
export interface CallbackRunOptions {
  readonly host?: "127.0.0.1" | "localhost";
  /** `0` asks the OS for an ephemeral port (tests). */
  readonly portStart?: number;
  readonly attempts?: number;
  /** The authorization window (§B28); defaults to four minutes. */
  readonly timeoutMs?: number;
}

export interface AuthorizeServerInput {
  readonly server: AuthorizeServerTarget;
  readonly config: McpServerConfig;
  /** Where the sealed store lives; the sealer arrives separately. */
  readonly store: { readonly stateDir: string };
  readonly sealer: CredentialSealer;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly fetch: typeof fetch;
  /** Epoch-millisecond source; also stamps the credential (§B29). */
  readonly clock: () => number;
  readonly signal?: AbortSignal;
  /** Progress text for the user; never a token or a verifier. */
  readonly onStatus?: (message: string) => void;
  readonly random?: RandomSource;
  readonly callback?: CallbackRunOptions;
}

/** The authorization-server metadata this flow needs (RFC 8414 §2). */
export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
}

interface ResolvedClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly metadataUrl?: string;
}

interface HttpRequestContext {
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function status(
  input: { readonly onStatus?: (message: string) => void },
  message: string,
): void {
  input.onStatus?.(message);
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Whether a redirect URI is a bare loopback HTTP URL (no credentials). */
export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return LOOPBACK_HOSTS[url.hostname] === true;
}

/**
 * The redirect set a registration may cover (§B27): every port of the
 * documented run, or just the bound URI when the OS picked the port.
 */
export function registrationRedirectUris(
  redirectUri: string,
  portStart: number,
  attempts: number,
): readonly string[] {
  if (portStart === 0) return [redirectUri];
  const url = new URL(redirectUri);
  const uris: string[] = [];
  for (let offset = 0; offset < attempts; offset += 1) {
    uris.push(
      `${url.protocol}//${url.hostname}:${portStart + offset}${url.pathname}`,
    );
  }
  return uris;
}

/** Insert the well-known segment between the host and the path (RFC 8414 §3.1). */
function wellKnownUrl(base: string, document: string): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  return new URL(`/.well-known/${document}${path}`, url.origin).toString();
}

function requireHttpUrl(value: string, detail: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${detail} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${detail} must be http(s), got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${detail} must not carry credentials`);
  }
  return url;
}

function secureEndpoint(
  value: unknown,
  field: string,
  serverName: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpOAuthError(
      "discovery",
      serverName,
      `the authorization-server metadata has no "${field}"`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError("discovery", serverName, `"${field}" is not a URL`);
  }
  const loopbackHttp =
    url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true;
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new McpOAuthError(
      "discovery",
      serverName,
      `"${field}" must be https (http is allowed only on loopback)`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new McpOAuthError(
      "discovery",
      serverName,
      `"${field}" must not carry credentials`,
    );
  }
  return url.toString();
}

function parseMetadata(
  payload: unknown,
  requestedIssuer: string,
  serverName: string,
): AuthorizationServerMetadata {
  if (!isRecord(payload)) {
    throw new McpOAuthError(
      "discovery",
      serverName,
      "the authorization-server metadata is not an object",
    );
  }
  const issuer = payload["issuer"];
  if (typeof issuer !== "string" || issuer.trim() === "") {
    throw new McpOAuthError(
      "discovery",
      serverName,
      'the authorization-server metadata has no "issuer"',
    );
  }
  if (normalizeIssuer(issuer) !== normalizeIssuer(requestedIssuer)) {
    throw new McpOAuthError(
      "discovery",
      serverName,
      `the authorization server identifies itself as "${issuer}", not "${requestedIssuer}"`,
    );
  }
  const registrationEndpoint = payload["registration_endpoint"];
  return {
    issuer: normalizeIssuer(issuer),
    authorizationEndpoint: secureEndpoint(
      payload["authorization_endpoint"],
      "authorization_endpoint",
      serverName,
    ),
    tokenEndpoint: secureEndpoint(
      payload["token_endpoint"],
      "token_endpoint",
      serverName,
    ),
    ...(registrationEndpoint === undefined
      ? {}
      : {
          registrationEndpoint: secureEndpoint(
            registrationEndpoint,
            "registration_endpoint",
            serverName,
          ),
        }),
  };
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_METADATA_BYTES) {
      await reader.cancel();
      throw new Error(`the response exceeds ${MAX_METADATA_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

interface JsonResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly payload: unknown;
}

/**
 * One bounded JSON request. Redirects are refused: metadata and registration
 * live at the URL the document named, and following one elsewhere would let a
 * hostile server move the token exchange to a plaintext origin.
 */
async function requestJson(
  url: string,
  request: HttpRequestContext,
  init: {
    readonly method: "GET" | "POST";
    readonly body?: string;
    readonly contentType?: string;
  },
): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.contentType !== undefined) {
    headers["content-type"] = init.contentType;
  }

  let response: Response;
  try {
    response = await request.fetch(url, {
      method: init.method,
      headers,
      redirect: "error",
      signal,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  } catch (error) {
    throw new Error(`the request to ${url} failed: ${messageOf(error)}`);
  }

  const text = await readBoundedText(response);
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${url} did not answer JSON`);
    }
  }
  return { status: response.status, ok: response.ok, payload };
}

async function fetchMetadataDocument(
  url: string,
  request: HttpRequestContext,
): Promise<unknown> {
  const response = await requestJson(url, request, { method: "GET" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.payload;
}

/**
 * Resolve the issuer: the configured one, else the MCP server's protected
 * resource metadata (RFC 9728).
 */
async function resolveIssuer(input: {
  readonly configured: string | undefined;
  readonly resourceUrl: string;
  readonly serverName: string;
  readonly request: HttpRequestContext;
}): Promise<string> {
  if (input.configured !== undefined) {
    requireHttpUrl(input.configured, "the issuer");
    return normalizeIssuer(input.configured);
  }

  const origin = new URL(input.resourceUrl).origin;
  const candidates = [
    wellKnownUrl(input.resourceUrl, "oauth-protected-resource"),
    wellKnownUrl(origin, "oauth-protected-resource"),
  ];
  for (const url of candidates) {
    try {
      const payload = await fetchMetadataDocument(url, input.request);
      const servers = isRecord(payload)
        ? payload["authorization_servers"]
        : undefined;
      const first = Array.isArray(servers) ? servers[0] : undefined;
      if (typeof first === "string" && first.trim() !== "") {
        return normalizeIssuer(first);
      }
    } catch {
      // A server without protected-resource metadata is normal; try the next
      // documented location and then the origin fallback.
    }
  }

  // TODO(spec B26): B26 says the issuer comes from
  // `authorizationServerIssuer` "or the server URL's well-known document" but
  // does not pin which document, nor what happens when the server publishes
  // none. This build falls back to the resource origin.
  return normalizeIssuer(origin);
}

async function fetchAuthorizationServerMetadata(input: {
  readonly issuer: string;
  readonly serverName: string;
  readonly request: HttpRequestContext;
}): Promise<AuthorizationServerMetadata> {
  const candidates = [
    wellKnownUrl(input.issuer, "oauth-authorization-server"),
    wellKnownUrl(input.issuer, "openid-configuration"),
  ];
  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const payload = await fetchMetadataDocument(url, input.request);
      return parseMetadata(payload, input.issuer, input.serverName);
    } catch (error) {
      failures.push(messageOf(error));
    }
  }
  throw new McpOAuthError(
    "discovery",
    input.serverName,
    `no usable authorization-server metadata at ${input.issuer} (${failures.join("; ")})`,
  );
}

/** Dynamic client registration (RFC 7591). */
async function registerClient(input: {
  readonly serverName: string;
  readonly endpoint: string;
  readonly redirectUris: readonly string[];
  readonly request: HttpRequestContext;
}): Promise<ResolvedClient> {
  // TODO(spec B26): B26 pins the published client metadata (B27) and the
  // redirect coverage, but not the registration body's `client_name`, grant
  // types or auth method for a dynamic client. This build registers a public
  // client with the loopback redirect set.
  const body = JSON.stringify({
    client_name: "droide",
    redirect_uris: [...input.redirectUris],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const response = await requestJson(input.endpoint, input.request, {
    method: "POST",
    body,
    contentType: "application/json",
  });
  if (!response.ok) {
    throw new McpOAuthError(
      "registration",
      input.serverName,
      `dynamic client registration was refused (status ${response.status})`,
    );
  }
  const payload = response.payload;
  const clientId = isRecord(payload) ? payload["client_id"] : undefined;
  if (typeof clientId !== "string" || clientId === "") {
    throw new McpOAuthError(
      "registration",
      input.serverName,
      "the registration response has no client_id",
    );
  }
  if (
    isRecord(payload) &&
    typeof payload["client_secret"] === "string" &&
    payload["client_secret"] !== ""
  ) {
    throw new McpOAuthError(
      "registration",
      input.serverName,
      "the registration response carries a client_secret, which this build cannot store; register a public client",
    );
  }
  return { clientId };
}

/**
 * Pick the client identity: the configured one, the metadata document, the one
 * a previous run registered, or a fresh dynamic registration.
 */
async function resolveClient(input: {
  readonly serverName: string;
  readonly options: McpOAuthOptions;
  readonly metadata: AuthorizationServerMetadata;
  readonly redirectUris: readonly string[];
  readonly stored: StoredCredential | undefined;
  readonly request: HttpRequestContext;
}): Promise<ResolvedClient> {
  const options = input.options;

  if (options.clientMetadataUrl !== undefined) {
    return {
      clientId: options.clientMetadataUrl,
      metadataUrl: options.clientMetadataUrl,
    };
  }
  if (options.clientId !== undefined) {
    return {
      clientId: options.clientId,
      ...(options.clientSecret === undefined
        ? {}
        : { clientSecret: options.clientSecret }),
    };
  }

  const stored = input.stored;
  if (
    stored !== undefined &&
    stored.client.clientId !== "" &&
    normalizeIssuer(stored.issuer) === normalizeIssuer(input.metadata.issuer)
  ) {
    return {
      clientId: stored.client.clientId,
      ...(stored.client.metadataUrl === undefined
        ? {}
        : { metadataUrl: stored.client.metadataUrl }),
    };
  }

  if (input.metadata.registrationEndpoint === undefined) {
    throw new McpOAuthError(
      "registration",
      input.serverName,
      "the authorization server publishes no registration endpoint; set oauth.clientId",
    );
  }
  return registerClient({
    serverName: input.serverName,
    endpoint: input.metadata.registrationEndpoint,
    redirectUris: input.redirectUris,
    request: input.request,
  });
}

/** Validate the entry's OAuth options and return the object form (§B26). */
function validatedOAuthOptions(
  config: McpRemoteServerConfig,
  serverName: string,
): McpOAuthOptions {
  if (config.disabled) {
    throw new McpOAuthError(
      "server-disabled",
      serverName,
      "the server is disabled in its mcp.json entry",
    );
  }
  const oauth = config.oauth;
  if (oauth === false) {
    throw new McpOAuthError(
      "oauth-disabled",
      serverName,
      "oauth is false, so this server never authenticates",
    );
  }
  const options: McpOAuthOptions = oauth ?? {};
  const hasCredentials =
    options.clientId !== undefined || options.clientSecret !== undefined;

  if (options.clientMetadataUrl !== undefined && hasCredentials) {
    throw new McpOAuthError(
      "client-metadata-conflict",
      serverName,
      "clientMetadataUrl cannot be combined with configured client credentials",
    );
  }
  if (
    options.clientMetadataUrl !== undefined &&
    options.tokenEndpointAuthMethod !== undefined &&
    options.tokenEndpointAuthMethod !== "none"
  ) {
    throw new McpOAuthError(
      "client-metadata-conflict",
      serverName,
      'clientMetadataUrl requires public token-endpoint auth ("none")',
    );
  }
  if (hasCredentials && options.authorizationServerIssuer === undefined) {
    throw new McpOAuthError(
      "missing-issuer",
      serverName,
      "configured client credentials require oauth.authorizationServerIssuer",
    );
  }

  const method = options.tokenEndpointAuthMethod;
  if (
    method !== undefined &&
    method !== "none" &&
    method !== "client_secret_basic"
  ) {
    // TODO(spec B26): B26 lists `tokenEndpointAuthMethod` without pinning the
    // accepted values; only public auth and client_secret_basic are implemented
    // (client_secret_post needs a form body this token client does not send).
    throw new McpOAuthError(
      "unsupported-config",
      serverName,
      `tokenEndpointAuthMethod "${method}" is not supported; use "none" or "client_secret_basic"`,
    );
  }
  return options;
}

/**
 * Run the whole dance for one server and store the credential.
 *
 * Resolves with the stored credential (issuer, client metadata, tokens,
 * `revision`, `updatedAt`). Refuses — without opening a browser — when the
 * entry is `oauth: false`, misconfigured, disabled or blocked by policy.
 */
export async function authorizeServer(
  input: AuthorizeServerInput,
): Promise<StoredCredential> {
  const { server, config } = input;
  const serverName = server.name;

  if (config.type === "stdio") {
    throw new McpOAuthError(
      "not-remote",
      serverName,
      "only http and sse servers authenticate with OAuth",
    );
  }
  if (!server.allowedByPolicy) {
    throw new McpOAuthError(
      "policy-blocked",
      serverName,
      "the org MCP policy does not allow this server",
    );
  }
  const options = validatedOAuthOptions(config, serverName);

  let resourceUrl: URL;
  try {
    resourceUrl = requireHttpUrl(config.url, "the server URL");
  } catch (error) {
    throw new McpOAuthError("unsupported-config", serverName, messageOf(error));
  }

  const callbackRun: CallbackRunOptions = input.callback ?? {};
  const portStart = callbackRun.portStart ?? CALLBACK_PORT_START;
  const attempts = callbackRun.attempts ?? CALLBACK_PORT_ATTEMPTS;
  const timeoutMs = callbackRun.timeoutMs ?? AUTHORIZATION_WINDOW_MS;

  const storeOptions: CredentialStoreOptions = {
    stateDir: input.store.stateDir,
    sealer: input.sealer,
    now: input.clock,
  };
  const document = await readCredentials(storeOptions);

  const cancellation = new AbortController();
  const signal =
    input.signal === undefined
      ? cancellation.signal
      : AbortSignal.any([input.signal, cancellation.signal]);
  const request: HttpRequestContext = {
    fetch: input.fetch,
    signal,
    timeoutMs: METADATA_TIMEOUT_MS,
  };

  const pair = createPkcePair(input.random);
  const state = createState(input.random);
  const resource = options.resource ?? config.url;

  const redirect = Promise.withResolvers<string>();
  const watcher = waitForAuthorizationCode({
    expectedState: state,
    portStart,
    attempts,
    timeoutMs,
    signal,
    ...(callbackRun.host === undefined ? {} : { host: callbackRun.host }),
    onListening: (uri) => redirect.resolve(uri),
  });
  watcher.catch((error: unknown) => {
    redirect.reject(error);
  });

  try {
    status(input, `Waiting for the loopback redirect of "${serverName}"`);
    const redirectUri = await redirect.promise;
    if (!isLoopbackRedirect(redirectUri)) {
      throw new McpOAuthError(
        "non-loopback-redirect",
        serverName,
        `the callback bound ${redirectUri}, which is not a loopback http URL`,
      );
    }
    status(input, `Listening on ${redirectUri}`);

    status(input, `Resolving the authorization server for "${serverName}"`);
    const issuer = await resolveIssuer({
      configured: options.authorizationServerIssuer,
      resourceUrl: resourceUrl.toString(),
      serverName,
      request,
    });
    const metadata = await fetchAuthorizationServerMetadata({
      issuer,
      serverName,
      request,
    });

    const client = await resolveClient({
      serverName,
      options,
      metadata,
      redirectUris: registrationRedirectUris(redirectUri, portStart, attempts),
      stored: document.servers[serverName],
      request,
    });

    let authorizationUrl: URL;
    try {
      authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: metadata.authorizationEndpoint,
        clientId: client.clientId,
        redirectUri,
        challenge: pair.challenge,
        state,
        resource,
      });
    } catch (error) {
      throw new McpOAuthError("discovery", serverName, messageOf(error));
    }

    status(input, `Open this URL to authorize "${serverName}":`);
    status(input, authorizationUrl.toString());
    try {
      await input.openBrowser(authorizationUrl.toString());
    } catch (error) {
      throw new McpOAuthError(
        "authorization",
        serverName,
        `a browser could not be opened (${messageOf(error)}); open the URL above by hand`,
      );
    }

    status(input, `Waiting for the authorization of "${serverName}"`);
    const { code } = await watcher;

    status(input, `Exchanging the authorization code for "${serverName}"`);
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: metadata.tokenEndpoint,
      clientId: client.clientId,
      ...(client.clientSecret === undefined
        ? {}
        : { clientSecret: client.clientSecret }),
      code,
      verifier: pair.verifier,
      redirectUri,
      resource,
      fetch: input.fetch,
    });

    const expiresAt =
      tokens.expiresInSeconds === undefined
        ? undefined
        : input.clock() + tokens.expiresInSeconds * 1000;

    const stored = await putCredential(storeOptions, {
      credential: {
        serverName,
        serverUrl: config.url,
        issuer: metadata.issuer,
        client: {
          clientId: client.clientId,
          ...(client.metadataUrl === undefined
            ? {}
            : { metadataUrl: client.metadataUrl }),
        },
        tokens: {
          accessToken: tokens.accessToken,
          tokenType: tokens.tokenType,
          ...(tokens.refreshToken === undefined
            ? {}
            : { refreshToken: tokens.refreshToken }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
        },
      },
      expectedRevision: Math.max(
        document.servers[serverName]?.revision ?? 0,
        document.tombstones[serverName]?.revision ?? 0,
      ),
    });
    status(
      input,
      `Stored credentials for "${serverName}" (revision ${stored.revision})`,
    );
    return stored;
  } catch (error) {
    cancellation.abort();
    await watcher.catch(() => undefined);
    if (error instanceof McpOAuthError) throw error;
    if (error instanceof OAuthTokenError) {
      throw new McpOAuthError("token", serverName, error.message);
    }
    throw error;
  }
}
