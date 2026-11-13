/**
 * The interactive MCP OAuth flow against a loopback authorization server.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B26–B29 and
 * `docs/adr/0008-oauth-credential-envelope.md`. Everything is offline: the
 * server binds `127.0.0.1:0`, the browser is the injected `openBrowser`, and
 * the callback port is ephemeral. Each test closes the server.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type {
  McpOAuthOptions,
  McpRemoteServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "../../../src/extensions/mcp/config.ts";
import {
  McpOAuthError,
  authorizeServer,
  isLoopbackRedirect,
  registrationRedirectUris,
  type AuthorizeServerInput,
  type McpOAuthErrorCode,
} from "../../../src/extensions/mcp/oauth/flow.ts";
import {
  CALLBACK_PORT_ATTEMPTS,
  CALLBACK_PORT_START,
  challengeFor,
} from "../../../src/extensions/mcp/oauth/pkce.ts";
import {
  readCredentials,
  type CredentialSealer,
} from "../../../src/extensions/mcp/oauth/store.ts";
import {
  startAuthorizationServer,
  type FakeAuthorizationServer,
} from "./oauth-fixtures.ts";

/** The clock every test pins, so `expiresAt` is a constant, not a race. */
const CLOCK_MS = 1_760_000_000_000;

/** An identity sealer: the store's serialisation is what is under test here. */
const plainSealer: CredentialSealer = {
  seal: async (plaintext) => plaintext,
  open: async (sealed) => sealed,
};

async function tempStore(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "droide-oauth-flow-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function withServer(
  t: TestContext,
  options: Parameters<typeof startAuthorizationServer>[0] = {},
): Promise<FakeAuthorizationServer> {
  const server = await startAuthorizationServer(options);
  t.after(() => server.close());
  return server;
}

function remote(
  url: string,
  oauth?: false | McpOAuthOptions,
): McpRemoteServerConfig {
  return {
    type: "http",
    url,
    headers: {},
    disabled: false,
    ...(oauth === undefined ? {} : { oauth }),
  };
}

function stdio(): McpStdioServerConfig {
  return { type: "stdio", command: "npx", args: [], env: {}, disabled: false };
}

function flow(
  store: string,
  config: McpServerConfig,
  openBrowser: (url: string) => Promise<void>,
  overrides: {
    readonly allowedByPolicy?: boolean;
    readonly sealer?: CredentialSealer;
    readonly now?: () => number;
  } = {},
): AuthorizeServerInput {
  return {
    server: {
      name: "linear",
      allowedByPolicy: overrides.allowedByPolicy ?? true,
    },
    config,
    store: { stateDir: store },
    sealer: overrides.sealer ?? plainSealer,
    openBrowser,
    fetch: globalThis.fetch,
    clock: overrides.now ?? (() => CLOCK_MS),
    callback: { portStart: 0, timeoutMs: 5_000 },
  };
}

/**
 * The browser: ask the authorization endpoint, then follow the redirect by hand
 * so the test sees (and can tamper with) exactly what the flow expects back.
 */
function browser(): (url: string) => Promise<void> {
  return async (url: string) => {
    const authorize = await fetch(url, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const location = authorize.headers.get("location");
    assert.notEqual(location, null);
    const callback = await fetch(location ?? "");
    assert.equal(callback.status, 200);
  };
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: McpOAuthErrorCode,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof McpOAuthError,
      `expected a flow error, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

test("the dance registers a client, exchanges the code and stores the credential", async (t) => {
  const server = await withServer(t);
  const store = await tempStore(t);

  const stored = await authorizeServer(
    flow(store, remote(server.resource), browser()),
  );

  assert.equal(stored.serverName, "linear");
  assert.equal(stored.serverUrl, server.resource);
  assert.equal(stored.issuer, server.issuer);
  assert.equal(stored.revision, 1);
  assert.equal(stored.updatedAt, new Date(CLOCK_MS).toISOString());
  assert.equal(stored.client.clientId, "dynamic-client-1");
  assert.equal(stored.tokens.accessToken, "access-code-1");
  assert.equal(stored.tokens.refreshToken, "refresh-code-1");
  assert.equal(stored.tokens.expiresAt, CLOCK_MS + 3_600_000);
  assert.equal(stored.tokens.scope, "read");

  const authorization = server.authorizations[0];
  assert.notEqual(authorization, undefined);
  assert.equal(authorization?.clientId, "dynamic-client-1");
  assert.equal(authorization?.method, "S256");
  assert.equal(authorization?.resource, server.resource);
  assert.ok((authorization?.state.length ?? 0) > 0);

  assert.equal(server.registrations.length, 1);
  assert.deepEqual(server.registrations[0]?.redirectUris, [
    authorization?.redirectUri,
  ]);
  assert.equal(server.registrations[0]?.tokenEndpointAuthMethod, "none");

  // The verifier the token endpoint received is the one the challenge commits
  // to: this is the PKCE proof, not merely a shape check.
  const token = server.tokenRequests[0];
  assert.notEqual(token, undefined);
  assert.equal(challengeFor(token?.verifier ?? ""), authorization?.challenge);
  assert.equal(token?.code, "code-1");
  assert.equal(token?.redirectUri, authorization?.redirectUri);

  const document = await readCredentials({
    stateDir: store,
    sealer: plainSealer,
  });
  assert.equal(document.servers["linear"]?.issuer, server.issuer);
  assert.equal(document.servers["linear"]?.revision, 1);
  assert.equal(document.servers["linear"]?.client.clientId, "dynamic-client-1");
});

test("a configured issuer is used without the resource document", async (t) => {
  const server = await withServer(t, { protectedResource: false });
  const store = await tempStore(t);

  const stored = await authorizeServer(
    flow(
      store,
      remote(server.resource, { authorizationServerIssuer: server.issuer }),
      browser(),
    ),
  );

  assert.equal(stored.issuer, server.issuer);
  assert.equal(server.registrations.length, 1);
  assert.equal(server.authorizations.length, 1);
});

test("a tampered state is refused and the flow still completes", async (t) => {
  const server = await withServer(t);
  const store = await tempStore(t);

  const openBrowser = async (url: string): Promise<void> => {
    const authorize = await fetch(url, { redirect: "manual" });
    const location = new URL(authorize.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";

    location.searchParams.set("state", "tampered");
    const refused = await fetch(location);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /state mismatch/);

    location.searchParams.set("state", state);
    const accepted = await fetch(location);
    assert.equal(accepted.status, 200);
  };

  const stored = await authorizeServer(
    flow(store, remote(server.resource), openBrowser),
  );
  assert.equal(stored.tokens.accessToken, "access-code-1");
  assert.equal(server.tokenRequests.length, 1);
});

test("a second run reuses the registered client id", async (t) => {
  const server = await withServer(t, { expiresInSeconds: 0 });
  const store = await tempStore(t);
  const config = remote(server.resource);

  const first = await authorizeServer(flow(store, config, browser()));
  const second = await authorizeServer(flow(store, config, browser()));

  assert.equal(server.registrations.length, 1);
  assert.deepEqual(
    server.authorizations.map((entry) => entry.clientId),
    ["dynamic-client-1", "dynamic-client-1"],
  );
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.client.clientId, "dynamic-client-1");
});

test("oauth: false never authenticates and never opens a browser", async (t) => {
  const server = await withServer(t);
  const store = await tempStore(t);

  let opened = 0;
  await rejectsWithCode(
    authorizeServer(
      flow(store, remote(server.resource, false), async () => {
        opened += 1;
      }),
    ),
    "oauth-disabled",
  );
  assert.equal(opened, 0);
  assert.equal(server.authorizations.length, 0);
});

test("a disabled, stdio or policy-blocked server is refused", async (t) => {
  const server = await withServer(t);
  const store = await tempStore(t);
  const open = async (): Promise<void> => undefined;

  const disabled = { ...remote(server.resource), disabled: true };
  await rejectsWithCode(
    authorizeServer(flow(store, disabled, open)),
    "server-disabled",
  );
  await rejectsWithCode(
    authorizeServer(flow(store, stdio(), open)),
    "not-remote",
  );
  await rejectsWithCode(
    authorizeServer(
      flow(store, remote(server.resource), open, { allowedByPolicy: false }),
    ),
    "policy-blocked",
  );
  assert.equal(server.registrations.length, 0);
});

test("the documented configuration refusals are typed", async (t) => {
  const server = await withServer(t);
  const store = await tempStore(t);
  const open = async (): Promise<void> => undefined;

  await rejectsWithCode(
    authorizeServer(
      flow(
        store,
        remote(server.resource, {
          clientMetadataUrl: "https://client.example.test/metadata",
          clientId: "configured",
        }),
        open,
      ),
    ),
    "client-metadata-conflict",
  );

  await rejectsWithCode(
    authorizeServer(
      flow(
        store,
        remote(server.resource, {
          clientMetadataUrl: "https://client.example.test/metadata",
          tokenEndpointAuthMethod: "client_secret_basic",
        }),
        open,
      ),
    ),
    "client-metadata-conflict",
  );

  await rejectsWithCode(
    authorizeServer(
      flow(store, remote(server.resource, { clientId: "configured" }), open),
    ),
    "missing-issuer",
  );

  await rejectsWithCode(
    authorizeServer(
      flow(
        store,
        remote(server.resource, {
          clientId: "configured",
          clientSecret: "secret",
          authorizationServerIssuer: server.issuer,
          tokenEndpointAuthMethod: "client_secret_post",
        }),
        open,
      ),
    ),
    "unsupported-config",
  );
});

test("a configured client id is used as-is without registering", async (t) => {
  const server = await withServer(t);
  const store = await tempStore(t);

  const stored = await authorizeServer(
    flow(
      store,
      remote(server.resource, {
        clientId: "configured-client",
        authorizationServerIssuer: server.issuer,
      }),
      browser(),
    ),
  );

  assert.equal(stored.client.clientId, "configured-client");
  assert.equal(stored.client.metadataUrl, undefined);
  assert.equal(server.registrations.length, 0);
  assert.equal(server.authorizations[0]?.clientId, "configured-client");
  assert.equal(server.tokenRequests[0]?.clientId, "configured-client");
});

test("a client metadata URL becomes the client id and is stored", async (t) => {
  const server = await withServer(t);
  const store = await tempStore(t);
  const metadataUrl = "https://client.example.test/metadata";

  const stored = await authorizeServer(
    flow(
      store,
      remote(server.resource, { clientMetadataUrl: metadataUrl }),
      browser(),
    ),
  );

  assert.equal(stored.client.clientId, metadataUrl);
  assert.equal(stored.client.metadataUrl, metadataUrl);
  assert.equal(server.registrations.length, 0);
  assert.equal(server.tokenRequests[0]?.clientId, metadataUrl);
});

test("a server without registration and without a client id is refused", async (t) => {
  const server = await withServer(t, { dynamicRegistration: false });
  const store = await tempStore(t);

  let opened = 0;
  await rejectsWithCode(
    authorizeServer(
      flow(store, remote(server.resource), async () => {
        opened += 1;
      }),
    ),
    "registration",
  );
  assert.equal(opened, 0);
  assert.equal(server.authorizations.length, 0);
});

test("a refused token exchange surfaces as a token error", async (t) => {
  const server = await withServer(t, { tokenStatus: 400 });
  const store = await tempStore(t);

  await rejectsWithCode(
    authorizeServer(flow(store, remote(server.resource), browser())),
    "token",
  );
  const document = await readCredentials({
    stateDir: store,
    sealer: plainSealer,
  });
  assert.deepEqual(document.servers, {});
});

test("only loopback http redirects are accepted", () => {
  assert.equal(isLoopbackRedirect("http://127.0.0.1:54621/callback"), true);
  assert.equal(isLoopbackRedirect("http://localhost:1234/callback"), true);
  assert.equal(isLoopbackRedirect("http://[::1]:1234/callback"), true);
  assert.equal(isLoopbackRedirect("https://127.0.0.1:54621/callback"), false);
  assert.equal(isLoopbackRedirect("http://example.test/callback"), false);
  assert.equal(isLoopbackRedirect("http://user:secret@127.0.0.1/cb"), false);
  assert.equal(isLoopbackRedirect("file:///tmp/callback"), false);
  assert.equal(isLoopbackRedirect("not a url"), false);
});

test("a dynamic registration covers the documented port run", () => {
  const uris = registrationRedirectUris(
    "http://127.0.0.1:54621/callback",
    CALLBACK_PORT_START,
    CALLBACK_PORT_ATTEMPTS,
  );
  assert.equal(uris.length, 100);
  assert.equal(uris[0], "http://127.0.0.1:54621/callback");
  assert.equal(uris[99], "http://127.0.0.1:54720/callback");
  assert.deepEqual(
    registrationRedirectUris("http://127.0.0.1:41234/callback", 0, 100),
    ["http://127.0.0.1:41234/callback"],
  );
});
