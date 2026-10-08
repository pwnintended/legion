import type { EngineInfo } from '@shared/engine';
import { describe, expect, it } from 'vitest';
import { engineStatus, parseBinaryPath, parseBudget, parseModel, parseWhole } from './settings-model';

describe('settings validation', () => {
  it('accepts whole numbers in range only', () => {
    expect(parseWhole(' 4 ', 1, 32)).toEqual({ ok: true, value: 4 });
    expect(parseWhole('0', 1, 32).ok).toBe(false);
    expect(parseWhole('33', 1, 32)).toEqual({ ok: false, message: 'Must be between 1 and 32.' });
    expect(parseWhole('2.5', 1, 32).ok).toBe(false);
    expect(parseWhole('', 0, 10).ok).toBe(false);
  });

  it('parses budgets, empty = no limit', () => {
    expect(parseBudget('')).toEqual({ ok: true, value: null });
    expect(parseBudget('$12.50')).toEqual({ ok: true, value: 12.5 });
    expect(parseBudget('1,000')).toEqual({ ok: true, value: 1000 });
    expect(parseBudget('0').ok).toBe(false);
    expect(parseBudget('ten').ok).toBe(false);
    expect(parseBudget('1.234').ok).toBe(false);
  });

  it('wants absolute binary paths or nothing', () => {
    expect(parseBinaryPath('')).toEqual({ ok: true, value: null });
    expect(parseBinaryPath('/opt/homebrew/bin/claude')).toEqual({ ok: true, value: '/opt/homebrew/bin/claude' });
    expect(parseBinaryPath('~/bin/codex')).toEqual({ ok: true, value: '~/bin/codex' });
    expect(parseBinaryPath('claude').ok).toBe(false);
    expect(parseBinaryPath('/usr/local/bin/').ok).toBe(false);
    expect(parseBinaryPath('C:\\Tools\\claude.exe', 'windows')).toEqual({ ok: true, value: 'C:\\Tools\\claude.exe' });
    expect(parseBinaryPath('~\\bin\\codex.cmd', 'windows').ok).toBe(true);
    expect(parseBinaryPath('C:\\Tools\\', 'windows').ok).toBe(false);
    expect(parseBinaryPath('/opt/claude', 'windows').ok).toBe(false);
  });

  it('treats an empty model as the CLI default', () => {
    expect(parseModel(' ')).toEqual({ ok: true, value: null });
    expect(parseModel('opus')).toEqual({ ok: true, value: 'opus' });
    expect(parseModel('gpt 5').ok).toBe(false);
  });
});

describe('engineStatus', () => {
  const info = (patch: Partial<EngineInfo>): EngineInfo => ({
    kind: 'claude',
    installed: true,
    path: '/opt/homebrew/bin/claude',
    version: '2.1.0',
    loggedIn: true,
    account: 'dev@example.com',
    models: [],
    error: null,
    probedAt: 0,
    ...patch,
  });

  it('summarizes install and login state', () => {
    expect(engineStatus(info({}), true)).toEqual({ tone: 'ok', label: 'logged in', detail: 'dev@example.com' });
    expect(engineStatus(info({ loggedIn: null, account: null }), true).label).toBe('ready');
    expect(engineStatus(info({ loggedIn: false }), true).tone).toBe('warn');
    expect(engineStatus(info({ installed: false, error: 'claude: command not found' }), true)).toEqual({
      tone: 'bad',
      label: 'not found',
      detail: 'claude: command not found',
    });
    expect(engineStatus(info({}), false).label).toBe('disabled');
    expect(engineStatus(undefined, true).label).toBe('not detected yet');
  });
});
