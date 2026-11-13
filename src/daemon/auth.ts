/**
 * The authentication gate and post-authentication handshake. Contract:
 * `specs/70-daemon-and-remote-control.md` B14–B17, B31.
 *
 * A connection starts unauthenticated: the first request must be
 * `daemon.authenticate`, and anything else is answered `AUTHENTICATION_ERROR`
 * with the fixed sentence below. State is per connection only — there is no
 * process-wide "someone authenticated" flag. The daemon is single-user, and a
 * credential is checked one of two ways: with a configured backend it is
 * verified and the answer is that account (`verified:true`), without one it is
 * compared with the local placeholder identity and the answer says
 * `verified:false`. The version comparison is advisory and only decorates
 * failures.
 */

import {
  DaemonAuthenticationError,
  DaemonInvalidResponseError,
} from "./errors.ts";
import {
  AUTHENTICATE_METHOD as AUTHENTICATE_METHOD_NAME,
  JSON_RPC_ERRORS,
  MAX_PIPELINE_REQUESTS,
  isJsonObject,
  isUuidV4,
} from "./protocol.ts";

/** The only method that may run before the gate opens (B15). */
export const AUTHENTICATE_METHOD = AUTHENTICATE_METHOD_NAME;
export const LOGOUT_METHOD = "daemon.logout";
export const CONNECTION_STATUS_METHOD = "daemon.connection_status";

/** Fixed sentence; clients match it verbatim (B15). */
export const AUTHENTICATION_REQUIRED_MESSAGE =
  "Connection not authenticated. Must call daemon.authenticate first.";

/** Methods a client may fold into `daemon.authenticate` (B16). */
export const PIPELINE_METHODS: readonly string[] = [
  "list_opened_sessions",
  "list_available_sessions",
  "get_session_messages",
  "get_message_blocks",
  "load_session",
];

/** The daemon is single-user; this is the account every credential maps to. */
export interface DaemonIdentity {
  readonly userId: string;
  readonly orgId: string;
}

/**
 * One authenticated account plus how it was established. `verified:true` means
 * the configured backend named it (B15's verification path); `verified:false`
 * means the daemon reported its local placeholder identity and a client that
 * needs a real account must refuse it.
 */
export interface AuthenticatedAccount extends DaemonIdentity {
  readonly verified: boolean;
}

/**
 * The backend check one credential goes through (B15). It resolves with the
 * account the backend named and throws a typed
 * `DaemonCredentialVerificationError` when the credential is refused or the
 * backend cannot be reached.
 */
export type CredentialVerifier = (
  request: AuthenticateRequest,
) => Promise<DaemonIdentity>;

/** What the daemon accepts as proof of identity. */
export interface DaemonAuthPolicy {
  /**
   * The account a locally accepted credential maps to. Absent when the
   * daemon only accepts credentials a backend has verified, so a policy can
   * never quietly name an account it was not given.
   */
  readonly identity?: DaemonIdentity;
  /** A WorkOS token this daemon accepts, when local token auth is configured. */
  readonly token?: string;
  /** An `fk-` API key this daemon accepts, when local key auth is configured. */
  readonly apiKey?: string;
  /**
   * When set, a presented credential is verified with the backend and the
   * identity it answers with is the one reported; the local `token`/`apiKey`
   * fields are then unused.
   */
  readonly verify?: CredentialVerifier;
}

/** One request folded into the authenticate pipeline. */
export interface PipelinedRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

/** Validated `daemon.authenticate` params. */
export interface AuthenticateRequest {
  readonly token?: string;
  readonly apiKey?: string;
  readonly activeOrganizationId?: string;
  readonly acceptEncodings?: readonly string[];
  readonly pipeline?: readonly PipelinedRequest[];
}

/** The decoded `daemon.authenticate` result (B16). */
export interface AuthenticateSuccess extends AuthenticatedAccount {
  readonly encoding?: string;
  readonly pipelined?: boolean;
}

/** What every connection is told immediately after authenticating (B16). */
export interface DaemonConnectionStatus {
  readonly supportsRequestCwd: boolean;
  readonly supportsPullRequestRecords: boolean;
  readonly supportsRemoteDesktop: boolean;
  readonly supportsReadOnlySideChats: boolean;
  readonly supportsSharedSessionSideChats: boolean;
  readonly supportsSessionPresence: boolean;
  readonly isDroidCLIInPath: boolean;
  readonly droidCLIVersion: string;
  readonly homedir: string;
  readonly platform: string;
  readonly hostId?: string;
}

/** A gate decision the dispatcher can act on without re-reading auth state. */
export type AuthGateDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "drop" }
  | {
      readonly kind: "reject";
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    };

/** The authentication failure answer, with the fixed gate sentence. */
export function authenticationRequired(): AuthGateDecision {
  return {
    kind: "reject",
    code: JSON_RPC_ERRORS.authentication,
    message: AUTHENTICATION_REQUIRED_MESSAGE,
  };
}

/**
 * Whether one request may be handled on this connection yet (B15). An
 * unauthenticated notification is not answered and an unauthenticated
 * response cannot belong to anything the daemon sent.
 */
export function gateEnvelope(
  auth: DaemonConnectionAuth,
  envelope: {
    readonly type: "request" | "response" | "notification";
    readonly method?: string;
  },
): AuthGateDecision {
  if (auth.authenticated) return { kind: "allow" };
  if (envelope.type !== "request") return { kind: "drop" };
  if (envelope.method === AUTHENTICATE_METHOD) return { kind: "allow" };
  return authenticationRequired();
}

/** Whether a pipeline entry names one of the five allowed read methods. */
export function isPipelineMethod(method: string): boolean {
  return PIPELINE_METHODS.includes(method);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new DaemonAuthenticationError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate `daemon.authenticate` params. Schema refinements fail as
 * `PARSE_ERROR` (B15); this returns a typed view or throws
 * `DaemonAuthenticationError` for the caller to re-code as a parse error.
 */
export function parseAuthenticateRequest(params: unknown): AuthenticateRequest {
  if (params === undefined) return {};
  if (!isJsonObject(params)) {
    throw new DaemonAuthenticationError(
      "daemon.authenticate params must be an object",
    );
  }
  if (params["actAsGrant"] !== undefined) {
    throw new DaemonAuthenticationError(
      "actAsGrant is not supported by this daemon",
    );
  }
  if (params["sharedSessionGrant"] !== undefined) {
    throw new DaemonAuthenticationError(
      "sharedSessionGrant is not supported by this daemon",
    );
  }

  const token = optionalString(params["token"], "token");
  const apiKey = optionalString(params["apiKey"], "apiKey");
  const activeOrganizationId = optionalString(
    params["activeOrganizationId"],
    "activeOrganizationId",
  );

  let acceptEncodings: string[] | undefined;
  const rawEncodings = params["acceptEncodings"];
  if (rawEncodings !== undefined) {
    if (!Array.isArray(rawEncodings)) {
      throw new DaemonAuthenticationError(
        "acceptEncodings must be an array of strings",
      );
    }
    acceptEncodings = [];
    for (const encoding of rawEncodings) {
      if (typeof encoding !== "string") {
        throw new DaemonAuthenticationError(
          "acceptEncodings must be an array of strings",
        );
      }
      acceptEncodings.push(encoding);
    }
  }

  const pipeline = parsePipeline(params["pipeline"]);
  return {
    ...(token === undefined ? {} : { token }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(activeOrganizationId === undefined ? {} : { activeOrganizationId }),
    ...(acceptEncodings === undefined ? {} : { acceptEncodings }),
    ...(pipeline === undefined ? {} : { pipeline }),
  };
}

function parsePipeline(value: unknown): PipelinedRequest[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new DaemonAuthenticationError("pipeline must be an array");
  }
  if (value.length > MAX_PIPELINE_REQUESTS) {
    throw new DaemonAuthenticationError(
      `pipeline accepts at most ${MAX_PIPELINE_REQUESTS} requests`,
    );
  }
  const entries: PipelinedRequest[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      throw new DaemonAuthenticationError(
        "each pipeline entry must be an object",
      );
    }
    const id = entry["id"];
    if (!isUuidV4(id)) {
      throw new DaemonAuthenticationError(
        "pipeline entry id must be a UUID v4 string",
      );
    }
    const method = entry["method"];
    if (typeof method !== "string" || method.length === 0) {
      throw new DaemonAuthenticationError(
        "pipeline entry method must be a non-empty string",
      );
    }
    const params = entry["params"];
    entries.push({
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
  }
  return entries;
}

/**
 * Verify one credential set against the daemon's single account (B31).
 * `activeOrganizationId` is checked before the credential so a caller learns
 * that it selected the wrong organization rather than that its token is bad.
 */
export function verifyCredential(
  request: AuthenticateRequest,
  policy: DaemonAuthPolicy,
): DaemonIdentity {
  if (
    request.activeOrganizationId !== undefined &&
    policy.identity !== undefined &&
    request.activeOrganizationId !== policy.identity.orgId
  ) {
    throw new DaemonAuthenticationError(
      "The selected organization does not match this daemon",
      {
        reason: "organization_selection_mismatch",
      },
    );
  }

  if (request.apiKey === undefined && request.token === undefined) {
    throw new DaemonAuthenticationError(
      "Authentication requires a token or an API key",
    );
  }

  if (request.apiKey !== undefined) {
    if (!request.apiKey.startsWith("fk-")) {
      throw new DaemonAuthenticationError("API key must start with fk-");
    }
    if (
      policy.apiKey !== undefined &&
      policy.identity !== undefined &&
      request.apiKey === policy.apiKey
    ) {
      return policy.identity;
    }
    if (policy.apiKey === undefined || policy.identity === undefined) {
      throw new DaemonAuthenticationError(
        "API key authentication is not configured",
      );
    }
    throw new DaemonAuthenticationError("Invalid API key");
  }

  if (request.token !== undefined) {
    if (
      policy.token !== undefined &&
      policy.identity !== undefined &&
      request.token === policy.token
    ) {
      return policy.identity;
    }
    if (policy.token === undefined || policy.identity === undefined) {
      throw new DaemonAuthenticationError(
        "Token authentication is not configured",
      );
    }
    throw new DaemonAuthenticationError("Invalid authentication token");
  }

  throw new DaemonAuthenticationError(
    "Authentication requires a token or an API key",
  );
}

/**
 * One credential check, in whichever mode the policy names (B15): a
 * configured verifier asks the backend and reports `verified:true`; without
 * one the daemon compares locally and marks the answer `verified:false`,
 * because a local string comparison is not a statement about a real account.
 */
export async function verifyCredentialAsync(
  request: AuthenticateRequest,
  policy: DaemonAuthPolicy,
): Promise<AuthenticatedAccount> {
  if (policy.verify === undefined) {
    return { ...verifyCredential(request, policy), verified: false };
  }

  // The shape checks belong to the daemon, not to the backend: they are the
  // same refusals a local policy makes, and they happen before any request.
  if (request.apiKey === undefined && request.token === undefined) {
    throw new DaemonAuthenticationError(
      "Authentication requires a token or an API key",
    );
  }
  if (request.apiKey !== undefined && !request.apiKey.startsWith("fk-")) {
    throw new DaemonAuthenticationError("API key must start with fk-");
  }

  const identity = await policy.verify(request);
  if (
    request.activeOrganizationId !== undefined &&
    request.activeOrganizationId !== identity.orgId
  ) {
    throw new DaemonAuthenticationError(
      "The selected organization does not match this daemon",
      { reason: "organization_selection_mismatch" },
    );
  }
  return { userId: identity.userId, orgId: identity.orgId, verified: true };
}

/**
 * Gate state for one connection. Authentication is sticky: once the gate has
 * opened, a second `daemon.authenticate` answers with the same identity and
 * never re-verifies the credential (B17).
 */
export class DaemonConnectionAuth {
  readonly policy: DaemonAuthPolicy;
  private identityValue: AuthenticatedAccount | undefined;
  private pending: Promise<AuthenticatedAccount> | undefined;

  constructor(policy: DaemonAuthPolicy) {
    this.policy = policy;
  }

  get authenticated(): boolean {
    return this.identityValue !== undefined;
  }

  get identity(): AuthenticatedAccount | undefined {
    return this.identityValue;
  }

  /**
   * Verify and remember the first successful credential. A second frame that
   * arrives while the check is in flight joins it rather than asking the
   * backend twice; a failed check clears the slot so a later attempt (with a
   * different credential) starts fresh.
   */
  async authenticate(
    request: AuthenticateRequest,
  ): Promise<AuthenticatedAccount> {
    if (this.identityValue === undefined) {
      this.pending ??= verifyCredentialAsync(request, this.policy);
      try {
        this.identityValue = await this.pending;
      } catch (error) {
        this.pending = undefined;
        throw error;
      }
    }
    return this.identityValue;
  }
}

/**
 * Validate a `daemon.authenticate` result sent by a peer. Used by the client
 * so a malformed identity is an invalid response, not a silent `undefined`.
 */
export function parseAuthenticateResult(result: unknown): AuthenticateSuccess {
  if (!isJsonObject(result)) {
    throw new DaemonInvalidResponseError(
      AUTHENTICATE_METHOD,
      undefined,
      "result must be an object",
    );
  }
  const userId = result["userId"];
  const orgId = result["orgId"];
  if (typeof userId !== "string" || userId.length === 0) {
    throw new DaemonInvalidResponseError(
      AUTHENTICATE_METHOD,
      undefined,
      "userId must be a non-empty string",
    );
  }
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new DaemonInvalidResponseError(
      AUTHENTICATE_METHOD,
      undefined,
      "orgId must be a non-empty string",
    );
  }
  const encoding = result["encoding"];
  if (encoding !== undefined && typeof encoding !== "string") {
    throw new DaemonInvalidResponseError(
      AUTHENTICATE_METHOD,
      undefined,
      "encoding must be a string",
    );
  }
  const pipelined = result["pipelined"];
  if (pipelined !== undefined && typeof pipelined !== "boolean") {
    throw new DaemonInvalidResponseError(
      AUTHENTICATE_METHOD,
      undefined,
      "pipelined must be a boolean",
    );
  }
  const verified = result["verified"];
  if (verified !== undefined && typeof verified !== "boolean") {
    throw new DaemonInvalidResponseError(
      AUTHENTICATE_METHOD,
      undefined,
      "verified must be a boolean",
    );
  }
  return {
    userId,
    orgId,
    // Absent means "this daemon did not claim verification", which a client
    // must treat as unverified rather than assume the safer opposite.
    verified: verified === true,
    ...(encoding === undefined ? {} : { encoding }),
    ...(pipelined === undefined ? {} : { pipelined }),
  };
}
