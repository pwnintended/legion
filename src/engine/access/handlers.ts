/** RPC procedures behind the "Access" settings: `skills.list`, `mcpServers.discover`. */
import { homedir } from 'node:os';
import type { EngineContext } from '../context';
import type { EngineRpcServer } from '../rpc/server';
import { discoverMcpServers } from './discover';
import { availableSkills } from './resolve';

export function registerAccessHandlers(server: EngineRpcServer, ctx: EngineContext): void {
  const home = ctx.env.HOME || homedir();
  const repoOf = (projectId: string | null): string | null =>
    projectId ? ctx.store.requireProject(projectId).path : null;

  server.implement('skills.list', ({ projectId }) => availableSkills(home, repoOf(projectId)));
  server.implement('mcpServers.discover', ({ projectId }) => discoverMcpServers(home, repoOf(projectId)));
}
