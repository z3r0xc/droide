-- The `tags` column carries the derived mission role; rows written before the
-- rule are marked unread (`-1`) and re-read by the refresh. The trigger covers
-- mutation writes from builds that do not know the rule (B22).

UPDATE session_ingest SET settings_mtime_ms = -1;
DELETE FROM meta WHERE key = 'last_full_refresh_at';
CREATE TRIGGER sessions_settings_rewritten
AFTER UPDATE OF tags, mission, archived_at ON sessions
BEGIN
  UPDATE session_ingest SET settings_mtime_ms = -1
   WHERE session_id = NEW.session_id;
END;
