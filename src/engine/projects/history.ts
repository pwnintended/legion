/** A project's git history (`git.log`) and single commits with their diff (`git.show`). Read-only. */
import type { Commit, CommitDiff, CommitRef } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { git, parseUnifiedDiff } from '../git';

/** Field and record separators that never appear in git's output for these fields. */
const FS = '\x1f';
const RS = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f');
/** Same flags as `diff.get`, so `parseUnifiedDiff` reads both. */
const DIFF_FLAGS = ['-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-U3'];

/** A revision the user (or the UI) passed: no options, no whitespace, no ranges. */
export function checkRev(rev: string): string {
  if (!rev || rev.startsWith('-') || /[\s\0]/.test(rev) || rev.includes('..')) {
    throw new RpcError('bad_request', `invalid revision "${rev}"`);
  }
  return rev;
}

/** `HEAD -> main, origin/main, tag: v1.2` → refs (HEAD itself is dropped). */
export function parseDecorations(decorations: string, remotes: readonly string[] = ['origin']): CommitRef[] {
  const refs: CommitRef[] = [];
  for (const raw of decorations.split(',')) {
    const part = raw.trim();
    if (!part || part === 'HEAD') continue;
    if (part.startsWith('HEAD -> ')) refs.push({ name: part.slice(8), kind: 'head' });
    else if (part.startsWith('tag: ')) refs.push({ name: part.slice(5), kind: 'tag' });
    else if (part.endsWith('/HEAD')) continue;
    else if (remotes.some((r) => part.startsWith(`${r}/`))) refs.push({ name: part, kind: 'remote' });
    else refs.push({ name: part, kind: 'branch' });
  }
  return refs;
}

export function parseLog(output: string, remotes: readonly string[]): Commit[] {
  const commits: Commit[] = [];
  for (const record of output.split(RS)) {
    const fields = record.replace(/^\n/, '').split(FS);
    if (fields.length < 8) continue;
    const [sha, shortSha, parents, author, authorEmail, at, decorations, ...subject] = fields as string[];
    commits.push({
      sha: sha as string,
      shortSha: shortSha as string,
      parents: (parents as string).split(' ').filter(Boolean),
      author: author as string,
      authorEmail: authorEmail as string,
      date: Number(at) * 1000,
      subject: subject.join(FS).replace(/\n$/, ''),
      refs: parseDecorations(decorations as string, remotes),
    });
  }
  return commits;
}

async function remoteNames(root: string): Promise<string[]> {
  const out = await git(root, ['remote'], { okExitCodes: [0, 1, 128] });
  return out.stdout.split('\n').filter(Boolean);
}

async function hasCommits(root: string): Promise<boolean> {
  const out = await git(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { okExitCodes: [0, 1, 128] });
  return out.exitCode === 0;
}

export async function gitLog(root: string, limit: number, ref: string | null): Promise<Commit[]> {
  const rev = ref ? checkRev(ref) : 'HEAD';
  if (!ref && !(await hasCommits(root))) return [];
  const [remotes, out] = await Promise.all([
    remoteNames(root),
    git(root, ['log', `--format=${LOG_FORMAT}%x1e`, '--decorate=short', `-n${limit}`, '--end-of-options', rev, '--'], {
      okExitCodes: [0, 128],
    }),
  ]);
  if (out.exitCode === 128) throw new RpcError('bad_request', `unknown revision ${rev}`);
  return parseLog(out.stdout, remotes);
}

export async function gitShow(root: string, sha: string): Promise<CommitDiff> {
  const rev = checkRev(sha);
  const [remotes, info] = await Promise.all([
    remoteNames(root),
    git(
      root,
      [
        'log',
        '-1',
        `--format=${LOG_FORMAT}${FS}%b%x1e`,
        '--decorate=short',
        '--end-of-options',
        `${rev}^{commit}`,
        '--',
      ],
      {
        okExitCodes: [0, 128],
      },
    ),
  ]);
  if (info.exitCode === 128) throw new RpcError('not_found', `no commit ${rev}`);
  const fields = info.stdout.split(RS)[0]?.split(FS) ?? [];
  const body = (fields.pop() ?? '').trim();
  const [commit] = parseLog(`${fields.join(FS)}${RS}`, remotes);
  if (!commit) throw new RpcError('not_found', `no commit ${rev}`);
  const parent = commit.parents[0];
  const diff = parent
    ? await git(root, ['diff', ...DIFF_FLAGS, parent, commit.sha, '--'])
    : await git(root, ['diff-tree', '-p', '--root', ...DIFF_FLAGS, commit.sha, '--']);
  return {
    from: parent ?? '',
    to: commit.sha,
    files: parseUnifiedDiff(diff.stdout),
    commit: { ...commit, body },
  };
}
