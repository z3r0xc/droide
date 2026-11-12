/**
 * Sealed store for MCP OAuth credentials.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B29 (issuer, client
 * metadata, tokens, `revision`, `updatedAt`, tombstones) and
 * `docs/adr/0008-oauth-credential-envelope.md` (the envelope is the OS's).
 *
 * Two invariants matter more than the shape:
 *  - the token document never touches disk in plaintext; only the sealed blob
 *    does, and a failed seal is an error, never a fallback;
 *  - a tombstone with an equal or higher revision wins, so a refresh that read
 *    an older revision cannot resurrect a cleared credential.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CREDENTIAL_SEALED_FILE = "mcp-oauth.v2.sealed";
export const CREDENTIAL_HEADER_FILE = "mcp-oauth.v2.header.json";
export const CREDENTIAL_SCHEMA_VERSION = 1;

/** Seals and opens bytes with the platform facility. */
export interface CredentialSealer {
  seal(plaintext: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

export interface StoredClient {
  readonly clientId: string;
  readonly metadataUrl?: string;
}

export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch milliseconds. */
  readonly expiresAt?: number;
  readonly scope?: string;
  readonly tokenType: string;
}

export interface StoredCredential {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly issuer: string;
  readonly client: StoredClient;
  readonly tokens: StoredTokens;
  /** Monotonic per server; every write bumps it. */
  readonly revision: number;
  readonly updatedAt: string;
}

export interface CredentialTombstone {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly revision: number;
  readonly deletedAt: string;
}

export interface CredentialDocument {
  readonly schemaVersion: number;
  readonly servers: Readonly<Record<string, StoredCredential>>;
  readonly tombstones: Readonly<Record<string, CredentialTombstone>>;
}

export type CredentialStoreErrorCode =
  "not-sealed" | "corrupt" | "stale" | "io";

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

export interface CredentialStoreOptions {
  readonly stateDir: string;
  readonly sealer: CredentialSealer;
  readonly now?: () => number;
}

const EMPTY: CredentialDocument = {
  schemaVersion: CREDENTIAL_SCHEMA_VERSION,
  servers: {},
  tombstones: {},
};

function paths(stateDir: string): { sealed: string; header: string } {
  return {
    sealed: join(stateDir, CREDENTIAL_SEALED_FILE),
    header: join(stateDir, CREDENTIAL_HEADER_FILE),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(value: unknown): CredentialDocument {
  if (!isRecord(value))
    throw new CredentialStoreError(
      "corrupt",
      "the sealed credential document is not an object",
    );
  const schemaVersion = value["schemaVersion"];
  if (schemaVersion !== CREDENTIAL_SCHEMA_VERSION) {
    throw new CredentialStoreError(
      "corrupt",
      `unsupported credential schemaVersion ${String(schemaVersion)}`,
    );
  }
  const servers = isRecord(value["servers"]) ? value["servers"] : {};
  const tombstones = isRecord(value["tombstones"]) ? value["tombstones"] : {};

  const parsedServers: Record<string, StoredCredential> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw))
      throw new CredentialStoreError(
        "corrupt",
        `credential for ${name} is not an object`,
      );
    const tokens = raw["tokens"];
    const client = raw["client"];
    if (!isRecord(tokens) || typeof tokens["accessToken"] !== "string") {
      throw new CredentialStoreError(
        "corrupt",
        `credential for ${name} has no access token`,
      );
    }
    if (!isRecord(client) || typeof client["clientId"] !== "string") {
      throw new CredentialStoreError(
        "corrupt",
        `credential for ${name} has no client id`,
      );
    }
    if (
      typeof raw["revision"] !== "number" ||
      typeof raw["updatedAt"] !== "string"
    ) {
      throw new CredentialStoreError(
        "corrupt",
        `credential for ${name} has no revision or timestamp`,
      );
    }
    parsedServers[name] = {
      serverName:
        typeof raw["serverName"] === "string" ? raw["serverName"] : name,
      serverUrl: typeof raw["serverUrl"] === "string" ? raw["serverUrl"] : "",
      issuer: typeof raw["issuer"] === "string" ? raw["issuer"] : "",
      client: {
        clientId: client["clientId"],
        ...(typeof client["metadataUrl"] === "string"
          ? { metadataUrl: client["metadataUrl"] }
          : {}),
      },
      tokens: {
        accessToken: tokens["accessToken"],
        tokenType:
          typeof tokens["tokenType"] === "string"
            ? tokens["tokenType"]
            : "Bearer",
        ...(typeof tokens["refreshToken"] === "string"
          ? { refreshToken: tokens["refreshToken"] }
          : {}),
        ...(typeof tokens["expiresAt"] === "number"
          ? { expiresAt: tokens["expiresAt"] }
          : {}),
        ...(typeof tokens["scope"] === "string"
          ? { scope: tokens["scope"] }
          : {}),
      },
      revision: raw["revision"],
      updatedAt: raw["updatedAt"],
    };
  }

  const parsedTombstones: Record<string, CredentialTombstone> = {};
  for (const [name, raw] of Object.entries(tombstones)) {
    if (
      !isRecord(raw) ||
      typeof raw["revision"] !== "number" ||
      typeof raw["deletedAt"] !== "string"
    ) {
      throw new CredentialStoreError(
        "corrupt",
        `tombstone for ${name} is malformed`,
      );
    }
    parsedTombstones[name] = {
      serverName:
        typeof raw["serverName"] === "string" ? raw["serverName"] : name,
      serverUrl: typeof raw["serverUrl"] === "string" ? raw["serverUrl"] : "",
      revision: raw["revision"],
      deletedAt: raw["deletedAt"],
    };
  }

  return {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    servers: parsedServers,
    tombstones: parsedTombstones,
  };
}

/** Read the document; a missing store is an empty one, an unopenable one is an error. */
export async function readCredentials(
  options: CredentialStoreOptions,
): Promise<CredentialDocument> {
  const files = paths(options.stateDir);
  let sealed: Buffer;
  try {
    sealed = await readFile(files.sealed);
  } catch {
    return EMPTY;
  }
  let opened: Uint8Array;
  try {
    opened = await options.sealer.open(sealed);
  } catch (error) {
    throw new CredentialStoreError(
      "not-sealed",
      `the credential store could not be opened on this machine: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(opened).toString("utf8"));
  } catch {
    throw new CredentialStoreError(
      "corrupt",
      "the sealed credential document is not JSON",
    );
  }
  return parseDocument(parsed);
}

async function writeDocument(
  options: CredentialStoreOptions,
  document: CredentialDocument,
): Promise<void> {
  const files = paths(options.stateDir);
  await mkdir(options.stateDir, { recursive: true });
  const sealed = await options.sealer.seal(
    Buffer.from(JSON.stringify(document), "utf8"),
  );
  const temporary = `${files.sealed}.${process.pid}.tmp`;
  await writeFile(temporary, sealed, { mode: 0o600 });
  await rename(temporary, files.sealed);
  await writeFile(
    files.header,
    `${JSON.stringify({ schemaVersion: CREDENTIAL_SCHEMA_VERSION, updatedAt: new Date((options.now ?? Date.now)()).toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

export interface PutCredentialInput {
  readonly credential: Omit<StoredCredential, "revision" | "updatedAt">;
  /** The revision the caller read; a higher stored revision refuses the write. */
  readonly expectedRevision?: number;
}

/**
 * Store a credential.
 *
 * The revision is computed here: `max(stored, tombstone) + 1`, which makes an
 * interleaved writer fail rather than silently win.
 */
export async function putCredential(
  options: CredentialStoreOptions,
  input: PutCredentialInput,
): Promise<StoredCredential> {
  const document = await readCredentials(options);
  const name = input.credential.serverName;
  const stored = document.servers[name];
  const tombstone = document.tombstones[name];
  const current = Math.max(stored?.revision ?? 0, tombstone?.revision ?? 0);

  if (
    input.expectedRevision !== undefined &&
    current > input.expectedRevision
  ) {
    throw new CredentialStoreError(
      "stale",
      `credential for ${name} moved to revision ${current}; re-read before writing`,
    );
  }

  const credential: StoredCredential = {
    ...input.credential,
    revision: current + 1,
    updatedAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
  const tombstones = { ...document.tombstones };
  delete tombstones[name];
  await writeDocument(options, {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    servers: { ...document.servers, [name]: credential },
    tombstones,
  });
  return credential;
}

/** Remove a credential by writing a tombstone with a higher revision. */
export async function deleteCredential(
  options: CredentialStoreOptions,
  input: { readonly serverName: string; readonly serverUrl?: string },
): Promise<CredentialTombstone> {
  const document = await readCredentials(options);
  const stored = document.servers[input.serverName];
  const current = Math.max(
    stored?.revision ?? 0,
    document.tombstones[input.serverName]?.revision ?? 0,
  );
  const tombstone: CredentialTombstone = {
    serverName: input.serverName,
    serverUrl: input.serverUrl ?? stored?.serverUrl ?? "",
    revision: current + 1,
    deletedAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
  const servers = { ...document.servers };
  delete servers[input.serverName];
  await writeDocument(options, {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    servers,
    tombstones: { ...document.tombstones, [input.serverName]: tombstone },
  });
  return tombstone;
}

/** Remove both files entirely (a user-requested reset, not a revoke). */
export async function clearCredentialStore(
  options: CredentialStoreOptions,
): Promise<void> {
  const files = paths(options.stateDir);
  await rm(files.sealed, { force: true });
  await rm(files.header, { force: true });
}
