/**
 * RPC procedures for projects and read-only repository browsing (architecture §5 Project, §10):
 * `projects.*`, `files.*`, `git.log`, `git.show`, `prs.list`. Nothing here writes to a user's repository.
 */
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Project } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import type { EngineContext } from '../context';
import { inspectRepo } from '../rpc/repo-inspect';
import type { EngineRpcServer } from '../rpc/server';
import { FileIndexCache } from './file-index';
import { DEFAULT_MAX_TEXT_BYTES, findFiles, listDir, readProjectFile, searchFiles } from './files';
import { gitLog, gitShow } from './history';
import { listPrs, projectInfo, projectStatus } from './info';

export interface ProjectServices {
  files: FileIndexCache;
  /** The project (its checkout must still be there for browsing). */
  project(projectId: string): Project;
}

/** Add (or find) the project for any folder inside a checkout. */
export async function addProject(ctx: EngineContext, path: string): Promise<Project> {
  const inspection = await inspectRepo(path, ctx.env);
  if (!inspection.isGitRepo || !inspection.root) {
    throw new RpcError('bad_request', inspection.error ?? 'not a git repository');
  }
  const root = await realpath(inspection.root).catch(() => inspection.root as string);
  ctx.store.touchRecentRepo(root, basename(root));
  return ctx.store.ensureProject(root, basename(root), true);
}

export function registerProjectHandlers(server: EngineRpcServer, ctx: EngineContext): ProjectServices {
  const files = new FileIndexCache();
  const services: ProjectServices = { files, project: (projectId) => ctx.store.requireProject(projectId) };
  const root = (projectId: string) => services.project(projectId).path;

  server.implement('projects.list', () => ctx.store.listProjects());
  server.implement('projects.add', ({ path }) => addProject(ctx, path));
  server.implement('projects.remove', ({ projectId }) => {
    ctx.store.removeProject(projectId);
    return { ok: true };
  });
  server.implement('projects.touch', ({ projectId }) => ctx.store.touchProject(projectId));
  server.implement('projects.pin', ({ projectId, pinned }) => ctx.store.updateProject(projectId, { pinned }));
  server.implement('projects.status', async ({ projectId }) => {
    const list = projectId ? [ctx.store.requireProject(projectId)] : ctx.store.listProjects();
    return Promise.all(list.map((project) => projectStatus(project)));
  });
  server.implement('projects.info', ({ projectId }) => projectInfo(services.project(projectId), files, ctx.env));

  server.implement('files.list', ({ projectId, dir }) => listDir(root(projectId), files, dir));
  server.implement('files.read', ({ projectId, path, maxBytes }) =>
    readProjectFile(root(projectId), files, path, maxBytes ?? DEFAULT_MAX_TEXT_BYTES),
  );
  server.implement('files.find', ({ projectId, query, limit }) => findFiles(root(projectId), files, query, limit));
  server.implement('files.search', ({ projectId, query, regex, caseSensitive, limit }) =>
    searchFiles(root(projectId), { query, regex: regex ?? false, caseSensitive: caseSensitive ?? false, limit }),
  );
  server.implement('git.log', ({ projectId, limit, ref }) => gitLog(root(projectId), limit, ref ?? null));
  server.implement('git.show', ({ projectId, sha }) => gitShow(root(projectId), sha));
  server.implement('prs.list', ({ projectId }) => listPrs(services.project(projectId), ctx.env));
  return services;
}
