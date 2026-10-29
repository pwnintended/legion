/**
 * A run's durable state, as plain files under `.legion/runs/<runId>/`:
 * - `run.json`: what was run (workflow, input) and how it ended. Rewritten atomically.
 * - `journal.jsonl`: append-only step log. A step is `started` and then `done` or `failed`; on resume the runtime
 *   replays the workflow from the top and every step with a `done` entry returns its recorded output instead of
 *   running again (step memoization). `started` entries carry what is needed to pick an interrupted step up
 *   (an agent's session id and the account it ran on).
 * - `agents/<step>.jsonl`: every `AgentEvent` of that step's sessions, for transcripts.
 */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface RunRecord {
  id: string;
  workflow: string;
  /** Absolute path of the workflow file that ran (project, user or builtin). */
  file: string;
  input: unknown;
  status: RunStatus;
  /** Repository root the run works on. */
  repo: string;
  startedAt: number;
  endedAt: number | null;
  result: unknown;
  error: string | null;
  /** The lead that started the run (`orchestrator` when absent): its milestones and interactions go there. */
  owner?: string;
  /**
   * The branch the run's worktrees start from and merge into when the workflow names none (a lead's own branch).
   * Absent: the repository's checked-out HEAD.
   */
  base?: string;
  /** Where agents and shell commands without a `cwd` work (a lead's worktree). Absent: `repo`. */
  cwd?: string;
  /** The Legion process running it (to tell a crashed run from one another session is running). */
  pid?: number;
}

export type StepKind = 'agent' | 'gate' | 'ask' | 'sh' | 'step' | 'git' | 'loop' | 'parallel';

export interface JournalEntry {
  key: string;
  kind: StepKind;
  status: 'started' | 'done' | 'failed';
  ts: number;
  /** Human label for the UI (defaults to the key). */
  label?: string;
  output?: unknown;
  error?: string;
  /** Kind-specific facts: `sessionId`, `account`, `where`, `engine`, `costUsd` for agents. */
  meta?: Record<string, unknown>;
}

export class Journal {
  readonly dir: string;
  private readonly entries = new Map<string, JournalEntry>();
  /** Every entry in file order (latest status per key is in `entries`). */
  private readonly log: JournalEntry[] = [];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, 'agents'), { recursive: true });
    let text = '';
    try {
      text = readFileSync(this.journalPath, 'utf8');
    } catch {
      // New run.
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        this.apply(entry);
      } catch {
        // A torn last line from a crash mid-write: everything before it is intact.
      }
    }
  }

  private get journalPath(): string {
    return join(this.dir, 'journal.jsonl');
  }

  private apply(entry: JournalEntry): void {
    this.log.push(entry);
    const prev = this.entries.get(entry.key);
    // A `started` after a finished entry is a new attempt (a resumed run retrying a failed step); anything else
    // continues the current attempt and keeps what earlier entries recorded (label, session id).
    const fresh = !prev || (entry.status === 'started' && prev.status !== 'started');
    this.entries.set(entry.key, fresh ? entry : { ...prev, ...entry, meta: { ...prev.meta, ...entry.meta } });
  }

  get(key: string): JournalEntry | undefined {
    return this.entries.get(key);
  }

  all(): JournalEntry[] {
    return [...this.entries.values()];
  }

  append(entry: JournalEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const fd = openSync(this.journalPath, 'a');
    try {
      appendFileSync(fd, line);
      // A `done` entry is what lets a resume skip the step: make sure it is on disk before moving on.
      if (entry.status !== 'started') fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.apply(entry);
  }

  /**
   * Makes a finished step run again on the next resume, with every step that finished after its latest attempt
   * began (they may depend on it). Files, branches and worktrees stay as they are. Returns the keys reset.
   */
  rewind(key: string, reason = 'rewound'): string[] {
    const target = this.entries.get(key);
    if (!target) throw new Error(`No step "${key}" in this run`);
    let start = -1;
    const last = new Map<string, JournalEntry['status']>();
    this.log.forEach((e, i) => {
      if (e.key === key && e.status === 'started' && last.get(key) !== 'started') start = i;
      last.set(e.key, e.status);
    });
    const keys = new Set<string>([key]);
    for (const e of this.log.slice(start + 1)) if (e.status === 'done') keys.add(e.key);
    const reset = [...keys].filter((k) => this.entries.get(k)?.status === 'done' || k === key);
    for (const k of reset) {
      const entry = this.entries.get(k) as JournalEntry;
      this.append({ key: k, kind: entry.kind, status: 'failed', ts: Date.now(), error: reason });
    }
    return reset;
  }

  /** Records one agent event for a step's transcript. */
  agentEvent(key: string, event: unknown): void {
    appendFileSync(
      join(this.dir, 'agents', `${stepFileName(key)}.jsonl`),
      `${JSON.stringify({ ts: Date.now(), event })}\n`,
    );
  }

  transcriptPath(key: string): string {
    return join(this.dir, 'agents', `${stepFileName(key)}.jsonl`);
  }
}

export function stepFileName(key: string): string {
  return key.replace(/[^\w.-]+/g, '_').slice(0, 180);
}

export function runsDir(repo: string): string {
  return join(repo, '.legion', 'runs');
}

export function readRun(dir: string): RunRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

export function writeRun(dir: string, run: RunRecord): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `run.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(tmp, join(dir, 'run.json'));
}

/** Runs of a repository, newest first. */
export function listRuns(repo: string): RunRecord[] {
  const root = runsDir(repo);
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => readRun(join(root, name)))
    .filter((run): run is RunRecord => run !== null)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Sortable, short, unique enough for one repository: `20261026-2101-k3f9`. */
export function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
