/**
 * The generic tile frame: border, focus glow, urgency pulse, header (icon/id, title, engine chip, status chip,
 * actions) and a body that hosts the tile kind's component. Tile authors only fill the body; they can add
 * header buttons with <TileActions>.
 */
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { commandTooltip } from '../app/commands';
import { useAcknowledged, useNow, useTileMeta, useUi } from '../app/hooks';
import { actions } from '../app/store';
import { Icon, type IconName } from '../chrome/icons';
import { EngineChip, StatusChipView } from '../chrome/ui';
import { tileDefinition } from '../tiles/registry';
import type { LayoutTile } from './tree';
import { type Column, focusTile, maximize, remove, toggleCollapsed } from './tree';
import type { TileKind, TileProps } from './types';

export const KIND_ICON: Record<TileKind, IconName> = {
  plan: 'list',
  dag: 'dag',
  session: 'session',
  review: 'eye',
  diff: 'diff',
  terminal: 'terminal',
  pr: 'pr',
  integration: 'merge',
  clarify: 'question',
};

const ActionsSlot = createContext<HTMLElement | null>(null);

/** Render header buttons for the current tile (portalled into the frame's header). */
export function TileActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

class TileErrorBoundary extends Component<{ kind: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[legion] ${this.props.kind} tile crashed`, error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="chip chip-bad">tile crashed</span>
        <p className="mono max-w-xs text-xs text-subtext0">{this.state.error.message}</p>
        <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}

function BodySkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 p-4" aria-hidden="true">
      {[78, 92, 64].map((w) => (
        <div key={w} className="h-2.5 rounded bg-surface0/60" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/**
 * Keyboard navigation (or closing an overlay) moved layout focus to this element: take DOM focus, unless
 * something inside already has it or focus lives outside the workspace (an overlay, the rail).
 */
export function useTakeFocus(ref: React.RefObject<HTMLElement | null>, focused: boolean): void {
  const focusRequest = useUi((s) => s.focusRequest);
  const handledRequest = useRef(-1);
  useEffect(() => {
    if (!focused || handledRequest.current === focusRequest) return;
    handledRequest.current = focusRequest;
    const el = ref.current;
    const active = document.activeElement;
    if (!el || el.contains(active)) return;
    if (!active || active === document.body || active.closest('[data-workspace]')) el.focus({ preventScroll: true });
  }, [focused, focusRequest, ref]);
}

export interface TileFrameProps {
  runId: string;
  tile: LayoutTile;
  column: Column | null;
  focused: boolean;
  /** On screen (off-screen tiles should pause expensive work). */
  visible: boolean;
  /** Dim when unfocused (Strip). */
  dimmable?: boolean;
  /** Header only (inactive tile in a stacked column). */
  collapsed?: boolean;
  /** Hide the built-in header actions (Overview/Focus stack). */
  compact?: boolean;
  /** Called when the header is clicked in compact/collapsed mode. */
  onActivate?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function TileFrame({
  runId,
  tile,
  column,
  focused,
  visible,
  dimmable = true,
  collapsed = false,
  compact = false,
  onActivate,
  className,
  style,
}: TileFrameProps) {
  const ref = useRef<HTMLElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const live = useUi((s) => s.layoutMode !== 'overview');
  const now = useNow(15_000, live && visible);
  const meta = useTileMeta(runId, tile, now);
  const urgentIds = meta.urgent.map((i) => i.id);
  const acknowledged = useAcknowledged(urgentIds);
  const urgent = urgentIds.length > 0;
  const maximized = useUi((s) => (column ? s.layouts[runId]?.maximized === column.id : false));

  useTakeFocus(ref, focused);

  const claimFocus = () => {
    if (!focused) actions.updateLayout(runId, (l) => focusTile(l, tile.id));
  };

  const def = tileDefinition(tile.kind);
  const Body = def.component as React.ComponentType<TileProps>;
  const props: TileProps = { tileId: tile.id, kind: tile.kind, runId, params: tile.params, focused, visible };

  return (
    <section
      ref={ref}
      className={`tile ${className ?? ''}`}
      style={style}
      tabIndex={-1}
      aria-label={meta.label ? `${meta.label} ${meta.title}` : meta.title}
      data-tile-id={tile.id}
      data-tile-kind={tile.kind}
      data-focused={focused}
      data-dim={dimmable && !focused && !urgent}
      data-urgent={urgent}
      data-pulse={urgent && !acknowledged}
      data-collapsed={collapsed}
      onPointerDownCapture={claimFocus}
      onFocusCapture={claimFocus}
    >
      <header className="tile-head">
        <button
          type="button"
          className="tile-head-title"
          onClick={onActivate}
          onDoubleClick={() => column && actions.updateLayout(runId, (l) => maximize(focusTile(l, tile.id)))}
          tabIndex={collapsed || onActivate ? 0 : -1}
          title={meta.note || undefined}
        >
          {meta.label ? (
            <span className="tile-id">{meta.label}</span>
          ) : (
            <Icon
              name={KIND_ICON[tile.kind]}
              className="flex-none"
              style={{
                color:
                  tile.kind === 'review' && meta.engine
                    ? `var(--${meta.engine.kind === 'codex' ? 'teal' : 'mauve'})`
                    : 'var(--subtext0)',
              }}
            />
          )}
          <span className="tile-title">{meta.title}</span>
        </button>
        {meta.engine && tile.kind !== 'review' ? (
          <EngineChip engine={meta.engine.kind} text={meta.engine.text} />
        ) : null}
        {meta.status ? <StatusChipView status={meta.status} /> : null}
        <div className="tile-actions" ref={setSlot}>
          {compact || !column ? null : (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={maximized ? 'Restore column width' : 'Maximize column'}
                title={commandTooltip('column.maximize', maximized ? 'Restore' : 'Maximize')}
                onClick={() => actions.updateLayout(runId, (l) => maximize(focusTile(l, tile.id)))}
              >
                <Icon name={maximized ? 'minimize' : 'maximize'} size={13} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Collapse column"
                title={commandTooltip('column.toggleCollapse', 'Collapse')}
                onClick={() => actions.updateLayout(runId, (l) => toggleCollapsed(l, column.id))}
              >
                <Icon name="collapse" size={13} />
              </button>
              {!tile.auto ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="Close tile"
                  title={commandTooltip('tile.close')}
                  onClick={() => actions.updateLayout(runId, (l) => remove(l, tile.id))}
                >
                  <Icon name="close" size={13} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </header>
      {collapsed ? null : (
        <div className="tile-body" data-tile-body>
          <ActionsSlot.Provider value={slot}>
            <TileErrorBoundary kind={tile.kind}>
              <Suspense fallback={<BodySkeleton />}>
                <Body {...props} />
              </Suspense>
            </TileErrorBoundary>
          </ActionsSlot.Provider>
        </div>
      )}
    </section>
  );
}
