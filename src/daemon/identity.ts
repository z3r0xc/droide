/**
 * Credential verification against a configured backend. Contract:
 * `specs/70-daemon-and-remote-control.md` B15 (verification versus a local
 * identity) and B31; the request itself is `specs/50-transport-and-auth.md`
 * B13, B32–B34.
 *
 * Two states and no third one: **verified** (a base is configured and the
 * backend named the account) and **local** (no base is configured, so the
 * daemon reports its placeholder identity and says `verified:false`). A base
 * that is configured but unreachable is a failure, never a quiet fallback to
 * the local identity — that is the whole point of the distinction.
 *
 * The credential travels exactly once, in the `Authorization` header of one
 * `GET /api/cli/whoami`. Nothing here builds a message from it: the errors
 * this module raises carry fixed sentences, and the HTTP boundary redacts
 * credential-bearing header values before any error or log sees them.
 */

import type { HttpClient } from "../transport/client.ts";
import { buildWhoamiHeaders } from "../transport/headers.ts";
import {
  API_BASE_URL_ENV,
  joinApiPath,
  parseApiBaseUrl,
} from "../transport/urls.ts";

import type { AuthenticateRequest, DaemonIdentity } from "./auth.ts";
import { DaemonCredentialVerificationError } from "./errors.ts";

/** The one identity endpoint every credential-verification path uses (50 B32). */
export const WHOAMI_PATH = "/api/cli/whoami";

/** The identity request's whole-exchange deadline (50 B34). */
export const IDENTITY_VERIFICATION_TIMEOUT_MS = 10_000;

/** Stable operation label, so a log line never needs the URL or the secret. */
export const IDENTITY_OPERATION = "daemon.identity";

/** Statuses that mean "this credential is not a valid account". */
const REFUSED_STATUSES: Readonly<Record<number, true>> = {
  401: true,
  403: true,
};

/** Fixed wire messages; neither is built from input. */
export const INVALID_CREDENTIAL_MESSAGE = "Invalid credential";
export const VERIFICATION_UNAVAILABLE_MESSAGE =
  "Credential verification is unavailable";

/**
 * The backend base this process verifies against, or `null` when
 * `DROIDE_API_BASE_URL` is unset or empty (the documented local mode).
 * Throws `InvalidBaseUrlError` when it is set but unusable, so startup can
 * refuse instead of pretending to verify.
 */
export function configuredVerificationBase(
  env: Readonly<Record<string, string | undefined>>,
): URL | null {
  const configured = env[API_BASE_URL_ENV]?.trim();
  if (configured === undefined || configured === "") return null;
  return parseApiBaseUrl(configured, API_BASE_URL_ENV);
}

export interface IdentityVerificationOptions {
  /** Already validated base; the whoami path is appended to it. */
  readonly base: URL;
  /** The transport's HTTP boundary, injected so tests never touch the wire. */
  readonly http: HttpClient;
  /** Defaults to {@link IDENTITY_VERIFICATION_TIMEOUT_MS} (50 B34). */
  readonly timeoutMs?: number;
  /** Cancels an in-flight check when the connection or daemon goes away. */
  readonly signal?: AbortSignal;
}

/**
 * Verify one credential with the backend and return the account it names.
 *
 * Failures are typed: `DaemonCredentialVerificationError` with outcome
 * `invalid_credential` (the backend refused it) or `verification_unavailable`
 * (no usable answer). Neither carries the credential, the base URL or the
 * response body.
 */
export async function verifyCredentialWithBackend(
  request: AuthenticateRequest,
  options: IdentityVerificationOptions,
): Promise<DaemonIdentity> {
  let response: { readonly status: number; readonly body: string };
  try {
    response = await options.http.request({
      operation: IDENTITY_OPERATION,
      method: "GET",
      url: joinApiPath(options.base, WHOAMI_PATH),
      headers: buildWhoamiHeaders({
        token: request.token ?? request.apiKey ?? "",
        organization: request.activeOrganizationId ?? null,
        purpose: "operational",
      }),
      timeoutMs: options.timeoutMs ?? IDENTITY_VERIFICATION_TIMEOUT_MS,
      // A verification request must land on the configured origin or nowhere:
      // following a redirect could hand the credential to another host.
      redirects: "refuse",
      credentials: "omit",
      idempotent: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    const status = statusOf(error);
    if (status !== undefined && REFUSED_STATUSES[status] === true) {
      throw new DaemonCredentialVerificationError(
        "invalid_credential",
        INVALID_CREDENTIAL_MESSAGE,
        { cause: error },
      );
    }
    throw new DaemonCredentialVerificationError(
      "verification_unavailable",
      VERIFICATION_UNAVAILABLE_MESSAGE,
      { cause: error },
    );
  }

  if (response.status < 200 || response.status >= 300) {
    const outcome =
      REFUSED_STATUSES[response.status] === true
        ? "invalid_credential"
        : "verification_unavailable";
    throw new DaemonCredentialVerificationError(
      outcome,
      outcome === "invalid_credential"
        ? INVALID_CREDENTIAL_MESSAGE
        : VERIFICATION_UNAVAILABLE_MESSAGE,
    );
  }

  const identity = parseWhoamiBody(response.body);
  if (identity === null) {
    throw new DaemonCredentialVerificationError(
      "verification_unavailable",
      VERIFICATION_UNAVAILABLE_MESSAGE,
    );
  }
  return identity;
}

/** `FetchError` (and anything else) may carry the status on `.statusCode`. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("statusCode" in error)) return undefined;
  const status = error.statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * The whoami body is untrusted: it is parsed leniently about extra fields
 * (50 B32) but strictly about the two this daemon reports. `null` means "no
 * usable account", which the caller turns into `verification_unavailable`.
 */
export function parseWhoamiBody(body: string): DaemonIdentity | null {
  if (body.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("userId" in value) || !("orgId" in value)) return null;
  const userId = value.userId;
  const orgId = value.orgId;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  return { userId, orgId };
}
