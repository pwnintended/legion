import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createRpcClient,
  createRpcServer,
  type RpcClient,
  RpcError,
  type RpcServer,
  toEndpoint,
} from './rpc-transport';

const contract = {
  add: { input: z.object({ a: z.number(), b: z.number() }), output: z.object({ sum: z.number() }) },
  fail: { input: z.object({ code: z.string() }), output: z.object({}) },
  crash: { input: z.object({}), output: z.object({}) },
  badOutput: { input: z.object({}), output: z.object({ n: z.number() }) },
  slow: { input: z.object({ ms: z.number() }), output: z.object({ done: z.literal(true) }) },
  missing: { input: z.object({}), output: z.object({}) },
  subscribe: { input: z.object({ since: z.number() }), output: z.object({ ok: z.literal(true) }) },
  echoPort: { input: z.object({ text: z.string() }), output: z.object({ ok: z.literal(true) }) },
} as const;
type C = typeof contract;
interface Ev {
  seq: number;
  name: string;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(batchMs = 5): {
  server: RpcServer<C, Ev>;
  client: RpcClient<C, Ev>;
  port1: MessagePort;
  port2: MessagePort;
} {
  const { port1, port2 } = new MessageChannel();
  const errors: unknown[] = [];
  const server = createRpcServer<C, Ev>(contract, {
    batchMs,
    onError: (error) => errors.push(error),
    handlers: {
      add: ({ a, b }) => ({ sum: a + b }),
      fail: ({ code }) => {
        throw new RpcError(code as 'conflict', `failed with ${code}`, { code });
      },
      crash: () => {
        throw new Error('boom');
      },
      badOutput: () => ({ n: 'nope' }) as unknown as { n: number },
      slow: async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { done: true as const };
      },
      subscribe: ({ since }, { connection }) => {
        connection.startStream(since, [
          { seq: since + 1, name: 'replayed-1' },
          { seq: since + 2, name: 'replayed-2' },
        ]);
        return { ok: true as const };
      },
      echoPort: ({ text }, { ports }) => {
        const port = ports[0] as MessagePort;
        port.postMessage(`echo:${text}`);
        return { ok: true as const };
      },
    },
  });
  server.connect(port1);
  const client = createRpcClient<C, Ev>(port2);
  cleanups.push(() => {
    client.close();
    server.close();
    port1.close();
    port2.close();
  });
  return { server, client, port1, port2 };
}

function collectEvents(client: RpcClient<C, Ev>): {
  events: Ev[];
  batches: number;
  next: (n: number) => Promise<void>;
} {
  const state = { events: [] as Ev[], batches: 0, next: async (_n: number) => {} };
  let waiter: { n: number; resolve: () => void } | null = null;
  client.onEvents((events) => {
    state.batches += 1;
    state.events.push(...events);
    if (waiter && state.events.length >= waiter.n) {
      waiter.resolve();
      waiter = null;
    }
  });
  state.next = (n) =>
    state.events.length >= n
      ? Promise.resolve()
      : new Promise((resolve) => {
          waiter = { n, resolve };
        });
  return state;
}

describe('rpc transport', () => {
  it('round-trips a typed call', async () => {
    const { client } = setup();
    await expect(client.call('add', { a: 2, b: 3 })).resolves.toEqual({ sum: 5 });
  });

  it('handles concurrent calls out of order', async () => {
    const { client } = setup();
    const slow = client.call('slow', { ms: 30 });
    const fast = client.call('add', { a: 1, b: 1 });
    await expect(fast).resolves.toEqual({ sum: 2 });
    await expect(slow).resolves.toEqual({ done: true });
  });

  it('propagates RpcError codes and data', async () => {
    const { client } = setup();
    const error = await client.call('fail', { code: 'conflict' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: 'conflict', message: 'failed with conflict', data: { code: 'conflict' } });
  });

  it('maps unexpected throws to internal', async () => {
    const { client } = setup();
    await expect(client.call('crash', {})).rejects.toMatchObject({ code: 'internal', message: 'boom' });
  });

  it('validates input on the server', async () => {
    const { client } = setup();
    const error = (await client.call('add', { a: 1, b: 'x' } as never).catch((e: unknown) => e)) as RpcError;
    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('b');
  });

  it('validates output on the server', async () => {
    const { client } = setup();
    await expect(client.call('badOutput', {})).rejects.toMatchObject({ code: 'internal' });
  });

  it('answers not_implemented and not_found', async () => {
    const { client } = setup();
    await expect(client.call('missing', {})).rejects.toMatchObject({ code: 'not_implemented' });
    await expect(client.call('nope' as 'missing', {})).rejects.toMatchObject({ code: 'not_found' });
  });

  it('implement() adds handlers at runtime', async () => {
    const { client, server } = setup();
    expect(server.isImplemented('missing')).toBe(false);
    server.implement('missing', () => ({}));
    await expect(client.call('missing', {})).resolves.toEqual({});
  });

  it('times out calls', async () => {
    const { client } = setup();
    await expect(client.call('slow', { ms: 200 }, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects pending calls when the client closes', async () => {
    const { client } = setup();
    const pending = client.call('slow', { ms: 100 });
    client.close();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    await expect(client.call('add', { a: 1, b: 1 })).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('only streams events after startStream, replays, then filters by cursor and batches', async () => {
    const { client, server } = setup(10);
    const received = collectEvents(client);
    server.publish([{ seq: 1, name: 'before-subscribe' }]);
    await client.call('subscribe', { since: 10 });
    await received.next(2);
    expect(received.events.map((e) => e.name)).toEqual(['replayed-1', 'replayed-2']);

    server.publish([{ seq: 12, name: 'old' }]);
    server.publish([{ seq: 13, name: 'a' }]);
    server.publish([
      { seq: 14, name: 'b' },
      { seq: 15, name: 'c' },
    ]);
    await received.next(5);
    expect(received.events.map((e) => e.seq)).toEqual([11, 12, 13, 14, 15]);
    // The three live events arrived coalesced in one batch.
    expect(received.batches).toBe(2);
  });

  it('fans out to multiple connections', async () => {
    const { client, server } = setup(0);
    const { port1, port2 } = new MessageChannel();
    server.connect(port1);
    const other = createRpcClient<C, Ev>(port2);
    cleanups.push(() => {
      other.close();
      port1.close();
      port2.close();
    });
    const a = collectEvents(client);
    const b = collectEvents(other);
    await client.call('subscribe', { since: 0 });
    await other.call('subscribe', { since: 0 });
    await a.next(2);
    await b.next(2);
    server.publish([{ seq: 3, name: 'live' }]);
    await a.next(3);
    await b.next(3);
    expect(a.events.at(-1)?.name).toBe('live');
    expect(b.events.at(-1)?.name).toBe('live');
    expect(server.connections.size).toBe(2);
  });

  it('transfers ports with a request', async () => {
    const { client } = setup();
    const side = new MessageChannel();
    cleanups.push(() => {
      side.port1.close();
      side.port2.close();
    });
    const echoed = new Promise<unknown>((resolve) => side.port1.once('message', resolve));
    await client.call('echoPort', { text: 'hi' }, { transfer: [side.port2] });
    await expect(echoed).resolves.toBe('echo:hi');
  });

  it('drops the connection when the port closes', async () => {
    const { server, port2 } = setup();
    expect(server.connections.size).toBe(1);
    const closed = new Promise<void>((resolve) => [...server.connections][0]?.onClose(resolve));
    port2.close();
    await closed;
    expect(server.connections.size).toBe(0);
  });

  it('ignores foreign messages on the port', async () => {
    const { client, port1 } = setup();
    port1.postMessage({ hello: 'world' });
    await expect(client.call('add', { a: 1, b: 2 })).resolves.toEqual({ sum: 3 });
  });

  it('toEndpoint supports emitter-style ports (Electron MessagePortMain shape)', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const sent: unknown[] = [];
    let started = false;
    const port = {
      postMessage: (message: unknown) => sent.push(message),
      on: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      off: (type: string) => listeners.delete(type),
      start: () => {
        started = true;
      },
    };
    const endpoint = toEndpoint(port);
    const received: unknown[] = [];
    const off = endpoint.onMessage((data, ports) => received.push([data, ports.length]));
    expect(started).toBe(true);
    listeners.get('message')?.({ data: 'x', ports: [1] });
    endpoint.postMessage('y');
    expect(received).toEqual([['x', 1]]);
    expect(sent).toEqual(['y']);
    off();
    expect(listeners.has('message')).toBe(false);
  });
});
