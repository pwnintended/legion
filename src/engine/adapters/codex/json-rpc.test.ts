import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JSON_RPC_ERROR,
  JsonRpcClosedError,
  JsonRpcError,
  JsonRpcPeer,
  JsonRpcTimeoutError,
  LineSplitter,
} from './json-rpc';

function setup(options: Partial<ConstructorParameters<typeof JsonRpcPeer>[0]> = {}) {
  const written: Record<string, unknown>[] = [];
  const peer = new JsonRpcPeer({ write: (line) => written.push(JSON.parse(line)), ...options });
  return { peer, written };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('JsonRpcPeer requests', () => {
  it('sends requests with increasing ids and resolves results', async () => {
    const { peer, written } = setup();
    const a = peer.request('thread/start', { cwd: '/x' });
    const b = peer.request('model/list');
    expect(written).toEqual([
      { id: 1, method: 'thread/start', params: { cwd: '/x' } },
      { id: 2, method: 'model/list' },
    ]);
    peer.receive(JSON.stringify({ id: 2, result: { data: [] } }));
    peer.receive(JSON.stringify({ id: 1, result: { thread: { id: 't' } } }));
    await expect(a).resolves.toEqual({ thread: { id: 't' } });
    await expect(b).resolves.toEqual({ data: [] });
    expect(peer.pendingCount).toBe(0);
  });

  it('rejects with JsonRpcError on error responses', async () => {
    const { peer } = setup();
    const p = peer.request('turn/steer', {});
    peer.receive(JSON.stringify({ id: 1, error: { code: -32600, message: 'no active turn to steer' } }));
    const error = await p.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).toMatchObject({ code: -32600, message: 'no active turn to steer' });
  });

  it('accepts messages with a jsonrpc member', async () => {
    const { peer } = setup();
    const p = peer.request('x');
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
    await expect(p).resolves.toBe(7);
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const { peer } = setup({ requestTimeoutMs: 1000 });
    const p = peer.request('slow');
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toBeInstanceOf(JsonRpcTimeoutError);
    expect(peer.pendingCount).toBe(0);
  });

  it('per-request timeout 0 waits forever', async () => {
    vi.useFakeTimers();
    const { peer } = setup({ requestTimeoutMs: 10 });
    const p = peer.request('slow', undefined, { timeoutMs: 0 });
    vi.advanceTimersByTime(100_000);
    peer.receive(JSON.stringify({ id: 1, result: 'late' }));
    await expect(p).resolves.toBe('late');
  });

  it('aborts with a signal', async () => {
    const { peer } = setup();
    const controller = new AbortController();
    const p = peer.request('x', undefined, { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    expect(peer.pendingCount).toBe(0);
  });

  it('close rejects pending and later requests', async () => {
    const { peer } = setup();
    const p = peer.request('x');
    peer.close();
    await expect(p).rejects.toBeInstanceOf(JsonRpcClosedError);
    await expect(peer.request('y')).rejects.toBeInstanceOf(JsonRpcClosedError);
    expect(() => peer.notify('z')).toThrow(JsonRpcClosedError);
  });

  it('rejects when the transport write throws', async () => {
    const peer = new JsonRpcPeer({
      write: () => {
        throw new Error('EPIPE');
      },
    });
    await expect(peer.request('x')).rejects.toThrow('EPIPE');
    expect(peer.pendingCount).toBe(0);
  });
});

describe('JsonRpcPeer notifications and server requests', () => {
  it('sends and dispatches notifications', () => {
    const notifications: [string, unknown][] = [];
    const { peer, written } = setup({ onNotification: (method, params) => notifications.push([method, params]) });
    peer.notify('initialized');
    expect(written).toEqual([{ method: 'initialized' }]);
    peer.receive('{"method":"turn/started","params":{"threadId":"t"}}');
    expect(notifications).toEqual([['turn/started', { threadId: 't' }]]);
  });

  it('answers server requests with the handler result, including id 0', async () => {
    const { peer, written } = setup({ onRequest: (method) => ({ handled: method }) });
    peer.receive('{"id":0,"method":"currentTime/read","params":{}}');
    await tick();
    expect(written).toEqual([{ id: 0, result: { handled: 'currentTime/read' } }]);
  });

  it('waits for async handlers (approvals)', async () => {
    let approve!: (value: unknown) => void;
    const { peer, written } = setup({
      onRequest: () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    });
    peer.receive('{"id":"a1","method":"item/commandExecution/requestApproval","params":{}}');
    await tick();
    expect(written).toEqual([]);
    approve({ decision: 'decline' });
    await tick();
    expect(written).toEqual([{ id: 'a1', result: { decision: 'decline' } }]);
  });

  it('replies with an error when the handler throws', async () => {
    const { peer, written } = setup({
      onRequest: (method) => {
        throw new JsonRpcError(JSON_RPC_ERROR.methodNotFound, `no ${method}`);
      },
    });
    peer.receive('{"id":5,"method":"item/tool/call","params":{}}');
    await tick();
    expect(written).toEqual([{ id: 5, error: { code: -32601, message: 'no item/tool/call' } }]);
  });

  it('maps non-RPC errors and rejections to internal errors', async () => {
    const { peer, written } = setup({ onRequest: () => Promise.reject(new Error('boom')) });
    peer.receive('{"id":6,"method":"x"}');
    await tick();
    expect(written).toEqual([{ id: 6, error: { code: -32603, message: 'boom' } }]);
  });

  it('never leaves a server request unanswered without a handler', async () => {
    const { peer, written } = setup();
    peer.receive('{"id":7,"method":"account/chatgptAuthTokens/refresh","params":{}}');
    await tick();
    expect(written).toEqual([
      { id: 7, error: { code: -32601, message: 'unsupported request: account/chatgptAuthTokens/refresh' } },
    ]);
  });

  it('drops replies after close', async () => {
    let approve!: (value: unknown) => void;
    const { peer, written } = setup({
      onRequest: () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    });
    peer.receive('{"id":1,"method":"x"}');
    peer.close();
    approve('late');
    await tick();
    expect(written).toEqual([]);
  });

  it('reports protocol errors', () => {
    const errors: string[] = [];
    const { peer } = setup({ onProtocolError: (message) => errors.push(message) });
    peer.receive('not json');
    peer.receive('[1,2]');
    peer.receive('{"id":42,"result":1}');
    peer.receive('{"foo":1}');
    peer.receive('   ');
    expect(errors).toEqual([
      'invalid JSON',
      'not a JSON-RPC message',
      'response for unknown request id 42',
      'not a JSON-RPC message',
    ]);
  });
});

describe('LineSplitter', () => {
  it('reassembles lines across chunks and handles CRLF', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\r\n\n{"c":3}\n{"d"')).toEqual(['{"b":2}', '{"c":3}']);
    expect(splitter.flush()).toBe('{"d"');
    expect(splitter.flush()).toBeNull();
  });
});

describe('recorded transcript', () => {
  it('routes every server message of a real approval session', async () => {
    const lines = readFileSync(join(import.meta.dirname, 'fixtures', 'approval.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const entries = lines.map((line) => JSON.parse(line) as { dir: string; msg: Record<string, unknown> });
    const notifications: string[] = [];
    const requests: string[] = [];
    const { peer, written } = setup({
      onNotification: (method) => notifications.push(method),
      onRequest: (method) => {
        requests.push(method);
        return { decision: 'decline' };
      },
    });
    const pending = [peer.request('initialize'), peer.request('thread/start'), peer.request('turn/start')];
    for (const { dir, msg } of entries) if (dir === 'in') peer.receive(JSON.stringify(msg));
    await Promise.all(pending);
    await tick();
    expect(requests).toEqual(['item/commandExecution/requestApproval']);
    expect(notifications).toContain('serverRequest/resolved');
    expect(notifications.at(-1)).toBe('turn/completed');
    expect(written.at(-1)).toEqual({ id: 0, result: { decision: 'decline' } });
  });
});
