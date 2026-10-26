import { spawn } from 'node:child_process';
import type { ShellOptions, ShellResult } from './host.ts';

const MAX_BUFFER = 4 * 1024 * 1024;

/** Runs `command` with `/bin/sh -c`, collecting output (capped). Never rejects: failures are a non-zero code. */
export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    let stdout = '';
    let stderr = '';
    const take = (current: string, chunk: Buffer) =>
      current.length < MAX_BUFFER ? current + chunk.toString('utf8') : current;
    child.stdout.on('data', (c: Buffer) => {
      stdout = take(stdout, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = take(stderr, c);
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    const done = (code: number, extra = '') => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra });
    };
    child.on('error', (err) => done(127, err.message));
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}
