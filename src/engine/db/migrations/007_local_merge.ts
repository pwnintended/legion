/** A run merged into its local base branch instead of a PR (`runs.mergeLocally`). */
export const up = /* sql */ `
ALTER TABLE runs ADD COLUMN merged TEXT;
`;
