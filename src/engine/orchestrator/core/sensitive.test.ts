import { DEFAULT_SETTINGS } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { decideAfterReview } from './policy';
import { packageScriptsChanged, sensitivePaths } from './sensitive';

const LIMITS = DEFAULT_SETTINGS.limits;

describe('sensitive changes', () => {
  it('flags agent config, Legion config, CI and git hooks anywhere they apply', () => {
    expect(
      sensitivePaths([
        'src/a.ts',
        '.claude/settings.json',
        'packages/web/.claude/settings.local.json',
        'CLAUDE.md',
        'docs/AGENTS.md',
        '.codex/config.toml',
        'legion.json',
        '.github/workflows/ci.yml',
        '.husky/pre-commit',
        'README.md',
      ]),
    ).toEqual([
      '.claude/settings.json',
      '.codex/config.toml',
      '.github/workflows/ci.yml',
      '.husky/pre-commit',
      'CLAUDE.md',
      'docs/AGENTS.md',
      'legion.json',
      'packages/web/.claude/settings.local.json',
    ]);
  });

  it('detects package.json script changes only', () => {
    const pkg = (scripts: Record<string, string>, extra = {}) => JSON.stringify({ name: 'x', scripts, ...extra });
    expect(packageScriptsChanged(pkg({ test: 'vitest' }), pkg({ test: 'vitest' }, { version: '2' }))).toBe(false);
    expect(packageScriptsChanged(pkg({ test: 'vitest' }), pkg({ test: 'curl x | sh' }))).toBe(true);
    expect(packageScriptsChanged(null, pkg({ postinstall: 'x' }))).toBe(true);
    expect(packageScriptsChanged(null, pkg({}))).toBe(false);
  });

  it('sends an approved review with sensitive changes to the human gate', () => {
    const task = { status: 'reviewing' as const, attemptCount: 1, fixRounds: 0 };
    const review = { verdict: 'approve' as const, criteria: [], findings: [] };
    const node = { risk: 'low' as const, touches: [] };
    expect(decideAfterReview(task, review, { node }, LIMITS).path).toEqual(['approved']);
    const gated = decideAfterReview(task, review, { node, sensitiveChanges: ['.claude/settings.json'] }, LIMITS);
    expect(gated.path).toEqual(['approved', 'awaiting_human']);
    expect(gated.reason).toContain('.claude/settings.json');
  });
});
