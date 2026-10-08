import { describe, expect, it } from 'vitest';
import { abbreviateHome, expandHome, isAbsolutePath, normalizePath, pathSegments } from './paths';

describe('paths on Windows', () => {
  it('knows drive and UNC paths as absolute, and nothing else', () => {
    expect(isAbsolutePath('C:\\Users\\me', 'windows')).toBe(true);
    expect(isAbsolutePath('d:/src', 'windows')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share\\x', 'windows')).toBe(true);
    expect(isAbsolutePath('C:relative', 'windows')).toBe(false);
    expect(isAbsolutePath('/Users/me', 'windows')).toBe(false);
    expect(isAbsolutePath('C:\\Users', 'mac')).toBe(false);
  });

  it('normalises separators, keeping a drive root and a share', () => {
    expect(normalizePath('C:/Users//me/src/', 'windows')).toBe('C:\\Users\\me\\src');
    expect(normalizePath('C:\\', 'windows')).toBe('C:\\');
    expect(normalizePath('C:/', 'windows')).toBe('C:\\');
    expect(normalizePath('\\\\server\\share\\', 'windows')).toBe('\\\\server\\share');
    expect(normalizePath('//tmp///x//', 'linux')).toBe('/tmp/x');
    expect(pathSegments('C:\\Users/me\\app', 'windows')).toEqual(['C:', 'Users', 'me', 'app']);
    expect(pathSegments('/a/b\\c', 'linux')).toEqual(['a', 'b\\c']);
  });

  it('abbreviates and expands the home directory, ignoring case on Windows', () => {
    const home = 'C:\\Users\\Me';
    expect(abbreviateHome('c:\\users\\me\\src\\app', home, 'windows')).toBe('~\\src\\app');
    expect(abbreviateHome('C:/Users/Me', home, 'windows')).toBe('~');
    expect(abbreviateHome('C:\\Users\\Meow', home, 'windows')).toBe('C:\\Users\\Meow');
    expect(expandHome('~\\src', home, 'windows')).toBe('C:\\Users\\Me\\src');
    expect(expandHome('~/src', home, 'windows')).toBe('C:\\Users\\Me\\src');
    expect(expandHome('~', home, 'windows')).toBe('C:\\Users\\Me');
    expect(expandHome('~\\src', '/home/me', 'linux')).toBe('~\\src');
  });
});
