/**
 * Feeds the data store from an engine client (the real EngineConnection or the demo fixture client):
 * live/replayed event batches → `applyEvents`; every new engine port (first connect, reload, engine restart)
 * and every `replayed: false` → snapshot refetch (`runs.list`, `inbox.list`, `runs.get`, engines, settings).
 * Transcripts are fetched on demand (`requestTranscript`) and then kept live by agent events.
 */
import type { ServerEvent } from '@shared/events';
import type { ProcedureName, RpcInput, RpcOutput } from '@shared/rpc';
import type { CallOptions } from '@shared/rpc-transport';
import { RpcError } from '@shared/rpc-transport';
import {
  applyEvents,
  applyOpenInbox,
  applyRunList,
  applySnapshot,
  applyTranscriptPage,
  beginTranscript,
  type DataState,
  failTranscript,
  TERMINAL_RUN_STATUSES,
} from './data';
import type { ConnectionState } from './engine-connection';
import { prefsStore } from './prefs';
import { dataStore, uiStore } from './store';

/** What the store needs from a connection; implemented by EngineConnection and the demo client. */
export interface EngineClient {
  getState(): ConnectionState;
  /** Highest event seq delivered so far. */
  readonly seq: number;
  onStatus(listener: () => void): () => void;
  onEvents(listener: (events: ServerEvent[]) => void): () => void;
  onReset(listener: () => void): () => void;
  call<P extends ProcedureName>(method: P, input: RpcInput<P>, options?: CallOptions): Promise<RpcOutput<P>>;
}

type Store = { getState(): DataState; setState(partial: Partial<DataState>): void };

const TRANSCRIPT_PAGE = 1000;
/** Snapshots fetched eagerly: every unfinished run plus this many finished ones. */
const RECENT_FINISHED_SNAPSHOTS = 3;

let current: StoreSync | null = null;

/** The client the app is connected to (for hooks that call RPCs). */
export function getClient(): EngineClient {
  if (!current) throw new Error('store not connected (connectStore was not called)');
  return current.client;
}

export class StoreSync {
  private readonly unsubscribe: (() => void)[] = [];
  private generation = -1;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private readonly snapshotRequests = new Map<string, Promise<void>>();
  private readonly transcriptRequests = new Map<string, Promise<void>>();

  constructor(
    readonly client: EngineClient,
    private readonly store: Store = dataStore,
  ) {}

  start(): this {
    this.unsubscribe.push(
      this.client.onEvents((events) => this.update((s) => applyEvents(s, events))),
      this.client.onReset(() => void this.refresh()),
      this.client.onStatus(() => this.onStatus()),
      uiStore.subscribe((ui, prev) => {
        if (ui.activeRunId && ui.activeRunId !== prev.activeRunId) void this.ensureSnapshot(ui.activeRunId);
      }),
    );
    this.onStatus();
    return this;
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private update(fn: (state: DataState) => DataState): void {
    const before = this.store.getState();
    const after = fn(before);
    if (after !== before) this.store.setState(after);
  }

  private onStatus(): void {
    const { status, generation } = this.client.getState();
    this.update((s) =>
      s.connection.status === status && s.connection.generation === generation
        ? s
        : { ...s, connection: { ...s.connection, status, generation } },
    );
    if (status === 'connected' && generation !== this.generation) {
      this.generation = generation;
      void this.refresh();
    }
  }

  /** Refetch every snapshot. Concurrent calls coalesce into one follow-up refresh. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    this.update((s) => ({ ...s, connection: { ...s.connection, syncing: true } }));
    try {
      const atSeq = this.client.seq;
      const [list, inbox] = await Promise.all([
        // `includeArchived` is new on the engine side; older engines ignore the extra key.
        this.client.call(
          'runs.list',
          (prefsStore.getState().showArchived ? { includeArchived: true } : {}) as RpcInput<'runs.list'>,
        ),
        this.client.call('inbox.list', { runId: null, includeResolved: false }).catch(() => null),
      ]);
      this.update((s) => applyRunList(s, list, atSeq));
      if (inbox) this.update((s) => applyOpenInbox(s, inbox, atSeq));

      const active = list.filter((r) => !TERMINAL_RUN_STATUSES.has(r.run.status)).map((r) => r.run.id);
      const finished = list
        .filter((r) => TERMINAL_RUN_STATUSES.has(r.run.status))
        .sort((a, b) => b.run.updatedAt - a.run.updatedAt)
        .slice(0, RECENT_FINISHED_SNAPSHOTS)
        .map((r) => r.run.id);
      const activeRunId = uiStore.getState().activeRunId;
      const wanted = new Set([...(activeRunId ? [activeRunId] : []), ...active, ...finished]);
      await Promise.all([
        ...[...wanted].filter((id) => list.some((r) => r.run.id === id)).map((id) => this.loadSnapshot(id)),
        this.loadEngines(),
        this.loadSettings(),
        ...Object.keys(this.store.getState().transcripts).map((id) => this.loadTranscript(id)),
      ]);
    } catch (error) {
      if (!(error instanceof RpcError && error.code === 'disconnected'))
        console.error('[legion] refresh failed', error);
    } finally {
      // Even a failed refresh ends the initial loading state (onboarding shows the engine diagnostics).
      this.update((s) => ({ ...s, connection: { ...s.connection, syncing: false, loaded: true } }));
    }
  }

  /** Load a run snapshot if it isn't loaded yet. */
  ensureSnapshot(runId: string): Promise<void> {
    if (this.store.getState().loadedRuns[runId] !== undefined) return Promise.resolve();
    return this.loadSnapshot(runId);
  }

  private loadSnapshot(runId: string): Promise<void> {
    const pending = this.snapshotRequests.get(runId);
    if (pending) return pending;
    const request = this.client
      .call('runs.get', { runId })
      .then((snapshot) => this.update((s) => applySnapshot(s, snapshot)))
      .catch((error: unknown) => {
        if (!(error instanceof RpcError && error.code === 'disconnected'))
          console.error(`[legion] runs.get ${runId} failed`, error);
      })
      .finally(() => this.snapshotRequests.delete(runId));
    this.snapshotRequests.set(runId, request);
    return request;
  }

  private async loadEngines(): Promise<void> {
    try {
      const list = await this.client.call('engines.list', {});
      this.update((s) => ({ ...s, engines: { status: 'ready', list } }));
    } catch {
      this.update((s) => ({ ...s, engines: { status: 'unavailable', list: s.engines.list } }));
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const settings = await this.client.call('settings.get', {});
      this.update((s) => ({ ...s, settings }));
    } catch {
      // keep what we have
    }
  }

  /** Fetch (or top up) an attempt's transcript; live agent events keep it current afterwards. */
  requestTranscript(attemptId: string): Promise<void> {
    const transcript = this.store.getState().transcripts[attemptId];
    if (transcript && transcript.status !== 'error') return this.transcriptRequests.get(attemptId) ?? Promise.resolve();
    return this.loadTranscript(attemptId);
  }

  private loadTranscript(attemptId: string): Promise<void> {
    const pending = this.transcriptRequests.get(attemptId);
    if (pending) return pending;
    this.update((s) => beginTranscript(s, attemptId));
    const run = async () => {
      try {
        // Page from the start with a local cursor: live events may already sit in the transcript with
        // higher seqs than the history we still have to fetch. Entries are merged/deduplicated by seq.
        let sinceSeq = 0;
        for (;;) {
          const page = await this.client.call('attempts.transcript', { attemptId, sinceSeq, limit: TRANSCRIPT_PAGE });
          this.update((s) => applyTranscriptPage(s, attemptId, page.entries, !page.hasMore));
          const last = page.entries.at(-1);
          if (!page.hasMore || !last) break;
          sinceSeq = last.seq;
        }
        const t = this.store.getState().transcripts[attemptId];
        if (t?.status === 'loading') this.update((s) => applyTranscriptPage(s, attemptId, [], true));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.update((s) => failTranscript(s, attemptId, message));
      }
    };
    const request = run().finally(() => this.transcriptRequests.delete(attemptId));
    this.transcriptRequests.set(attemptId, request);
    return request;
  }
}

/** Wire a client into the global stores. Returns the controller (call `stop()` to detach). */
export function connectStore(client: EngineClient): StoreSync {
  current?.stop();
  current = new StoreSync(client).start();
  return current;
}

export function getSync(): StoreSync | null {
  return current;
}
