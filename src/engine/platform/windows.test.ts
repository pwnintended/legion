import { describe, expect, it } from 'vitest';
import { shimScript, type WindowsDeps, windowsPlatform } from './windows';

/** A fake Windows filesystem: the files that exist, and the text of the ones that are read. */
function fakeFs(files: Record<string, string>, killed: number[] = []): WindowsDeps {
  const key = (p: string) => p.toLowerCase();
  const byKey = new Map(Object.entries(files).map(([p, text]) => [key(p), text]));
  return {
    isFile: (p) => byKey.has(key(p)),
    readText: (p) => byKey.get(key(p)) ?? null,
    killTree: (pid) => void killed.push(pid),
  };
}

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const CODEX_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

describe('windows findExecutable', () => {
  const platform = windowsPlatform(
    fakeFs({
      'C:\\Tools\\claude.exe': '',
      [`${NPM}\\claude.cmd`]: '',
      [`${NPM}\\codex.cmd`]: CODEX_SHIM,
      [`${NPM}\\codex`]: '#!/bin/sh',
    }),
  );

  it('tries PATHEXT extensions in each PATH entry, in order, reading Path in any case', () => {
    expect(platform.findExecutable('claude', { Path: `C:\\Tools;${NPM}` })).toBe('C:\\Tools\\claude.exe');
    expect(platform.findExecutable('claude', { PATH: `${NPM};C:\\Tools` })).toBe(`${NPM}\\claude.cmd`);
    expect(platform.findExecutable('codex', { Path: NPM })).toBe(`${NPM}\\codex.cmd`);
  });

  it('honours PATHEXT, quoted entries, explicit extensions and absolute paths; skips relative entries', () => {
    expect(platform.findExecutable('codex', { Path: NPM, PATHEXT: '.EXE' })).toBeNull();
    expect(platform.findExecutable('claude', { Path: '"C:\\Tools"' })).toBe('C:\\Tools\\claude.exe');
    expect(platform.findExecutable('codex.cmd', { Path: NPM })).toBe(`${NPM}\\codex.cmd`);
    expect(platform.findExecutable('C:\\Tools\\claude', {})).toBe('C:\\Tools\\claude.exe');
    expect(platform.findExecutable('C:\\Tools\\nope.exe', {})).toBeNull();
    expect(platform.findExecutable('claude', { Path: 'Tools' })).toBeNull();
    expect(platform.findExecutable('Tools\\claude', { Path: 'C:\\' })).toBeNull();
  });
});

describe('windows launch', () => {
  it('runs an .exe as is', () => {
    const platform = windowsPlatform(fakeFs({}));
    expect(platform.launch('C:\\Tools\\claude.exe', ['-p', 'a\nb'], {})).toEqual({
      cmd: 'C:\\Tools\\claude.exe',
      args: ['-p', 'a\nb'],
    });
  });

  it("runs an npm shim's script with node (the bundled node.exe first), so arguments keep their newlines", () => {
    const script = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const files = { [`${NPM}\\codex.cmd`]: CODEX_SHIM, [script]: '', 'C:\\Node\\node.exe': '' };
    const fromPath = windowsPlatform(fakeFs(files)).launch(`${NPM}\\codex.cmd`, ['app-server', 'x\ny'], {
      Path: 'C:\\Node',
    });
    expect(fromPath).toEqual({ cmd: 'C:\\Node\\node.exe', args: [script, 'app-server', 'x\ny'] });
    const bundled = windowsPlatform(fakeFs({ ...files, [`${NPM}\\node.exe`]: '' }));
    expect(bundled.launch(`${NPM}\\codex.cmd`, [], {}).cmd).toBe(`${NPM}\\node.exe`);
  });

  it('falls back to cmd.exe with every argument quoted and its metacharacters escaped', () => {
    const platform = windowsPlatform(fakeFs({ 'C:\\Tools\\run.cmd': '@echo off\r\nrun.exe %*' }));
    const launched = platform.launch('C:\\Tools\\run.cmd', ['plain', 'a b', 'say "hi"', 'x&y'], {
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    });
    expect(launched).toEqual({
      cmd: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Tools\\run.cmd ^"plain^" ^"a^ b^" ^"say^ \\^"hi\\^"^" ^"x^&y^""'],
      verbatim: true,
    });
  });

  it('finds the script in npm and pnpm shim styles', () => {
    expect(shimScript('"%~dp0\\..\\pkg\\cli.mjs" %*', 'C:\\bin')).toBe('C:\\pkg\\cli.mjs');
    expect(shimScript('"%dp0%\\node_modules\\x\\cli.js" %*', 'C:\\npm')).toBe('C:\\npm\\node_modules\\x\\cli.js');
    expect(shimScript('@echo off\r\nfoo.exe %*', 'C:\\bin')).toBeNull();
    expect(shimScript(null, 'C:\\bin')).toBeNull();
  });
});

describe('windows processes and shells', () => {
  it('kills a process tree by pid, and falls back to kill() without one', () => {
    const killed: number[] = [];
    const platform = windowsPlatform(fakeFs({}, killed));
    const signals: string[] = [];
    platform.kill({ pid: 42, kill: (s) => signals.push(String(s)) > 0 }, 'SIGINT');
    platform.kill({ pid: undefined, kill: (s) => signals.push(String(s)) > 0 }, 'SIGTERM');
    expect(killed).toEqual([42]);
    expect(signals).toEqual(['SIGTERM']);
  });

  it('runs legion.json commands in Git Bash: CLAUDE_CODE_GIT_BASH_PATH, else next to git, else cmd.exe', () => {
    const git = 'C:\\Program Files\\Git';
    const files = { [`${git}\\cmd\\git.exe`]: '', [`${git}\\bin\\bash.exe`]: '', 'D:\\bash.exe': '' };
    const platform = windowsPlatform(fakeFs(files));
    expect(platform.scriptShell({ Path: `${git}\\cmd`, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\bash.exe' })).toBe(
      'D:\\bash.exe',
    );
    expect(platform.scriptShell({ Path: `${git}\\cmd` })).toBe(`${git}\\bin\\bash.exe`);
    expect(platform.scriptShell({ Path: 'C:\\Windows\\System32' })).toBe(true);
  });

  it('opens PowerShell 7, else Windows PowerShell, else cmd.exe in terminals', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const legacy = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const both = windowsPlatform(fakeFs({ [pwsh]: '', [legacy]: '' }));
    const path = 'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    expect(both.interactiveShell({ Path: path })).toEqual({ cmd: pwsh, args: ['-NoLogo'] });
    expect(windowsPlatform(fakeFs({ [legacy]: '' })).interactiveShell({ Path: path }).cmd).toBe(legacy);
    expect(windowsPlatform(fakeFs({})).interactiveShell({ ComSpec: 'C:\\cmd.exe' })).toEqual({
      cmd: 'C:\\cmd.exe',
      args: [],
    });
  });
});
