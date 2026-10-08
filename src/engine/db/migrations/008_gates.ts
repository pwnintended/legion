/**
 * Structured gate results: a verify-phase `verifications` row is one gate (null gate fields = a legacy row or a
 * setup/install command). The full output lives apart in `verification_outputs` so snapshots stay small; it is
 * fetched on demand (`verifications.output`).
 */
export const up = /* sql */ `
ALTER TABLE verifications ADD COLUMN gate TEXT;
ALTER TABLE verifications ADD COLUMN kind TEXT;
ALTER TABLE verifications ADD COLUMN status TEXT;
ALTER TABLE verifications ADD COLUMN summary TEXT;
ALTER TABLE verifications ADD COLUMN blocking INTEGER;
CREATE TABLE verification_outputs (
  verification_id TEXT PRIMARY KEY REFERENCES verifications (id) ON DELETE CASCADE,
  output          TEXT NOT NULL
);
`;
