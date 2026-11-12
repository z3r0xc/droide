/**
 * The cache migration manifest and its ledger identity.
 * Contract: `specs/40-sessions-and-storage.md` B6-B11.
 *
 * The SQL assets are read from disk at startup (they are contract data, not
 * code); this module only names them, validates their ordering, and computes
 * the identity the ledger stores. The identity is a checksum over *normalised*
 * SQL, so reformatting a released migration keeps it (B7) while changing a
 * statement does not.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  DuplicateMigrationVersionError,
  InvalidMigrationVersionError,
} from "./errors.ts";

export interface SessionMigration {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

/** Ascending by version; the position is the only source of the number. */
const MIGRATION_FILES = [
  "0001_baseline.sql",
  "0002_transcript_summary_fingerprint.sql",
  "0003_tags_role_key.sql",
  "0004_daemon_session_fields.sql",
  "0005_schema_version.sql",
  "0006_spans_and_search.sql",
  "0007_term_prefixes.sql",
  "0008_whole_transcript_records.sql",
  "0009_vector_bookkeeping.sql",
  "0010_transcript_index.sql",
] as const;

interface MigrationSource {
  readonly version: number;
  readonly filename: string;
  readonly sql: string;
}

function loadSources(): readonly MigrationSource[] {
  return MIGRATION_FILES.map((filename, index) => ({
    version: index + 1,
    filename,
    sql: readFileSync(
      new URL(`./migrations/${filename}`, import.meta.url),
      "utf8",
    ),
  }));
}

/** `0003_tags_role_key.sql` -> `tags-role-key`, the name the ledger stores. */
export function migrationNameFromFilename(filename: string): string {
  const stem = filename.replace(/^\d+_/, "").replace(/\.sql$/, "");
  return stem.replace(/_/g, "-");
}

export function migrationChecksum(
  version: number,
  name: string,
  sql: string,
): string {
  const identity = `${version}\u0000${name}\u0000${normalizeMigrationSql(sql)}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/**
 * Strip comments, collapse whitespace and drop whitespace next to `(`, `)`,
 * `,` and `;` — the normalisation B7 defines. Quoted literals and identifiers
 * are copied verbatim so a string containing `--` or a comma cannot change the
 * identity of the statement around it.
 */
export function normalizeMigrationSql(sql: string): string {
  const parts: { readonly literal: boolean; readonly value: string }[] = [];
  let text = "";

  const flushText = (): void => {
    if (text.length > 0) {
      parts.push({ literal: false, value: text });
      text = "";
    }
  };

  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      text += " ";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      )
        index += 1;
      index += 2;
      text += " ";
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let literal = quote;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index] ?? "";
        literal += inner;
        index += 1;
        if (inner === quote) {
          if (sql[index] === quote) {
            literal += quote;
            index += 1;
            continue;
          }
          break;
        }
      }
      flushText();
      parts.push({ literal: true, value: literal });
      continue;
    }

    text += char ?? "";
    index += 1;
  }
  flushText();

  return parts
    .map((part) =>
      part.literal
        ? part.value
        : part.value.replace(/\s+/g, " ").replace(/ ?([(),;]) ?/g, "$1"),
    )
    .join("")
    .trim();
}

export function validateMigrations(
  migrations: readonly { readonly version: number; readonly name: string }[],
): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new InvalidMigrationVersionError(
        migration.version,
        "version must be a positive integer",
      );
    }
    if (seen.has(migration.version)) {
      throw new DuplicateMigrationVersionError(migration.version);
    }
    seen.add(migration.version);
  }
  for (let version = 1; version <= migrations.length; version += 1) {
    if (!seen.has(version)) {
      throw new InvalidMigrationVersionError(
        version,
        "versions must be contiguous from 1; missing",
      );
    }
  }
}

function loadMigrations(): readonly SessionMigration[] {
  const migrations = loadSources().map((source) => {
    const name = migrationNameFromFilename(source.filename);
    return {
      version: source.version,
      name,
      filename: source.filename,
      sql: source.sql,
      checksum: migrationChecksum(source.version, name, source.sql),
    };
  });
  validateMigrations(migrations);
  return migrations;
}

export const CACHE_MIGRATIONS: readonly SessionMigration[] = loadMigrations();

export const CACHE_SCHEMA_VERSION: number =
  CACHE_MIGRATIONS.at(-1)?.version ?? 0;
