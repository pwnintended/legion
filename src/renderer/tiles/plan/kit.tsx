/**
 * Small building blocks shared by the plan, DAG, review, diff, PR and integration tiles: segmented toggles,
 * an inline feedback composer, markdown, tile-scoped keys and "open a tile next to this one".
 */

import { RpcError } from '@shared/rpc-transport';
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Streamdown } from 'streamdown';
import { actions, uiStore } from '../../app/store';
import { Kbd } from '../../chrome/ui';
import { allocateId, allTiles, columnOfTile, type ExpandedWidth, insertColumn, makeColumn } from '../../layout/tree';
import type { TileDescriptor, TileKind, TileParamsByKind } from '../../layout/types';
import './tiles.css';

// ---------------------------------------------------------------------------------------------
// Segmented toggle
// ---------------------------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset className="lg-segs" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="lg-seg"
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Async actions
// ---------------------------------------------------------------------------------------------

export function errorText(error: unknown): string {
  if (error instanceof RpcError) {
    if (error.code === 'not_implemented') return 'Not available in this engine version yet.';
    return error.message || error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Run an async action once at a time, tracking pending state and the last error. */
export function useAction<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
): [(...args: A) => Promise<boolean>, { pending: boolean; error: string | null; clear: () => void }] {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await fnRef.current(...args);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return [run, { pending, error, clear }];
}

// ---------------------------------------------------------------------------------------------
// Auto-growing textarea + inline composer
// ---------------------------------------------------------------------------------------------

export function AutoTextarea({
  minRows = 2,
  maxRows = 12,
  value,
  ...rest
}: ComponentProps<'textarea'> & { minRows?: number; maxRows?: number; value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const line = 19;
    el.style.height = '0px';
    const h = Math.min(maxRows * line + 18, Math.max(minRows * line + 18, el.scrollHeight + 2));
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > h + 2 ? 'auto' : 'hidden';
  }, [value, minRows, maxRows]);
  return <textarea ref={ref} value={value} rows={minRows} {...rest} />;
}

/** A textarea with submit/cancel; ⌘⏎ submits, Esc cancels. */
export function InlineComposer({
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  initial = '',
  tone = 'primary',
  hint,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel: () => void;
  initial?: string;
  tone?: 'primary' | 'warn';
  hint?: ReactNode;
}) {
  const [text, setText] = useState(initial);
  const [submit, { pending, error }] = useAction(async () => {
    await onSubmit(text.trim());
  });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('textarea')?.focus();
  }, []);
  return (
    <div ref={ref} className="flex flex-col gap-2 lg-rise">
      <AutoTextarea
        className="lg-field w-full"
        placeholder={placeholder}
        value={text}
        minRows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            if (text.trim()) void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {error ? <div className="text-[12px] text-red">{error}</div> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`btn ${tone === 'warn' ? 'btn-warn' : 'btn-primary'}`}
          disabled={!text.trim() || pending}
          onClick={() => void submit()}
        >
          {pending ? 'Sending…' : submitLabel}
          <Kbd>⌘⏎</Kbd>
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        {hint ? <span className="faint ml-auto text-[11.5px]">{hint}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

function openLink(href: string | undefined) {
  if (!href || !/^https?:\/\//.test(href)) return;
  const bridge = (window as { legion?: { openExternal?: (url: string) => Promise<void> } }).legion;
  if (bridge?.openExternal) void bridge.openExternal(href);
  else window.open(href, '_blank', 'noopener');
}

type Extra = { node?: unknown };
const MD_COMPONENTS = {
  a: ({ href, children }: ComponentProps<'a'> & Extra) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openLink(href);
      }}
    >
      {children}
    </a>
  ),
  pre: ({ children }: ComponentProps<'pre'> & Extra) => <pre>{children}</pre>,
  code: ({ children, className }: ComponentProps<'code'> & Extra) => <code className={className}>{children}</code>,
  inlineCode: ({ children }: ComponentProps<'code'> & Extra) => <code>{children}</code>,
  table: ({ children }: ComponentProps<'table'> & Extra) => <table>{children}</table>,
  thead: ({ children }: ComponentProps<'thead'> & Extra) => <thead>{children}</thead>,
  tbody: ({ children }: ComponentProps<'tbody'> & Extra) => <tbody>{children}</tbody>,
  tr: ({ children }: ComponentProps<'tr'> & Extra) => <tr>{children}</tr>,
  th: ({ children }: ComponentProps<'th'> & Extra) => <th>{children}</th>,
  td: ({ children }: ComponentProps<'td'> & Extra) => <td>{children}</td>,
  h1: ({ children }: ComponentProps<'h1'> & Extra) => <h1>{children}</h1>,
  h2: ({ children }: ComponentProps<'h2'> & Extra) => <h2>{children}</h2>,
  h3: ({ children }: ComponentProps<'h3'> & Extra) => <h3>{children}</h3>,
  h4: ({ children }: ComponentProps<'h4'> & Extra) => <h4>{children}</h4>,
  p: ({ children }: ComponentProps<'p'> & Extra) => <p>{children}</p>,
  ul: ({ children }: ComponentProps<'ul'> & Extra) => <ul>{children}</ul>,
  ol: ({ children }: ComponentProps<'ol'> & Extra) => <ol>{children}</ol>,
  li: ({ children }: ComponentProps<'li'> & Extra) => <li>{children}</li>,
  strong: ({ children }: ComponentProps<'strong'> & Extra) => <strong>{children}</strong>,
  blockquote: ({ children }: ComponentProps<'blockquote'> & Extra) => <blockquote>{children}</blockquote>,
  hr: () => <hr />,
};

/** Rendered markdown in Legion's typography (static mode, no code-block chrome). */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`lg-md ${className ?? ''}`}>
      <Streamdown mode="static" controls={false} lineNumbers={false} components={MD_COMPONENTS}>
        {children}
      </Streamdown>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tile-scoped keys
// ---------------------------------------------------------------------------------------------

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * Plain-key shortcuts for one tile: the listener sits on the tile frame (which takes DOM focus on keyboard
 * navigation), so keys work whether focus is on the frame or inside the body. Keys typed into fields are
 * ignored. Return true from the handler to consume the event.
 */
export function useTileKeys(ref: RefObject<HTMLElement | null>, handler: (event: KeyboardEvent) => boolean): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const tile = ref.current?.closest<HTMLElement>('[data-tile-id], [data-code-tile]');
    if (!tile) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (handlerRef.current(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    tile.addEventListener('keydown', onKey);
    return () => tile.removeEventListener('keydown', onKey);
  }, [ref]);
}

// ---------------------------------------------------------------------------------------------
// Opening tiles
// ---------------------------------------------------------------------------------------------

function sameParams(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Focus the tile showing `kind`/`params` in the run's layout, or open it as a new column right of
 * `besideTileId` (or of the focused column).
 */
export function openTile<K extends TileKind>(
  runId: string,
  kind: K,
  params: TileParamsByKind[K],
  options: { besideTileId?: string | null; width?: ExpandedWidth } = {},
): void {
  const layout = uiStore.getState().layouts[runId];
  if (!layout) return;
  const existing = allTiles(layout).find(({ tile }) => tile.kind === kind && sameParams(tile.params, params));
  if (existing) {
    actions.revealTile(runId, existing.tile.id);
    return;
  }
  actions.updateLayout(
    runId,
    (ws) => {
      const [id, next] = allocateId(ws, kind);
      const tile: TileDescriptor<K> & { auto: false } = { id, kind, params, auto: false };
      const column = makeColumn({ id: `col:${id}`, width: options.width ?? '1/2', tiles: [tile as never] });
      const after =
        (options.besideTileId ? columnOfTile(ws, options.besideTileId)?.id : null) ?? ws.focus?.column ?? null;
      return insertColumn(next, column, after, true);
    },
    true,
  );
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

export function Check({ ok, size = 13 }: { ok: boolean | null; size?: number }) {
  if (ok === null)
    return <span className="dot live flex-none" style={{ color: 'var(--blue)', width: 7, height: 7, margin: 3 }} />;
  return ok ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="passed" className="flex-none">
      <path d="M20 6L9 17l-5-5" stroke="var(--green)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="failed" className="flex-none">
      <path d="M18 6L6 18M6 6l12 12" stroke="var(--red)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
