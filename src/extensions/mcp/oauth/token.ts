/**
 * Token endpoint exchanges.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B26–B29 and
 * `docs/adr/0008-oauth-credential-envelope.md`. Pure over an injected `fetch`:
 * no storage here, and no token is ever logged or embedded in an error message.
 */
export interface TokenEndpointOptions {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** Present only for a confidential client; public clients omit it. */
  readonly clientSecret?: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface AuthorizationCodeExchange extends TokenEndpointOptions {
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly resource?: string;
}

export interface RefreshExchange extends TokenEndpointOptions {
  readonly refreshToken: string;
  readonly resource?: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresInSeconds?: number;
  /** Epoch milliseconds derived from the response and the injected clock. */
  readonly expiresAt?: number;
  readonly scope?: string;
  readonly tokenType: string;
}

export class OAuthTokenError extends Error {
  /** OAuth `error` code from the body when present (`invalid_grant`, …). */
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { readonly code?: string; readonly status?: number } = {},
  ) {
    super(message);
    this.name = "OAuthTokenError";
    this.code = options.code;
    this.status = options.status;
  }
}

export const MAX_TOKEN_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function requireEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthTokenError("token endpoint is not a URL");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new OAuthTokenError(
      "token endpoint must be https (http is allowed only on loopback)",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new OAuthTokenError("token endpoint must not carry credentials");
  }
  return url;
}

async function readBounded(response: Response, limit: number): Promise<string> {
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
    if (total > limit) {
      await reader.cancel();
      throw new OAuthTokenError(`token response exceeds ${limit} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseTokenSet(payload: unknown): TokenSet {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new OAuthTokenError("token response is not an object");
  }
  const record = payload as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthTokenError("token response has no access_token");
  }
  const tokenType =
    typeof record["token_type"] === "string" ? record["token_type"] : "Bearer";
  const refreshToken =
    typeof record["refresh_token"] === "string"
      ? record["refresh_token"]
      : undefined;
  const scope =
    typeof record["scope"] === "string" ? record["scope"] : undefined;
  const expiresIn =
    typeof record["expires_in"] === "number" &&
    Number.isFinite(record["expires_in"])
      ? record["expires_in"]
      : undefined;
  return {
    accessToken,
    tokenType,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(scope === undefined ? {} : { scope }),
    ...(expiresIn === undefined ? {} : { expiresInSeconds: expiresIn }),
  };
}

async function postForm(
  options: TokenEndpointOptions,
  form: URLSearchParams,
): Promise<TokenSet> {
  const endpoint = requireEndpoint(options.tokenEndpoint);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (options.clientSecret !== undefined) {
    // Confidential clients authenticate at the token endpoint; the spec's
    // `tokenEndpointAuthMethod` selects this shape.
    headers["authorization"] =
      `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`;
  } else {
    form.set("client_id", options.clientId);
  }

  let response: Response;
  try {
    response = await options.fetch(endpoint, {
      method: "POST",
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthTokenError(
      `token request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await readBounded(
    response,
    options.maxBytes ?? MAX_TOKEN_BODY_BYTES,
  );
  let payload: unknown;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new OAuthTokenError(
      `token response is not JSON (status ${response.status})`,
      { status: response.status },
    );
  }

  if (!response.ok) {
    const code =
      payload !== null &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : undefined;
    throw new OAuthTokenError(
      `token endpoint refused the request (status ${response.status}${code === undefined ? "" : `, ${code}`})`,
      {
        status: response.status,
        ...(code === undefined ? {} : { code }),
      },
    );
  }
  return parseTokenSet(payload);
}

/** Exchange an authorization code (PKCE). */
export async function exchangeAuthorizationCode(
  request: AuthorizationCodeExchange,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.verifier,
  });
  if (request.resource !== undefined) form.set("resource", request.resource);
  return postForm(request, form);
}

/** Refresh an access token. */
export async function refreshAccessToken(
  request: RefreshExchange,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
  });
  if (request.resource !== undefined) form.set("resource", request.resource);
  return postForm(request, form);
}
