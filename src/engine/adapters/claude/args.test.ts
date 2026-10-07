import { permissionProfileFor, type SessionOptions } from '@shared/engine';
import { describe, expect, it } from 'vitest';
import { bashRules, buildClaudeArgs, childEnv, flagSettings, mcpConfig, permissionArgs } from './args';
import { READ_ONLY_GUIDE } from './read-only-policy';

const base = (overrides: Partial<SessionOptions> = {}): SessionOptions => ({
  role: 'reviewer',
  cwd: '/repo',
  prompt: 'p',
  permission: permissionProfileFor('reviewer'),
  mcp: null,
  env: {},
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
    expect(args.slice(0, 7)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]);
    expect(flag(args, '--session-id')).toBe('uuid-1');
    expect(flag(args, '--setting-sources')).toBe('project');
    expect(JSON.parse(flag(args, '--settings') as string)).toEqual({ autoMemoryEnabled: false });
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model');
  });

  it('maps a read-only role onto default mode with the prompt tool (the session answers, never a human)', () => {
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
      expect.arrayContaining(['Edit', 'Write', 'AskUserQuestion', 'ExitPlanMode', 'Bash(git push *)']),
    );
  });

  it('maps a coder onto acceptEdits with verify commands, Legion MCP and in-band approvals', () => {
    const args = buildClaudeArgs({
      opts: base({
        role: 'coder',
        permission: permissionProfileFor('coder', ['pnpm test', ' pnpm lint ']),
        mcp: { url: 'http://127.0.0.1:9/mcp', token: 't' },
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
    expect(args).not.toContain('--permission-prompts');
    expect((flag(args, '--allowedTools') as string).split(',')).toEqual([
      'Bash(pnpm test)',
      'Bash(pnpm test *)',
      'Bash(pnpm lint)',
      'Bash(pnpm lint *)',
      'mcp__legion',
    ]);
    expect(flag(args, '--disallowedTools')).not.toContain('Edit');
    expect(flag(args, '--mcp-config')).toBe('/tmp/x/mcp.json');
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(args.slice(-4)).toEqual(['--add-dir', '/a', '--add-dir', '/b']);
  });

  it('loads no setting source at all for an untrusted working directory (reviewer, finalizer)', () => {
    const args = buildClaudeArgs({ opts: base({ untrustedWorkdir: true }) });
    expect(args).toContain('--setting-sources=');
    expect(args).not.toContain('project');
    expect(args).not.toContain('--setting-sources');
  });

  it('gives a verify command with shell syntax only its exact rule', () => {
    expect(bashRules('pnpm test')).toEqual(['Bash(pnpm test)', 'Bash(pnpm test *)']);
    expect(bashRules('pnpm build && pnpm test')).toEqual(['Bash(pnpm build && pnpm test)']);
    expect(bashRules('  ')).toEqual([]);
  });

  it('inlines the MCP config when no file is given', () => {
    const args = buildClaudeArgs({ opts: base({ mcp: { url: 'http://h/mcp', token: 'tok' } }), sessionId: 's' });
    expect(JSON.parse(flag(args, '--mcp-config') as string)).toEqual({
      mcpServers: { legion: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer tok' } } },
    });
    expect(flag(args, '--allowedTools')).toBe('mcp__legion');
  });

  it('denies instead of asking when a write profile has askHuman=false', () => {
    const perms = permissionArgs(
      { mode: 'workspace_write', allowedCommands: [], askHuman: false, web: false, approvals: 'ask' },
      null,
    );
    expect(perms).toMatchObject({ mode: 'acceptEdits', askHost: false, allowedTools: [] });
    const args = buildClaudeArgs({
      opts: base({
        permission: { mode: 'workspace_write', allowedCommands: [], askHuman: false, web: false, approvals: 'ask' },
      }),
    });
    expect(flag(args, '--permission-prompts')).toBe('none');
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
      }),
    ).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1' });
  });
});

describe('coordinate mode', () => {
  it('may only talk: dontAsk, Legion MCP allowed, every read/shell/web/sub-agent tool denied', () => {
    const perms = permissionArgs(
      { mode: 'coordinate', allowedCommands: ['pnpm test'], askHuman: false, web: false, approvals: 'ask' },
      { url: 'http://127.0.0.1:9/mcp', token: 't' },
    );
    expect(perms).toMatchObject({ mode: 'dontAsk', askHost: false, allowedTools: ['mcp__legion'] });
    expect(perms.disallowedTools).toEqual(
      expect.arrayContaining([
        'Read',
        'Glob',
        'Grep',
        'Bash',
        'WebFetch',
        'WebSearch',
        'Task',
        'Agent',
        'Edit',
        'Write',
        'AskUserQuestion',
        'Bash(git push *)',
      ]),
    );
    expect(perms.disallowedTools).not.toContain('Bash(pnpm test)');
  });
});

describe('web research profiles', () => {
  it('pre-approves the web tools for a read-only researcher', () => {
    const perms = permissionArgs(permissionProfileFor('researcher'), { url: 'http://127.0.0.1:9/mcp', token: 't' });
    expect(perms).toMatchObject({ mode: 'default', askHost: true });
    expect(perms.allowedTools).toEqual(['mcp__legion', 'WebSearch', 'WebFetch']);
    expect(perms.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(perms.disallowedTools).not.toContain('WebFetch');
  });

  it('lets a research lead search the web but nothing else', () => {
    const perms = permissionArgs(permissionProfileFor('research_lead'), null);
    expect(perms.allowedTools).toEqual(['WebSearch', 'WebFetch']);
    expect(perms.disallowedTools).toEqual(expect.arrayContaining(['Read', 'Bash', 'Task']));
    expect(perms.disallowedTools).not.toContain('WebSearch');
    expect(permissionArgs(permissionProfileFor('lead'), null).disallowedTools).toContain('WebSearch');
  });
});

describe('project MCP servers', () => {
  const linear = { type: 'http' as const, url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } };
  const local = { type: 'stdio' as const, command: 'npx', args: ['-y', 'thing'], env: { A: 'b' } };

  it('adds the servers next to Legion and pre-approves them by name', () => {
    const args = buildClaudeArgs({
      opts: base({
        role: 'coder',
        permission: permissionProfileFor('coder'),
        mcp: { url: 'http://h/mcp', token: 'tok' },
        extraMcp: { linear, local },
      }),
      sessionId: 's',
    });
    expect(JSON.parse(flag(args, '--mcp-config') as string)).toEqual({
      mcpServers: {
        legion: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer tok' } },
        linear: { type: 'http', url: linear.url, headers: linear.headers },
        local: { type: 'stdio', command: 'npx', args: ['-y', 'thing'], env: { A: 'b' } },
      },
    });
    expect((flag(args, '--allowedTools') as string).split(',')).toEqual(['mcp__legion', 'mcp__linear', 'mcp__local']);
    expect(args).toContain('--strict-mcp-config');
  });

  it('passes the servers even without a Legion connection', () => {
    const args = buildClaudeArgs({ opts: base({ extraMcp: { linear } }), sessionId: 's' });
    expect(Object.keys(JSON.parse(flag(args, '--mcp-config') as string).mcpServers)).toEqual(['linear']);
    expect(flag(args, '--allowedTools')).toBe('mcp__linear');
  });

  it('gives a coordinating session none of them', () => {
    const args = buildClaudeArgs({
      opts: base({
        role: 'lead',
        permission: permissionProfileFor('lead'),
        extraMcp: { linear },
        skills: { allow: ['x'], user: [] },
      }),
      sessionId: 's',
    });
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    expect(JSON.parse(flag(args, '--settings') as string)).toEqual({ autoMemoryEnabled: false });
  });

  it('builds an mcpConfig without Legion', () => {
    expect(mcpConfig(null, { linear }).mcpServers).toEqual({
      linear: { type: 'http', url: linear.url, headers: linear.headers },
    });
  });
});

describe('skill allowlist', () => {
  it('leaves the CLI default alone without one', () => {
    const args = buildClaudeArgs({ opts: base(), sessionId: 's' });
    expect(JSON.parse(flag(args, '--settings') as string)).toEqual({ autoMemoryEnabled: false });
    expect(args).not.toContain('--plugin-dir');
  });

  it('switches bundled skills off and turns off repo skills that are not allowed', () => {
    const skills = { allow: ['keep', 'zebra'], user: [{ name: 'zebra', dir: '/home/u/.claude/skills/zebra' }] };
    expect(flagSettings(skills, ['keep', 'drop'])).toEqual({
      autoMemoryEnabled: false,
      disableBundledSkills: true,
      skillOverrides: { 'plugin-authoring': 'off', drop: 'off' },
    });
    const args = buildClaudeArgs({
      opts: base({ role: 'coder', permission: permissionProfileFor('coder'), skills }),
      sessionId: 's',
      skillsPluginDir: '/tmp/x/skills-plugin',
      disabledSkills: ['keep', 'drop'],
    });
    expect(flag(args, '--plugin-dir')).toBe('/tmp/x/skills-plugin');
    expect(JSON.parse(flag(args, '--settings') as string).skillOverrides).toEqual({
      'plugin-authoring': 'off',
      drop: 'off',
    });
  });

  it('with an empty allowlist turns everything off', () => {
    expect(flagSettings({ allow: [], user: [] }, ['repo-skill'])).toMatchObject({
      disableBundledSkills: true,
      skillOverrides: { 'repo-skill': 'off', 'plugin-authoring': 'off' },
    });
  });
});
