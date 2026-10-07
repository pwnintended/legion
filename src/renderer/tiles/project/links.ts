/** Repository-relative links and images in Markdown (README, docs): resolution and rewriting. Pure. */

/** Resolve `rel` against the directory of `fromPath` (repo-relative); null when it leaves the repo or is a URL. */
export function resolveRepoPath(fromPath: string, rel: string): string | null {
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//') || rel.startsWith('#')) return null;
  const clean = decodeURIComponent(rel.split('#')[0]?.split('?')[0] ?? '');
  if (!clean) return null;
  const segments = clean.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.length ? segments.join('/') : null;
}

/**
 * The markdown renderer hardens URLs (relative ones come out as "[blocked]"), so repository-relative links and
 * images are rewritten to this placeholder origin first and resolved again by the components below.
 */
const REPO_ORIGIN = 'https://repo.legion.invalid/';

/** Rewrite relative `[..](x)`, `![..](x)`, `src="x"` and `href="x"` targets to {@link REPO_ORIGIN} URLs. */
export function absolutizeRepoLinks(text: string, fromPath: string): string {
  const fix = (target: string) => {
    const resolved = resolveRepoPath(fromPath, target);
    if (!resolved) return target;
    const hash = target.includes('#') ? target.slice(target.indexOf('#')) : '';
    return `${REPO_ORIGIN}${encodeURI(resolved)}${hash}`;
  };
  return text
    .replace(
      /(\]\()(<?)([^)\s>]+)(>?)/g,
      (_m, open: string, lt: string, target: string, gt: string) => `${open}${lt}${fix(target)}${gt}`,
    )
    .replace(
      /\b(src|href)=(["'])([^"']+)\2/g,
      (_m, attr: string, quote: string, target: string) => `${attr}=${quote}${fix(target)}${quote}`,
    );
}

/** The repo path behind a rewritten URL (or a still-relative one), else null. */
export function repoTarget(url: string, fromPath: string): string | null {
  if (url.startsWith(REPO_ORIGIN)) return decodeURI(url.slice(REPO_ORIGIN.length).split('#')[0] ?? '') || null;
  return resolveRepoPath(fromPath, url);
}
