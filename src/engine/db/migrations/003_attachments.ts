/**
 * Attachments: one row per added file (content-addressed on disk by `sha256`), claimed by a run when it is
 * used (`run_id`); unclaimed drafts are garbage-collected. `runs.attachments` = the refs given at creation.
 */
export const up = /* sql */ `
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  run_id     TEXT REFERENCES runs (id) ON DELETE SET NULL
);
CREATE INDEX attachments_sha ON attachments (sha256);
CREATE INDEX attachments_drafts ON attachments (run_id, created_at);
ALTER TABLE runs ADD COLUMN attachments TEXT;
`;
