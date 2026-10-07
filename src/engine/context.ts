import type { Store } from './db';

/** Shared state handed to every RPC handler module. */
export interface EngineContext {
  readonly dataDir: string;
  readonly dbPath: string;
  /** Environment for child processes (login-shell PATH resolved by main). */
  readonly env: Readonly<Record<string, string>>;
  readonly store: Store;
  readonly version: string;
  readonly startedAt: number;
  readonly schemaVersion: number;
  readonly log: Logger;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (message, ...args) => console.log(`[engine] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[engine] ${message}`, ...args),
  error: (message, ...args) => console.error(`[engine] ${message}`, ...args),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
