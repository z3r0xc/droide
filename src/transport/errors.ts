/**
 * Typed failures at the transport boundary. Contract:
 * `specs/50-transport-and-auth.md` §I (B92–B104) and §D (B37–B44).
 *
 * Three rules shape every class here:
 *
 * - **Identity over text.** Callers switch on the class (and on `reason` /
 *   `statusCode`), never on a message string, so a wording change cannot change
 *   behaviour.
 * - **No secrets.** A response body is untrusted input and a request carries a
 *   bearer token. Messages quote a bounded prefix of a *hosted* body (required
 *   by B92), never a customer-Prem body (B93), never request headers (the
 *   `requestHeaders` a `FetchError` carries are already redacted), and never a
 *   URL's query or credentials.
 * - **The operation is named.** Every message begins with the operation the
 *   caller asked for, so a failure never reads as "something, somewhere".
 */

/** Stable label of the request that failed, e.g. `list-sessions`. */
export type Operation = string;

/** Header record that has already passed through `redactHeaders`. */
export type RedactedHeaders = Readonly<Record<string, string>>;

export interface TransportErrorOptions {
  readonly cause?: unknown;
  readonly requestHeaders?: RedactedHeaders;
}

function causeOption(cause: unknown): { cause: unknown } | undefined {
  return cause === undefined ? undefined : { cause };
}

/** Base class: every transport failure can be caught as one kind. */
export class TransportError extends Error {
  readonly operation: Operation;
  /** Request headers with credentials replaced; safe to log. */
  readonly requestHeaders: RedactedHeaders;

  constructor(
    message: string,
    operation: Operation,
    options: TransportErrorOptions = {},
  ) {
    super(message, causeOption(options.cause));
    this.name = "TransportError";
    this.operation = operation;
    this.requestHeaders = options.requestHeaders ?? {};
  }
}

/**
 * No HTTP exchange happened: DNS, TCP, TLS handshake or proxy failure. `code`
 * is the platform's short code (`ECONNREFUSED`, `ENOTFOUND`, …) or `null`;
 * the platform's prose is never copied in (it can echo a proxy URL).
 */
export class TransportNetworkError extends TransportError {
  readonly code: string | null;

  constructor(
    operation: Operation,
    code: string | null,
    options: TransportErrorOptions = {},
  ) {
    super(
      `${operation}: the server could not be reached${code === null ? "" : ` (${code})`}. Check network or proxy access and try again.`,
      operation,
      options,
    );
    this.name = "TransportNetworkError";
    this.code = code;
  }
}

/**
 * The certificate chain was not trusted (B88). Trust material is never
 * bypassed: the message points at the supported remediation instead.
 *
 * TODO(spec B88): the spec quotes only the `certificate chain not trusted: …`
 * prefix and the two remediations; the exact full sentence is not quoted.
 */
export class TlsTrustError extends TransportError {
  readonly code: string | null;

  constructor(
    operation: Operation,
    code: string | null,
    options: TransportErrorOptions = {},
  ) {
    super(
      `${operation}: certificate chain not trusted${code === null ? "" : `: ${code}`}. Export the appliance root CA (PEM) and point FACTORY_EXTRA_CA_CERTS at it, or delete the certificate cache under the Factory directory on Windows.`,
      operation,
      options,
    );
    this.name = "TlsTrustError";
    this.code = code;
  }
}

/** The request's own deadline elapsed (B34–B36). */
export class TransportTimeoutError extends TransportError {
  readonly timeoutMs: number;

  constructor(
    operation: Operation,
    timeoutMs: number,
    options: TransportErrorOptions = {},
  ) {
    super(`${operation}: no response within ${timeoutMs} ms.`, operation, {
      ...options,
    });
    this.name = "TransportTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's signal aborted before the exchange completed. */
export class RequestAbortedError extends TransportError {
  constructor(operation: Operation, options: TransportErrorOptions = {}) {
    super(`${operation}: request aborted.`, operation, options);
    this.name = "RequestAbortedError";
  }
}

/**
 * A redirect would leave HTTPS or the configured origin. The target is
 * reported by origin only (never a path or query that could carry a token).
 */
export class UnsafeRedirectError extends TransportError {
  readonly targetOrigin: string;

  constructor(
    operation: Operation,
    targetOrigin: string,
    options: TransportErrorOptions = {},
  ) {
    super(
      `${operation}: refused a redirect to ${targetOrigin} because it leaves the configured origin or downgrades HTTPS.`,
      operation,
      options,
    );
    this.name = "UnsafeRedirectError";
    this.targetOrigin = targetOrigin;
  }
}

/** The body exceeded the documented byte cap before it could be read. */
export class ResponseTooLargeError extends TransportError {
  readonly limitBytes: number;

  constructor(
    operation: Operation,
    limitBytes: number,
    options: TransportErrorOptions = {},
  ) {
    super(
      `${operation}: response body exceeded the ${limitBytes}-byte limit.`,
      operation,
      options,
    );
    this.name = "ResponseTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * A 2xx body could not be used: empty, not JSON, or not the shape the caller
 * validated. `detail` describes *why*, never the payload (B111's rule for
 * stream payloads applies to every untrusted body).
 */
export class InvalidResponseError extends TransportError {
  readonly detail: string;

  constructor(
    operation: Operation,
    detail: string,
    options: TransportErrorOptions = {},
  ) {
    super(
      `${operation}: the server response was unusable (${detail}).`,
      operation,
      options,
    );
    this.name = "InvalidResponseError";
    this.detail = detail;
  }
}

/** Longest hosted body prefix quoted in a `FetchError` message (B92). */
export const MAX_ERROR_BODY_CHARS = 2048;

export interface FetchErrorInit extends TransportErrorOptions {
  /** The request that failed, for the "factory backend" marker (B92). */
  readonly requestUrl?: URL;
  /** B92's factory-backend marker; defaults to `true`. */
  readonly factoryBackend?: boolean;
  /** B93: customer bodies may carry secrets or user content, so they are not quoted. */
  readonly customerDeployment?: boolean;
}

function boundedBody(body: string): string {
  return body.length > MAX_ERROR_BODY_CHARS
    ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…`
    : body;
}

/** Origin and path only: a query string may carry a token, so it is dropped. */
function safeUrl(url: URL | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  return `${url.origin}${url.pathname}`;
}

/**
 * A non-2xx backend response (B92/B93). The message is contract data:
 * `<status> <body>` on the hosted path, `<status> Fetch failed` for an empty
 * body, and exactly `Customer request failed` on a customer deployment.
 * `operation` is carried as a field for display; it is not part of the fixed
 * message because the spec pins that string.
 */
export class FetchError extends Error {
  readonly statusCode: number;
  readonly operation: Operation;
  readonly requestUrl: string | null;
  readonly factoryBackend: boolean;
  readonly requestHeaders: RedactedHeaders;

  constructor(
    statusCode: number,
    body: string,
    operation: Operation,
    init: FetchErrorInit = {},
  ) {
    const message =
      init.customerDeployment === true
        ? "Customer request failed"
        : body.length === 0
          ? `${statusCode} Fetch failed`
          : `${statusCode} ${boundedBody(body)}`;
    super(message, causeOption(init.cause));
    this.name = "FetchError";
    this.statusCode = statusCode;
    this.operation = operation;
    this.requestUrl = safeUrl(init.requestUrl);
    this.factoryBackend = init.factoryBackend ?? true;
    this.requestHeaders = init.requestHeaders ?? {};
  }
}

/**
 * A status-carrying backend/proxy error (B94). `retryAfterSeconds` is the
 * server's instruction, already parsed; the retry policy still owns the delay.
 */
export interface ResponseErrorOptions extends TransportErrorOptions {
  readonly code?: string | null;
  readonly retryAfterSeconds?: number | null;
  readonly title?: string;
}

/** B94's public response body: `{detail, status, title}` plus `code`. */
export interface ResponseErrorPublicObject {
  readonly detail: string;
  readonly status: number | null;
  readonly title: string;
  readonly code?: string;
}

export class ResponseError extends TransportError {
  readonly statusCode: number | null;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly title: string;

  constructor(
    message: string,
    statusCode: number | null,
    operation: Operation,
    options: ResponseErrorOptions = {},
  ) {
    super(message, operation, options);
    this.name = "ResponseError";
    this.statusCode = statusCode;
    this.code = options.code ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.title = options.title ?? "Request failed";
  }

  /** B94: `{detail, status, title}` plus `code` when public. */
  toPublicObject(): ResponseErrorPublicObject {
    const base = {
      detail: this.message,
      status: this.statusCode,
      title: this.title,
    };
    return this.code === null ? base : { ...base, code: this.code };
  }

  /** B94: `displayToUser` metadata repeats the same fields under `error`. */
  toDisplayObject(): { readonly error: ResponseErrorPublicObject } {
    return { error: this.toPublicObject() };
  }
}

export class ResponseError400BadRequest extends ResponseError {
  constructor(
    message: string,
    operation: Operation,
    options: ResponseErrorOptions = {},
  ) {
    super(message, 400, operation, { ...options, title: "Bad Request" });
    this.name = "ResponseError400BadRequest";
  }
}

export class ResponseError401Unauthorized extends ResponseError {
  constructor(
    message: string,
    operation: Operation,
    options: ResponseErrorOptions = {},
  ) {
    super(message, 401, operation, { ...options, title: "Unauthorized" });
    this.name = "ResponseError401Unauthorized";
  }
}

export class ResponseError403Forbidden extends ResponseError {
  constructor(
    message: string,
    operation: Operation,
    options: ResponseErrorOptions = {},
  ) {
    super(message, 403, operation, { ...options, title: "Forbidden" });
    this.name = "ResponseError403Forbidden";
  }
}

/** Copy the spec fixes verbatim (B95, B97). */
export const AUTH_MESSAGES = {
  notAuthenticated:
    "Not authenticated. Please log in using /login or set a valid FACTORY_API_KEY environment variable.",
  invalidApiKey:
    "Authentication failed. FACTORY_API_KEY is set but appears to be invalid. Unset it or replace it with a valid key.",
  apiUnavailable:
    "FACTORY_API_KEY could not be validated because the Factory API is not accessible. Check network or proxy access and try again.",
  validationFailed:
    "FACTORY_API_KEY validation failed. Try again or contact support if the problem continues.",
  apiKeyRejected: "Factory API key was rejected.",
  customerLoginRequired: "Sign in to this customer deployment.",
  customerOrganizationRequired:
    "Choose an organization for this customer deployment.",
  notAuthenticatedTitle: "Not authenticated.",
} as const;

/** No credential resolved at all; a sign-in (or key) is the only remedy. */
export class AuthenticationError extends TransportError {
  constructor(
    operation: Operation,
    message: string = AUTH_MESSAGES.notAuthenticated,
    options: TransportErrorOptions = {},
  ) {
    super(message, operation, options);
    this.name = "AuthenticationError";
  }
}

/** A Factory-bound request may not leave the process in airgap (B89). */
export const AIRGAP_BLOCKED_MESSAGE =
  "Outbound request blocked because Airgap Mode is enabled; only BYOK, MCP, and marketplaces are permitted.";

export class AirgapBlockedError extends TransportError {
  constructor(operation: Operation, options: TransportErrorOptions = {}) {
    super(AIRGAP_BLOCKED_MESSAGE, operation, options);
    this.name = "AirgapBlockedError";
  }
}

/**
 * A route hosted by the Factory control plane was asked for on a customer
 * deployment (B30/B90). The message is contract data.
 */
export class DeploymentUnavailableError extends TransportError {
  constructor(
    operation: Operation,
    kind: "hosted" | "route",
    options: TransportErrorOptions = {},
  ) {
    super(
      kind === "hosted"
        ? "This hosted operation is unavailable on customer deployments."
        : "This operation is unavailable on customer deployments.",
      operation,
      options,
    );
    this.name = "DeploymentUnavailableError";
  }
}

/**
 * B95: the status-to-class table for a rejected verification. 400, 401 and 403
 * are the three rejection identities; any other status is not a key rejection
 * and returns `null` so the caller applies B96's classification.
 */
export function apiKeyRejectionError(
  status: number,
  operation: Operation,
  options: ResponseErrorOptions = {},
):
  | ResponseError400BadRequest
  | ResponseError401Unauthorized
  | ResponseError403Forbidden
  | null {
  switch (status) {
    case 400:
      return new ResponseError400BadRequest(
        AUTH_MESSAGES.apiKeyRejected,
        operation,
        options,
      );
    case 401:
      return new ResponseError401Unauthorized(
        AUTH_MESSAGES.apiKeyRejected,
        operation,
        options,
      );
    case 403:
      return new ResponseError403Forbidden(
        AUTH_MESSAGES.apiKeyRejected,
        operation,
        options,
      );
    default:
      return null;
  }
}

/** B96's three outcomes, spelled as the spec spells them. */
export type ApiKeyValidationReason =
  "apiKeyRejected" | "FactoryApiUnavailable" | "FactoryApiValidationFailed";

export interface ApiKeyValidationFailure {
  readonly reason: ApiKeyValidationReason;
  readonly message: string;
}

function statusOf(error: unknown): number | null {
  if (error instanceof FetchError) {
    return error.statusCode;
  }
  if (error instanceof ResponseError) {
    return error.statusCode;
  }
  return null;
}

/**
 * B95/B96: classify a failed API-key verification. 400/401/403 are a rejected
 * key; 5xx and transport failures mean the API could not answer; everything
 * else (including a malformed 2xx, which carries no status) is a validation
 * failure.
 */
export function classifyApiKeyValidationFailure(
  error: unknown,
): ApiKeyValidationFailure {
  if (
    error instanceof TransportNetworkError ||
    error instanceof TlsTrustError
  ) {
    return {
      reason: "FactoryApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    };
  }
  if (error instanceof TransportTimeoutError) {
    return {
      reason: "FactoryApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    };
  }
  const status = statusOf(error);
  if (status === 400 || status === 401 || status === 403) {
    return {
      reason: "apiKeyRejected",
      message: AUTH_MESSAGES.apiKeyRejected,
    };
  }
  if (status !== null && status >= 500) {
    return {
      reason: "FactoryApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    };
  }
  if (status !== null) {
    return {
      reason: "FactoryApiValidationFailed",
      message: AUTH_MESSAGES.validationFailed,
    };
  }
  if (error instanceof ResponseError) {
    // A `ResponseError` without a status is a malformed 2xx (B96).
    return {
      reason: "FactoryApiValidationFailed",
      message: AUTH_MESSAGES.validationFailed,
    };
  }
  return {
    reason: "FactoryApiUnavailable",
    message: AUTH_MESSAGES.apiUnavailable,
  };
}

/* -------------------------------------------------------------------------- */
/* LLM stream failures (B101–B104)                                            */
/* -------------------------------------------------------------------------- */

/** B101's reason set, most specific classification first. */
export type LlmFailureReason =
  | "quota-exhausted"
  | "payment-required"
  | "content-moderation"
  | "context-limit"
  | "request-too-large"
  | "text-fields-too-large"
  | "invalid-request"
  | "authentication"
  | "forbidden"
  | "gone"
  | "throttling"
  | "overloaded"
  | "network"
  | "host-duration-limit"
  | "output-degeneration"
  | "internal-error"
  | "unknown";

/**
 * User-facing copy per class. B102 pins one message per class but the spec file
 * quotes none of them, so these are factual descriptions, not recoveries.
 *
 * TODO(spec B102): replace with the exact fixed copy from
 * `orig/packages/droid-core/src/llms/errors/constants.ts:1-44`.
 */
export const LLM_FAILURE_MESSAGES: Readonly<Record<LlmFailureReason, string>> =
  {
    "quota-exhausted":
      "The model provider quota for this account is exhausted.",
    "payment-required": "No active subscription found.",
    "content-moderation":
      "The model provider rejected the request under its content policy.",
    "context-limit": "The conversation exceeds the model's context window.",
    "request-too-large": "The request is too large for the model provider.",
    "text-fields-too-large":
      "One or more text fields in the request are larger than the model provider accepts.",
    "invalid-request": "The model provider rejected the request as invalid.",
    authentication: "The model provider rejected the credentials.",
    forbidden: "The model provider refused the request.",
    gone: "The requested model is no longer available from the provider.",
    throttling: "The model provider is throttling requests for this account.",
    overloaded: "The model provider is currently overloaded.",
    network:
      "The model provider could not be reached because of network issues.",
    "host-duration-limit":
      "The model provider stopped the request at its host duration limit.",
    "output-degeneration": "The model response degenerated and was stopped.",
    "internal-error": "The model provider reported an internal error.",
    unknown: "The model call failed for an unknown reason.",
  };

/** B103: retryability is part of the class, not a caller decision. */
const RETRYABLE_REASONS: Readonly<Partial<Record<LlmFailureReason, true>>> = {
  throttling: true,
  overloaded: true,
  network: true,
  "internal-error": true,
  "host-duration-limit": true,
  unknown: true,
};

export function isRetryableLlmReason(reason: LlmFailureReason): boolean {
  return RETRYABLE_REASONS[reason] === true;
}

export interface LlmErrorOptions extends TransportErrorOptions {
  readonly statusCode?: number | null;
  /** B41: server instruction, in milliseconds, never a substituted delay. */
  readonly retryAfterMs?: number | null;
}

export class LlmError extends TransportError {
  readonly reason: LlmFailureReason;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    reason: LlmFailureReason,
    operation: Operation,
    message: string,
    options: LlmErrorOptions = {},
  ) {
    super(message, operation, options);
    this.name = "LlmError";
    this.reason = reason;
    this.retryable = isRetryableLlmReason(reason);
    this.statusCode = options.statusCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function llmClass(
  name: string,
  reason: LlmFailureReason,
): new (operation: Operation, options?: LlmErrorOptions) => LlmError {
  return class extends LlmError {
    constructor(operation: Operation, options: LlmErrorOptions = {}) {
      super(reason, operation, LLM_FAILURE_MESSAGES[reason], options);
      this.name = name;
    }
  };
}

export const LlmQuotaExhaustedError = llmClass(
  "LlmQuotaExhaustedError",
  "quota-exhausted",
);
export const LlmPaymentRequiredError = llmClass(
  "LlmPaymentRequiredError",
  "payment-required",
);
export const LlmContentModerationError = llmClass(
  "LlmContentModerationError",
  "content-moderation",
);
export const LlmContextLimitError = llmClass(
  "LlmContextLimitError",
  "context-limit",
);
export const LlmRequestTooLargeError = llmClass(
  "LlmRequestTooLargeError",
  "request-too-large",
);
export const LlmTextFieldsTooLargeError = llmClass(
  "LlmTextFieldsTooLargeError",
  "text-fields-too-large",
);
export const LlmInvalidRequestError = llmClass(
  "LlmInvalidRequestError",
  "invalid-request",
);
export const LlmAuthenticationError = llmClass(
  "LlmAuthenticationError",
  "authentication",
);
export const LlmForbiddenError = llmClass("LlmForbiddenError", "forbidden");
export const LlmGoneError = llmClass("LlmGoneError", "gone");
export const LlmThrottlingError = llmClass("LlmThrottlingError", "throttling");
export const LlmOverloadedError = llmClass("LlmOverloadedError", "overloaded");
export const LlmNetworkError = llmClass("LlmNetworkError", "network");
export const LlmHostDurationLimitError = llmClass(
  "LlmHostDurationLimitError",
  "host-duration-limit",
);
export const LlmOutputDegenerationError = llmClass(
  "LlmOutputDegenerationError",
  "output-degeneration",
);
export const LlmInternalError = llmClass("LlmInternalError", "internal-error");
export const LlmUnknownError = llmClass("LlmUnknownError", "unknown");

/** A stream frame violated the SSE contract or the dialect's event shape. */
export class LlmStreamError extends TransportError {
  constructor(
    operation: Operation,
    message: string,
    options: TransportErrorOptions = {},
  ) {
    super(`${operation}: ${message}`, operation, options);
    this.name = "LlmStreamError";
  }
}

/* -------------------------------------------------------------------------- */
/* SSE framing failures (B110/B111)                                           */
/* -------------------------------------------------------------------------- */

export type SseFailure =
  /** The body ended inside a line or inside an event. */
  | "truncated"
  /** One event's bytes exceeded the documented bound. */
  | "oversized";

export class SseProtocolError extends TransportError {
  readonly failure: SseFailure;

  constructor(
    operation: Operation,
    failure: SseFailure,
    detail: string,
    options: TransportErrorOptions = {},
  ) {
    super(`${operation}: ${detail}`, operation, options);
    this.name = "SseProtocolError";
    this.failure = failure;
  }
}

export interface ModelFailureInput {
  readonly operation: Operation;
  readonly status: number | null;
  /** The proxy's stable `code`, when the body carried one (B104). */
  readonly code?: string | null;
  /** B104: the proxy marked the failure as forwarded from a provider. */
  readonly upstreamError?: boolean;
  /** B104: the body is the legacy `{"detail":"Forbidden"}` gate form. */
  readonly legacyForbidden?: boolean;
  readonly retryAfterMs?: number | null;
}

/**
 * B101/B104: status (and only the documented proxy codes) selects the class.
 * Provider-controlled text never becomes a reason, so the caller must pass
 * flags it parsed, not prose.
 *
 * TODO(spec B101): the body markers for quota-vs-payment (non-proxy), content
 * moderation, context limit, request-too-large and thinking-signature/PDF
 * invalidity are not quoted in the spec; only the proxy's two `code` values and
 * the status bands are implemented.
 */
export function classifyModelFailure(input: ModelFailureInput): LlmError {
  const options: LlmErrorOptions = {
    statusCode: input.status,
    retryAfterMs: input.retryAfterMs ?? null,
  };
  const status = input.status;
  const gateApplies = input.upstreamError !== true;
  const code = input.code ?? null;

  if (gateApplies && code === "content_policy_rejected") {
    return new LlmContentModerationError(input.operation, options);
  }
  if (gateApplies && status === 403 && input.legacyForbidden === true) {
    return new LlmContentModerationError(input.operation, options);
  }
  if (gateApplies && status === 402) {
    return code === "no_active_subscription"
      ? new LlmPaymentRequiredError(input.operation, options)
      : new LlmQuotaExhaustedError(input.operation, options);
  }
  if (status === 413) {
    return new LlmRequestTooLargeError(input.operation, options);
  }
  if (status === 401) {
    return new LlmAuthenticationError(input.operation, options);
  }
  if (status === 403) {
    return new LlmForbiddenError(input.operation, options);
  }
  if (status === 410) {
    return new LlmGoneError(input.operation, options);
  }
  if (status === 429) {
    return new LlmThrottlingError(input.operation, options);
  }
  if (
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 529
  ) {
    return new LlmOverloadedError(input.operation, options);
  }
  if (status !== null && status >= 500) {
    return new LlmInternalError(input.operation, options);
  }
  if (status !== null && status >= 400) {
    return new LlmInvalidRequestError(input.operation, options);
  }
  return new LlmUnknownError(input.operation, options);
}
