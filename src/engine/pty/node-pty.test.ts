import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
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
});
