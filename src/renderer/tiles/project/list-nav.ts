/** Keyboard navigation for the project home's lists (activity, files, search). */
import { useEffect, useRef, useState } from 'react';

function isTyping(event: React.KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

/**
 * ↑/↓ (and j/k outside text fields) move through `count` rows, Home/End jump, ⏎ opens (⌘⏎ in a new column).
 * The active row is scrolled into view; rows carry `data-row={index}` inside the element `ref` points at.
 * `extraKeys` sees every key first and returns true when it handled it.
 */
export function useListNav(
  count: number,
  onOpen: (index: number, pinned: boolean) => void,
  extraKeys?: (event: React.KeyboardEvent, active: number) => boolean,
) {
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const clamped = count === 0 ? -1 : Math.min(active, count - 1);
  useEffect(() => {
    if (clamped < 0) return;
    ref.current?.querySelector<HTMLElement>(`[data-row="${clamped}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [clamped]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey) return;
    if (extraKeys?.(event, clamped)) return;
    const key = event.key;
    const move = (to: number) => {
      event.preventDefault();
      event.stopPropagation();
      if (count > 0) setActive(Math.max(0, Math.min(count - 1, to)));
    };
    if (key === 'Enter') {
      if (clamped < 0) return;
      event.preventDefault();
      event.stopPropagation();
      onOpen(clamped, event.metaKey || event.ctrlKey);
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    const typing = isTyping(event);
    if (key === 'ArrowDown' || (key === 'j' && !typing)) move(clamped + 1);
    else if (key === 'ArrowUp' || (key === 'k' && !typing)) move(clamped <= 0 ? 0 : clamped - 1);
    else if (key === 'Home' && !typing) move(0);
    else if (key === 'End' && !typing) move(count - 1);
    else if (key === 'PageDown') move(clamped + 10);
    else if (key === 'PageUp') move(clamped - 10);
  };
  return { active: clamped, setActive, ref, onKeyDown };
}
