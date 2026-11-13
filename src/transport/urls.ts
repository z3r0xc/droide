/**
 * Base-URL resolution. Contract: `specs/50-transport-and-auth.md` §A
 * (B1–B9) and §G's canonicalization rule (B72).
 *
 * Precedence is fixed and total:
 *
 * 1. a `customer-prem` deployment's origin (it is the authentication authority);
 * 2. the explicit per-process override, then `DROIDE_API_BASE_URL_EU`; the EU
 *    value wins only when the resolved region is `eu` and it is configured;
 * 3. the explicit per-process override, then `DROIDE_API_BASE_URL`, then the
 *    baked build define.
 *
 * The environment beats the baked define (B3). An explicit override is the
 * injection point for tests and embedders; the spec pins only env > define, so
 * its position above both is marked below rather than guessed silently.
 *
 * Nothing here reads `process.env`: callers pass the environment slice from
 * `src/config/paths.ts`, which is the only module allowed to read it.
 */

import { TransportError } from "./errors.ts";

export const API_BASE_URL_ENV = "DROIDE_API_BASE_URL";
export const API_BASE_URL_EU_ENV = "DROIDE_API_BASE_URL_EU";

/** B4's region domain. */
export type ManagedRegion = "global" | "eu";

/**
 * The per-process deployment choice (B2/B70). Only the routing shape lives
 * here; reading and validating the selection file is the deployment slice's
 * job.
 */
export type DeploymentSelection =
  | { readonly kind: "managed" }
  | { readonly kind: "customer-prem"; readonly origin: string };

/** The environment slice this layer reads; `config` supplies the rest. */
export interface TransportEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Values compiled into a release build; the environment overrides them (B3).
 *
 * `apiBaseUrl: ""` means the build ships no endpoint: this product has no
 * hosted backend of its own, so a base must be configured (environment or
 * settings) before a request can be routed. Empty is not "invalid", it is
 * "unconfigured", and the two are reported differently.
 */
export interface BakedApiUrls {
  readonly apiBaseUrl: string;
  readonly apiBaseUrlEu: string | null;
}

/**
 * Explicit values for one process. `apiBaseUrlEu: null` means "explicitly no EU
 * base", distinct from absent (fall through to env/define).
 *
 * TODO(spec B3): the spec pins `environment > baked define`; an explicit
 * caller-supplied override is not covered and is placed above both.
 */
export interface ApiUrlOverrides {
  readonly apiBaseUrl?: string;
  readonly apiBaseUrlEu?: string | null;
}

export interface ApiUrlConfigInput {
  readonly deployment: DeploymentSelection;
  readonly environment: TransportEnvironment;
  readonly baked: BakedApiUrls;
  readonly overrides?: ApiUrlOverrides;
}

/** The resolved, validated URLs one process routes with. */
export interface ApiUrlConfig {
  readonly deployment: DeploymentSelection;
  /** Validated absolute http(s) URL without a trailing `/` or credentials. */
  readonly apiBaseUrl: URL;
  /** Validated EU base, or `null` when unset (always `null` on customer Prem). */
  readonly apiBaseUrlEu: URL | null;
}

/** A configured base URL violated B7 (or the credential/query refusal below). */
export class InvalidBaseUrlError extends TransportError {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`api-base-url: ${field} ${reason}`, "api-base-url");
    this.name = "InvalidBaseUrlError";
    this.field = field;
  }
}

/** B72: a customer origin that cannot be used as an origin. */
export class InvalidDeploymentOriginError extends TransportError {
  constructor(reason: string) {
    super(`deployment: ${reason}`, "deployment");
    this.name = "InvalidDeploymentOriginError";
  }
}

const LOCAL_HTTP_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true,
};

/**
 * B7: non-empty, `http://` or `https://`, no trailing `/`. Credentials and a
 * query/fragment are refused as well: a base URL is an origin plus a path
 * prefix, and anything else would either leak into every request or make
 * relative-path joining ambiguous.
 *
 * TODO(spec B7): the clause lists empty, scheme and trailing slash only; the
 * credential and query/fragment refusals come from B9's request policy.
 */
export function parseApiBaseUrl(value: string, field: string): URL {
  if (value.length === 0) {
    throw new InvalidBaseUrlError(field, "must not be empty");
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    throw new InvalidBaseUrlError(field, "must start with http:// or https://");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidBaseUrlError(field, "is not an absolute URL");
  }
  if (value.endsWith("/")) {
    throw new InvalidBaseUrlError(field, "must not end with /");
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidBaseUrlError(field, "must not contain credentials");
  }
  if (url.search !== "") {
    throw new InvalidBaseUrlError(field, "must not contain a query");
  }
  if (url.hash !== "") {
    throw new InvalidBaseUrlError(field, "must not contain a fragment");
  }
  return url;
}

/**
 * B72: canonicalize a customer origin. Trims; prepends `https://` when no
 * scheme is present; refuses a path or query; refuses whitespace, backslashes,
 * userinfo and fragments; allows `http` only for loopback; removes a trailing
 * dot and returns the origin.
 */
export function canonicalizeCustomerOrigin(value: string): URL {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidDeploymentOriginError("the customer origin is empty");
  }
  if (/\s/u.test(trimmed)) {
    throw new InvalidDeploymentOriginError(
      "the customer origin must not contain whitespace",
    );
  }
  if (trimmed.includes("\\")) {
    throw new InvalidDeploymentOriginError(
      "the customer origin must not contain backslashes",
    );
  }

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidDeploymentOriginError(
      "the customer origin is not an absolute URL",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidDeploymentOriginError(
      "the customer origin must use http:// or https://",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidDeploymentOriginError(
      "the customer origin must not contain credentials",
    );
  }
  if (url.hash !== "") {
    throw new InvalidDeploymentOriginError(
      "the customer origin must not contain a fragment",
    );
  }
  if (url.search !== "") {
    throw new InvalidDeploymentOriginError(
      "the customer origin must not contain a query",
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new InvalidDeploymentOriginError(
      "the customer origin must not contain a path",
    );
  }
  if (url.hostname === "") {
    throw new InvalidDeploymentOriginError("the customer origin has no host");
  }
  if (url.protocol === "http:" && LOCAL_HTTP_HOSTS[url.hostname] !== true) {
    throw new InvalidDeploymentOriginError(
      "http is allowed only for localhost, 127.0.0.1 or [::1]",
    );
  }
  if (url.hostname.endsWith(".")) {
    url.hostname = url.hostname.slice(0, -1);
  }
  return new URL(url.origin);
}

function environmentValue(
  environment: TransportEnvironment,
  name: string,
): string | null {
  const value = environment.env[name];
  return value === undefined || value === "" ? null : value;
}

/**
 * B1–B3/B7: build the per-process URL config. A `customer-prem` selection
 * replaces `apiBaseUrl` with the origin and leaves `apiBaseUrlEu` unset, so the
 * EU branch can never win (B2). A `factory` selection resolves each URL as
 * override > environment > baked define.
 */
export function createApiUrlConfig(input: ApiUrlConfigInput): ApiUrlConfig {
  const { deployment, environment, baked, overrides } = input;

  if (deployment.kind === "customer-prem") {
    return {
      deployment,
      apiBaseUrl: canonicalizeCustomerOrigin(deployment.origin),
      apiBaseUrlEu: null,
    };
  }

  const baseValue =
    overrides?.apiBaseUrl ??
    environmentValue(environment, API_BASE_URL_ENV) ??
    baked.apiBaseUrl;
  const euValue =
    overrides?.apiBaseUrlEu !== undefined
      ? overrides.apiBaseUrlEu
      : (environmentValue(environment, API_BASE_URL_EU_ENV) ??
        baked.apiBaseUrlEu);

  if (baseValue === "" || baseValue === undefined) {
    throw new InvalidBaseUrlError(
      API_BASE_URL_ENV,
      `is not configured; set ${API_BASE_URL_ENV} to the endpoint to use`,
    );
  }

  return {
    deployment,
    apiBaseUrl: parseApiBaseUrl(baseValue, API_BASE_URL_ENV),
    apiBaseUrlEu:
      euValue === null || euValue === ""
        ? null
        : parseApiBaseUrl(euValue, API_BASE_URL_EU_ENV),
  };
}

/**
 * B1: the destination of a backend API request. The customer origin wins by
 * construction; otherwise the EU base wins on `eu` when configured; otherwise
 * the global base.
 */
export function resolveCliApiBaseUrl(
  config: ApiUrlConfig,
  region: ManagedRegion,
): URL {
  if (config.deployment.kind === "customer-prem") {
    return config.apiBaseUrl;
  }
  if (region === "eu" && config.apiBaseUrlEu !== null) {
    return config.apiBaseUrlEu;
  }
  return config.apiBaseUrl;
}

export interface RegionInputs {
  readonly deployment: DeploymentSelection;
  /** Whether any credential resolved; no credential pins `global` (B4). */
  readonly hasCredential: boolean;
  /** The cached identity's region, or `null` when it has none. */
  readonly identityRegion: ManagedRegion | null;
}

/** B4: a customer deployment, no credential, or no identity region is global. */
export function resolveRegion(input: RegionInputs): ManagedRegion {
  if (input.deployment.kind === "customer-prem") {
    return "global";
  }
  if (!input.hasCredential || input.identityRegion === null) {
    return "global";
  }
  return input.identityRegion;
}

/** The only identity field consulted for routing (B5/B6). */
export interface PremIdentity {
  /** `premBaseHostV2`; the legacy `premBaseHost` is deliberately absent. */
  readonly premBaseHostV2?: string | null;
}

export interface PremHostInputs {
  readonly deployment: DeploymentSelection;
  readonly identity: PremIdentity | null;
}

/**
 * B5/B6: the customer origin for a customer deployment, else the cached
 * `premBaseHostV2` for a managed Prem organization, else `null` (hosted). The
 * legacy `premBaseHost` field is never read — it is not even accepted here.
 */
export function resolvePremBaseHost(input: PremHostInputs): URL | null {
  if (input.deployment.kind === "customer-prem") {
    return canonicalizeCustomerOrigin(input.deployment.origin);
  }
  const host = input.identity?.premBaseHostV2 ?? null;
  if (host === null || host === "") {
    return null;
  }
  return canonicalizeCustomerOrigin(host);
}

/**
 * B8/B9: join a relative backend path to a base URL resolved for *this*
 * request. The path must be relative and rooted; a full URL, a
 * protocol-relative path or a path with a backslash is refused.
 */
export function joinApiPath(base: URL, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new InvalidBaseUrlError("path", "must be a rooted relative path");
  }
  if (path.includes("\\")) {
    throw new InvalidBaseUrlError("path", "must not contain backslashes");
  }
  const root = base.href.replace(/\/+$/u, "");
  return new URL(`${root}${path}`);
}

/** B8: resolve one request's absolute URL from this process's config. */
export function resolveApiRequestUrl(
  config: ApiUrlConfig,
  region: ManagedRegion,
  path: string,
): URL {
  return joinApiPath(resolveCliApiBaseUrl(config, region), path);
}
