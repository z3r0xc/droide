import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AIRGAP_BLOCKED_MESSAGE,
  AUTH_MESSAGES,
  AirgapBlockedError,
  AuthenticationError,
  DeploymentUnavailableError,
  FetchError,
  LlmContentModerationError,
  LlmContextLimitError,
  LlmForbiddenError,
  LlmInternalError,
  LlmInvalidRequestError,
  LlmOverloadedError,
  LlmPaymentRequiredError,
  LlmQuotaExhaustedError,
  LlmRequestTooLargeError,
  LlmThrottlingError,
  MODEL_FAILURE_MARKERS,
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
  assert.match(certificate.message, /DROIDE_EXTRA_CA_CERTS/);
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

test("B101 body markers: quota codes separate exhaustion from throttling", () => {
  for (const code of MODEL_FAILURE_MARKERS.quotaCodes) {
    const error = classifyModelFailure({
      operation: "llm",
      status: 429,
      bodyJson: { error: { code } },
    });
    assert.ok(error instanceof LlmQuotaExhaustedError, code);
    assert.equal(error.reason, "quota-exhausted");
    assert.equal(error.retryable, false);
  }
});

test("B101 body markers: a quota marker is read from code, type and status", () => {
  for (const key of ["code", "type", "status"] as const) {
    const error = classifyModelFailure({
      operation: "llm",
      status: 400,
      bodyJson: { [key]: "billing_not_active" },
    });
    assert.equal(error.reason, "quota-exhausted", key);
    assert.ok(error instanceof LlmQuotaExhaustedError, key);
  }
});

test("B101 body markers: a quota message, plain text or JSON, is exhaustion", () => {
  const json = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyJson: { error: { message: "You have reached your billing hard limit." } },
  });
  assert.equal(json.reason, "quota-exhausted");

  const raw = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyText: '{"error":{"code":"insufficient_quota"}}',
  });
  assert.equal(raw.reason, "quota-exhausted");

  const prose = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyText: "Your monthly limit exhausted. Check your plan and billing.",
  });
  assert.equal(prose.reason, "quota-exhausted");

  const statusless = classifyModelFailure({
    operation: "llm",
    status: null,
    bodyJson: { detail: "exhausted your available credits" },
  });
  assert.equal(statusless.reason, "quota-exhausted");
});

test("B101 body markers: a subscription gate outranks quota text on a 402", () => {
  const payment = classifyModelFailure({
    operation: "llm",
    status: 402,
    code: "no_active_subscription",
    bodyJson: { error: { code: "insufficient_quota" } },
  });
  assert.ok(payment instanceof LlmPaymentRequiredError);

  const quota = classifyModelFailure({
    operation: "llm",
    status: 402,
    bodyJson: { error: { code: "insufficient_quota" } },
  });
  assert.ok(quota instanceof LlmQuotaExhaustedError);
});

test("B101 body markers: moderation codes and messages are content moderation", () => {
  for (const code of MODEL_FAILURE_MARKERS.moderationCodes) {
    const error = classifyModelFailure({
      operation: "llm",
      status: 400,
      bodyJson: { error: { code } },
    });
    assert.ok(error instanceof LlmContentModerationError, code);
    assert.equal(error.retryable, false);
  }

  for (const message of [
    "Your request was rejected as a result of our safety system.",
    "This request was blocked for violating our usage policy.",
    "The prompt was flagged by content moderation.",
  ]) {
    const error = classifyModelFailure({
      operation: "llm",
      status: 403,
      bodyJson: { error: { message } },
    });
    assert.equal(error.reason, "content-moderation", message);
  }

  // B104: an upstream-marked 403 is still the provider's own moderation body.
  const upstream = classifyModelFailure({
    operation: "llm",
    status: 403,
    upstreamError: true,
    bodyJson: { error: { code: "content_filter" } },
  });
  assert.equal(upstream.reason, "content-moderation");
});

test("B101 body markers: context limit beats throttling and 413", () => {
  const code = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyJson: { error: { code: "context_length_exceeded" } },
  });
  assert.ok(code instanceof LlmContextLimitError);

  const throttled = classifyModelFailure({
    operation: "llm",
    status: 429,
    bodyJson: {
      error: { message: "This model's maximum context length is 200000 tokens" },
    },
  });
  assert.equal(throttled.reason, "context-limit");
  assert.equal(throttled.retryable, false);

  const sized = classifyModelFailure({
    operation: "llm",
    status: 413,
    bodyJson: {
      error: { message: "Request size exceeds model context window" },
    },
  });
  assert.equal(sized.reason, "context-limit");
});

test("B101 body markers: a size refusal is request-too-large, not a context limit", () => {
  const byCode = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyJson: { error: { code: "413" } },
  });
  assert.ok(byCode instanceof LlmRequestTooLargeError);

  const byMessage = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyText: "413 Request Entity Too Large",
  });
  assert.equal(byMessage.reason, "request-too-large");
});

test("B101 body markers: signature and PDF shapes are invalid requests", () => {
  for (const message of [
    "Invalid `signature` in `thinking` block",
    "Thought signature is not valid",
    "Function call is missing a thought_signature",
    "A maximum of 100 PDF pages may be provided",
  ]) {
    const error = classifyModelFailure({
      operation: "llm",
      status: 400,
      bodyJson: { error: { message } },
    });
    assert.equal(error.reason, "invalid-request", message);
    assert.equal(error.retryable, false);
  }
});

test("B101 near misses stay unclassified: a rate, a bare quota phrase, a length", () => {
  const unclassified: ReadonlyArray<{
    readonly status: number;
    readonly bodyJson: unknown;
    readonly expected: string;
  }> = [
    {
      status: 429,
      bodyJson: {
        error: {
          message: "Rate limit reached for requests",
          code: "rate_limit_exceeded",
        },
      },
      expected: "throttling",
    },
    {
      status: 429,
      bodyJson: { error: { message: "Resource exhausted: quota exceeded" } },
      expected: "throttling",
    },
    {
      status: 429,
      bodyJson: { error: { message: "insufficient credits" } },
      expected: "throttling",
    },
    {
      status: 400,
      bodyJson: { error: { message: "The model has used too many tokens." } },
      expected: "invalid-request",
    },
    {
      status: 400,
      bodyJson: { error: { message: "This value is over the maximum length." } },
      expected: "invalid-request",
    },
  ];

  for (const item of unclassified) {
    const error = classifyModelFailure({
      operation: "llm",
      status: item.status,
      bodyJson: item.bodyJson,
    });
    assert.equal(error.reason, item.expected, String(item.bodyJson));
  }
});

test("B101 body markers: a non-JSON body is prose, never a marker", () => {
  const gateway = classifyModelFailure({
    operation: "llm",
    status: 502,
    bodyText: "upstream connect error or disconnect/reset before headers",
  });
  assert.ok(gateway instanceof LlmOverloadedError);

  const plain = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyText: "bad request",
  });
  assert.ok(plain instanceof LlmInvalidRequestError);
});

test("B101 body markers: an HTML gateway page is never read for markers", () => {
  const page =
    "<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Content moderation is unavailable: insufficient_quota</body></html>";
  const error = classifyModelFailure({
    operation: "llm",
    status: 403,
    bodyText: page,
  });
  assert.ok(error instanceof LlmForbiddenError);
  assert.equal(error.reason, "forbidden");
});

test("B101 body markers: a JSON string body is not an error envelope", () => {
  const bodies: readonly unknown[] = [
    "insufficient_quota",
    '{"error":{"code":"insufficient_quota"}}',
    42,
    ["insufficient_quota"],
  ];
  for (const bodyJson of bodies) {
    const error = classifyModelFailure({
      operation: "llm",
      status: 400,
      bodyJson,
    });
    assert.ok(error instanceof LlmInvalidRequestError, String(bodyJson));
  }

  const quoted = classifyModelFailure({
    operation: "llm",
    status: 400,
    bodyText: '"insufficient_quota"',
  });
  assert.ok(quoted instanceof LlmInvalidRequestError);
});

test("B101 body markers: a 5xx body is never re-read as a deterministic cause", () => {
  const error = classifyModelFailure({
    operation: "llm",
    status: 500,
    bodyJson: { error: { code: "insufficient_quota" } },
  });
  assert.ok(error instanceof LlmOverloadedError);
  assert.equal(error.retryable, true);
});
