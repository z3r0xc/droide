/**
 * The authentication gate and handshake. Clauses: `specs/70` B14–B17, B31.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTHENTICATE_METHOD,
  AUTHENTICATION_REQUIRED_MESSAGE,
  CONNECTION_STATUS_METHOD,
  DaemonConnectionAuth,
  LOGOUT_METHOD,
  PIPELINE_METHODS,
  authenticationRequired,
  gateEnvelope,
  isPipelineMethod,
  parseAuthenticateRequest,
  parseAuthenticateResult,
  verifyCredential,
  verifyCredentialAsync,
} from "../../../src/daemon/auth.ts";
import {
  DaemonAuthenticationError,
  DaemonCredentialVerificationError,
  DaemonInvalidResponseError,
} from "../../../src/daemon/errors.ts";
import { JSON_RPC_ERRORS } from "../../../src/daemon/protocol.ts";
import {
  TEST_ACCOUNT,
  TEST_API_KEY,
  TEST_IDENTITY,
  TEST_TOKEN,
  testAuthPolicy,
} from "./helpers.ts";

test("the gate answers a non-auth first request with -32001 and the fixed sentence", () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  const decision = gateEnvelope(auth, {
    type: "request",
    method: "list_opened_sessions",
  });
  assert.deepEqual(decision, {
    kind: "reject",
    code: -32001,
    message:
      "Connection not authenticated. Must call daemon.authenticate first.",
  });
  if (decision.kind !== "reject") {
    throw new assert.AssertionError({ message: "expected a rejection" });
  }
  assert.equal(decision.message, AUTHENTICATION_REQUIRED_MESSAGE);
});

test("the gate allows daemon.authenticate as the first request", () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  assert.deepEqual(
    gateEnvelope(auth, { type: "request", method: AUTHENTICATE_METHOD }),
    {
      kind: "allow",
    },
  );
  assert.deepEqual(authenticationRequired(), {
    kind: "reject",
    code: JSON_RPC_ERRORS.authentication,
    message: AUTHENTICATION_REQUIRED_MESSAGE,
  });
});

test("an unauthenticated notification or response is dropped, never answered", () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  assert.deepEqual(
    gateEnvelope(auth, { type: "notification", method: "daemon.ping" }),
    { kind: "drop" },
  );
  assert.deepEqual(gateEnvelope(auth, { type: "response" }), { kind: "drop" });
});

test("once authenticated every envelope is allowed", async () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  await auth.authenticate({ token: TEST_TOKEN });
  assert.deepEqual(
    gateEnvelope(auth, { type: "request", method: "anything" }),
    { kind: "allow" },
  );
  assert.deepEqual(gateEnvelope(auth, { type: "response" }), {
    kind: "allow",
  });
});

test("each connection holds its own gate state", async () => {
  const policy = testAuthPolicy();
  const first = new DaemonConnectionAuth(policy);
  const second = new DaemonConnectionAuth(policy);
  await first.authenticate({ token: TEST_TOKEN });
  assert.equal(first.authenticated, true);
  assert.equal(second.authenticated, false);
  assert.equal(second.identity, undefined);
});

test("a valid token and a valid fk- key both authenticate the single account", () => {
  assert.deepEqual(verifyCredential({ token: TEST_TOKEN }, testAuthPolicy()), {
    userId: TEST_IDENTITY.userId,
    orgId: TEST_IDENTITY.orgId,
  });
  assert.deepEqual(
    verifyCredential({ apiKey: TEST_API_KEY }, testAuthPolicy()),
    {
      userId: TEST_IDENTITY.userId,
      orgId: TEST_IDENTITY.orgId,
    },
  );
});

test("a missing credential, a bad token and a bad key are refused", () => {
  const policy = testAuthPolicy();
  assert.throws(() => verifyCredential({}, policy), {
    name: "DaemonAuthenticationError",
    message: "Authentication requires a token or an API key",
  });
  assert.throws(() => verifyCredential({ token: "other" }, policy), {
    message: "Invalid authentication token",
  });
  assert.throws(() => verifyCredential({ apiKey: "fk-other" }, policy), {
    message: "Invalid API key",
  });
});

test("a key without the fk- prefix is refused before it is compared", () => {
  assert.throws(
    () => verifyCredential({ apiKey: "sk-looks-like-a-key" }, testAuthPolicy()),
    { message: "API key must start with fk-" },
  );
});

test("authentication is not configured when the daemon has no credential", () => {
  const policy = { identity: TEST_IDENTITY };
  assert.throws(() => verifyCredential({ token: TEST_TOKEN }, policy), {
    message: "Token authentication is not configured",
  });
  assert.throws(() => verifyCredential({ apiKey: TEST_API_KEY }, policy), {
    message: "API key authentication is not configured",
  });
});

function authErrorOf(run: () => unknown): DaemonAuthenticationError {
  try {
    run();
  } catch (error) {
    if (error instanceof DaemonAuthenticationError) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: "expected an auth error" });
}

test("a selected organization is checked before the credential and carries a reason", () => {
  const policy = testAuthPolicy();
  const error = authErrorOf(() =>
    verifyCredential(
      { token: TEST_TOKEN, activeOrganizationId: "another-org" },
      policy,
    ),
  );
  assert.equal(error.reason, "organization_selection_mismatch");
  assert.deepEqual(
    verifyCredential(
      { token: TEST_TOKEN, activeOrganizationId: TEST_IDENTITY.orgId },
      policy,
    ),
    TEST_IDENTITY,
  );
});

test("re-authenticating never re-verifies the credential (B17)", async () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  const first = await auth.authenticate({ token: TEST_TOKEN });
  const second = await auth.authenticate({ apiKey: "fk-not-valid" });
  assert.deepEqual(second, first);
  assert.equal(auth.authenticated, true);
});

test("a local credential is answered with the placeholder marked unverified", async () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  const account = await auth.authenticate({ apiKey: TEST_API_KEY });
  assert.deepEqual(account, TEST_ACCOUNT);
  assert.equal(account.verified, false);
  assert.deepEqual(auth.identity, TEST_ACCOUNT);
  assert.deepEqual(
    await verifyCredentialAsync({ token: TEST_TOKEN }, testAuthPolicy()),
    { ...TEST_IDENTITY, verified: false },
  );
});

test("a configured verifier supplies the account and the answer is verified", async () => {
  const seen: unknown[] = [];
  const policy = {
    verify: async (request: { token?: string; apiKey?: string }) => {
      seen.push(request.token ?? request.apiKey);
      return { userId: "backend-user", orgId: "backend-org" };
    },
  };
  assert.deepEqual(await verifyCredentialAsync({ token: "t" }, policy), {
    userId: "backend-user",
    orgId: "backend-org",
    verified: true,
  });
  assert.deepEqual(seen, ["t"]);
});

test("two authenticate frames in flight ask the backend once", async () => {
  let calls = 0;
  const auth = new DaemonConnectionAuth({
    verify: async () => {
      calls += 1;
      return { userId: "u", orgId: "o" };
    },
  });
  const [first, second] = await Promise.all([
    auth.authenticate({ token: "t" }),
    auth.authenticate({ token: "t" }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});

test("a failed check leaves the gate open for a later attempt", async () => {
  let attempts = 0;
  const auth = new DaemonConnectionAuth({
    verify: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("backend blip");
      return { userId: "u", orgId: "o" };
    },
  });
  await assert.rejects(auth.authenticate({ token: "t" }), {
    message: "backend blip",
  });
  assert.equal(auth.authenticated, false);
  assert.deepEqual(await auth.authenticate({ token: "t" }), {
    userId: "u",
    orgId: "o",
    verified: true,
  });
});

test("a verifier refusal stays a typed auth failure", async () => {
  const policy = {
    verify: async () => {
      throw new DaemonCredentialVerificationError(
        "invalid_credential",
        "Invalid credential",
      );
    },
  };
  await assert.rejects(verifyCredentialAsync({ token: "secret" }, policy), {
    name: "DaemonCredentialVerificationError",
    reason: "invalid_credential",
    message: "Invalid credential",
  });
});

test("the organization is checked against the verified account, not a local one", async () => {
  const policy = {
    verify: async () => ({ userId: "u", orgId: "verified-org" }),
  };
  const error = await verifyCredentialAsync(
    { token: "t", activeOrganizationId: "another-org" },
    policy,
  ).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof DaemonAuthenticationError);
  assert.equal(error.reason, "organization_selection_mismatch");
  assert.deepEqual(
    await verifyCredentialAsync(
      { token: "t", activeOrganizationId: "verified-org" },
      policy,
    ),
    { userId: "u", orgId: "verified-org", verified: true },
  );
});

test("a verified policy still refuses a malformed or missing credential locally", async () => {
  const policy = {
    verify: async () => ({ userId: "u", orgId: "o" }),
  };
  await assert.rejects(verifyCredentialAsync({}, policy), {
    message: "Authentication requires a token or an API key",
  });
  await assert.rejects(verifyCredentialAsync({ apiKey: "sk-nope" }, policy), {
    message: "API key must start with fk-",
  });
});

test("authenticate params are validated as a schema: grants are refused", () => {
  assert.deepEqual(parseAuthenticateRequest({ token: "t" }), { token: "t" });
  assert.deepEqual(parseAuthenticateRequest(undefined), {});
  assert.throws(() => parseAuthenticateRequest({ actAsGrant: {} }), {
    message: "actAsGrant is not supported by this daemon",
  });
  assert.throws(() => parseAuthenticateRequest({ sharedSessionGrant: {} }), {
    message: "sharedSessionGrant is not supported by this daemon",
  });
  assert.throws(() => parseAuthenticateRequest("token"), {
    message: "daemon.authenticate params must be an object",
  });
});

test("acceptEncodings must be an array of strings", () => {
  assert.deepEqual(
    parseAuthenticateRequest({ acceptEncodings: ["deflate-raw"] }),
    { acceptEncodings: ["deflate-raw"] },
  );
  assert.throws(() => parseAuthenticateRequest({ acceptEncodings: "gzip" }), {
    message: "acceptEncodings must be an array of strings",
  });
  assert.throws(() => parseAuthenticateRequest({ acceptEncodings: [1] }), {
    message: "acceptEncodings must be an array of strings",
  });
});

test("the pipeline accepts at most eight UUID-addressed read requests", () => {
  const entry = {
    id: "0b8f2f0e-9b1a-4c3d-8e4f-1a2b3c4d5e6f",
    method: PIPELINE_METHODS[0] ?? "",
  };
  const parsed = parseAuthenticateRequest({ pipeline: [entry] });
  assert.equal(parsed.pipeline?.length, 1);
  assert.equal(isPipelineMethod(entry.method), true);
  assert.equal(isPipelineMethod("daemon.send_message"), false);
  assert.throws(
    () =>
      parseAuthenticateRequest({
        pipeline: Array.from({ length: 9 }, () => entry),
      }),
    { message: "pipeline accepts at most 8 requests" },
  );
  assert.throws(
    () => parseAuthenticateRequest({ pipeline: [{ id: "1", method: "x" }] }),
    { message: "pipeline entry id must be a UUID v4 string" },
  );
  assert.throws(() => parseAuthenticateRequest({ pipeline: "x" }), {
    message: "pipeline must be an array",
  });
});

test("the authenticate result must carry a non-empty userId and orgId", () => {
  assert.deepEqual(
    parseAuthenticateResult({
      userId: "u",
      orgId: "o",
      encoding: "deflate-raw",
      pipelined: true,
    }),
    {
      userId: "u",
      orgId: "o",
      verified: false,
      encoding: "deflate-raw",
      pipelined: true,
    },
  );
  assert.deepEqual(
    parseAuthenticateResult({ userId: "u", orgId: "o", verified: true }),
    { userId: "u", orgId: "o", verified: true },
  );
  for (const bad of [
    {},
    { userId: "", orgId: "o" },
    { userId: "u", orgId: 7 },
    { userId: "u", orgId: "o", pipelined: "yes" },
    { userId: "u", orgId: "o", verified: "yes" },
    null,
  ]) {
    assert.throws(() => parseAuthenticateResult(bad), {
      name: "DaemonInvalidResponseError",
    });
  }
  assert.ok(
    new DaemonInvalidResponseError("m", undefined, "d") instanceof Error,
  );
});

test("the lifecycle method names are the ones the dispatcher special-cases", () => {
  assert.equal(AUTHENTICATE_METHOD, "daemon.authenticate");
  assert.equal(LOGOUT_METHOD, "daemon.logout");
  assert.equal(CONNECTION_STATUS_METHOD, "daemon.connection_status");
});
