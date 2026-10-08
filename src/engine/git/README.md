# git

System `git` (via execa) and `gh` wrappers (architecture §8–§9): worktree provisioning under
`<dataDir>/worktrees/<repoHash>/<runId>/<taskId>/`, branch naming (`legion/<runShort>/...`, see
`@shared/ids` `runShort`/`slugify`), per-repo mutex for ref-changing commands, `merge-tree --write-tree`
forecasts, the serialized integration merge queue (record `Merge.preSha` before every merge via
`Store.insertMerge`), diff parsing for `diff.get` (`DiffFile`/`DiffHunk` in `@shared/rpc`), push + `gh pr create --draft`.

Never touch the user's main checkout's working tree or index. The one exception is `mergeIntoBase`
(`runs.mergeLocally`, the human asked for it): when the base branch is checked out it moves by
`merge --ff-only` there, which git refuses rather than overwrite local changes. `rpc/repo-inspect.ts` already does the
read-only repo inspection for `repos.inspect`; move it here if you need to share code with it.
