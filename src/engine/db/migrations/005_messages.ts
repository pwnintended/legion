/**
 * Agent hierarchy and mailbox: `attempts.parent_attempt_id` (the attempt this one reports to) and the
 * `messages` table (one row per message between two attempts of a run; `delivered_at` = reached the
 * recipient's context).
 */
export const up = /* sql */ `
ALTER TABLE attempts ADD COLUMN parent_attempt_id TEXT REFERENCES attempts (id) ON DELETE SET NULL;
CREATE INDEX attempts_parent ON attempts (parent_attempt_id);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  from_attempt_id TEXT NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  to_attempt_id   TEXT NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  body            TEXT NOT NULL,
  reply_to        TEXT REFERENCES messages (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);
CREATE INDEX messages_run ON messages (run_id, created_at);
CREATE INDEX messages_to ON messages (to_attempt_id, delivered_at);
`;
