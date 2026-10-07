/**
 * Projects (the repositories in the rail) and `runs.project_id`. Existing runs are backfilled: one project per
 * distinct `repo_path` (already the checkout's top level, see `runs.create`), named after its last segment,
 * added when its first run was created.
 */
export const up = /* sql */ `
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  added_at       INTEGER NOT NULL,
  last_opened_at INTEGER,
  pinned         INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE SET NULL;
CREATE INDEX runs_project ON runs (project_id);

INSERT INTO projects (id, path, name, added_at, last_opened_at, pinned)
SELECT
  'prj_' || lower(hex(randomblob(6))),
  repo_path,
  substr(rtrim(repo_path, '/'), length(rtrim(rtrim(repo_path, '/'), replace(rtrim(repo_path, '/'), '/', ''))) + 1),
  MIN(created_at),
  MAX(updated_at),
  0
FROM runs
GROUP BY repo_path;

UPDATE runs SET project_id = (SELECT id FROM projects WHERE projects.path = runs.repo_path);
`;
