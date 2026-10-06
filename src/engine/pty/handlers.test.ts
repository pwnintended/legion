import { tmpdir } from 'node:os';
import { MessageChannel as NodeChannel } from 'node:worker_threads';
import type { TerminalMessage } from '@shared/rpc';
import { createRpcClient, RpcError } from '@shared/rpc-transport';
import { describe, expect, it } from 'vitest';
import { type EngineContext, silentLogger } from '../context';
import { createEngineRpcServer } from '../rpc/server';
import { registerTerminalHandlers } from './handlers';
import type { PtyProcess } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeProc(): PtyProcess & { emit(data: string): void; killed: boolean } {
  let onData: (data: string) => void = () => {};
  let onExit: (event: { exitCode: number }) => void = () => {};
  const proc = {
    pid: 7,
    killed: false,
    onData: (l: (data: string) => void) => {
      onData = l;
    },
    onExit: (l: (event: { exitCode: number }) => void) => {
      onExit = l;
    },
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill() {
      proc.killed = true;
      onExit({ exitCode: 0 });
    },
    emit: (data: string) => onData(data),
  };
  return proc;
}

describe('terminal handlers', () => {
  it('opens a terminal with the transferred port, resizes and closes it', async () => {
    const ctx = {
      env: { SHELL: '/bin/sh' },
      log: silentLogger,
      store: { onEvents: () => {} },
    } as unknown as EngineContext;
    const server = createEngineRpcServer(ctx);
    const procs: ReturnType<typeof fakeProc>[] = [];
    const service = registerTerminalHandlers(server, ctx, {
      spawn: () => {
        const p = fakeProc();
        procs.push(p);
        return p;
      },
    });
    const rpc = new NodeChannel();
    server.connect(rpc.port1);
    const client = createRpcClient<typeof import('@shared/rpc').rpcContract>(rpc.port2);

    const term = new NodeChannel();
    const received: TerminalMessage[] = [];
    term.port2.on('message', (m: TerminalMessage) => received.push(m));
    const opened = await client.call(
      'terminals.open',
      { target: { kind: 'shell', cwd: tmpdir() }, cols: 80, rows: 24 },
      { transfer: [term.port1] },
    );
    expect(opened.pid).toBe(7);
    procs[0]?.emit('prompt$ ');
    await sleep(30);
    expect(received.map((m) => (m.type === 'data' ? m.data : '')).join('')).toContain('prompt$');

    await expect(
      client.call('terminals.resize', { terminalId: opened.terminalId, cols: 90, rows: 30 }),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      client.call('terminals.resize', { terminalId: 'term_nope', cols: 90, rows: 30 }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await client.call('terminals.close', { terminalId: opened.terminalId });
    expect(procs[0]?.killed).toBe(true);

    await expect(
      client.call('terminals.open', { target: { kind: 'shell', cwd: tmpdir() }, cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(RpcError);
    const missing = new NodeChannel();
    await expect(
      client.call(
        'terminals.open',
        { target: { kind: 'shell', cwd: '/definitely/not/here' }, cols: 80, rows: 24 },
        { transfer: [missing.port1] },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    service.dispose();
    client.close({ closePort: true });
  });
});
