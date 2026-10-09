/**
 * The shortcuts sheet (? when nothing is being typed, ⌘? anywhere; the status bar's "? keys"): every key Legion
 * answers to, the view on screen first, then Everywhere, then the other views (dimmed until searched). Typing
 * filters; pressing a chord looks it up instead of running it ("what does ⌥L do here?") and shows every place it
 * means something. Esc clears a search, then closes; ? closes from an empty search.
 */
import { motion } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { listCommands } from '../app/commands';
import { useUi } from '../app/hooks';
import {
  buildKeyRows,
  filterRows,
  type KeyRow,
  type KeyScope,
  rowAvailable,
  rowsForKey,
  SCOPE_LABEL,
  scopeOrder,
} from '../app/key-reference';
import { formatChord, formatEvent, matchesChord } from '../app/keys';
import { useReducedMotionPref } from '../app/prefs';
import { actions, dataStore, uiStore } from '../app/store';
import { Icon } from '../chrome/icons';
import { Kbd } from '../chrome/ui';
import { SPRING } from '../theme/motion';
import { OverlayPanel } from './Shell';

/** A pressed chord and the rows it runs. */
interface Lookup {
  label: string;
  event: KeyboardEvent;
  ids: Set<string>;
}

/** Text-editing chords: with something typed, an unbound one edits the search instead of being looked up. */
const EDITING = new Set([
  'A',
  'C',
  'V',
  'X',
  'Z',
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock']);

export function KeysOverlay() {
  const view = useUi((s) => s.view);
  const reduced = useReducedMotionPref();
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const here: KeyScope = view;
  // What can run is judged as of opening, behind the sheet (the sheet itself would make most of it unavailable).
  const { rows, available } = useMemo(() => {
    const commands = listCommands();
    const rows = buildKeyRows(commands);
    const ui = uiStore.getState();
    const ctx = {
      ui: { ...ui, overlay: null },
      data: dataStore.getState(),
      activeRunId: ui.activeRunId,
      layout: ui.activeRunId && ui.view === 'agents' ? (ui.layouts[ui.activeRunId] ?? null) : null,
    };
    const byId = new Map(commands.map((c) => [c.id, c]));
    return { rows, available: new Set(rows.filter((r) => rowAvailable(r, ctx, byId)).map((r) => r.id)) };
  }, []);

  const shown = lookup ? rows.filter((r) => lookup.ids.has(r.id)) : filterRows(rows, query);
  const browsing = !lookup && query.trim() === '';
  const groups = scopeOrder(here)
    .map((scope) => [scope, shown.filter((r) => r.scope === scope)] as const)
    .filter(([, list]) => list.length > 0);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const native = event.nativeEvent;
    if (native.isComposing || MODIFIER_KEYS.has(event.key)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (lookup || query) {
        setLookup(null);
        setQuery('');
      } else actions.closeOverlay();
      return;
    }
    const chord = event.metaKey || event.ctrlKey || event.altKey;
    if (!chord) {
      if (event.key === '?' && !lookup && query === '') {
        event.preventDefault();
        actions.closeOverlay();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        list.current?.scrollBy({ top: event.key === 'ArrowDown' ? 90 : -90, behavior: reduced ? 'auto' : 'smooth' });
      } else if (lookup && (event.key === 'Backspace' || event.key.length === 1)) setLookup(null);
      return;
    }
    const hits = rowsForKey(rows, native);
    const editing = query !== '' && EDITING.has(event.key.length === 1 ? event.key.toUpperCase() : event.key);
    if (hits.length === 0 && (editing || ['C', 'V', 'X', 'Z'].includes(event.code.replace(/^Key/, '')))) return;
    event.preventDefault();
    setQuery('');
    setLookup({ label: formatEvent(native), event: native, ids: new Set(hits.map((r) => r.id)) });
    list.current?.scrollTo({ top: 0 });
  };

  return (
    <OverlayPanel
      label="Keyboard shortcuts"
      placement="center"
      width="min(880px, 100%)"
      top={64}
      testId="keys"
      onKeyDown={onKeyDown}
    >
      <div className="keys-search">
        <Icon name="search" size={16} className="keys-search-icon" />
        {lookup ? (
          <motion.span
            key={lookup.label}
            className="keys-token"
            data-testid="keys-token"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.86 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={reduced ? { duration: 0.1 } : SPRING}
          >
            {lookup.label}
          </motion.span>
        ) : null}
        <input
          className="keys-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={lookup ? '' : 'Search, or press a shortcut to see what it does'}
          aria-label="Search shortcuts"
          spellCheck={false}
          data-autofocus
        />
      </div>

      <div className="keys-list" ref={list} data-testid="keys-list">
        {groups.map(([scope, scoped]) => (
          <section
            key={scope}
            className="keys-group"
            data-dim={browsing && scope !== here && scope !== 'global' ? 'true' : undefined}
            aria-labelledby={`keys-${scope}`}
          >
            <h3 className="keys-head" id={`keys-${scope}`}>
              <span className="sec">{SCOPE_LABEL[scope]}</span>
              {scope === here ? <span className="keys-here">you're here</span> : null}
            </h3>
            <ul className="keys-rows">
              {scoped.map((row) => (
                <Row key={row.id} row={row} off={!available.has(row.id)} lookup={lookup} />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="keys-empty">
            {lookup ? (
              <>
                <span className="kbd">{lookup.label}</span> isn’t bound to anything in Legion.
              </>
            ) : (
              <>No key for “{query.trim()}”. Try a word from what it does, like “split” or “approve”.</>
            )}
          </p>
        ) : null}
      </div>

      <div className="ovl-foot">
        <span>Type to search</span>
        <span>Press a shortcut to look it up</span>
        <span className="ovl-keys">
          <Kbd>?</Kbd> or <Kbd chord="Escape" /> close
        </span>
      </div>
    </OverlayPanel>
  );
}

function Row({ row, off, lookup }: { row: KeyRow; off: boolean; lookup: Lookup | null }) {
  // Which cap the pressed chord is: caps line up with chords one to one, or a family's single cap holds them all.
  let hit = -1;
  if (lookup) {
    const index = row.chords.findIndex((c) => matchesChord(c, lookup.event));
    hit = row.caps.length === row.chords.length ? index : row.caps.length === 1 && index >= 0 ? 0 : -1;
  }
  return (
    <li
      className="keys-row"
      data-off={off ? 'true' : undefined}
      title={off ? `${row.title} (not available right now)` : row.title}
    >
      <span className="keys-title">{row.title}</span>
      {row.where ? <span className="keys-where">{row.where}</span> : null}
      <span className="keys-caps">
        {row.caps.map((cap, i) => (
          <span key={cap} className="kbd keys-cap" data-hit={i === hit ? 'true' : undefined}>
            {cap}
          </span>
        ))}
      </span>
    </li>
  );
}

/** The key that opens the sheet from where focus is: `?`, or `⌘?` while typing (a field, the editor, a terminal). */
export function keysChord(typing: boolean): string {
  return typing ? formatChord('Mod+Shift+?') : formatChord('Shift+?');
}
