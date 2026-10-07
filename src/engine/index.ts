/**
 * Engine entry. Runs in two modes:
 * - Electron utilityProcess (`process.parentPort` exists): main sends `connect` messages carrying one
 *   MessagePort per renderer; see `shared/host-protocol.ts`.
 * - Plain Node (tests, future headless mode): call `startEngine()` and `handle.connect(port)` yourself.
 *
 * This module must never import `electron`.
 */
import { join } from 'node:path';
import type { EngineKind } from '@shared/domain';
import type { AgentEngine } from '@shared/engine';
import type { ServerEvent } from '@shared/events';
import type { EngineToMainMessage, MainToEngineMessage } from '@shared/host-protocol';
import { ENGINE_ENV } from '@shared/host-protocol';
import type { MessageEndpoint, PortLike, RpcConnection } from '@shared/rpc-transport';
import { AttachmentService, registerAttachmentHandlers } from './attachments';
import { consoleLogger, type EngineContext, type Logger } from './context';
import { openStore, type Store } from './db';
import { type McpServerHandle, startMcpServer } from './mcp';
import {
  createOrchestrator,
  EngineRegistry,
  FAKE_ENGINES_ENV,
  FakePrHost,
  ghPrHost,
  type Orchestrator,
  type PrHost,
  recover,
  registerOrchestratorHandlers,
  resolveAttemptTerminal,
  trackPtyExits,
} from './orchestrator';
import { registerProjectHandlers } from './projects';
import { createNodePtySpawn, type PtySpawn, registerTerminalHandlers, type TerminalService } from './pty';
import { registerCoreHandlers } from './rpc/core';
import { createEngineRpcServer, type EngineRpcServer } from './rpc/server';
import { SELFTEST_ENV, selfTest } from './selftest';

export interface StartEngineOptions {
  /** Data directory; the DB lives at `<dataDir>/legion.db`. */
  dataDir: string;
  /** Environment for child processes. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  version?: string;
  log?: Logger;
  /** Override the clock (tests). */
  now?: () => number;
  /** Serve every engine kind with the scripted fake. Default: `LEGION_FAKE_ENGINES=1` in `env`. */
  fakeEngines?: boolean;
  /** Delay between scripted fake steps in fake-engine mode (default 120 ms, so the UI can follow). */
  fakeStepDelayMs?: number;
  /** Engines per kind (tests inject fakes standing in for claude / codex). */
  engines?: Partial<Record<EngineKind, AgentEngine>>;
  /** GitHub side of the PR step. Default: `gh` (a push-less fake in fake-engine mode). */
  prHost?: PrHost;
  /** Engine → main messages (notify / badge / power). */
  onHostMessage?: (message: EngineToMainMessage) => void;
  /** PTY spawn (tests inject a fake; default node-pty, loaded lazily). */
  ptySpawn?: PtySpawn;
  /** Probe the engines right away (default true). */
  probeOnStart?: boolean;
  /** Reconcile the DB with reality and resume work (default true). */
  recover?: boolean;
  /** Interval of the open-PR status poll (default 3 min; 0 = off). */
  prPollMs?: number;
}

export interface EngineHandle {
  readonly ctx: EngineContext;
  readonly store: Store;
  readonly server: EngineRpcServer;
  readonly orchestrator: Orchestrator;
  readonly registry: EngineRegistry;
  readonly terminals: TerminalService;
  readonly mcp: McpServerHandle;
  /** Settles when crash recovery has finished (work is resumed in the background). */
  readonly ready: Promise<void>;
  /** Attach a renderer (or test) port; the connection closes when the port does. */
  connect(port: PortLike | MessageEndpoint): RpcConnection<ServerEvent>;
  /** Stop agents (state stays resumable), close connections, the MCP server and the database. */
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
  registerProjectHandlers(server, ctx);

  const fake = options.fakeEngines ?? env[FAKE_ENGINES_ENV] === '1';
  const registry = new EngineRegistry({
    dataDir: options.dataDir,
    env,
    version: ctx.version,
    log,
    settings: () => opened.store.getSettings(),
    fake,
    ...(options.engines ? { overrides: options.engines } : {}),
    ...(options.fakeStepDelayMs !== undefined ? { fakeStepDelayMs: options.fakeStepDelayMs } : {}),
  });
  const attachments = new AttachmentService({ dataDir: options.dataDir, store: opened.store, log });
  const stopAttachmentGc = registerAttachmentHandlers(server, attachments, log);
  const orchestrator = createOrchestrator({
    ctx,
    attachments,
    registry,
    prHost: options.prHost ?? (fake ? new FakePrHost({ push: false }) : ghPrHost),
    ...(options.onHostMessage ? { host: options.onHostMessage } : {}),
    ...(options.prPollMs !== undefined ? { prPollMs: options.prPollMs } : {}),
  });
  // Engine paths (and anything else engine-related) apply without a restart.
  const offSettings = opened.store.onEvents((events) => {
    if (events.some((e) => e.type === 'settings.updated')) registry.reconfigure();
  });

  let mcp: McpServerHandle;
  try {
    mcp = await startMcpServer({
      host: orchestrator.mcpHost,
      log: (level, message, extra) => log[level](`mcp: ${message}`, ...(extra ? [extra] : [])),
    });
  } catch (error) {
    opened.close();
    throw error;
  }
  orchestrator.mcp = mcp;

  const pty = trackPtyExits(options.ptySpawn ?? createNodePtySpawn());
  const terminals = registerTerminalHandlers(server, ctx, {
    spawn: pty.spawn,
    resolveAttempt: (attemptId) => resolveAttemptTerminal(orchestrator, attemptId),
  });
  orchestrator.terminals = terminals;
  orchestrator.ptyExit = pty.exitOf;
  registerOrchestratorHandlers(server, orchestrator);

  if (options.probeOnStart ?? true) void registry.probe().catch(() => undefined);
  const ready =
    options.recover === false
      ? Promise.resolve()
      : recover(orchestrator).catch((error: unknown) => log.error('recovery failed', error));

  let closed = false;
  return {
    ctx,
    store: opened.store,
    server,
    orchestrator,
    registry,
    terminals,
    mcp,
    ready,
    connect: (port) => server.connect(port),
    async close() {
      if (closed) return;
      closed = true;
      await ready;
      offSettings();
      stopAttachmentGc();
      await orchestrator.close();
      terminals.dispose();
      await mcp.close();
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

  startEngine({ dataDir, onHostMessage: post })
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
      post({ type: 'badge', count: engine.orchestrator.openInboxCount() });
      consoleLogger.info(
        `ready (pid ${process.pid}, data ${dataDir}${engine.registry.fakeMode ? ', scripted fake engines' : ''})`,
      );
      if (process.env[SELFTEST_ENV] === '1') {
        selfTest(engine).then(
          (summary) => consoleLogger.info(`selftest ok: ${summary}`),
          (error: unknown) => consoleLogger.error(`selftest failed: ${(error as Error).message}`),
        );
      }
    })
    .catch((error: unknown) => {
      console.error('[engine] failed to start', error);
      process.exit(1);
    });
}
