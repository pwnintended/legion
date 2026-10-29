/**
 * Thumbnails of attached images, in a row: drawn with kitty placeholders where the terminal speaks kitty graphics
 * (see images.ts), a link to the file otherwise.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Box, Text, useStdout } from 'ink';
import type { Attachment } from './attachments.ts';
import { fitCells, hyperlink, kittyPlace, kittyPlaceholder } from './images.ts';
import { glyph, theme } from './theme.ts';

const THUMB_COLUMNS = 24;
const THUMB_ROWS = 6;

// Kitty image ids are the terminal's, shared with whatever else ran in it: start somewhere unlikely.
let nextId = 0x4c0000 + Math.floor(Math.random() * 0x10000);
const placed = new Map<string, number>();

/** The kitty image id of an attachment, sending it to the terminal the first time. */
function place(a: Attachment, cells: { columns: number; rows: number }, write: (s: string) => void): number {
  const known = placed.get(a.path);
  if (known !== undefined) return known;
  const id = nextId++;
  placed.set(a.path, id);
  try {
    write(kittyPlace(id, readFileSync(a.path), cells));
  } catch {
    // The file went away: the cells stay blank, the caption still says what it was.
  }
  return id;
}

export function thumbCells(a: Attachment): { columns: number; rows: number } {
  return fitCells(a, THUMB_COLUMNS, THUMB_ROWS);
}

export function Thumbnails(props: {
  attachments: readonly Attachment[];
  /** Draw them (kitty graphics); otherwise each is a link. */
  kitty: boolean;
}) {
  const { kitty, attachments } = props;
  // Ink's own stream, written to directly: the image takes no room, only its placeholder cells do.
  const { stdout } = useStdout();
  if (!kitty) {
    return (
      <Box flexWrap="wrap" columnGap={2}>
        {attachments.map((a) => (
          <Text key={a.path}>
            <Text color={theme.accent}>{glyph.image} </Text>
            <Text color={theme.info} underline>
              {hyperlink(pathToFileURL(a.path).href, `Image #${a.n}`)}
            </Text>
            <Text dimColor>
              {' '}
              {a.width}×{a.height}
            </Text>
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexWrap="wrap" columnGap={2}>
      {attachments.map((a) => {
        const cells = thumbCells(a);
        // The image goes to the terminal (once) ahead of the frame that first draws its cells.
        const id = place(a, cells, (s) => stdout.write(s));
        return (
          <Box key={a.path} flexDirection="column" flexShrink={0}>
            {kittyPlaceholder(id, cells).map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of one image, in order.
              <Text key={r}>{row}</Text>
            ))}
            <Text dimColor>
              {hyperlink(pathToFileURL(a.path).href, `Image #${a.n}`)} {a.width}×{a.height}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
