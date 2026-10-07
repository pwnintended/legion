import { describe, expect, it } from 'vitest';
import { decideReadOnly, parseSegments, READ_ONLY_GUIDE } from './read-only-policy';

const allowed = (command: string) => decideReadOnly('Bash', { command }).behavior === 'allow';

describe('parseSegments', () => {
  it('splits on ; && || | and keeps quoted literals as one word', () => {
    expect(parseSegments("git ls-files | grep -v '^.agents/skills' ; ls -a && node -v")).toEqual([
      { words: ['git', 'ls-files'] },
      { words: ['grep', '-v', '^.agents/skills'] },
      { words: ['ls', '-a'] },
      { words: ['node', '-v'] },
    ]);
    expect(parseSegments('echo "a b"')).toEqual([{ words: ['echo', 'a b'] }]);
  });

  it.each([
    'ls $(pwd)',
    'echo `pwd`',
    'echo $HOME',
    'echo "$HOME"',
    'ls > out.txt',
    'cat < in.txt',
    'sleep 1 &',
    'ls & ls',
    '(ls)',
    '{ ls; }',
    'ls\nrm x',
    'ls # c',
    "echo 'unterminated",
    'ls ;; ls',
    '; ls',
    'ls ||',
    '',
  ])('rejects %j', (command) => {
    expect(parseSegments(command)).toBeNull();
  });

  it('keeps a leading ~ as written, drops harmless redirects and marks globs', () => {
    expect(parseSegments('ls ~/.cargo ~ 2>/dev/null; cat a >/dev/null 2>&1 | head &>/dev/null')).toEqual([
      { words: ['ls', '~/.cargo', '~'] },
      { words: ['cat', 'a'] },
      { words: ['head'] },
    ]);
    expect(parseSegments('ls src/*.ts a?')).toEqual([{ words: ['ls', 'src/*.ts', 'a?'], glob: true }]);
    expect(parseSegments("find . -name '*.rs'")).toEqual([{ words: ['find', '.', '-name', '*.rs'] }]);
    expect(parseSegments('git log HEAD~1')).toEqual([{ words: ['git', 'log', 'HEAD~1'] }]);
  });

  it.each([
    'ls ~root',
    'cat ~bob/x',
    'ls > /tmp/x',
    'ls 2>/dev/nullx',
    'ls 2>/dev/null/x',
    'ls 2>&2',
    'ls >&1',
    'ls 2>/dev/null &',
    '2>/dev/null',
    'ls src/[ab].ts',
    'ls {a,b}',
  ])('still rejects %j', (command) => {
    expect(parseSegments(command)).toBeNull();
  });

  it('treats everything inside single quotes as literal', () => {
    expect(parseSegments("grep -n 'a|b;$x`y' f")).toEqual([{ words: ['grep', '-n', 'a|b;$x`y', 'f'] }]);
  });
});

describe('decideReadOnly', () => {
  it('allows the chain from the field report that dontAsk denied', () => {
    expect(allowed("git ls-files | grep -v '^.agents/skills' ; ls -a; node -v; npm -v; which blender")).toBe(true);
  });

  it.each([
    'npm -v',
    'npm --version',
    'pnpm -v',
    'cargo --version',
    'go version',
    'java -version',
    'python3 --version',
    'rustc -V',
    'command -v node',
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1 -- src',
    'rg -n foo src | head -20',
    'cat package.json',
    'tail -n 20 log.txt',
    // From a planner session that hit the old rules on every line:
    'cd /p/bloodsport && ls -la && cat Cargo.toml 2>/dev/null | head -80 && git log --oneline | head -10',
    "find . -path ./target -prune -o -name '*.rs' -print | head -100",
    'git -C /p/bloodsport log --oneline | head -15',
    'git -C /p/x --no-pager show HEAD~1 -- src',
    'sed -n 728,990p /p/ARCHITECTURE.md',
    "sed -n '10,$p' f",
    'ls ~/.cargo/registry/src/ | head; ls ~/.cargo/registry/src/*/ | grep -E bevy',
    'which just; cargo --version; rustc --version; ls ~/.rustup/toolchains',
    'cat src/*.ts | wc -l',
    'sort -u a | uniq -c | sort -rn',
    'diff a b; realpath x; readlink -f y; file z; tree -L 2; nl f; tr a b',
    'cd',
  ])('allows %j', (command) => {
    expect(allowed(command)).toBe(true);
  });

  it.each([
    'npm install',
    'npm -v extra',
    'npm run build',
    'rm -v',
    'bash --version',
    'sh -v',
    'env -v',
    'sudo -v',
    './configure --help',
    '/usr/bin/node -v',
    'command -v',
    'command -v ../x',
    'git commit -m x',
    'git push',
    'git -c core.pager=sh log',
    'git diff --output=x',
    'git log --ext-diff',
    'git branch -D x',
    'rg --pre ./x foo',
    'tail -f log.txt',
    'ls && rm -rf x',
    'ls | sh',
    'find . -delete',
    'node -e 1',
    'find . -name x -exec rm {} +',
    'find . -name x -execdir ls ;',
    "find . -name '*.tmp' -delete",
    'find . -fprint out',
    'sed -i s/a/b/ f',
    'sed -n 1p -i f',
    "sed -n '1w out' f",
    "sed -n '1e ls' f",
    'sed 1p f',
    'sort -o out a',
    'sort -uo out a',
    'sort --compress-program=sh a',
    'tree -o out',
    'tree -R -H x',
    'file -C -m magic',
    'cd -',
    'cd a b',
    'git -C /x push',
    'git -C /x -c core.pager=sh log',
    'git -C',
    'rg foo src/*',
    'git diff src/*',
    'tail src/*.log',
    'find src/*',
    'node -v*',
  ])('denies %j', (command) => {
    expect(allowed(command)).toBe(false);
  });

  it('names the offending segment and what is allowed', () => {
    const decision = decideReadOnly('Bash', { command: 'ls; npm install; node -v' });
    expect(decision).toMatchObject({ behavior: 'deny', interrupt: false });
    if (decision.behavior !== 'deny') throw new Error('expected deny');
    expect(decision.message).toContain('`npm install`');
    expect(decision.message).toContain('--version');
  });

  it('explains an unparsable line without naming a segment', () => {
    const decision = decideReadOnly('Bash', { command: 'echo $HOME' });
    if (decision.behavior !== 'deny') throw new Error('expected deny');
    expect(decision.message).toMatch(/plain commands only/);
  });

  it('allows the read tools on any path: cat already reads anywhere', () => {
    for (const tool of ['Read', 'Grep', 'Glob']) {
      expect(decideReadOnly(tool, { file_path: '/p/other-repo/ARCHITECTURE.md' })).toMatchObject({
        behavior: 'allow',
      });
    }
  });

  it('denies every other tool and a missing command', () => {
    expect(decideReadOnly('WebFetch', { url: 'https://x' })).toMatchObject({ behavior: 'deny' });
    expect(decideReadOnly('Write', { file_path: '/x' })).toMatchObject({ behavior: 'deny' });
    expect(decideReadOnly('Bash', {})).toMatchObject({ behavior: 'deny' });
    expect(decideReadOnly('Bash', null)).toMatchObject({ behavior: 'deny' });
  });

  it('states the rules it enforces in the guide for the system prompt', () => {
    for (const text of ['Read', 'Grep', 'Glob', '`find`', "`sed -n 'N,Mp'`", '`git -C <dir>`', '2>/dev/null', '`ls`']) {
      expect(READ_ONLY_GUIDE).toContain(text);
    }
  });
});
