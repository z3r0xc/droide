/**
 * PKCE and authorization-URL construction.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B26–B28 and
 * `docs/adr/0008-oauth-credential-envelope.md`. Pure: randomness and the clock
 * are injected, so a test can reproduce a vector exactly.
 *
 * Everything here is deliberately small and boring: a verifier with enough
 * entropy (`43..128` characters, RFC 7636 §4.1), an S256 challenge, an opaque
 * `state`, and a URL builder that refuses to put a fragment or credentials in
 * the redirect.
 */
import { createHash, randomBytes } from "node:crypto";

/** Byte source; tests pass a deterministic one. */
export type RandomSource = (bytes: number) => Uint8Array;

const DEFAULT_RANDOM: RandomSource = (bytes) => randomBytes(bytes);

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export interface PkcePair {
  /** Sent in the token request. Never log it. */
  readonly verifier: string;
  /** Sent in the authorization request. */
  readonly challenge: string;
}

/**
 * A verifier of `length` characters drawn from 32 random bytes: 43 characters of
 * base64url carry 258 bits, which is the RFC's recommended floor and well above
 * what a token endpoint accepts as "sufficient".
 */
export function createPkcePair(
  random: RandomSource = DEFAULT_RANDOM,
): PkcePair {
  const verifier = base64url(random(32));
  const challenge = base64url(
    createHash("sha256").update(verifier, "ascii").digest(),
  );
  return { verifier, challenge };
}

/** The S256 challenge for a known verifier (exposed for the flow and for tests). */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** An opaque `state` value; 24 bytes is more than enough to defeat guessing. */
export function createState(random: RandomSource = DEFAULT_RANDOM): string {
  return base64url(random(24));
}

export interface AuthorizationRequest {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  /** RFC 8707 resource indicator; omitted when the server did not configure one. */
  readonly resource?: string;
  readonly scopes?: readonly string[];
}

export class AuthorizationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationUrlError";
  }
}

/**
 * Build the authorization URL.
 *
 * The redirect must be a loopback HTTP URL: a `file:` or remote callback would
 * hand the code to whoever owns that origin, and a fragment is invalid in a
 * redirect URI by definition.
 */
export function buildAuthorizationUrl(request: AuthorizationRequest): URL {
  const endpoint = new URL(request.authorizationEndpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new AuthorizationUrlError(
      `authorization endpoint must be http(s), got ${endpoint.protocol}`,
    );
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new AuthorizationUrlError(
      "authorization endpoint must not carry credentials",
    );
  }

  const redirect = new URL(request.redirectUri);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (redirect.protocol !== "http:" || !loopbackHosts.has(redirect.hostname)) {
    throw new AuthorizationUrlError("redirect URI must be a loopback http URL");
  }
  if (redirect.hash.length > 0) {
    throw new AuthorizationUrlError("redirect URI must not carry a fragment");
  }

  endpoint.searchParams.set("response_type", "code");
  endpoint.searchParams.set("client_id", request.clientId);
  endpoint.searchParams.set("redirect_uri", request.redirectUri);
  endpoint.searchParams.set("code_challenge", request.challenge);
  endpoint.searchParams.set("code_challenge_method", "S256");
  endpoint.searchParams.set("state", request.state);
  if (request.resource !== undefined)
    endpoint.searchParams.set("resource", request.resource);
  if (request.scopes !== undefined && request.scopes.length > 0) {
    endpoint.searchParams.set("scope", request.scopes.join(" "));
  }
  return endpoint;
}

/** How long a user has to finish the browser step (§B28). */
export const AUTHORIZATION_WINDOW_MS = 4 * 60 * 1000;

/** First loopback port the callback server tries, and how many it tries (§B27). */
export const CALLBACK_PORT_START = 54_621;
export const CALLBACK_PORT_ATTEMPTS = 100;
