/**
 * `present` (architecture §8.7): an agent puts files or a markdown document in front of the human. The files are
 * copied into the attachment store (claimed by the run), so what the human sees outlives the worktree it came
 * from; the presentation then shows up in the run's conversation and the assistant hears about it.
 *
 * Paths are confined to the agent's working directory and the system temp dir (where agents are told to save
 * screenshots): a presented file is read by Legion, never by the agent's own sandbox, so the check is here.
 */
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import type { AttachmentRef } from '@shared/attachments';
import type { Presentation } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import type { McpBinding, PresentRequest } from '../mcp';
import type { Orchestrator } from './orchestrator';

/** Where an attempt works: its live session's cwd, else its task's worktree, else the run's checkout. */
function workingDirectory(o: Orchestrator, binding: McpBinding): string {
  const live = o.live.get(binding.attemptId);
  if (live) return live.opts.cwd;
  const task = binding.taskId ? o.store.getTask(binding.taskId) : null;
  return task?.worktreePath ?? o.store.requireRun(binding.runId).repoPath;
}

const realOrNull = (path: string) => realpath(path).catch(() => null);

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The real path of `file` when it lies inside one of `roots` (symlinks resolved first), else an error. */
async function confine(file: string, cwd: string, roots: readonly string[]): Promise<string> {
  const target = await realOrNull(isAbsolute(file) ? file : resolve(cwd, file));
  if (!target) throw new Error(`${file} does not exist`);
  if (!roots.some((root) => inside(target, root)))
    throw new Error(`${file} is outside your working directory and the temp dir; save it under ${tmpdir()} first`);
  return target;
}

/** `Passkey list (dark)` → `passkey-list-dark.md`. */
export function documentName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'document'}.md`;
}

export async function present(
  o: Orchestrator,
  binding: McpBinding,
  request: PresentRequest,
): Promise<{ id: string; files: number }> {
  const cwd = workingDirectory(o, binding);
  const roots = (await Promise.all([cwd, tmpdir(), '/tmp'].map(realOrNull))).filter((r): r is string => r !== null);
  const refs: AttachmentRef[] = [];
  const problems: string[] = [];
  for (const file of [...new Set(request.files)]) {
    try {
      const path = await confine(file, cwd, roots);
      refs.push(await o.attachments.add({ name: basename(path), path }));
    } catch (error) {
      problems.push(error instanceof RpcError || error instanceof Error ? error.message : String(error));
    }
  }
  if (request.markdown) {
    refs.push(
      await o.attachments.add({
        name: documentName(request.title),
        mime: 'text/markdown',
        dataBase64: Buffer.from(request.markdown, 'utf8').toString('base64'),
      }),
    );
  }
  if (refs.length === 0) throw new Error(problems.join('; ') || 'nothing to show');
  o.assertOpen();
  o.attachments.claim(refs, binding.runId);
  const presentation: Presentation = o.store.insertPresentation({
    runId: binding.runId,
    taskId: binding.taskId,
    attemptId: binding.attemptId,
    title: request.title.trim(),
    caption: request.caption,
    attachments: refs,
  });
  if (o.assistantAttemptId(binding.runId) !== binding.attemptId) o.wakeAssistant(binding.runId);
  if (problems.length) {
    // Shown, but say what was left out so the agent can fix it.
    throw new Error(`presented ${refs.length} file(s) as ${presentation.id}, but skipped: ${problems.join('; ')}`);
  }
  return { id: presentation.id, files: refs.length };
}
