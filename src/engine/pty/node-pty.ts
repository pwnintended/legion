import { createRequire } from 'node:module';
import type { PtySpawn } from './types';

/**
 * Spawns through node-pty, loaded on the first spawn so code that never opens a terminal (and plain-Node
 * unit tests) never touches the native module. It only loads in the runtime it was rebuilt for (Electron).
 */
export function createNodePtySpawn(): PtySpawn {
  let pty: typeof import('node-pty') | null = null;
  return (cmd, args, options) => {
    pty ??= createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
    return pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
    });
  };
}
