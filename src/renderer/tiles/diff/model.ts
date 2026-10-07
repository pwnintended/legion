/**
 * Diff tile model (pure): flatten a `DiffResult` into fixed-height rows for virtualization, anchor review
 * findings at file:line, and pick languages for highlighting.
 */
import type { DiffFile, DiffHunk, DiffLine } from '@shared/rpc';
import type { TrackedFinding } from '../review/evidence';

export const ROW_H = { file: 36, hunk: 26, line: 20, note: 30, gap: 10 } as const;
/** Files with more changed lines than this start collapsed. */
export const LARGE_FILE_LINES = 400;

export type Row =
  | { kind: 'file'; key: string; file: number; height: number }
  | { kind: 'hunk'; key: string; file: number; hunk: number; height: number }
  | {
      kind: 'line';
      key: string;
      file: number;
      hunk: number;
      line: number;
      height: number;
      /** Findings anchored at this line: open, resolved, or none. */
      anchor: 'open' | 'resolved' | null;
    }
  | { kind: 'finding'; key: string; file: number; finding: TrackedFinding; height: number }
  | { kind: 'note'; key: string; file: number; text: string; height: number }
  | { kind: 'gap'; key: string; file: number; height: number };

export function isLarge(file: DiffFile): boolean {
  return file.additions + file.deletions > LARGE_FILE_LINES;
}

export function defaultCollapsed(files: readonly DiffFile[]): Set<string> {
  return new Set(files.filter((f) => isLarge(f) || f.binary).map((f) => f.path));
}

/** The line a finding anchors to: same new-side line, else the nearest following one, else the closest before. */
export function anchorLine(file: DiffFile, line: number | null): { hunk: number; line: number } | null {
  if (line === null) return null;
  let best: { hunk: number; line: number; dist: number } | null = null;
  for (let hi = 0; hi < file.hunks.length; hi++) {
    const lines = (file.hunks[hi] as DiffHunk).lines;
    for (let li = 0; li < lines.length; li++) {
      // Findings point at the new side; deleted lines never anchor one.
      const n = (lines[li] as DiffLine).newLine;
      if (n === null) continue;
      const dist = n === line ? 0 : n > line ? n - line : 10_000 + (line - n);
      if (!best || dist < best.dist) best = { hunk: hi, line: li, dist };
    }
  }
  return best ? { hunk: best.hunk, line: best.line } : null;
}

export interface BuiltRows {
  rows: Row[];
  /** Row indices of hunk headers (j/k). */
  hunkRows: number[];
  /** Row indices of finding cards (n). */
  findingRows: number[];
  /** Row index of each file header by path. */
  fileRows: Map<string, number>;
  /** Findings whose file is not part of this diff. */
  elsewhere: TrackedFinding[];
}

export function buildRows(
  files: readonly DiffFile[],
  collapsed: ReadonlySet<string>,
  findings: readonly TrackedFinding[],
  findingHeight: (f: TrackedFinding) => number,
): BuiltRows {
  const rows: Row[] = [];
  const hunkRows: number[] = [];
  const findingRows: number[] = [];
  const fileRows = new Map<string, number>();
  const placed = new Set<TrackedFinding>();
  files.forEach((file, fi) => {
    fileRows.set(file.path, rows.length);
    rows.push({ kind: 'file', key: `f:${file.path}`, file: fi, height: ROW_H.file });
    const mine = findings.filter((f) => f.finding.file === file.path);
    if (collapsed.has(file.path)) {
      const hidden = mine.length ? ` · ${mine.length} finding${mine.length === 1 ? '' : 's'}` : '';
      rows.push({
        kind: 'note',
        key: `n:${file.path}`,
        file: fi,
        text: `${file.binary ? 'Binary file' : `${file.additions + file.deletions} changed lines`} · collapsed${hidden}`,
        height: ROW_H.note,
      });
      for (const f of mine) placed.add(f);
      return;
    }
    if (file.binary || file.hunks.length === 0) {
      rows.push({
        kind: 'note',
        key: `n:${file.path}`,
        file: fi,
        text: file.binary
          ? 'Binary file'
          : file.status === 'renamed'
            ? `Renamed from ${file.oldPath}`
            : 'No textual changes',
        height: ROW_H.note,
      });
    }
    const anchors = new Map<string, TrackedFinding[]>();
    const unanchored: TrackedFinding[] = [];
    for (const f of mine) {
      const at = anchorLine(file, f.finding.line);
      if (!at) unanchored.push(f);
      else anchors.set(`${at.hunk}:${at.line}`, [...(anchors.get(`${at.hunk}:${at.line}`) ?? []), f]);
    }
    const pushFinding = (f: TrackedFinding) => {
      placed.add(f);
      findingRows.push(rows.length);
      rows.push({ kind: 'finding', key: `x:${f.key}`, file: fi, finding: f, height: findingHeight(f) });
    };
    for (const f of unanchored) pushFinding(f);
    file.hunks.forEach((hunk, hi) => {
      hunkRows.push(rows.length);
      rows.push({ kind: 'hunk', key: `h:${file.path}:${hi}`, file: fi, hunk: hi, height: ROW_H.hunk });
      hunk.lines.forEach((_, li) => {
        const here = anchors.get(`${hi}:${li}`) ?? [];
        const anchor = here.some((f) => f.state === 'open') ? 'open' : here.length ? 'resolved' : null;
        rows.push({
          kind: 'line',
          key: `l:${file.path}:${hi}:${li}`,
          file: fi,
          hunk: hi,
          line: li,
          height: ROW_H.line,
          anchor,
        });
        for (const f of here) pushFinding(f);
      });
    });
    if (file.truncated)
      rows.push({
        kind: 'note',
        key: `t:${file.path}`,
        file: fi,
        text: 'Diff truncated: too large to show in full',
        height: ROW_H.note,
      });
    rows.push({ kind: 'gap', key: `g:${file.path}`, file: fi, height: ROW_H.gap });
  });
  return {
    rows,
    hunkRows,
    findingRows,
    fileRows,
    elsewhere: findings.filter((f) => !placed.has(f) && f.finding.file !== null),
  };
}

/** Prefix sums of row heights: offsets[i] is the top of row i, offsets[rows.length] the total height. */
export function offsetsOf(rows: readonly Row[]): number[] {
  const out = new Array<number>(rows.length + 1);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    out[i] = y;
    y += (rows[i] as Row).height;
  }
  out[rows.length] = y;
  return out;
}

/** First row index whose bottom is below `y` (binary search). */
export function rowAt(offsets: readonly number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] as number) <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  sql: 'sql',
  css: 'css',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  java: 'java',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  diff: 'diff',
  patch: 'diff',
  jsonc: 'json',
  json5: 'json',
};

export function languageOf(path: string): string | null {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? null;
}

/** The two sides of a hunk as code blocks for the highlighter, with each line's index into its side. */
export function hunkSides(hunk: DiffHunk): {
  oldCode: string;
  newCode: string;
  index: { side: 'old' | 'new'; at: number }[];
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const index: { side: 'old' | 'new'; at: number }[] = [];
  for (const line of hunk.lines as DiffLine[]) {
    if (line.kind === 'del') {
      index.push({ side: 'old', at: oldLines.length });
      oldLines.push(line.text);
    } else if (line.kind === 'add') {
      index.push({ side: 'new', at: newLines.length });
      newLines.push(line.text);
    } else if (line.kind === 'context') {
      index.push({ side: 'new', at: newLines.length });
      oldLines.push(line.text);
      newLines.push(line.text);
    } else index.push({ side: 'new', at: -1 });
  }
  return { oldCode: oldLines.join('\n'), newCode: newLines.join('\n'), index };
}
