/**
 * Host-side answer to the `can_use_tool` requests of a read-only session (planner, reviewer, finalizer, researcher).
 *
 * `dontAsk` cannot serve them: it denies whatever is not on the CLI's fixed read-only command set (not
 * configurable), and a chain is denied when one part is off it (`... ; npm -v` dies on the `npm -v`). In
 * `default` mode with the prompt tool the CLI still runs everything it recognises as read-only itself and asks
 * only about the rest; this policy answers that rest without a human: version/help probes and a few plain reads,
 * alone or chained, are allowed; everything else is denied with a message that tells the agent what is.
 *
 * Strict by construction: a command is parsed into plain words (quoted literals only) and any shell feature that
 * could do more than run programs with literal arguments denies the whole line.
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
]);

export interface Segment {
  words: string[];
}

/**
 * Splits a command line into `;` `&&` `||` `|` separated segments of plain words. Null when the line uses
 * anything else a shell would interpret: substitution, expansion, redirection, globs, grouping, escapes,
 * background jobs, comments or line breaks outside single quotes (inside them everything is literal).
 */
export function parseSegments(command: string): Segment[] | null {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) return null;
  const segments: Segment[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length === 0) return false;
    segments.push({ words });
    words = [];
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
    // `~` only expands at the start of a word; inside one (`HEAD~1`) it is literal.
    if ('`$<>(){}\\*?[]!#'.includes(c) || (c === '~' && word === null)) return null;
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

function isPlainRead(words: readonly string[]): boolean {
  const [program, ...args] = words as [string, ...string[]];
  if (program === 'git') {
    return args.length > 0 && GIT_READ.has(args[0] as string) && !args.some((a) => GIT_UNSAFE_ARG.test(a));
  }
  if (!PLAIN_READ.has(program)) return false;
  if (program === 'rg') return !args.some((a) => RG_UNSAFE_ARG.test(a));
  if (program === 'tail') return !args.some((a) => a === '-f' || a === '-F' || a.startsWith('--follow'));
  return true;
}

/** The first segment of `command` that is neither a probe nor a plain read; null when every one is (or unparsable). */
export function firstDisallowed(command: string): { parsed: boolean; segment: string | null } {
  const segments = parseSegments(command.trim());
  if (!segments) return { parsed: false, segment: null };
  for (const { words } of segments) {
    if (!isProbe(words) && !isPlainRead(words)) return { parsed: true, segment: words.join(' ') };
  }
  return { parsed: true, segment: null };
}

const ALLOWED =
  'version/help probes (`<tool> --version`, `command -v <tool>`), `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, ' +
  '`echo`, `pwd`, `which` and read-only `git` (`status`, `log`, `diff`, `show`, `ls-files`, …), alone or chained ' +
  'with `;`, `&&`, `||` or `|`';

function deny(message: string): ApprovalDecision {
  return { behavior: 'deny', message, interrupt: false };
}

/** The answer to one `can_use_tool` request of a read-only session. Never asks a human. */
export function decideReadOnly(toolName: string, input: unknown): ApprovalDecision {
  if (toolName !== 'Bash') {
    return deny(`${toolName} is not available in this read-only session. Use the read-only tools you already have.`);
  }
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return deny('Bash needs a command string.');
  const { parsed, segment } = firstDisallowed(command);
  if (!parsed) {
    return deny(
      `This session is read-only and runs plain commands only (no substitution, redirection, globs, variables, ` +
        `escapes or line breaks). Allowed: ${ALLOWED}. Run anything else as separate simple commands.`,
    );
  }
  if (segment === null) return { behavior: 'allow', scope: 'once', updatedInput: null };
  return deny(
    `This session is read-only: \`${segment}\` is not allowed. Allowed: ${ALLOWED}. Run the other parts of the ` +
      'line as separate commands.',
  );
}
