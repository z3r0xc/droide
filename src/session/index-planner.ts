/**
 * Planning a refresh of the transcript index. Contract:
 * `specs/40-sessions-and-storage.md` B23-B30.
 *
 * The planner is pure: it sees a listing, a `stat` for a transcript path and the
 * rows an earlier pass left, and it decides one action per transcript. Reading
 * the file, extracting its searchable values and writing the rows belong to the
 * caller, which is what keeps the decision table testable without a disk or a
 * database.
 *
 * Identity is the sessions-relative transcript path; the decision is made from
 * the file's mtime and size alone. A file whose recorded fingerprint still
 * matches is skipped without being read, which is the whole point of an index:
 * a refresh over unchanged transcripts touches no file.
 */

/** `mtimeMs` is already truncated to whole milliseconds by the caller's stat. */
export interface TranscriptStat {
  readonly mtimeMs: number;
  readonly size: number;
}

/** One `<session id>.jsonl` found under the sessions directory. */
export interface ListedTranscript {
  /** Sessions-dir relative, `/`-separated: `<id>.jsonl` or `<key>/<id>.jsonl`. */
  readonly transcriptPath: string;
  readonly sessionId: string;
  readonly projectKey: string;
}

/** One `transcript_index` row as an earlier pass left it. */
export interface IndexedTranscriptRow extends ListedTranscript {
  readonly transcriptMtimeMs: number;
  readonly transcriptSize: number;
}

export interface TranscriptIndexPlannerInput {
  /** Every transcript currently on disk, in a deterministic order. */
  readonly list: () => readonly ListedTranscript[];
  /** `null` when the file is gone (or unreadable as a transcript). */
  readonly stat: (transcriptPath: string) => TranscriptStat | null;
  /** Rows written by earlier passes. */
  readonly indexed: readonly IndexedTranscriptRow[];
}

export type TranscriptIndexAction = "insert" | "update" | "skip" | "delete";

export interface TranscriptIndexPlanEntry extends ListedTranscript {
  readonly action: TranscriptIndexAction;
  /** The stat the decision was made from; `0` for a delete. */
  readonly mtimeMs: number;
  readonly size: number;
}

export interface TranscriptIndexPlanSummary {
  /** Transcripts on disk when the pass began. */
  readonly scanned: number;
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly skipped: number;
}

export interface TranscriptIndexPlan {
  readonly entries: readonly TranscriptIndexPlanEntry[];
  readonly summary: TranscriptIndexPlanSummary;
}

function entryFor(
  action: TranscriptIndexAction,
  transcript: ListedTranscript,
  stat: TranscriptStat | null,
): TranscriptIndexPlanEntry {
  return {
    action,
    transcriptPath: transcript.transcriptPath,
    sessionId: transcript.sessionId,
    projectKey: transcript.projectKey,
    mtimeMs: stat === null ? 0 : stat.mtimeMs,
    size: stat === null ? 0 : stat.size,
  };
}

function decide(
  transcript: ListedTranscript,
  stat: TranscriptStat | null,
  row: IndexedTranscriptRow | undefined,
): TranscriptIndexPlanEntry {
  if (stat === null) {
    // Listed, then vanished before it could be described: an existing row is
    // retired exactly as if the listing had missed it.
    return entryFor(row === undefined ? "skip" : "delete", transcript, null);
  }
  if (row === undefined) return entryFor("insert", transcript, stat);
  if (
    row.transcriptMtimeMs === stat.mtimeMs &&
    row.transcriptSize === stat.size
  )
    return entryFor("skip", transcript, stat);
  return entryFor("update", transcript, stat);
}

/**
 * Decide one action per transcript.
 *
 * A row is deleted only after the caller's `stat` confirms its file is gone: a
 * listing that misses a file must never erase a row that still has a transcript
 * (B30's re-stat rule). A row the listing missed but the stat still finds is
 * re-decided from its fingerprint, not deleted.
 */
export function planTranscriptIndex(
  input: TranscriptIndexPlannerInput,
): TranscriptIndexPlan {
  const indexedByPath = new Map<string, IndexedTranscriptRow>();
  for (const row of input.indexed) indexedByPath.set(row.transcriptPath, row);

  const listed = input.list();
  const listedPaths = new Set<string>();
  const entries: TranscriptIndexPlanEntry[] = [];

  for (const transcript of listed) {
    listedPaths.add(transcript.transcriptPath);
    entries.push(
      decide(
        transcript,
        input.stat(transcript.transcriptPath),
        indexedByPath.get(transcript.transcriptPath),
      ),
    );
  }

  // Rows whose file the listing did not mention: the stat is the authority.
  const unlisted = input.indexed
    .filter((row) => !listedPaths.has(row.transcriptPath))
    .sort((left, right) =>
      left.transcriptPath.localeCompare(right.transcriptPath),
    );
  for (const row of unlisted) {
    entries.push(decide(row, input.stat(row.transcriptPath), row));
  }

  const summary: TranscriptIndexPlanSummary = {
    scanned: listed.length,
    inserted: entries.filter((entry) => entry.action === "insert").length,
    updated: entries.filter((entry) => entry.action === "update").length,
    deleted: entries.filter((entry) => entry.action === "delete").length,
    skipped: entries.filter((entry) => entry.action === "skip").length,
  };
  return { entries, summary };
}
