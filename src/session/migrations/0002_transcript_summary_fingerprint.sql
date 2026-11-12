-- Detect first-line rewrites even when their writers preserve file times.

ALTER TABLE session_ingest
  ADD COLUMN transcript_summary_fingerprint TEXT;
