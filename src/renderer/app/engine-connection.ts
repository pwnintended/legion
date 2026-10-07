import { ENGINE_PORT_MESSAGE, type LegionBridge } from '@shared/bridge';
import type { ServerEvent } from '@shared/events';
import type { ProcedureName, RpcContract, RpcInput, RpcOutput } from '@shared/rpc';
import { type CallOptions, createRpcClient, type RpcClient, RpcError } from '@shared/rpc-transport';

/** `degraded`: calls work but the event stream could not be started (retrying). */
export type ConnectionStatus = 'connecting' | 'connected' | 'degraded' | 'disconnected';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Increments every time a stream is (re)established on an engine port (renderer reload, engine restart). */
  generation: number;
}

const SUBSCRIBE_RETRY_MS = 500;
const SUBSCRIBE_RETRY_MAX_MS = 10_000;

/**
 * The renderer's link to the engine. Gets a MessagePort from main (via the preload's window.postMessage),
 * builds an RPC client on it and keeps the event stream going: every new port (renderer reload, engine
 * restart) replaces the client and re-subscribes from the last seen seq. Calls made while no port is
 * attached wait for the next one.
 */
export class EngineConnection {
  private client: RpcClient<RpcContract, ServerEvent> | null = null;
  private state: ConnectionState = { status: 'connecting', generation: 0 };
  private lastSeq = 0;
  private waiters: (() => void)[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(events: ServerEvent[]) => void>();
  private readonly resetListeners = new Set<(fromSeq: number) => void>();
  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data = event.data as { type?: unknown } | null;
    const port = event.ports[0];
    if (data?.type === ENGINE_PORT_MESSAGE && port) this.attachPort(port);
  };

  constructor(bridge: LegionBridge) {
    window.addEventListener('message', this.onWindowMessage);
    bridge.requestEnginePort();
  }

  /** Stable snapshot for useSyncExternalStore. */
  getState = (): ConnectionState => this.state;

  /** Highest event seq applied so far. */
  get seq(): number {
    return this.lastSeq;
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Server events in seq order (live, or replayed after a reconnect). */
  onEvents(listener: (events: ServerEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** The engine could not replay events after `fromSeq`: stores must refetch their snapshots. */
  onReset(listener: (fromSeq: number) => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  async call<P extends ProcedureName>(method: P, input: RpcInput<P>, options?: CallOptions): Promise<RpcOutput<P>> {
    for (;;) {
      const client = this.client ?? (await this.nextClient());
      try {
        return await client.call(method, input, options);
      } catch (error) {
        // The port died mid-call (engine restart): retry once a new port arrives.
        if (error instanceof RpcError && error.code === 'disconnected' && client !== this.client) continue;
        throw error;
      }
    }
  }

  dispose(): void {
    window.removeEventListener('message', this.onWindowMessage);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.close({ closePort: true });
    this.client = null;
    this.setState({ status: 'disconnected', generation: this.state.generation });
  }

  private nextClient(): Promise<RpcClient<RpcContract, ServerEvent>> {
    return new Promise((resolve) => {
      this.waiters.push(() => {
        if (this.client) resolve(this.client);
      });
    });
  }

  /**
   * Use a new engine port. Calls go through it right away; the connection reports `connected` (a new
   * generation, which makes the stores refetch their snapshots) only once `subscribe` succeeded, so the
   * refetch starts from the seq the stream resumes at. A failed `subscribe` leaves the connection
   * `degraded` (calls work, no live updates) and is retried with backoff.
   */
  attachPort(port: MessagePort): void {
    this.client?.close({ closePort: true });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = createRpcClient<RpcContract, ServerEvent>(port);
    this.client = client;
    client.onEvents((events) => {
      if (client !== this.client) return;
      const fresh = events.filter((event) => event.seq > this.lastSeq);
      const last = fresh.at(-1);
      if (!last) return;
      this.lastSeq = last.seq;
      for (const listener of this.eventListeners) listener(fresh);
    });
    if (this.state.status === 'connected') this.setState({ status: 'connecting', generation: this.state.generation });
    this.subscribe(client, 0);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private subscribe(client: RpcClient<RpcContract, ServerEvent>, failures: number): void {
    if (client !== this.client) return;
    void client
      .call('subscribe', { sinceSeq: this.lastSeq })
      .then(({ headSeq, replayed }) => {
        if (client !== this.client) return;
        const fromSeq = this.lastSeq;
        if (!replayed) this.lastSeq = Math.max(this.lastSeq, headSeq);
        this.setState({ status: 'connected', generation: this.state.generation + 1 });
        if (!replayed) for (const listener of this.resetListeners) listener(fromSeq);
      })
      .catch((error: unknown) => {
        if (client !== this.client) return;
        console.error('[legion] subscribe failed; retrying', error);
        this.setState({ status: 'degraded', generation: this.state.generation });
        const delay = Math.min(SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_MS * 2 ** failures);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.subscribe(client, failures + 1);
        }, delay);
      });
  }

  private setState(state: ConnectionState): void {
    if (state.status === this.state.status && state.generation === this.state.generation) return;
    this.state = state;
    for (const listener of this.statusListeners) listener();
  }
}
