/**
 * One run worktree mirrored in its own box, at the same absolute path, so paths in prompts, tool calls and events
 * mean the same thing on both sides.
 *
 * The local worktree stays the source of truth: the workflow's git steps (commit, merge, diff, PR) run there as
 * always. Before a step, the box gets the worktree's commits (a git bundle) and its uncommitted state (a patch);
 * after it, what changed in the box comes back as a patch. Both sides are compared by tree id: the working tree as
 * `git add -A` would commit it (ignored files excluded, so build caches stay where they are), so a step that
 * changed nothing syncs nothing.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RemoteConfig } from '../config.ts';
import { git, gitSucceeds, gitText } from '../git/exec.ts';
import { type Logger, silentLogger } from '../util/log.ts';
import { type ExecResult, exec, execOk, type RemoteBox, type RemoteProcess, type StartOptions } from './box.ts';

/** Where Legion keeps its CLIs and Codex home inside a box. */
const BOX_CLI_BIN = '$HOME/.legion/cli/bin';

/**
 * Every command in a box goes through this: Legion's CLIs on PATH, Codex's home, the project's `[remote] prelude`
 * (run in the worktree root, its output kept off stdout so it cannot corrupt a protocol stream), then the command.
 * `$1` is the worktree root; the command follows.
 */
export const LAUNCHER = `w="$1"; shift
export PATH="${BOX_CLI_BIN}:$PATH"
export CODEX_HOME="$HOME/.legion/codex-home"
mkdir -p "$CODEX_HOME"; chmod 700 "$CODEX_HOME"
# Codex's ChatGPT login, seeded once per box from the account's environment; the CLI keeps its refreshed tokens.
if [ ! -f "$CODEX_HOME/auth.json" ] && [ -n "\${CODEX_AUTH_GZIP_B64:-}" ]; then
  (umask 077; printf %s "$CODEX_AUTH_GZIP_B64" | base64 -d | gunzip > "$CODEX_HOME/auth.json.tmp" &&
    mv "$CODEX_HOME/auth.json.tmp" "$CODEX_HOME/auth.json") || echo "legion: could not seed Codex's login" >&2
fi
unset CODEX_AUTH_GZIP_B64
if [ -n "\${LEGION_PRELUDE:-}" ]; then
  c="$PWD"; cd "$w" || exit 1
  eval "$LEGION_PRELUDE" >&2
  cd "$c" || exit 1
fi
unset LEGION_PRELUDE
exec "$@"`;

/**
 * Makes the worktree directory: the snapshot's warm clone moved there (build caches and all), else an empty repo.
 * Prints the commit it has checked out, if any. `$1` path, `$2` warm clone (may be empty).
 */
export const PREPARE = `set -e
p="$1"; clone="$2"
if ! git -C "$p" rev-parse --git-dir >/dev/null 2>&1; then
  parent="$(dirname "$p")"
  mkdir -p "$parent" 2>/dev/null || { sudo mkdir -p "$parent" && sudo chown "$(id -u):$(id -g)" "$parent"; }
  if [ -n "$clone" ] && [ -d "$clone/.git" ]; then mv "$clone" "$p"; else git init -q "$p"; fi
fi
git -C "$p" rev-parse -q --verify 'HEAD^{commit}' || true`;

/** Prints the tree id of the working tree in `$1` (a copy of the index, so the real one is untouched). */
const TREE = `t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
i="$(git rev-parse --git-path index)"
if [ -f "$i" ]; then cp "$i" "$t/index"; fi
export GIT_INDEX_FILE="$t/index"
git add -A
git write-tree`;

/**
 * Brings the box's worktree to the local one. \`$1\` path, \`$2\` bundle (or empty), \`$3\` commit, \`$4\` branch (or
 * empty), \`$5\` \`hard\` (check out, clean) or \`soft\` (move HEAD, keep the working tree), \`$6\` patch (or empty).
 * Prints the resulting tree id.
 */
export const PUSH = `set -e
cd "$1"
if [ -n "$2" ]; then git fetch -q "$2" HEAD; rm -f "$2"; fi
if [ "$5" = hard ]; then
  if [ -n "$4" ]; then git checkout -q -f -B "$4" "$3"; else git checkout -q -f --detach "$3"; fi
  git clean -q -fd
else
  if [ -n "$4" ]; then git update-ref "refs/heads/$4" "$3"; git symbolic-ref HEAD "refs/heads/$4"
  else git update-ref --no-deref HEAD "$3"; fi
  git reset -q
fi
if [ -n "$6" ]; then git apply --binary --whitespace=nowarn "$6"; rm -f "$6"; fi
${TREE}`;

/** Prints the tree id of \`$1\`; when it is not \`$2\`, also writes the patch from \`$2\` to it into \`$3\`. */
export const PULL = `set -e
cd "$1"
tree="$( ${TREE.replace(/\n/g, '\n  ')} )"
echo "$tree"
if [ "$tree" != "$2" ]; then git diff --binary --full-index "$2" "$tree" > "$3"; fi`;

/** Installs the CLI \`$1\` (claude | codex) when the box does not have it. */
export const ENSURE_CLI = `set -e
case "$1" in
  claude) bin=claude; pkg=@anthropic-ai/claude-code ;;
  codex) bin=codex; pkg=@openai/codex ;;
  *) exit 2 ;;
esac
if ! command -v "$bin" >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.legion/cli" --no-audit --no-fund "$pkg" >&2
fi`;

interface LocalState {
  head: string;
  branch: string | null;
  tree: string;
}

/** The state both sides last agreed on: the commit, and the working tree's id on each side. */
interface Synced {
  head: string;
  local: string;
  box: string;
}

export interface WorkspaceOptions {
  /** The worktree's top level: the same path locally and in the box. */
  path: string;
  box: RemoteBox;
  /** The box was made just now (nothing from an earlier session in it). */
  created: boolean;
  config: () => RemoteConfig;
  log?: Logger;
}

export class Workspace {
  readonly path: string;
  readonly box: RemoteBox;
  readonly created: boolean;
  /** Agent sessions started in this box since it was attached (the ones a step may resume). */
  readonly sessions = new Set<string>();
  private readonly config: () => RemoteConfig;
  private readonly log: Logger;
  private synced: Synced | null = null;
  /** Sync steps one at a time: they read and move `synced`. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly clis = new Map<string, Promise<void>>();

  constructor(opts: WorkspaceOptions) {
    this.path = opts.path;
    this.box = opts.box;
    this.created = opts.created;
    this.config = opts.config;
    this.log = opts.log ?? silentLogger;
  }

  /** Brings the box to the local worktree's state. */
  push(): Promise<void> {
    return this.serial(() => this.doPush());
  }

  /** Brings what changed in the box since the last sync into the local worktree. */
  pull(): Promise<void> {
    return this.serial(() => this.doPull());
  }

  /** Makes sure the box has `claude` or `codex` (once per box). */
  ensureCli(kind: 'claude' | 'codex'): Promise<void> {
    let done = this.clis.get(kind);
    if (!done) {
      done = execOk(this.box, this.launch(['bash', '-c', ENSURE_CLI, 'legion', kind]), { env: this.env() }).then(
        () => undefined,
      );
      done.catch(() => this.clis.delete(kind));
      this.clis.set(kind, done);
    }
    return done;
  }

  /** Starts `argv` in the box in `cwd` (inside the worktree), through the launcher. */
  start(argv: readonly string[], opts: StartOptions): Promise<RemoteProcess> {
    return this.box.start(this.launch(argv), { ...opts, env: this.env(opts.env) });
  }

  /** Runs `argv` to the end in the box, through the launcher. */
  exec(argv: readonly string[], opts: Parameters<typeof exec>[2] = {}): Promise<ExecResult> {
    return exec(this.box, this.launch(argv), { ...opts, env: this.env(opts.env) });
  }

  private launch(argv: readonly string[]): string[] {
    return ['bash', '-c', LAUNCHER, 'legion', this.path, ...argv];
  }

  private env(extra?: Readonly<Record<string, string>>): Record<string, string> {
    const prelude = this.config().prelude;
    return { ...(prelude ? { LEGION_PRELUDE: prelude } : {}), ...extra };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async doPush(): Promise<void> {
    // Another step still running in this box may have changed things: bring them here first, so the box's tree
    // after the push is exactly the local one.
    if (this.synced) await this.doPull();
    const local = await localState(this.path);
    const s = this.synced;
    if (s && s.head === local.head && s.local === local.tree) return;
    const tmp = await mkdtemp(join(tmpdir(), 'legion-push-'));
    try {
      let mode: 'hard' | 'soft';
      let have: string | null;
      if (s) {
        mode = 'soft';
        have = s.head;
      } else {
        mode = 'hard';
        const out = await execOk(this.box, ['bash', '-c', PREPARE, 'legion', this.path, this.config().clone ?? '']);
        have = out.trim() || null;
      }
      const bundle = await this.bundle(tmp, local.head, have);
      // The uncommitted state: against the last synced tree, or (fresh) against the commit itself.
      const from = s ? s.local : local.head;
      const patch = from === local.tree ? null : await this.localDiff(tmp, from, local.tree);
      const tag = randomBytes(4).toString('hex');
      const boxBundle = bundle ? `/tmp/legion-${tag}.bundle` : '';
      const boxPatch = patch ? `/tmp/legion-${tag}.patch` : '';
      if (bundle) await this.box.upload(bundle, boxBundle);
      if (patch) await this.box.writeFile(boxPatch, patch);
      const out = await execOk(this.box, [
        'bash',
        '-c',
        PUSH,
        'legion',
        this.path,
        boxBundle,
        local.head,
        local.branch ?? '',
        mode,
        boxPatch,
      ]);
      const boxTree = out.trim().split('\n').pop() ?? '';
      if (!s && boxTree !== local.tree) {
        // Clean filters, line endings or LFS can make the same files hash differently there; diffs still line up.
        this.log.warn(`remote: ${this.path} hashes to ${boxTree} in box ${this.box.id}, ${local.tree} here`);
      }
      this.synced = { head: local.head, local: local.tree, box: boxTree };
      if (!s) await this.setup();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async doPull(): Promise<void> {
    const s = this.synced;
    if (!s) return;
    const boxPatch = `/tmp/legion-pull-${randomBytes(4).toString('hex')}.patch`;
    const out = await execOk(this.box, ['bash', '-c', PULL, 'legion', this.path, s.box, boxPatch]);
    const tree = out.trim();
    if (tree === s.box) return;
    const patch = await this.box.readFile(boxPatch);
    void exec(this.box, ['rm', '-f', boxPatch]).catch(() => undefined);
    let local = s.local;
    if (patch.length > 0) {
      const tmp = await mkdtemp(join(tmpdir(), 'legion-pull-'));
      const file = join(tmp, 'box.patch');
      await writeFile(file, patch);
      const applied = await git(this.path, ['apply', '--binary', '--whitespace=nowarn', file], {
        okExitCodes: [0, 1],
      });
      if (applied.exitCode !== 0) {
        throw new Error(
          `remote: the changes from box ${this.box.id} do not apply to ${this.path} (kept in ${file}): ${applied.stderr.trim()}`,
        );
      }
      // What both sides now agree on: the last synced tree plus the box's changes. Changes made here meanwhile
      // are not in it, so the next push still sends them.
      const env = { GIT_INDEX_FILE: join(tmp, 'index') };
      await git(this.path, ['read-tree', s.local], { env });
      await git(this.path, ['apply', '--cached', '--binary', '--whitespace=nowarn', file], { env });
      local = await gitText(this.path, ['write-tree'], { env });
      await rm(tmp, { recursive: true, force: true });
    }
    this.synced = { head: s.head, local, box: tree };
  }

  /** A bundle of `head` for a box that has `have` (null: nothing); null when it needs none. */
  private async bundle(tmp: string, head: string, have: string | null): Promise<string | null> {
    if (have === head) return null;
    const known = have !== null && (await gitSucceeds(this.path, ['cat-file', '-e', `${have}^{commit}`]));
    if (known && (await gitSucceeds(this.path, ['merge-base', '--is-ancestor', head, have as string]))) return null;
    const file = join(tmp, 'push.bundle');
    await git(this.path, ['bundle', 'create', '-q', file, 'HEAD', ...(known ? [`^${have}`] : [])]);
    return file;
  }

  private async localDiff(tmp: string, from: string, to: string): Promise<Buffer | null> {
    const file = join(tmp, 'push.patch');
    await git(this.path, ['diff', '--binary', '--full-index', `--output=${file}`, from, to]);
    const patch = await readFile(file);
    return patch.length > 0 ? patch : null;
  }

  /** `[remote] setup`, once per new box, in the worktree. */
  private async setup(): Promise<void> {
    for (const command of this.config().setup) {
      const r = await this.exec(['bash', '-c', command], { cwd: this.path });
      if (r.code !== 0)
        throw new Error(`remote setup \`${command}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
    }
  }
}

/** HEAD, its branch, and the tree id of the working tree as `git add -A` would commit it. */
export async function localState(dir: string): Promise<LocalState> {
  const head = await gitText(dir, ['rev-parse', 'HEAD']);
  const branch = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { okExitCodes: [0, 1] });
  const index = resolve(dir, await gitText(dir, ['rev-parse', '--git-path', 'index']));
  const tmp = await mkdtemp(join(tmpdir(), 'legion-tree-'));
  try {
    const copy = join(tmp, 'index');
    // A copy keeps the stat cache (no rehashing every file) without touching the real index.
    if (existsSync(index)) await copyFile(index, copy);
    const env = { GIT_INDEX_FILE: copy };
    await git(dir, ['add', '-A'], { env });
    const tree = await gitText(dir, ['write-tree'], { env });
    return { head, branch: branch.exitCode === 0 ? branch.stdout.trim() : null, tree };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
