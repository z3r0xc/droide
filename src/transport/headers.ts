/**
 * Request headers built from one credential snapshot. Contract:
 * `specs/50-transport-and-auth.md` §B (B10–B13, B19, B22).
 *
 * A snapshot is the *only* source of a token or organization; nothing here
 * reads the environment or a file. Header names are contract data (spelled in
 * the spec's "Header names (literal)" table) and every merge is
 * case-insensitive, because a caller-supplied `authorization` must override the
 * credential rather than ride beside it.
 */

/** The literal header names this layer emits (spec: "Header names (literal)"). */
export const HEADER_NAMES = {
  authorization: "Authorization",
  organization: "X-Droide-Org-Id",
  client: "X-Droide-Client",
  sdk: "X-Droide-Sdk",
  requestSurface: "X-Droide-Request-Surface",
  execOutputFormat: "X-Droide-Exec-Output-Format",
  execInputFormat: "X-Droide-Exec-Input-Format",
  clientVersion: "X-Client-Version",
  whoamiExtended: "X-Droide-Whoami-Extended",
  sessionAttribution: "X-Droide-Session-Attribution",
  contentType: "Content-Type",
  traceparent: "traceparent",
} as const;

/**
 * B17: managed model requests to the proxy carry a `User-Agent`. The name is
 * not in the spec's literal header table, which lists protocol headers only,
 * so it is exported separately.
 */
export const USER_AGENT_HEADER = "User-Agent";

/** `usage` is a managed-LLM proxy route; `operational` is everything else. */
export type HeaderPurpose = "operational" | "usage";

/**
 * One consistent read of the credential: token, active organization and the
 * caller's attribution. `purpose` decides whether the operational
 * `X-Droide-Client` default applies (B11/B12).
 */
export interface CredentialSnapshot {
  readonly token: string | null;
  readonly organization: string | null;
  readonly purpose: HeaderPurpose;
  /** Known caller kind; operational requests default to `cli` (B11). */
  readonly client?: string;
  /** SDK callers only (B11). */
  readonly sdk?: string;
  readonly requestSurface?: string;
  readonly execOutputFormat?: string;
  readonly execInputFormat?: string;
  /** `false` means "not a known caller", so a usage route sends no attribution (B12). */
  readonly callerKnown?: boolean;
}

export interface HeaderContext {
  /** Installed version; `X-Client-Version` is sent only when this is set (B11). */
  readonly version?: string | null;
  /** Body media type, e.g. `application/json` (B20/B22). */
  readonly contentType?: string | null;
  /** W3C trace context, already injected by the tracing boundary (B18). */
  readonly traceparent?: string | null;
  /** B17: the caller product's user agent, sent only when it supplies one. */
  readonly userAgent?: string | null;
}

/** A header group; values may be absent and are then skipped. */
export type HeaderGroup = Readonly<Record<string, string | undefined>>;

const DEFAULT_CLIENT = "cli";

/** Attribution headers a usage route strips from caller input (B12). */
const ATTRIBUTION_HEADER_NAMES: Readonly<Record<string, true>> = {
  [HEADER_NAMES.client.toLowerCase()]: true,
  [HEADER_NAMES.sdk.toLowerCase()]: true,
  [HEADER_NAMES.requestSurface.toLowerCase()]: true,
  [HEADER_NAMES.execOutputFormat.toLowerCase()]: true,
  [HEADER_NAMES.execInputFormat.toLowerCase()]: true,
};

/**
 * B10/B11: `Authorization` (only when a token exists), the caller-attribution
 * projection, then the active organization. Canonical header casing, insertion
 * order as specified.
 */
export function buildHeaders(
  snapshot: CredentialSnapshot,
  context: HeaderContext = {},
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (snapshot.token !== null && snapshot.token !== "") {
    headers[HEADER_NAMES.authorization] = `Bearer ${snapshot.token}`;
  }

  // B11: the operational default is `cli`; B12: a usage route sends only a
  // *known* caller's attribution, never a default.
  const sendAttribution =
    snapshot.purpose === "operational" || snapshot.callerKnown === true;
  if (sendAttribution) {
    headers[HEADER_NAMES.client] = snapshot.client ?? DEFAULT_CLIENT;
    if (snapshot.sdk !== undefined && snapshot.sdk !== "") {
      headers[HEADER_NAMES.sdk] = snapshot.sdk;
    }
    if (snapshot.requestSurface !== undefined) {
      headers[HEADER_NAMES.requestSurface] = snapshot.requestSurface;
    }
    if (snapshot.execOutputFormat !== undefined) {
      headers[HEADER_NAMES.execOutputFormat] = snapshot.execOutputFormat;
    }
    if (snapshot.execInputFormat !== undefined) {
      headers[HEADER_NAMES.execInputFormat] = snapshot.execInputFormat;
    }
  }

  if (context.version !== undefined && context.version !== null) {
    headers[HEADER_NAMES.clientVersion] = context.version;
  }

  if (snapshot.organization !== null && snapshot.organization !== "") {
    headers[HEADER_NAMES.organization] = snapshot.organization;
  }

  if (context.contentType !== undefined && context.contentType !== null) {
    headers[HEADER_NAMES.contentType] = context.contentType;
  }

  if (context.traceparent !== undefined && context.traceparent !== null) {
    headers[HEADER_NAMES.traceparent] = context.traceparent;
  }

  if (context.userAgent !== undefined && context.userAgent !== null) {
    headers[USER_AGENT_HEADER] = context.userAgent;
  }

  return headers;
}

/**
 * B22: a customer-Prem authentication request carries exactly the bearer
 * credential, the selected organization and a JSON content type when a body is
 * present. It is deliberately not `buildHeaders`: the CLI client
 * attribution and version headers do not belong on the Prem authority.
 */
export function buildCustomerPremAuthHeaders(
  snapshot: CredentialSnapshot,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (snapshot.token !== null && snapshot.token !== "") {
    headers[HEADER_NAMES.authorization] = `Bearer ${snapshot.token}`;
  }
  if (snapshot.organization !== null && snapshot.organization !== "") {
    headers[HEADER_NAMES.organization] = snapshot.organization;
  }
  if (hasBody) {
    headers[HEADER_NAMES.contentType] = "application/json";
  }
  return headers;
}

/** B13: the identity request always asks for the extended answer. */
export function buildWhoamiHeaders(
  snapshot: CredentialSnapshot,
  context: HeaderContext = {},
  attribution?: string,
): Record<string, string> {
  const headers = buildHeaders(snapshot, context);
  headers[HEADER_NAMES.whoamiExtended] = "true";
  if (attribution !== undefined && attribution !== "") {
    headers[HEADER_NAMES.sessionAttribution] = attribution;
  }
  return headers;
}

/**
 * B19: later groups win on a case-insensitive name collision, and a name
 * different only in case is never duplicated. `Map` is used for the
 * case-folded key; insertion order follows the first group to mention it.
 */
export function mergeHeaders(
  ...groups: readonly HeaderGroup[]
): Record<string, string> {
  const merged = new Map<string, { name: string; value: string }>();
  for (const group of groups) {
    for (const [name, value] of Object.entries(group)) {
      if (value === undefined) {
        continue;
      }
      const key = name.toLowerCase();
      const existing = merged.get(key);
      merged.set(key, { name: existing?.name ?? name, value });
    }
  }
  const result: Record<string, string> = {};
  for (const { name, value } of merged.values()) {
    result[name] = value;
  }
  return result;
}

/** B12: remove caller-supplied attribution from a usage-route header record. */
export function stripAttributionHeaders<T extends HeaderGroup>(
  headers: T,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      ATTRIBUTION_HEADER_NAMES[name.toLowerCase()] === true
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

/** Case-insensitive lookup; the winner keeps the name it was built with. */
export function headerValue(
  headers: HeaderGroup,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** Placeholder written in place of a credential-bearing header value. */
export const REDACTED = "<redacted>";

/**
 * Header names whose value is a credential. `cookie` and `set-cookie` are
 * included because a session cookie is a bearer credential too.
 */
const SECRET_HEADER_NAMES: Readonly<Record<string, true>> = {
  authorization: true,
  "proxy-authorization": true,
  cookie: true,
  "set-cookie": true,
  "x-api-key": true,
};

/**
 * Every error and log path passes headers through this. Values (not just the
 * token) are replaced, so a malformed `Bearer` header cannot leak a fragment;
 * names and non-secret values survive for diagnosis.
 */
export function redactHeaders(
  headers: HeaderGroup | Headers,
): Record<string, string> {
  const entries: Iterable<[string, string | undefined]> =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);
  const result: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (value === undefined) {
      continue;
    }
    result[name] =
      SECRET_HEADER_NAMES[name.toLowerCase()] === true ? REDACTED : value;
  }
  return result;
}

/**
 * A URL safe to put in a message: credentials dropped by `URL`, query and
 * fragment removed (either may carry a token). Returns `null` for an
 * unparseable value so a malformed URL cannot smuggle text into a message.
 */
export function redactUrl(value: string | URL): string | null {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}
