/**
 * Test-only harness: a real temp git repo (with a local bare `origin`), an engine in plain Node with two
 * scripted `FakeEngine`s standing in for Claude and Codex, a fake PR host, an RPC client and the pushed
 * event stream. Not exported from index.ts.
 */
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { SettingsPatch, TaskNode } from '@shared/domain';
import type { AgentEngine } from '@shared/engine';
import type { ServerEvent } from '@shared/events';
import type { EngineToMainMessage } from '@shared/host-protocol';
import type { RpcContract } from '@shared/rpc';
import { createRpcClient, type RpcClient } from '@shared/rpc-transport';
import type { PlanOutput, ReviewOutput, TaskReport } from '@shared/schemas';
import { FakeEngine, type FakeScript, type FakeStep, type FakeTurnContext } from '../adapters/fake';
import { silentLogger } from '../context';
import { type FixtureRepo, makeBare, makeRepo } from '../git/test-helpers';
import { type EngineHandle, startEngine } from '../index';
import type { PtyProcess, PtySpawn } from '../pty';
import { criterionIds, taskIdIn } from './demo';
import { FakePrHost } from './pr-host';

export type EngineName = 'claude' | 'codex';

/** One scripted behaviour for both fake engines; `engine` says which one is playing. */
export type Script = (ctx: FakeTurnContext, engine: EngineName) => FakeStep[];

export interface Harness {
  readonly repo: FixtureRepo;
  readonly origin: string;
  readonly dataDir: string;
  engine: EngineHandle;
  client: RpcClient<RpcContract, ServerEvent>;
  claude: FakeEngine;
  codex: FakeEngine;
  readonly prHost: FakePrHost;
  /** Every event pushed to the client, across restarts. */
  readonly events: ServerEvent[];
  readonly host: EngineToMainMessage[];
  readonly ptys: FakePty[];
  /** Stop the engine (like a crash: in-flight state stays in the DB) and start a new one. */
  restart(script?: Script): Promise<void>;
  waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export class FakePty implements PtyProcess {
  static nextPid = 9000;
  readonly pid = FakePty.nextPid++;
  killed = false;
  private readonly exitListeners: ((event: { exitCode: number }) => void)[] = [];
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly cwd: string,
    readonly env: Record<string, string>,
  ) {}
  onData(): void {}
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListeners.push(listener);
  }
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {
    this.exit(0);
  }
  exit(code: number): void {
    if (this.killed) return;
    this.killed = true;
    for (const listener of this.exitListeners) listener({ exitCode: code });
  }
}

export async function startHarness(options: {
  script: Script;
  files?: Record<string, string>;
  settings?: SettingsPatch;
  /** Make the fakes report the kind they stand in for (attempt rows say claude/codex, takeover works). */
  realKinds?: boolean;
}): Promise<Harness> {
  const repo = await makeRepo({ 'README.md': '# fixture\n', ...options.files });
  const origin = await makeBare(repo.scratch);
  await repo.git('remote', 'add', 'origin', origin);
  await repo.git('push', '-q', '-u', 'origin', 'main');
  const dataDir = join(repo.scratch, 'legion-home');
  const prHost = new FakePrHost();
  const events: ServerEvent[] = [];
  const host: EngineToMainMessage[] = [];
  const ptys: FakePty[] = [];
  const ptySpawn: PtySpawn = (cmd, args, opts) => {
    const pty = new FakePty(cmd, args, opts.cwd, opts.env);
    ptys.push(pty);
    return pty;
  };

  const boot = async (script: Script) => {
    const claude = new FakeEngine({ script: (ctx) => script(ctx, 'claude') });
    const codex = new FakeEngine({ script: (ctx) => script(ctx, 'codex') });
    const engine = await startEngine({
      dataDir,
      env: process.env,
      log: silentLogger,
      engines: options.realKinds
        ? { claude: asKind(claude, 'claude'), codex: asKind(codex, 'codex') }
        : { claude, codex },
      prHost,
      onHostMessage: (message) => host.push(message),
      ptySpawn,
      probeOnStart: false,
    });
    if (options.settings) engine.store.updateSettings(options.settings);
    const channel = new MessageChannel();
    engine.connect(channel.port1);
    const client = createRpcClient<RpcContract, ServerEvent>(channel.port2, { timeoutMs: 30_000 });
    client.onEvents((batch) => events.push(...batch));
    await client.call('subscribe', { sinceSeq: events.at(-1)?.seq ?? 0 });
    return { engine, client, claude, codex };
  };

  let current = options.script;
  const booted = await boot(current);
  const harness: Harness = {
    repo,
    origin,
    dataDir,
    ...booted,
    prHost,
    events,
    host,
    ptys,
    async restart(script) {
      harness.client.close({ closePort: true });
      await harness.engine.close();
      current = script ?? current;
      Object.assign(harness, await boot(current));
    },
    async waitFor(probe, label, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = probe();
        if (value !== null && value !== undefined && value !== false) return value as never;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
    async close() {
      harness.client.close({ closePort: true });
      await harness.engine.close();
      repo.cleanup();
    },
  };
  return harness;
}

/** A fake engine that reports another kind. */
export function asKind(engine: FakeEngine, kind: EngineName): AgentEngine {
  return {
    kind,
    probe: async () => ({ ...(await engine.probe()), kind }),
    start: (opts) => engine.start(opts),
    resume: (id, opts) => engine.resume(id, opts),
  };
}

// -- script building blocks -------------------------------------------------------------------------

export function schemaProps(ctx: FakeTurnContext): string[] {
  const props = (ctx.opts.outputSchema as { properties?: Record<string, unknown> } | null | undefined)?.properties;
  return props ? Object.keys(props) : [];
}

export function plannerKind(ctx: FakeTurnContext): 'clarify' | 'plan' {
  return schemaProps(ctx).includes('questions') ? 'clarify' : 'plan';
}

export function report(summary: string, status: TaskReport['status'] = 'done'): FakeStep {
  const value: TaskReport = {
    status,
    summary,
    commitMessage: summary,
    criteria: [{ id: 'AC1', status: 'met', evidence: 'done' }],
    notes: null,
  };
  return { kind: 'output', value };
}

export function approve(ctx: FakeTurnContext, extra: Partial<ReviewOutput> = {}): FakeStep {
  const value: ReviewOutput = {
    verdict: 'approve',
    criteria: criterionIds(ctx.message).map((id) => ({ id, status: 'met', evidence: 'verified' })),
    findings: [],
    summary: 'Looks good.',
    ...extra,
  };
  return { kind: 'output', value };
}

export function requestChangesOutput(title: string): FakeStep {
  const value: ReviewOutput = {
    verdict: 'request_changes',
    criteria: [{ id: 'AC1', status: 'unmet', evidence: 'missing' }],
    findings: [{ severity: 'blocker', file: null, line: null, title, body: 'Fix it.', suggestedFix: null }],
    summary: 'Needs work.',
  };
  return { kind: 'output', value };
}

export { criterionIds, taskIdIn };

export function node(
  id: string,
  overrides: Partial<TaskNode> & { engine?: 'claude' | 'codex'; writes?: string[] } = {},
): PlanOutput['dag']['nodes'][number] {
  const { engine = 'claude', writes, ...rest } = overrides;
  return {
    id,
    title: `Task ${id}`,
    goal: `Implement ${id}.`,
    kind: 'feature',
    dependsOn: [],
    acceptanceCriteria: [{ id: 'AC1', text: `${id} works` }],
    touches: (writes ?? [`src/${id.toLowerCase()}.txt`]).map((glob) => ({ glob, mode: 'create' as const })),
    size: 'S',
    verify: { commands: [`test -f src/${id.toLowerCase()}.txt`] },
    contextHints: { files: [], notes: '' },
    agent: { engine, model: null, effort: null },
    risk: 'low',
    ...rest,
  } as PlanOutput['dag']['nodes'][number];
}

export function planOutput(nodes: PlanOutput['dag']['nodes']): FakeStep {
  const value: PlanOutput = { markdown: '# Plan\n\n## Summary\n\nTest plan.\n', dag: { nodes } };
  return { kind: 'output', value };
}

/** Re-export for tests that build scripts from scratch. */
export type { FakeScript };
