import assert from "node:assert/strict";
import { test } from "node:test";

import {
  planTranscriptIndex,
  type IndexedTranscriptRow,
  type ListedTranscript,
  type TranscriptStat,
} from "../../../src/session/index-planner.ts";

const ID_A = "3f2b8c1e-9a4d-4f6b-8c2e-1a2b3c4d5e6f";
const ID_B = "0c9f8a7b-6d5e-4c3b-2a19-8f7e6d5c4b3a";

function listed(projectKey = ""): readonly ListedTranscript[] {
  return [
    {
      transcriptPath:
        projectKey === "" ? `${ID_A}.jsonl` : `${projectKey}/${ID_A}.jsonl`,
      sessionId: ID_A,
      projectKey,
    },
    {
      transcriptPath:
        projectKey === "" ? `${ID_B}.jsonl` : `${projectKey}/${ID_B}.jsonl`,
      sessionId: ID_B,
      projectKey,
    },
  ];
}

function stat(mtimeMs: number, size: number): TranscriptStat {
  return { mtimeMs, size };
}

function row(
  transcript: ListedTranscript,
  mtimeMs: number,
  size: number,
): IndexedTranscriptRow {
  return {
    ...transcript,
    transcriptMtimeMs: mtimeMs,
    transcriptSize: size,
  };
}

test("a transcript with no row is inserted, an unchanged one is skipped", () => {
  const files = listed();
  const first = files[0];
  const second = files[1];
  assert.ok(first !== undefined && second !== undefined);
  const plan = planTranscriptIndex({
    list: () => files,
    stat: (path) =>
      path === first.transcriptPath ? stat(10, 100) : stat(20, 200),
    indexed: [row(second, 20, 200)],
  });

  assert.deepEqual(
    plan.entries.map((entry) => `${entry.action}:${entry.sessionId}`),
    [`insert:${ID_A}`, `skip:${ID_B}`],
  );
  assert.deepEqual(plan.summary, {
    scanned: 2,
    inserted: 1,
    updated: 0,
    deleted: 0,
    skipped: 1,
  });
});

test("a retitled transcript whose mtime was restored is updated when it grew", () => {
  const files = listed();
  const first = files[0];
  assert.ok(first !== undefined);
  // A longer title rewrites line 1: mtime is restored by the writer but the
  // size cannot be, which is the fingerprint the plan compares (B23).
  const plan = planTranscriptIndex({
    list: () => [first],
    stat: () => stat(10, 120),
    indexed: [row(first, 10, 100)],
  });
  assert.equal(plan.entries[0]?.action, "update");
  assert.equal(plan.summary.updated, 1);
});

test("a retitle that restores mtime and keeps the size is invisible to the plan", () => {
  const files = listed();
  const first = files[0];
  assert.ok(first !== undefined);
  const plan = planTranscriptIndex({
    list: () => [first],
    stat: () => stat(10, 100),
    indexed: [row(first, 10, 100)],
  });
  // Documented limitation: (mtime, size) cannot see it; only a file that grew,
  // shrank or was touched is re-read.
  assert.equal(plan.entries[0]?.action, "skip");
  assert.equal(plan.summary.skipped, 1);
});

test("a size change alone is an update even when the mtime matches", () => {
  const files = listed();
  const first = files[0];
  assert.ok(first !== undefined);
  const plan = planTranscriptIndex({
    list: () => [first],
    stat: () => stat(10, 140),
    indexed: [row(first, 10, 100)],
  });
  assert.equal(plan.entries[0]?.action, "update");
});

test("a row whose file is gone is deleted only after a re-stat", () => {
  const files = listed();
  const first = files[0];
  const second = files[1];
  assert.ok(first !== undefined && second !== undefined);

  const gone = planTranscriptIndex({
    list: () => [first],
    stat: (path) => (path === first.transcriptPath ? stat(10, 100) : null),
    indexed: [row(first, 10, 100), row(second, 20, 200)],
  });
  assert.deepEqual(
    gone.entries.map((entry) => `${entry.action}:${entry.transcriptPath}`),
    [`skip:${first.transcriptPath}`, `delete:${second.transcriptPath}`],
  );
  assert.deepEqual(gone.summary, {
    scanned: 1,
    inserted: 0,
    updated: 0,
    deleted: 1,
    skipped: 1,
  });
});

test("a listed transcript that vanishes before its stat is retired, not read", () => {
  const files = listed();
  const first = files[0];
  const second = files[1];
  assert.ok(first !== undefined && second !== undefined);
  const plan = planTranscriptIndex({
    list: () => [first, second],
    stat: () => null,
    indexed: [row(first, 10, 100)],
  });
  assert.deepEqual(
    plan.entries.map((entry) => `${entry.action}:${entry.sessionId}`),
    [`delete:${ID_A}`, `skip:${ID_B}`],
  );
});

test("a row the listing missed but the disk still has is re-decided, not deleted", () => {
  const files = listed();
  const first = files[0];
  assert.ok(first !== undefined);
  const plan = planTranscriptIndex({
    list: () => [],
    stat: () => stat(30, 300),
    indexed: [row(first, 10, 100)],
  });
  assert.equal(plan.entries[0]?.action, "update");
  assert.equal(plan.summary.deleted, 0);
});
