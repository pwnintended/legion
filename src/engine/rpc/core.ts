import { basename } from 'node:path';
import type { EngineContext } from '../context';
import { inspectRepo } from './repo-inspect';
import type { EngineRpcServer } from './server';

/**
 * Procedures implemented by the engine skeleton itself. Feature modules (orchestrator, git, pty, ...)
 * register theirs the same way: `server.implement(name, handler)` from a `register*Handlers` function.
 */
export function registerCoreHandlers(server: EngineRpcServer, ctx: EngineContext): void {
  server.implement('app.info', () => ({
    name: 'Legion',
    version: ctx.version,
    engineVersion: ctx.version,
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    pid: process.pid,
    dataDir: ctx.dataDir,
    dbPath: ctx.dbPath,
    schemaVersion: ctx.schemaVersion,
    startedAt: ctx.startedAt,
    headSeq: ctx.store.headSeq(),
  }));

  server.implement('settings.get', () => ctx.store.getSettings());
  server.implement('settings.set', (patch) => ctx.store.updateSettings(patch));

  server.implement('runs.list', ({ includeArchived }) =>
    ctx.store.listRunSummaries({ includeArchived: includeArchived ?? false }),
  );

  server.implement('repos.recent', () => ctx.store.listRecentRepos());
  server.implement('repos.inspect', async ({ path }) => {
    const inspection = await inspectRepo(path, ctx.env);
    if (inspection.isGitRepo && inspection.root) {
      ctx.store.touchRecentRepo(inspection.root, basename(inspection.root));
    }
    return inspection;
  });
}
