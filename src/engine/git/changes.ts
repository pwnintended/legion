import type { Touch } from '@shared/domain';
import type { DiffFile, DiffHunk, DiffLine, DiffResult } from '@shared/rpc';
import { git, gitText, splitZ, withRepoLock } from './exec';
import { matchesAny } from './glob';
import { headSha } from './repo';

// ---------------------------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------------------------

const FALLBACK_IDENTITY = ['-c', 'user.name=Legion', '-c', 'user.email=legion@localhost'] as const;

/** `-c` args that make commits work even when the user has no git identity configured. */
export async function identityArgs(repo: string): Promise<string[]> {
  const name = await git(repo, ['config', 'user.name'], { okExitCodes: [0, 1] });
  const email = await git(repo, ['config', 'user.email'], { okExitCodes: [0, 1] });
  return name.stdout.trim() && email.stdout.trim() ? [] : [...FALLBACK_IDENTITY];
}

/** Args that disable hooks for Legion-authored commits/merges (husky etc. must not fire in worktrees). */
export const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const;

/**
 * Rerere for Legion's own merges only (recorded resolutions live in the shared common dir, reusable across
 * worktrees), passed per command so the user's repository config is never changed.
 */
export const RERERE = ['-c', 'rerere.enabled=true'] as const;

export interface CommitResult {
  /** False when the tree was clean and nothing was committed. */
  committed: boolean;
  /** The new commit, or the unchanged HEAD for a no-op. */
  sha: string;
}

/** `git add -A && git commit` in `worktree` (serialized per repo). No-op when there is nothing to commit. */
export async function commitAll(worktree: string, message: string): Promise<CommitResult> {
  return withRepoLock(worktree, async () => {
    await git(worktree, ['add', '-A']);
    const staged = await git(worktree, ['diff', '--cached', '--quiet'], { okExitCodes: [0, 1] });
    if (staged.exitCode === 0) return { committed: false, sha: await headSha(worktree) };
    const id = await identityArgs(worktree);
    await git(worktree, [...id, ...NO_HOOKS, 'commit', '--no-verify', '--no-gpg-sign', '-F', '-'], { input: message });
    return { committed: true, sha: await headSha(worktree) };
  });
}

/** Stage exactly `paths` and commit them. No-op when they have no changes. */
export async function commitPaths(worktree: string, paths: readonly string[], message: string): Promise<CommitResult> {
  return withRepoLock(worktree, async () => {
    if (paths.length > 0) await git(worktree, ['add', '-A', '--', ...paths]);
    const staged = await git(worktree, ['diff', '--cached', '--quiet'], { okExitCodes: [0, 1] });
    if (staged.exitCode === 0) return { committed: false, sha: await headSha(worktree) };
    const id = await identityArgs(worktree);
    await git(worktree, [...id, ...NO_HOOKS, 'commit', '--no-verify', '--no-gpg-sign', '-F', '-'], { input: message });
    return { committed: true, sha: await headSha(worktree) };
  });
}

// ---------------------------------------------------------------------------------------------
// Changed files
// ---------------------------------------------------------------------------------------------

export type ChangeStatus = DiffFile['status'];

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RangeOptions {
  /** Use `from...to` (diff against merge-base) instead of `from..to`. */
  mergeBase?: boolean;
}

function rangeArgs(from: string, to: string | null, opts: RangeOptions): string[] {
  if (to === null) return [from];
  return [opts.mergeBase ? `${from}...${to}` : `${from}..${to}`];
}

function statusFromLetter(letter: string): ChangeStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type_changed';
    default:
      return 'modified';
  }
}

/** Parse `--name-status -z` output. */
export function parseNameStatusZ(output: string): { status: ChangeStatus; path: string; oldPath: string | null }[] {
  const parts = splitZ(output);
  const out: { status: ChangeStatus; path: string; oldPath: string | null }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] as string;
    const letter = code[0] ?? 'M';
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i] ?? '';
      const path = parts[++i] ?? '';
      out.push({ status: statusFromLetter(letter), path, oldPath });
    } else {
      out.push({ status: statusFromLetter(letter), path: parts[++i] ?? '', oldPath: null });
    }
  }
  return out;
}

/** Parse `--numstat -z` output into a path -> counts map (keyed by new path). */
export function parseNumstatZ(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const parts = splitZ(output);
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] as string;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let path = m[3] as string;
    if (path === '') {
      // rename/copy: following two records are old and new path
      i++;
      path = parts[++i] ?? '';
    }
    const binary = m[1] === '-';
    map.set(path, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

/**
 * Files changed between two refs with status and added/removed counts. `to = null` diffs `from`
 * against the working tree (tracked files only).
 */
export async function changedFiles(
  repo: string,
  from: string,
  to: string | null,
  opts: RangeOptions = {},
): Promise<ChangedFile[]> {
  const range = rangeArgs(from, to, opts);
  const common = ['diff', '-M', '--no-color', '--no-ext-diff', '-z'];
  const [statusOut, numOut] = await Promise.all([
    git(repo, [...common, '--name-status', ...range, '--']),
    git(repo, [...common, '--numstat', ...range, '--']),
  ]);
  const nums = parseNumstatZ(numOut.stdout);
  return parseNameStatusZ(statusOut.stdout).map((e) => {
    const n = nums.get(e.path);
    return {
      path: e.path,
      oldPath: e.oldPath,
      status: e.status,
      additions: n?.additions ?? 0,
      deletions: n?.deletions ?? 0,
      binary: n?.binary ?? false,
    };
  });
}

/** Every path a change touches: new path, plus the old path of renames/copies-as-deletions. */
export function touchedPaths(files: readonly ChangedFile[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    set.add(f.path);
    if (f.status === 'renamed' && f.oldPath) set.add(f.oldPath);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------------------------

export interface ParseDiffOptions {
  /** A file whose additions + deletions exceed this keeps counts but drops its hunks. Default 5000. */
  maxChangedLinesPerFile?: number;
}

function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = inner[++i] as string;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(inner[i + 1] ?? '')) oct += inner[++i];
      bytes.push(Number.parseInt(oct, 8));
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string): string {
  return /^[ab]\//.test(p) ? p.slice(2) : p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parse `git diff` output (default `a/` `b/` prefixes) into the `diff.get` shape: one {@link DiffFile}
 * per file with hunks and numbered lines. Handles renames/copies, binary files, pure deletions/additions,
 * mode-only changes, and "\ No newline at end of file".
 */
export function parseUnifiedDiff(text: string, opts: ParseDiffOptions = {}): DiffFile[] {
  const maxChanged = opts.maxChangedLinesPerFile ?? 5000;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files: DiffFile[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.startsWith('diff --git ')) {
      i++;
      continue;
    }
    // ---- header ----
    const header = line.slice('diff --git '.length);
    let path = '';
    const half = (header.length - 5) / 2;
    if (Number.isInteger(half) && header.startsWith('a/') && header.slice(half + 2, half + 5) === ' b/') {
      path = header.slice(2, 2 + half);
    }
    let oldPath: string | null = null;
    let status: DiffFile['status'] = 'modified';
    let binary = false;
    let oldMode = '';
    let newMode = '';
    let minus: string | null = null;
    let plus: string | null = null;
    i++;
    while (
      i < lines.length &&
      !(lines[i] as string).startsWith('@@') &&
      !(lines[i] as string).startsWith('diff --git ')
    ) {
      const h = lines[i] as string;
      if (h.startsWith('new file mode')) status = 'added';
      else if (h.startsWith('deleted file mode')) status = 'deleted';
      else if (h.startsWith('old mode ')) oldMode = h.slice(9).trim();
      else if (h.startsWith('new mode ')) newMode = h.slice(9).trim();
      else if (h.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = unquoteGitPath(h.slice(12));
      } else if (h.startsWith('rename to ')) path = unquoteGitPath(h.slice(10));
      else if (h.startsWith('copy from ')) {
        status = 'copied';
        oldPath = unquoteGitPath(h.slice(10));
      } else if (h.startsWith('copy to ')) path = unquoteGitPath(h.slice(8));
      else if (h.startsWith('Binary files ') || h.startsWith('GIT binary patch')) binary = true;
      else if (h.startsWith('--- ')) minus = h.slice(4);
      else if (h.startsWith('+++ ')) plus = h.slice(4);
      i++;
    }
    if (status === 'modified' && oldMode && newMode && oldMode.slice(0, 2) !== newMode.slice(0, 2)) {
      status = 'type_changed';
    }
    if (!path) {
      const candidate = plus && plus !== '/dev/null' ? plus : minus;
      if (candidate) path = stripPrefix(unquoteGitPath(candidate.replace(/\t$/, '')));
    }
    if (!path && header) path = stripPrefix(unquoteGitPath(header.split(' b/').at(-1) ?? header));

    // ---- hunks ----
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    while (i < lines.length && (lines[i] as string).startsWith('@@')) {
      const m = HUNK_RE.exec(lines[i] as string);
      i++;
      if (!m) continue;
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      const hunk: DiffHunk = { oldStart, oldLines, newStart, newLines, header: m[5] ?? '', lines: [] };
      let oldNo = oldStart;
      let newNo = newStart;
      let remOld = oldLines;
      let remNew = newLines;
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.startsWith('\\')) {
          hunk.lines.push({ kind: 'no_newline', oldLine: null, newLine: null, text: l.slice(2) });
          i++;
          continue;
        }
        if (remOld <= 0 && remNew <= 0) break;
        const c = l[0];
        let dl: DiffLine;
        if (c === '+') {
          dl = { kind: 'add', oldLine: null, newLine: newNo++, text: l.slice(1) };
          remNew--;
          additions++;
        } else if (c === '-') {
          dl = { kind: 'del', oldLine: oldNo++, newLine: null, text: l.slice(1) };
          remOld--;
          deletions++;
        } else {
          dl = { kind: 'context', oldLine: oldNo++, newLine: newNo++, text: l.slice(1) };
          remOld--;
          remNew--;
        }
        hunk.lines.push(dl);
        i++;
      }
      hunks.push(hunk);
    }
    const truncated = additions + deletions > maxChanged;
    files.push({
      path,
      oldPath,
      status,
      binary,
      additions,
      deletions,
      hunks: truncated ? [] : hunks,
      truncated,
    });
  }
  return files;
}

/**
 * The `diff.get` payload for `from..to` (or `from...to` with `mergeBase`). `to = null` = working tree.
 * Binary files report counts of 0 and no hunks; for them numstat is not consulted.
 */
export async function getDiff(
  repo: string,
  from: string,
  to: string | null,
  opts: RangeOptions & ParseDiffOptions = {},
): Promise<DiffResult> {
  const range = rangeArgs(from, to, opts);
  const out = await gitText(
    repo,
    ['diff', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-U3', ...range, '--'],
    {},
  );
  return { from, to: to ?? 'WORKTREE', files: parseUnifiedDiff(out, opts) };
}

// ---------------------------------------------------------------------------------------------
// Scope check
// ---------------------------------------------------------------------------------------------

export interface ScopeReport {
  inScope: string[];
  outOfScope: string[];
}

/**
 * Compare changed paths with a node's declared `touches`. Only `create` / `modify` globs grant write
 * scope; a path matching only a `read` glob is out of scope.
 */
export function scopeCheck(changedPaths: readonly string[], touches: readonly Touch[]): ScopeReport {
  const writable = touches.filter((t) => t.mode !== 'read').map((t) => t.glob);
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const p of [...changedPaths].sort()) {
    (matchesAny(writable, p) ? inScope : outOfScope).push(p);
  }
  return { inScope, outOfScope };
}
