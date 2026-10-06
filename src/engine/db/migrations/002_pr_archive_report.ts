/** Run PR status (`pr`) and archive flag, the coder's final report on tasks. */
export const up = /* sql */ `
ALTER TABLE runs ADD COLUMN pr TEXT;
ALTER TABLE runs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN report TEXT;
CREATE INDEX runs_archived ON runs (archived, created_at);
`;
