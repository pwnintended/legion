import { chmod, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionProfileFor, type SessionOptions } from '@shared/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appServerArgs,
  childEnv,
  isPreapproved,
  MCP_TOKEN_ENV,
  policyFor,
  prepareCodexHome,
  resolveBinary,
  threadConfig,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
} from './config';

function opts(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    role: 'coder',
    cwd: '/repo/wt',
    prompt: 'go',
    permission: permissionProfileFor('coder', ['pnpm test']),
    mcp: { url: 'http://127.0.0.1:4000/mcp', token: 'secret' },
    env: { PATH: '/bin' },
    ...overrides,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'legion-codex-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('permissions', () => {
  it('maps roles per architecture §6', () => {
    for (const role of ['planner', 'reviewer', 'finalizer'] as const) {
      expect(policyFor(opts({ role, permission: permissionProfileFor(role) }))).toEqual({
        sandbox: 'read-only',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      });
    }
    for (const role of ['coder', 'resolver'] as const) {
      expect(policyFor(opts({ role, permission: permissionProfileFor(role) }))).toEqual({
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      });
    }
    const unattended = opts({ permission: { mode: 'workspace_write', allowedCommands: [], askHuman: false } });
    expect(policyFor(unattended).approvalPolicy).toBe('never');
  });

  it('pre-approves exact commands and their argument extensions only', () => {
    expect(isPreapproved(['pnpm test'], ['pnpm test'])).toBe(true);
    expect(isPreapproved(['pnpm test --run x'], ['pnpm test'])).toBe(true);
    expect(isPreapproved(['pnpm testx'], ['pnpm test'])).toBe(false);
    expect(isPreapproved(['pnpm test', 'rm -rf /'], ['pnpm test'])).toBe(false);
    expect(isPreapproved([], ['pnpm test'])).toBe(false);
    expect(isPreapproved(['pnpm test'], [])).toBe(false);
  });
});

describe('thread parameters', () => {
  it('configures the Legion MCP server with a bearer token env var and a day-long tool timeout', () => {
    expect(threadConfig(opts())).toEqual({
      mcp_servers: {
        legion: {
          url: 'http://127.0.0.1:4000/mcp',
          bearer_token_env_var: MCP_TOKEN_ENV,
          default_tools_approval_mode: 'approve',
          tool_timeout_sec: 86_400,
        },
      },
    });
    // request_human_input from a Codex coder may wait for a human at least as long as Claude's MCP_TOOL_TIMEOUT.
    const legion = (threadConfig(opts()).mcp_servers as Record<string, { tool_timeout_sec: number }>).legion;
    expect(legion?.tool_timeout_sec).toBeGreaterThanOrEqual(24 * 60 * 60);
    expect(threadStartParams(opts()).config).toMatchObject({ mcp_servers: { legion: { tool_timeout_sec: 86_400 } } });
    expect(threadResumeParams('t1', opts()).config).toMatchObject({
      mcp_servers: { legion: { tool_timeout_sec: 86_400 } },
    });
    expect(threadConfig(opts({ mcp: null }))).toEqual({});
  });

  it('adds extra writable roots for workspace-write sessions only', () => {
    expect(threadConfig(opts({ mcp: null, addDirs: ['../shared', '/abs'] }))).toEqual({
      sandbox_workspace_write: { writable_roots: ['/repo/shared', '/abs'] },
    });
    const reviewer = opts({
      role: 'reviewer',
      permission: permissionProfileFor('reviewer'),
      mcp: null,
      addDirs: ['/x'],
    });
    expect(threadConfig(reviewer)).toEqual({});
  });

  it('builds thread/start, thread/resume and turn/start params', () => {
    const o = opts({ model: 'gpt-6-luna', systemPrompt: 'Be brief.', effort: 'low', outputSchema: { type: 'object' } });
    expect(threadStartParams(o)).toMatchObject({
      cwd: '/repo/wt',
      model: 'gpt-6-luna',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      developerInstructions: 'Be brief.',
    });
    expect(threadResumeParams('t1', o)).toMatchObject({ threadId: 't1', excludeTurns: true, cwd: '/repo/wt' });
    expect(turnStartParams('t1', 'hi', o)).toEqual({
      threadId: 't1',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
      effort: 'low',
      outputSchema: { type: 'object' },
    });
    expect(turnStartParams('t1', 'hi', opts())).toEqual({
      threadId: 't1',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    });
  });

  it('puts the MCP token only in the child env', () => {
    expect(childEnv(opts(), '/home/codex')).toEqual({
      PATH: '/bin',
      CODEX_HOME: '/home/codex',
      [MCP_TOKEN_ENV]: 'secret',
    });
    expect(childEnv(opts({ mcp: null, env: { PATH: '/bin', [MCP_TOKEN_ENV]: 'stale' } }), '/h')).toEqual({
      PATH: '/bin',
      CODEX_HOME: '/h',
    });
  });

  it('disables user hooks and connectors on the app-server command line', () => {
    const args = appServerArgs();
    expect(args[0]).toBe('app-server');
    expect(args).toContain('features.hooks=false');
    expect(args).toContain('features.apps=false');
  });
});

describe('binary resolution', () => {
  it('finds executables on the given PATH only', async () => {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
    await writeFile(join(bin, 'plain'), '');
    await chmod(join(bin, 'codex'), 0o755);
    expect(await resolveBinary('codex', { PATH: `/nonexistent:${bin}` })).toBe(join(bin, 'codex'));
    expect(await resolveBinary('plain', { PATH: bin })).toBeNull();
    expect(await resolveBinary('codex', { PATH: '' })).toBeNull();
    expect(await resolveBinary(join(bin, 'codex'), {})).toBe(join(bin, 'codex'));
  });
});

describe('CODEX_HOME isolation', () => {
  it('links only auth.json into the Legion home', async () => {
    const userHome = join(dir, 'user-codex');
    await mkdir(userHome);
    await writeFile(join(userHome, 'auth.json'), '{}');
    await writeFile(join(userHome, 'hooks.json'), '{}');
    const legion = join(dir, 'legion', 'codex-home');
    const env = { CODEX_HOME: userHome };

    expect(await prepareCodexHome(legion, env)).toEqual({ path: legion, isolated: true });
    expect(await readlink(join(legion, 'auth.json'))).toBe(join(userHome, 'auth.json'));
    await expect(lstat(join(legion, 'hooks.json'))).rejects.toThrow();

    // idempotent, and repairs a replaced link
    expect(await prepareCodexHome(legion, env)).toEqual({ path: legion, isolated: true });
    await rm(join(legion, 'auth.json'));
    await writeFile(join(legion, 'auth.json'), '{"stale":true}');
    await prepareCodexHome(legion, env);
    expect(await readlink(join(legion, 'auth.json'))).toBe(join(userHome, 'auth.json'));
  });

  it('falls back to the user home without auth.json (keyring) and when disabled', async () => {
    const userHome = join(dir, 'user-codex');
    await mkdir(userHome);
    expect(await prepareCodexHome(join(dir, 'legion'), { CODEX_HOME: userHome })).toEqual({
      path: userHome,
      isolated: false,
    });
    expect(await prepareCodexHome(null, { CODEX_HOME: userHome })).toEqual({ path: userHome, isolated: false });
    expect(await prepareCodexHome(join(dir, 'legion'), { CODEX_HOME: userHome, OPENAI_API_KEY: 'k' })).toEqual({
      path: join(dir, 'legion'),
      isolated: true,
    });
  });

  it('defaults the user home to ~/.codex', async () => {
    expect(await prepareCodexHome(null, { HOME: '/Users/someone' })).toEqual({
      path: '/Users/someone/.codex',
      isolated: false,
    });
  });
});
