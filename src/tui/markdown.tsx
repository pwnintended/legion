/**
 * Markdown for a terminal: headings, emphasis, inline code, links, lists, quotes, rules, fenced code with a
 * gutter, and pipe tables laid out in columns. Anything else prints as written.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { theme } from './theme.ts';

type Block =
  | { kind: 'text'; line: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'blank' };

export function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? '').trim().startsWith(fence[1] ?? '```'); i++)
        body.push(lines[i] ?? '');
      blocks.push({ kind: 'code', lang: fence[2] ?? '', lines: body });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? ''); i++) {
        const cells = (lines[i] ?? '')
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      i--;
      blocks.push({ kind: 'table', rows });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) blocks.push({ kind: 'rule' });
    else if (/^\s*>/.test(line)) blocks.push({ kind: 'quote', text: line.replace(/^\s*>\s?/, '') });
    else if (!line.trim()) blocks.push({ kind: 'blank' });
    else blocks.push({ kind: 'text', line });
  }
  // Collapse runs of blank lines.
  return blocks.filter((b, n) => !(b.kind === 'blank' && (n === 0 || blocks[n - 1]?.kind === 'blank')));
}

/** `**bold**`, `*em*`/`_em_`, `` `code` ``, `[text](url)` and bare URLs. */
export function Inline({ text, dim }: { text: string; dim?: boolean }): ReactNode {
  const parts: ReactNode[] = [];
  const re =
    /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const key = n++;
    if (m[2] ?? m[3])
      parts.push(
        <Text key={key} bold>
          {m[2] ?? m[3]}
        </Text>,
      );
    else if (m[4] !== undefined)
      parts.push(
        <Text key={key} color={theme.code}>
          {m[4]}
        </Text>,
      );
    else if (m[5] !== undefined)
      parts.push(
        <Text key={key}>
          <Text underline>{m[5]}</Text>
          <Text dimColor> ({m[6]})</Text>
        </Text>,
      );
    else if (m[7] ?? m[8])
      parts.push(
        <Text key={key} italic>
          {m[7] ?? m[8]}
        </Text>,
      );
    else
      parts.push(
        <Text key={key} color={theme.info} underline>
          {m[0]}
        </Text>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Text dimColor={dim}>{parts}</Text>;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text.replace(/\s+$/, ''));
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond their position.
        <BlockView key={i} block={block} />
      ))}
    </Box>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'blank':
      return <Text> </Text>;
    case 'rule':
      return <Text dimColor>{'─'.repeat(40)}</Text>;
    case 'heading':
      return (
        <Text bold color={block.level <= 2 ? theme.accent : undefined} underline={block.level === 1}>
          {block.text.replace(/\*\*/g, '')}
        </Text>
      );
    case 'quote':
      return (
        <Text>
          <Text color={theme.muted}>│ </Text>
          <Text italic dimColor>
            <Inline text={block.text} />
          </Text>
        </Text>
      );
    case 'code':
      return (
        <Box flexDirection="column">
          {block.lang ? <Text dimColor>{`╭ ${block.lang}`}</Text> : null}
          {block.lines.map((l, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional.
            <Text key={n}>
              <Text dimColor>│ </Text>
              <Text color={theme.code}>{l || ' '}</Text>
            </Text>
          ))}
        </Box>
      );
    case 'table':
      return <Table rows={block.rows} />;
    case 'text': {
      const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(block.line);
      if (list) {
        const indent = list[1] ?? '';
        const marker = /\d/.test(list[2] ?? '') ? (list[2] ?? '') : indent.length >= 2 ? '◦' : '•';
        const task = /^\[([ xX])\]\s+(.*)$/.exec(list[3] ?? '');
        return (
          <Box>
            <Text>
              {indent}
              <Text color={theme.accent}>{task ? (task[1] === ' ' ? '☐' : '☑') : marker}</Text>{' '}
            </Text>
            <Box flexShrink={1}>
              <Inline text={task ? (task[2] ?? '') : (list[3] ?? '')} />
            </Box>
          </Box>
        );
      }
      return <Inline text={block.line} />;
    }
  }
}

function Table({ rows }: { rows: string[][] }) {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const plain = (s: string) => s.replace(/\*\*|`/g, '');
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.min(40, Math.max(...rows.map((r) => plain(r[c] ?? '').length))),
  );
  const cell = (s: string, c: number) => {
    const p = plain(s);
    const w = widths[c] ?? 0;
    return p.length > w ? `${p.slice(0, w - 1)}…` : p.padEnd(w);
  };
  return (
    <Box flexDirection="column">
      {rows.map((r, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional.
        <Box key={n} flexDirection="column">
          <Text>
            {Array.from({ length: cols }, (_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional.
              <Text key={c} bold={n === 0}>
                {c > 0 ? <Text dimColor> │ </Text> : null}
                {cell(r[c] ?? '', c)}
              </Text>
            ))}
          </Text>
          {n === 0 && rows.length > 1 ? <Text dimColor>{widths.map((w) => '─'.repeat(w)).join('─┼─')}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
