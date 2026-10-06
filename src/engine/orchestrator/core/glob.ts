/**
 * Repo-relative path globs, without dependencies.
 *
 * Supported syntax: `*` (any run of non-`/` chars), `?`, `[abc]`, `[a-z]`, `[!x]`/`[^x]`, `**` as a whole
 * segment (any number of segments, including zero), `{a,b}` alternatives (nested, expanded up to
 * `MAX_BRACE_EXPANSIONS`), and `\x` escapes. A pattern without any wildcard (`src/db`) and a pattern ending
 * in `/` mean "this path and everything below it", like a .gitignore entry, because planners routinely
 * declare directories as plain paths.
 *
 * Overlap is decided exactly for this language: two globs overlap iff some path matches both. It is the
 * emptiness test of the product of two segment automata (`**` vs segments), each segment being a product of
 * two character automata (`*` vs chars). Anything outside the language (extglobs `@(..)`, `{1..3}` ranges,
 * huge brace expansions) is treated as "matches everything", so it overlaps with every other glob: the
 * check never under-reports. Known over-reporting: `*` may match an empty segment and dotfiles are not
 * special, so `a/*` overlaps `a/.env`.
 */

type CharToken =
  | { t: 'lit'; c: string }
  | { t: 'any' }
  | { t: 'class'; negated: boolean; ranges: ReadonlyArray<readonly [number, number]> };
type SegToken = CharToken | { t: 'star' };
type Segment = { t: 'globstar' } | { t: 'seg'; tokens: readonly SegToken[] };

export interface CompiledGlob {
  /** Normalized source (see `normalizeGlob`). */
  readonly source: string;
  /** Alternatives after brace expansion; the glob matches a path iff any alternative does. */
  readonly alternatives: readonly (readonly Segment[])[];
  /** Outside the supported language; compiled as `**` (matches everything). */
  readonly unsupported: boolean;
}

export const MAX_BRACE_EXPANSIONS = 256;

const GLOB_META = /[*?[\]{}]/;

/** Trim, drop leading `./`, collapse duplicate slashes. Does not judge sanity (see `globProblems`). */
export function normalizeGlob(glob: string): string {
  let out = glob.trim().replace(/\/{2,}/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** True if the pattern has no wildcard characters (escapes aside). */
export function isLiteralGlob(glob: string): boolean {
  return !GLOB_META.test(glob.replace(/\\./g, ''));
}

export interface GlobProblem {
  severity: 'error' | 'warning';
  message: string;
}

/** Sanity problems of a `touches` glob: must be repo-relative, inside the repo, and parseable. */
export function globProblems(raw: string): GlobProblem[] {
  const problems: GlobProblem[] = [];
  const glob = normalizeGlob(raw);
  const error = (message: string) => problems.push({ severity: 'error', message });
  const warning = (message: string) => problems.push({ severity: 'warning', message });
  if (glob === '' || glob === '.') {
    error('empty path');
    return problems;
  }
  if (glob.includes('\0')) error('contains a NUL character');
  if (glob.startsWith('/') || glob.startsWith('~') || /^[A-Za-z]:[\\/]/.test(glob)) {
    error('must be relative to the repository root');
  }
  if (glob.startsWith('!')) error('negated globs are not supported');
  const segments = glob.split('/');
  if (segments.includes('..')) error('must not leave the repository (`..`)');
  if (segments.includes('.git')) error('must not touch `.git`');
  if (/[@!+*?]\(/.test(glob)) warning('extglob syntax is not supported; treated as matching everything');
  if (/\\(?![*?[\]{}\\!^])/.test(glob)) warning('backslash is an escape character; use `/` as path separator');
  const balance = bracketBalance(glob);
  if (balance) error(balance);
  if (!balance && /^(\*\*\/?)+\*?$|^\*$/.test(glob)) warning('matches the whole repository');
  return problems;
}

function bracketBalance(glob: string): string | null {
  let braces = 0;
  let inClass = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']' && glob[i - 1] !== '[' && !(glob[i - 1] === '!' && glob[i - 2] === '[')) inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '{') braces++;
    else if (c === '}') {
      braces--;
      if (braces < 0) return 'unbalanced `}`';
    }
  }
  if (inClass) return 'unterminated `[` character class';
  if (braces !== 0) return 'unbalanced `{`';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------------------------

/** Expand `{a,b}` groups. Returns null when unsupported (`{1..3}`) or above the expansion cap. */
function expandBraces(glob: string): string[] | null {
  let depth = 0;
  let start = -1;
  let hasComma = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') {
      if (depth === 0) {
        start = i;
        hasComma = false;
      }
      depth++;
    } else if (c === ',' && depth === 1) {
      hasComma = true;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const body = glob.slice(start + 1, i);
        if (!hasComma) {
          if (body.includes('..')) return null;
          // `{x}` is literal text; keep scanning after it.
          const rest = expandBraces(glob.slice(i + 1));
          return rest?.map((r) => `${glob.slice(0, i + 1)}${r}`) ?? null;
        }
        const parts = splitTopLevelCommas(body);
        const prefix = glob.slice(0, start);
        const suffix = glob.slice(i + 1);
        const out: string[] = [];
        for (const part of parts) {
          const expanded = expandBraces(`${prefix}${part}${suffix}`);
          if (!expanded) return null;
          out.push(...expanded);
          if (out.length > MAX_BRACE_EXPANSIONS) return null;
        }
        return out;
      }
    }
  }
  return [glob];
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === '\\') {
      current += c + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

function parseClass(glob: string, start: number): { token: CharToken; end: number } | null {
  let i = start + 1;
  let negated = false;
  if (glob[i] === '!' || glob[i] === '^') {
    negated = true;
    i++;
  }
  const ranges: [number, number][] = [];
  let first = true;
  while (i < glob.length) {
    let c = glob[i] as string;
    if (c === ']' && !first) return { token: { t: 'class', negated, ranges }, end: i };
    first = false;
    if (c === '\\' && i + 1 < glob.length) {
      i++;
      c = glob[i] as string;
    }
    const from = c.codePointAt(0) as number;
    if (glob[i + 1] === '-' && glob[i + 2] !== undefined && glob[i + 2] !== ']') {
      let to = glob[i + 2] as string;
      i += 2;
      if (to === '\\' && i + 1 < glob.length) {
        i++;
        to = glob[i] as string;
      }
      const toCode = to.codePointAt(0) as number;
      ranges.push(from <= toCode ? [from, toCode] : [toCode, from]);
    } else {
      ranges.push([from, from]);
    }
    i++;
  }
  return null;
}

function parseSegment(text: string): Segment | null {
  if (text === '**') return { t: 'globstar' };
  const tokens: SegToken[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '\\' && i + 1 < text.length) {
      tokens.push({ t: 'lit', c: text[i + 1] as string });
      i++;
    } else if (c === '*') {
      if (tokens.at(-1)?.t !== 'star') tokens.push({ t: 'star' });
    } else if (c === '?') {
      tokens.push({ t: 'any' });
    } else if (c === '[') {
      const parsed = parseClass(text, i);
      if (!parsed) return null;
      tokens.push(parsed.token);
      i = parsed.end;
    } else {
      tokens.push({ t: 'lit', c });
    }
  }
  return { t: 'seg', tokens };
}

/** Split on `/` outside character classes. */
function splitSegments(glob: string): string[] {
  const out: string[] = [];
  let current = '';
  let inClass = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '\\') {
      current += c + (glob[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    if (c === '/' && !inClass) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

const UNIVERSE: readonly Segment[] = [{ t: 'globstar' }];
const cache = new Map<string, CompiledGlob>();

/**
 * Compile a glob. `directoryLiterals` (default true) applies the "plain path = path and everything below"
 * rule; pass false to treat the input as an exact file path pattern.
 */
export function compileGlob(raw: string, directoryLiterals = true): CompiledGlob {
  const key = `${directoryLiterals ? 'd' : 'f'}:${raw}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let source = normalizeGlob(raw);
  const unsupportedResult = (): CompiledGlob => ({ source, alternatives: [UNIVERSE], unsupported: true });
  let compiled: CompiledGlob;
  if (/[@!+*?]\(/.test(source) || bracketBalance(source)) {
    compiled = unsupportedResult();
  } else {
    if (directoryLiterals && (source.endsWith('/') || isLiteralGlob(source))) {
      source = `${source.replace(/\/+$/, '')}/**`;
    }
    const expanded = expandBraces(source);
    const alternatives: Segment[][] = [];
    let ok = expanded !== null;
    for (const alt of expanded ?? []) {
      const segments: Segment[] = [];
      for (const part of splitSegments(alt)) {
        if (part === '' || part === '.') continue;
        const segment = parseSegment(part);
        if (!segment) {
          ok = false;
          break;
        }
        if (segment.t === 'globstar' && segments.at(-1)?.t === 'globstar') continue;
        segments.push(segment);
      }
      alternatives.push(segments);
    }
    compiled = ok ? { source, alternatives, unsupported: false } : unsupportedResult();
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------------------------
// Intersection
// ---------------------------------------------------------------------------------------------

const SLASH = 0x2f;
const MAX_CLASS_SCAN = 4096;

function classHas(token: Extract<CharToken, { t: 'class' }>, code: number): boolean {
  if (code === SLASH) return false;
  const inside = token.ranges.some(([from, to]) => code >= from && code <= to);
  return inside !== token.negated;
}

function charTokensIntersect(a: CharToken, b: CharToken): boolean {
  if (a.t === 'lit' && b.t === 'lit') return a.c === b.c;
  if (a.t === 'lit') return charAccepts(b, a.c);
  if (b.t === 'lit') return charAccepts(a, b.c);
  if (a.t === 'any') return classNonEmpty(b);
  if (b.t === 'any') return classNonEmpty(a);
  if (a.t !== 'class' || b.t !== 'class') return true;
  if (a.negated && b.negated) return true;
  const [pos, other] = a.negated ? [b, a] : [a, b];
  let scanned = 0;
  for (const [from, to] of pos.ranges) {
    for (let code = from; code <= to; code++) {
      if (++scanned > MAX_CLASS_SCAN) return true;
      if (classHas(pos, code) && classHas(other, code)) return true;
    }
  }
  return false;
}

function charAccepts(token: CharToken, c: string): boolean {
  if (c === '/') return false;
  if (token.t === 'lit') return token.c === c;
  if (token.t === 'any') return true;
  return classHas(token, c.codePointAt(0) as number);
}

function classNonEmpty(token: CharToken): boolean {
  return token.t !== 'class' || token.negated || token.ranges.length > 0;
}

/** Can two single-segment patterns match a common string? */
function segmentsIntersect(a: readonly SegToken[], b: readonly SegToken[]): boolean {
  const memo = new Map<number, boolean>();
  const width = b.length + 1;
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false);
    let result = false;
    const ta = a[i];
    const tb = b[j];
    if (ta === undefined && tb === undefined) result = true;
    if (!result && ta?.t === 'star') result = go(i + 1, j) || (tb !== undefined && go(i, j + 1));
    if (!result && tb?.t === 'star') result = go(i, j + 1) || (ta !== undefined && go(i + 1, j));
    if (!result && ta && tb && ta.t !== 'star' && tb.t !== 'star') {
      result = charTokensIntersect(ta, tb) && go(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function pathsIntersect(a: readonly Segment[], b: readonly Segment[]): boolean {
  const memo = new Map<number, boolean>();
  const width = b.length + 1;
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false);
    let result = false;
    const sa = a[i];
    const sb = b[j];
    if (sa === undefined && sb === undefined) result = true;
    if (!result && sa?.t === 'globstar') result = go(i + 1, j) || (sb !== undefined && go(i, j + 1));
    if (!result && sb?.t === 'globstar') result = go(i, j + 1) || (sa !== undefined && go(i + 1, j));
    if (!result && sa?.t === 'seg' && sb?.t === 'seg') {
      result = segmentsIntersect(sa.tokens, sb.tokens) && go(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function compiledOverlap(a: CompiledGlob, b: CompiledGlob): boolean {
  if (a.unsupported || b.unsupported) return true;
  return a.alternatives.some((x) => b.alternatives.some((y) => pathsIntersect(x, y)));
}

/**
 * Could some repo path match both globs? Conservative: unsupported syntax overlaps everything.
 * `directoryLiterals: false` treats wildcard-free patterns as exact file paths.
 */
export function globsOverlap(a: string, b: string, directoryLiterals = true): boolean {
  return compiledOverlap(compileGlob(a, directoryLiterals), compileGlob(b, directoryLiterals));
}

/** Does a concrete repo-relative file path match the glob (with the directory-literal rule)? */
export function globMatchesPath(glob: string, path: string): boolean {
  const compiled = compileGlob(glob);
  if (compiled.unsupported) return true;
  const segments: Segment[] = normalizeGlob(path)
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .map((s) => ({ t: 'seg', tokens: [...s].map((c) => ({ t: 'lit', c }) as const) }));
  return compiled.alternatives.some((alt) => pathsIntersect(alt, segments));
}
