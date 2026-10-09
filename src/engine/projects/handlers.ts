/**
 * RPC procedures for projects and read-only repository browsing (architecture §5 Project, §10):
 * `projects.*`, `files.*`, `git.log`, `git.show`, `prs.list`. The writes are `files.write` (the user saving a
 * file they edited, refused when it changed since), `projects.setGates` (legion.json's `gates` key, gates.ts) and
 * `projects.setPrompts` (its `prompts` key, prompts.ts).
 * Files are read from the main checkout or, with `checkout`, from one of the project's worktrees (checkouts.ts).
 */
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Project } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import type { EngineContext } from '../context';
import { inspectRepo } from '../rpc/repo-inspect';
import type { EngineRpcServer } from '../rpc/server';
import { checkoutRoot, listCheckouts } from './checkouts';
import { FileIndexCache } from './file-index';
import {
  DEFAULT_MAX_TEXT_BYTES,
  findFiles,
  listDir,
  readProjectFile,
  searchFiles,
  statProjectFile,
  writeProjectFile,
} from './files';
import { readProjectGates, writeProjectGates } from './gates';
import { gitLog, gitShow } from './history';
import { listPrs, projectInfo, projectStatus } from './info';
import { readProjectPrompts, writeProjectPrompts } from './prompts';

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

  server.implement('projects.checkouts', ({ projectId }) =>
    listCheckouts(root(projectId), {
      runs: ctx.store.listRuns().filter((r) => r.projectId === projectId),
      tasksOf: (runId) => ctx.store.listTasks(runId),
    }),
  );
  server.implement('projects.gates', ({ projectId }) => readProjectGates(root(projectId)));
  server.implement('projects.setGates', ({ projectId, revision, gates, verify }) =>
    writeProjectGates(root(projectId), { revision, gates, verify }),
  );
  server.implement('projects.prompts', ({ projectId }) => readProjectPrompts(root(projectId)));
  server.implement('projects.setPrompts', ({ projectId, revision, prompts }) =>
    writeProjectPrompts(root(projectId), { revision, prompts }),
  );

  const at = (projectId: string, checkout: string | null | undefined) => checkoutRoot(root(projectId), checkout);
  server.implement('files.list', async ({ projectId, checkout, dir }) =>
    listDir(await at(projectId, checkout), files, dir),
  );
  server.implement('files.read', async ({ projectId, checkout, path, maxBytes }) =>
    readProjectFile(await at(projectId, checkout), files, path, maxBytes ?? DEFAULT_MAX_TEXT_BYTES),
  );
  server.implement('files.stat', async ({ projectId, checkout, path }) =>
    statProjectFile(await at(projectId, checkout), files, path),
  );
  server.implement('files.write', async ({ projectId, checkout, path, text, expectedVersion }) =>
    writeProjectFile(await at(projectId, checkout), files, path, text, expectedVersion),
  );
  server.implement('files.find', async ({ projectId, checkout, query, limit }) =>
    findFiles(await at(projectId, checkout), files, query, limit),
  );
  server.implement('files.search', async ({ projectId, checkout, query, regex, caseSensitive, limit }) =>
    searchFiles(await at(projectId, checkout), {
      query,
      regex: regex ?? false,
      caseSensitive: caseSensitive ?? false,
      limit,
    }),
  );
  server.implement('git.log', ({ projectId, limit, ref }) => gitLog(root(projectId), limit, ref ?? null));
  server.implement('git.show', ({ projectId, sha }) => gitShow(root(projectId), sha));
  server.implement('prs.list', ({ projectId }) => listPrs(services.project(projectId), ctx.env));
  return services;
}
