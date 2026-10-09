/**
 * The keyboard reference behind the shortcuts sheet (? / ⌘?): every key Legion answers to, grouped by where it
 * works. Built from the command registry, so a new binding shows up by itself, plus `LOCAL_KEYS`: keys a tile or
 * field handles on its own (the composer's ⏎, the diff's j/k, the editor's ⌘/) that the registry never sees.
 * Adding a key outside the registry? Add it to `LOCAL_KEYS` too.
 *
 * Commands that differ only in direction or number (⌥H/J/K/L focus, ⌘1–9) fold into one row, `FAMILIES`.
 */
import { type Command, type CommandContext, isEnabled, listCommands } from './commands';
import { type Chord, formatChord, formatModifiers, IS_MAC, type KeyEventLike, matchesChord, parseChord } from './keys';

export type KeyScope = 'chat' | 'agents' | 'code' | 'global';

export const SCOPE_LABEL: Record<KeyScope, string> = {
  chat: 'Chat',
  agents: 'Agents',
  code: 'Code',
  global: 'Everywhere',
};

export interface KeyRow {
  id: string;
  title: string;
  scope: KeyScope;
  /** Where inside the scope, when narrower than the whole view: `editor`, `diff`, `terminal`, `reply`. */
  where: string | null;
  /** Key caps to show, formatted for this platform (`⌥HJKL`, `⌘1–9`). */
  caps: string[];
  /** Every chord that runs it, alternates included: what press-to-find matches. */
  chords: Chord[];
  /** The registry commands behind the row (none for local keys). */
  commandIds: string[];
}

/** Which view a command belongs to, by id. First match wins. */
const SCOPES: [prefix: string, scope: KeyScope][] = [
  ['view.agents.leave', 'agents'],
  ['view.agents', 'chat'],
  ['board.', 'chat'],
  ['map.', 'agents'],
  ['plan.', 'agents'],
  ['review.', 'agents'],
  ['approval.', 'agents'],
  ['escalation.', 'agents'],
  ['code.', 'code'],
  ['tile.newTerminal', 'code'],
];

export function scopeOf(commandId: string): KeyScope {
  return SCOPES.find(([prefix]) => commandId.startsWith(prefix))?.[1] ?? 'global';
}

/** Commands shown as one row. Members in key order: left, down, up, right reads H J K L. */
const DIRECTIONS = ['left', 'down', 'up', 'right'];
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const FAMILIES: { id: string; title: string; members: string[] }[] = [
  {
    id: 'board.focus',
    title: 'Focus the tile left, below, above or right',
    members: DIRECTIONS.map((d) => `board.focus.${d}`),
  },
  {
    id: 'code.focus',
    title: 'Focus the tile left, below, above or right',
    members: DIRECTIONS.map((d) => `code.focus.${d}`),
  },
  { id: 'code.move', title: 'Move the tile', members: DIRECTIONS.map((d) => `code.move.${d}`) },
  { id: 'code.resize', title: 'Resize the tile', members: DIRECTIONS.map((d) => `code.resize.${d}`) },
  { id: 'map.station', title: 'Next / previous station', members: ['map.next', 'map.prev'] },
  { id: 'map.tab', title: 'Previous / next tab of the station', members: ['map.tabPrev', 'map.tabNext'] },
  { id: 'code.tab', title: 'Previous / next tab', members: ['code.tab.previous', 'code.tab.next'] },
  {
    id: 'code.workspace.step',
    title: 'Next / previous workspace',
    members: ['code.workspace.next', 'code.workspace.previous'],
  },
  { id: 'workspace', title: 'Go to a run by its place in the rail', members: DIGITS.map((n) => `workspace.${n}`) },
  { id: 'code.workspace', title: 'Go to a workspace by its place', members: DIGITS.map((n) => `code.workspace.${n}`) },
];

/** Bindings that are not a key of their own: Esc closing an overlay is said once, by the sheet's own footer. */
const SKIP = new Set(['overlay.close']);

/** Clearer names for rows whose registry title is written for the palette. */
const TITLES: Record<string, string> = {
  'help.keys': 'Keyboard shortcuts (this sheet)',
  'board.monocle.exit': 'Leave monocle: tile the board again',
  'code.fullscreen.exit': 'Tile again after showing one alone',
  'code.newWorkspace': 'New workspace on the project or a run’s worktree',
};

interface LocalKey {
  id: string;
  title: string;
  scope: KeyScope;
  where: string;
  keys: string[];
}

/** Keys handled by a tile or field itself, outside the registry. Same binding syntax as commands. */
export function localKeys(mac = IS_MAC): LocalKey[] {
  return [
    { id: 'reply.send', title: 'Send your reply', scope: 'chat', where: 'reply', keys: ['Enter'] },
    { id: 'reply.newline', title: 'New line', scope: 'chat', where: 'reply', keys: ['Shift+Enter'] },
    {
      id: 'reply.now',
      title: 'Interrupt the assistant and send now',
      scope: 'chat',
      where: 'reply',
      keys: ['Mod+Enter'],
    },
    { id: 'reply.attach', title: 'Attach files', scope: 'chat', where: 'reply', keys: ['Mod+Shift+A'] },
    { id: 'dag.edit', title: 'Edit the selected task', scope: 'agents', where: 'plan', keys: ['E'] },
    { id: 'dag.remove', title: 'Remove the selected task', scope: 'agents', where: 'plan', keys: ['Backspace'] },
    { id: 'diff.hunk', title: 'Next / previous hunk', scope: 'code', where: 'diff', keys: ['J', 'K'] },
    { id: 'diff.finding', title: 'Next / previous finding', scope: 'code', where: 'diff', keys: ['N', 'Shift+N'] },
    { id: 'diff.file', title: 'Next / previous file', scope: 'code', where: 'diff', keys: [']', '['] },
    { id: 'diff.fold', title: 'Fold the file', scope: 'code', where: 'diff', keys: ['X'] },
    { id: 'diff.comment', title: 'Comment on the hunk', scope: 'code', where: 'diff', keys: ['C'] },
    { id: 'editor.find', title: 'Find and replace', scope: 'code', where: 'editor', keys: ['Mod+F'] },
    { id: 'editor.next', title: 'Select the next occurrence', scope: 'code', where: 'editor', keys: ['Mod+D'] },
    { id: 'editor.comment', title: 'Comment the lines out', scope: 'code', where: 'editor', keys: ['Mod+/'] },
    {
      id: 'terminal.copy',
      title: 'Copy the selection',
      scope: 'code',
      where: 'terminal',
      keys: [mac ? 'Mod+C' : 'Mod+Shift+C'],
    },
  ];
}

function bindingsOf(command: Command): string[] {
  if (!command.keybinding) return [];
  return typeof command.keybinding === 'string' ? [command.keybinding] : [...command.keybinding];
}

/**
 * One cap for a family: `⌥` + `HJKL` when the members share modifiers and are letters (four read as a word, two
 * as `J/K`), `⌘1–9` for digits, else a cap per member.
 */
function familyCaps(firsts: string[], mac: boolean): string[] {
  const chords = firsts.map(parseChord);
  const [head] = chords;
  const same =
    head !== undefined &&
    chords.every((c) => c.mod === head.mod && c.alt === head.alt && c.shift === head.shift && c.ctrl === head.ctrl);
  const keys = chords.map((c) => c.key);
  if (!same || !keys.every((k) => /^[A-Z0-9]$/.test(k))) return firsts.map((b) => formatChord(b, mac));
  const modifiers = firsts[0]?.split('+').slice(0, -1).join('+') ?? '';
  const prefix = modifiers ? formatModifiers(modifiers, mac) : '';
  if (keys.every((k) => /[0-9]/.test(k))) return [`${prefix}${keys[0]}–${keys.at(-1)}`];
  return [`${prefix}${keys.join(keys.length > 2 ? '' : '/')}`];
}

/** Every key, in registry order within its scope (a family where its first member is), local keys last. */
export function buildKeyRows(commands: readonly Command[] = listCommands(), mac = IS_MAC): KeyRow[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const familyOf = new Map<string, (typeof FAMILIES)[number]>();
  for (const family of FAMILIES) for (const member of family.members) familyOf.set(member, family);

  const rows: KeyRow[] = [];
  const done = new Set<string>();
  for (const command of commands) {
    const bindings = bindingsOf(command);
    if (bindings.length === 0 || SKIP.has(command.id) || done.has(command.id)) continue;
    const family = familyOf.get(command.id);
    if (family) {
      const members = family.members
        .map((id) => byId.get(id))
        .filter((c): c is Command => !!c && bindingsOf(c).length > 0);
      for (const member of members) done.add(member.id);
      rows.push({
        id: family.id,
        title: family.title,
        scope: scopeOf(command.id),
        where: null,
        caps: familyCaps(
          members.map((m) => bindingsOf(m)[0] as string),
          mac,
        ),
        chords: members.flatMap((m) => bindingsOf(m).map(parseChord)),
        commandIds: members.map((m) => m.id),
      });
      continue;
    }
    done.add(command.id);
    rows.push({
      id: command.id,
      title: TITLES[command.id] ?? command.title.replace(/…$/, ''),
      scope: scopeOf(command.id),
      where: null,
      caps: bindings.map((b) => formatChord(b, mac)),
      chords: bindings.map(parseChord),
      commandIds: [command.id],
    });
  }
  for (const local of localKeys(mac))
    rows.push({
      id: `local.${local.id}`,
      title: local.title,
      scope: local.scope,
      where: local.where,
      caps:
        local.keys.length === 2 && local.keys.every((k) => k.length === 1)
          ? [local.keys.join('/')]
          : local.keys.map((k) => formatChord(k, mac)),
      chords: local.keys.map(parseChord),
      commandIds: [],
    });
  return rows;
}

/** Scopes in sheet order: the view on screen first, then Everywhere, then the other views. */
export function scopeOrder(here: KeyScope): KeyScope[] {
  const views: KeyScope[] = ['chat', 'agents', 'code'];
  return [here, ...(here === 'global' ? [] : ['global' as const]), ...views.filter((v) => v !== here)];
}

/** Rows whose words (title, where, scope, caps) contain every word of the query. */
export function filterRows(rows: readonly KeyRow[], query: string): KeyRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = [row.title, row.where ?? '', SCOPE_LABEL[row.scope], ...row.caps].join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** Rows a pressed chord runs (press-to-find). */
export function rowsForKey(rows: readonly KeyRow[], event: KeyEventLike, mac = IS_MAC): KeyRow[] {
  return rows.filter((row) => row.chords.some((chord) => matchesChord(chord, event, mac)));
}

/** Can the row's command run right now? Local keys are always listed as available. */
export function rowAvailable(row: KeyRow, ctx: CommandContext, commands: ReadonlyMap<string, Command>): boolean {
  if (row.commandIds.length === 0) return true;
  return row.commandIds.some((id) => {
    const command = commands.get(id);
    return command ? isEnabled(command, ctx) : false;
  });
}
