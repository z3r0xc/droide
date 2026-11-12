# Sessions, session store and session search

- **Target:** Factory AI `droid` 1.9.0
- **Status:** review
- **Owner:** storage / session index
- **Related:** `specs/00-context.md`, `specs/template.md`; session transcript *writer* and `/btw` forks are the CLI session lifecycle; daemon RPC surface (`SEARCH_SESSIONS`) is the daemon spec; embeddings/semantic recall are their own slice. Tool ids: none.

## Purpose

`droid` keeps one durable artefact per session — a JSONL transcript plus an
optional settings file under `<home>/<dir>/sessions/` — and projects it into a
local SQLite *session index* that answers "list my sessions" and "search my
sessions" without reading every file. This spec pins that projection: the
database's shape and versioning, the rules that decide when a row is rewritten
or restarted, the on-disk layout (including the WAL and lock behaviour the CLI
and the daemon share), and the observable contract of `droid search` (alias
`find`). The index is a disposable projection: every failure below is answered
by rebuilding, never by losing a transcript.

## Scope

In scope: the cache database DDL (all nine cache migrations), the annotations
database DDL (its one migration), the migration ledger and open/recovery
envelope, row and append write semantics, ingest/refresh planning and
compaction of stale rows, the filesystem layout under the Factory home, and the
`droid search|find` CLI contract.

Out of scope, covered elsewhere:

- The transcript **format** (event types, `session_start`, message blocks) and
  who writes it — session lifecycle spec. This spec only consumes it.
- `droid exec`, TUI interaction, resume/fork pickers (`--resume`, `--last`) as
  commands — CLI spec. Only their data dependency (listing order) is here.
- Cloud sync, federated search results merging and the daemon's JSON-RPC
  transport — daemon / cloud-sync specs. This spec records only what the local
  side contributes to those shapes.
- Semantic search quality (embedding model, span ranking) — semantic search
  slice. The tables it owns are inventoried here because they are part of the
  schema contract; its algorithm is not.
- Per-line span text rules (`MAX_SPAN_CHARS` etc.) — semantic slice.

Deliberately deferred: exact human-facing i18n strings (the message catalogs are
not in the recovered source; see Open question 1).

## Terms

- **Factory home** — the user's home directory (`os.homedir()`) unless
  `FACTORY_HOME_OVERRIDE` is set (`packages/runtime/cli/src/home/index.ts:19-21`,
  `packages/runtime/cli/src/environment.ts:1-3`).
- **Factory dir name** — `.factory` in production, `.factory-dev` otherwise
  (`packages/environment/src/constants/index.ts:6-9`,
  `packages/utils/src/environment/factory-dir-name/index.ts:12-14`). Written
  below as `<base>` = `Factory home` + `/` + `Factory dir name`.
- **Sessions dir** — `<base>/sessions` (`packages/runtime/session-index/src/access.ts:85-87`).
- **Transcript** — `<sessions dir>/<project dir>/<session id>.jsonl`; the
  **settings file** is the sibling `<session id>.settings.json` and is optional.
- **project_key** — the transcript's directory *relative to the sessions dir*:
  `''` (global root), `'btw'`, or a sanitized project directory that always
  begins with `-` (`packages/runtime/session-paths/src/index.ts:102-124`).
- **Cache database** — `<base>/cache/session-index/index.db`
  (`packages/runtime/session-index/src/cache.ts:38-40`) plus its `-wal` and
  `-shm` sidecars.
- **Annotations database** — a second, separate SQLite file with its own
  migration ledger; see B37. Path is not present in the recovered source
  (Open question 2).
- **Cache migration** — one numbered, append-only SQL asset applied in place;
  **annotations migration** — the same for the other file, independent ledger.
- **Ledger** — table `schema_migrations` (`version`, `name`, `checksum`,
  `applied_at`) in both files
  (`packages/runtime/session-index/src/constants.ts:9-22`).
- **Mutation write** — the per-session row write the CLI's discovery hook issues
  when it notices a session changed (`record.ts:80-90`).
- **Append write** — a write from a producer that knows only that lines were
  added (`record.ts:176-194`).
- **Ingest / refresh** — the pass that reads transcripts and settings files and
  computes rows (`ingest.ts`, `discovery.ts`).
- **Summary line** — the transcript's first JSONL line (`session_start`).
- **Summary fingerprint** — 16 hex chars of `sha256(summaryLine.trim())`
  (`discovery.ts:43-48`).
- **Span** — a stretch of user/assistant prose stored in `session_spans`
  (`0006_spans_and_search*.sql:43-45`).
- **Term filter** — a bloom filter over one session's terms
  (`0006_spans_and_search*.sql:117-121`).
- **Hit** — one match inside a session, identified by `docId`.
- **`docId`** — locally `line:<n>` with a 1-based transcript line
  (`packages/utils/src/session-search/hit.ts:48-51`); the compact formatter also
  accepts `event:<id>` and `session:<id>` forms (`src/search/sessionSearch.ts:276-280`).
- **Kind** — `message_text` | `document` | `tool_use` | `tool_result`
  (`packages/droid-sdk-core/src/protocol/daemon/schemas/enums.ts:714-719`).

Citation note: two cache migrations (`0001_baseline`, `0003_tags_role_key`) are
stored UTF-16LE in the bundle. Line numbers cited for them are of the decoded
text; every other file is ASCII/UTF-8 and cited as-is.

Citation conventions, to keep the clauses short: a bare module name
(`record.ts`, `search.ts`, `ingest.ts`, `listing.ts`, `driver.ts`,
`migrate.ts`, `schema.ts`, `cache.ts`, `constants.ts`, `lease.ts`,
`discovery.ts`, `semantic.ts`, `daemon-search.ts`) means
`evidence/original/windows-x64/packages/runtime/session-index/src/<name>`;
a path beginning `src/` means `evidence/original/windows-x64/src/`; a path
beginning `packages/` means `evidence/original/windows-x64/packages/`; and a
`<number>_<name>*.sql` asset means
`evidence/extracted/windows-x64/<number>_<name>-<hash>.sql`.

## Observable behaviour

### Open, layout and lifecycle

**B1.** Opening the index creates `<base>/cache/session-index/` if absent and
writes an empty `.metadata_never_index` marker beside the database (best
effort; a failure never blocks the open)
(`packages/runtime/session-index/src/cache.ts:56-66`, `148-166`). `[observed]`

**B2.** Every open applies the connection PRAGMAs in this order:
`journal_mode = WAL`, `wal_autocheckpoint = 0`,
`journal_size_limit = 524288`, `synchronous = NORMAL`, `busy_timeout = 0`,
`foreign_keys = ON`. Before them, `auto_vacuum` is read and set to
`INCREMENTAL` only when the file is not already in that mode
(`constants.ts:302-341`, `driver.ts:860-872`). Resting `busy_timeout` is 0; it is
raised only for the duration of work a caller is waiting on: 5000 ms for
migrations, the refresh and lease claims (`DELIBERATE_BUSY_TIMEOUT_MS`), 25 ms
for a mutation/append write (`MUTATION_BUSY_TIMEOUT_MS`), then restored to 0
(`constants.ts:158-200`, `driver.ts:911-919`). `[observed]`

**B3.** The write-ahead log is checkpointed explicitly, never by SQLite's page
threshold: `PASSIVE` at most once per 64 writes (`WAL_CHECKPOINT_WRITE_INTERVAL`),
scheduled off the writing frame; after 128 un-checkpointed writes a write is
declined (returned as "refused", retried by the caller) rather than
checkpointing inline; `TRUNCATE` after a migration batch and on
`close()`; every 1024 files during a refresh (`constants.ts:237-302`,
`record.ts:620-698`, `driver.ts:955-970`, `migrate.ts:368-386`). `[observed]`

**B4.** One refresh runs at a time per file. The claim is a `meta` row
`refresh_lease_until` holding `<untilMs>:<pid>`, leased for 60000 ms, renewed at
half-life, reclaimed immediately when the recorded pid is not alive; a second
refresher returns without reading (`constants.ts:116-146`,
`lease.ts:29-82`). `[observed]`

**B5.** With the index, a listing answers from the index or rejects; it never
walks the sessions directory. A listing waits out a busy peer for up to 10000 ms
(other outcomes are final) and then fails with
`Session index unavailable for listing` / `Could not list sessions from the
session index` (`state: unavailable`, `reason` = error class)
(`listing.ts:284-310`, `373-421`). A failed open is retried at most once every
10000 ms; a `busy` outcome is retried immediately (`access.ts:119`, `747-800`,
`918-925`). When the disk is full the listing is served from an
`immutable=1` snapshot of the main file, missing whatever is still in the WAL
(`listing.ts:313-340`, `398-403`). Writes never fail a session: a refused write
is retried by the caller after it yields (`record.ts:697-740`). `[observed]`

### Migrations and downgrade

**B6.** Migration versions come from the asset manifest, are contiguous from 1,
and are applied in ascending order; a list containing a duplicate version or a
version below 1 fails at import time with `Duplicate session index migration
version` / `Session index migration version must be positive`
(`migrate.ts:40-65`, `src/migrations.generated.ts:15-61`). `[observed]`

**B7.** A migration's identity in the ledger is
`sha256("<version>\0<name>\0<normalized sql>")[0..16)`, where normalization strips
`--` and `/* */` comments, collapses runs of whitespace and removes whitespace
adjacent to `(`, `)`, `,` and `;`, while copying quoted literals verbatim
(`migrate.ts:87-183`). Consequently reformatting or commenting a released
migration keeps its identity; changing a statement does not. `[observed]`

**B8.** A database with no pending migrations is not written to at all — but its
ledger is still validated (`migrate.ts:315-325`). `[observed]`

**B9.** Each pending migration runs in its own `BEGIN IMMEDIATE` transaction
that re-reads the ledger, re-checks compatibility, skips if a peer already
committed that version (logged as `applied-by-peer`), executes the SQL and
inserts the ledger row with `Date.now()` (`migrate.ts:315-366`). `[observed]`

**B10.** A ledger row whose version this build knows but whose checksum differs
fails the open with `Session index migration checksum mismatch`; the file is
left in place (`migrate.ts:209-235`). `[observed]`

**B11.** A ledger row whose version this build does **not** know is tolerated
("the file is ahead"): an older binary keeps opening a newer file. Only unknown
versions are tolerated — known versions are still checksum-checked
(`migrate.ts:186-195`, `cache.ts:72-78`). `[observed]`

**B12.** After migrations, the open compares the file's catalog with the shape
this build's migrations produce in a throwaway `:memory:` database
(`schema.ts:203-238`). Required: every table, every column of the inspected
tables, and every index named by the expected shape. Extra tables and indexes
are tolerated. A column whose declared type/notnull/default/pk differs is a
fault **unless** the ledger is ahead. A trigger or view count above the
expected count is a fault unless the ledger is ahead. First failure wins, in
table → column → index → foreign-object order, and the open fails with
`Session index database is not shaped like this build` whose `key` names
`table`, `table.column` or the index (`schema.ts:29-45`, `142-197`,
`cache.ts:104-131`). `[observed]`

**B13.** Only the tables this build owns have their columns read; a foreign
table is recorded as present and not described (`schema.ts:111-140`). `[observed]`

**B14.** A file whose pages SQLite reports as unusable (`SQLITE_CORRUPT`,
`SQLITE_CORRUPT_VTAB`, `SQLITE_CORRUPT_SEQUENCE`, `SQLITE_CORRUPT_INDEX`,
`SQLITE_NOTADB`) is **moved** — never deleted — into
`<db dir>/quarantine/<ISO-8601 with : and . replaced>_<pid>/`, sidecars first,
then the main file, then any sidecar that appeared at the live path (as
`<name><suffix>.late`). At most the two newest quarantine folders holding that
database are kept. The open then retries once on a fresh file; a second failure
propagates and leaves the fresh file where it is (`driver.ts:700-765`,
`293-305`, `migrate.ts:407-470`). A move the filesystem refuses (a peer holds
the file on Windows) logs `database quarantine failed` and rethrows the original
failure (`driver.ts:777-806`). `[observed]`

**B15.** Every other open failure — checksum mismatch, pre-ledger file, a shape
the statements cannot use, `SQLITE_FULL`, permissions, a lock — leaves the file
exactly where it is and propagates (`migrate.ts:389-398`, `452-468`). `[observed]`

**B16.** A read-only snapshot open (`immutable=1`, no locks, no sidecars) exists
for a full disk and reads only the main file, missing whatever is still in the
WAL (`driver.ts:1015-1022`). `[observed]`

### Row write rules

**B17.** A session's identity is its id: a lowercase UUIDv4 string taken from
the transcript's file name (`src/utils/uuid.ts:1-9`,
`discovery.ts:238`). The two file paths are **derived** from
`(sessions dir, project_key, session id)`, never stored; a row whose derivation
would escape the sessions dir is rejected with
`Indexed session resolves outside the sessions dir` and only the session id is
reported (`session-paths/src/index.ts:126-160`, `record.ts:313-325`). `[observed]`

**B18.** A mutation write inserts the row when absent and otherwise updates it,
with these monotonic rules: `project_key` always takes the new value; the
summary-derived columns (`cwd`, `title`, `org_id`, `owner`, `host_id`, `parent`,
`calling_session_id`, `calling_tool_use_id`) are overwritten **only** when the
producer states it read or wrote the summary line; `first_event_at` only rises
from NULL (`COALESCE`); `has_user_visible_messages` and `last_event_at` and
`messages_count` take `MAX` of old and new (`record.ts:92-174`). `[observed]`

**B19.** The settings-derived columns (`mission`, `tags` as JSONB, `archived_at`,
`worktree`, `artifacts`, `settings_write_seq`) are written only when the
writer's settings read is at least as new as the mtime the row records; a
writer that saw no settings file wins only over a row that records no read, and
the unread marker `-1` loses to any read. After the columns are written the
invoking write records `session_ingest.settings_mtime_ms`
(`record.ts:392-489`, `206-211`). `[observed]`

**B20.** An append write updates only an existing row: `messages_count` grows by
the number of the append's lines that end past `session_ingest.transcript_offset`,
`last_event_at` takes the max, and `has_user_visible_messages` is set to 1 when
the append reports visible content (never cleared) (`record.ts:186-194`,
`220-233`, `912-924`). `[observed]`

**B21.** All writes of one call are one `BEGIN IMMEDIATE` transaction under the
mutation `busy_timeout`; a corruption error reports corruption to the owner and
a busy/locked error returns "refused" (the caller retries after yielding); any
other error throws (`record.ts:697-740`). `[observed]`

**B22.** Writing `tags`, `mission` or `archived_at` on `sessions` fires
`sessions_settings_rewritten`, which sets that row's `settings_mtime_ms = -1`
(settings unread) (`0003_tags_role_key*.sql:33-38`), and fires
`sessions_daemon_fields_stale`, which nulls `settings_write_seq` when the write
did not itself advance it (`0004_daemon_session_fields*.sql:27-33`). A build
that knows the rule records the settings mtime afterwards, in the same
transaction, so it is not re-read. `[observed]`

### Refresh, compaction and fingerprint

**B23.** Discovery decides a file is unchanged without reading it when
`mtime == ctime`, and the stored mtime, size and `project_key` all still match
and a fingerprint is stored — because renaming a session rewrites line 1 and can
restore the old mtime, but cannot restore ctime (`discovery.ts:195-224`). `[observed]`

**B24.** A row is **restarted** (transcript read from byte 0) when: the summary
line is unusable; the row was never ingested; the file shrank; the size matches
but the mtime differs; the `project_key` changed (`ingest.ts:567-580`). `[observed]`

**B25.** When only the summary line changed and the row had been fully read
(`transcript_offset == transcript_size`, message counts equal, no backfill or
projection rebuild pending) the refresh **shifts** rather than restarts: it
re-reads the summary line and adjusts the offset by the size delta, trusting the
canonical append-only body (`ingest.ts:591-612`). `[observed]`

**B26.** Otherwise the transcript is resumed from `transcript_offset`; a
projection rebuild (missing or untrusted term filter, a filter smaller than the
file needs, a span tail beyond the offset) or a migration backfill restarts the
transcript in place while keeping the row (`ingest.ts:580-632`). `[observed]`

Every rewrite a transcript writer performs — a compaction that replaces the
history, a fork that copies it, a rename that replaces line 1 — is classified by
this table alone (size, mtime, fingerprint, `project_key`); the index never
inspects the rewrite's intent. `[inferred]` for the write shapes themselves,
which belong to the session-lifecycle spec; the classification is `[observed]`.

**B27.** A restart of a **rewritten** transcript (`keepsRow` false) deletes the
row and, by cascade, its `session_ingest`/span/filter rows, then re-inserts a
minimal `(session_id, project_key)` row before writing the recomputed columns; a
restart in place keeps the row so settings-derived columns survive. A file that
fails as a skipped session (no summary, unusable summary) has its existing row
deleted under the same `skipIfMoved` fence (`ingest.ts:1600-1616`,
`1748-1775`). `[observed]`

**B28.** The refresh writes one row per file in a single transaction:
`sessions` (the same rules as B18/B19) plus the `session_ingest` upsert of
`transcript_mtime_ms`, `transcript_size`, `transcript_summary_fingerprint`,
`transcript_offset`, `transcript_skipped_lines`, `transcript_messages_count`,
`settings_mtime_ms`, the three span-tail columns and `schema_version`
(`ingest.ts:1208-1235`). `[observed]`

**B29.** A per-session refresh requested with `skipIfMoved` leaves the row alone
when another writer committed it since the pass read its state; the comparison
is made inside the write's transaction (`ingest.ts:1310-1355`). `[observed]`

**B30.** At the end of a **complete** discovery pass, rows whose transcript no
longer exists are deleted — each only after re-`stat` and only while the row is
still exactly as the pass stored it — inside one deliberate-timeout
transaction; a verification failure leaves the rows and marks the pass
incomplete (`ingest.ts:2147-2230`). `[observed]`

**B31.** `session_ingest` is deleted with its session
(`ON DELETE CASCADE`), so a re-ingest of that id starts from byte zero
(`0001_baseline*.sql:176-179`). `session_spans` and `session_term_filters`
cascade the same way (`0006_spans_and_search*.sql:8-10`, `81-82`, `130-132`). `[observed]`

**B32.** Each row carries `session_ingest.schema_version`, stamped on every
refresh write with `max(latest cache migration, 7)`; a mutation write that finds
a *higher* stamp lowers it to this build's version and lowers
`meta.last_full_refresh_schema_version` with it, so a newer build backfills what
this write may have rewritten (`ingest.ts:212-216`, `303-325`). `[observed]`

**B33.** `meta` keys written by the refresh: `last_full_refresh_at` (epoch ms,
set when a pass reached every transcript), `last_full_refresh_schema_version`
(set only when no row was left to backfill), `last_integrity_check_at`,
`vector_epoch` (`constants.ts:66-84`, `record.ts:833-868`). `[observed]`

**B34.** A term filter is trusted only on a row whose `schema_version` is at
least 7, with a filter present, and with `messages_count` not exceeding
`transcript_messages_count`; an untrusted filter is rebuilt from the whole
transcript by the next refresh that builds projections
(`search.ts:355-380`, `constants.ts:466-474`). `[observed]`

**B35.** Spans are upserted by `(session_id, span_index)`; when the text
changes the embedding columns (`scale`, `vector`, `text_sha256`) are cleared,
and unchanged text keeps them. `CHECK` constraints forbid a vector without its
scale and text hash, and forbid `synced_at` / `embedding_space` without a vector
(`0006_spans_and_search*.sql:81-112`). `[observed]`

**B36.** `session_spans` insert/delete/update triggers on vector-bearing columns
increment `meta.vector_epoch`, so a semantic search may reuse its loaded matrix
while the epoch is unchanged; a write that touches no vector does not move it
(`0009_vector_bookkeeping*.sql:22-48`). `[observed]`

**B37.** The annotations file uses its own ledger and one migration creating
`session_annotations` (primary key `(session_id, annotator, subject)`) and
`session_annotation_write_clock` (single row `id = 1`, `generation`, seeded with
0), plus four indexes, one of which is a partial index over unsettled rows
(`0001_session_annotations*.sql:3-37`). Quarantining that file must not prune
its copies, because paid output cannot be recomputed (`driver.ts:762-764`,
`migrate.ts:392-394`). `[observed]`

### Listing

**B38.** A listing row carries `modified_time_ms =
NULLIF(MAX(session_ingest.transcript_mtime_ms, sessions.last_event_at), 0)`, so
an append the mutation path reported after the last ingest still orders
correctly (`record.ts:239-264`). `[observed]`

**B39.** Row visibility uses the tenant rule: unless the airgap flag is on, rows
are `org_id IS NULL OR org_id = <active org>`, so with no active organization
only unattributed rows are visible (`record.ts:925-943`, `266-277`). `[derived]`
— two readers and a migration comment agree on the clause; see Open question 6.

**B40.** Listed sessions are ordered newest-first by `modifiedTime`, ties broken
in favour of the session whose `cwd` equals the current directory; BTW forks are
never listed; archived sessions appear only when requested
(`listing.ts:71-108`). `createdTime` is `first_event_at` when known. `[observed]`

**B41.** The entry listing (the daemon's) is cached in-process against a
version string built from `PRAGMA data_version` and `total_changes()`; an
unchanged version returns the previous array without re-reading
(`record.ts:545-556`, `945-968`, `driver.ts:1024-1031`). `[observed]`

**B42.** A file no covering refresh has reached (no `last_full_refresh_at`) is
still listed as it stands, after one shared wait of up to 2000 ms (polled every
50 ms) for the rebuild the open requested; a listing that times out returns what
is there, and later listings on that store do not wait again
(`listing.ts:216-270`, `360-372`). `[observed]`

### `droid search` / `find`

**B43.** Syntax: `droid search [options] <query>` (`find` is an alias). Options
and defaults: `--kind <message_text|document|tool_use|tool_result|all>` default
`all` (any other value is rejected); `--limit-sessions <n>` default 20;
`--limit-hits <n>` default 3; `--context-chars <n>` default 80; `--json`;
`--reindex`; `--include-archived`; `--exclude-children`; `--include-hidden`
(`src/entrypoints/search/command.ts:8-55`). The two limits accept digits only
and are refused with `Expected a positive integer.`; context is refused with
`Expected a non-negative integer.` (`src/utils/commanderParsers.ts:12-32`). `[observed]`

**B44.** Bounds are clamped by the shared rule: sessions to
`[1, ∞)` for this command (it opts out of the shared 100 ceiling), hits to
`[1, 20]`, context to `[0, 1000]`, and the query is trimmed; a query over 500
characters is rejected (`packages/utils/src/session-search/query.ts:44-73`,
`packages/common/src/session/constants.ts:77-86`, `src/entrypoints/search/run.ts:150-166`). `[observed]`

**B45.** The CLI searches in `regex` mode, so the query is a pattern over a
supported subset; an unsupported or unconstrained pattern is rejected before
any scan (`run.ts:150-156`, `utils/src/session-search/query.ts:464-503`). `[observed]`

**B46.** Scope filters: `--include-archived` (default excludes
`sessions.archived_at IS NOT NULL`), `--exclude-children` (default includes
sessions whose `calling_session_id` is set), `--include-hidden` (default excludes
`sessions.has_user_visible_messages = 0`), plus the org rule of B39 and the
optional `since`/`until`/`projectKey` windows (`search.ts:289-320`). `[observed]`

**B47.** Searched text is the file's raw JSONL, matched by a bundled `ripgrep`
(`--no-config --no-messages --text`, `--fixed-strings` for literal mode,
`--ignore-case` unless case-sensitive). A match counts only where it lies inside
a searchable value: the summary line's `title` and `cwd`; `message.content`
text; `text`/`thinking` blocks; a `tool_use` block's `name` and every value under
its `input`; a `tool_result` block's `content` (text parts only); a `document`
block's `source.data` when that source is text. Ids, signatures and base64
sources are not searchable (`utils/src/session-search/extract.ts:278-340`,
`search.ts:782-900`). `[observed]`

**B48.** A match in injected harness text inside a user message is discarded
(`search.ts:1560-1564`). Matches in titles do not count when `--kind` is set
(`search.ts:392-394`, `2143-2145`). `[observed]`

**B49.** Session order: title tier (exact title match, then title contains,
then the rest), then "a user wrote a match" (`message_text` in a `user` message,
not a summary field), then `last_event_at` descending, then `session_id`
descending (`utils/src/session-search/rank.ts:13-67`, `search.ts:2611-2626`). `[observed]`

**B50.** Hits within a session are the **newest** matching messages, scanned
newest-first, capped at `--limit-hits`; with `--kind` only blocks of that kind
count (`search.ts:2116-2196`). `[observed]`

**B51.** A result reports `sessionCount.count` plus `exact`, and `complete:
false` (with a coverage reason) when a scan budget (10 000 ms), a matcher
failure or a candidate source cut the page short
(`search.ts:126`, `3038-3064`; `src/search/sessionSearch.ts:229-240`). `[observed]`

**B52.** Snippets are the matched value trimmed to `--context-chars` on each
side (default radius 140 when the field is absent), prefixed/suffixed with `…`
when truncated, with `<mark>` around the match in the legacy engine and SGR
highlighting in the index engine (`search.ts:93`, `1584-1610`). `[observed]`

**B53.** Human output, index engine: one header line carrying a session count
(the `compactSessions` message when the count is exact and equals what is shown,
the `compactShowing` message with `count`/`shown`/`bound` otherwise), then one
block per session — `<sessionId> <title ≤60 chars> · <matchCount>` — then one
line per hit: `  L<n> <kind>[ <toolName>]: <snippet>` (the anchor is `L<line>`
for a `line:` docId and `@<id>` for an `event:` one), where `kind` is chosen by
`compactUser` / `compactDroid` / `compactCall` / `compactResult` /
`compactDocument`. At most 120 characters of snippet are
shown per hit, control sequences are stripped, and a `, <compactPartial>` suffix
marks an incomplete result (`src/search/sessionSearch.ts:200-341`). The literal
words come from `common:sessionSearch.*` and are Open question 1. `[observed]`

**B54.** `--json` writes `JSON.stringify(result, null, 2)` of the federated
result (sessions with `sessionId`, optional `title`, optional `updatedAt`,
`hits[{docId, kind, toolName?, messageRole?, snippets[]}]`, optional totals and
`sessionCount`) (`run.ts:167-170`). `[observed]`

**B55.** With the `session_index_search` flag off, `--include-archived`,
`--exclude-children` and `--include-hidden` are refused with
`--include-archived, --exclude-children and --include-hidden need the session
index, which is off`, and everything else runs the legacy on-disk engine, whose
human output is the grouped-by-kind rendering (`run.ts:143-149`,
`src/search/sessionSearch.ts:26-190`). `[observed]`

**B56.** A query rejected by the planner prints `sessionSearch.queryRejected` to
stderr and sets exit status 1; an abort (Ctrl-C) sets 130; any other failure
prints the search-failed message and sets 1 (`run.ts:160-173`). `[observed]`

## Data & config

### Our head: version 10 (a local design, labelled)

The subject's cache head is version 9. This build adds one migration of its own,
`0010_transcript_index`, because the retrieval shape we need is a *literal
transcript index* rather than the subject's `session_term_filters` planner.
The difference is deliberate and recorded here, not hidden:

| object | purpose |
|---|---|
| `transcript_index` | one row per transcript path: session, project key, mtime+size fingerprint, `indexed_at`, and six settings-derived columns (`mission`, `tags`, `archived_at`, `worktree`, `artifacts`, `settings_write_seq`) |
| `transcript_index_value` | one row per indexed line (`path`, `line`, `ordinal` PK): `kind`, `tool`, `role`, `summary`, lowercased `value`, FK-cascaded from `transcript_index` |
| 3 indexes | by session, by project key, and by lowercased value for the prefilter |
| 3 triggers | a changed fingerprint clears cached values; an insert seeds the settings copy; a `sessions` update keeps it synced |

**Invariant that keeps this honest.** The index only *prefilters*: a session is
skipped only when its fingerprint still matches its file **and** no cached value
matches the query. Everything else is scanned exactly as before, so the results
of `search()` are identical with the index on or off — proven by
`tests/integration/session/index.test.ts` (indexed vs literal parity over 15
query/option cases, plus a prefilter-trust case).

A binary database written by the subject is therefore *not* readable by this
build (different table names), and this build's database is not readable by the
subject. That is the cost of a clean-room index; it is stated here instead of
being discovered by a user.

### Cache database, head version 9

`schema_migrations` — `version INTEGER PRIMARY KEY`, `name TEXT NOT NULL`,
`checksum TEXT NOT NULL`, `applied_at INTEGER NOT NULL`
(`constants.ts:9-22`); created with `IF NOT EXISTS` on every open, unlike
migration SQL, which never uses `IF NOT EXISTS` (`0001_baseline*.sql:19-21`).

The nine migrations, and what each is *for* (a reimplementation must produce the
same head shape; only a migration's identity and effect are contract, not its
wording):

| v | ledger name | intent |
|---|---|---|
| 1 | `baseline` | The whole initial cache: `meta`, `sessions` (with `org_id`, `owner`, `parent`, `calling_session_id`, `calling_tool_use_id`, `mission`, `tags`, tri-state `has_user_visible_messages`), its five indexes, and `session_ingest` kept in its own table because its write class differs. **Frozen**: every later change is an appended migration, and a change that alters what a row *means* invalidates the bookkeeping so the refresh rewrites the rows (`0001_baseline*.sql:1-21`) |
| 2 | `transcript-summary-fingerprint` | Detect first-line rewrites whose writers preserve mtime (`0002_transcript_summary_fingerprint*.sql:1-4`) |
| 3 | `tags_role_key` | `tags` now carries a derived `mission-session:role` key; mark every row's settings unread with `-1` (not `0`, which is a real "no settings file"), drop `last_full_refresh_at` so readers fall back until a covering refresh, and add `sessions_settings_rewritten` for older builds' writes (`0003_tags_role_key*.sql:1-38`) |
| 4 | `daemon-session-fields` | Let the daemon list from the index alone: `host_id`, `worktree`, `artifacts`, and `settings_write_seq` (NULL = needs re-reading) with the `sessions_daemon_fields_stale` trigger (`0004_daemon_session_fields*.sql:1-33`) |
| 5 | `schema-version` | Per-row `schema_version`, so a backfill is named by a migration instead of a cleared marker; every row is NULL here, so the next refresh reads every summary line once (`0005_schema_version*.sql:1-20`) |
| 6 | `spans-and-search` | Everything retrieval stores: span-tail columns, `session_spans`, `session_term_filters`; additive, no backfill (`0006_spans_and_search*.sql:1-28`) |
| 7 | `term-prefixes` | Record the word-prefix rule for term filters. It shipped as `TERM_FILTER_SCHEMA_VERSION = 7` with no file, so the ledger takes the entry; the SQL is a no-op because a migration must contain a statement (`0007_term_prefixes*.sql:1-15`) |
| 8 | `whole-transcript-records` | Stop dropping over-long transcript records: rows stamped 7 that skipped nothing move to 8, rows that skipped a record are re-read from their start by the next refresh (`0008_whole_transcript_records*.sql:1-21`) |
| 9 | `vector-bookkeeping` | `meta.vector_epoch` plus the three `session_spans` triggers and the unembedded-span index, so semantic search can reuse its matrix (`0009_vector_bookkeeping*.sql:1-54`) |

Backfills are declared in code, not SQL: version 5 names the summary-line source
and version 8 the transcript source (`src/migrations.ts:28-38`).

`meta` — `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`
(`0001_baseline*.sql:23-26`). Known keys: `last_full_refresh_at`,
`last_full_refresh_schema_version`, `last_integrity_check_at`,
`refresh_lease_until`, `vector_epoch` (seeded `'0'`
by `0009_vector_bookkeeping*.sql:22`).

`sessions` (`0001_baseline*.sql:28-123` plus `0004_daemon_session_fields*.sql:22-25`):

| column | type | nullability / default | meaning |
|---|---|---|---|
| `session_id` | TEXT | PK | UUIDv4, transcript file stem |
| `project_key` | TEXT | NOT NULL | transcript dir relative to sessions dir; `''` is a real value |
| `cwd` | TEXT | | working directory from the summary |
| `title` | TEXT | | session title |
| `org_id` | TEXT | | tenancy; NULL means "not permitted to assume" |
| `owner` | TEXT | | tenancy |
| `parent` | TEXT | | `FactorySessionData.parent` |
| `calling_session_id` | TEXT | | parent session for subagents |
| `calling_tool_use_id` | TEXT | | tool call that spawned it |
| `mission` | TEXT | | mission id |
| `tags` | BLOB | NOT NULL DEFAULT `jsonb('{}')` | JSON object keyed by tag name |
| `has_user_visible_messages` | INTEGER | | tri-state: NULL undetermined, 0 hides |
| `archived_at` | TEXT | | archive marker |
| `first_event_at` | INTEGER | | epoch ms, first event (else file birth time) |
| `last_event_at` | INTEGER | | epoch ms, newest message |
| `messages_count` | INTEGER | NOT NULL DEFAULT 0 | every message in the transcript |
| `host_id` | TEXT | | host that ran it |
| `worktree` | TEXT | | JSON from the settings file |
| `artifacts` | TEXT | | JSON from the settings file |
| `settings_write_seq` | INTEGER | | NULL means the settings-derived columns need re-reading |

Indexes: `sessions_parent`, `sessions_caller`, `sessions_mission`
(`0001_baseline*.sql:124-126`), expression index
`sessions_subagent ON sessions(json_extract(tags, '$.subagent'))`
(`0001_baseline*.sql:139`), and
`sessions_recency ON sessions(org_id, owner, project_key, last_event_at)`
(`0001_baseline*.sql:152`).

`session_ingest` (`0001_baseline*.sql:178-194`, then `0002`, `0005`, `0006`):

| column | type | nullability / default |
|---|---|---|
| `session_id` | TEXT | PK, `REFERENCES sessions(session_id) ON DELETE CASCADE` |
| `transcript_mtime_ms` | INTEGER | NOT NULL DEFAULT 0 |
| `transcript_size` | INTEGER | NOT NULL DEFAULT 0 |
| `transcript_offset` | INTEGER | NOT NULL DEFAULT 0 (bytes read) |
| `transcript_skipped_lines` | INTEGER | NOT NULL DEFAULT 0 |
| `transcript_messages_count` | INTEGER | NOT NULL DEFAULT 0 |
| `settings_mtime_ms` | INTEGER | NOT NULL DEFAULT 0; `-1` = unread |
| `transcript_summary_fingerprint` | TEXT | nullable (added v2) |
| `schema_version` | INTEGER | nullable (added v5) |
| `span_tail_offset` | INTEGER | NOT NULL DEFAULT 0 (added v6) |
| `span_tail_line` | INTEGER | NOT NULL DEFAULT 0 |
| `span_tail_index` | INTEGER | NOT NULL DEFAULT 0 |

`session_spans` (`0006_spans_and_search*.sql:81-112`): `session_id TEXT NOT NULL
REFERENCES sessions(session_id) ON DELETE CASCADE`, `span_index INTEGER NOT NULL`,
`line_start INTEGER NOT NULL`, `line_end INTEGER NOT NULL`, `text TEXT NOT NULL`,
`first_event_id TEXT`, `last_event_id TEXT`, `scale REAL`, `vector BLOB`,
`text_sha256 TEXT`, `embedding_space BLOB`, `synced_at INTEGER`,
`PRIMARY KEY (session_id, span_index)`, plus the three `CHECK`s of B35.
Indexes: `session_spans_embedded_text_idx (text_sha256) WHERE vector IS NOT NULL`
and `session_spans_unembedded_idx (session_id) WHERE vector IS NULL`.

`session_term_filters` (`0006_spans_and_search*.sql:130-133`): `session_id TEXT
PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE`, `filter BLOB NOT
NULL`.

Triggers (head): `sessions_settings_rewritten`, `sessions_daemon_fields_stale`,
`session_spans_vector_inserted`, `session_spans_vector_deleted`,
`session_spans_vector_updated`.

### Annotations database

`session_annotations`: `session_id`, `annotator`, `subject` (all TEXT NOT NULL,
composite PK), `annotator_version TEXT NOT NULL`, `revision TEXT NOT NULL`,
`generation INTEGER NOT NULL DEFAULT 1`, `source TEXT NOT NULL`, `org_id TEXT`,
`owner TEXT`, `payload BLOB`, `provenance BLOB NOT NULL`,
`payload_bytes INTEGER NOT NULL`, `produced_at INTEGER NOT NULL`,
`deleted_at INTEGER`, `orphaned_at INTEGER`, `cloud_settled_at INTEGER`
(`0001_session_annotations*.sql:3-21`). `session_annotation_write_clock`:
`id INTEGER PRIMARY KEY CHECK (id = 1)`, `generation INTEGER NOT NULL`, one row
`(1, 0)`; the clock survives row deletion so a delayed acknowledgement cannot
settle a recreated key (`0001_session_annotations*.sql:22-27`). Indexes:
`_unsettled (org_id, owner, produced_at) WHERE cloud_settled_at IS NULL`,
`_owner_session (org_id, owner, session_id)`,
`_annotator (org_id, owner, annotator, produced_at)`,
`_orphaned (orphaned_at) WHERE orphaned_at IS NOT NULL`.

### On-disk layout

```
<home>/.factory/                        (.factory-dev outside production)
├── sessions/
│   ├── <sessionId>.jsonl               project_key ''
│   ├── <sessionId>.settings.json       optional
│   ├── .favorites                      JSON array of session ids
│   ├── btw/<sessionId>.jsonl           project_key 'btw'
│   └── -<sanitized cwd>/<sessionId>.jsonl   project_key begins with '-'
└── cache/session-index/
    ├── index.db  index.db-wal  index.db-shm
    ├── .metadata_never_index
    └── quarantine/<timestamp>-<pid>/
```

`project_key` for a project directory comes from
`sanitizePathToDirectoryName`: `~` expanded, path resolved, `realpathSync`
applied when it exists, trailing separators removed, then prefixed with `-` and
its separators replaced by `-` (on Windows the `C:` colon is stripped)
(`session-paths/src/index.ts:61-80`). Because that is impure, the key is stored
rather than recomputed. `.favorites` is read from the sessions dir and degrades
to "no favorites" when unreadable or malformed (`listing.ts:45-78`).

Environment: `FACTORY_HOME_OVERRIDE` (home override),
`FACTORY_ENV`/`FACTORY_ENV_DIRS` (which of `.factory` / `.factory-dev`),
`MIN_SQLITE_VERSION` is a package constant, not an environment variable.

SQLite: the package pins its own library where the runtime would dlopen an older
one (macOS), through `configureSessionIndexHost({ sqliteLibrary })`
(`access.ts:1155-1200`); the floor is `3.51.3` — the first release without the
WAL-reset race that corrupts a database written by two processes, which is the
CLI-beside-daemon shape — and a lower version is **logged, not refused**, because
`jsonb()` only needs 3.45 (`constants.ts:40-64`, `driver.ts:250-286`). Opening
reports `sqlite_version()` and which library supplied it.

## Errors

| Condition | Identity | Effect |
|---|---|---|
| Duplicate or non-positive migration version | `Duplicate session index migration version` / `Session index migration version must be positive` | import-time throw; nothing opened |
| Known-version checksum differs | `Session index migration checksum mismatch` (log `source: session-index`, `key: <version>:<name>`) | open fails, file untouched |
| Ledger complete but a table/column/index missing | `Session index database is not shaped like this build` with `state` = fault id, `key` = `table[.column]` or index name | open fails, file untouched |
| A table cannot be described | `Session index table could not be inspected` (`key: <table>`) | open fails |
| SQLite reports corruption / not-a-database | `SQLITE_CORRUPT*` / `SQLITE_NOTADB`; log `database quarantined` with `operation` = open/migrate/check/recover and `state` = moved/absent/replaced/failed | file moved to quarantine, fresh file retried once |
| Quarantine rename refused | log `database quarantine failed` with errno | original error propagates, file left in place |
| Nested store transaction | `Nested session-index transaction` | throw; the outer transaction is unaffected |
| Row's key resolves outside the sessions dir | `Indexed session resolves outside the sessions dir` (`state: outside-sessions-dir`) | listing fails for that row; no path leaks into the log |
| Peer holds the writer slot | SQLite busy/locked; log `Deferred a session index write a peer held the lock for` | write returns "refused"; caller retries after yielding; no data lost |
| WAL at its write cap | log `Declined a session index write because the write-ahead log is at its cap` | write refused, retried later |
| Refresh lease held | none (silent) | second pass returns without reading |
| `--kind` outside the enum | `Invalid --kind value` (a `MetaError`, so the generic search-failure line is printed) | exit 1 |
| Query outside the supported regex subset | `Search query rejected`; stderr `common:sessionSearch.queryRejected`, exit 1 | nothing scanned |
| Index-requiring flag with the feature off | `--include-archived, --exclude-children and --include-hidden need the session index, which is off` | exit 1 |
| `ripgrep` missing or unusable | log `Session search matcher is unavailable` (`state: matcher-unavailable`) | empty result with `complete: false`; no transcript scan |
| Search aborted (Ctrl-C) | exit 130 | no output written |

## Acceptance tests

Fixtures are synthesised: a `fixtures/migrations/` directory holding the nine
cache SQL assets (their contents are the contract), plus
`fixtures/sessions/` (two JSONL transcripts and one settings file) and
`fixtures/search/` (one transcript containing a user text message, an assistant
`thinking` block, a `tool_use` with `input`, the matching `tool_result`, a text
`document` block, and a `session_start` with title/cwd).

| Clause | Test id | Fixture |
|---|---|---|
| B6, B9, B10, B11 | `tests/session_index/test_migration_ledger` | `fixtures/migrations/` |
| B7, B8 | `tests/session_index/test_migration_identity_normalization` | `fixtures/migrations/` |
| B12, B13 | `tests/session_index/test_open_rejects_wrong_shape` | `fixtures/migrations/`, a DB altered by `ALTER TABLE sessions DROP COLUMN host_id` |
| B14, B15, B16 | `tests/session_index/test_quarantine_and_recovery` | a 4 KB file of random bytes at `index.db`; a `-wal` beside it |
| B1, B2, B3, B4, B5 | `tests/session_index/test_open_pragmas_and_layout` | empty dir |
| B17, B18, B19, B20, B21 | `tests/session_index/test_row_write_semantics` | `fixtures/sessions/` |
| B22 | `tests/session_index/test_settings_triggers` | one row written by `UPDATE sessions SET mission = 'm'` |
| B23, B24, B25, B26, B27, B28, B29 | `tests/session_index/test_refresh_plan` | `fixtures/sessions/` incl. a retitled transcript with restored mtime |
| B30, B31 | `tests/session_index/test_cleanup_cascade` | `fixtures/sessions/` with one transcript deleted between passes |
| B32, B33, B34 | `tests/session_index/test_schema_version_backfill` | DB at head, row stamped 7 |
| B35, B36 | `tests/session_index/test_spans_and_vector_epoch` | spans inserted, re-upserted with changed text |
| B37 | `tests/session_index/test_annotations_schema` | `fixtures/migrations/annotations/` |
| B38, B39, B40, B41 | `tests/session_index/test_listing_order_and_scope` | `fixtures/sessions/` with two orgs, an archived row, a BTW fork |
| B42 | `tests/session_index/test_listing_coverage_wait` | `fixtures/sessions/` with `meta` cleared of `last_full_refresh_at` |
| B43, B44, B45, B56 | `tests/cli/test_search_option_contract` | `fixtures/search/` (help text + argument parsing harness) |
| B46, B47, B48, B49, B50, B51, B52 | `tests/cli/test_search_results` | `fixtures/search/` |
| B53, B54, B55 | `tests/cli/test_search_output_format` | `fixtures/search/` + a `--json` golden |

Three tests carry the load and must be exact:

1. **`test_migrate_empty_to_head_schema_snapshot`.** Input: an empty file;
   apply assets 1–9 in order with a runner implementing B6–B9. Expected, read
   back as a canonicalised dump (objects sorted, columns as
   `cid|name|type|notnull|dflt_value|pk`):
   - objects = the 5 tables, 7 indexes, 5 triggers listed in "Data & config",
     and nothing else (no `sqlite_`-prefixed objects counted);
   - `sessions` has 20 columns, `c0`=`session_id|TEXT|0|-|1` …
     `c19`=`settings_write_seq|INTEGER|0|-|0`;
   - `session_ingest` has 12 columns ending
     `span_tail_offset|INTEGER|1|0|0`, `span_tail_line|INTEGER|1|0|0`,
     `span_tail_index|INTEGER|1|0|0`;
   - `session_spans` has 12 columns with `pk` 1 on `session_id`, 2 on
     `span_index`;
   - `meta` contains exactly `vector_epoch='0'`;
   - ledger holds 9 rows, versions 1–9, with the hyphenated names
     `baseline`, `transcript-summary-fingerprint`, `tags-role-key`,
     `daemon-session-fields`, `schema-version`, `spans-and-search`,
     `term-prefixes`, `whole-transcript-records`, `vector-bookkeeping`.
2. **`test_append_and_query_ordering`.** Input: session A written by the
   mutation path at `last_event_at=1000`, `messages_count=5`; an append
   carrying two lines that end past `transcript_offset=3` and
   `modifiedTimeMs=2000`; then an ingest that counts 9 messages and sets
   `transcript_mtime_ms=1500`. Expected: after the append `messages_count=7`;
   after the ingest `messages_count=9` and `modified_time_ms=2000` (max of the
   two writers); listing order A before B where B has `last_event_at=1999`;
   deleting A removes its `session_ingest` row (`SELECT COUNT(*) = 0`).
3. **`test_search_fixture_hits_and_limits`.** Input: the search fixture;
   `--kind all --limit-sessions 5 --limit-hits 2 --context-chars 20`. Expected:
   exactly one session; hits in `docId` descending line order (newest first) and
   at most 2; the `tool_use` hit carries the tool name; the `thinking` block
   matches as `message_text`/`assistant`; the base64 `document` source and the
   tool-call `id` never match; `--kind tool_result` returns only that block;
   `--limit-sessions 0` and `--context-chars -1` are rejected by the argument
   parser; the same query with `--json` parses as the B54 shape.

## Evidence

| Evidence | Supports | Method |
|---|---|---|
| `ev_schema_cache_head` | B6–B13, Data & config | Decoded assets 1–9 (UTF-16LE for 0001/0003) and applied them with `sqlite3` 3.50.6 to an empty file; inventoried `sqlite_master` and `pragma_table_info` |
| `ev_schema_annotations` | B37 | Decoded and applied `0001_session_annotations`; inventoried the two tables and four indexes |
| `ev_migrate_runner` | B6–B16 | Reading `migrate.ts:40-470` [observed] |
| `ev_driver_pragmas` | B1–B3, B14–B16 | Reading `constants.ts:237-341`, `driver.ts:830-1031` [observed] |
| `ev_cache_open` | B12, B14, B15 | Reading `cache.ts:37-172`, `schema.ts:26-238` [observed] |
| `ev_record_writes` | B17–B22 | Reading `record.ts:92-741`, `ingest.ts:1181-1235` [observed] |
| `ev_refresh_plan` | B23–B31, B34 | Reading `discovery.ts:43-300`, `ingest.ts:212-330`, `567-632`, `1310-1360`, `2147-2230` [observed] |
| `ev_lease` | B4 | Reading `lease.ts:1-120` [observed] |
| `ev_listing` | B38–B42 | Reading `record.ts:239-400`, `925-968`, `listing.ts:71-145`, `216-270`, `driver.ts:1024-1031` [observed] |
| `ev_search_cli` | B43–B46, B53–B56 | Reading `src/entrypoints/search/command.ts:8-66`, `run.ts:36-173`, `src/search/sessionSearch.ts:1-341` [observed] |
| `ev_search_engine` | B47–B52 | Reading `search.ts:289-400`, `640-900`, `1400-1700`, `2116-2196`, `2333-3064`; `utils/src/session-search/extract.ts:257-340`, `rank.ts:13-67` [observed] |
| `ev_search_bounds` | B44, B51 | Reading `utils/src/session-search/query.ts:44-73`, `packages/common/src/session/constants.ts:77-86` [observed] |
| `ev_session_paths` | B17, Data & config | Reading `session-paths/src/index.ts:36-160`, `280-381` [observed] |
| `ev_factory_home` | Terms, layout | Reading `cli/src/home/index.ts:13-29`, `environment/src/constants/index.ts:6-9` [derived: `getFactoryDirName` is an accessor over `getBaseEnv()`] |
| `ev_schema_version` | B32–B33 | Reading `ingest.ts:212-325`, `record.ts:833-868` [observed] |
| `ev_daemon_search` | B49, B54 | Reading `daemon-search.ts:30-130`, `283-400`; protocol schema `droid-sdk-core/.../droid.ts:893-963` [observed] |

Inferred only: the human strings behind the i18n keys (message catalogs are
absent from the recovered tree), and the annotations database path.

## Open questions

1. **Human-facing wording.** `common:sessionSearch.*` message texts are not in
   the recovered source (only `t('common:sessionSearch.…')` calls). The
   *structure* of B53 is observed; the literal words are not. Settle by running
   `droid search x --help`/a search against a seeded home capture. Blocks the
   exact-text half of B53/B56.
2. **Annotations database path and writer.** Only its DDL, its generated
   manifest and the `preserveQuarantine` flag are present; the module that opens
   it, and its file name, were elided. Blocks B37's path and the write rules of
   the annotations file. Settle from a captured home directory (`find` under
   `<base>` for `*.db` after an annotating run) or from the packaging manifest.
3. **`CacheOpenOutcome` / `SchemaFault` / `SessionIndexStatus` literal values.**
   The enums module is a type-only barrel and absent. Their *behaviour* is
   established (created / migrated / current; missing-table, missing-column,
   column-changed, missing-index, foreign-object; ready / busy / failed), their
   serialised strings are not. Affects log assertions only.
4. **`--reindex` semantics for a one-shot search.** `requestRebuild` is a no-op
   for `droid search` (`run.ts:56-62`), and `refresh` is passed through to
   `searchEverywhere` (`run.ts:98-110`). Whether `--reindex` performs a full
   refresh or a per-session one before scanning is not visible in the shipped
   code path. Blocks no clause (B43 only lists the flag); it affects how fresh a
   result may be.
5. **Search when the index is unavailable mid-command.** `access.ts` reports
   `unavailable` and the CLI has no JSON-directory fallback (unlike the listing);
   the observable result is an empty, incomplete result, but the sequence that
   produces it from a cold start with `busy` is not exercised in the source we
   have. Blocks no clause; recorded so a reimplementation does not invent a
   fallback.
6. **`sessions.org_id` tenancy asymmetry.** Listings include `org_id IS NULL`
   rows alongside the active org, and search does the same but also admits
   `additionalOrganizationIds`. Whether a NULL-org session is meant to be visible
   when an organization is active is asserted differently in two readers; the
   migration comment says NULL means "not permitted to assume". Blocks a strict
   reading of B39. Settle against the Postgres store's documented rule.

## Clean-room notes

A reimplementation must reproduce:

- The exact cache schema at head — table, column, index and trigger names,
  nullability, defaults, the three `session_spans` `CHECK`s and both partial
  indexes — because the open path validates the catalog against the migrations
  and because a future migration is addressed by version number.
- The `schema_migrations` ledger with a content checksum over *normalised* SQL,
  one `BEGIN IMMEDIATE` transaction per migration, "skip if a peer applied it",
  and tolerance of an ahead ledger with no tolerance for a missing object.
- The write-ahead-log policy: WAL, no auto-checkpoint, bounded journal,
  explicit passive checkpoints, a declining cap, and `TRUNCATE` on migration and
  close.
- The three-way path layout and the derivation of transcript/settings paths from
  `(sessions dir, project_key, session id)`, including rejection of escaping
  keys.
- Monotonic row updates (`MAX`/`COALESCE`), the settings-read race rule, and the
  append rule that counts only lines past `transcript_offset`.
- The refresh decision table (restart / shift / resume / skip), the summary
  fingerprint with its `mtime == ctime` guard, the delete-only-when-unchanged
  cleanup, the cascade, and the per-row `schema_version` backfill contract.
- Search: the option names and defaults, the shared clamps, the searched JSON
  paths, the ranking tuple, newest-first per-session hits, the completeness
  flag, and the compact output line shape.

Explicitly not part of the contract: the specific SQL text of each migration
(only its identity and its resulting shape matter to a caller), the log record
keys and telemetry fields, the exact checkpoint cadence (any policy with the same
bounds is acceptable), the bloom-filter geometry and hash count (any sound filter
that never excludes a true match), the embedding format, the cloud merge
algorithm, in-process caches, and the legacy engine's internal file-index cache.