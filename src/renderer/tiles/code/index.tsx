/**
 * A file of a checkout: text in the editor (editor/Editor.tsx: editable, ⌘S saves, read-only while an agent works
 * in the checkout or when the file is truncated or not UTF-8), images previewed, Markdown rendered (with its
 * source in the editor), binary and oversized files named. Selecting lines offers "Start a run about this…" (⌘⏎):
 * the composer with this project and a `path:lines` reference.
 */
import { useCallback, useEffect, useState } from 'react';
import { type CommandContext, commandTooltip, registerCommands } from '../../app/commands';
import { codeReference, startRunAbout } from '../../app/project-actions';
import { Icon } from '../../chrome/icons';
import { Kbd } from '../../chrome/ui';
import { onScreen } from '../../code/actions';
import { useCheckoutReadOnly } from '../../code/hooks';
import { TileActions } from '../../layout/TileFrame';
import type { TileProps } from '../../layout/types';
import { toast } from '../../overlays/nav';
import { copyText, formatBytes, revealInFinder, SkeletonRows, useFile, useProject } from '../project/kit';
import { RepoMarkdown } from '../project/RepoMarkdown';
import { keepMine, reloadBuffer, saveBuffer, useBuffer } from './editor/buffers';
import { Editor, type LineRange } from './editor/Editor';

/** Selections of code tabs by tab id (read by the ⌘⏎ command). */
const selections = new Map<string, { projectId: string; path: string; sel: LineRange }>();

/** The tab on show in the focused viewer, if it is a file. */
function focusedTab(ctx: CommandContext): string | null {
  if (ctx.ui.overlay) return null;
  const ws = onScreen()?.ws;
  const tile = ws?.focus ? ws.tiles[ws.focus] : undefined;
  if (tile?.kind !== 'viewer' || !tile.active) return null;
  return tile.tabs.find((t) => t.id === tile.active)?.kind === 'code' ? tile.active : null;
}

registerCommands([
  {
    id: 'code.startRun',
    title: 'Start a run about the selected lines',
    category: 'Project',
    keybinding: 'Mod+Enter',
    // Above ⌘⏎ (keep the preview tab) while lines are selected in the viewer's file.
    priority: 10,
    hidden: true,
    when: (ctx) => {
      const tab = focusedTab(ctx);
      return tab !== null && selections.has(tab);
    },
    run: (ctx) => {
      const tab = focusedTab(ctx);
      const s = tab ? selections.get(tab) : undefined;
      if (s) startRunAbout(s.projectId, s.path, s.sel.start, s.sel.end);
    },
  },
  {
    id: 'code.save',
    title: 'Save the file',
    category: 'Tile',
    keybinding: 'Mod+S',
    priority: 1,
    // vim has no Ctrl+S of its own: saving keeps working in vim mode off macOS.
    overControlKeys: true,
    when: (ctx) => focusedTab(ctx) !== null,
    run: (ctx) => {
      const tab = focusedTab(ctx);
      if (tab) return saveBuffer(tab);
    },
  },
]);

/** How often a preview on screen (an image, rendered Markdown) is read again: agents may be writing it. */
const PREVIEW_MS = 2500;

function normalize(a: number, b: number): LineRange {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

function rangeLabel(sel: LineRange): string {
  return sel.start === sel.end ? `L${sel.start}` : `L${sel.start}–${sel.end}`;
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

/** What the file's editing state is, in its path bar: unsaved, saving, read-only and why. */
function EditState({ tabId, readOnly }: { tabId: string; readOnly: string | null }) {
  const state = useBuffer(tabId, (m) => (m ? (m.saving ? 'saving' : m.dirty ? 'dirty' : 'clean') : null));
  if (readOnly)
    return (
      <span className="cv-state" data-state="locked">
        {readOnly}
      </span>
    );
  if (state === 'saving') return <span className="cv-state">Saving…</span>;
  if (state === 'dirty')
    return (
      <span className="cv-state" data-state="dirty" title={commandTooltip('code.save', 'Save')}>
        Unsaved
      </span>
    );
  return null;
}

/** The file changed on disk under unsaved edits: take what is there, or keep yours (saving over it). */
function ConflictBar({ tabId, path }: { tabId: string; path: string }) {
  const conflict = useBuffer(tabId, (m) => m?.conflict ?? false);
  if (!conflict) return null;
  return (
    <div className="cv-conflict" role="alert" data-testid="code-conflict">
      <Icon name="alert" size={13} />
      <span className="cv-conflict-text">
        <span className="mono">{path}</span> changed on disk while you were editing it.
      </span>
      <button type="button" className="btn btn-sm" onClick={() => void reloadBuffer(tabId)}>
        Take theirs
      </button>
      <button type="button" className="btn btn-sm btn-warn" onClick={() => keepMine(tabId)}>
        Keep mine and save
      </button>
    </div>
  );
}

function SelectionBar({
  projectId,
  path,
  sel,
  focused,
}: {
  projectId: string;
  path: string;
  sel: LineRange;
  focused: boolean;
}) {
  const copyReference = useCallback(async () => {
    try {
      await copyText(codeReference(path, sel.start, sel.end));
      toast('Reference copied.');
    } catch {
      toast("Couldn't copy the reference.", 'error');
    }
  }, [path, sel]);
  return (
    <div className="cv-bar" data-testid="code-selection-bar">
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
        {focused ? <Kbd chord="Mod+Enter" /> : null}
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
    </div>
  );
}

export default function CodeTile({ tileId, params, focused, visible }: TileProps<'code'>) {
  const { projectId, path } = params;
  const checkout = params.checkout ?? null;
  const project = useProject(projectId);
  const file = useFile(projectId, path, checkout);
  const markdown = /\.(md|mdx|markdown)$/i.test(path);
  const [mode, setMode] = useState<'preview' | 'source'>(markdown && params.line === null ? 'preview' : 'source');
  const reveal = params.line ? normalize(params.line, params.endLine ?? params.line) : null;
  const revealNonce = `${path}:${params.line ?? ''}:${params.endLine ?? ''}`;
  const [sel, setSel] = useState<LineRange | null>(null);
  const workspaceLocked = useCheckoutReadOnly(projectId, checkout);

  // A new reveal (search hit, reference) shows the source.
  useEffect(() => {
    if (params.line !== null) setMode('source');
    else setMode(markdown ? 'preview' : 'source');
  }, [params.line, markdown]);

  // Expose the selection to ⌘⏎.
  useEffect(() => {
    if (sel) selections.set(tileId, { projectId, path, sel });
    else selections.delete(tileId);
    return () => {
      selections.delete(tileId);
    };
  }, [tileId, projectId, path, sel]);

  const { refresh } = file;
  const data = file.data?.path === path ? file.data : null;
  const editing = data?.kind === 'text' && !(markdown && mode === 'preview');
  // The editor watches its own file; a preview (image, rendered Markdown) is read again now and then instead.
  useEffect(() => {
    if (!visible || editing) return;
    const timer = setInterval(refresh, PREVIEW_MS);
    return () => clearInterval(timer);
  }, [visible, editing, refresh]);

  const readOnly = !data
    ? null
    : data.truncated
      ? 'Read-only: too large to edit here'
      : data.encoding && data.encoding !== 'utf-8'
        ? `Read-only: ${data.encoding}`
        : !data.version
          ? 'Read-only'
          : workspaceLocked
            ? 'Read-only while its agent works here'
            : null;

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
        <RepoMarkdown projectId={projectId} checkout={checkout} path={path} text={data.text ?? ''} />
      </div>
    );
  } else {
    body = (
      <Editor
        tabId={tileId}
        projectId={projectId}
        checkout={checkout}
        path={path}
        text={data.text ?? ''}
        version={data.version ?? ''}
        readOnly={readOnly !== null}
        reveal={reveal}
        revealNonce={revealNonce}
        visible={visible}
        onSelection={setSel}
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
            onClick={() => revealInFinder(`${checkout ?? project.path}/${path}`)}
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
        {editing ? <EditState tabId={tileId} readOnly={readOnly} /> : null}
        {data?.kind === 'text' ? (
          <span className="cv-path-meta">
            {formatBytes(data.size)}
            {data.encoding && data.encoding !== 'utf-8' ? ` · ${data.encoding}` : ''}
          </span>
        ) : null}
      </div>
      {editing ? <ConflictBar tabId={tileId} path={path} /> : null}
      <div className="cv-body">{body}</div>
      {editing && sel ? <SelectionBar projectId={projectId} path={path} sel={sel} focused={focused} /> : null}
      {data?.truncated ? (
        <div className="cv-truncated">
          <Icon name="alert" size={12} />
          Showing the first {formatBytes(new TextEncoder().encode(data.text ?? '').length)} of {formatBytes(data.size)}.
        </div>
      ) : null}
    </div>
  );
}
