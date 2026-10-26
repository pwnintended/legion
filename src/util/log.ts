import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Appends to a log file: the TUI owns the terminal, so nothing may write to stdout/stderr behind its back. */
export function fileLogger(path: string): Logger {
  mkdirSync(dirname(path), { recursive: true });
  const write = (level: string, message: string, args: unknown[]) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${level} ${format(message, ...args)}\n`);
    } catch {
      // Logging must never take the session down.
    }
  };
  return {
    info: (m, ...a) => write('INFO', m, a),
    warn: (m, ...a) => write('WARN', m, a),
    error: (m, ...a) => write('ERROR', m, a),
  };
}
