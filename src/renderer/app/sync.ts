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
  applyProjectList,
  applyRunList,
  applySnapshot,
  applyTranscriptPage,
  beginTranscript,
  type DataState,
  dropTranscript,
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
  /** Events after `fromSeq` could not be replayed (snapshots must be refetched); undefined = unknown. */
  onReset(listener: (fromSeq?: number) => void): () => void;
  call<P extends ProcedureName>(method: P, input: RpcInput<P>, options?: CallOptions): Promise<RpcOutput<P>>;
}

type Store = { getState(): DataState; setState(partial: Partial<DataState>): void };

const TRANSCRIPT_PAGE = 2000;
/**
 * History fetched per transcript at most (entries). Pages are compacted as they land (see `compactEntries`),
 * so memory stays bounded either way; this bounds the work for a pathological session.
 */
const MAX_HISTORY_PAGES = 100;
/** A transcript no tile has shown for this long is dropped from the store (refetched when shown again). */
export const TRANSCRIPT_IDLE_MS = 90_000;
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
  /** Client seq the refresh in flight read its snapshots at. */
  private refreshSeq = -1;
  private readonly snapshotRequests = new Map<string, Promise<void>>();
  private readonly transcriptRequests = new Map<string, Promise<void>>();
  /** attemptId → number of mounted views of its transcript. */
  private readonly transcriptUsers = new Map<string, number>();
  private readonly evictTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly client: EngineClient,
    private readonly store: Store = dataStore,
    private readonly idleMs = TRANSCRIPT_IDLE_MS,
  ) {}

  start(): this {
    this.unsubscribe.push(
      this.client.onEvents((events) => this.update((s) => applyEvents(s, events))),
      this.client.onReset((fromSeq) => {
        // The new stream generation usually started a refresh already, at the seq the stream resumes from:
        // that one covers the gap, no need for a second.
        if (!(this.refreshing && this.refreshSeq >= this.client.seq)) void this.refresh();
        this.topUpTranscripts(fromSeq);
      }),
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
    for (const timer of this.evictTimers.values()) clearTimeout(timer);
    this.evictTimers.clear();
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
      this.refreshSeq = atSeq;
      const [list, inbox, projects] = await Promise.all([
        // `includeArchived` is new on the engine side; older engines ignore the extra key.
        this.client.call(
          'runs.list',
          (prefsStore.getState().showArchived ? { includeArchived: true } : {}) as RpcInput<'runs.list'>,
        ),
        this.client.call('inbox.list', { runId: null, includeResolved: false }).catch(() => null),
        // Older engines have no projects: the rail then groups runs by repository.
        this.client.call('projects.list', {}).catch(() => null),
      ]);
      // Projects first: the run list marks the store loaded, and the active project must be known by then.
      if (projects) this.update((s) => applyProjectList(s, projects, atSeq));
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
      // Transcripts are not refetched here: live events keep them current, and a stream gap tops up only
      // the ones on screen (see `topUpTranscripts`).
      await Promise.all([
        ...[...wanted].filter((id) => list.some((r) => r.run.id === id)).map((id) => this.loadSnapshot(id)),
        this.loadEngines(),
        this.loadSettings(),
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

  /**
   * A view shows `attemptId`'s transcript: keep it in the store. Returns the release function; once nothing
   * has shown a transcript for `idleMs`, it is dropped (and refetched if shown again).
   */
  retainTranscript(attemptId: string): () => void {
    this.transcriptUsers.set(attemptId, (this.transcriptUsers.get(attemptId) ?? 0) + 1);
    const timer = this.evictTimers.get(attemptId);
    if (timer) clearTimeout(timer);
    this.evictTimers.delete(attemptId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.transcriptUsers.get(attemptId) ?? 1) - 1;
      if (n > 0) {
        this.transcriptUsers.set(attemptId, n);
        return;
      }
      this.transcriptUsers.delete(attemptId);
      this.scheduleEviction(attemptId);
    };
  }

  private scheduleEviction(attemptId: string): void {
    const previous = this.evictTimers.get(attemptId);
    if (previous) clearTimeout(previous);
    this.evictTimers.set(
      attemptId,
      setTimeout(() => {
        this.evictTimers.delete(attemptId);
        if (this.transcriptUsers.has(attemptId)) return;
        // A load in flight would re-create it: evict once it has landed.
        if (this.transcriptRequests.has(attemptId)) return this.scheduleEviction(attemptId);
        this.update((s) => dropTranscript(s, attemptId));
      }, this.idleMs),
    );
  }

  /**
   * The event stream had a gap after `fromSeq`: fetch what the transcripts on screen missed. The others are
   * dropped (they would be stale) and refetched in full when shown again.
   */
  private topUpTranscripts(fromSeq: number | undefined): void {
    for (const attemptId of Object.keys(this.store.getState().transcripts)) {
      if (!this.transcriptUsers.has(attemptId)) {
        if (!this.transcriptRequests.has(attemptId)) this.update((s) => dropTranscript(s, attemptId));
        continue;
      }
      void this.loadTranscript(attemptId, fromSeq ?? 0);
    }
  }

  private loadTranscript(attemptId: string, fromSeq = 0): Promise<void> {
    const pending = this.transcriptRequests.get(attemptId);
    if (pending) return pending;
    this.update((s) => beginTranscript(s, attemptId));
    const run = async () => {
      try {
        // Page forward with a local cursor: live events may already sit in the transcript with higher seqs
        // than the history we still have to fetch. Entries are merged/deduplicated by seq and compacted.
        let sinceSeq = fromSeq;
        for (let pages = 0; pages < MAX_HISTORY_PAGES; pages++) {
          const page = await this.client.call('attempts.transcript', { attemptId, sinceSeq, limit: TRANSCRIPT_PAGE });
          // Dropped meanwhile (evicted, or the gap handling started over): stop.
          if (!this.store.getState().transcripts[attemptId]) return;
          const last = page.entries.at(-1);
          const capped = page.hasMore && !!last && pages === MAX_HISTORY_PAGES - 1;
          const done = !page.hasMore || !last || capped;
          this.update((s) => applyTranscriptPage(s, attemptId, page.entries, done, capped ? last.seq : null));
          if (done) break;
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
