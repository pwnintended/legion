import { describe, expect, it } from 'vitest';
import { hasShellMeta, isAllowedCommand, matchesAllowedCommand, unwrapShellCommand } from './shell';

describe('strict command matching', () => {
  it('unwraps the shell wrapper Codex reports commands in', () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'pnpm test'")).toBe('pnpm test');
    expect(unwrapShellCommand("bash -c 'it'\\''s'")).toBe("it's");
    expect(unwrapShellCommand('/bin/bash -lc pnpm')).toBe('pnpm');
    expect(unwrapShellCommand('pnpm test')).toBe('pnpm test');
    // More than one word after -c, or double quotes: not something to reason about.
    expect(unwrapShellCommand("/bin/zsh -lc 'pnpm test' ; id")).toBeNull();
    expect(unwrapShellCommand('/bin/zsh -lc "pnpm test"')).toBeNull();
    expect(unwrapShellCommand("/bin/zsh -lc 'unterminated")).toBeNull();
  });

  it('accepts the allowed command plus plain arguments only', () => {
    expect(matchesAllowedCommand('pnpm test', 'pnpm test')).toBe(true);
    expect(matchesAllowedCommand('pnpm test -- --run src/a.test.ts', 'pnpm test')).toBe(true);
    expect(matchesAllowedCommand('pnpm testx', 'pnpm test')).toBe(false);
    const tails = ['&& x', '; x', '| sh', '$(x)', '`x`', '> f', '< f', '*', '?', '~', '!x', "'x'", '"x"', '\\x'];
    for (const tail of [...tails, '{a,b}', '(x)', '#', '[a]', '\nx']) {
      expect(matchesAllowedCommand(`pnpm test ${tail}`, 'pnpm test'), tail).toBe(false);
      expect(hasShellMeta(tail), tail).toBe(true);
    }
  });

  it('matches wrapped commands against a list', () => {
    expect(isAllowedCommand("/bin/zsh -lc 'pnpm lint --fix'", ['pnpm test', 'pnpm lint'])).toBe(true);
    expect(isAllowedCommand("/bin/zsh -lc 'pnpm test; id'", ['pnpm test'])).toBe(false);
    expect(isAllowedCommand('', ['pnpm test'])).toBe(false);
  });
});
