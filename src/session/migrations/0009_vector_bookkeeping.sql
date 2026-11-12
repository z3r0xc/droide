-- `meta.vector_epoch` moves whenever a stored vector (or what the matrix keeps
-- beside it) may have changed, so semantic search can reuse a loaded matrix.
-- The triggers live in the file so every writer moves the epoch, including
-- cascades and builds that know nothing of it (B36).

INSERT INTO meta (key, value) VALUES ('vector_epoch', '0');
CREATE TRIGGER session_spans_vector_inserted
AFTER INSERT ON session_spans
WHEN NEW.vector IS NOT NULL
BEGIN
  UPDATE meta SET value = value + 1 WHERE key = 'vector_epoch';
END;
CREATE TRIGGER session_spans_vector_deleted
AFTER DELETE ON session_spans
WHEN OLD.vector IS NOT NULL
BEGIN
  UPDATE meta SET value = value + 1 WHERE key = 'vector_epoch';
END;
CREATE TRIGGER session_spans_vector_updated
AFTER UPDATE OF session_id, span_index, line_start, scale, vector ON session_spans
WHEN (OLD.vector IS NOT NULL OR NEW.vector IS NOT NULL)
  AND (OLD.vector IS NOT NEW.vector
    OR OLD.scale IS NOT NEW.scale
    OR OLD.session_id IS NOT NEW.session_id
    OR OLD.span_index IS NOT NEW.span_index
    OR OLD.line_start IS NOT NEW.line_start)
BEGIN
  UPDATE meta SET value = value + 1 WHERE key = 'vector_epoch';
END;
CREATE INDEX session_spans_unembedded_idx ON session_spans (session_id)
  WHERE vector IS NULL;
