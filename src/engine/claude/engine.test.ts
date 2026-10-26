import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { permissionProfile } from '../types.ts';
import { ClaudeEngine, parseAuthStatus, parseVersion, resolveBinary } from './engine.ts';
import { claudeProfile } from './testing.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-claude-engine-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A fake `claude` script in <dir>/bin answering --version and auth status. Logged in only for the account in
 * `$CLAUDE_CONFIG_DIR` = `<dir>/account`; records its arguments and whether a parent session variable leaked.
 */
function fakeClaude(): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'claude');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `echo "$@ CLAUDECODE=$CLAUDECODE" >> "${join(dir, 'calls')}"`,
      'while [ "$1" = "--prefix" ]; do shift; done',
      'if [ "$1" = "--version" ]; then echo "2.1.289 (Claude Code)"; exit 0; fi',
      `if [ "$1" = "auth" ] && [ "$CLAUDE_CONFIG_DIR" = "${join(dir, 'account')}" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo '{"loggedIn": false, "authMethod": "none"}'; exit 1; fi`,
      'exit 2',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return bin;
}

describe('resolveBinary', () => {
  it('finds the first executable on PATH', () => {
    const bin = fakeClaude();
    expect(resolveBinary('claude', { PATH: `/nonexistent:relative:${bin}` })).toBe(join(bin, 'claude'));
    expect(resolveBinary('claude', { PATH: '/nonexistent' })).toBeNull();
    expect(resolveBinary('claude', {})).toBeNull();
  });

  it('takes a path only if it is executable', () => {
    const bin = fakeClaude();
    expect(resolveBinary(join(bin, 'claude'), {})).toBe(join(bin, 'claude'));
    expect(resolveBinary(join(bin, 'nope'), {})).toBeNull();
    expect(resolveBinary(bin, {})).toBeNull();
  });
});

describe('ClaudeEngine.probe', () => {
  it("reports version and login state for the profile's account without starting a session", async () => {
    const bin = fakeClaude();
    const engine = new ClaudeEngine(
      claudeProfile({ name: 'claude-1', args: ['--prefix'], env: { CLAUDE_CONFIG_DIR: join(dir, 'account') } }),
      { baseEnv: { PATH: bin, CLAUDECODE: '1' } },
    );
    expect(await engine.probe()).toEqual({
      kind: 'claude',
      profile: 'claude-1',
      installed: true,
      path: join(bin, 'claude'),
      version: '2.1.289',
      loggedIn: true,
      error: null,
    });
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toEqual([
      '--prefix --version CLAUDECODE=',
      '--prefix auth status --json CLAUDECODE=',
    ]);
  });

  it('reports a logged-out account', async () => {
    const bin = fakeClaude();
    const engine = new ClaudeEngine(claudeProfile({ env: { CLAUDE_CONFIG_DIR: join(dir, 'other') } }), {
      baseEnv: { PATH: bin },
    });
    const info = await engine.probe();
    expect(info).toMatchObject({ installed: true, loggedIn: false });
    expect(info.error).toMatch(/not logged in/);
  });

  it('reports a missing CLI', async () => {
    const info = await new ClaudeEngine(claudeProfile(), { baseEnv: { PATH: '/nonexistent' } }).probe();
    expect(info).toMatchObject({ installed: false, path: null, error: 'claude not found on PATH' });
  });

  it("resolves the command on the profile env's PATH", async () => {
    const bin = fakeClaude();
    const info = await new ClaudeEngine(claudeProfile({ env: { PATH: bin } }), { baseEnv: {} }).probe();
    expect(info.installed).toBe(true);
  });
});

describe('ClaudeEngine.start', () => {
  it('fails fast when the CLI is not on the session PATH', async () => {
    const engine = new ClaudeEngine(claudeProfile(), {
      baseEnv: { PATH: '/nonexistent' },
      spawn: () => {
        throw new Error('unreachable');
      },
    });
    await expect(
      engine.start({ cwd: dir, prompt: 'p', permission: permissionProfile('workspace_write') }),
    ).rejects.toThrow(/not found/);
  });
});

describe('parsers', () => {
  it('parses versions and auth status', () => {
    expect(parseVersion('2.1.289 (Claude Code)\n')).toBe('2.1.289');
    expect(parseVersion('garbage')).toBeNull();
    expect(parseAuthStatus('not json')).toBeNull();
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"api_key"}')).toBe(true);
    expect(parseAuthStatus('{"authMethod":"api_key"}')).toBeNull();
  });
});
