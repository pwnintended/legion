/**
 * Initial schema: every entity from architecture §5 plus support tables.
 * JSON columns hold zod-validated values (see shared/domain.ts); timestamps are epoch ms;
 * booleans are 0/1. Status columns are only changed through Store.transition* (compare-and-set).
 */
export const up = /* sql */ `
CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  repo_path          TEXT NOT NULL,
  base_ref           TEXT NOT NULL,
  title              TEXT NOT NULL,
  issue_text         TEXT NOT NULL,
  issue_url          TEXT,
  status             TEXT NOT NULL,
  paused             INTEGER NOT NULL DEFAULT 0,
  planner_engine     TEXT NOT NULL,
  planner_model      TEXT,
  integration_branch TEXT,
  pr_url             TEXT,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX runs_status ON runs (status);

CREATE TABLE plans (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  markdown    TEXT NOT NULL,
  dag         TEXT NOT NULL,
  source      TEXT NOT NULL,
  feedback    TEXT,
  created_at  INTEGER NOT NULL,
  approved_at INTEGER,
  UNIQUE (run_id, version)
);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  branch          TEXT,
  worktree_path   TEXT,
  start_sha       TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  fix_rounds      INTEGER NOT NULL DEFAULT 0,
  merged_sha      TEXT,
  engine_override TEXT,
  model_override  TEXT,
  effort_override TEXT,
  progress        TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (run_id, node_id)
);
CREATE INDEX tasks_status ON tasks (status);

CREATE TABLE attempts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  engine        TEXT NOT NULL,
  model         TEXT,
  effort        TEXT,
  session_id    TEXT,
  status        TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  cost_usd      REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  error         TEXT
);
CREATE INDEX attempts_run ON attempts (run_id);
CREATE INDEX attempts_task ON attempts (task_id);
CREATE INDEX attempts_status ON attempts (status);

CREATE TABLE reviews (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL,
  criteria   TEXT NOT NULL,
  findings   TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reviews_run ON reviews (run_id);

CREATE TABLE inbox_items (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  attempt_id  TEXT REFERENCES attempts (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  resolution  TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX inbox_open ON inbox_items (resolved_at, run_id);

-- Append-only log. payload = ServerEventBody JSON (shared/events.ts). seq is the global stream cursor.
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  run_id     TEXT,
  task_id    TEXT,
  attempt_id TEXT,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX events_run ON events (run_id, seq);
CREATE INDEX events_attempt ON events (attempt_id, seq);

-- Key/value: 'app' = Settings JSON; other keys are free for engine bookkeeping.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE recent_repos (
  path         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- Integration merge queue history (§8 merge queue, §9 "record the pre-merge SHA").
CREATE TABLE merges (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  pre_sha    TEXT NOT NULL,
  post_sha   TEXT,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX merges_run ON merges (run_id, created_at);

-- Verify command results (task verify, post-merge verify, final verify).
CREATE TABLE verifications (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  attempt_id  TEXT REFERENCES attempts (id) ON DELETE CASCADE,
  phase       TEXT NOT NULL,
  command     TEXT NOT NULL,
  exit_code   INTEGER,
  output_tail TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX verifications_task ON verifications (task_id, created_at);
`;
