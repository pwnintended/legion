/** RPC procedures behind the "Access" settings (`skills.list`, `mcpServers.discover`) and `skills.invocable`. */
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineContext } from '../context';
import type { EngineRpcServer } from '../rpc/server';
import { discoverMcpServers } from './discover';
import { availableSkills, invocableSkills } from './resolve';

export function registerAccessHandlers(server: EngineRpcServer, ctx: EngineContext): void {
  const home = ctx.env.HOME || homedir();
  const repoOf = (projectId: string | null): string | null =>
    projectId ? ctx.store.requireProject(projectId).path : null;

  server.implement('skills.list', ({ projectId }) => availableSkills(home, repoOf(projectId)));
  server.implement('skills.invocable', async ({ repoPath, engine }) => {
    // A run's project is keyed by the checkout's real path (see `insertRun`); a repo without one has no grants.
    const project = ctx.store.projectByPath(await realpath(repoPath).catch(() => repoPath));
    const codexHome = join(ctx.dataDir, 'codex-home');
    return invocableSkills(ctx.store.getSettings(), project?.id ?? null, engine, home, codexHome, repoPath);
  });
  server.implement('mcpServers.discover', ({ projectId }) => discoverMcpServers(home, repoOf(projectId)));
}
