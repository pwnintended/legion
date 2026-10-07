import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  formatArgs,
  formFromServer,
  parseArgs,
  parsePairs,
  parseServerName,
  serverFromForm,
  serverSummary,
  toggled,
} from './access-model';

describe('parseServerName', () => {
  it('accepts a tool-prefix-safe name', () => {
    expect(parseServerName(' linear ', [])).toEqual({ ok: true, value: 'linear' });
  });
  it('refuses a bad, reserved or taken name', () => {
    expect(parseServerName('', []).ok).toBe(false);
    expect(parseServerName('1abc', []).ok).toBe(false);
    expect(parseServerName('a__b', []).ok).toBe(false);
    expect(parseServerName('Legion', []).ok).toBe(false);
    expect(parseServerName('linear', ['linear'])).toMatchObject({ ok: false });
  });
});

describe('pairs and args', () => {
  it('parses headers and env', () => {
    expect(parsePairs('Authorization: Bearer a:b\n\nX-Team: core', ':')).toEqual({
      ok: true,
      value: { Authorization: 'Bearer a:b', 'X-Team': 'core' },
    });
    expect(parsePairs('TOKEN=a=b', '=')).toEqual({ ok: true, value: { TOKEN: 'a=b' } });
    expect(parsePairs('nonsense', ':')).toMatchObject({ ok: false });
    expect(parsePairs('=x', '=')).toMatchObject({ ok: false });
  });
  it('splits a command line, keeping quoted arguments together', () => {
    expect(parseArgs('npx -y "@acme/mcp server" \'a b\'')).toEqual(['npx', '-y', '@acme/mcp server', 'a b']);
    expect(formatArgs(['npx', '-y', 'a b'])).toBe('npx -y "a b"');
    expect(parseArgs(formatArgs(['x', 'a b', '']))).toEqual(['x', 'a b', '']);
  });
});

describe('serverFromForm', () => {
  it('builds an http server', () => {
    expect(
      serverFromForm({ ...EMPTY_FORM, url: 'https://mcp.linear.app/mcp', headers: 'Authorization: Bearer x' }),
    ).toEqual({
      ok: true,
      value: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } },
    });
  });
  it('builds a command server', () => {
    expect(serverFromForm({ ...EMPTY_FORM, type: 'stdio', command: 'npx -y thing', env: 'A=b' })).toEqual({
      ok: true,
      value: { type: 'stdio', command: 'npx', args: ['-y', 'thing'], env: { A: 'b' } },
    });
  });
  it('explains what is missing', () => {
    expect(serverFromForm({ ...EMPTY_FORM, url: 'nope' })).toMatchObject({ ok: false });
    expect(serverFromForm({ ...EMPTY_FORM, url: 'ftp://x/y' })).toMatchObject({ ok: false });
    expect(serverFromForm({ ...EMPTY_FORM, type: 'stdio', command: '  ' })).toMatchObject({ ok: false });
    expect(serverFromForm({ ...EMPTY_FORM, url: 'https://x/y', headers: 'bad' })).toMatchObject({ ok: false });
  });
  it('round-trips through the form', () => {
    const server = { type: 'stdio' as const, command: 'npx', args: ['-y', 'a b'], env: { K: 'v' } };
    expect(serverFromForm(formFromServer(server))).toEqual({ ok: true, value: server });
  });
});

describe('serverSummary', () => {
  it('never shows header or env values', () => {
    expect(serverSummary({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer secret' } })).toBe(
      'https://x/mcp · 1 header',
    );
    expect(serverSummary({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { T: 'secret' } })).toBe('npx -y x');
  });
});

describe('toggled', () => {
  it('adds and removes, keeping the given order', () => {
    expect(toggled(['b'], 'a', ['a', 'b', 'c'])).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a', ['a', 'b'])).toEqual(['b']);
    expect(toggled([], 'z')).toEqual(['z']);
  });
});
