import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { TerminalMessage } from '@shared/rpc';
import { afterEach, describe, expect, it } from 'vitest';
import { PtyManager } from './manager';
import type { PtyProcess, PtySpawn } from './types';

class FakePty implements PtyProcess {
  pid = 4242;
  written: string[] = [];
  size = { cols: 0, rows: 0 };
  paused = false;
  pauseCount = 0;
  killed = false;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number }) => void)[] = [];
  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListeners.push(listener);
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.size = { cols, rows };
  }
  pause() {
    this.paused = true;
    this.pauseCount++;
  }
  resume() {
    this.paused = false;
  }
  kill() {
    this.killed = true;
    this.emitExit(137);
  }
  emit(data: string) {
    for (const l of this.dataListeners) l(data);
  }
  emitExit(code: number) {
    for (const l of this.exitListeners) l({ exitCode: code });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function view(port: MessagePort) {
  const messages: TerminalMessage[] = [];
  port.on('message', (m: TerminalMessage) => messages.push(m));
  return {
    messages,
    text: () => messages.map((m) => (m.type === 'data' ? m.data : '')).join(''),
  };
}

describe('PtyManager', () => {
  const managers: PtyManager[] = [];
  afterEach(() => {
    for (const m of managers.splice(0)) m.dispose();
  });

  function setup(opts: ConstructorParameters<typeof PtyManager>[0] extends infer O ? Partial<O> : never = {}) {
    const ptys: FakePty[] = [];
    const spawn: PtySpawn = () => {
      const p = new FakePty();
      ptys.push(p);
      return p;
    };
    const manager = new PtyManager({ spawn, flushMs: 1, ...opts });
    managers.push(manager);
    const open = (extra: Partial<Parameters<PtyManager['open']>[0]> = {}) =>
      manager.open({ cmd: 'sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, ...extra });
    return { manager, ptys, open };
  }

  it('streams output and forwards input over the port', async () => {
    const { manager, ptys, open } = setup();
    const { terminalId } = open();
    const { port1, port2 } = new MessageChannel();
    const v = view(port2);
    manager.attach(terminalId, port1);
    await sleep(10);
    ptys[0]?.emit('hello ');
    ptys[0]?.emit('world');
    await sleep(20);
    expect(v.text()).toBe('hello world');
    port2.postMessage({ type: 'input', data: 'ls\r' });
    await sleep(10);
    expect(ptys[0]?.written).toEqual(['ls\r']);
    expect(manager.resize(terminalId, 100, 30)).toBe(true);
    expect(ptys[0]?.size).toEqual({ cols: 100, rows: 30 });
    port2.close();
  });

  it('hydrates a re-attached view from scrollback and survives detach', async () => {
    const { manager, ptys, open } = setup();
    const { terminalId } = open();
    const first = new MessageChannel();
    manager.attach(terminalId, first.port1);
    ptys[0]?.emit('line one\r\nline two\r\n');
    await sleep(20);
    first.port2.close();
    await sleep(20);
    expect(ptys[0]?.killed).toBe(false);
    ptys[0]?.emit('while detached\r\n');
    await sleep(10);

    const second = new MessageChannel();
    const v = view(second.port2);
    manager.attach(terminalId, second.port1);
    await sleep(30);
    ptys[0]?.emit('live');
    await sleep(20);
    const text = v.text();
    expect(text).toContain('line one');
    expect(text).toContain('line two');
    expect(text).toContain('while detached');
    expect(text.indexOf('while detached')).toBeLessThan(text.indexOf('live'));
    // The snapshot is one message, not a replay of every chunk.
    expect(v.messages[0]?.type).toBe('data');
    second.port2.close();
  });

  it('pauses the pty when an acking client falls behind and resumes after acks', async () => {
    const { manager, ptys, open } = setup({ highWaterBytes: 1000, lowWaterBytes: 200 });
    const { terminalId } = open();
    const { port1, port2 } = new MessageChannel();
    view(port2);
    manager.attach(terminalId, port1);
    await sleep(10);
    port2.postMessage({ type: 'ack', bytes: 0 });
    await sleep(5);
    ptys[0]?.emit('x'.repeat(1500));
    await sleep(20);
    expect(ptys[0]?.paused).toBe(true);
    port2.postMessage({ type: 'ack', bytes: 1400 });
    await sleep(20);
    expect(ptys[0]?.paused).toBe(false);
    port2.close();
  });

  it('never pauses for clients that do not ack', async () => {
    const { manager, ptys, open } = setup({ highWaterBytes: 100, lowWaterBytes: 10 });
    const { terminalId } = open();
    const { port1, port2 } = new MessageChannel();
    view(port2);
    manager.attach(terminalId, port1);
    ptys[0]?.emit('x'.repeat(5000));
    await sleep(20);
    expect(ptys[0]?.pauseCount).toBe(0);
    port2.close();
  });

  it('reports exit to views, and to a view attached afterwards', async () => {
    const exits: (number | null)[] = [];
    const { manager, ptys, open } = setup({ onExit: (_id, code) => exits.push(code) });
    const { terminalId } = open();
    const a = new MessageChannel();
    const va = view(a.port2);
    manager.attach(terminalId, a.port1);
    await sleep(10);
    ptys[0]?.emit('bye');
    ptys[0]?.emitExit(3);
    await sleep(20);
    expect(va.messages.at(-1)).toEqual({ type: 'exit', code: 3 });
    expect(exits).toEqual([3]);

    const b = new MessageChannel();
    const vb = view(b.port2);
    manager.attach(terminalId, b.port1);
    await sleep(20);
    expect(vb.text()).toContain('bye');
    expect(vb.messages.at(-1)).toEqual({ type: 'exit', code: 3 });
    a.port2.close();
    b.port2.close();
  });

  it('close() kills the process and rejects later attaches', async () => {
    const { manager, ptys, open } = setup();
    const { terminalId } = open();
    expect(manager.close(terminalId)).toBe(true);
    expect(ptys[0]?.killed).toBe(true);
    expect(manager.has(terminalId)).toBe(false);
    expect(manager.close(terminalId)).toBe(false);
    const { port1 } = new MessageChannel();
    expect(() => manager.attach(terminalId, port1)).toThrow(/unknown terminal/);
  });

  it('reuses a live session for the same key', () => {
    const { ptys, open } = setup();
    const a = open({ key: 'attempt:1' });
    const b = open({ key: 'attempt:1', cols: 120, rows: 40 });
    expect(b.reused).toBe(true);
    expect(b.terminalId).toBe(a.terminalId);
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.size).toEqual({ cols: 120, rows: 40 });
  });

  it('kills a detached session after its TTL but not while attached', async () => {
    const { manager, ptys, open } = setup();
    const { terminalId } = open({ detachedTtlMs: 40 });
    const { port1, port2 } = new MessageChannel();
    view(port2);
    manager.attach(terminalId, port1);
    await sleep(80);
    expect(ptys[0]?.killed).toBe(false);
    port2.close();
    await sleep(120);
    expect(ptys[0]?.killed).toBe(true);
    expect(manager.has(terminalId)).toBe(false);
  });
});
