-- Which producer created a session, when it is not this build's own agent.
-- `cli_acp` marks a session `session/new` created (spec 60 B63); NULL marks a
-- session whose producer is unknown or owes no hint (spec 40 B57).
-- Additive: no backfill, so a row already in the field keeps its values.

ALTER TABLE sessions ADD COLUMN origin_hint TEXT;