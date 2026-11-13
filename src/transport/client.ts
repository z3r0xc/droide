/**
 * The HTTP boundary. Contract: `specs/50-transport-and-auth.md` B33–B38 and
 * §B's request attributes (B19, B91).
 *
 * Deliberate default: **one request, no retry** — B33 says the ordinary backend
 * boundary performs exactly one `fetch` and has no retry of its own. A caller
 * opts in to retries by passing a {@link RetryPolicy}; even then only an
 * idempotent request is retried, and only for 429/5xx (never a 4xx auth
 * failure). A server `Retry-After` is a *minimum* delay. The sleeper is
 * injected, so a test asserts the exact delays without waiting.
 *
 * Every request carries a deadline. Bodies are read through a byte cap, are
 * never trusted, and are only turned into a value by a caller-supplied
 * validator. Redirects are followed manually so a downgrade to `http:` or a
 * move to another origin is refused before the new request is sent.
 */

import {
  FetchError,
  InvalidResponseError,
  RequestAbortedError,
  ResponseTooLargeError,
  TransportError,
  TransportNetworkError,
  TransportTimeoutError,
  TlsTrustError,
  UnsafeRedirectError,
  type RedactedHeaders,
} from "./errors.ts";
import { redactHeaders } from "./headers.ts";

/** Injected HTTP client; the process global `fetch` is the production value. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

/** Injected delay; production uses a timer, tests record the delay. */
export type Sleeper = (delayMs: number) => Promise<void>;

/** Injected clock, read only for an HTTP-date `Retry-After`. */
export interface Clock {
  readonly now: () => number;
}

/** Default cap for one response body. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Redirect hops one logical attempt may follow. */
export const MAX_REDIRECTS = 5;

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Delay growth between attempts. */
export type RetryBackoff =
  /** `stepMs × retryNumber`: B38's 500 ms, 1000 ms, 1500 ms. */
  | { readonly kind: "linear"; readonly stepMs: number }
  | {
      readonly kind: "exponential";
      readonly baseMs: number;
      readonly factor: number;
      readonly maxMs: number;
    };

export interface RetryPolicy {
  /** Total attempts; 1 means one request and no retry (B33). */
  readonly maxAttempts: number;
  readonly backoff: RetryBackoff;
  /** Fraction of the delay that may be added; `0` is deterministic. */
  readonly jitter: number;
}

/** B33: the ordinary backend boundary. */
export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  backoff: { kind: "linear", stepMs: 0 },
  jitter: 0,
};

/** B38: a transient WorkOS refresh — at most three retries, 500 ms × attempt. */
export const REFRESH_RETRY: RetryPolicy = {
  maxAttempts: 4,
  backoff: { kind: "linear", stepMs: 500 },
  jitter: 0,
};

/** `retryNumber` is 1-based: the wait before the second request is 1. */
export function retryDelayMs(
  policy: RetryPolicy,
  retryNumber: number,
  random: () => number = () => 0,
): number {
  const backoff = policy.backoff;
  const base =
    backoff.kind === "linear"
      ? backoff.stepMs * retryNumber
      : Math.min(
          backoff.maxMs,
          backoff.baseMs * backoff.factor ** (retryNumber - 1),
        );
  const jitter = Math.max(0, policy.jitter) * random();
  return Math.round(base * (1 + jitter));
}

/** 429 and 5xx are the only statuses a retry may repeat (B37/B41). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * B41: `retry-after-ms` in milliseconds, else `retry-after` in seconds or as
 * an HTTP date. Non-positive or unparseable values are ignored.
 *
 * The Anthropic pair (`anthropic-ratelimit-tokens-remaining` = 0 with
 * `anthropic-ratelimit-tokens-reset` as an HTTP date) is used only when both
 * `retry-after` spellings are absent, and only while tokens remain at zero.
 */
export function parseRetryAfter(headers: Headers, now: number): number | null {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const value = Number.parseInt(milliseconds, 10);
    if (Number.isFinite(value)) {
      return Math.max(0, value);
    }
  }
  const after = headers.get("retry-after");
  if (after === null) {
    return resetDelayFromAnthropicPair(headers, now);
  }
  const trimmed = after.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, date - now);
}

/**
 * B41's fallback: a provider that reports a zero token budget and a reset time
 * instead of a `retry-after`. A non-zero remaining count, a missing or
 * unparseable reset, or a reset in the past yields `null` so the caller keeps
 * its own backoff.
 */
function resetDelayFromAnthropicPair(headers: Headers, now: number): number | null {
  const remaining = headers.get("anthropic-ratelimit-tokens-remaining");
  if (remaining === null || remaining.trim() !== "0") return null;
  const reset = headers.get("anthropic-ratelimit-tokens-reset");
  if (reset === null) return null;
  const at = Date.parse(reset.trim());
  if (Number.isNaN(at) || at <= now) return null;
  return at - now;
}

export interface HttpRequest {
  /** Stable operation label used in every error message. */
  readonly operation: string;
  readonly method: HttpMethod;
  readonly url: URL;
  /** Already built (see `headers.ts`); redacted before any error carries it. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Whole-exchange deadline for one attempt, including the body (B34–B36). */
  readonly timeoutMs: number;
  readonly maxResponseBytes?: number;
  readonly retry?: RetryPolicy;
  /** Defaults to true for GET/HEAD; a POST redemption opts in explicitly (B38). */
  readonly idempotent?: boolean;
  /** Defaults to refusing anything but a same-origin `https:` hop; B91 uses `refuse`. */
  readonly redirects?: "same-origin" | "refuse";
  /** B93: a customer-deployment failure quotes the status only, never the body. */
  readonly customerDeployment?: boolean;
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly operation: string;
  readonly status: number;
  readonly headers: Headers;
  /** Decoded body; already bounded by the cap. */
  readonly body: string;
  readonly url: URL;
  /** Logical requests made, including retries; redirect hops are not counted. */
  readonly attempts: number;
}

export interface HttpJsonResponse<T> {
  readonly response: HttpResponse;
  readonly value: T;
}

export interface HttpClientOptions {
  readonly fetch: FetchLike;
  readonly sleep: Sleeper;
  readonly clock: Clock;
  /** Jitter source; defaults to no jitter so tests are deterministic. */
  readonly random?: () => number;
}

const REDIRECT_STATUSES: Readonly<Record<number, true>> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

const TLS_TRUST_CODES: Readonly<Record<string, true>> = {
  CERT_HAS_EXPIRED: true,
  CERT_NOT_YET_VALID: true,
  DEPTH_ZERO_SELF_SIGNED_CERT: true,
  SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_GET_ISSUER_CERT: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
};

/** First `code` on the error or its `cause` chain, without a cast at the use site. */
function errorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return null;
    }
    if ("code" in current) {
      const code: unknown = current.code;
      if (typeof code === "string") {
        return code;
      }
    }
    if (!("cause" in current)) {
      return null;
    }
    current = current.cause;
  }
  return null;
}

function mapFetchFailure(
  error: unknown,
  operation: string,
  timeoutMs: number,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  requestHeaders: RedactedHeaders,
): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  if (timeoutSignal.aborted) {
    return new TransportTimeoutError(operation, timeoutMs, { requestHeaders });
  }
  if (callerSignal?.aborted === true) {
    return new RequestAbortedError(operation, { requestHeaders });
  }
  const code = errorCode(error);
  if (code !== null && TLS_TRUST_CODES[code] === true) {
    return new TlsTrustError(operation, code, { requestHeaders, cause: error });
  }
  return new TransportNetworkError(operation, code, {
    requestHeaders,
    cause: error,
  });
}

async function readBoundedBody(
  response: Response,
  limit: number,
  operation: string,
  requestHeaders: RedactedHeaders,
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {
          // Already closed.
        });
        throw new ResponseTooLargeError(operation, limit, { requestHeaders });
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

interface AttemptResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  readonly url: URL;
}

/**
 * A small HTTP client over injected inputs. Construction never touches the
 * network; `request` performs exactly the attempts its policy allows.
 */
export class HttpClient {
  readonly #options: HttpClientOptions;

  constructor(options: HttpClientOptions) {
    this.#options = options;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    if (!(request.timeoutMs > 0)) {
      throw new RangeError(
        "timeoutMs must be a positive number of milliseconds",
      );
    }
    const policy = request.retry ?? NO_RETRY;
    const idempotent =
      request.idempotent ??
      (request.method === "GET" || request.method === "HEAD");
    const requestHeaders = redactHeaders(request.headers ?? {});
    const maxResponseBytes = request.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    const random = this.#options.random ?? (() => 0);

    let attempt = 0;
    while (attempt < policy.maxAttempts) {
      attempt += 1;
      const result = await this.#attempt(
        {
          ...request,
          redirects:
            request.redirects ??
            (request.customerDeployment === true ? "refuse" : "same-origin"),
        },
        requestHeaders,
        maxResponseBytes,
      );

      if (result.status >= 200 && result.status < 300) {
        return {
          operation: request.operation,
          status: result.status,
          headers: result.headers,
          body: result.body,
          url: result.url,
          attempts: attempt,
        };
      }

      if (
        idempotent &&
        isRetryableStatus(result.status) &&
        attempt < policy.maxAttempts
      ) {
        const serverDelay = parseRetryAfter(
          result.headers,
          this.#options.clock.now(),
        );
        const computed = retryDelayMs(policy, attempt, random);
        await this.#options.sleep(Math.max(computed, serverDelay ?? 0));
        continue;
      }

      throw new FetchError(result.status, result.body, request.operation, {
        requestUrl: result.url,
        requestHeaders,
        customerDeployment: request.customerDeployment === true,
      });
    }

    // Unreachable: the loop either returns or throws. Kept total for the type.
    throw new TransportError(
      `${request.operation}: the request produced no response.`,
      request.operation,
    );
  }

  /**
   * One logical request, following only a same-origin `https:` redirect. The
   * deadline covers every hop; the body of a redirect response is cancelled so
   * the connection is released.
   */
  async #attempt(
    request: HttpRequest,
    requestHeaders: RedactedHeaders,
    maxResponseBytes: number,
  ): Promise<AttemptResult> {
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
    const signal =
      request.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([request.signal, timeoutSignal]);

    const rawHeaders = request.headers ?? {};
    let url = request.url;
    let method: HttpMethod = request.method;
    let body = request.body;
    let hops = 0;

    while (true) {
      let response: Response;
      try {
        response = await this.#options.fetch(url, {
          method,
          headers: rawHeaders,
          ...(body === undefined ? {} : { body }),
          signal,
          redirect: "manual",
          credentials: request.credentials ?? "omit",
        });
      } catch (error) {
        throw mapFetchFailure(
          error,
          request.operation,
          request.timeoutMs,
          timeoutSignal,
          request.signal,
          requestHeaders,
        );
      }

      const status = response.status;
      if (REDIRECT_STATUSES[status] === true) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {
          // Nothing to release.
        });
        if (location === null) {
          throw new TransportError(
            `${request.operation}: the server returned ${status} without a Location.`,
            request.operation,
            { requestHeaders },
          );
        }
        let target: URL;
        try {
          target = new URL(location, url);
        } catch {
          throw new TransportError(
            `${request.operation}: the server returned an unusable Location.`,
            request.operation,
            { requestHeaders },
          );
        }
        if (
          request.redirects === "refuse" ||
          target.origin !== url.origin ||
          (url.protocol === "https:" && target.protocol !== "https:")
        ) {
          throw new UnsafeRedirectError(request.operation, target.origin, {
            requestHeaders,
          });
        }
        hops += 1;
        if (hops > MAX_REDIRECTS) {
          throw new TransportError(
            `${request.operation}: too many redirects (limit ${MAX_REDIRECTS}).`,
            request.operation,
            { requestHeaders },
          );
        }
        if (
          status === 303 ||
          ((status === 301 || status === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
        }
        url = target;
        continue;
      }

      let text: string;
      try {
        text = await readBoundedBody(
          response,
          maxResponseBytes,
          request.operation,
          requestHeaders,
        );
      } catch (error) {
        throw mapFetchFailure(
          error,
          request.operation,
          request.timeoutMs,
          timeoutSignal,
          request.signal,
          requestHeaders,
        );
      }

      return { status, headers: response.headers, body: text, url };
    }
  }

  /**
   * Read and parse a JSON body. The body is untrusted: `parse` must validate
   * and narrow it, and its typed failure propagates unchanged.
   */
  async requestJson<T>(
    request: HttpRequest,
    parse: (value: unknown) => T,
  ): Promise<HttpJsonResponse<T>> {
    const response = await this.request(request);
    if (response.body.trim() === "") {
      throw new InvalidResponseError(request.operation, "empty body", {
        requestHeaders: redactHeaders(request.headers ?? {}),
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new InvalidResponseError(request.operation, "not valid JSON", {
        requestHeaders: redactHeaders(request.headers ?? {}),
      });
    }
    return { response, value: parse(value) };
  }
}
