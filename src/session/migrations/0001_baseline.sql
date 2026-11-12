-- Cache schema baseline. Frozen: databases at this version exist in the
-- field, so changes are appended as new migrations (spec 40 B6-B13). No
-- IF NOT EXISTS: an existing object means the ledger and the file disagree.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE sessions (
  session_id           TEXT PRIMARY KEY,
  project_key          TEXT NOT NULL,
  cwd                  TEXT,
  title                TEXT,
  org_id               TEXT,
  owner                TEXT,
  parent               TEXT,
  calling_session_id   TEXT,
  calling_tool_use_id  TEXT,
  mission              TEXT,
  tags                 BLOB NOT NULL DEFAULT (jsonb('{}')),
  has_user_visible_messages INTEGER,
  archived_at          TEXT,
  first_event_at       INTEGER,
  last_event_at        INTEGER,
  messages_count       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_parent   ON sessions (parent);
CREATE INDEX sessions_caller   ON sessions (calling_session_id);
CREATE INDEX sessions_mission  ON sessions (mission);
CREATE INDEX sessions_subagent ON sessions (json_extract(tags, '$.subagent'));
CREATE INDEX sessions_recency  ON sessions (org_id, owner, project_key, last_event_at);
CREATE TABLE session_ingest (
  session_id               TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  transcript_mtime_ms      INTEGER NOT NULL DEFAULT 0,
  transcript_size          INTEGER NOT NULL DEFAULT 0,
  transcript_offset        INTEGER NOT NULL DEFAULT 0,
  transcript_skipped_lines INTEGER NOT NULL DEFAULT 0,
  transcript_messages_count INTEGER NOT NULL DEFAULT 0,
  settings_mtime_ms        INTEGER NOT NULL DEFAULT 0
);
