/**
 * `LEGION_SELFTEST=1`: after start, prove the runtime-sensitive pieces work in this build (used on the
 * packaged app, where native modules come from `app.asar.unpacked`): node-pty spawns a process, node:sqlite
 * answers, the MCP server listens. Logs one `selftest ok …` / `selftest failed …` line.
 */
import { tmpdir } from 'node:os';
import type { EngineHandle } from './index';
import { createNodePtySpawn } from './pty';

export const SELFTEST_ENV = 'LEGION_SELFTEST';
const MARKER = 'legion-pty-ok';

export async function selfTest(engine: EngineHandle): Promise<string> {
  const spawn = createNodePtySpawn();
  const output = await new Promise<string>((resolve, reject) => {
    const proc = spawn('/bin/echo', [MARKER], { cwd: tmpdir(), env: { ...engine.ctx.env }, cols: 80, rows: 24 });
    let data = '';
    const timer = setTimeout(() => reject(new Error('pty did not exit within 10 s')), 10_000);
    proc.onData((chunk) => {
      data += chunk;
    });
    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0) reject(new Error(`pty exited with ${exitCode}`));
      else resolve(data);
    });
  });
  if (!output.includes(MARKER)) throw new Error(`unexpected pty output ${JSON.stringify(output)}`);
  const head = engine.store.headSeq();
  return `node-pty ok, node:sqlite schema v${engine.ctx.schemaVersion} (head seq ${head}), mcp ${engine.mcp.url}`;
}
