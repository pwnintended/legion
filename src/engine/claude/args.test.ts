import { describe, expect, it } from 'vitest';
import { permissionProfile, type SessionOptions } from '../types.ts';
import { bashRules, buildClaudeArgs, childEnv, mcpConfig, permissionArgs, tempDirs } from './args.ts';
import { READ_ONLY_GUIDE } from './read-only-policy.ts';

const base = (overrides: Partial<SessionOptions> = {}): SessionOptions => ({
  cwd: '/repo',
  prompt: 'p',
  permission: permissionProfile('read_only'),
  ...overrides,
});

/** Value following `flag` (asserting it appears once). */
function flag(args: string[], name: string): string | undefined {
  expect(args.filter((a) => a === name)).toHaveLength(1);
  return args[args.indexOf(name) + 1];
}

describe('buildClaudeArgs', () => {
  it('always starts headless stream-json with partial messages and config isolation', () => {
    const args = buildClaudeArgs({ opts: base(), sessionId: 'uuid-1' });
    expect(args.slice(0, 8)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
    ]);
    expect(flag(args, '--session-id')).toBe('uuid-1');
    expect(flag(args, '--setting-sources')).toBe('project');
    expect(JSON.parse(flag(args, '--settings') as string)).toEqual({ autoMemoryEnabled: false });
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model');
  });

  it('maps read_only onto default mode with the prompt tool (the session answers, never a human)', () => {
    const args = buildClaudeArgs({
      opts: base({ model: 'haiku', effort: 'low', systemPrompt: 'Be terse.', outputSchema: { type: 'object' } }),
      sessionId: 's',
    });
    expect(flag(args, '--model')).toBe('haiku');
    expect(flag(args, '--effort')).toBe('low');
    expect(flag(args, '--append-system-prompt')).toBe(`Be terse.\n\n${READ_ONLY_GUIDE}`);
    expect(flag(args, '--json-schema')).toBe('{"type":"object"}');
    expect(flag(args, '--permission-mode')).toBe('default');
    expect(flag(args, '--permission-prompt-tool')).toBe('stdio');
    expect(args).not.toContain('--permission-prompts');
    expect(args).not.toContain('--allowedTools');
    const denied = (flag(args, '--disallowedTools') as string).split(',');
    expect(denied).toEqual(
      expect.arrayContaining([
        'Edit',
        'Write',
        'AskUserQuestion',
        'ExitPlanMode',
        'Bash(git commit *)',
        'Bash(git push *)',
        'EnterWorktree',
        'CronCreate',
      ]),
    );
  });

  it('maps workspace_write onto acceptEdits with allowed commands, MCP and in-band approvals', () => {
    const args = buildClaudeArgs({
      opts: base({
        permission: permissionProfile('workspace_write', { allowedCommands: ['pnpm test', ' pnpm lint '] }),
        mcp: { legion: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer t' } } },
        addDirs: ['/a', '/b'],
      }),
      resume: 'old-session',
      mcpConfigPath: '/tmp/x/mcp.json',
    });
    expect(flag(args, '--resume')).toBe('old-session');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--append-system-prompt');
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
    expect(flag(args, '--permission-prompt-tool')).toBe('stdio');
    expect((flag(args, '--allowedTools') as string).split(',')).toEqual([
      'Bash(pnpm test)',
      'Bash(pnpm test *)',
      'Bash(pnpm lint)',
      'Bash(pnpm lint *)',
      'mcp__legion',
    ]);
    const denied = flag(args, '--disallowedTools') as string;
    expect(denied).not.toContain('Edit');
    expect(denied.split(',')).toEqual(expect.arrayContaining(['Bash(git commit *)', 'Bash(git push *)']));
    expect(flag(args, '--mcp-config')).toBe('/tmp/x/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(-4)).toEqual(['--add-dir', '/a', '--add-dir', '/b']);
  });

  it('lets only sessions allowed git (the assistant, leads) commit and push', () => {
    const denied = (git: boolean) =>
      (
        flag(
          buildClaudeArgs({ opts: base({ permission: permissionProfile('workspace_write', { git }) }) }),
          '--disallowedTools',
        ) as string
      ).split(',');
    expect(denied(false)).toEqual(expect.arrayContaining(['Bash(git commit *)', 'Bash(git push *)']));
    expect(denied(true)).not.toContain('Bash(git commit *)');
    expect(denied(true)).not.toContain('Bash(git push *)');
    expect(denied(true)).toContain('EnterWorktree');
    // Read-only sessions never get it.
    expect(permissionProfile('read_only', { git: true }).git).toBe(false);
  });

  it('gives writing sessions the temp directories as working directories, read-only ones not', () => {
    expect(tempDirs()).toContain('/tmp');
    const added = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '--add-dir' ? [a] : []));
    const write = buildClaudeArgs({ opts: base({ permission: permissionProfile('workspace_write') }) });
    expect(added(write)).toEqual(expect.arrayContaining(tempDirs()));
    const read = buildClaudeArgs({ opts: base({ permission: permissionProfile('read_only') }) });
    expect(added(read)).toEqual([]);
  });

  it('starts workspace_write in acceptEdits even with auto approvals (the session switches over the protocol)', () => {
    const args = buildClaudeArgs({
      opts: base({ permission: permissionProfile('workspace_write', { approvals: 'auto' }) }),
      sessionId: 's',
    });
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
  });

  it('loads no setting source at all for an untrusted working directory', () => {
    const args = buildClaudeArgs({ opts: base({ untrustedWorkdir: true }) });
    expect(args).toContain('--setting-sources=');
    expect(args).not.toContain('project');
    expect(args).not.toContain('--setting-sources');
  });

  it('runs a userSettings session like plain claude', () => {
    const opts = base({ permission: permissionProfile('workspace_write'), userSettings: true });
    const args = buildClaudeArgs({ opts, sessionId: 's' });
    expect(flag(args, '--setting-sources')).toBe('user,project,local');
    expect(args).not.toContain('--settings');
    expect(args).not.toContain('--strict-mcp-config');
    // An untrusted working directory still wins.
    const untrusted = buildClaudeArgs({ opts: { ...opts, untrustedWorkdir: true } });
    expect(untrusted).toContain('--setting-sources=');
    expect(untrusted).toContain('--strict-mcp-config');
  });

  it('gives an allowed command with shell syntax only its exact rule', () => {
    expect(bashRules('pnpm test')).toEqual(['Bash(pnpm test)', 'Bash(pnpm test *)']);
    expect(bashRules('pnpm build && pnpm test')).toEqual(['Bash(pnpm build && pnpm test)']);
    expect(bashRules('  ')).toEqual([]);
  });

  it('inlines the MCP config when no file is given', () => {
    const args = buildClaudeArgs({
      opts: base({ mcp: { legion: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer tok' } } } }),
      sessionId: 's',
    });
    expect(JSON.parse(flag(args, '--mcp-config') as string)).toEqual({
      mcpServers: { legion: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer tok' } } },
    });
    expect(flag(args, '--allowedTools')).toBe('mcp__legion');
  });

  it('treats an empty MCP record as none', () => {
    const args = buildClaudeArgs({ opts: base({ mcp: {} }), sessionId: 's' });
    expect(args).not.toContain('--mcp-config');
    expect(args).toContain('--strict-mcp-config');
  });

  it('rejects sessionId together with resume', () => {
    expect(() => buildClaudeArgs({ opts: base(), sessionId: 'a', resume: 'b' })).toThrow(/mutually exclusive/);
  });
});

describe('childEnv', () => {
  it('removes parent Claude Code session variables and keeps the rest', () => {
    expect(
      childEnv({
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'k',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'x',
        CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
        CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
        UNSET: undefined,
      }),
    ).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1' });
  });

  it('lays process env, profile env and session env over each other in order', () => {
    expect(
      childEnv(
        { PATH: '/bin', HOME: '/h', CLAUDECODE: '1' },
        { CLAUDE_CONFIG_DIR: '/h/.claude-1', HOME: '/p' },
        { HOME: '/s', CLAUDE_CODE_SESSION_ID: 'leak' },
      ),
    ).toEqual({ PATH: '/bin', HOME: '/s', CLAUDE_CONFIG_DIR: '/h/.claude-1' });
  });
});

describe('web profiles', () => {
  it('pre-approves the web tools for a read-only session that may use the web', () => {
    const perms = permissionArgs(permissionProfile('read_only', { web: true }), ['legion']);
    expect(perms).toMatchObject({ mode: 'default' });
    expect(perms.allowedTools).toEqual(['mcp__legion', 'WebSearch', 'WebFetch']);
    expect(perms.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(perms.disallowedTools).not.toContain('WebFetch');
  });

  it('leaves the web tools to the prompt otherwise', () => {
    expect(permissionArgs(permissionProfile('workspace_write')).allowedTools).toEqual([]);
    expect(permissionArgs(permissionProfile('workspace_write', { web: true })).allowedTools).toEqual([
      'WebSearch',
      'WebFetch',
    ]);
  });
});

describe('mcpConfig', () => {
  const linear = { type: 'http' as const, url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } };
  const local = { type: 'stdio' as const, command: 'npx', args: ['-y', 'thing'], env: { A: 'b' } };

  it('passes http and stdio servers and pre-approves them by name', () => {
    const args = buildClaudeArgs({
      opts: base({ permission: permissionProfile('workspace_write'), mcp: { linear, local } }),
      sessionId: 's',
    });
    expect(JSON.parse(flag(args, '--mcp-config') as string)).toEqual({
      mcpServers: {
        linear: { type: 'http', url: linear.url, headers: linear.headers },
        local: { type: 'stdio', command: 'npx', args: ['-y', 'thing'], env: { A: 'b' } },
      },
    });
    expect((flag(args, '--allowedTools') as string).split(',')).toEqual(['mcp__linear', 'mcp__local']);
  });

  it('rejects server names that cannot be a tool prefix', () => {
    expect(() => mcpConfig({ 'a,b': linear })).toThrow(/invalid MCP server name/);
    expect(() => mcpConfig({ '': linear })).toThrow(/invalid MCP server name/);
  });
});
