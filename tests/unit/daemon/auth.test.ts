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
} from "../../../src/daemon/auth.ts";
import {
  DaemonAuthenticationError,
  DaemonInvalidResponseError,
} from "../../../src/daemon/errors.ts";
import { JSON_RPC_ERRORS } from "../../../src/daemon/protocol.ts";
import {
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

test("once authenticated every envelope is allowed", () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  auth.authenticate({ token: TEST_TOKEN });
  assert.deepEqual(
    gateEnvelope(auth, { type: "request", method: "anything" }),
    { kind: "allow" },
  );
  assert.deepEqual(gateEnvelope(auth, { type: "response" }), {
    kind: "allow",
  });
});

test("each connection holds its own gate state", () => {
  const policy = testAuthPolicy();
  const first = new DaemonConnectionAuth(policy);
  const second = new DaemonConnectionAuth(policy);
  first.authenticate({ token: TEST_TOKEN });
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

test("re-authenticating never re-verifies the credential (B17)", () => {
  const auth = new DaemonConnectionAuth(testAuthPolicy());
  const first = auth.authenticate({ token: TEST_TOKEN });
  const second = auth.authenticate({ apiKey: "fk-not-valid" });
  assert.deepEqual(second, first);
  assert.equal(auth.authenticated, true);
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
    { userId: "u", orgId: "o", encoding: "deflate-raw", pipelined: true },
  );
  for (const bad of [
    {},
    { userId: "", orgId: "o" },
    { userId: "u", orgId: 7 },
    { userId: "u", orgId: "o", pipelined: "yes" },
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
