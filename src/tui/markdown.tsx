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

type Style = { bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean; color?: string };
/** A run of text in one style. */
export type Seg = Style & { text: string };

/** `**bold**`, `*em*`/`_em_`, `` `code` ``, `[text](url)` and bare URLs, as styled runs. */
export function segments(text: string): Seg[] {
  const segs: Seg[] = [];
  const re =
    /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    if (m[2] ?? m[3]) segs.push({ text: m[2] ?? m[3] ?? '', bold: true });
    else if (m[4] !== undefined) segs.push({ text: m[4], color: theme.code });
    else if (m[5] !== undefined) segs.push({ text: m[5], underline: true }, { text: ` (${m[6]})`, dim: true });
    else if (m[7] ?? m[8]) segs.push({ text: m[7] ?? m[8] ?? '', italic: true });
    else segs.push({ text: m[0], color: theme.info, underline: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}

const cols = (s: string) => [...s].length;

/**
 * Word-wraps styled runs into lines of at most `width` columns. Ink wraps without trimming, so a line that fills the
 * width exactly pushes the space after it to the start of the next line; wrapping here drops the spaces at breaks.
 * Words longer than a line are cut.
 */
export function wrapSegments(segs: Seg[], width: number): Seg[][] {
  // Words are runs between spaces; one word can span several styles (`` `code`, `` is one word).
  const words: { space: Seg | null; parts: Seg[] }[] = [];
  let space: Seg | null = null;
  for (const seg of segs) {
    for (const piece of seg.text.split(/( +)/)) {
      if (!piece) continue;
      if (piece.startsWith(' ')) space = { ...seg, text: piece };
      else if (space || words.length === 0) {
        words.push({ space, parts: [{ ...seg, text: piece }] });
        space = null;
      } else words[words.length - 1]?.parts.push({ ...seg, text: piece });
    }
  }
  const max = Math.max(1, width);
  const lines: Seg[][] = [[]];
  let col = 0;
  for (const [n, word] of words.entries()) {
    const w = word.parts.reduce((sum, p) => sum + cols(p.text), 0);
    // Leading spaces of the text are kept; spaces at a break are not.
    const gap = word.space ? cols(word.space.text) : 0;
    if (col > 0 && col + gap + w > max) {
      lines.push([]);
      col = 0;
    } else if (word.space && (col > 0 || n === 0)) {
      lines[lines.length - 1]?.push(word.space);
      col += gap;
    }
    for (const part of word.parts) {
      let rest = part.text;
      while (col + cols(rest) > max) {
        const room = max - col;
        if (room > 0) lines[lines.length - 1]?.push({ ...part, text: [...rest].slice(0, room).join('') });
        rest = [...rest].slice(Math.max(0, room)).join('');
        lines.push([]);
        col = 0;
      }
      if (rest) {
        lines[lines.length - 1]?.push({ ...part, text: rest });
        col += cols(rest);
      }
    }
  }
  return lines;
}

function SegsView({ segs }: { segs: Seg[] }) {
  return (
    <Text>
      {segs.map((s, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
        <Text key={n} bold={s.bold} italic={s.italic} underline={s.underline} dimColor={s.dim} color={s.color}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** Inline Markdown; with a `width`, wrapped here rather than by Ink (see `wrapSegments`). */
export function Inline({ text, width, style }: { text: string; width?: number; style?: Style }): ReactNode {
  const segs = segments(text).map((s) => ({ ...style, ...s }));
  if (width === undefined) return <SegsView segs={segs} />;
  return (
    <Box flexDirection="column">
      {wrapSegments(segs, width).map((line, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional.
        <SegsView key={n} segs={line} />
      ))}
    </Box>
  );
}

/** `width` is the columns the text has; give it whenever it is known, so wrapped lines break cleanly. */
export function Markdown({ text, width }: { text: string; width?: number }) {
  const blocks = parseBlocks(text.replace(/\s+$/, ''));
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond their position.
        <BlockView key={i} block={block} width={width} />
      ))}
    </Box>
  );
}

function BlockView({ block, width }: { block: Block; width?: number }) {
  const less = (n: number) => (width === undefined ? undefined : width - n);
  switch (block.kind) {
    case 'blank':
      return <Text> </Text>;
    case 'rule':
      return <Text dimColor>{'─'.repeat(40)}</Text>;
    case 'heading':
      // The title in the plain foreground, sections in the accent: a title underlined in color reads as a link.
      return (
        <Text bold color={block.level === 2 ? theme.accent : undefined}>
          {block.text.replace(/\*\*/g, '')}
        </Text>
      );
    case 'quote':
      return (
        <Box>
          <Text color={theme.muted}>│ </Text>
          <Box flexShrink={1}>
            <Inline text={block.text} width={less(2)} style={{ italic: true, dim: true }} />
          </Box>
        </Box>
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
              <Inline text={task ? (task[2] ?? '') : (list[3] ?? '')} width={less(indent.length + 2)} />
            </Box>
          </Box>
        );
      }
      return <Inline text={block.line} width={width} />;
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
