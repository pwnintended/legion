/**
 * Changes that widen what agents or Legion itself execute (agent settings and instructions, Legion's
 * config, CI, git hooks, package scripts). A coder writing them can escalate beyond its sandbox: the next
 * session or verify run trusts them. A task touching any of them waits for a human before merging.
 */
import { globMatchesPath } from './glob';

export const SENSITIVE_GLOBS: readonly string[] = [
  // Agent configuration and instructions (Claude Code, Codex).
  '**/.claude/**',
  '**/.codex/**',
  '**/CLAUDE.md',
  '**/CLAUDE.local.md',
  '**/AGENTS.md',
  '**/AGENTS.override.md',
  '.mcp.json',
  // Legion's own config (setup/verify commands).
  'legion.json',
  // CI.
  '.github/workflows/**',
  '.github/actions/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  '.buildkite/**',
  'azure-pipelines.yml',
  'Jenkinsfile',
  // Git hooks.
  '.husky/**',
  '.githooks/**',
  'lefthook.yml',
  '.lefthook.yml',
  '.pre-commit-config.yaml',
];

/** Changed paths matching {@link SENSITIVE_GLOBS}, sorted. */
export function sensitivePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].filter((p) => SENSITIVE_GLOBS.some((g) => globMatchesPath(g, p))).sort();
}

/** `package.json` `scripts` differ between two versions of the file's text (null = file absent). */
export function packageScriptsChanged(before: string | null, after: string | null): boolean {
  const scripts = (text: string | null): string => {
    if (text === null) return '{}';
    try {
      const parsed = JSON.parse(text) as { scripts?: unknown };
      return JSON.stringify(parsed?.scripts ?? {});
    } catch {
      return `unparsable:${text}`;
    }
  };
  return scripts(before) !== scripts(after);
}
