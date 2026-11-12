import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TOKEN_BODY_BYTES,
  OAuthTokenError,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "../../../src/extensions/mcp/oauth/token.ts";

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

function fakeFetch(handler: (captured: Captured) => Response): {
  fetch: typeof fetch;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const entry: Captured = {
      url: input instanceof URL ? input.toString() : String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    captured.push(entry);
    return handler(entry);
  };
  return { fetch: fetchImpl as typeof fetch, captured };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = {
  tokenEndpoint: "https://auth.example.test/token",
  clientId: "client-1",
};

test("a public-client exchange sends the verifier and client id in the body", async () => {
  const { fetch, captured } = fakeFetch(() =>
    json({
      access_token: "at-1",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt-1",
      scope: "read",
    }),
  );

  const tokens = await exchangeAuthorizationCode({
    ...base,
    code: "CODE",
    verifier: "VERIFIER",
    redirectUri: "http://127.0.0.1:54621/callback",
    fetch,
  });

  assert.equal(tokens.accessToken, "at-1");
  assert.equal(tokens.refreshToken, "rt-1");
  assert.equal(tokens.expiresInSeconds, 3600);
  assert.equal(tokens.scope, "read");

  const form = new URLSearchParams(captured[0]?.body ?? "");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "CODE");
  assert.equal(form.get("code_verifier"), "VERIFIER");
  assert.equal(form.get("redirect_uri"), "http://127.0.0.1:54621/callback");
  assert.equal(form.get("client_id"), "client-1");
  assert.equal(captured[0]?.headers.get("authorization"), null);
});

test("a confidential client authenticates with basic auth and omits client_id", async () => {
  const { fetch, captured } = fakeFetch(() =>
    json({ access_token: "at-2", token_type: "Bearer" }),
  );

  await exchangeAuthorizationCode({
    ...base,
    clientSecret: "shh",
    code: "C",
    verifier: "V",
    redirectUri: "http://127.0.0.1:1/cb",
    fetch,
  });

  const expected = `Basic ${Buffer.from("client-1:shh").toString("base64")}`;
  assert.equal(captured[0]?.headers.get("authorization"), expected);
  assert.equal(
    new URLSearchParams(captured[0]?.body ?? "").has("client_id"),
    false,
  );
});

test("a resource indicator is forwarded", async () => {
  const { fetch, captured } = fakeFetch(() =>
    json({ access_token: "a", token_type: "Bearer" }),
  );

  await refreshAccessToken({
    ...base,
    refreshToken: "rt",
    resource: "https://mcp.example.test",
    fetch,
  });

  const form = new URLSearchParams(captured[0]?.body ?? "");
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "rt");
  assert.equal(form.get("resource"), "https://mcp.example.test");
});

test("an OAuth error surfaces its code and status", async () => {
  const { fetch } = fakeFetch(() =>
    json({ error: "invalid_grant", error_description: "code expired" }, 400),
  );

  await assert.rejects(
    exchangeAuthorizationCode({
      ...base,
      code: "C",
      verifier: "V",
      redirectUri: "http://127.0.0.1:1/cb",
      fetch,
    }),
    (error: unknown) => {
      assert.equal(error instanceof OAuthTokenError, true);
      assert.equal(
        error instanceof OAuthTokenError ? error.code : "",
        "invalid_grant",
      );
      assert.equal(error instanceof OAuthTokenError ? error.status : 0, 400);
      return true;
    },
  );
});

test("a non-JSON body is refused without echoing it", async () => {
  const { fetch } = fakeFetch(
    () => new Response("<html>nope</html>", { status: 200 }),
  );

  await assert.rejects(
    exchangeAuthorizationCode({
      ...base,
      code: "C",
      verifier: "V",
      redirectUri: "http://127.0.0.1:1/cb",
      fetch,
    }),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : "", /not JSON/);
      return true;
    },
  );
});

test("a response without an access token is refused", async () => {
  const { fetch } = fakeFetch(() => json({ token_type: "Bearer" }));
  await assert.rejects(
    exchangeAuthorizationCode({
      ...base,
      code: "C",
      verifier: "V",
      redirectUri: "http://127.0.0.1:1/cb",
      fetch,
    }),
    /no access_token/,
  );
});

test("an oversized body is refused instead of buffered", async () => {
  const huge = "x".repeat(MAX_TOKEN_BODY_BYTES + 1);
  const { fetch } = fakeFetch(() => new Response(huge, { status: 200 }));
  await assert.rejects(
    exchangeAuthorizationCode({
      ...base,
      code: "C",
      verifier: "V",
      redirectUri: "http://127.0.0.1:1/cb",
      fetch,
    }),
    /exceeds/,
  );
});

test("a non-loopback http endpoint is refused before any request", async () => {
  const { fetch, captured } = fakeFetch(() => json({}));
  await assert.rejects(
    exchangeAuthorizationCode({
      ...base,
      tokenEndpoint: "http://auth.example.test/token",
      code: "C",
      verifier: "V",
      redirectUri: "http://127.0.0.1:1/cb",
      fetch,
    }),
    /must be https/,
  );
  assert.equal(captured.length, 0);
});

test("an endpoint with credentials is refused", async () => {
  const { fetch } = fakeFetch(() => json({}));
  await assert.rejects(
    exchangeAuthorizationCode({
      ...base,
      tokenEndpoint: "https://user:pass@auth.example.test/token",
      code: "C",
      verifier: "V",
      redirectUri: "http://127.0.0.1:1/cb",
      fetch,
    }),
    /must not carry credentials/,
  );
});

test("a network failure becomes a typed error", async () => {
  const failing: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    exchangeAuthorizationCode({
      ...base,
      code: "C",
      verifier: "V",
      redirectUri: "http://127.0.0.1:1/cb",
      fetch: failing,
    }),
    (error: unknown) => {
      assert.equal(error instanceof OAuthTokenError, true);
      assert.match(
        error instanceof Error ? error.message : "",
        /token request failed/,
      );
      return true;
    },
  );
});
