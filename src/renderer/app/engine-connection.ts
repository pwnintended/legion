import { ENGINE_PORT_MESSAGE, type LegionBridge } from '@shared/bridge';
import type { ServerEvent } from '@shared/events';
import type { ProcedureName, RpcContract, RpcInput, RpcOutput } from '@shared/rpc';
import { type CallOptions, createRpcClient, type RpcClient, RpcError } from '@shared/rpc-transport';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Increments every time a new engine port is attached (renderer reload, engine restart). */
  generation: number;
}

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
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(events: ServerEvent[]) => void>();
  private readonly resetListeners = new Set<(fromSeq: number) => void>();
  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data = event.data as { type?: unknown } | null;
    const port = event.ports[0];
    if (data?.type === ENGINE_PORT_MESSAGE && port) this.attach(port);
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

  private attach(port: MessagePort): void {
    this.client?.close({ closePort: true });
    const client = createRpcClient<RpcContract, ServerEvent>(port);
    this.client = client;
    client.onEvents((events) => {
      const fresh = events.filter((event) => event.seq > this.lastSeq);
      const last = fresh.at(-1);
      if (!last) return;
      this.lastSeq = last.seq;
      for (const listener of this.eventListeners) listener(fresh);
    });
    void client
      .call('subscribe', { sinceSeq: this.lastSeq })
      .then(({ headSeq, replayed }) => {
        if (!replayed) {
          const fromSeq = this.lastSeq;
          this.lastSeq = Math.max(this.lastSeq, headSeq);
          for (const listener of this.resetListeners) listener(fromSeq);
        }
      })
      .catch((error: unknown) => console.error('[legion] subscribe failed', error));
    this.setState({ status: 'connected', generation: this.state.generation + 1 });
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private setState(state: ConnectionState): void {
    if (state.status === this.state.status && state.generation === this.state.generation) return;
    this.state = state;
    for (const listener of this.statusListeners) listener();
  }
}
