/**
 * The set of files a project shows: tracked plus untracked-but-not-ignored (`git ls-files --cached --others
 * --exclude-standard`), minus tracked files deleted from the working tree. Built with one git call, grouped by
 * directory for the tree, cached briefly per project root (the tree, ⌘P and the language stats share it).
 */
import { git, splitZ } from '../git';

export interface DirNode {
  /** Child directory names. */
  dirs: Set<string>;
  /** Child file names (anything git lists: files, symlinks, submodule checkouts). */
  files: string[];
}

export interface FileIndex {
  /** Repo-relative paths, sorted. */
  files: string[];
  set: Set<string>;
  /** '' = root. */
  dirs: Map<string, DirNode>;
  builtAt: number;
}

export async function buildFileIndex(root: string): Promise<FileIndex> {
  const [listed, deleted] = await Promise.all([
    git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate']),
    git(root, ['ls-files', '-z', '--deleted']),
  ]);
  const gone = new Set(splitZ(deleted.stdout));
  const files = [...new Set(splitZ(listed.stdout))].filter((path) => path && !gone.has(path)).sort();
  const dirs = new Map<string, DirNode>([['', { dirs: new Set(), files: [] }]]);
  const node = (dir: string): DirNode => {
    let entry = dirs.get(dir);
    if (!entry) {
      entry = { dirs: new Set(), files: [] };
      dirs.set(dir, entry);
    }
    return entry;
  };
  for (const path of files) {
    const slash = path.lastIndexOf('/');
    node(slash === -1 ? '' : path.slice(0, slash)).files.push(path.slice(slash + 1));
    // Register every ancestor directory with its parent.
    let dir = slash === -1 ? '' : path.slice(0, slash);
    while (dir) {
      const up = dir.lastIndexOf('/');
      const parent = up === -1 ? '' : dir.slice(0, up);
      const children = node(parent).dirs;
      const name = dir.slice(up + 1);
      if (children.has(name)) break;
      children.add(name);
      dir = parent;
    }
  }
  return { files, set: new Set(files), dirs, builtAt: Date.now() };
}

/** Per-root cache: fresh for `ttlMs`, concurrent callers share one build. */
export class FileIndexCache {
  private readonly entries = new Map<string, { index: FileIndex | null; building: Promise<FileIndex> | null }>();

  constructor(
    private readonly ttlMs = 5000,
    private readonly max = 16,
  ) {}

  async get(root: string, options: { fresh?: boolean } = {}): Promise<FileIndex> {
    let entry = this.entries.get(root);
    if (entry?.building) return entry.building;
    if (entry?.index && !options.fresh && Date.now() - entry.index.builtAt < this.ttlMs) return entry.index;
    entry ??= { index: null, building: null };
    this.entries.delete(root);
    this.entries.set(root, entry);
    const current = entry;
    current.building = buildFileIndex(root).then(
      (index) => {
        current.index = index;
        current.building = null;
        return index;
      },
      (error: unknown) => {
        current.building = null;
        throw error;
      },
    );
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      if (key !== root) this.entries.delete(key);
    }
    return current.building;
  }
}
