import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTHORIZATION_WINDOW_MS,
  AuthorizationUrlError,
  CALLBACK_PORT_ATTEMPTS,
  CALLBACK_PORT_START,
  buildAuthorizationUrl,
  challengeFor,
  createPkcePair,
  createState,
} from "../../../src/extensions/mcp/oauth/pkce.ts";

/** Deterministic byte source: 0, 1, 2, … so a vector is reproducible. */
function counting(bytes: number): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, index) => index);
}

test("the S256 challenge matches RFC 7636 appendix B", () => {
  assert.equal(
    challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("a generated verifier is base64url and long enough", () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.challenge, challengeFor(pair.verifier));
});

test("two pairs differ", () => {
  assert.notEqual(createPkcePair().verifier, createPkcePair().verifier);
});

test("the pair is reproducible from an injected source", () => {
  const first = createPkcePair(counting);
  const second = createPkcePair(counting);
  assert.equal(first.verifier, second.verifier);
  assert.equal(first.challenge, second.challenge);
});

test("state is opaque, base64url and 32 characters", () => {
  const state = createState();
  assert.match(state, /^[A-Za-z0-9_-]{32}$/);
});

test("the authorization URL carries PKCE, state and the loopback redirect", () => {
  const url = buildAuthorizationUrl({
    authorizationEndpoint: "https://auth.example.test/authorize?tenant=a",
    clientId: "client-1",
    redirectUri: "http://127.0.0.1:54621/callback",
    challenge: "CHALLENGE",
    state: "STATE",
    resource: "https://mcp.example.test",
    scopes: ["read", "write"],
  });

  assert.equal(url.origin, "https://auth.example.test");
  assert.equal(url.searchParams.get("tenant"), "a");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:54621/callback",
  );
  assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "STATE");
  assert.equal(url.searchParams.get("resource"), "https://mcp.example.test");
  assert.equal(url.searchParams.get("scope"), "read write");
});

test("a missing resource or empty scopes add no parameters", () => {
  const url = buildAuthorizationUrl({
    authorizationEndpoint: "https://auth.example.test/authorize",
    clientId: "c",
    redirectUri: "http://localhost:1234/cb",
    challenge: "X",
    state: "S",
    scopes: [],
  });
  assert.equal(url.searchParams.has("resource"), false);
  assert.equal(url.searchParams.has("scope"), false);
});

test("a non-loopback or non-http redirect is refused", () => {
  const base = {
    authorizationEndpoint: "https://auth.example.test/authorize",
    clientId: "c",
    challenge: "X",
    state: "S",
  };
  assert.throws(
    () =>
      buildAuthorizationUrl({ ...base, redirectUri: "https://127.0.0.1/cb" }),
    AuthorizationUrlError,
  );
  assert.throws(
    () =>
      buildAuthorizationUrl({
        ...base,
        redirectUri: "http://auth.example.test/cb",
      }),
    AuthorizationUrlError,
  );
  assert.throws(
    () =>
      buildAuthorizationUrl({
        ...base,
        redirectUri: "http://127.0.0.1:1234/cb#x",
      }),
    AuthorizationUrlError,
  );
});

test("an endpoint with credentials or a bad scheme is refused", () => {
  const base = {
    clientId: "c",
    redirectUri: "http://127.0.0.1:1234/cb",
    challenge: "X",
    state: "S",
  };
  assert.throws(
    () =>
      buildAuthorizationUrl({
        ...base,
        authorizationEndpoint: "https://user:pass@auth.example.test/authorize",
      }),
    AuthorizationUrlError,
  );
  assert.throws(
    () =>
      buildAuthorizationUrl({
        ...base,
        authorizationEndpoint: "ftp://auth.example.test/authorize",
      }),
    AuthorizationUrlError,
  );
});

test("the timing constants come from the specification", () => {
  assert.equal(AUTHORIZATION_WINDOW_MS, 240_000);
  assert.equal(CALLBACK_PORT_START, 54_621);
  assert.equal(CALLBACK_PORT_ATTEMPTS, 100);
});
