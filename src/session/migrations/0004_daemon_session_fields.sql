-- Fields the daemon lists from the index. `settings_write_seq` NULL marks a row
-- whose settings and summary line still need re-reading.

ALTER TABLE sessions ADD COLUMN host_id TEXT;
ALTER TABLE sessions ADD COLUMN worktree TEXT;
ALTER TABLE sessions ADD COLUMN artifacts TEXT;
ALTER TABLE sessions ADD COLUMN settings_write_seq INTEGER;
CREATE TRIGGER sessions_daemon_fields_stale
AFTER UPDATE OF tags, mission, archived_at ON sessions
WHEN NEW.settings_write_seq IS OLD.settings_write_seq
BEGIN
  UPDATE sessions SET settings_write_seq = NULL
   WHERE session_id = NEW.session_id;
END;
