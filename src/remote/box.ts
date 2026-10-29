/**
 * The little Legion needs from a remote machine: start a process (stdin, streamed output, signals, exit code) and
 * move files in and out. `UpstashBoxes` provides it over the Upstash Box SDK; tests use a local fake.
 */
import { Box, BoxError, EphemeralBox } from '@upstash/box';
import type { RemoteConfig } from '../config.ts';

export interface RemoteProcess {
  write(data: string | Uint8Array): void;
  endStdin(): void;
  /** Signal name without `SIG` (`TERM`, `INT`, `KILL`). */
  kill(signal?: string): void;
  /** The exit code; -1 when the connection was torn down while it ran. */
  wait(): Promise<number>;
  /** Drops the connection, which ends the process. */
  close(): void;
}

export interface StartOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  onStdout(data: Uint8Array): void;
  onStderr(data: Uint8Array): void;
}

export interface RemoteBox {
  readonly id: string;
  /** Runs `argv` without a shell. Resolves once the process has started. */
  start(argv: readonly string[], opts: StartOptions): Promise<RemoteProcess>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  /** Copies a local file into the box (multipart; for large files such as git bundles). */
  upload(localPath: string, path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  /** Saves the box's filesystem as a snapshot (waits until it is ready); returns its id. */
  snapshot(name: string): Promise<string>;
  delete(): Promise<void>;
}

export interface BoxProvider {
  /**
   * The box called `name`: reattached when it exists (`created: false`), else made from the snapshot `from` (null:
   * a fresh box).
   */
  open(name: string, labels: readonly string[], from: string | null): Promise<{ box: RemoteBox; created: boolean }>;
  deleteSnapshot(id: string): Promise<void>;
  /** Deletes every box carrying `label`. */
  removeLabeled(label: string): Promise<void>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** Runs `argv` in `box` to the end and collects its output (capped). Never rejects for a non-zero exit. */
export async function exec(
  box: RemoteBox,
  argv: readonly string[],
  opts: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    stdin?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ExecResult> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  const proc = await box.start(argv, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    onStdout: (data) => {
      if (outBytes < MAX_OUTPUT) out.push(Buffer.from(data));
      outBytes += data.length;
    },
    onStderr: (data) => {
      if (errBytes < MAX_OUTPUT) err.push(Buffer.from(data));
      errBytes += data.length;
    },
  });
  if (opts.stdin !== undefined) proc.write(opts.stdin);
  proc.endStdin();
  const stop = () => proc.kill('TERM');
  const timer = opts.timeoutMs ? setTimeout(stop, opts.timeoutMs) : null;
  opts.signal?.addEventListener('abort', stop, { once: true });
  try {
    const code = await proc.wait();
    return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
    proc.close();
  }
}

/** Like {@link exec}, but a non-zero exit throws with the command's stderr. */
export async function execOk(
  box: RemoteBox,
  argv: readonly string[],
  opts: Parameters<typeof exec>[2] = {},
): Promise<string> {
  const result = await exec(box, argv, opts);
  if (result.code !== 0) {
    const what = argv[0] === 'bash' ? 'box script' : argv.join(' ');
    throw new Error(
      `${what} failed (exit ${result.code}) in box ${box.id}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

/** Boxes on Upstash (`[remote]`), authenticated with the Box API key. */
export class UpstashBoxes implements BoxProvider {
  private readonly config: () => RemoteConfig;
  private readonly apiKey: string;

  constructor(config: () => RemoteConfig, apiKey: string) {
    this.config = config;
    this.apiKey = apiKey;
  }

  async open(
    name: string,
    labels: readonly string[],
    from: string | null,
  ): Promise<{ box: RemoteBox; created: boolean }> {
    const settings = this.config();
    const existing = await this.find(name);
    if (existing) return { box: wrap(existing), created: false };
    const config = {
      apiKey: this.apiKey,
      name,
      labels: [...labels],
      size: settings.size,
      ttl: settings.ttlHours * 3600,
      enableTelemetry: false,
    };
    // Ephemeral: Upstash deletes it after the TTL even when Legion never does.
    const box = from
      ? await EphemeralBox.fromSnapshot(from, config)
      : await EphemeralBox.create({ ...config, runtime: settings.runtime });
    return { box: wrap(box), created: true };
  }

  async deleteSnapshot(id: string): Promise<void> {
    await Box.deleteSnapshots({ apiKey: this.apiKey, snapshotIds: id, enableTelemetry: false });
  }

  async removeLabeled(label: string): Promise<void> {
    const boxes = await Box.list({ apiKey: this.apiKey, label, enableTelemetry: false });
    if (boxes.length > 0)
      await Box.delete({ apiKey: this.apiKey, boxIds: boxes.map((b) => b.id), enableTelemetry: false });
  }

  private async find(name: string): Promise<Box | null> {
    try {
      return await Box.getByName(name, { apiKey: this.apiKey, enableTelemetry: false });
    } catch (err) {
      if (err instanceof BoxError && err.statusCode === 404) return null;
      throw err;
    }
  }
}

const START_ATTEMPTS = 3;

function wrap(box: Box | EphemeralBox): RemoteBox {
  return {
    id: box.id,
    async start(argv, opts) {
      const open = () =>
        box.exec.session({
          argv: [...argv],
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
          onStdout: opts.onStdout,
          onStderr: opts.onStderr,
        });
      // Upstash now and then refuses a session before it starts ("could not determine session pid"): try again.
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      for (let attempt = 1; !handle; attempt++) {
        try {
          handle = await open();
        } catch (err) {
          if (attempt >= START_ATTEMPTS || !/exec-session error/.test((err as Error).message)) throw err;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      return {
        write: (data) => handle.write(data),
        endStdin: () => handle.endStdin(),
        kill: (signal) => handle.kill(signal ?? 'TERM'),
        wait: () => handle.wait(),
        close: () => handle.close(),
      };
    },
    writeFile: (path, content) =>
      box.files.write({ path, content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
    upload: (localPath, path) => box.files.upload([{ path: localPath, destination: path }]),
    readFile: async (path) => Buffer.from(await box.files.read(path, { encoding: 'base64' }), 'base64'),
    snapshot: async (name) => (await box.snapshot({ name })).id,
    delete: () => box.delete(),
  };
}
