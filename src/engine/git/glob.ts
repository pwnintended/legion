/**
 * Minimal glob matcher for `touches` / `legion.json` patterns. Supports `**`, `*`, `?`, `[abc]`,
 * `{a,b}` and a trailing `/` (directory prefix). Paths are repo-relative, `/`-separated.
 * A pattern without glob characters matches that exact path or anything beneath it.
 */
const cache = new Map<string, RegExp>();

function hasMagic(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let p = pattern.replace(/^\.\//, '').replace(/^\/+/, '');
  let prefixOnly = false;
  if (p.endsWith('/')) {
    p = `${p}**`;
  } else if (!hasMagic(p)) {
    prefixOnly = true;
  }
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end === -1) {
        re += '\\[';
      } else {
        let body = p.slice(i + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|\\\]}]/g, '\\$&');
    }
  }
  while (braceDepth-- > 0) re += ')';
  const rx = new RegExp(`^${re}${prefixOnly ? '(?:/.*)?' : ''}$`);
  cache.set(pattern, rx);
  return rx;
}

export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path.replace(/^\.\//, ''));
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}
