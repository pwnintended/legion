import { EventEmitter } from 'node:events';
import { ENGINE_PORT_MESSAGE, IPC } from '@shared/bridge';
import type { EngineToMainMessage, MainToEngineMessage } from '@shared/host-protocol';
import { ENGINE_ENV } from '@shared/host-protocol';
import { backoffMs } from '@shared/util';
import { MessageChannelMain, type UtilityProcess, utilityProcess, type WebContents } from 'electron';

export interface EngineSupervisorOptions {
  /** Built engine entry (out/main/engine.js). */
  entry: string;
  dataDir: string;
  version: string;
  /** Resolved lazily (login-shell PATH lookup) right before each spawn. */
  env: () => Promise<Record<string, string>>;
}

interface SupervisorEvents {
  message: [EngineToMainMessage];
  ready: [{ pid: number; generation: number }];
  exit: [{ code: number; restarting: boolean }];
}

/**
 * Owns the engine utilityProcess: spawns it, restarts it with exponential backoff when it crashes, and
 * wires a fresh MessageChannelMain between the engine and each renderer — on renderer request (load or
 * reload) and again for every renderer after an engine restart.
 */
export class EngineSupervisor extends EventEmitter<SupervisorEvents> {
  private child: UtilityProcess | null = null;
  private ready = false;
  private stopping = false;
  private crashes = 0;
  private generation = 0;
  private healthyTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Set<WebContents>();
  private clientCounter = 0;

  constructor(private readonly options: EngineSupervisorOptions) {
    super();
  }

  get isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const env = await this.options.env();
    if (this.stopping) return;
    const child = utilityProcess.fork(this.options.entry, [], {
      serviceName: 'Legion Engine',
      stdio: 'pipe',
      env: {
        ...env,
        [ENGINE_ENV.home]: this.options.dataDir,
        [ENGINE_ENV.version]: this.options.version,
      },
    });
    this.child = child;
    this.generation += 1;
    const generation = this.generation;

    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));

    child.on('message', (message: EngineToMainMessage) => {
      if (message.type === 'ready') {
        this.ready = true;
        // Consider the engine healthy after a minute; then reset the crash counter.
        this.healthyTimer = setTimeout(() => {
          this.crashes = 0;
        }, 60_000);
        this.emit('ready', { pid: message.pid, generation });
        for (const contents of this.clients) this.wire(contents);
      }
      this.emit('message', message);
    });

    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      if (this.healthyTimer) clearTimeout(this.healthyTimer);
      const restarting = !this.stopping;
      this.emit('exit', { code, restarting });
      if (restarting) {
        const delay = backoffMs(this.crashes);
        this.crashes += 1;
        console.error(`[main] engine exited with code ${code}; restarting in ${delay} ms`);
        this.restartTimer = setTimeout(() => void this.start(), delay);
      }
    });
  }

  /** Register a renderer; it gets a port now (if the engine is ready) and after every restart. */
  attach(contents: WebContents): void {
    if (!this.clients.has(contents)) {
      this.clients.add(contents);
      contents.once('destroyed', () => this.clients.delete(contents));
    }
    if (this.ready) this.wire(contents);
  }

  private wire(contents: WebContents): void {
    const child = this.child;
    if (!child || !this.ready || contents.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.clientCounter += 1;
    const connect: MainToEngineMessage = { type: 'connect', clientId: `renderer-${contents.id}-${this.clientCounter}` };
    child.postMessage(connect, [port1]);
    contents.postMessage(IPC.enginePort, { type: ENGINE_PORT_MESSAGE, generation: this.generation }, [port2]);
  }

  send(message: MainToEngineMessage): void {
    this.child?.postMessage(message);
  }

  /** Ask the engine to shut down cleanly; kill it if it doesn't exit in time. */
  async stop(timeoutMs = 3000): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: 'shutdown' } satisfies MainToEngineMessage);
    });
  }
}
