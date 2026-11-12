# Session store

SQLite projection of the JSONL session transcripts. Contract:
`specs/40-sessions-and-storage.md`. Paths are the config layer's job; this
package takes a `dbPath`, a `sessionsDir`, and an injected clock.

## Schema map (head version 9)

| object | purpose |
|---|---|
| `schema_migrations` | ledger: `version, name, checksum, applied_at` |
| `meta` | `refresh_lease_until`, `vector_epoch` (seeded `'0'`) |
| `sessions` | product row; `tags` is a JSONB object, `project_key` locates the files |
| `session_ingest` | per-file bookkeeping: mtime/size/offset, counts, span tail |
| `session_spans` | span text + embedding columns, cascade from `sessions` |
| `session_term_filters` | one bloom filter blob per session |

Seven indexes (`sessions_parent`, `sessions_caller`, `sessions_mission`, the
expression index `sessions_subagent`, `sessions_recency`, plus the two partial
`session_spans_*` indexes) and five triggers (`sessions_settings_rewritten`,
`sessions_daemon_fields_stale`, the three `session_spans_vector_*`).

## Invariants

- Migrations are append-only assets; identity is
  `sha256("<version>\0<name>\0<normalised sql>")[0..16)`, so comments and
  formatting do not change it. Each pending migration runs in its own
  `BEGIN IMMEDIATE`; an already-current file is not written at all.
- A ledger version this build does not know is refused (`SchemaTooNewError`):
  we cannot validate a shape we did not produce. (Spec B11 tolerates it; this
  slice deliberately does not.)
- Transcript paths are derived, never stored: `sessionsDir/<project_key>/<id>.jsonl`.
  A key that escapes the sessions dir is rejected.
- Appends update only an existing session. The file line is written first, then
  the index rows in one transaction; an index failure truncates the line back.
- `messages_count` only grows; `last_event_at` takes the max;
  `has_user_visible_messages` is set by a user message and never cleared.
- Listing excludes `btw` forks and (by default) archived rows; recency is
  `NULLIF(MAX(transcript_mtime_ms, last_event_at), 0)`.
- Search is a literal, case-insensitive scan of transcript values. Limits:
  sessions 1..1000, hits 1..20, context 0..1000, query <= 500 characters.
- Backups: `.metadata_never_index` beside the database (best effort).