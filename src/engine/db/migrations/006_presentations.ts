/**
 * What agents present to the human (`present`): one row per presentation, its files as attachment refs (JSON;
 * the attachment rows are claimed by the run, so the files outlive worktrees and drafts GC).
 */
export const up = /* sql */ `
CREATE TABLE presentations (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  attempt_id  TEXT NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  caption     TEXT,
  attachments TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX presentations_run ON presentations (run_id, created_at);
`;
