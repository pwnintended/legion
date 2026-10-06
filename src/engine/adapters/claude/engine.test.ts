import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { permissionProfileFor } from '@shared/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/helpers';
import { ClaudeEngine, parseAuthStatus, parseVersion, resolveClaudeBinary } from './engine';

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir('legion-claude-engine-');
});
afterEach(() => dir.cleanup());

/** A fake `claude` script in <dir>/bin answering --version and auth status. */
function fakeClaude(authJson: string, authExit = 0): string {
  const bin = join(dir.path, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'claude');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.289 (Claude Code)"; exit 0; fi',
      `if [ "$1" = "auth" ]; then echo '${authJson}'; exit ${authExit}; fi`,
      'exit 2',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return bin;
}

describe('resolveClaudeBinary', () => {
  it('finds the first executable claude on PATH', () => {
    const bin = fakeClaude('{}');
    expect(resolveClaudeBinary({ PATH: `/nonexistent:relative:${bin}` })).toBe(join(bin, 'claude'));
    expect(resolveClaudeBinary({ PATH: '/nonexistent' })).toBeNull();
    expect(resolveClaudeBinary({})).toBeNull();
  });

  it('honours an explicit binary path only if executable', () => {
    const bin = fakeClaude('{}');
    expect(resolveClaudeBinary({}, join(bin, 'claude'))).toBe(join(bin, 'claude'));
    expect(resolveClaudeBinary({}, join(bin, 'nope'))).toBeNull();
  });
});

describe('ClaudeEngine.probe', () => {
  it('reports version and login state without starting a session', async () => {
    const bin = fakeClaude(
      '{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c", "subscriptionType": "max"}',
    );
    const info = await new ClaudeEngine({ env: { PATH: bin } }).probe();
    expect(info).toMatchObject({
      kind: 'claude',
      installed: true,
      path: join(bin, 'claude'),
      version: '2.1.289',
      loggedIn: true,
      account: 'a@b.c (max)',
      error: null,
    });
    expect(info.models).toContain('haiku');
  });

  it('reports a logged-out CLI', async () => {
    const bin = fakeClaude('{"loggedIn": false, "authMethod": "none"}', 1);
    const info = await new ClaudeEngine({ env: { PATH: bin } }).probe();
    expect(info).toMatchObject({ installed: true, loggedIn: false, account: null });
    expect(info.error).toMatch(/not logged in/);
  });

  it('reports a missing CLI', async () => {
    const info = await new ClaudeEngine({ env: { PATH: '/nonexistent' } }).probe();
    expect(info).toMatchObject({ installed: false, path: null, error: 'claude CLI not found on PATH' });
  });
});

describe('ClaudeEngine.start', () => {
  it('fails fast when the CLI is not on the session PATH', async () => {
    const engine = new ClaudeEngine({ spawn: () => Promise.reject(new Error('unreachable')) as never });
    await expect(
      engine.start({
        role: 'coder',
        cwd: dir.path,
        prompt: 'p',
        permission: permissionProfileFor('coder'),
        mcp: null,
        env: { PATH: '/nonexistent' },
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('parsers', () => {
  it('parses versions and auth status', () => {
    expect(parseVersion('2.1.289 (Claude Code)\n')).toBe('2.1.289');
    expect(parseVersion('garbage')).toBeNull();
    expect(parseAuthStatus('not json')).toEqual({ loggedIn: null, account: null });
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"api_key"}')).toEqual({ loggedIn: true, account: 'api_key' });
  });
});
