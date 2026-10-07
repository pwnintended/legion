/**
 * Code viewer: one file of the project, read-only. Shiki highlighting (the diff tile's worker), line numbers,
 * virtualized rows (large files stay smooth), guards for binary / oversized / truncated files, image preview,
 * and a rendered preview for Markdown. Select lines (click / shift-click / drag the gutter, or select text) and
 * "Start a run about this…" (⌘⏎) opens the composer with this project and a `path:lines` reference.
 */
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type CommandContext, commandTooltip, registerCommands } from '../../app/commands';
import { codeReference, startRunAbout } from '../../app/project-actions';
import { Icon } from '../../chrome/icons';
import { Kbd } from '../../chrome/ui';
import { TileActions } from '../../layout/TileFrame';
import { focusedTile } from '../../layout/tree';
import type { TileProps } from '../../layout/types';
import { toast } from '../../overlays/nav';
import { highlighted, requestHighlight, type Tok, useHighlightVersion } from '../diff/highlight';
import { languageOf } from '../diff/model';
import { copyText, formatBytes, revealInFinder, SkeletonRows, useFile, useProject } from '../project/kit';
import { RepoMarkdown } from '../project/RepoMarkdown';

const LINE_H = 20;
const OVERSCAN = 40;
/** Files above these are shown without syntax colours (tokenizing them would stall the worker). */
const MAX_HIGHLIGHT_CHARS = 400_000;
const MAX_HIGHLIGHT_LINE = 2_000;

interface Selection {
  start: number;
  end: number;
}

/** Selections of code tiles by tile id (read by the ⌘⏎ command). */
const selections = new Map<string, { projectId: string; path: string; sel: Selection }>();

function focusedSelection(ctx: CommandContext) {
  if (ctx.ui.overlay || !ctx.layout || ctx.activeRunId !== null) return null;
  const tile = focusedTile(ctx.layout);
  return tile?.kind === 'code' ? (selections.get(tile.id) ?? null) : null;
}

registerCommands([
  {
    id: 'code.startRun',
    title: 'Start a run about the selected lines',
    category: 'Project',
    keybinding: 'Mod+Enter',
    // Above ⌘⏎ (Focus layout) while lines are selected in the focused code tile.
    priority: 10,
    hidden: true,
    inInput: false,
    when: (ctx) => focusedSelection(ctx) !== null,
    run: (ctx) => {
      const s = focusedSelection(ctx);
      if (s) startRunAbout(s.projectId, s.path, s.sel.start, s.sel.end);
    },
  },
]);

function normalize(a: number, b: number): Selection {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** A cheap content fingerprint for highlight cache keys. */
function fingerprint(text: string): string {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(text.length / 4096));
  for (let i = 0; i < text.length; i += step) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

function rangeLabel(sel: Selection): string {
  return sel.start === sel.end ? `L${sel.start}` : `L${sel.start}–${sel.end}`;
}

function lineOf(node: Node | null): number | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const line = el?.closest<HTMLElement>('[data-line]')?.dataset.line;
  return line ? Number(line) : null;
}

function Tokens({ toks, text }: { toks: Tok[] | null | undefined; text: string }) {
  if (!toks) return <>{text || ' '}</>;
  return (
    <>
      {toks.map((t, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: token order is stable
          key={i}
          style={t.c || t.i ? { color: t.c ?? undefined, fontStyle: t.i ? 'italic' : undefined } : undefined}
        >
          {t.t}
        </span>
      ))}
    </>
  );
}

function CodeView({
  tileId,
  projectId,
  path,
  text,
  reveal,
  revealNonce,
  focused,
}: {
  tileId: string;
  projectId: string;
  path: string;
  text: string;
  reveal: Selection | null;
  revealNonce: string;
  focused: boolean;
}) {
  const lines = useMemo(() => {
    const out = text.split('\n');
    if (out.length > 1 && out.at(-1) === '') out.pop();
    return out;
  }, [text]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [sel, setSel] = useState<Selection | null>(reveal);
  const anchor = useRef<number | null>(null);
  const dragging = useRef(false);

  // Highlighting (worker), skipped for huge or minified files.
  useHighlightVersion();
  const lang = languageOf(path);
  const key = `code|${projectId}|${path}|${fingerprint(text)}`;
  const highlightable =
    !!lang && text.length <= MAX_HIGHLIGHT_CHARS && lines.every((l) => l.length <= MAX_HIGHLIGHT_LINE);
  useEffect(() => {
    if (highlightable && lang) requestHighlight(key, lang, [text]);
  }, [highlightable, key, lang, text]);
  const tokens = highlightable ? highlighted(key)?.[0] : null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Reveal the requested lines (opening a search result, a ⌘P with :line, a reference).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when a new reveal is requested
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setSel(reveal);
    if (!reveal) {
      el.scrollTop = 0;
      return;
    }
    const target = (reveal.start - 1) * LINE_H - el.clientHeight / 3;
    el.scrollTop = Math.max(0, target);
  }, [revealNonce]);

  // Expose the selection to ⌘⏎.
  useEffect(() => {
    if (sel) selections.set(tileId, { projectId, path, sel });
    else selections.delete(tileId);
    return () => {
      selections.delete(tileId);
    };
  }, [tileId, projectId, path, sel]);

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const onGutterDown = (line: number, event: React.MouseEvent) => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (event.shiftKey && anchor.current !== null) setSel(normalize(anchor.current, line));
    else {
      anchor.current = line;
      setSel({ start: line, end: line });
    }
    dragging.current = true;
  };
  const onGutterEnter = (line: number) => {
    if (dragging.current && anchor.current !== null) setSel(normalize(anchor.current, line));
  };

  // Selecting text marks the lines it spans.
  const onTextMouseUp = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const a = lineOf(selection.anchorNode);
    const b = lineOf(selection.focusNode);
    if (a !== null && b !== null) {
      anchor.current = a;
      setSel(normalize(a, b));
    }
  };

  const total = lines.length;
  const first = Math.max(0, Math.floor(view.top / LINE_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((view.top + view.height) / LINE_H) + OVERSCAN);
  const digits = String(total).length;

  const copyReference = useCallback(async () => {
    if (!sel) return;
    try {
      await copyText(codeReference(path, sel.start, sel.end));
      toast('Reference copied.');
    } catch {
      toast("Couldn't copy the reference.", 'error');
    }
  }, [path, sel]);

  // The action bar floats above the first selected line (below the last when that's off the top).
  let barTop: number | null = null;
  if (sel) {
    const above = (sel.start - 1) * LINE_H - view.top - 38;
    const below = sel.end * LINE_H - view.top + 6;
    barTop = above >= 6 ? above : below <= view.height - 40 ? below : 8;
  }

  return (
    <div className="cv" style={{ '--cv-gutter': `${digits + 2}ch` } as CSSProperties}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: text selection maps to line selection */}
      <div
        ref={scrollRef}
        className="cv-scroll"
        data-tile-body-scroll
        onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
        onMouseUp={onTextMouseUp}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && sel) {
            event.stopPropagation();
            setSel(null);
          }
        }}
        data-testid="code-view"
      >
        <div className="cv-inner" style={{ height: total * LINE_H }}>
          <div className="cv-rows" style={{ transform: `translateY(${first * LINE_H}px)` }}>
            {lines.slice(first, last).map((line, i) => {
              const n = first + i + 1;
              const selected = sel !== null && n >= sel.start && n <= sel.end;
              return (
                <div key={n} className="cv-line" data-line={n} data-sel={selected || undefined}>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: line numbers select lines with the mouse */}
                  <span
                    className="cv-ln"
                    onMouseDown={(event) => onGutterDown(n, event)}
                    onMouseEnter={() => onGutterEnter(n)}
                  >
                    {n}
                  </span>
                  <span className="cv-tx">
                    <Tokens toks={tokens?.[n - 1]} text={line} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {sel && barTop !== null ? (
        <div className="cv-bar" style={{ top: barTop }} data-testid="code-selection-bar">
          <span className="cv-bar-range mono">{rangeLabel(sel)}</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => startRunAbout(projectId, path, sel.start, sel.end)}
            title={focused ? commandTooltip('code.startRun', 'Start a run about these lines') : undefined}
            data-testid="code-start-run"
          >
            <Icon name="spark" size={12} />
            Start a run about this…
            {focused ? <Kbd>⌘⏎</Kbd> : null}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Copy reference"
            title={`Copy ${codeReference(path, sel.start, sel.end)}`}
            onClick={() => void copyReference()}
          >
            <Icon name="link" size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Clear selection"
            title="Clear selection (esc)"
            onClick={() => setSel(null)}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ImageView({ mime, base64, size }: { mime: string; base64: string; size: number }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="cv-image" data-testid="code-image">
      <div className="cv-image-stage">
        <img
          src={`data:${mime};base64,${base64}`}
          alt=""
          onLoad={(event) => setDims({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
        />
      </div>
      <div className="cv-image-meta mono">
        {dims ? `${dims.w} × ${dims.h} · ` : ''}
        {formatBytes(size)} · {mime.replace('image/', '').replace('+xml', '')}
      </div>
    </div>
  );
}

function Notice({ icon, title, note }: { icon: 'file' | 'image' | 'alert'; title: string; note?: string }) {
  return (
    <div className="cv-notice">
      <span className="cv-notice-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="cv-notice-title">{title}</span>
      {note ? <span className="faint">{note}</span> : null}
    </div>
  );
}

export default function CodeTile({ tileId, params, focused }: TileProps<'code'>) {
  const { projectId, path } = params;
  const project = useProject(projectId);
  const file = useFile(projectId, path);
  const markdown = /\.(md|mdx|markdown)$/i.test(path);
  const [mode, setMode] = useState<'preview' | 'source'>(markdown && params.line === null ? 'preview' : 'source');
  const reveal = params.line ? normalize(params.line, params.endLine ?? params.line) : null;
  const revealNonce = `${path}:${params.line ?? ''}:${params.endLine ?? ''}`;

  // A new reveal (search hit, reference) shows the source.
  useEffect(() => {
    if (params.line !== null) setMode('source');
    else setMode(markdown ? 'preview' : 'source');
  }, [params.line, markdown]);

  const data = file.data?.path === path ? file.data : null;
  let body: React.ReactNode;
  if (!data) {
    body = file.error ? (
      <Notice icon="alert" title="Couldn't open this file" note={file.error} />
    ) : (
      <div className="p-4">
        <SkeletonRows rows={10} />
      </div>
    );
  } else if (data.kind === 'image' && data.image) {
    body = <ImageView mime={data.image.mime} base64={data.image.base64} size={data.size} />;
  } else if (data.kind === 'too_large') {
    body = <Notice icon="image" title="Image too large to preview" note={formatBytes(data.size)} />;
  } else if (data.kind === 'binary') {
    body = <Notice icon="file" title="Binary file" note={`${formatBytes(data.size)} · not shown`} />;
  } else if (markdown && mode === 'preview') {
    body = (
      <div className="cv-md" data-testid="code-markdown">
        <RepoMarkdown projectId={projectId} path={path} text={data.text ?? ''} />
      </div>
    );
  } else {
    body = (
      <CodeView
        tileId={tileId}
        projectId={projectId}
        path={path}
        text={data.text ?? ''}
        reveal={reveal}
        revealNonce={revealNonce}
        focused={focused}
      />
    );
  }

  return (
    <div className="cv-wrap" data-testid="code-tile" data-path={path}>
      <TileActions>
        {markdown && data?.kind === 'text' ? (
          <div className="segs cv-mode" role="radiogroup" aria-label="Markdown view">
            {(['preview', 'source'] as const).map((m) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className="seg"
                onClick={() => setMode(m)}
              >
                {mode === m ? <span className="seg-pill" /> : null}
                {m === 'preview' ? 'Preview' : 'Source'}
              </button>
            ))}
          </div>
        ) : null}
        {project ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Reveal in Finder"
            title="Reveal in Finder"
            onClick={() => revealInFinder(`${project.path}/${path}`)}
          >
            <Icon name="folderOpen" size={13} />
          </button>
        ) : null}
      </TileActions>
      <div className="cv-path mono" title={path}>
        {path.split('/').map((part, i, all) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: path segments
          <span key={i} className={i === all.length - 1 ? 'cv-path-name' : undefined}>
            {part}
            {i < all.length - 1 ? <span className="cv-path-sep">/</span> : null}
          </span>
        ))}
        {data?.kind === 'text' ? (
          <span className="cv-path-meta">
            {formatBytes(data.size)}
            {data.encoding && data.encoding !== 'utf-8' ? ` · ${data.encoding}` : ''}
          </span>
        ) : null}
      </div>
      <div className="cv-body">{body}</div>
      {data?.truncated ? (
        <div className="cv-truncated">
          <Icon name="alert" size={12} />
          Showing the first {formatBytes(new TextEncoder().encode(data.text ?? '').length)} of {formatBytes(data.size)}.
        </div>
      ) : null}
    </div>
  );
}
