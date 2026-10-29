import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { matchCommands } from './input.tsx';
import { Inline, parseBlocks, segments, wrapSegments } from './markdown.tsx';
import { formatValue } from './store.ts';

describe('parseBlocks', () => {
  it('recognizes fences, tables, headings, quotes and rules', () => {
    const blocks = parseBlocks(
      [
        '# Title',
        '',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '> note',
        '---',
        'text',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'blank', 'code', 'table', 'quote', 'rule', 'text']);
    expect(blocks[2]).toEqual({ kind: 'code', lang: 'ts', lines: ['const a = 1;'] });
    expect(blocks[3]).toEqual({
      kind: 'table',
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    });
  });
});

describe('wrapSegments', () => {
  const wrap = (text: string, width: number) =>
    wrapSegments(segments(text), width).map((l) => l.map((s) => s.text).join(''));

  it('breaks between words without carrying the space to the next line', () => {
    // "aaaa bbbb" fills 9 columns exactly; Ink alone would start the next line with the space.
    expect(wrap('aaaa bbbb cc', 9)).toEqual(['aaaa bbbb', 'cc']);
  });

  it('keeps a word that spans styles together and cuts words longer than a line', () => {
    expect(wrap('see `a.b`, ok', 6)).toEqual(['see', 'a.b,', 'ok']);
    expect(wrap('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });

  it('keeps leading spaces of the text', () => {
    expect(wrap('  x y', 10)).toEqual(['  x y']);
  });

  it('keeps link targets across wrapped labels and bare URLs', () => {
    for (const text of ['[read the docs](https://example.com/docs)', 'https://example.com/docs']) {
      const lines = wrapSegments(segments(text), 8);
      expect(lines.length).toBeGreaterThan(1);
      for (const seg of lines.flat()) expect(seg.href).toBe('https://example.com/docs');
    }
  });

  it('turns absolute file targets into file URLs', () => {
    expect(segments('[source](/tmp/source.ts)')[0]?.href).toBe('file:///tmp/source.ts');
  });

  it('renders terminal hyperlinks on every wrapped line', () => {
    const ui = render(createElement(Inline, { text: '[read the docs](https://example.com/docs)', width: 8 }));
    try {
      const lines = ui.lastFrame()?.split('\n') ?? [];
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line).toContain('\u001B]8;;https://example.com/docs\u001B\\');
        expect(line).toContain('\u001B]8;;\u001B\\');
      }
    } finally {
      ui.unmount();
    }
  });
});

describe('matchCommands', () => {
  const commands = [
    { name: 'run', args: '<name>', description: '' },
    { name: 'runs', args: '', description: '' },
    { name: 'resume', args: '', description: '' },
    { name: 'config', args: '', description: '' },
  ];
  it('matches by prefix first, then by substring, and closes once arguments start', () => {
    expect(matchCommands(commands, '/ru').map((c) => c.name)).toEqual(['run', 'runs', 'resume']);
    expect(matchCommands(commands, '/n').map((c) => c.name)).toEqual(['run', 'runs', 'config']);
    expect(matchCommands(commands, '/run x')).toEqual([]);
    expect(matchCommands(commands, 'run')).toEqual([]);
  });

  it('then by letters in order, then by description', () => {
    const more = [...commands, { name: 'workflows', args: '', description: 'browse workflows' }];
    expect(matchCommands(more, '/wfs').map((c) => c.name)).toEqual(['workflows']);
    expect(matchCommands(more, '/rme').map((c) => c.name)).toEqual(['resume']);
    expect(matchCommands(more, '/browse').map((c) => c.name)).toEqual(['workflows']);
    expect(matchCommands(more, '/br')).toEqual([]);
  });
});

describe('formatValue', () => {
  it('renders results as readable lines', () => {
    expect(formatValue({ pr: 'https://x/1', tasks: ['a', 'b'], nested: { ok: true }, none: null })).toBe(
      'pr: https://x/1\ntasks:\n  - a\n  - b\nnested:\n  ok: true\nnone: —',
    );
  });
});
