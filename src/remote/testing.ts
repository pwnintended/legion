/**
 * Test helpers for remote mode (not used in production code): `LocalBoxes`, a `BoxProvider` whose boxes are
 * directories on this machine. A box's filesystem is `<root>/<box>/`: absolute paths under the given prefixes (the
 * worktrees, `/tmp/legion-…`) are moved under it in arguments and working directories, and `HOME` is the box's own,
 * so the real box scripts and git run unchanged.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BoxProvider, RemoteBox, RemoteProcess } from './box.ts';

export class LocalBoxes implements BoxProvider {
  readonly boxes = new Map<string, LocalBox>();
  readonly removed: string[] = [];
  private readonly root: string;
  private readonly prefixes: readonly string[];

  /** `prefixes`: the absolute paths that live inside a box (besides `/tmp/legion-`). */
  constructor(root: string, prefixes: readonly string[]) {
    this.root = root;
    this.prefixes = [...prefixes, '/tmp/legion-'];
  }

  async open(name: string, labels: readonly string[]): Promise<{ box: RemoteBox; created: boolean }> {
    const existing = this.boxes.get(name);
    if (existing) return { box: existing, created: false };
    const box = new LocalBox(name, join(this.root, name), this.prefixes, labels);
    this.boxes.set(name, box);
    return { box, created: true };
  }

  async removeLabeled(label: string): Promise<void> {
    for (const [name, box] of this.boxes) {
      if (box.labels.includes(label)) {
        this.boxes.delete(name);
        this.removed.push(name);
      }
    }
  }
}

export class LocalBox implements RemoteBox {
  readonly id: string;
  readonly root: string;
  readonly home: string;
  readonly labels: readonly string[];
  /** Every argv started in this box. */
  readonly started: string[][] = [];
  private readonly prefixes: readonly string[];

  constructor(id: string, root: string, prefixes: readonly string[], labels: readonly string[]) {
    this.id = id;
    this.root = root;
    this.home = join(root, 'home');
    this.prefixes = prefixes;
    this.labels = labels;
    mkdirSync(this.home, { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
  }

  /** Where a box path is on this machine. */
  path(p: string): string {
    return this.prefixes.some((prefix) => p.startsWith(prefix)) ? join(this.root, p) : p;
  }

  async start(argv: readonly string[], opts: Parameters<RemoteBox['start']>[1]): Promise<RemoteProcess> {
    this.started.push([...argv]);
    const [command, ...args] = argv.map((a) => this.path(a));
    const cwd = opts.cwd ? this.path(opts.cwd) : this.home;
    const child = spawn(command as string, args, {
      cwd,
      env: { ...process.env, HOME: this.home, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => opts.onStdout(d));
    child.stderr.on('data', (d: Buffer) => opts.onStderr(d));
    child.stdin.on('error', () => undefined);
    const exit = new Promise<number>((resolve) => {
      child.once('error', () => resolve(127));
      child.once('close', (code) => resolve(code ?? -1));
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return {
      write: (data) => child.stdin.write(data),
      endStdin: () => child.stdin.end(),
      kill: (signal) => child.kill(`SIG${signal ?? 'TERM'}` as NodeJS.Signals),
      wait: () => exit,
      close: () => {
        if (child.exitCode === null) child.kill('SIGKILL');
      },
    };
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    mkdirSync(dirname(this.path(path)), { recursive: true });
    await writeFile(this.path(path), content);
  }

  async upload(localPath: string, path: string): Promise<void> {
    await this.writeFile(path, await readFile(localPath));
  }

  async readFile(path: string): Promise<Buffer> {
    return readFile(this.path(path));
  }

  async delete(): Promise<void> {}
}
