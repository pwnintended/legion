/** A one-line (soft-wrapping) prompt input with history, word editing and bracketed paste. */
import { Box, Text, useInput, usePaste } from 'ink';
import { useRef, useState } from 'react';

export interface PromptInputProps {
  prompt: string;
  placeholder?: string;
  isActive: boolean;
  onSubmit(value: string): void;
  /** A key pressed while the input is empty; return true to consume it (interaction hotkeys). */
  onEmptyKey?(input: string): boolean;
  onEscape?(): void;
  onCtrlC?(): void;
  onTab?(): void;
}

export function PromptInput(props: PromptInputProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);

  const set = (next: string, at = next.length) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(at, next.length)));
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
        props.onEscape?.();
        return;
      }
      if (key.tab) {
        props.onTab?.();
        return;
      }
      if (key.return) {
        // A trailing backslash continues on a new line.
        if (value.endsWith('\\')) {
          set(`${value.slice(0, -1)}\n`);
          return;
        }
        if (value.trim()) history.current.push(value);
        historyIndex.current = null;
        const submitted = value;
        set('');
        props.onSubmit(submitted);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const h = history.current;
        if (h.length === 0) return;
        let i = historyIndex.current ?? h.length;
        i = key.upArrow ? Math.max(0, i - 1) : Math.min(h.length, i + 1);
        historyIndex.current = i;
        set(h[i] ?? '');
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

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return (
    <Box>
      <Text color="cyan">{props.prompt} </Text>
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
  );
}
