import type { ServerEvent } from '@shared/events';
import type { ProcedureName, RpcInput, TranscriptEntry } from '@shared/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataState } from './data';
import { initialData } from './data';
import type { ConnectionState } from './engine-connection';
import { type EngineClient, StoreSync } from './sync';

/** An engine double: a fixed transcript per attempt, records every call. */
class FakeClient implements EngineClient {
  seq = 0;
  calls: { method: string; input: unknown }[] = [];
  history: Record<string, TranscriptEntry[]> = {};
  private status = new Set<() => void>();
  private events = new Set<(events: ServerEvent[]) => void>();
  private resets = new Set<(fromSeq?: number) => void>();
  private state: ConnectionState = { status: 'connected', generation: 1 };

  getState = () => this.state;
  onStatus(l: () => void) {
    this.status.add(l);
    return () => this.status.delete(l);
  }
  onEvents(l: (events: ServerEvent[]) => void) {
    this.events.add(l);
    return () => this.events.delete(l);
  }
  onReset(l: (fromSeq?: number) => void) {
    this.resets.add(l);
    return () => this.resets.delete(l);
  }
  reset(fromSeq: number) {
    for (const l of this.resets) l(fromSeq);
  }
  // biome-ignore lint/suspicious/noExplicitAny: a loose double for the typed call
  async call(method: ProcedureName, input: any): Promise<any> {
    this.calls.push({ method, input });
    switch (method) {
      case 'runs.list':
      case 'inbox.list':
      case 'engines.list':
        return [];
      case 'settings.get':
        return null;
      case 'attempts.transcript': {
        const { attemptId, sinceSeq, limit } = input as RpcInput<'attempts.transcript'>;
        const rest = (this.history[attemptId] ?? []).filter((e) => e.seq > sinceSeq);
        return { entries: rest.slice(0, limit), hasMore: rest.length > limit };
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

function memoryStore() {
  let state: DataState = initialData();
  return {
    getState: () => state,
    setState: (next: Partial<DataState>) => {
      state = { ...state, ...next };
    },
  };
}

const message = (seq: number): TranscriptEntry => ({ seq, ts: seq, event: { type: 'message', text: `m${seq}` } });
const transcriptCalls = (client: FakeClient) =>
  client.calls.filter((c) => c.method === 'attempts.transcript').map((c) => c.input);

describe('StoreSync transcripts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a transcript a while after the last view of it unmounts', async () => {
    const client = new FakeClient();
    client.history.a = [message(1), message(2)];
    const store = memoryStore();
    const sync = new StoreSync(client, store, 1000);
    const release = sync.retainTranscript('a');
    await sync.requestTranscript('a');
    expect(store.getState().transcripts.a?.count).toBe(2);
    release();
    vi.advanceTimersByTime(999);
    expect(store.getState().transcripts.a).toBeDefined();
    // Shown again before the timer fired: kept.
    const again = sync.retainTranscript('a');
    vi.advanceTimersByTime(5000);
    expect(store.getState().transcripts.a).toBeDefined();
    again();
    vi.advanceTimersByTime(1000);
    expect(store.getState().transcripts.a).toBeUndefined();
    sync.stop();
  });

  it('does not refetch transcripts on refresh; a stream gap tops up only the ones on screen', async () => {
    const client = new FakeClient();
    client.history = { a: [message(1), message(2)], b: [message(3)] };
    const store = memoryStore();
    const sync = new StoreSync(client, store, 1000).start();
    const releaseA = sync.retainTranscript('a');
    await sync.requestTranscript('a');
    // `b` was fetched but nothing shows it.
    await sync.requestTranscript('b');
    client.calls = [];

    await sync.refresh();
    expect(transcriptCalls(client)).toEqual([]);
    expect(store.getState().transcripts.b?.count).toBe(1);

    // Events after seq 2 could not be replayed: `a` (on screen) is topped up from there, `b` is dropped.
    client.history.a = [message(1), message(2), message(5)];
    client.reset(2);
    await vi.waitFor(() => expect(store.getState().transcripts.a?.lastSeq).toBe(5));
    expect(transcriptCalls(client)).toEqual([{ attemptId: 'a', sinceSeq: 2, limit: expect.any(Number) }]);
    expect(store.getState().transcripts.b).toBeUndefined();
    releaseA();
    sync.stop();
  });
});
