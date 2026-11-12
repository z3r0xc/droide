-- Everything retrieval stores: span text with its embedding columns, the span
-- tail bookkeeping, and one term filter per session. All cascade from sessions.

ALTER TABLE session_ingest ADD COLUMN span_tail_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_ingest ADD COLUMN span_tail_line   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_ingest ADD COLUMN span_tail_index  INTEGER NOT NULL DEFAULT 0;
CREATE TABLE session_spans (
  session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  span_index       INTEGER NOT NULL,
  line_start       INTEGER NOT NULL,
  line_end         INTEGER NOT NULL,
  text             TEXT NOT NULL,
  first_event_id   TEXT,
  last_event_id    TEXT,
  scale            REAL,
  vector           BLOB,
  text_sha256      TEXT,
  embedding_space  BLOB,
  synced_at        INTEGER,
  PRIMARY KEY (session_id, span_index),
  CHECK ((vector IS NULL) = (scale IS NULL)
    AND (vector IS NULL) = (text_sha256 IS NULL)),
  CHECK (vector IS NOT NULL OR synced_at IS NULL),
  CHECK (vector IS NOT NULL OR embedding_space IS NULL)
);
CREATE INDEX session_spans_embedded_text_idx ON session_spans (text_sha256)
  WHERE vector IS NOT NULL;
CREATE TABLE session_term_filters (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  filter     BLOB NOT NULL
);
