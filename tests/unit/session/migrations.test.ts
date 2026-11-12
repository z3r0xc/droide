import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DuplicateMigrationVersionError,
  InvalidMigrationVersionError,
} from "../../../src/session/errors.ts";
import {
  CACHE_MIGRATIONS,
  CACHE_SCHEMA_VERSION,
  migrationChecksum,
  migrationNameFromFilename,
  normalizeMigrationSql,
  validateMigrations,
} from "../../../src/session/migrations.ts";

test("the manifest is ten contiguous migrations with the ledger's names", () => {
  assert.equal(CACHE_MIGRATIONS.length, 10);
  assert.equal(CACHE_SCHEMA_VERSION, 10);
  assert.deepEqual(
    CACHE_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    CACHE_MIGRATIONS.map((migration) => migration.name),
    [
      "baseline",
      "transcript-summary-fingerprint",
      "tags-role-key",
      "daemon-session-fields",
      "schema-version",
      "spans-and-search",
      "term-prefixes",
      "whole-transcript-records",
      "vector-bookkeeping",
      "transcript-index",
    ],
  );
});

test("a filename maps to the hyphenated ledger name", () => {
  assert.equal(
    migrationNameFromFilename("0003_tags_role_key.sql"),
    "tags-role-key",
  );
  assert.equal(migrationNameFromFilename("0001_baseline.sql"), "baseline");
});

test("comments and formatting do not change a migration's identity", () => {
  const baseline = CACHE_MIGRATIONS[0];
  assert.ok(baseline);
  const reformatted = `  -- a new comment\n/* another */\n\n${baseline.sql.replace(/\n/g, "\n\n  ")}\n`;
  assert.equal(
    migrationChecksum(baseline.version, baseline.name, reformatted),
    baseline.checksum,
  );
});

test("changing a statement changes the identity", () => {
  const baseline = CACHE_MIGRATIONS[0];
  assert.ok(baseline);
  const changed = baseline.sql.replace(
    "messages_count       INTEGER NOT NULL DEFAULT 0",
    "messages_count INTEGER NOT NULL DEFAULT 1",
  );
  assert.notEqual(
    migrationChecksum(baseline.version, baseline.name, changed),
    baseline.checksum,
  );
});

test("normalisation keeps quoted literals verbatim, including comment markers", () => {
  assert.equal(
    normalizeMigrationSql("SELECT '-- keep  this', \"a, b\" -- drop\n;"),
    "SELECT '-- keep  this',\"a, b\";",
  );
  assert.equal(normalizeMigrationSql("/* gone */ SELECT  1 ;"), "SELECT 1;");
});

test("a duplicate, non-positive or gapped version fails validation", () => {
  assert.throws(
    () =>
      validateMigrations([
        { version: 1, name: "a" },
        { version: 1, name: "b" },
      ]),
    DuplicateMigrationVersionError,
  );
  assert.throws(
    () => validateMigrations([{ version: 0, name: "a" }]),
    InvalidMigrationVersionError,
  );
  assert.throws(
    () =>
      validateMigrations([
        { version: 1, name: "a" },
        { version: 3, name: "c" },
      ]),
    InvalidMigrationVersionError,
  );
});
