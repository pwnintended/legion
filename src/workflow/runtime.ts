/**
 * Executes a workflow with step memoization. Every SDK primitive (`agent`, `gate`, `sh`, `git.*`, `step`) is a
 * named step: before running it checks the journal and returns the recorded output when the step is `done`, so a
 * resumed run re-executes the workflow function from the top and fast-forwards to where it stopped. Code between
 * steps re-runs on every resume and must therefore be deterministic (no clocks, no randomness).
 *
 * Step keys are what replay matches on. A key is the name the workflow gives the step, prefixed by the enclosing
 * `loop` rounds and `group`s (`review/2/fix`). Using one key twice in a run is an error, not a silent counter:
 * counters would depend on the order parallel branches happen to reach them.
 *
 * The current run is found through AsyncLocalStorage, so workflows call `agent(...)` without threading a context.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import type { z } from 'zod';
import type { AgentSession, ApprovalDecision, Effort, EngineKind, SessionOptions } from '../engine/types.ts';
import { permissionProfile } from '../engine/types.ts';
import { toStrictJsonSchema } from '../util/json-schema.ts';
import type { RunHost, ShellResult, Worktree } from './host.ts';
import type { Journal, JournalEntry, StepKind } from './journal.ts';

export class WorkflowCancelled extends Error {
  constructor(message = 'Workflow cancelled') {
    super(message);
    this.name = 'WorkflowCancelled';
  }
}

export class StepError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = 'StepError';
    this.key = key;
  }
}

interface RunState {
  runId: string;
  host: RunHost;
  journal: Journal;
  signal: AbortSignal;
  /** Keys used in this execution (duplicate detection). */
  seen: Set<string>;
  agents: Semaphore;
  /** Worktrees the run has created so far (also replayed ones), by path: restored lazily when a step needs one. */
  worktrees: Map<string, Worktree>;
}

interface Scope {
  run: RunState;
  prefix: string;
}

const storage = new AsyncLocalStorage<Scope>();

function current(): Scope {
  const scope = storage.getStore();
  if (!scope) throw new Error('Legion SDK functions can only be called while a workflow is running');
  return scope;
}

export function executeInRun<T>(
  run: Omit<RunState, 'seen' | 'agents' | 'worktrees'>,
  fn: () => Promise<T>,
): Promise<T> {
  const state: RunState = { ...run, seen: new Set(), agents: new Semaphore(run.host.maxAgents), worktrees: new Map() };
  return storage.run({ run: state, prefix: '' }, fn);
}

function fullKey(scope: Scope, key: string): string {
  if (!key || /[/\s]/.test(key)) {
    throw new Error(`Invalid step key ${JSON.stringify(key)}: use a non-empty name without slashes or spaces`);
  }
  return scope.prefix ? `${scope.prefix}/${key}` : key;
}

function claim(scope: Scope, key: string): string {
  const full = fullKey(scope, key);
  if (scope.run.seen.has(full)) throw new Error(`Duplicate step key "${full}": every step in a run needs its own key`);
  scope.run.seen.add(full);
  return full;
}

function checkCancelled(run: RunState): void {
  if (run.signal.aborted) throw new WorkflowCancelled();
}

/**
 * The memoization core: returns the journaled output of a finished step, else runs `fn` between a `started`
 * and a `done`/`failed` entry.
 */
async function memo<T>(
  kind: StepKind,
  key: string,
  label: string | undefined,
  fn: (full: string, previous: JournalEntry | undefined) => Promise<{ output: T; meta?: Record<string, unknown> }>,
  tags: { engine?: EngineKind } = {},
): Promise<T> {
  const scope = current();
  const { run } = scope;
  checkCancelled(run);
  const full = claim(scope, key);
  const shown = label ?? full;
  const previous = run.journal.get(full);
  if (previous?.status === 'done') {
    run.host.emit({ type: 'step', runId: run.runId, key: full, kind, status: 'cached', label: shown, ...tags });
    return previous.output as T;
  }
  run.journal.append({ key: full, kind, status: 'started', ts: Date.now(), label: shown, ...tags });
  run.host.emit({ type: 'step', runId: run.runId, key: full, kind, status: 'started', label: shown, ...tags });
  try {
    const { output, meta } = await fn(full, previous);
    run.journal.append({
      key: full,
      kind,
      status: 'done',
      ts: Date.now(),
      label: shown,
      output,
      ...(meta ? { meta } : {}),
    });
    run.host.emit({ type: 'step', runId: run.runId, key: full, kind, status: 'done', label: shown, ...tags });
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof WorkflowCancelled)) {
      run.journal.append({ key: full, kind, status: 'failed', ts: Date.now(), label: shown, error: message });
    }
    run.host.emit({
      type: 'step',
      runId: run.runId,
      key: full,
      kind,
      status: 'failed',
      label: shown,
      detail: message,
      ...tags,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------------------------

export interface AgentOptions<S extends z.ZodType | undefined = undefined> {
  prompt: string;
  /** Which CLI runs the step; the session decides which profile (account) that is. Default: claude. */
  engine?: 'claude' | 'codex';
  /** `read` may look but never change files; `write` may edit the working directory. Default: write. */
  mode?: 'read' | 'write';
  /** Working directory: a worktree path for coders. Default: the repository root. */
  cwd?: string;
  model?: string;
  effort?: Effort;
  /** Appended to the engine's system prompt. */
  system?: string;
  /** zod schema of the structured result. The agent's answer is validated against it (one corrective retry). */
  output?: S;
  /**
   * Continue the session of an earlier agent step instead of starting a fresh one: its key as seen from here
   * (`code` finds `T1/code` from inside `T1/review/2`), or a full key (`T1/review/1/fix`).
   */
  resume?: string;
  /** Shell commands the agent may run without asking (exact prefixes, e.g. `pnpm test`). */
  allow?: string[];
  web?: boolean;
  /** Who answers tool approvals the agent asks for. Default: the session setting. */
  approvals?: 'ask' | 'auto';
  /** The working directory holds another agent's work: load no project config from it (reviewers). */
  untrusted?: boolean;
  /** Shown in the run view instead of the key. */
  label?: string;
}

export type AgentResult<S> = S extends z.ZodType ? z.infer<S> : string;

const MAX_OUTPUT_RETRIES = 1;

export function agent<S extends z.ZodType | undefined = undefined>(
  key: string,
  opts: AgentOptions<S>,
): Promise<AgentResult<S>> {
  const scope = current();
  const { run } = scope;
  return memo(
    'agent',
    key,
    opts.label,
    async (full, previous) => {
      const code = { engine: opts.engine ?? 'claude', model: opts.model ?? null, effort: opts.effort ?? null };
      const chosen = run.host.agentModel?.({ key, step: full, ...code }) ?? code;
      const kind: EngineKind = chosen.engine ?? code.engine;
      const engine = run.host.engine(kind);
      const sessionOpts: SessionOptions = {
        cwd: opts.cwd ?? run.host.repo,
        prompt: opts.prompt,
        systemPrompt: opts.system ?? null,
        model: chosen.model,
        effort: chosen.effort,
        mcp: run.host.mcp?.() ?? null,
        permission: permissionProfile(opts.mode === 'read' ? 'read_only' : 'workspace_write', {
          allowedCommands: opts.allow ?? [],
          web: opts.web ?? false,
          approvals: opts.approvals ?? run.host.approvals,
        }),
        outputSchema: opts.output ? toStrictJsonSchema(opts.output) : null,
        signal: run.signal,
        untrustedWorkdir: opts.untrusted ?? false,
      };

      // Pick an earlier session up: this step's own (interrupted mid-turn) or the one `resume` names. Sessions live
      // in the profile's config dir, so only the same profile can resume them.
      let resumeId: string | null = null;
      let prompt = opts.prompt;
      const interrupted = previous?.status === 'started' ? previous.meta : undefined;
      if (interrupted?.sessionId && interrupted.profile === engine.profile.name && interrupted.engine === kind) {
        resumeId = String(interrupted.sessionId);
        prompt = `You were interrupted. Continue where you left off and finish the task.\n\nThe task was:\n${opts.prompt}`;
      } else if (opts.resume) {
        const from = lookup(run.journal, scope.prefix, opts.resume);
        if (!from) throw new Error(`resume: no agent step "${opts.resume}" ran before this one`);
        if (from.meta?.sessionId && from.meta.profile === engine.profile.name && from.meta.engine === kind) {
          resumeId = String(from.meta.sessionId);
        } else {
          // Different account or engine: start over with what the earlier step produced.
          prompt = `${opts.prompt}\n\nContext — the result of the earlier step "${opts.resume}":\n${stringify(from.output)}`;
        }
      }

      const meta: Record<string, unknown> = {
        engine: kind,
        profile: engine.profile.name,
        cwd: sessionOpts.cwd,
        ...(chosen.model ? { model: chosen.model } : {}),
        ...(chosen.effort ? { effort: chosen.effort } : {}),
      };
      const release = await run.agents.acquire();
      try {
        checkCancelled(run);
        await ensureCwd(run, sessionOpts.cwd);
        const session = resumeId
          ? await engine.resume(resumeId, { ...sessionOpts, prompt })
          : await engine.start({ ...sessionOpts, prompt });
        const result = await drive(run, full, session, opts.output, meta);
        return { output: result as AgentResult<S>, meta };
      } finally {
        release();
      }
    },
    { engine: opts.engine ?? 'claude' },
  );
}

/** Resolves a step key named from inside `prefix`: the same scope first, then outwards (`review/2/code`,
 * `review/code`, `code`). A key with slashes is a full key (`review/1/fix`: the previous round's step). */
function lookup(journal: Journal, prefix: string, key: string): JournalEntry | undefined {
  if (key.includes('/')) return journal.get(key);
  const parts = prefix ? prefix.split('/') : [];
  for (let i = parts.length; i >= 0; i--) {
    const candidate = [...parts.slice(0, i), key].join('/');
    const entry = journal.get(candidate);
    if (entry) return entry;
  }
  return journal.get(key);
}

async function drive(
  run: RunState,
  key: string,
  session: AgentSession,
  schema: z.ZodType | undefined,
  meta: Record<string, unknown>,
): Promise<unknown> {
  let lastText = '';
  let retries = 0;
  let outcome: { ok: true; value: unknown } | { ok: false; error: string } | null = null;
  try {
    for await (const event of session.events) {
      run.journal.agentEvent(key, event);
      run.host.emit({ type: 'agent', runId: run.runId, key, event });
      switch (event.type) {
        case 'session_started':
          meta.sessionId = event.sessionId;
          // Journal the session id right away: it is what lets an interrupted step resume instead of restart.
          run.journal.append({ key, kind: 'agent', status: 'started', ts: Date.now(), meta: { ...meta } });
          break;
        case 'message':
          lastText = event.text;
          break;
        case 'usage':
          if (event.costUsd !== null) meta.costUsd = event.costUsd;
          break;
        case 'approval_request': {
          const decision: ApprovalDecision = await run.host.interact({
            kind: 'approval',
            runId: run.runId,
            key,
            tool: event.tool,
            input: event.input,
            reason: event.reason,
          });
          await session.respond(event.requestId, decision);
          break;
        }
        case 'turn_complete': {
          if (event.isError) {
            outcome = { ok: false, error: event.reason ?? 'the agent turn failed' };
            break;
          }
          if (!schema) {
            outcome = { ok: true, value: lastText };
            break;
          }
          const parsed = schema.safeParse(event.structuredOutput ?? tryJson(lastText));
          if (parsed.success) {
            outcome = { ok: true, value: parsed.data };
          } else if (retries < MAX_OUTPUT_RETRIES) {
            retries++;
            await session.send(
              `Your structured output did not match the required schema:\n${formatIssues(parsed.error)}\nReply again with the complete, corrected output.`,
            );
          } else {
            outcome = {
              ok: false,
              error: `structured output did not match the schema:\n${formatIssues(parsed.error)}`,
            };
          }
          break;
        }
        case 'error':
          if (!event.retryable) outcome ??= { ok: false, error: event.message };
          break;
        default:
          break;
      }
      if (outcome) break;
    }
  } finally {
    await session.close();
  }
  if (run.signal.aborted) throw new WorkflowCancelled();
  if (!outcome) throw new Error('the agent exited before finishing its turn');
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------------------------
// gates and questions
// ---------------------------------------------------------------------------------------------

export interface GateOptions {
  title: string;
  /** Markdown shown with the gate. Objects are rendered as JSON. */
  show?: unknown;
}

export interface GateResult {
  /** false when the human asked for changes; `note` says which. Aborting cancels the run instead. */
  approved: boolean;
  note: string | null;
}

/** Pauses until the human approves, asks for changes, or aborts the run. */
export function gate(key: string, opts: GateOptions): Promise<GateResult> {
  const { run } = current();
  return memo('gate', key, opts.title, async (full) => {
    const answer = await run.host.interact({
      kind: 'gate',
      runId: run.runId,
      key: full,
      title: opts.title,
      body: opts.show === undefined ? null : stringify(opts.show),
    });
    if (answer.choice === 'abort') throw new WorkflowCancelled(`Aborted at "${opts.title}"`);
    return { output: { approved: answer.choice === 'approve', note: answer.note } };
  });
}

/** Asks the human a question; `options` are suggested answers (free text is always allowed). */
export function ask(key: string, question: string, opts: { options?: string[] } = {}): Promise<string> {
  const { run } = current();
  return memo('ask', key, question, async (full) => {
    const { answer } = await run.host.interact({
      kind: 'ask',
      runId: run.runId,
      key: full,
      question,
      options: opts.options ?? [],
    });
    return { output: answer };
  });
}

// ---------------------------------------------------------------------------------------------
// shell and generic steps
// ---------------------------------------------------------------------------------------------

export interface ShOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Return a non-zero exit instead of failing the step. */
  allowFail?: boolean;
  timeoutMs?: number;
  label?: string;
}

const OUTPUT_TAIL = 32_000;

/** Runs a shell command (`/bin/sh -c`). Fails the step on a non-zero exit unless `allowFail`. */
export function sh(key: string, command: string, opts: ShOptions = {}): Promise<ShellResult> {
  const { run } = current();
  return memo('sh', key, opts.label ?? `$ ${command}`, async () => {
    const cwd = opts.cwd ?? run.host.repo;
    await ensureCwd(run, cwd);
    const result = await run.host.sh(command, {
      cwd,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      signal: run.signal,
    });
    const output = { code: result.code, stdout: tail(result.stdout), stderr: tail(result.stderr) };
    if (result.code !== 0 && !opts.allowFail) {
      throw new Error(`\`${command}\` exited with ${result.code}\n${output.stderr || output.stdout}`.trim());
    }
    return { output };
  });
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
}

/** Memoizes any async computation with side effects. The result must be JSON-serializable. */
export function step<T>(key: string, fn: () => Promise<T>, opts: { label?: string } = {}): Promise<T> {
  return memo('step', key, opts.label, async () => ({ output: await fn() }));
}

// ---------------------------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noConfusingVoidType: a round that is not done may simply not return.
export type LoopBody<T> = (round: number) => Promise<{ done: true; value?: T } | undefined | void>;

export interface LoopResult<T> {
  /** True when the body said it was done; false when `max` rounds ran out. */
  done: boolean;
  rounds: number;
  value: T | undefined;
}

/**
 * Runs `body` for rounds 1..max until it returns `{ done: true }`. Steps inside are keyed per round
 * (`review/2/fix`), so a resumed run replays finished rounds from the journal.
 */
export async function loop<T = undefined>(
  key: string,
  opts: { max: number },
  body: LoopBody<T>,
): Promise<LoopResult<T>> {
  const scope = current();
  const full = claim(scope, key);
  if (!Number.isInteger(opts.max) || opts.max < 1) throw new Error(`loop "${full}": max must be a positive integer`);
  scope.run.host.emit({
    type: 'step',
    runId: scope.run.runId,
    key: full,
    kind: 'loop',
    status: 'started',
    label: full,
  });
  for (let round = 1; round <= opts.max; round++) {
    checkCancelled(scope.run);
    const result = await storage.run({ run: scope.run, prefix: `${full}/${round}` }, () => body(round));
    if (result?.done) {
      scope.run.host.emit({
        type: 'step',
        runId: scope.run.runId,
        key: full,
        kind: 'loop',
        status: 'done',
        label: full,
        detail: `done after ${round}`,
      });
      return { done: true, rounds: round, value: result.value };
    }
  }
  scope.run.host.emit({
    type: 'step',
    runId: scope.run.runId,
    key: full,
    kind: 'loop',
    status: 'done',
    label: full,
    detail: `stopped after ${opts.max} rounds`,
  });
  return { done: false, rounds: opts.max, value: undefined };
}

/** Prefixes the keys of every step inside `fn` with `key/` (e.g. one group per task). */
export function group<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const scope = current();
  const full = claim(scope, key);
  return storage.run({ run: scope.run, prefix: full }, fn);
}

/** Runs thunks concurrently (at most `concurrency` at once) and returns their results in order. */
export async function parallel<T>(
  thunks: readonly (() => Promise<T>)[],
  opts: { concurrency?: number } = {},
): Promise<T[]> {
  const limit = Math.max(1, opts.concurrency ?? thunks.length);
  const results: T[] = new Array(thunks.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < thunks.length && failed === null) {
      const i = next++;
      try {
        results[i] = await (thunks[i] as () => Promise<T>)();
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  if (failed !== null) throw failed;
  return results;
}

/** A progress line in the run view. */
export function log(message: string): void {
  const { run } = current();
  run.host.emit({ type: 'log', runId: run.runId, message });
}

/** Facts about the current run. */
export function runInfo(): { runId: string; repo: string; dryRun: boolean } {
  const { run } = current();
  return { runId: run.runId, repo: run.host.repo, dryRun: run.host.dryRun };
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

function gitStep<T>(key: string, label: string, fn: (run: RunState) => Promise<T>, uses: Worktree[] = []): Promise<T> {
  const { run } = current();
  return memo('git', key, label, async () => {
    for (const wt of uses) await ensureCwd(run, wt.path);
    return { output: await fn(run) };
  });
}

function track(wt: Worktree): Worktree {
  current().run.worktrees.set(wt.path, wt);
  return wt;
}

/**
 * Before a step really runs in `cwd`: a worktree a resumed run replayed from the journal may be gone (reboot,
 * cleanup), so bring it back from its branch. Replayed steps never get here, so a worktree removed later in the
 * run is not resurrected just by replaying past it.
 */
async function ensureCwd(run: RunState, cwd: string): Promise<void> {
  const wt = run.worktrees.get(cwd);
  if (wt && !existsSync(cwd)) await run.host.git.restore(wt);
}

export const git = {
  /** The run's integration branch in its own worktree; task branches are squash-merged into it. */
  async integration(opts: { base?: string; key?: string } = {}): Promise<Worktree> {
    const key = opts.key ?? 'integration';
    const wt = await gitStep(key, 'integration branch', (run) =>
      run.host.git.integration(run.runId, { base: opts.base ?? null }),
    );
    return track(wt);
  },
  /** A new branch + worktree for one task, from `from` (default: HEAD). Key: `wt-<name>`. */
  async worktree(name: string, opts: { from?: Worktree | string } = {}): Promise<Worktree> {
    const from = typeof opts.from === 'string' ? opts.from : (opts.from?.branch ?? null);
    const wt = await gitStep(`wt-${name}`, `worktree ${name}`, (run) =>
      run.host.git.worktree(run.runId, name, { from }),
    );
    return track(wt);
  },
  /** Commits all changes in a worktree (agents never commit themselves). */
  commit(wt: Worktree, message: string, opts: { key?: string } = {}): Promise<{ sha: string | null }> {
    return gitStep(opts.key ?? `commit-${wt.name}`, `commit ${wt.name}`, (run) => run.host.git.commit(wt, message), [
      wt,
    ]);
  },
  /** Squash-merges `wt` into `into`. `{ ok: false, conflicts }` leaves `into` untouched. */
  merge(wt: Worktree, into: Worktree, opts: { message?: string; key?: string } = {}) {
    return gitStep(
      opts.key ?? `merge-${wt.name}`,
      `merge ${wt.name} → ${into.name}`,
      (run) => run.host.git.squashMerge(wt, into, opts.message ?? wt.name),
      [into],
    );
  },
  /** Merges `from` into `wt`, leaving conflicts in the worktree for an agent to resolve. */
  mergeInto(wt: Worktree, from: Worktree, opts: { key?: string } = {}) {
    return gitStep(
      opts.key ?? `sync-${wt.name}`,
      `merge ${from.name} into ${wt.name}`,
      (run) => run.host.git.mergeInto(wt, from),
      [wt],
    );
  },
  /** Commits a merge an agent resolved; fails if conflict markers remain. */
  finishMerge(wt: Worktree, opts: { message?: string; key?: string } = {}) {
    return gitStep(
      opts.key ?? `resolve-${wt.name}`,
      `finish merge in ${wt.name}`,
      (run) => run.host.git.finishMerge(wt, opts.message ?? `Merge into ${wt.name}`),
      [wt],
    );
  },
  /** Unified diff of a worktree against its base (not journaled: a read). */
  async diff(wt: Worktree, opts: { against?: string } = {}): Promise<string> {
    const { run } = current();
    await ensureCwd(run, wt.path);
    return run.host.git.diff(wt, { against: opts.against ?? null });
  },
  /** Changed paths of a worktree against its base (not journaled: a read). */
  async changedFiles(wt: Worktree): Promise<string[]> {
    const { run } = current();
    await ensureCwd(run, wt.path);
    return run.host.git.changedFiles(wt);
  },
  /** Pushes and opens a draft pull request with `gh` (idempotent: an existing PR is returned). */
  pr(wt: Worktree, opts: { title: string; body: string; base?: string; key?: string }) {
    return gitStep(opts.key ?? 'pr', `draft PR: ${opts.title}`, (run) =>
      run.host.git.draftPr(wt, { title: opts.title, body: opts.body, base: opts.base ?? null }),
    );
  },
  /** Merges `wt`'s branch into the base branch locally, without touching the user's checkout. */
  mergeToBase(wt: Worktree, opts: { message: string; base?: string; key?: string }) {
    return gitStep(opts.key ?? 'merge-to-base', `merge ${wt.name} into base`, (run) =>
      run.host.git.mergeToBase(wt, { base: opts.base ?? null, message: opts.message }),
    );
  },
  /** Removes a worktree (its branch stays). */
  remove(wt: Worktree, opts: { key?: string } = {}): Promise<null> {
    return gitStep(opts.key ?? `rm-${wt.name}`, `remove ${wt.name}`, async (run) => {
      await run.host.git.remove(wt);
      return null;
    });
  },
};

// ---------------------------------------------------------------------------------------------

class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];
  constructor(size: number) {
    this.available = Math.max(1, size);
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    };
  }
}
