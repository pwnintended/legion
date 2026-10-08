/**
 * Engine registry: one `AgentEngine` per engine kind, plus cached probe results (`engines.list`).
 *
 * With `fake: true` (`LEGION_FAKE_ENGINES=1`) every kind is served by the scripted `FakeEngine`, so the
 * whole app runs without real CLIs (tests, demos). Tests can also inject engines per kind.
 *
 * `reconfigure()` (called on every `settings.updated`) rebuilds an engine whose binary path changed, so a
 * new path takes effect for the next session without a restart. Live sessions keep the engine instance
 * they were started with; models and `enabled` are read from the settings at each session start anyway.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type EngineKind, REAL_ENGINE_KINDS, type RealEngineKind, type Settings } from '@shared/domain';
import type { AgentEngine, EngineInfo } from '@shared/engine';
import { ClaudeEngine } from '../adapters/claude';
import { CodexEngine } from '../adapters/codex';
import { FakeEngine } from '../adapters/fake';
import type { Logger } from '../context';
import { demoScript } from './demo';

export const FAKE_ENGINES_ENV = 'LEGION_FAKE_ENGINES';

export interface EngineRegistryOptions {
  dataDir: string;
  env: Readonly<Record<string, string>>;
  version: string;
  log: Logger;
  settings: () => Settings;
  /** Serve every kind with the scripted fake engine. */
  fake: boolean;
  /** Per-kind engines (tests). */
  overrides?: Partial<Record<EngineKind, AgentEngine>>;
  /** Delay between fake steps (demo mode default 120 ms). */
  fakeStepDelayMs?: number;
}

export type Usability = { ok: true } | { ok: false; reason: string };

const KINDS: readonly EngineKind[] = ['claude', 'codex', 'fake'];

export class EngineRegistry {
  /** Legion-owned CODEX_HOME (threads live there; resume and takeover need it). */
  readonly codexHome: string;
  private readonly engines: Record<EngineKind, AgentEngine>;
  private readonly infos = new Map<EngineKind, EngineInfo>();
  private readonly probing = new Map<EngineKind, Promise<EngineInfo>>();
  /** Binary paths the real engines were built with. */
  private paths: Record<RealEngineKind, string | null>;

  constructor(private readonly options: EngineRegistryOptions) {
    this.codexHome = join(options.dataDir, 'codex-home');
    const settings = options.settings();
    const overrides = options.overrides ?? {};
    const fake = overrides.fake ?? new FakeEngine({ script: demoScript, stepDelayMs: options.fakeStepDelayMs ?? 120 });
    this.paths = { claude: expandHome(settings.engines.claude.path), codex: expandHome(settings.engines.codex.path) };
    this.engines = {
      fake,
      claude: overrides.claude ?? (options.fake ? fake : this.build('claude', this.paths.claude)),
      codex: overrides.codex ?? (options.fake ? fake : this.build('codex', this.paths.codex)),
    };
  }

  private build(kind: RealEngineKind, path: string | null): AgentEngine {
    const { options } = this;
    if (kind === 'claude') return new ClaudeEngine({ env: options.env, binaryPath: path, log: options.log });
    return new CodexEngine({
      codexHome: this.codexHome,
      env: options.env,
      ...(path ? { binary: path } : {}),
      clientVersion: options.version,
      onStderr: (line) => options.log.warn(`codex: ${line}`),
    });
  }

  /**
   * Apply engine settings that need a new engine instance (binary paths). Returns the kinds that were
   * rebuilt (and re-probed in the background). Injected and fake engines are never replaced.
   */
  reconfigure(): RealEngineKind[] {
    const settings = this.options.settings();
    const rebuilt: RealEngineKind[] = [];
    for (const kind of REAL_ENGINE_KINDS) {
      const path = expandHome(settings.engines[kind].path);
      if (path === this.paths[kind]) continue;
      this.paths[kind] = path;
      if (this.options.fake || this.options.overrides?.[kind]) continue;
      this.engines[kind] = this.build(kind, path);
      this.infos.delete(kind);
      this.probing.delete(kind);
      rebuilt.push(kind);
      this.options.log.info(`engine ${kind}: binary path changed to ${path ?? '(PATH lookup)'}`);
      void this.probeOne(kind);
    }
    return rebuilt;
  }

  get fakeMode(): boolean {
    return this.options.fake;
  }

  get(kind: EngineKind): AgentEngine {
    return this.engines[kind];
  }

  /** True when `kind` is served by a scripted fake (takeover is impossible). */
  isFake(kind: EngineKind): boolean {
    return this.engines[kind].kind === 'fake';
  }

  /** Last probe result of `kind`, if probed. */
  info(kind: EngineKind): EngineInfo | null {
    return this.infos.get(kind) ?? null;
  }

  /** Probe one kind (deduplicated while in flight). Never throws. */
  probeOne(kind: EngineKind): Promise<EngineInfo> {
    const inFlight = this.probing.get(kind);
    if (inFlight) return inFlight;
    const engine = this.engines[kind];
    const promise = engine
      .probe()
      .catch(
        (error: unknown): EngineInfo => ({
          kind: engine.kind,
          installed: false,
          path: null,
          version: null,
          loggedIn: null,
          account: null,
          models: [],
          error: `probe failed: ${(error as Error).message}`,
          probedAt: Date.now(),
        }),
      )
      .then((raw) => {
        const info: EngineInfo =
          engine.kind === 'fake' && kind !== 'fake'
            ? { ...raw, kind, account: `scripted fake (${FAKE_ENGINES_ENV}=1)` }
            : { ...raw, kind };
        if (this.engines[kind] === engine) this.infos.set(kind, info);
        if (info.error) this.options.log.warn(`engine ${kind}: ${info.error}`);
        return info;
      })
      .finally(() => {
        if (this.probing.get(kind) === promise) this.probing.delete(kind);
      });
    this.probing.set(kind, promise);
    return promise;
  }

  async probe(kind: EngineKind | null = null): Promise<EngineInfo[]> {
    const kinds = kind ? [kind] : this.listedKinds();
    await Promise.all(kinds.map((k) => this.probeOne(k)));
    return this.listedKinds()
      .map((k) => this.infos.get(k))
      .filter((info): info is EngineInfo => info !== undefined);
  }

  /** Cached results; probes kinds that were never probed. */
  async list(): Promise<EngineInfo[]> {
    const missing = this.listedKinds().filter((k) => !this.infos.has(k));
    await Promise.all(missing.map((k) => this.probeOne(k)));
    return this.listedKinds().map((k) => this.infos.get(k) as EngineInfo);
  }

  /**
   * Can a session be started on `kind`? Based on settings and the last probe (an unprobed engine is
   * assumed usable; the session start will fail loudly if it is not).
   */
  usable(kind: EngineKind): Usability {
    if (kind !== 'fake' && !this.options.settings().engines[kind].enabled && !this.isFake(kind)) {
      return { ok: false, reason: `${kind} is disabled in settings` };
    }
    const info = this.infos.get(kind);
    if (!info) return { ok: true };
    if (!info.installed) return { ok: false, reason: info.error ?? `${kind} is not installed` };
    if (info.loggedIn === false) return { ok: false, reason: info.error ?? `${kind} is not logged in` };
    return { ok: true };
  }

  /** The `fake` kind is only listed when something uses it (fake mode or an injected engine). */
  private listedKinds(): EngineKind[] {
    return KINDS.filter((k) => k !== 'fake' || this.options.fake || this.options.overrides?.fake !== undefined);
  }
}

/** A settings path with `~` (`~/…`, `~\…`) put in for the home directory. */
function expandHome(path: string | null): string | null {
  return path ? path.replace(/^~(?=$|[\\/])/, homedir()) : path;
}
