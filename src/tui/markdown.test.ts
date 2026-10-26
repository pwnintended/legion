import { describe, expect, it } from 'vitest';
import { matchCommands } from './input.tsx';
import { parseBlocks } from './markdown.tsx';
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

describe('matchCommands', () => {
  const commands = [
    { name: 'run', args: '<name>', description: '' },
    { name: 'runs', args: '', description: '' },
    { name: 'resume', args: '', description: '' },
    { name: 'config', args: '', description: '' },
  ];
  it('matches by prefix first, then by substring, and closes once arguments start', () => {
    expect(matchCommands(commands, '/ru').map((c) => c.name)).toEqual(['run', 'runs']);
    expect(matchCommands(commands, '/n').map((c) => c.name)).toEqual(['run', 'runs', 'config']);
    expect(matchCommands(commands, '/run x')).toEqual([]);
    expect(matchCommands(commands, 'run')).toEqual([]);
  });
});

describe('formatValue', () => {
  it('renders results as readable lines', () => {
    expect(formatValue({ pr: 'https://x/1', tasks: ['a', 'b'], nested: { ok: true }, none: null })).toBe(
      'pr: https://x/1\ntasks:\n  - a\n  - b\nnested:\n  ok: true\nnone: —',
    );
  });
});
