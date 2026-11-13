/**
 * The local half of Remote Control registration.
 *
 * Contract: `specs/70-daemon-and-remote-control.md` §B25–B27. `register`,
 * `remove` and the tunnels need the backend (CreateComputer, relay dial), which
 * this build does not have — they stay refused with clause-named markers.
 * What *is* local is the file they write, so `computer list` reads it and tells
 * the truth about state instead of leaving the command opaque.
 *
 * The file is untrusted: a hand-edited or half-written `host.json` becomes a
 * diagnostic, never an exception.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ComputerRegistration {
  readonly computerId: string;
  readonly firestoreOrgId: string;
  readonly userId: string;
  readonly registeredAt?: string;
}

export interface HostConfig {
  readonly schemaVersion: number;
  readonly hostId?: string;
  readonly provisioningId?: string;
  readonly createdAt?: string;
  readonly registration?: ComputerRegistration;
}

export interface HostConfigResult {
  readonly path: string;
  readonly config?: HostConfig;
  readonly diagnostic?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read `<stateDir>/host.json`. A missing file is not a problem. */
export function readHostConfig(stateDir: string): HostConfigResult | undefined {
  const path = join(stateDir, "host.json");
  let document: string;
  try {
    document = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    return {
      path,
      diagnostic: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { path, diagnostic: "expected a JSON object" };
  }

  const record = parsed as Record<string, unknown>;
  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== 1) {
    return {
      path,
      diagnostic: `unsupported schemaVersion ${String(schemaVersion)} (this build reads 1)`,
    };
  }

  const hostId = readString(record, "hostId");
  const provisioningId = readString(record, "provisioningId");
  const createdAt = readString(record, "createdAt");

  let registration: ComputerRegistration | undefined;
  const raw = record["computerRegistration"];
  if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { path, diagnostic: "computerRegistration must be an object" };
    }
    const entry = isPlainRecord(raw) ? raw : undefined;
    if (entry === undefined)
      return { path, diagnostic: "computerRegistration must be an object" };
    const computerId = readString(entry, "computerId");
    const firestoreOrgId = readString(entry, "firestoreOrgId");
    const userId = readString(entry, "userId");
    if (
      computerId === undefined ||
      firestoreOrgId === undefined ||
      userId === undefined
    ) {
      const missing = [
        computerId === undefined ? "computerId" : undefined,
        firestoreOrgId === undefined ? "firestoreOrgId" : undefined,
        userId === undefined ? "userId" : undefined,
      ].filter((field): field is string => field !== undefined);
      return {
        path,
        diagnostic: `computerRegistration is missing ${missing.join(", ")}`,
      };
    }
    const registeredAt = readString(entry, "registeredAt");
    registration = {
      computerId,
      firestoreOrgId,
      userId,
      ...(registeredAt === undefined ? {} : { registeredAt }),
    };
  }

  return {
    path,
    config: {
      schemaVersion: 1,
      ...(hostId === undefined ? {} : { hostId }),
      ...(provisioningId === undefined ? {} : { provisioningId }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(registration === undefined ? {} : { registration }),
    },
  };
}

export interface RenderComputerListOptions {
  /** The signed-in user, when known: a registration for someone else is inert. */
  readonly userId?: string;
  readonly organizationId?: string;
}

/** Render what the local file says. Wording is ours (the catalogue is missing). */
export function renderComputerList(
  files: readonly (HostConfigResult | undefined)[],
  options: RenderComputerListOptions = {},
): string {
  const present = files.filter(
    (file): file is HostConfigResult => file !== undefined,
  );
  const registered = present.filter(
    (file) => file.config?.registration !== undefined,
  );

  if (registered.length === 0) {
    const problems = present.filter((file) => file.diagnostic !== undefined);
    const lines = ["this machine is not registered for Remote Control"];
    for (const file of problems)
      lines.push(`  ${file.path}: ${file.diagnostic}`);
    return `${lines.join("\n")}\n`;
  }

  const lines: string[] = [];
  for (const file of registered) {
    const registration = file.config?.registration;
    if (registration === undefined) continue;
    const scope = file.path;
    lines.push(`computer ${registration.computerId}`);
    lines.push(`  host id: ${file.config?.hostId ?? "(none)"}`);
    if (registration.registeredAt !== undefined)
      lines.push(`  registered: ${registration.registeredAt}`);
    if (
      options.userId !== undefined &&
      options.userId !== registration.userId
    ) {
      lines.push(
        "  state: registered for a different user — inert until you sign in as that user",
      );
    } else if (
      options.organizationId !== undefined &&
      options.organizationId !== registration.firestoreOrgId
    ) {
      lines.push(
        "  state: registered for a different organization — inert until you switch back",
      );
    } else {
      lines.push(
        "  state: registered (remote control itself is not enabled in this build)",
      );
    }
    lines.push(`  file: ${scope}`);
  }
  for (const file of present.filter(
    (entry) => entry.diagnostic !== undefined,
  )) {
    lines.push(`problem: ${file.path}: ${file.diagnostic}`);
  }
  return `${lines.join("\n")}\n`;
}
