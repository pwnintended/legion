import { tmpdir } from 'node:os';
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { PtyManager } from './manager';
import { createNodePtySpawn } from './node-pty';

// node-pty is rebuilt for Electron's ABI, so the real-pty check only runs when this file executes inside
// Electron (e.g. `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/engine/pty/node-pty`).
describe.skipIf(!process.versions.electron)('real node-pty (Electron runtime only)', () => {
  it('runs a command and reports its exit code', async () => {
    const spawn = createNodePtySpawn();
    const proc = spawn('/bin/sh', ['-c', 'printf legion-ok; exit 3'], { cwd: tmpdir(), env: {}, cols: 80, rows: 24 });
    let output = '';
    proc.onData((d) => {
      output += d;
    });
    const code = await new Promise<number>((resolve) => proc.onExit((e) => resolve(e.exitCode)));
    expect(output).toContain('legion-ok');
    expect(code).toBe(3);
  });

  it('hydrates a late view through the manager and streams live output', async () => {
    const manager = new PtyManager({ spawn: createNodePtySpawn() });
    const { terminalId } = manager.open({
      cmd: '/bin/sh',
      args: ['-c', 'printf early; sleep 0.3; printf late; sleep 0.3'],
      cwd: tmpdir(),
      env: {},
      cols: 80,
      rows: 24,
    });
    await new Promise((r) => setTimeout(r, 150));
    const { port1, port2 } = new MessageChannel();
    let text = '';
    let exit: number | null | undefined;
    port2.on('message', (m: { type: string; data?: string; code?: number | null }) => {
      if (m.type === 'data') text += m.data;
      if (m.type === 'exit') exit = m.code;
    });
    manager.attach(terminalId, port1);
    await new Promise((r) => setTimeout(r, 800));
    expect(text).toContain('early');
    expect(text).toContain('late');
    expect(exit).toBe(0);
    port2.close();
    manager.dispose();
  });
});
