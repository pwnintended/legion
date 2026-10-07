import { describe, expect, it } from 'vitest';
import { decideReadOnly, parseSegments } from './read-only-policy';

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
    'ls *.ts',
    'ls ~/x',
    'ls a ~',
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

  it('denies every other tool and a missing command', () => {
    expect(decideReadOnly('WebFetch', { url: 'https://x' })).toMatchObject({ behavior: 'deny' });
    expect(decideReadOnly('Bash', {})).toMatchObject({ behavior: 'deny' });
    expect(decideReadOnly('Bash', null)).toMatchObject({ behavior: 'deny' });
  });
});
