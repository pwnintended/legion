/**
 * Built-in secret scan (§8 Verify): likely credentials on the added lines of a task's unified diff. No
 * external tool. Findings report the new-file line and a masked excerpt; the secret value itself is never
 * kept, so it can't leak into gate output, prompts or the database.
 */
import type { GateResult, GateSettings, SecretFinding } from './gates';
import { globMatchesPath } from './glob';

export interface SecretRule {
  /** Reported in findings (`github-token`). */
  readonly id: string;
  readonly description: string;
  /** Global regex over one added line. The secret is the `secret` group, else the whole match. */
  readonly pattern: RegExp;
  /** The secret of a match when it isn't the `secret` group. */
  readonly value?: (match: RegExpMatchArray) => string | undefined;
  /** Extra check on the secret (entropy, shape); false = not a finding. */
  readonly accept?: (value: string) => boolean;
  /** false = never dismissed as a placeholder (an explicit private-key header, whatever text follows it). */
  readonly placeholders?: boolean;
  /** Matches overlapping another rule's match are dropped (the generic rule defers to the specific ones). */
  readonly fallback?: boolean;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (text === '') return 0;
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  const length = [...text].length;
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A generic secret is a literal of at least this many characters at or above `GENERIC_MIN_ENTROPY`, with
 * letters and either digits or well-mixed case (see `mixedCase`). Random tokens of that length score
 * ~3.7-5 bits/char; words, repeated characters and short hex ids stay below. Lockfiles (full of hashes) are
 * skipped altogether.
 */
const GENERIC_MIN_LENGTH = 16;
const GENERIC_MIN_ENTROPY = 3.5;

/**
 * Key names a generic secret is assigned to (`api_key`, `DB_PASSWORD`, `clientSecret`, `"token"`). Bounded so a long
 * minified line can't make the pattern backtrack quadratically.
 */
const SECRET_KEY =
  '[A-Za-z0-9_.-]{0,40}(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|auth[_-]?key|private[_-]?key)[A-Za-z0-9_.-]{0,40}';

/**
 * A quoted literal, delimiter-aware: whitespace and the other quote characters may appear inside, and `\x`
 * escapes (`\"`) don't end it. The content is the `dq`, `sq` or `bq` group.
 */
const QUOTED_LITERAL = String.raw`"(?<dq>(?:[^"\\]|\\.)+)"|'(?<sq>(?:[^'\\]|\\.)+)'|\x60(?<bq>(?:[^\x60\\]|\\.)+)\x60`;

/**
 * A generic secret has at most one whitespace character per this many characters: a password with a space
 * is one, a sentence (`"Token expired at 2024, please refresh"`) is not.
 */
const CHARS_PER_SPACE = 12;

function fewSpaces(value: string): boolean {
  return (value.match(/\s/g)?.length ?? 0) * CHARS_PER_SPACE <= value.length;
}

/** Code rather than a literal: `config.apiKey`, `process.env.TOKEN`. */
const MEMBER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const ENV_REFERENCE = /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|System\.getenv|Deno\.env|ENV\[)/i;
/** Integrity hashes (`sha512-...`) aren't secrets. */
const HASH_PREFIX = /^(?:sha\d+|md5)[-:]/i;

/**
 * Upper and lower case each make up at least a quarter of the letters, as in random text; CamelCase words
 * (`ThisIsMyDevPassword`) and SCREAMING_CASE don't.
 */
function mixedCase(value: string): boolean {
  const upper = value.replace(/[^A-Z]/g, '').length;
  const lower = value.replace(/[^a-z]/g, '').length;
  const share = upper / (upper + lower);
  return share >= 0.25 && share <= 0.75;
}

function looksRandom(value: string): boolean {
  return (
    value.length >= GENERIC_MIN_LENGTH &&
    fewSpaces(value) &&
    /[A-Za-z]/.test(value) &&
    (/[0-9]/.test(value) || mixedCase(value)) &&
    !MEMBER_CHAIN.test(value) &&
    !ENV_REFERENCE.test(value) &&
    !HASH_PREFIX.test(value) &&
    shannonEntropy(value) >= GENERIC_MIN_ENTROPY
  );
}

/** The rules, most specific first. */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    description: 'PEM/OpenSSH/PGP private key block (whatever follows the header on the line is masked)',
    pattern: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----(?<secret>.*?)\s*$/g,
    placeholders: false,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID',
    pattern: /\b(?<secret>(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g,
  },
  {
    id: 'github-token',
    description: 'GitHub token (personal, OAuth, app, refresh)',
    pattern: /\b(?<secret>gh[pousr]_[A-Za-z0-9]{36,255})\b/g,
  },
  {
    id: 'github-fine-grained-token',
    description: 'GitHub fine-grained personal access token',
    pattern: /\b(?<secret>github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack token (bot, user, app, refresh)',
    pattern: /\b(?<secret>xox[abeoprs]-[A-Za-z0-9-]{10,})/g,
  },
  {
    id: 'slack-webhook',
    description: 'Slack incoming webhook URL',
    pattern: /hooks\.slack\.com\/services\/(?<secret>T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,})/g,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret or restricted key',
    pattern: /\b(?<secret>(?:sk|rk)_live_[A-Za-z0-9]{20,})\b/g,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\b(?<secret>AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/g,
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    pattern: /\b(?<secret>sk-ant-[a-z]{3,6}\d{2}-[A-Za-z0-9_-]{20,})/g,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key (legacy, project, service account, admin)',
    pattern: /\b(?<secret>sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})/g,
    accept: (value) => /[0-9]/.test(value) && shannonEntropy(value) >= GENERIC_MIN_ENTROPY,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    pattern: /\b(?<secret>npm_[A-Za-z0-9]{36})\b/g,
  },
  {
    id: 'generic-secret',
    description: 'High-entropy literal assigned to a secret/token/password/api_key name',
    pattern: new RegExp(
      [
        // `KEY = 'value'`, `"key": "value"`, `key: \`value\``, anywhere on the line.
        String.raw`${SECRET_KEY}['"]?\s*(?::=|=>|:(?!:)|=(?!=))\s*(?:${QUOTED_LITERAL})`,
        // `KEY=value` / `key: value` as the whole line (.env, YAML, INI), maybe with a `# comment` / `; comment`.
        String.raw`^\s*(?:export\s+)?${SECRET_KEY}\s*[=:]\s*(?<bare>[^\s'"\x60,;()]+)(?:\s+[#;].*)?\s*$`,
      ].join('|'),
      'gi',
    ),
    value: (m) => m.groups?.dq ?? m.groups?.sq ?? m.groups?.bq ?? m.groups?.bare,
    accept: looksRandom,
    fallback: true,
  },
];

/**
 * Values that stand for a secret rather than being one: `changeme`, `xxxx…`, `<token>`, `${VAR}`,
 * `{{ secret }}`, `your_api_key`, the AWS docs key `...EXAMPLE`.
 */
const PLACEHOLDER =
  /change[_-]?me|replace[_-]?me|placeholder|example|dummy|redacted|your[_-]|<[^>]*>|\$\{|\{\{|%\(|^\$[A-Za-z_]|x{5,}|\*{3,}|\.{3}|…|0{8,}/i;

export function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER.test(value);
}

/** Opt-out marker for a deliberate test fixture or false positive. */
export const ALLOW_SECRET_MARKER = 'legion:allow-secret';

/** Lockfiles: generated, full of hashes, never scanned. */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'Podfile.lock',
  'packages.lock.json',
  'flake.lock',
  'gradle.lockfile',
]);

export interface AddedLine {
  /** Repo-relative path in the new tree. */
  readonly file: string;
  /** Line number in the new file. */
  readonly line: number;
  /** The line without its `+`. */
  readonly text: string;
}

/** Decode a git C-quoted path (`"dir/caf\303\251 x.txt"`). */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < quoted.length - 1; i++) {
    const c = quoted[i] as string;
    if (c !== '\\') {
      bytes.push(...encoder.encode(c));
      continue;
    }
    const next = quoted[i + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(quoted.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path of a `+++ ` header, or null for `/dev/null` (a deletion). */
function headerPath(rest: string): string | null {
  let path = rest.startsWith('"') ? unquoteGitPath(rest.slice(0, rest.lastIndexOf('"') + 1)) : rest.split('\t')[0];
  path = (path ?? '').trimEnd();
  if (path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The added lines of a unified diff (`git diff`), with their new-file line numbers. Removed and context
 * lines, deleted files (`+++ /dev/null`) and binary patches yield nothing; renames report the new path.
 */
export function diffAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const marker = text[0];
      if (marker === '+') {
        if (file !== null) out.push({ file, line: newLine, text: text.slice(1) });
        newLine++;
        newLeft--;
        continue;
      }
      if (marker === '-') {
        oldLeft--;
        continue;
      }
      if (marker === ' ' || text === '') {
        oldLeft--;
        newLeft--;
        newLine++;
        continue;
      }
      if (marker === '\\') continue; // `\ No newline at end of file`
      // A truncated hunk: read the line as a header.
      oldLeft = 0;
      newLeft = 0;
    }
    if (text.startsWith('diff --git ') || text.startsWith('Binary files ') || text === 'GIT binary patch') {
      file = null;
    } else if (text.startsWith('+++ ')) {
      file = headerPath(text.slice(4));
    } else {
      const hunk = HUNK.exec(text);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLine = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
    }
  }
  return out;
}

/** The number of added lines of a unified diff (the `N` of the pass summary). */
export function countAddedLines(diff: string): number {
  return diffAddedLines(diff).length;
}

const MAX_EXCERPT = 120;
const EXCERPT_LEAD = 40;

/** At most the first 4 characters of a secret (fewer for short ones), then `…`. */
export function maskSecret(value: string): string {
  return `${value.slice(0, Math.min(4, Math.floor(value.length / 4)))}…`;
}

/** One rule's match on a line: the secret and where it is. */
interface Hit {
  readonly rule: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Values this short are only masked at their match, never wherever they occur (a lone `"` of a PEM line). */
const MIN_GLOBAL_MASK = 8;

/** Token-like runs and quoted literals of an excerpt; masked when they look random even if no rule claimed them. */
const TOKEN_RUN = /[A-Za-z0-9+/=_.~-]{16,}/g;
const QUOTED_RUN = new RegExp(QUOTED_LITERAL, 'g');

function looksLikeToken(run: string): boolean {
  return /[A-Za-z]/.test(run) && (/[0-9]/.test(run) || mixedCase(run)) && shannonEntropy(run) >= GENERIC_MIN_ENTROPY;
}

/**
 * The line with every hit masked where it matched (before trimming, so the spans still line up), then any
 * other occurrence of a hit's value and any other random-looking quoted literal or run (a credential no
 * rule recognized, in a comment or an odd syntax), trimmed and clipped around the first mask.
 */
function maskedExcerpt(text: string, hits: readonly Hit[]): string {
  const spans: { start: number; end: number }[] = [];
  for (const hit of [...hits].sort((a, b) => a.start - b.start)) {
    if (hit.end <= hit.start) continue;
    const last = spans.at(-1);
    if (last && hit.start <= last.end) last.end = Math.max(last.end, hit.end);
    else spans.push({ start: hit.start, end: hit.end });
  }
  let line = '';
  let at = 0;
  let firstMask: string | null = null;
  for (const span of spans) {
    line += text.slice(at, span.start);
    const mask = maskSecret(text.slice(span.start, span.end));
    firstMask ??= mask;
    line += mask;
    at = span.end;
  }
  line += text.slice(at);
  for (const { value } of [...hits].sort((a, b) => b.value.length - a.value.length)) {
    if (value.length >= MIN_GLOBAL_MASK) line = line.split(value).join(maskSecret(value));
  }
  line = line.replace(QUOTED_RUN, (quoted) => {
    const inner = quoted.slice(1, -1);
    return inner.length >= GENERIC_MIN_LENGTH && looksLikeToken(inner)
      ? `${quoted[0]}${maskSecret(inner)}${quoted.at(-1)}`
      : quoted;
  });
  line = line.replace(TOKEN_RUN, (run) => (looksLikeToken(run) ? maskSecret(run) : run));
  const lead = line.length - line.trimStart().length;
  const first = Math.max(0, (firstMask === null ? 0 : line.indexOf(firstMask)) - lead);
  line = line.trim();
  if (line.length <= MAX_EXCERPT) return line;
  const start = Math.max(0, Math.min(first - EXCERPT_LEAD, line.length - MAX_EXCERPT));
  const end = start + MAX_EXCERPT;
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

function hitsOf(rule: SecretRule, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(rule.pattern)) {
    const value = rule.value ? rule.value(m) : (m.groups?.secret ?? m[0]);
    if (value === undefined) continue;
    if (rule.placeholders !== false && value !== '' && isPlaceholderSecret(value)) continue;
    if (rule.accept && !rule.accept(value)) continue;
    // Every secret ends its match (a closing quote or trailing space aside).
    const start = (m.index ?? 0) + m[0].lastIndexOf(value);
    hits.push({ rule: rule.id, value, start, end: start + value.length });
  }
  return hits;
}

const overlaps = (a: Hit, b: Hit): boolean => a.start < b.end && b.start < a.end;

/** Every rule's hits on a line; fallback hits overlapping a specific one are dropped. */
function lineHits(text: string): Hit[] {
  const specific = SECRET_RULES.filter((r) => !r.fallback).flatMap((r) => hitsOf(r, text));
  const fallback = SECRET_RULES.filter((r) => r.fallback)
    .flatMap((r) => hitsOf(r, text))
    .filter((h) => !specific.some((s) => overlaps(s, h)));
  return [...specific, ...fallback];
}

/** Is this file never scanned (lockfile or `allow` glob)? */
function skippedFile(file: string, allow: readonly string[]): boolean {
  const base = file.split('/').at(-1) ?? file;
  return LOCKFILE_NAMES.has(base) || allow.some((glob) => globMatchesPath(glob, file));
}

/**
 * Likely secrets on the added lines of a unified diff, one finding per line and rule, in diff order.
 * Skips lockfiles, files matching an `allow` glob, lines containing `legion:allow-secret`, placeholders and
 * env references. Excerpts mask every secret found on the line and any other random-looking run.
 */
export function scanSecrets(diff: string, options: { readonly allow?: readonly string[] } = {}): SecretFinding[] {
  const allow = options.allow ?? [];
  const findings: SecretFinding[] = [];
  const skipped = new Map<string, boolean>();
  for (const { file, line, text } of diffAddedLines(diff)) {
    let skip = skipped.get(file);
    if (skip === undefined) {
      skip = skippedFile(file, allow);
      skipped.set(file, skip);
    }
    if (skip || text.includes(ALLOW_SECRET_MARKER)) continue;
    const hits = lineHits(text);
    if (hits.length === 0) continue;
    const excerpt = maskedExcerpt(text, hits);
    for (const rule of new Set(hits.map((h) => h.rule))) findings.push({ file, line, rule, excerpt });
  }
  return findings;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The `secrets` gate result: `skipped` when the scan is off, `pass` without findings, else `fail`, blocking
 * only in `block` mode. The output lists every finding as `file:line rule excerpt` (masked).
 */
export function secretsGateResult(
  findings: readonly SecretFinding[],
  settings: Pick<GateSettings, 'secrets'>,
  addedLines: number,
  durationMs: number | null,
): GateResult {
  const { mode } = settings.secrets;
  const base = {
    command: 'legion:secrets',
    durationMs,
    name: 'secrets',
    kind: 'secrets',
    source: 'builtin',
  } as const;
  if (mode === 'off') {
    return { ...base, exitCode: 0, outputTail: '', status: 'skipped', blocking: false, summary: 'secret scan off' };
  }
  const first = findings[0];
  if (!first) {
    return {
      ...base,
      exitCode: 0,
      outputTail: '',
      status: 'pass',
      blocking: mode === 'block',
      summary: `no secrets in ${plural(addedLines, 'added line')}`,
    };
  }
  return {
    ...base,
    exitCode: 1,
    outputTail: findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.excerpt}`).join('\n'),
    status: 'fail',
    blocking: mode === 'block',
    summary: `${plural(findings.length, 'possible secret')}, first at ${first.file}:${first.line}`,
  };
}
