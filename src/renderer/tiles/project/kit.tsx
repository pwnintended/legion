/**
 * Shared pieces of the project home tiles (overview, activity, files, code, search): data hooks over the
 * read-only project procedures, formatting, file icons, match highlighting and native niceties.
 */
import type { Project } from '@shared/domain';
import type { Commit, FileContent, FileList, PrList, ProjectInfo } from '@shared/rpc';
import type { ReactNode } from 'react';
import { rpc, useData } from '../../app/hooks';
import { useQuery } from '../../app/query';
import { Icon, type IconName } from '../../chrome/icons';
import './project.css';

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

export function useProject(projectId: string): Project | null {
  return useData((s) => s.projects[projectId] ?? null);
}

/** The user's home directory (paths read `~/…`), from `app.info`. */
export function useHomeDir(): string | null {
  const info = useQuery('app.info', () => rpc('app.info', {}), { staleMs: Number.POSITIVE_INFINITY });
  return info.data?.homeDir ?? null;
}

export function useProjectInfo(projectId: string) {
  return useQuery<ProjectInfo>(`info:${projectId}`, () => rpc('projects.info', { projectId }), { staleMs: 60_000 });
}

export function useGitLog(projectId: string, limit = 50) {
  return useQuery<Commit[]>(`log:${projectId}:${limit}`, () => rpc('git.log', { projectId, limit }), {
    staleMs: 30_000,
  });
}

export function usePrs(projectId: string) {
  return useQuery<PrList>(`prs:${projectId}`, () => rpc('prs.list', { projectId }), { staleMs: 120_000 });
}

export function useDir(projectId: string, dir: string | null) {
  return useQuery<FileList>(
    dir === null ? null : `dir:${projectId}:${dir}`,
    () => rpc('files.list', { projectId, dir: dir ?? '' }),
    { staleMs: 15_000 },
  );
}

/** The query key of a file (of a checkout: absent/null = the main one). */
export function fileKey(projectId: string, path: string, checkout: string | null = null): string {
  return `file:${projectId}:${checkout ?? ''}:${path}`;
}

export function useFile(projectId: string, path: string | null, checkout: string | null = null) {
  return useQuery<FileContent>(
    path === null ? null : fileKey(projectId, path, checkout),
    () => rpc('files.read', { projectId, path: path ?? '', checkout }),
    { staleMs: 10_000 },
  );
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `just now`, `5m`, `3h`, `yesterday`, `4d`, `Mar 3`, `Mar 3 2024`. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${sameYear ? '' : ` ${date.getFullYear()}`}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { dir: '', name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

// ---------------------------------------------------------------------------------------------
// File icons
// ---------------------------------------------------------------------------------------------

const EXT_COLOR: Record<string, string> = {
  ts: 'var(--blue)',
  tsx: 'var(--sapphire)',
  mts: 'var(--blue)',
  cts: 'var(--blue)',
  js: 'var(--yellow)',
  jsx: 'var(--yellow)',
  mjs: 'var(--yellow)',
  cjs: 'var(--yellow)',
  json: 'var(--peach)',
  md: 'var(--lavender)',
  mdx: 'var(--lavender)',
  css: 'var(--sky)',
  scss: 'var(--pink)',
  html: 'var(--peach)',
  py: 'var(--yellow)',
  go: 'var(--teal)',
  rs: 'var(--peach)',
  rb: 'var(--red)',
  sh: 'var(--green)',
  zsh: 'var(--green)',
  bash: 'var(--green)',
  yml: 'var(--mauve)',
  yaml: 'var(--mauve)',
  toml: 'var(--mauve)',
  sql: 'var(--sapphire)',
  swift: 'var(--peach)',
  lock: 'var(--overlay0)',
  svg: 'var(--yellow)',
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp']);
const TEXT_EXT = new Set(['md', 'mdx', 'txt', 'rst', 'adoc', 'license']);

export function fileVisual(name: string): { icon: IconName; color: string } {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? (lower.split('.').at(-1) ?? '') : '';
  if (IMAGE_EXT.has(ext)) return { icon: 'image', color: EXT_COLOR[ext] ?? 'var(--green)' };
  if (TEXT_EXT.has(ext) || lower.startsWith('readme') || lower === 'license')
    return { icon: 'fileText', color: EXT_COLOR[ext] ?? 'var(--subtext0)' };
  const color = EXT_COLOR[ext];
  return color ? { icon: 'fileCode', color } : { icon: 'file', color: 'var(--overlay2)' };
}

export function FileIcon({ name, size = 14 }: { name: string; size?: number }) {
  const { icon, color } = fileVisual(name);
  return <Icon name={icon} size={size} style={{ color }} className="flex-none" />;
}

const LANGUAGE_COLOR: Record<string, string> = {
  TypeScript: 'var(--blue)',
  JavaScript: 'var(--yellow)',
  Python: 'var(--sapphire)',
  Go: 'var(--teal)',
  Rust: 'var(--peach)',
  Ruby: 'var(--red)',
  Swift: 'var(--peach)',
  Kotlin: 'var(--mauve)',
  Java: 'var(--maroon)',
  CSS: 'var(--sky)',
  SCSS: 'var(--pink)',
  HTML: 'var(--flamingo)',
  Markdown: 'var(--lavender)',
  Shell: 'var(--green)',
  SQL: 'var(--sapphire)',
  Vue: 'var(--green)',
  Svelte: 'var(--peach)',
  C: 'var(--overlay2)',
  'C++': 'var(--pink)',
  'C#': 'var(--green)',
  Dockerfile: 'var(--sky)',
};
const FALLBACK_COLORS = ['var(--rosewater)', 'var(--flamingo)', 'var(--maroon)', 'var(--teal)', 'var(--lavender)'];

export function languageColor(name: string, index = 0): string {
  return LANGUAGE_COLOR[name] ?? (FALLBACK_COLORS[index % FALLBACK_COLORS.length] as string);
}

// ---------------------------------------------------------------------------------------------
// Highlighted text (fuzzy positions, search matches)
// ---------------------------------------------------------------------------------------------

/** `text` with the characters at `positions` wrapped in <mark>. */
export function HighlightPositions({
  text,
  positions,
  offset = 0,
}: {
  text: string;
  positions: readonly number[];
  offset?: number;
}) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions.map((p) => p - offset));
  const parts: ReactNode[] = [];
  let run = '';
  let marked = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(marked ? <mark key={key}>{run}</mark> : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== marked) {
      flush(i);
      marked = hit;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

/** Every occurrence of `query` in `text` marked (literal, or a regex; case per `caseSensitive`). */
export function HighlightQuery({
  text,
  query,
  regex,
  caseSensitive,
}: {
  text: string;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}) {
  let pattern: RegExp | null = null;
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = source ? new RegExp(source, caseSensitive ? 'g' : 'gi') : null;
  } catch {
    pattern = null;
  }
  if (!pattern) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0].length === 0) break;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<mark key={start}>{match[0]}</mark>);
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// ---------------------------------------------------------------------------------------------
// Native niceties
// ---------------------------------------------------------------------------------------------

type Bridge = { showItemInFolder?: (path: string) => void; openExternal?: (url: string) => Promise<void> };

function bridge(): Bridge | undefined {
  return (window as Window & { legion?: Bridge }).legion;
}

export function revealInFinder(path: string): void {
  bridge()?.showItemInFolder?.(path);
}

export function openUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  const b = bridge();
  if (b?.openExternal) void b.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** A soft placeholder while a list loads. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="ph-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={i} style={{ width: `${55 + ((i * 37) % 40)}%` }} />
      ))}
    </div>
  );
}
