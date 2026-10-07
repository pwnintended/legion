/**
 * Host-side answer to the `can_use_tool` requests of a read-only session (planner, reviewer, finalizer, researcher).
 *
 * `dontAsk` cannot serve them: it denies whatever is not on the CLI's fixed read-only command set (not
 * configurable), and a chain is denied when one part is off it (`... ; npm -v` dies on the `npm -v`). In
 * `default` mode with the prompt tool the CLI still runs everything it recognises as read-only itself and asks
 * only about the rest; this policy answers that rest without a human: the read tools (on any path, like `cat`),
 * version/help probes and a few plain reads, alone or chained, are allowed; everything else is denied with a
 * message that tells the agent what is. `READ_ONLY_GUIDE` states the same rules up front in the system prompt, so
 * the agent does not have to learn them from denials.
 *
 * Strict by construction: a command is parsed into plain words (quoted literals only) and any shell feature that
 * could do more than run programs with literal arguments denies the whole line. The exceptions do nothing but
 * name paths or discard output: `~` / `~/…` at the start of a word, `*` and `?` globs (only for programs no
 * flag-shaped file name can turn into a writer or runner) and redirects to `/dev/null` or `2>&1`.
 */
import type { ApprovalDecision } from '@shared/engine';

const MAX_COMMAND_LENGTH = 2_000;

/** Flags that make a program print its version or usage and exit. */
const PROBE_ARGS: ReadonlySet<string> = new Set([
  '-v',
  '-V',
  '--version',
  '-version',
  'version',
  '-h',
  '--help',
  'help',
]);

/**
 * Programs that run or wrap other things, read a script from stdin, or change files: never a probe, whatever the
 * flag (`rm -v` is "verbose", not "version").
 */
const NOT_A_PROBE: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'env',
  'xargs',
  'sudo',
  'su',
  'doas',
  'nohup',
  'nice',
  'time',
  'timeout',
  'watch',
  'eval',
  'exec',
  'source',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'ln',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'tee',
  'dd',
]);

const PROGRAM = /^[A-Za-z][\w.+-]*$/;

/** Tools that only read (the CLI asks about them outside cwd and `--add-dir`s); `cat` already reads anywhere. */
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

/** `git <subcommand>` forms that only read; any other subcommand (and any global flag) is not covered. */
const GIT_READ: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'describe',
  'blame',
  'shortlog',
]);

/** Arguments that make an otherwise reading command write a file or run another program. */
const GIT_UNSAFE_ARG = /^(--output|--ext-diff|--open-files-in-pager|-O)/;
const RG_UNSAFE_ARG = /^(--pre|--hostname-bin)/;
const SORT_UNSAFE_ARG = /^(-[^-]*o|--output|--compress-program)/;
const FILE_UNSAFE_ARG = /^(-[^-]*C|--compile)/;
const TREE_UNSAFE_ARG = /^(-[^-]*[oR]|--output)/;
const FIND_UNSAFE_ARG: ReadonlySet<string> = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);
/** `sed -n` with a line or line range to print: the one `sed` that cannot write or run anything. */
const SED_PRINT = /^\d+(,(\d+|\$))?p$/;

/** Plain reads (flags are not inspected unless listed in `UNSAFE_ARG`): what an agent chains with a probe. */
const PLAIN_READ: ReadonlySet<string> = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'grep',
  'rg',
  'uniq',
  'cut',
  'basename',
  'dirname',
  'stat',
  'du',
  'which',
  'cd',
  'find',
  'sed',
  'sort',
  'tr',
  'nl',
  'diff',
  'realpath',
  'readlink',
  'file',
  'tree',
]);

/**
 * Programs a glob may feed: whatever file names it expands to (`-f`, `--pre=x`), they have no flag that writes a
 * file or runs a program. `git`, `rg`, `find`, `sort`, `tree`, … do, so a glob in their line denies it.
 */
const GLOB_SAFE: ReadonlySet<string> = new Set(['ls', 'cat', 'head', 'wc', 'grep', 'du', 'stat']);
const GLOB_SAFE_TEXT = [...GLOB_SAFE].map((p) => `\`${p}\``).join(', ');

/** Redirects that only discard output or merge stderr into stdout, followed by the end of the word. */
const HARMLESS_REDIRECT = /^(?:[12&]?>>?[ \t]*\/dev\/null|2>&1)(?=[ \t;|&]|$)/;

export interface Segment {
  words: string[];
  /** An unquoted `*` or `?` the shell will expand. */
  glob?: true;
}

/**
 * Splits a command line into `;` `&&` `||` `|` separated segments of plain words. Null when the line uses
 * anything else a shell would interpret: substitution, variables, redirection (but `>/dev/null`, `2>/dev/null`,
 * `&>/dev/null`, `2>&1`, which are dropped), brace or bracket expansion, `~user`, grouping, escapes, background
 * jobs, comments or line breaks outside single quotes (inside them everything is literal). `~` and `~/…` at the
 * start of a word are kept as written (the shell makes them the home folder); `*` and `?` mark the segment `glob`.
 */
export function parseSegments(command: string): Segment[] | null {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) return null;
  const segments: Segment[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let glob = false;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length === 0) return false;
    segments.push(glob ? { words, glob } : { words });
    words = [];
    glob = false;
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === '\n' || c === '\r' || c === '\0') return null;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word = (word ?? '') + c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '$' || c === '`' || c === '\\' || c === '!') return null;
      else word = (word ?? '') + c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word = word ?? '';
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (word === null) {
      const redirect = HARMLESS_REDIRECT.exec(command.slice(i));
      if (redirect) {
        i += redirect[0].length - 1;
        continue;
      }
    }
    if (c === ';') {
      if (!endSegment()) return null;
      continue;
    }
    if (c === '|' || c === '&') {
      const double = command[i + 1] === c;
      if (c === '&' && !double) return null;
      if (!endSegment()) return null;
      if (double) i++;
      continue;
    }
    // `~` only expands at the start of a word (inside one, `HEAD~1`, it is literal); `~user` is someone else's.
    if (c === '~' && word === null && !/^~(\/|[ \t;|&]|$)/.test(command.slice(i))) return null;
    if (c === '*' || c === '?') glob = true;
    else if ('`$<>(){}\\[]!#'.includes(c)) return null;
    word = (word ?? '') + c;
  }
  if (quote !== null) return null;
  if (!endSegment()) return null;
  return segments;
}

/** `<program> --version` and friends, `command -v <program>`: print something and exit. */
function isProbe(words: readonly string[]): boolean {
  const [program, arg, extra] = words as [string, string?, string?];
  if (program === 'command') return words.length === 3 && arg === '-v' && PROGRAM.test(extra ?? '');
  if (words.length !== 2 || NOT_A_PROBE.has(program)) return false;
  return PROGRAM.test(program) && PROBE_ARGS.has(arg ?? '');
}

/** `git [-C <dir>] [--no-pager] <read subcommand> ...` without an argument that writes or runs something. */
function isGitRead(args: readonly string[]): boolean {
  let i = 0;
  while (args[i] === '-C' || args[i] === '--no-pager') i += args[i] === '-C' ? 2 : 1;
  const sub = args[i];
  return sub !== undefined && GIT_READ.has(sub) && !args.slice(i).some((a) => GIT_UNSAFE_ARG.test(a));
}

function isPlainRead(words: readonly string[]): boolean {
  const [program, ...args] = words as [string, ...string[]];
  if (program === 'git') return isGitRead(args);
  if (!PLAIN_READ.has(program)) return false;
  switch (program) {
    case 'rg':
      return !args.some((a) => RG_UNSAFE_ARG.test(a));
    case 'tail':
      return !args.some((a) => a === '-f' || a === '-F' || a.startsWith('--follow'));
    case 'cd':
      return args.length <= 1 && !args[0]?.startsWith('-');
    case 'find':
      return !args.some((a) => FIND_UNSAFE_ARG.has(a));
    case 'sed':
      return args[0] === '-n' && SED_PRINT.test(args[1] ?? '') && !args.slice(2).some((a) => a.startsWith('-'));
    case 'sort':
      return !args.some((a) => SORT_UNSAFE_ARG.test(a));
    case 'file':
      return !args.some((a) => FILE_UNSAFE_ARG.test(a));
    case 'tree':
      return !args.some((a) => TREE_UNSAFE_ARG.test(a));
    default:
      return true;
  }
}

function isAllowed({ words, glob }: Segment): boolean {
  if (glob && !GLOB_SAFE.has(words[0] as string)) return false;
  return isProbe(words) || isPlainRead(words);
}

/** The first segment of `command` that is neither a probe nor a plain read; null when every one is (or unparsable). */
export function firstDisallowed(command: string): { parsed: boolean; segment: string | null } {
  const segments = parseSegments(command.trim());
  if (!segments) return { parsed: false, segment: null };
  for (const segment of segments) {
    if (!isAllowed(segment)) return { parsed: true, segment: segment.words.join(' ') };
  }
  return { parsed: true, segment: null };
}

const ALLOWED =
  'version/help probes (`<tool> --version`, `command -v <tool>`), `cd`, `ls`, `cat`, `head`, `tail`, `wc`, ' +
  "`grep`, `rg`, `find` (no `-exec`/`-delete`), `sed -n 'N,Mp'`, `sort`, `uniq`, `cut`, `tr`, `nl`, `diff`, " +
  '`stat`, `du`, `file`, `tree`, `echo`, `pwd`, `which`, `realpath` and read-only `git` (`status`, `log`, ' +
  '`diff`, `show`, `ls-files`, `blame`, …, also as `git -C <dir>`), alone or chained with `;`, `&&`, `||` or `|`';

/**
 * Appended to a read-only session's system prompt: the policy below, stated before the agent's first command so
 * it does not spend turns finding the edges by being denied.
 */
export const READ_ONLY_GUIDE = [
  '## Tools in this session',
  '',
  'This session is read-only and nobody approves anything: what falls outside these rules is denied, not asked about.',
  '',
  '- Read files with Read (offset/limit for long ones) and search with Grep and Glob. They work on any path, ' +
    'other repositories included; prefer them to `cat`, `head`, `sed` or `find`.',
  `- Bash runs ${ALLOWED}.`,
  `- \`~/…\`, \`2>/dev/null\` and \`2>&1\` work. Unquoted \`*\` and \`?\` only with ${GLOB_SAFE_TEXT}; quote ` +
    'patterns for `find -name` and `rg`.',
  '- Not available: `$(…)`, backticks, variables, other redirects, `{…}`/`[…]`, subshells, heredocs, line ' +
    'breaks, and anything that writes, installs, builds or runs code.',
].join('\n');

function deny(message: string): ApprovalDecision {
  return { behavior: 'deny', message, interrupt: false };
}

/** The answer to one `can_use_tool` request of a read-only session. Never asks a human. */
export function decideReadOnly(toolName: string, input: unknown): ApprovalDecision {
  if (READ_TOOLS.has(toolName)) return { behavior: 'allow', scope: 'once', updatedInput: null };
  if (toolName !== 'Bash') {
    return deny(`${toolName} is not available in this read-only session. Use Read, Grep, Glob or read-only Bash.`);
  }
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return deny('Bash needs a command string.');
  const { parsed, segment } = firstDisallowed(command);
  if (!parsed) {
    return deny(
      'This session is read-only and runs plain commands only (no substitution, variables, redirects other than ' +
        `to /dev/null, braces, brackets, escapes or line breaks). Allowed: ${ALLOWED}. Run anything else as ` +
        'separate simple commands.',
    );
  }
  if (segment === null) return { behavior: 'allow', scope: 'once', updatedInput: null };
  return deny(
    `This session is read-only: \`${segment}\` is not allowed (globs only with ${GLOB_SAFE_TEXT}). ` +
      `Allowed: ${ALLOWED}. Run the other parts of the line as separate commands.`,
  );
}
