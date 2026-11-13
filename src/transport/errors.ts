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
 * The sentence is quoted in spec 50 B88, from this file.
 */
export class TlsTrustError extends TransportError {
  readonly code: string | null;

  constructor(
    operation: Operation,
    code: string | null,
    options: TransportErrorOptions = {},
  ) {
    super(
      `${operation}: certificate chain not trusted${code === null ? "" : `: ${code}`}. Export the appliance root CA (PEM) and point DROIDE_EXTRA_CA_CERTS at it, or delete the certificate cache under the state directory on Windows.`,
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
  /** The request that failed, for the "backend" marker (B92). */
  readonly requestUrl?: URL;
  /** B92's factory-backend marker; defaults to `true`. */
  readonly droideBackend?: boolean;
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
  readonly droideBackend: boolean;
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
    this.droideBackend = init.droideBackend ?? true;
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
    "Not authenticated. Please log in using /login or set a valid DROIDE_API_KEY environment variable.",
  invalidApiKey:
    "Authentication failed. DROIDE_API_KEY is set but appears to be invalid. Unset it or replace it with a valid key.",
  apiUnavailable:
    "DROIDE_API_KEY could not be validated because the API is not accessible. Check network or proxy access and try again.",
  validationFailed:
    "DROIDE_API_KEY validation failed. Try again or contact support if the problem continues.",
  apiKeyRejected: "API key was rejected.",
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

/** A backend-bound request may not leave the process in airgap (B89). */
export const AIRGAP_BLOCKED_MESSAGE =
  "Outbound request blocked because Airgap Mode is enabled; only BYOK, MCP, and marketplaces are permitted.";

export class AirgapBlockedError extends TransportError {
  constructor(operation: Operation, options: TransportErrorOptions = {}) {
    super(AIRGAP_BLOCKED_MESSAGE, operation, options);
    this.name = "AirgapBlockedError";
  }
}

/**
 * A route hosted by the managed control plane was asked for on a customer
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
  "apiKeyRejected" | "ApiUnavailable" | "ApiValidationFailed";

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
      reason: "ApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    };
  }
  if (error instanceof TransportTimeoutError) {
    return {
      reason: "ApiUnavailable",
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
      reason: "ApiUnavailable",
      message: AUTH_MESSAGES.apiUnavailable,
    };
  }
  if (status !== null) {
    return {
      reason: "ApiValidationFailed",
      message: AUTH_MESSAGES.validationFailed,
    };
  }
  if (error instanceof ResponseError) {
    // A `ResponseError` without a status is a malformed 2xx (B96).
    return {
      reason: "ApiValidationFailed",
      message: AUTH_MESSAGES.validationFailed,
    };
  }
  return {
    reason: "ApiUnavailable",
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
 * User-facing copy per class, quoted row for row by spec 50 B102.
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
  /** B101: the response body exactly as received; untrusted, never echoed. */
  readonly bodyText?: string | null;
  /**
   * B101: the body when the caller already parsed it. A JSON string, array or
   * scalar is not an error envelope and carries no marker.
   */
  readonly bodyJson?: unknown;
}

/**
 * B101: the body-marker vocabulary, quoted from the recovered classifier
 * (`orig/packages/core/src/llms/errors/utils.ts`,
 * `constants.ts`) and reproduced row for row in spec 50 B101. Each entry is a
 * literal the provider or proxy prints, never a guess about intent: a message
 * that merely mentions a rate, a limit or a bill stays unclassified.
 */
export const MODEL_FAILURE_MARKERS: {
  readonly quotaCodes: readonly string[];
  readonly quotaMessages: readonly RegExp[];
  readonly moderationCodes: readonly string[];
  readonly moderationMessages: readonly RegExp[];
  readonly contextLimitCodes: readonly string[];
  readonly contextLimitMessages: readonly RegExp[];
  readonly requestTooLargeCodes: readonly string[];
  readonly requestTooLargeMessages: readonly RegExp[];
  readonly invalidRequestMessages: readonly RegExp[];
} = {
  quotaCodes: [
    "insufficient_quota",
    "account_quota_exceeded",
    "billing_error",
    "billing_hard_limit_reached",
    "billing_not_active",
    "credit_balance_too_low",
  ],
  quotaMessages: [
    /\b(?:weekly|monthly|daily)\s*\/?\s*(?:weekly|monthly|daily)?\s*limit\s+exhausted\b/i,
    /\bquota\s+exhausted\b/i,
    /check (?:your )?plan and billing/i,
    /\bbilling (?:hard )?limit\s+(?:(?:has been|was|is)\s+)?(?:reached|exceeded|exhausted)\b/i,
    /\b(?:reached|exceeded|exhausted)\s+(?:your\s+)?billing (?:hard )?limit\b/i,
    /\b(?:credits?|balance)\b[^.;]*\b(?:insufficient|exhausted|too low)\b/i,
    /exhausted your available credits/i,
  ],
  moderationCodes: ["content_filter", "cyber_policy", "moderation_blocked"],
  moderationMessages: [
    /content moderation/i,
    /content_filter/i,
    /cyber(?:[_\s-]?policy|security reasons)/i,
    /violating our usage policy/i,
    /rejected as a result of our safety system/i,
  ],
  contextLimitCodes: ["context_length_exceeded"],
  contextLimitMessages: [
    /context length/i,
    /context limit/i,
    /context size (?:has been )?exceeded/i,
    /exceed\s.*context\s.*limit/i,
    /exceeds?\s+(?:the\s+)?(?:available\s+)?context\s+size/i,
    /exceeds?\s+(?:the\s+)?.*context\s+window/i,
    /maximum context/i,
    /prompt\s+(?:is\s+)?too\s+long/i,
    /input is too long/i,
    /input is too many tokens/i,
    /context\s+window\s+(?:is\s+full|exceeded)/i,
    /context window exceeds limit/i,
    /request size exceed(?:s|ed)/i,
    /request too large for (?:the )?context window/i,
    /required for long context requests/i,
  ],
  requestTooLargeCodes: ["413"],
  requestTooLargeMessages: [/request entity too large/i],
  invalidRequestMessages: [
    // Anthropic: "Invalid `signature` in `thinking` block".
    /invalid.*signature.*thinking/i,
    // Gemini: "Thought signature is not valid", "thought_signature invalid".
    /thought[-_ ]?signature.*(?:not |in)valid/i,
    // Gemini: "missing a `thought_signature`", "Invalid value at ... thought_signature".
    /(?:invalid|missing).*thought[-_ ]?signature/i,
    // OpenAI: an encrypted reasoning artifact issued to another caller/org.
    /(?:encrypted[_ ]content.*(?:organization_id|could not be (?:verified|decrypted|parsed))|could not decrypt.*encrypted[_ ]content|encrypted[_ ]content`? was not issued to this caller)/i,
    // Anthropic: "A maximum of 100 PDF pages may be provided".
    /maximum of \d+ PDF pages/i,
  ],
};

const QUOTA_CODE_SET = new Set<string>(MODEL_FAILURE_MARKERS.quotaCodes);
const MODERATION_CODE_SET = new Set<string>(MODEL_FAILURE_MARKERS.moderationCodes);
const CONTEXT_LIMIT_CODE_SET = new Set<string>(
  MODEL_FAILURE_MARKERS.contextLimitCodes,
);
const REQUEST_TOO_LARGE_CODE_SET = new Set<string>(
  MODEL_FAILURE_MARKERS.requestTooLargeCodes,
);

/** Bound on the body prefix read for markers; a body is untrusted input. */
const MAX_MARKER_BODY_CHARS = 65_536;

/** The body fields a marker may be read from, already lowercased/trimmed. */
interface BodyFields {
  readonly codes: readonly string[];
  readonly messages: readonly string[];
}

/** B101 marker reasons, and the class each one produces. */
type MarkerReason =
  | "quota-exhausted"
  | "content-moderation"
  | "context-limit"
  | "request-too-large"
  | "invalid-request";

const MARKER_ERRORS: Readonly<
  Record<
    MarkerReason,
    (operation: Operation, options: LlmErrorOptions) => LlmError
  >
> = {
  "quota-exhausted": (operation, options) =>
    new LlmQuotaExhaustedError(operation, options),
  "content-moderation": (operation, options) =>
    new LlmContentModerationError(operation, options),
  "context-limit": (operation, options) =>
    new LlmContextLimitError(operation, options),
  "request-too-large": (operation, options) =>
    new LlmRequestTooLargeError(operation, options),
  "invalid-request": (operation, options) =>
    new LlmInvalidRequestError(operation, options),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * An HTML body is a gateway/firewall page, not an API error envelope (B104's
 * block-page exclusion). Its prose is never read as a marker.
 */
function looksLikeMarkup(text: string): boolean {
  return /<(?:!doctype\s+html|html|head|body)\b/.test(
    text.slice(0, 512).toLowerCase(),
  );
}

function collectBodyFields(
  record: Record<string, unknown>,
  codes: string[],
  messages: string[],
): void {
  for (const key of ["code", "type", "status"] as const) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized !== "") codes.push(normalized);
  }
  for (const key of ["message", "detail"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") messages.push(value);
  }
}

/**
 * B101: read the marker fields out of the body. Only documented envelope
 * fields (`code`, `type`, `status`, `message`, `detail`, and the same under
 * `error`) carry a marker; a bare JSON string, an array, a number and an HTML
 * page carry none, so they stay unclassified.
 */
function readBodyFields(
  bodyJson: unknown,
  bodyText: string | null,
): BodyFields | null {
  const codes: string[] = [];
  const messages: string[] = [];
  const text =
    bodyText === null ? null : bodyText.slice(0, MAX_MARKER_BODY_CHARS);
  let root: Record<string, unknown> | null = null;

  if (typeof bodyJson === "string") return null;
  if (bodyJson !== undefined && bodyJson !== null) {
    root = asRecord(bodyJson);
    if (root === null) return null;
  } else if (text !== null) {
    const trimmed = text.trim();
    if (trimmed === "" || looksLikeMarkup(trimmed)) return null;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      messages.push(trimmed);
      return { codes, messages };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    root = asRecord(parsed);
    if (root === null) return null;
  } else {
    return null;
  }

  collectBodyFields(root, codes, messages);
  const nested = asRecord(root.error);
  if (nested !== null) collectBodyFields(nested, codes, messages);
  if (codes.length === 0 && messages.length === 0) return null;
  return { codes, messages };
}

function hasQuotedCode(fields: BodyFields, quoted: ReadonlySet<string>): boolean {
  return fields.codes.some((code) => quoted.has(code));
}

function hasQuotedMessage(
  fields: BodyFields,
  patterns: readonly RegExp[],
): boolean {
  return fields.messages.some((message) =>
    patterns.some((pattern) => pattern.test(message)),
  );
}

/** B101 priority inside the body: spend, then policy, then size, then form. */
function reasonFromBody(fields: BodyFields): MarkerReason | null {
  if (
    hasQuotedCode(fields, QUOTA_CODE_SET) ||
    hasQuotedMessage(fields, MODEL_FAILURE_MARKERS.quotaMessages)
  ) {
    return "quota-exhausted";
  }
  if (
    hasQuotedCode(fields, MODERATION_CODE_SET) ||
    hasQuotedMessage(fields, MODEL_FAILURE_MARKERS.moderationMessages)
  ) {
    return "content-moderation";
  }
  if (
    hasQuotedCode(fields, CONTEXT_LIMIT_CODE_SET) ||
    hasQuotedMessage(fields, MODEL_FAILURE_MARKERS.contextLimitMessages)
  ) {
    return "context-limit";
  }
  if (
    hasQuotedCode(fields, REQUEST_TOO_LARGE_CODE_SET) ||
    hasQuotedMessage(fields, MODEL_FAILURE_MARKERS.requestTooLargeMessages)
  ) {
    return "request-too-large";
  }
  if (hasQuotedMessage(fields, MODEL_FAILURE_MARKERS.invalidRequestMessages)) {
    return "invalid-request";
  }
  return null;
}

/**
 * B101/B104: the proxy's exact codes first, then a quoted body marker, then the
 * status band. Provider-controlled text never becomes a reason: the caller
 * passes the body it parsed (or the raw text) and only the quoted marker
 * vocabulary is read from it; the reason enum is the only thing that escapes.
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
  if (gateApplies && status === 402 && code === "no_active_subscription") {
    return new LlmPaymentRequiredError(input.operation, options);
  }

  // B101: a quoted body marker narrows a client refusal — a 429 that states a
  // spend or context cause is not throttling, and a 413 that names the context
  // window is a context limit. A 5xx is an availability signal, so its prose is
  // never re-read as a deterministic cause.
  if (status === null || (status >= 400 && status < 500)) {
    const fields = readBodyFields(input.bodyJson, input.bodyText ?? null);
    const reason = fields === null ? null : reasonFromBody(fields);
    if (reason !== null) {
      return MARKER_ERRORS[reason](input.operation, options);
    }
  }

  if (gateApplies && status === 402) {
    return new LlmQuotaExhaustedError(input.operation, options);
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
