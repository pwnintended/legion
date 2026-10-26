/**
 * The prompt: a bordered, soft-wrapping input with history, word editing, bracketed paste, and a slash-command
 * menu (type `/`, arrows to pick, Tab to complete, Enter to run).
 */
import { Box, Text, useInput, usePaste } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { theme } from './theme.ts';

export interface CommandSpec {
  name: string;
  args: string;
  description: string;
}

export interface PromptInputProps {
  prompt: string;
  placeholder?: string;
  /** Border color: tells the user what Enter will do (talk, answer, write a note). */
  tone?: string;
  isActive: boolean;
  /** Replaces the text when `n` changes (a command put there for the user to finish). */
  seed?: { text: string; n: number } | null;
  commands?: readonly CommandSpec[];
  /** Hide what is typed (a secret answer); it is not kept in the history either. */
  mask?: boolean;
  onSubmit(value: string): void;
  /** A key pressed while the input is empty; return true to consume it (interaction hotkeys). */
  onEmptyKey?(input: string): boolean;
  /** Up/down while the input is empty; return true to consume it (picking a question's option). */
  onNavigate?(direction: -1 | 1): boolean;
  onEscape?(): void;
  onCtrlC?(): void;
  onTab?(): void;
}

const MENU_SIZE = 7;

export function matchCommands(commands: readonly CommandSpec[], value: string): CommandSpec[] {
  if (!value.startsWith('/') || /\s/.test(value)) return [];
  const typed = value.slice(1).toLowerCase();
  const starts = commands.filter((c) => c.name.startsWith(typed));
  const contains = commands.filter((c) => !c.name.startsWith(typed) && c.name.includes(typed));
  return [...starts, ...contains];
}

export function PromptInput(props: PromptInputProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const seedN = props.seed?.n;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new seed replaces the text.
  useEffect(() => {
    if (props.seed) {
      setValue(props.seed.text);
      setCursor(props.seed.text.length);
    }
  }, [seedN]);
  const menu = matchCommands(props.commands ?? [], value);
  const choice = menu[Math.min(selected, menu.length - 1)];

  const set = (next: string, at = next.length) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(at, next.length)));
    setSelected(0);
  };

  const submit = (text: string) => {
    if (text.trim() && !props.mask) history.current.push(text);
    historyIndex.current = null;
    set('');
    props.onSubmit(text);
  };

  usePaste(
    (text) => {
      const clean = text.replace(/\r\n?/g, '\n');
      set(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
    },
    { isActive: props.isActive },
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        if (value) set('');
        else props.onCtrlC?.();
        return;
      }
      if (key.escape) {
        if (value.startsWith('/') && menu.length > 0) set('');
        else props.onEscape?.();
        return;
      }
      if (key.tab) {
        if (choice) set(`/${choice.name}${choice.args ? ' ' : ''}`);
        else props.onTab?.();
        return;
      }
      if (key.return) {
        // Shift+Enter (reported by kitty-protocol terminals), Alt+Enter, or a trailing backslash: a new line.
        if (value.endsWith('\\')) return set(`${value.slice(0, -1)}\n`);
        if (key.shift || key.meta) return set(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1);
        // Enter on a partly typed command runs the highlighted one, or completes it if it takes arguments.
        if (choice && value !== `/${choice.name}`) {
          if (choice.args && !choice.args.startsWith('[')) return set(`/${choice.name} `);
          return submit(`/${choice.name}`);
        }
        return submit(value);
      }
      if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? -1 : 1;
        if (menu.length > 0) {
          setSelected((n) => (Math.min(n, menu.length - 1) + dir + menu.length) % menu.length);
          return;
        }
        if (!value && props.onNavigate?.(dir)) return;
        const h = history.current;
        if (h.length === 0) return;
        let i = historyIndex.current ?? h.length;
        i = dir < 0 ? Math.max(0, i - 1) : Math.min(h.length, i + 1);
        historyIndex.current = i;
        const next = h[i] ?? '';
        setValue(next);
        setCursor(next.length);
        return;
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.home || (key.ctrl && input === 'a')) return setCursor(0);
      if (key.end || (key.ctrl && input === 'e')) return setCursor(value.length);
      if (key.ctrl && input === 'u') return set(value.slice(cursor), 0);
      if (key.ctrl && input === 'k') return set(value.slice(0, cursor), cursor);
      if (key.ctrl && input === 'w') {
        const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
        return set(before + value.slice(cursor), before.length);
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.ctrl || key.meta || !input) return;
      if (!value && props.onEmptyKey?.(input)) return;
      set(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
    },
    { isActive: props.isActive },
  );

  const shown = props.mask ? '•'.repeat(value.length) : value;
  const before = shown.slice(0, cursor);
  const at = shown[cursor] ?? ' ';
  const after = shown.slice(cursor + 1);
  const first = Math.max(0, Math.min(selected - MENU_SIZE + 1, menu.length - MENU_SIZE));
  const width = Math.max(...menu.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0)), 0) + 2;
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={props.tone ?? theme.muted} paddingX={1}>
        <Text color={props.tone ?? theme.accent} bold>
          {props.prompt}{' '}
        </Text>
        <Box flexShrink={1}>
          {value ? (
            <Text>
              {before}
              <Text inverse>{at === '\n' ? ' ' : at}</Text>
              {at === '\n' ? '\n' : ''}
              {after}
            </Text>
          ) : (
            <Text>
              <Text inverse> </Text>
              <Text dimColor>{props.placeholder ?? ''}</Text>
            </Text>
          )}
        </Box>
      </Box>
      {menu.length > 0 ? (
        <Box flexDirection="column" paddingX={2}>
          {menu.slice(first, first + MENU_SIZE).map((c) => {
            const on = c === choice;
            const label = `/${c.name}${c.args ? ` ${c.args}` : ''}`;
            return (
              <Text key={c.name}>
                <Text color={on ? theme.accent : undefined} bold={on}>
                  {on ? '❯ ' : '  '}
                  {label.padEnd(width)}
                </Text>
                <Text dimColor={!on}>{c.description}</Text>
              </Text>
            );
          })}
          {menu.length > MENU_SIZE ? <Text dimColor>{`  ${menu.length} commands · ↑↓ to see more`}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
