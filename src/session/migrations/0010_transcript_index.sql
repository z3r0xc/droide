-- A disposable search projection over the transcript files. A row is keyed by
-- the sessions-relative transcript path and records the file times it was built
-- from, so a refresh can skip an unchanged file and a changed fingerprint
-- invalidates the cached values (spec 40 B23-B26, B47).

CREATE TABLE transcript_index (
  transcript_path     TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  project_key         TEXT NOT NULL,
  transcript_mtime_ms INTEGER NOT NULL,
  transcript_size     INTEGER NOT NULL,
  indexed_at          INTEGER NOT NULL,
  mission             TEXT,
  tags                BLOB NOT NULL DEFAULT (jsonb('{}')),
  archived_at         TEXT,
  worktree            TEXT,
  artifacts           TEXT,
  settings_write_seq  INTEGER
);
CREATE INDEX transcript_index_session ON transcript_index (session_id);
CREATE INDEX transcript_index_state
  ON transcript_index (transcript_mtime_ms, transcript_size);

CREATE TABLE transcript_index_value (
  transcript_path TEXT NOT NULL
    REFERENCES transcript_index(transcript_path) ON DELETE CASCADE,
  line_number     INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL,
  kind            TEXT NOT NULL
    CHECK (kind IN ('message_text', 'document', 'tool_use', 'tool_result')),
  tool_name       TEXT,
  message_role    TEXT,
  is_summary      INTEGER NOT NULL DEFAULT 0,
  value_lower     TEXT NOT NULL,
  PRIMARY KEY (transcript_path, line_number, ordinal)
);
CREATE INDEX transcript_index_value_kind ON transcript_index_value (kind);

-- A changed file invalidates its cached values before the new ones land, so a
-- stale projection can never answer a search.
CREATE TRIGGER transcript_index_values_cleared
AFTER UPDATE OF transcript_mtime_ms, transcript_size ON transcript_index
WHEN NEW.transcript_mtime_ms IS NOT OLD.transcript_mtime_ms
  OR NEW.transcript_size IS NOT OLD.transcript_size
BEGIN
  DELETE FROM transcript_index_value WHERE transcript_path = NEW.transcript_path;
END;

-- The settings-derived columns are the session row's, copied rather than
-- re-derived (B19): seeded when the projection row appears, kept current when
-- the session row changes.
CREATE TRIGGER transcript_index_settings_seeded
AFTER INSERT ON transcript_index
BEGIN
  UPDATE transcript_index
     SET mission = (SELECT mission FROM sessions WHERE session_id = NEW.session_id),
         tags = COALESCE((SELECT tags FROM sessions WHERE session_id = NEW.session_id), jsonb('{}')),
         archived_at = (SELECT archived_at FROM sessions WHERE session_id = NEW.session_id),
         worktree = (SELECT worktree FROM sessions WHERE session_id = NEW.session_id),
         artifacts = (SELECT artifacts FROM sessions WHERE session_id = NEW.session_id),
         settings_write_seq = (SELECT settings_write_seq FROM sessions WHERE session_id = NEW.session_id)
   WHERE transcript_path = NEW.transcript_path;
END;

CREATE TRIGGER transcript_index_settings_synced
AFTER UPDATE OF mission, tags, archived_at, worktree, artifacts, settings_write_seq ON sessions
BEGIN
  UPDATE transcript_index
     SET mission = NEW.mission,
         tags = NEW.tags,
         archived_at = NEW.archived_at,
         worktree = NEW.worktree,
         artifacts = NEW.artifacts,
         settings_write_seq = NEW.settings_write_seq
   WHERE session_id = NEW.session_id;
END;
