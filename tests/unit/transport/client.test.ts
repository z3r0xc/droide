import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FetchError,
  InvalidResponseError,
  ResponseTooLargeError,
  TransportNetworkError,
  TransportTimeoutError,
  TlsTrustError,
  UnsafeRedirectError,
} from "../../../src/transport/errors.ts";
import { REDACTED } from "../../../src/transport/headers.ts";
import {
  HttpClient,
  NO_RETRY,
  REFRESH_RETRY,
  isRetryableStatus,
  parseRetryAfter,
  retryDelayMs,
  type FetchLike,
  type HttpRequest,
  type RetryPolicy,
} from "../../../src/transport/client.ts";
import { isRecord, readString } from "../../../src/transport/schema.ts";

interface RecordedCall {
  readonly url: URL;
  readonly init: RequestInit;
}

interface Harness {
  readonly client: HttpClient;
  readonly calls: RecordedCall[];
  readonly sleeps: number[];
}

type Step = Response | (() => Promise<Response>);

function harness(steps: readonly Step[], now = 0): Harness {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = steps[index];
    index += 1;
    if (step === undefined) {
      throw new Error(`unexpected request #${index}`);
    }
    if (typeof step === "function") {
      return await step();
    }
    return step;
  };
  return {
    client: new HttpClient({
      fetch: fetchImpl,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
      clock: { now: () => now },
    }),
    calls,
    sleeps,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    operation: "list-sessions",
    method: "GET",
    url: new URL("https://api.example/api/sessions/v2"),
    timeoutMs: 1000,
    ...overrides,
  };
}

test("the default policy is exactly one request (B33)", async () => {
  const testHarness = harness([jsonResponse({ ok: true })]);
  const response = await testHarness.client.request(request());
  assert.equal(response.status, 200);
  assert.equal(response.attempts, 1);
  assert.equal(testHarness.calls.length, 1);
});

test("one request, no retry: a 500 becomes FetchError with the status and body", async () => {
  const testHarness = harness([new Response("boom", { status: 500 })]);
  await assert.rejects(
    testHarness.client.request(request()),
    (error: unknown) => {
      assert.ok(error instanceof FetchError);
      assert.equal(error.message, "500 boom");
      assert.equal(error.statusCode, 500);
      assert.equal(error.operation, "list-sessions");
      assert.equal(error.droideBackend, true);
      assert.equal(error.requestUrl, "https://api.example/api/sessions/v2");
      return true;
    },
  );
  assert.equal(testHarness.calls.length, 1);
});

test("an empty error body reads as `<status> Fetch failed`", async () => {
  const testHarness = harness([new Response("", { status: 503 })]);
  await assert.rejects(
    testHarness.client.request(request()),
    (error: unknown) =>
      error instanceof FetchError && error.message === "503 Fetch failed",
  );
});

test("REFRESH_RETRY: 5xx retries at 500/1000/1500 ms and stops at four attempts", async () => {
  const testHarness = harness([
    new Response("a", { status: 500 }),
    new Response("b", { status: 502 }),
    new Response("c", { status: 503 }),
    new Response("d", { status: 529 }),
  ]);
  await assert.rejects(
    testHarness.client.request(
      request({
        method: "POST",
        idempotent: true,
        retry: REFRESH_RETRY,
        url: new URL("https://api.example/auth/refresh"),
      }),
    ),
    FetchError,
  );
  assert.deepEqual(testHarness.sleeps, [500, 1000, 1500]);
  assert.equal(testHarness.calls.length, 4);
});

test("a retry that succeeds reports the attempt count actually used", async () => {
  const policy: RetryPolicy = {
    maxAttempts: 4,
    backoff: { kind: "linear", stepMs: 500 },
    jitter: 0,
  };
  const testHarness = harness([
    new Response("busy", { status: 503 }),
    new Response("busy", { status: 503 }),
    jsonResponse({ ok: true }),
  ]);
  const response = await testHarness.client.request(request({ retry: policy }));
  assert.equal(response.status, 200);
  assert.equal(response.attempts, 3);
  assert.deepEqual(testHarness.sleeps, [500, 1000]);
});

test("Retry-After is honoured as a minimum delay", async () => {
  const policy: RetryPolicy = {
    maxAttempts: 2,
    backoff: { kind: "linear", stepMs: 100 },
    jitter: 0,
  };
  const testHarness = harness([
    new Response("slow down", {
      status: 429,
      headers: { "retry-after": "2" },
    }),
    jsonResponse({ ok: true }),
  ]);
  await testHarness.client.request(request({ retry: policy }));
  assert.deepEqual(testHarness.sleeps, [2000]);
});

test("retry-after-ms is read in milliseconds", async () => {
  const policy: RetryPolicy = {
    maxAttempts: 2,
    backoff: { kind: "linear", stepMs: 100 },
    jitter: 0,
  };
  const testHarness = harness([
    new Response("slow down", {
      status: 429,
      headers: { "retry-after-ms": "750" },
    }),
    jsonResponse({ ok: true }),
  ]);
  await testHarness.client.request(request({ retry: policy }));
  assert.deepEqual(testHarness.sleeps, [750]);
});

test("an HTTP-date Retry-After is read against the injected clock", () => {
  const headers = new Headers({
    "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
  });
  const now = Date.parse("Wed, 21 Oct 2015 07:27:58 GMT");
  assert.equal(parseRetryAfter(headers, now), 2000);
  assert.equal(parseRetryAfter(new Headers(), now), null);
  assert.equal(
    parseRetryAfter(new Headers({ "retry-after": "not-a-date" }), now),
    null,
  );
});

test("a 401 is never retried, even under a retry policy", async () => {
  const testHarness = harness([
    new Response("unauthorized", { status: 401 }),
    jsonResponse({ ok: true }),
  ]);
  await assert.rejects(
    testHarness.client.request(request({ retry: REFRESH_RETRY })),
    FetchError,
  );
  assert.equal(testHarness.calls.length, 1);
  assert.deepEqual(testHarness.sleeps, []);
});

test("a non-idempotent POST is not retried unless it opts in", async () => {
  const policy: RetryPolicy = {
    maxAttempts: 3,
    backoff: { kind: "linear", stepMs: 500 },
    jitter: 0,
  };
  const testHarness = harness([
    new Response("x", { status: 503 }),
    new Response("y", { status: 503 }),
  ]);
  await assert.rejects(
    testHarness.client.request(
      request({ method: "POST", retry: policy, body: "{}" }),
    ),
    FetchError,
  );
  assert.equal(testHarness.calls.length, 1);
  assert.deepEqual(testHarness.sleeps, []);
});

test("only 429 and 5xx are retryable statuses", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
});

test("exponential backoff grows by the factor and is capped", () => {
  const policy: RetryPolicy = {
    maxAttempts: 5,
    backoff: { kind: "exponential", baseMs: 3000, factor: 1.5, maxMs: 15000 },
    jitter: 0,
  };
  assert.deepEqual(
    [1, 2, 3, 4].map((retry) => retryDelayMs(policy, retry)),
    [3000, 4500, 6750, 10125],
  );
  const capped: RetryPolicy = {
    maxAttempts: 8,
    backoff: { kind: "exponential", baseMs: 3000, factor: 2, maxMs: 15000 },
    jitter: 0,
  };
  assert.equal(retryDelayMs(capped, 5), 15000);
  assert.equal(NO_RETRY.maxAttempts, 1);
});

test("a response over the byte cap is refused before it is fully read", async () => {
  const testHarness = harness([
    new Response("0123456789abcdefghij", { status: 200 }),
  ]);
  await assert.rejects(
    testHarness.client.request(request({ maxResponseBytes: 10 })),
    (error: unknown) =>
      error instanceof ResponseTooLargeError && error.limitBytes === 10,
  );
});

test("requestJson validates the body and returns the parsed value", async () => {
  const testHarness = harness([
    jsonResponse({ value: "yes" }),
    jsonResponse({ value: "yes" }),
  ]);
  const parsed = await testHarness.client.requestJson(request(), (value) => {
    if (!isRecord(value)) {
      throw new Error("not an object");
    }
    return readString(value, "value");
  });
  assert.equal(parsed.value, "yes");
  assert.equal(parsed.response.status, 200);
});

test("requestJson refuses invalid JSON and an empty body without quoting them", async () => {
  const invalid = harness([new Response("{not json", { status: 200 })]);
  await assert.rejects(
    invalid.client.requestJson(request(), () => null),
    (error: unknown) =>
      error instanceof InvalidResponseError &&
      error.detail === "not valid JSON",
  );

  const empty = harness([new Response("", { status: 200 })]);
  await assert.rejects(
    empty.client.requestJson(request(), () => null),
    (error: unknown) =>
      error instanceof InvalidResponseError && error.detail === "empty body",
  );
});

test("a transport failure maps to TransportNetworkError with its code", async () => {
  const cause = Object.assign(new Error("connect failed"), {
    code: "ECONNREFUSED",
  });
  const testHarness = harness([
    () => Promise.reject(new TypeError("fetch failed", { cause })),
  ]);
  await assert.rejects(
    testHarness.client.request(request()),
    (error: unknown) =>
      error instanceof TransportNetworkError && error.code === "ECONNREFUSED",
  );
});

test("a certificate failure maps to TlsTrustError, never to a retry", async () => {
  const cause = Object.assign(new Error("cert"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });
  const testHarness = harness([
    () => Promise.reject(new TypeError("fetch failed", { cause })),
  ]);
  await assert.rejects(
    testHarness.client.request(request()),
    (error: unknown) =>
      error instanceof TlsTrustError &&
      error.code === "SELF_SIGNED_CERT_IN_CHAIN",
  );
});

test("the request deadline aborts the exchange with a typed timeout", async () => {
  const fetchImpl: FetchLike = (_url, init) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    const signal = init.signal;
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
    return promise;
  };
  const client = new HttpClient({
    fetch: fetchImpl,
    sleep: async () => {},
    clock: { now: () => 0 },
  });
  await assert.rejects(
    client.request(request({ timeoutMs: 5 })),
    (error: unknown) =>
      error instanceof TransportTimeoutError && error.timeoutMs === 5,
  );
});

test("a same-origin redirect is followed", async () => {
  const testHarness = harness([
    new Response(null, { status: 302, headers: { location: "/next" } }),
    jsonResponse({ ok: true }),
  ]);
  const response = await testHarness.client.request(request());
  assert.equal(response.status, 200);
  assert.equal(new URL(response.url).pathname, "/next");
  assert.equal(testHarness.calls.length, 2);
  assert.equal(
    new URL(testHarness.calls[1]?.url ?? "").href,
    "https://api.example/next",
  );
});

test("a redirect to another origin is refused before the second request", async () => {
  const testHarness = harness([
    new Response(null, {
      status: 307,
      headers: { location: "https://evil.example/steal" },
    }),
  ]);
  await assert.rejects(
    testHarness.client.request(request()),
    (error: unknown) =>
      error instanceof UnsafeRedirectError &&
      error.targetOrigin === "https://evil.example",
  );
  assert.equal(testHarness.calls.length, 1);
});

test("a customer deployment refuses every redirect", async () => {
  const testHarness = harness([
    new Response(null, { status: 302, headers: { location: "/next" } }),
  ]);
  await assert.rejects(
    testHarness.client.request(request({ redirects: "refuse" })),
    UnsafeRedirectError,
  );
  assert.equal(testHarness.calls.length, 1);
});

test("a customer-deployment failure quotes the status only, never the body", async () => {
  const testHarness = harness([
    new Response("secret user content", { status: 500 }),
  ]);
  await assert.rejects(
    testHarness.client.request(
      request({ customerDeployment: true, redirects: "refuse" }),
    ),
    (error: unknown) =>
      error instanceof FetchError &&
      error.message === "Customer request failed" &&
      !error.message.includes("secret"),
  );
});

test("error paths carry redacted request headers and never the token", async () => {
  const testHarness = harness([new Response("nope", { status: 500 })]);
  await assert.rejects(
    testHarness.client.request(
      request({
        headers: {
          Authorization: "Bearer super-secret",
          "X-Droide-Org-Id": "org",
        },
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof FetchError);
      assert.equal(error.requestHeaders.Authorization, REDACTED);
      assert.equal(error.requestHeaders["X-Droide-Org-Id"], "org");
      assert.equal(
        JSON.stringify(error.requestHeaders).includes("super-secret"),
        false,
      );
      assert.equal(error.message.includes("super-secret"), false);
      return true;
    },
  );
  // The actual request still carried the credential.
  const sent = testHarness.calls[0]?.init.headers;
  assert.deepEqual(sent, {
    Authorization: "Bearer super-secret",
    "X-Droide-Org-Id": "org",
  });
});

test("request headers are sent verbatim, bodies only when provided", async () => {
  const testHarness = harness([
    jsonResponse({ ok: true }),
    jsonResponse({ ok: true }),
  ]);
  await testHarness.client.request(
    request({ method: "GET", headers: { "X-Droide-Client": "cli" } }),
  );
  assert.equal(testHarness.calls[0]?.init.body, undefined);
  assert.equal(testHarness.calls[0]?.init.credentials, "omit");
  assert.equal(testHarness.calls[0]?.init.redirect, "manual");

  await testHarness.client.request(
    request({
      method: "POST",
      body: '{"a":1}',
      headers: { "Content-Type": "application/json" },
    }),
  );
  assert.equal(testHarness.calls[1]?.init.body, '{"a":1}');
});
