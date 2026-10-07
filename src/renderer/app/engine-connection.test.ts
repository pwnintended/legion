import type { ServerEvent } from '@shared/events';
import { rpcContract } from '@shared/rpc';
import { createRpcServer, RpcError } from '@shared/rpc-transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineConnection } from './engine-connection';

describe('EngineConnection', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('marks the connection degraded when subscribe fails and retries until the stream is up', async () => {
    let attempts = 0;
    const server = createRpcServer<typeof rpcContract, ServerEvent>(rpcContract, {
      batchMs: 0,
      handlers: {
        subscribe: ({ sinceSeq }) => {
          attempts++;
          if (attempts <= 2) throw new RpcError('unavailable', 'event log not ready');
          expect(sinceSeq).toBe(0);
          return { headSeq: 42, replayed: false };
        },
      },
    });
    const { port1, port2 } = new MessageChannel();
    server.connect(port2);
    const connection = new EngineConnection({ requestEnginePort: () => {} } as never);
    const statuses: string[] = [];
    connection.onStatus(() => statuses.push(connection.getState().status));
    const resets: number[] = [];
    connection.onReset((fromSeq) => resets.push(fromSeq));

    connection.attachPort(port1);
    // Not "connected" before the stream is: a refresh would start from the wrong seq.
    expect(connection.getState()).toEqual({ status: 'connecting', generation: 0 });
    await vi.waitFor(() => expect(connection.getState().status).toBe('degraded'));
    await vi.waitFor(() => expect(connection.getState().status).toBe('connected'), { timeout: 5000 });
    expect(attempts).toBe(3);
    expect(connection.getState().generation).toBe(1);
    expect(connection.seq).toBe(42);
    expect(resets).toEqual([0]);
    expect(statuses).toEqual(['degraded', 'connected']);
    connection.dispose();
    server.close();
  });
});
