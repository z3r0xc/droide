import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AIRGAP_BLOCKED_MESSAGE,
  AUTH_MESSAGES,
  AirgapBlockedError,
  AuthenticationError,
  DeploymentUnavailableError,
  FetchError,
  LlmForbiddenError,
  LlmInternalError,
  LlmInvalidRequestError,
  LlmOverloadedError,
  LlmPaymentRequiredError,
  LlmQuotaExhaustedError,
  LlmThrottlingError,
  ResponseError,
  ResponseError400BadRequest,
  ResponseError401Unauthorized,
  ResponseError403Forbidden,
  TransportNetworkError,
  TlsTrustError,
  apiKeyRejectionError,
  classifyApiKeyValidationFailure,
  classifyModelFailure,
  isRetryableLlmReason,
} from "../../../src/transport/errors.ts";

test("HTTP status to classification table (B95/B96)", () => {
  const cases: ReadonlyArray<{
    readonly error: Error;
    readonly reason: string;
    readonly message: string;
  }> = [
    {
      error: new FetchError(400, "bad", "verify"),
      reason: "apiKeyRejected",
      message: AUTH_MESSAGES.apiKeyRejected,
    },
    {
      error: new FetchError(401, "bad", "verify"),
      reason: "apiKeyRejected",
      message: AUTH_MESSAGES.apiKeyRejected,
    },
    {
      error: new FetchError(403, "bad", "verify"),
      reason: "apiKeyRejected",
      message: AUTH_MESSAGES.apiKeyRejected,
    },
    {
      error: new FetchError(500, "boom", "verify"),
      reason: "ApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    },
    {
      error: new FetchError(418, "teapot", "verify"),
      reason: "ApiValidationFailed",
      message: AUTH_MESSAGES.validationFailed,
    },
    {
      error: new ResponseError("malformed", null, "verify"),
      reason: "ApiValidationFailed",
      message: AUTH_MESSAGES.validationFailed,
    },
    {
      error: new TypeError("fetch failed"),
      reason: "ApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    },
    {
      error: new TransportNetworkError("verify", "ECONNREFUSED"),
      reason: "ApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    },
    {
      error: new TlsTrustError("verify", "SELF_SIGNED_CERT_IN_CHAIN"),
      reason: "ApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    },
  ];
  for (const testCase of cases) {
    const failure = classifyApiKeyValidationFailure(testCase.error);
    assert.equal(failure.reason, testCase.reason, testCase.error.message);
    assert.equal(failure.message, testCase.message, testCase.error.message);
  }
});

test("the response error classes carry the spec's fixed copy", () => {
  const unauthorized = new ResponseError401Unauthorized(
    AUTH_MESSAGES.apiKeyRejected,
    "verify",
  );
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.message, "API key was rejected.");
  assert.deepEqual(unauthorized.toPublicObject(), {
    detail: "API key was rejected.",
    status: 401,
    title: "Unauthorized",
  });
  assert.deepEqual(unauthorized.toDisplayObject(), {
    error: unauthorized.toPublicObject(),
  });
  assert.equal(new ResponseError400BadRequest("x", "op").statusCode, 400);
  assert.equal(new ResponseError403Forbidden("x", "op").statusCode, 403);
});

test("a rejected verification maps to a typed 400/401/403 error", () => {
  const badRequest = apiKeyRejectionError(400, "verify");
  assert.ok(badRequest instanceof ResponseError400BadRequest);
  assert.equal(badRequest.message, "API key was rejected.");
  assert.ok(
    apiKeyRejectionError(401, "verify") instanceof ResponseError401Unauthorized,
  );
  assert.ok(
    apiKeyRejectionError(403, "verify") instanceof ResponseError403Forbidden,
  );
  assert.equal(apiKeyRejectionError(500, "verify"), null);
  assert.equal(apiKeyRejectionError(418, "verify"), null);
});

test("a public code and retry-after survive the public object", () => {
  const error = new ResponseError403Forbidden("blocked", "llm", {
    code: "content_policy_rejected",
    retryAfterSeconds: 30,
  });
  assert.deepEqual(error.toPublicObject(), {
    detail: "blocked",
    status: 403,
    title: "Forbidden",
    code: "content_policy_rejected",
  });
  assert.equal(error.retryAfterSeconds, 30);
});

test("transport messages name the operation and never a credential", () => {
  const network = new TransportNetworkError("list-sessions", "ENOTFOUND");
  assert.match(network.message, /^list-sessions: /);
  const certificate = new TlsTrustError("whoami", "CERT_HAS_EXPIRED");
  assert.match(certificate.message, /^whoami: certificate chain not trusted/);
  assert.match(certificate.message, /FACTORY_EXTRA_CA_CERTS/);
});

test("deployment refusals use the exact spec messages", () => {
  assert.equal(
    new DeploymentUnavailableError("op", "hosted").message,
    "This hosted operation is unavailable on customer deployments.",
  );
  assert.equal(
    new DeploymentUnavailableError("op", "route").message,
    "This operation is unavailable on customer deployments.",
  );
});

test("absent credentials use the fixed not-authenticated copy", () => {
  assert.equal(
    new AuthenticationError("verify").message,
    "Not authenticated. Please log in using /login or set a valid DROIDE_API_KEY environment variable.",
  );
  assert.equal(
    new AuthenticationError("prem", AUTH_MESSAGES.customerLoginRequired)
      .message,
    "Sign in to this customer deployment.",
  );
});

test("airgap is a hard veto with its fixed message (B89)", () => {
  const error = new AirgapBlockedError("list-sessions");
  assert.equal(
    error.message,
    "Outbound request blocked because Airgap Mode is enabled; only BYOK, MCP, and marketplaces are permitted.",
  );
  assert.equal(error.message, AIRGAP_BLOCKED_MESSAGE);
});

test("model failures classify by status and documented proxy codes (B101/B104)", () => {
  const throttling = classifyModelFailure({ operation: "llm", status: 429 });
  assert.ok(throttling instanceof LlmThrottlingError);
  assert.equal(throttling.retryable, true);

  for (const status of [408, 500, 502, 503, 529]) {
    const overloaded = classifyModelFailure({ operation: "llm", status });
    assert.ok(overloaded instanceof LlmOverloadedError, String(status));
    assert.equal(overloaded.retryable, true);
  }

  const internal = classifyModelFailure({ operation: "llm", status: 501 });
  assert.ok(internal instanceof LlmInternalError);
  assert.equal(internal.retryable, true);

  const invalid = classifyModelFailure({ operation: "llm", status: 400 });
  assert.ok(invalid instanceof LlmInvalidRequestError);
  assert.equal(invalid.retryable, false);
});

test("a proxy content gate is non-retryable moderation, legacy form included", () => {
  const gate = classifyModelFailure({
    operation: "llm",
    status: 403,
    code: "content_policy_rejected",
  });
  assert.equal(gate.reason, "content-moderation");
  assert.equal(gate.retryable, false);

  const legacy = classifyModelFailure({
    operation: "llm",
    status: 403,
    legacyForbidden: true,
  });
  assert.equal(legacy.reason, "content-moderation");

  // B104: an upstream-marked error is a provider error, not a gate.
  const upstream = classifyModelFailure({
    operation: "llm",
    status: 403,
    code: "content_policy_rejected",
    upstreamError: true,
  });
  assert.ok(upstream instanceof LlmForbiddenError);
  assert.equal(upstream.retryable, false);
});

test("402 splits into payment required and quota exhausted", () => {
  const payment = classifyModelFailure({
    operation: "llm",
    status: 402,
    code: "no_active_subscription",
  });
  assert.ok(payment instanceof LlmPaymentRequiredError);
  assert.equal(payment.message, "No active subscription found.");

  const quota = classifyModelFailure({ operation: "llm", status: 402 });
  assert.ok(quota instanceof LlmQuotaExhaustedError);
});

test("retryability is part of the reason set (B103)", () => {
  assert.equal(isRetryableLlmReason("throttling"), true);
  assert.equal(isRetryableLlmReason("overloaded"), true);
  assert.equal(isRetryableLlmReason("network"), true);
  assert.equal(isRetryableLlmReason("internal-error"), true);
  assert.equal(isRetryableLlmReason("unknown"), true);
  assert.equal(isRetryableLlmReason("invalid-request"), false);
  assert.equal(isRetryableLlmReason("content-moderation"), false);
  assert.equal(isRetryableLlmReason("context-limit"), false);
  assert.equal(isRetryableLlmReason("request-too-large"), false);
  assert.equal(isRetryableLlmReason("output-degeneration"), false);
});
