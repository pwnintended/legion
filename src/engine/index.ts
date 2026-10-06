/**
 * Engine entry. Runs in two modes:
 * - Electron utilityProcess (`process.parentPort` exists): main sends `connect` messages carrying one
 *   MessagePort per renderer; see `shared/host-protocol.ts`.
 * - Plain Node (tests, future headless mode): call `startEngine()` and `handle.connect(port)` yourself.
 *
 * This module must never import `electron`.
 */
import { join } from 'node:path';
import type { ServerEvent } from '@shared/events';
import type { EngineToMainMessage, MainToEngineMessage } from '@shared/host-protocol';
import { ENGINE_ENV } from '@shared/host-protocol';
import type { MessageEndpoint, PortLike, RpcConnection } from '@shared/rpc-transport';
import { consoleLogger, type EngineContext, type Logger } from './context';
import { openStore, type Store } from './db';
import { registerCoreHandlers } from './rpc/core';
import { createEngineRpcServer, type EngineRpcServer } from './rpc/server';

export interface StartEngineOptions {
  /** Data directory; the DB lives at `<dataDir>/legion.db`. */
  dataDir: string;
  /** Environment for child processes. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  version?: string;
  log?: Logger;
  /** Override the clock (tests). */
  now?: () => number;
}

export interface EngineHandle {
  readonly ctx: EngineContext;
  readonly store: Store;
  readonly server: EngineRpcServer;
  /** Attach a renderer (or test) port; the connection closes when the port does. */
  connect(port: PortLike | MessageEndpoint): RpcConnection<ServerEvent>;
  /** Close all connections and the database. */
  close(): Promise<void>;
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

export async function startEngine(options: StartEngineOptions): Promise<EngineHandle> {
  const log = options.log ?? consoleLogger;
  const dbPath = join(options.dataDir, 'legion.db');
  const opened = openStore(dbPath, { now: options.now });
  const env = cleanEnv(options.env ?? process.env);
  const ctx: EngineContext = {
    dataDir: options.dataDir,
    dbPath,
    env,
    store: opened.store,
    version: options.version ?? env[ENGINE_ENV.version] ?? '0.0.0-dev',
    startedAt: (options.now ?? Date.now)(),
    schemaVersion: opened.schemaVersion,
    log,
  };
  const server = createEngineRpcServer(ctx);
  registerCoreHandlers(server, ctx);

  let closed = false;
  return {
    ctx,
    store: opened.store,
    server,
    connect: (port) => server.connect(port),
    async close() {
      if (closed) return;
      closed = true;
      server.close();
      opened.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// utilityProcess bootstrap
// ---------------------------------------------------------------------------------------------

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown; ports: unknown[] }) => void): unknown;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (parentPort) {
  const port = parentPort;
  const post = (message: EngineToMainMessage): void => port.postMessage(message);
  const dataDir = process.env[ENGINE_ENV.home];
  if (!dataDir) {
    console.error(`[engine] ${ENGINE_ENV.home} is not set`);
    process.exit(2);
  }

  startEngine({ dataDir })
    .then((engine) => {
      port.on('message', (event) => {
        const message = event.data as MainToEngineMessage;
        if (message.type === 'connect') {
          const rendererPort = event.ports[0] as PortLike | undefined;
          if (rendererPort) engine.connect(rendererPort);
        } else if (message.type === 'shutdown') {
          void engine.close().finally(() => process.exit(0));
        }
      });
      post({ type: 'ready', pid: process.pid, dataDir });
      consoleLogger.info(`ready (pid ${process.pid}, data ${dataDir})`);
    })
    .catch((error: unknown) => {
      console.error('[engine] failed to start', error);
      process.exit(1);
    });
}
