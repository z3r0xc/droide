-- The refresh reads transcript records whole, whatever their size. A row that
-- skipped a record is read again from its start; a clean row at 7 is stamped 8
-- and its transcript stays unread.

UPDATE session_ingest SET schema_version = 8
 WHERE transcript_skipped_lines = 0 AND schema_version = 7;
