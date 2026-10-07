import { homedir } from 'node:os';
import { basename } from 'node:path';
import { RpcError } from '@shared/rpc-transport';
import type { EngineContext } from '../context';
import { createInitialCommit, GitError } from '../git';
import { DiscoveryCache, discoveryRoots, listBranches } from './repo-discover';
import { inspectRepo } from './repo-inspect';
import type { EngineRpcServer } from './server';

/**
 * Procedures implemented by the engine skeleton itself. Feature modules (orchestrator, git, pty, ...)
 * register theirs the same way: `server.implement(name, handler)` from a `register*Handlers` function.
 */
export function registerCoreHandlers(server: EngineRpcServer, ctx: EngineContext): void {
  const home = ctx.env.HOME || homedir();
  const discovery = new DiscoveryCache();

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
    homeDir: home,
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
  server.implement('repos.initialCommit', async ({ path }) => {
    const before = await inspectRepo(path, ctx.env);
    if (!before.isGitRepo || !before.root) throw new RpcError('bad_request', before.error ?? 'not a git repository');
    if (before.headSha) throw new RpcError('conflict', 'the repository already has commits');
    try {
      await createInitialCommit(before.root, ctx.env);
    } catch (error) {
      const detail = error instanceof GitError ? error.stderr.trim() || error.stdout.trim() : (error as Error).message;
      throw new RpcError('failed_precondition', `git commit failed: ${detail}`);
    }
    return inspectRepo(path, ctx.env);
  });
  server.implement('repos.discover', ({ refresh }) => {
    const recent = ctx.store.listRecentRepos().map((r) => r.path);
    return discovery.get({ roots: discoveryRoots(home, recent, ctx.env), env: ctx.env }, refresh ?? false);
  });
  server.implement('repos.branches', ({ path }) => listBranches(path, ctx.env));
}
