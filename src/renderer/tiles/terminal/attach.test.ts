import type { RpcInput } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { describe, expect, it } from 'vitest';
import { type OpenCall, openOrAttach } from './attach';

const shell = { kind: 'shell', cwd: '/repo' } as const;

function fakeEngine(live: string[]) {
  const calls: RpcInput<'terminals.open'>[] = [];
  let next = 1;
  const call: OpenCall = async (input, options) => {
    calls.push(input);
    expect(options.transfer).toHaveLength(1);
    if (input.terminalId) {
      if (!live.includes(input.terminalId)) throw new RpcError('not_found', `unknown terminal ${input.terminalId}`);
      return { terminalId: input.terminalId, pid: 1 };
    }
    const terminalId = `term_new${next++}`;
    live.push(terminalId);
    return { terminalId, pid: 2 };
  };
  return { call, calls };
}

describe('openOrAttach', () => {
  it('re-attaches to the terminal the tile opened before instead of spawning a new shell', async () => {
    const engine = fakeEngine(['term_a']);
    const opened = await openOrAttach(engine.call, { target: shell, terminalId: 'term_a', cols: 80, rows: 24 });
    expect(opened).toMatchObject({ terminalId: 'term_a', reattached: true });
    expect(engine.calls).toEqual([{ target: shell, cols: 80, rows: 24, terminalId: 'term_a' }]);
    opened.port.close();
  });

  it('opens a new terminal when the old one is gone (reaped, engine restarted)', async () => {
    const engine = fakeEngine([]);
    const opened = await openOrAttach(engine.call, { target: shell, terminalId: 'term_gone', cols: 80, rows: 24 });
    expect(opened).toMatchObject({ terminalId: 'term_new1', reattached: false });
    expect(engine.calls.map((c) => c.terminalId)).toEqual(['term_gone', null]);
    opened.port.close();
  });

  it('opens by target when the tile has no terminal yet, and surfaces other errors', async () => {
    const engine = fakeEngine([]);
    const opened = await openOrAttach(engine.call, { target: shell, terminalId: null, cols: 100, rows: 30 });
    expect(opened).toMatchObject({ terminalId: 'term_new1', reattached: false });
    opened.port.close();
    const failing: OpenCall = async () => {
      throw new RpcError('bad_request', 'not a directory: /nope');
    };
    await expect(openOrAttach(failing, { target: shell, terminalId: 'term_a', cols: 80, rows: 24 })).rejects.toThrow(
      'not a directory',
    );
  });
});
