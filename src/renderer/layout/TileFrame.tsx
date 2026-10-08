/**
 * What hosts a tile kind's body, wherever it is drawn (the route map's station pane, the Code view's tiles and
 * viewer): the header actions slot (<TileActions>), an error boundary, a skeleton while the kind's code loads,
 * and where the body saves its own params (a terminal's engine id, a search query).
 */
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { useUi } from '../app/hooks';
import { actions } from '../app/store';
import type { IconName } from '../chrome/icons';
import { tileDefinition } from '../tiles/registry';
import { type LayoutTile, setTileParams } from './tree';
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
  agents: 'session',
  messages: 'list',
  project: 'book',
  activity: 'clock',
  files: 'folder',
  code: 'fileCode',
  search: 'search',
};

const ActionsSlot = createContext<HTMLElement | null>(null);

type ParamsSink = (tileId: string, params: LayoutTile['params']) => void;
const ParamsContext = createContext<ParamsSink | null>(null);

/**
 * Save new params for this tile where its host keeps them: the Code view's workspace store, else the run's
 * layout tree (the route map).
 */
export function useSetTileParams<K extends TileKind>(runId: string, tileId: string) {
  const sink = useContext(ParamsContext);
  return useCallback(
    (params: TileProps<K>['params']) => {
      if (sink) sink(tileId, params as LayoutTile['params']);
      else actions.updateLayout(runId, (layout) => setTileParams(layout, tileId, params as LayoutTile['params']));
    },
    [sink, runId, tileId],
  );
}

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
 * A tile kind's body with what its host gives it: the header actions slot (`<TileActions>` portals into
 * `actionsSlot`), an error boundary, a skeleton while the kind's code loads, and the params sink.
 */
export function TileBody({
  runId,
  tile,
  focused,
  visible,
  actionsSlot,
  onParams = null,
}: {
  runId: string;
  tile: LayoutTile;
  focused: boolean;
  visible: boolean;
  actionsSlot: HTMLElement | null;
  /** Where the body saves its params (default: the run's layout tree). */
  onParams?: ParamsSink | null;
}) {
  const Body = tileDefinition(tile.kind).component as React.ComponentType<TileProps>;
  return (
    <ParamsContext.Provider value={onParams}>
      <ActionsSlot.Provider value={actionsSlot}>
        <TileErrorBoundary kind={tile.kind}>
          <Suspense fallback={<BodySkeleton />}>
            <Body
              tileId={tile.id}
              kind={tile.kind}
              runId={runId}
              params={tile.params}
              focused={focused}
              visible={visible}
            />
          </Suspense>
        </TileErrorBoundary>
      </ActionsSlot.Provider>
    </ParamsContext.Provider>
  );
}

/**
 * Keyboard navigation (or closing an overlay) moved layout focus to this element: take DOM focus, unless
 * something inside already has it, focus lives outside the workspace (an overlay, the rail), or it sits in a
 * place that keeps it (`data-keeps-focus`: the route map, where ↑↓ walk the stations).
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
    if (active?.closest('[data-keeps-focus]')) return;
    if (!active || active === document.body || active.closest('[data-workspace]')) el.focus({ preventScroll: true });
  }, [focused, focusRequest, ref]);
}
