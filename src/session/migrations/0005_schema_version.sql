-- Each row's schema version, so a migration can request a source backfill by
-- naming it instead of clearing a marker (B32).

ALTER TABLE session_ingest ADD COLUMN schema_version INTEGER;
