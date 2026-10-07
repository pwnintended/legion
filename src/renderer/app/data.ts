/**
 * Client-side mirror of engine state (architecture §10) and the pure reducer that maintains it.
 *
 * Entities are stored normalized by id. Every write records the event-log seq it reflects in `versions`, so
 * applying data is idempotent and order-tolerant:
 * - a `ServerEvent` applies when its seq is newer than the entity's version;
 * - a snapshot (`runs.get` → its own seq; `runs.list` / `inbox.list` → the client seq when the request was
 *   sent) applies when it is at least as new as the entity's version.
 * Agent events append to per-attempt transcripts (deduplicated by seq) and feed small derived views
 * (recent activity lines, rate limits).
 */
import type {
  Attempt,
  EngineKind,
  InboxItem,
  Merge,
  Plan,
  Review,
  Run,
  Settings,
  Task,
  TaskStatus,
  Verification,
} from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import type { AgentEvent, ServerEvent } from '@shared/events';
import type { RunSnapshot, RunSummary, TranscriptEntry } from '@shared/rpc';
import { isArchived } from './compat';

export type EntityKind = 'run' | 'plan' | 'task' | 'attempt' | 'review' | 'inbox' | 'verification' | 'merge';

export interface Transcript {
  status: 'loading' | 'ready' | 'error';
  /**
   * Sorted by seq, unique. Live events are appended in place (O(1)): the array is shared by successive
   * states and only `entries[0 .. count)` belongs to this one, so read it through the latest Transcript and
   * key memos on the Transcript (or `count`), not on the array. It is replaced (new identity) when history
   * pages are merged in or it is trimmed.
   */
  entries: TranscriptEntry[];
  /** Entries of this state (`entries.length` for the latest state). */
  count: number;
  /** Highest seq in `entries` (0 when empty). */
  lastSeq: number;
  error: string | null;
  /**
   * Entries trimmed to bound memory (see `compactEntries`): they sat between the session's head and the
   * rest, seqs `gap.from ..= gap.to`. History pages don't bring them back.
   */
  dropped: number;
  gap: { from: number; to: number } | null;
}

/** A stored entry; `through` = the last seq a coalesced text/reasoning entry covers. */
type StoredEntry = TranscriptEntry & { through?: number };

export interface RateLimit {
  engine: EngineKind;
  window: string;
  usedPct: number;
  resetsAt: number | null;
  ts: number;
}

export interface DiffStat {
  /** The attempt's run (for pruning when the run goes away); null when not known yet. */
  runId: string | null;
  /** Highest `file_change` seq counted. */
  seq: number;
  /** Seqs of the `file_change` events counted (each is counted once, whichever way it arrives). */
  counted: number[];
  added: number;
  removed: number;
  files: string[];
}

export interface EnginesState {
  status: 'unknown' | 'ready' | 'unavailable';
  list: EngineInfo[];
}

export interface ConnectionInfo {
  status: 'connecting' | 'connected' | 'disconnected';
  generation: number;
  /** A snapshot fetch is in flight. */
  syncing: boolean;
  /** At least one `runs.list` has been applied (distinguishes "no runs" from "not loaded yet"). */
  loaded: boolean;
}

export interface DataState {
  /** Highest event seq applied. */
  seq: number;
  runs: Record<string, Run>;
  /** Aggregates from `runs.list`, used for runs whose snapshot isn't loaded. */
  summaries: Record<string, Omit<RunSummary, 'run'>>;
  /** Runs whose full snapshot (`runs.get`) has been applied → its seq. */
  loadedRuns: Record<string, number>;
  plans: Record<string, Plan>;
  tasks: Record<string, Task>;
  attempts: Record<string, Attempt>;
  reviews: Record<string, Review>;
  inbox: Record<string, InboxItem>;
  verifications: Record<string, Verification>;
  merges: Record<string, Merge>;
  /** `${kind}:${id}` → seq the stored row reflects. */
  versions: Record<string, number>;
  transcripts: Record<string, Transcript>;
  /** Last few human-readable activity lines per attempt (for cards, thin columns, overview). */
  activity: Record<string, { runId: string | null; seq: number; lines: string[] }>;
  /** Lines added/removed and files touched per attempt, from `file_change` agent events. */
  diffstats: Record<string, DiffStat>;
  /** engine → window → latest reading. */
  rateLimits: Partial<Record<EngineKind, Record<string, RateLimit>>>;
  settings: Settings | null;
  engines: EnginesState;
  connection: ConnectionInfo;
}

export const MAX_TRANSCRIPT_ENTRIES = 5000;
export const ACTIVITY_LINES = 4;

export function initialData(): DataState {
  return {
    seq: 0,
    runs: {},
    summaries: {},
    loadedRuns: {},
    plans: {},
    tasks: {},
    attempts: {},
    reviews: {},
    inbox: {},
    verifications: {},
    merges: {},
    versions: {},
    transcripts: {},
    activity: {},
    diffstats: {},
    rateLimits: {},
    settings: null,
    engines: { status: 'unknown', list: [] },
    connection: { status: 'connecting', generation: 0, syncing: false, loaded: false },
  };
}

// ---------------------------------------------------------------------------------------------
// Copy-on-write draft: clones each touched collection once per batch.
// ---------------------------------------------------------------------------------------------

type Collections = Pick<
  DataState,
  'runs' | 'plans' | 'tasks' | 'attempts' | 'reviews' | 'inbox' | 'verifications' | 'merges'
>;
const COLLECTION: { [K in EntityKind]: keyof Collections } = {
  run: 'runs',
  plan: 'plans',
  task: 'tasks',
  attempt: 'attempts',
  review: 'reviews',
  inbox: 'inbox',
  verification: 'verifications',
  merge: 'merges',
};

type MutableKeys =
  | keyof Collections
  | 'versions'
  | 'transcripts'
  | 'activity'
  | 'diffstats'
  | 'summaries'
  | 'loadedRuns';

class Draft {
  readonly next: DataState;
  private readonly cloned = new Set<MutableKeys>();

  constructor(state: DataState) {
    this.next = { ...state };
  }

  map<K extends MutableKeys>(key: K): DataState[K] {
    if (!this.cloned.has(key)) {
      this.cloned.add(key);
      (this.next as unknown as Record<string, unknown>)[key] = { ...(this.next[key] as object) };
    }
    return this.next[key];
  }

  version(kind: EntityKind, id: string): number {
    return this.next.versions[`${kind}:${id}`] ?? -1;
  }

  /** Write an entity if `seq` is newer (events) or at least as new (snapshots). */
  put<T extends { id: string }>(kind: EntityKind, row: T, seq: number, snapshot = false): boolean {
    const current = this.version(kind, row.id);
    if (snapshot ? seq < current : seq <= current) return false;
    (this.map(COLLECTION[kind]) as Record<string, unknown>)[row.id] = row;
    this.map('versions')[`${kind}:${row.id}`] = seq;
    return true;
  }

  drop(kind: EntityKind, id: string): void {
    delete (this.map(COLLECTION[kind]) as Record<string, unknown>)[id];
    delete this.map('versions')[`${kind}:${id}`];
  }
}

// ---------------------------------------------------------------------------------------------
// Agent-event derived views
// ---------------------------------------------------------------------------------------------

function short(text: string, max = 96): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function inputSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
      const value = record[key];
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

/** One readable line for an agent event, or null for events not worth a line. */
export function activityLine(event: AgentEvent): string | null {
  switch (event.type) {
    case 'message':
      return short(event.text);
    case 'tool_call': {
      const detail = inputSummary(event.input);
      if (event.kind === 'command') return short(`$ ${detail || event.name}`);
      return short(detail ? `${event.name} ${detail}` : event.name);
    }
    case 'file_change':
      return short(`Edit ${event.path} +${event.added} −${event.removed}`);
    case 'todo': {
      const done = event.items.filter((i) => i.status === 'completed').length;
      const current = event.items.find((i) => i.status === 'in_progress');
      return short(`todo ${done}/${event.items.length}${current ? ` · ${current.text}` : ''}`);
    }
    case 'approval_request':
      return short(`approval: ${inputSummary(event.input) || event.tool}`);
    case 'error':
      return short(`error: ${event.message}`);
    case 'turn_complete':
      return event.isError ? short(`turn failed${event.reason ? `: ${event.reason}` : ''}`) : null;
    default:
      return null;
  }
}

/**
 * Append an activity line. A file change right after the edit call that produced it replaces that line
 * (`Edit a.ts` then `Edit a.ts +7 −1` reads as one step).
 */
export function pushActivity(lines: readonly string[], line: string): string[] {
  const last = lines.at(-1);
  const merges =
    last !== undefined &&
    line.startsWith('Edit ') &&
    line.startsWith(`${last.replace(/^(Write|Edit|MultiEdit|apply_patch) /, 'Edit ')} +`);
  return [...(merges ? lines.slice(0, -1) : lines), line].slice(-ACTIVITY_LINES);
}

function addDiffStat(
  draft: Draft,
  attemptId: string,
  runId: string | null,
  seq: number,
  change: { path: string; added: number; removed: number },
): void {
  const current = draft.next.diffstats[attemptId];
  // Deduplicated by the event's seq (not "newer than the last one counted"): history may arrive after
  // live events and still holds older changes that must be counted.
  if (current?.counted.includes(seq)) return;
  draft.map('diffstats')[attemptId] = {
    runId: runId ?? current?.runId ?? null,
    seq: Math.max(seq, current?.seq ?? 0),
    counted: [...(current?.counted ?? []), seq],
    added: (current?.added ?? 0) + change.added,
    removed: (current?.removed ?? 0) + change.removed,
    files: current?.files.includes(change.path) ? current.files : [...(current?.files ?? []), change.path],
  };
}

/** After compaction a transcript is at most this full, so compactions are amortized over many appends. */
const COMPACT_TO = Math.floor(MAX_TRANSCRIPT_ENTRIES * 0.8);
/** Entries always kept from the start of a session (its start row, the first steps), whatever is trimmed. */
export const TRANSCRIPT_HEAD = 200;

/**
 * Shrink a transcript that grew past the cap without changing what the timeline shows where possible:
 * 1. consecutive `text_delta`s (and `reasoning` chunks) fold into one entry with the joined text, keeping
 *    the first one's seq (the row key) — streamed text is most of a long transcript;
 * 2. `usage` keeps only its latest reading and `rate_limit` readings go (the timeline doesn't show them);
 * 3. only if that is not enough, the oldest entries *after* the session's head are dropped (counted in
 *    `dropped`), never the start of the session.
 */
type Retention = Pick<Transcript, 'dropped' | 'gap'>;

export function compactEntries(
  entries: readonly TranscriptEntry[],
  retention: Retention = { dropped: 0, gap: null },
): { entries: TranscriptEntry[] } & Retention {
  const out: StoredEntry[] = [];
  let lastUsage = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.event.type === 'usage') {
      lastUsage = i;
      break;
    }
  }
  entries.forEach((entry, i) => {
    const { event } = entry;
    if (event.type === 'rate_limit' || (event.type === 'usage' && i !== lastUsage)) return;
    const prev = out.at(-1);
    const through = (entry as StoredEntry).through ?? entry.seq;
    if (prev && event.type === 'text_delta' && prev.event.type === 'text_delta') {
      out[out.length - 1] = { ...prev, event: { ...prev.event, text: prev.event.text + event.text }, through };
      return;
    }
    if (prev && event.type === 'reasoning' && prev.event.type === 'reasoning') {
      out[out.length - 1] = { ...prev, event: { ...prev.event, text: prev.event.text + event.text }, through };
      return;
    }
    out.push(entry);
  });
  if (out.length <= COMPACT_TO) return { entries: out, dropped: retention.dropped, gap: retention.gap };
  const drop = out.length - COMPACT_TO;
  const first = out[TRANSCRIPT_HEAD] as StoredEntry;
  const last = out[TRANSCRIPT_HEAD + drop - 1] as StoredEntry;
  const from = Math.min(first.seq, retention.gap?.from ?? first.seq);
  const to = Math.max(last.through ?? last.seq, retention.gap?.to ?? 0);
  return {
    entries: [...out.slice(0, TRANSCRIPT_HEAD), ...out.slice(TRANSCRIPT_HEAD + drop)],
    dropped: retention.dropped + drop,
    gap: { from, to },
  };
}

/** Keep a transcript under the cap (see `compactEntries`). */
function bounded(entries: TranscriptEntry[], retention: Retention): { entries: TranscriptEntry[] } & Retention {
  if (entries.length <= MAX_TRANSCRIPT_ENTRIES) return { entries, dropped: retention.dropped, gap: retention.gap };
  return compactEntries(entries, retention);
}

/**
 * Merge history into a transcript (deduplicated by seq, sorted). Always returns a new array. Entries the
 * transcript already holds in compacted form (inside a coalesced text run, or in the trimmed gap) are not
 * added again.
 */
function mergeEntries(
  a: readonly TranscriptEntry[],
  b: readonly TranscriptEntry[],
  retention: Retention,
): { entries: TranscriptEntry[] } & Retention {
  const covered: [number, number][] = [];
  if (retention.gap) covered.push([retention.gap.from, retention.gap.to]);
  const bySeq = new Map<number, TranscriptEntry>();
  for (const entry of a) {
    bySeq.set(entry.seq, entry);
    const through = (entry as StoredEntry).through;
    if (through !== undefined) covered.push([entry.seq, through]);
  }
  covered.sort((x, y) => x[0] - y[0]);
  let r = 0;
  for (const entry of [...b].sort((x, y) => x.seq - y.seq)) {
    while (r < covered.length && (covered[r] as [number, number])[1] < entry.seq) r++;
    const range = covered[r];
    if (bySeq.has(entry.seq) || (range && entry.seq >= range[0])) continue;
    bySeq.set(entry.seq, entry);
  }
  return bounded(
    [...bySeq.values()].sort((x, y) => x.seq - y.seq),
    retention,
  );
}

/**
 * Append one live entry (seq > lastSeq) in O(1) amortized: pushes onto the shared array when this state owns
 * its tail, copies only when an older state is being extended (never in practice).
 */
export function appendEntry(transcript: Transcript, entry: TranscriptEntry): Transcript {
  let entries = transcript.entries;
  if (entries.length !== transcript.count) entries = entries.slice(0, transcript.count);
  entries.push(entry);
  const next = bounded(entries, transcript);
  return {
    ...transcript,
    entries: next.entries,
    count: next.entries.length,
    dropped: next.dropped,
    gap: next.gap,
    lastSeq: entry.seq,
  };
}

function applyAgentEvent(draft: Draft, event: ServerEvent & { type: 'agent.event' }): void {
  const { attemptId } = event;
  const transcript = draft.next.transcripts[attemptId];
  if (transcript && event.seq > transcript.lastSeq) {
    draft.map('transcripts')[attemptId] = appendEntry(transcript, { seq: event.seq, ts: event.ts, event: event.event });
  }
  const line = activityLine(event.event);
  const activity = draft.next.activity[attemptId];
  if (line && (!activity || event.seq > activity.seq)) {
    draft.map('activity')[attemptId] = {
      runId: event.runId,
      seq: event.seq,
      lines: pushActivity(activity?.lines ?? [], line),
    };
  }
  if (event.event.type === 'file_change') addDiffStat(draft, attemptId, event.runId, event.seq, event.event);
  if (event.event.type === 'rate_limit') {
    const { engine, window, usedPct, resetsAt } = event.event;
    const rateLimits = { ...draft.next.rateLimits };
    rateLimits[engine] = { ...rateLimits[engine], [window]: { engine, window, usedPct, resetsAt, ts: event.ts } };
    draft.next.rateLimits = rateLimits;
  }
}

// ---------------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------------

export function applyEvents(state: DataState, events: readonly ServerEvent[]): DataState {
  if (events.length === 0) return state;
  const draft = new Draft(state);
  for (const event of events) {
    switch (event.type) {
      case 'run.updated':
        draft.put('run', event.run, event.seq);
        break;
      case 'plan.updated':
        draft.put('plan', event.plan, event.seq);
        break;
      case 'task.updated':
        draft.put('task', event.task, event.seq);
        break;
      case 'attempt.updated':
        draft.put('attempt', event.attempt, event.seq);
        break;
      case 'review.created':
        draft.put('review', event.review, event.seq);
        break;
      case 'inbox.updated':
        draft.put('inbox', event.item, event.seq);
        break;
      case 'verification.created':
        draft.put('verification', event.verification, event.seq);
        break;
      case 'merge.updated':
        draft.put('merge', event.merge, event.seq);
        break;
      case 'agent.event':
        applyAgentEvent(draft, event);
        break;
      case 'settings.updated':
        draft.next.settings = event.settings;
        break;
    }
    if (event.seq > draft.next.seq) draft.next.seq = event.seq;
  }
  return draft.next;
}

export function applySnapshot(state: DataState, snapshot: RunSnapshot): DataState {
  const draft = new Draft(state);
  const seq = snapshot.seq;
  const runId = snapshot.run.id;
  draft.put('run', snapshot.run, seq, true);
  const lists: [EntityKind, { id: string; runId: string }[]][] = [
    ['plan', snapshot.plans],
    ['task', snapshot.tasks],
    ['attempt', snapshot.attempts],
    ['review', snapshot.reviews],
    ['inbox', snapshot.inbox],
    ['verification', snapshot.verifications],
    ['merge', snapshot.merges],
  ];
  for (const [kind, rows] of lists) {
    const ids = new Set(rows.map((r) => r.id));
    for (const row of rows) draft.put(kind, row, seq, true);
    // Rows of this run that the snapshot no longer has (and that no newer event wrote) are gone.
    const collection = draft.next[COLLECTION[kind]] as Record<string, { runId: string }>;
    for (const [id, row] of Object.entries(collection)) {
      if (row.runId === runId && !ids.has(id) && draft.version(kind, id) <= seq) draft.drop(kind, id);
    }
  }
  draft.map('loadedRuns')[runId] = Math.max(seq, state.loadedRuns[runId] ?? 0);
  return draft.next;
}

/**
 * A run row returned by a procedure (`runs.create`, `runs.archive`, ...) after client seq `atSeq`: it is at
 * least as new as what the store has (the procedure ran after all of it). Its `run.updated` event may still
 * come and then applies on top.
 */
export function applyRunRow(state: DataState, run: Run, atSeq: number): DataState {
  const draft = new Draft(state);
  return draft.put('run', run, Math.max(atSeq, draft.version('run', run.id)), true) ? draft.next : state;
}

/** `runs.list` result read at (or after) client seq `atSeq`. */
export function applyRunList(state: DataState, list: readonly RunSummary[], atSeq: number): DataState {
  const draft = new Draft(state);
  const ids = new Set<string>();
  for (const { run, ...summary } of list) {
    ids.add(run.id);
    draft.put('run', run, atSeq, true);
    draft.map('summaries')[run.id] = summary;
  }
  const gone = new Set<string>();
  for (const id of Object.keys(state.runs)) {
    if (!ids.has(id) && draft.version('run', id) <= atSeq) {
      draft.drop('run', id);
      delete draft.map('summaries')[id];
      delete draft.map('loadedRuns')[id];
      gone.add(id);
    }
  }
  pruneDerived(draft, gone);
  draft.next.connection = { ...draft.next.connection, loaded: true };
  return draft.next;
}

/** `inbox.list({runId: null, includeResolved: false})` read at client seq `atSeq`. */
export function applyOpenInbox(state: DataState, items: readonly InboxItem[], atSeq: number): DataState {
  const draft = new Draft(state);
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) draft.put('inbox', item, atSeq, true);
  // Open items that are missing from the list were resolved while we weren't looking.
  for (const [id, item] of Object.entries(state.inbox)) {
    if (!ids.has(id) && item.resolvedAt === null && draft.version('inbox', id) <= atSeq) draft.drop('inbox', id);
  }
  return draft.next;
}

export function beginTranscript(state: DataState, attemptId: string): DataState {
  const current = state.transcripts[attemptId];
  if (current?.status === 'loading') return state;
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [attemptId]: { ...(current ?? emptyTranscript()), status: 'loading', error: null },
    },
  };
}

/** A fresh transcript (its own entries array: live events are appended to it in place). */
function emptyTranscript(): Transcript {
  return { status: 'loading', entries: [], count: 0, lastSeq: 0, error: null, dropped: 0, gap: null };
}

/** The entries of this state (see `Transcript.entries`). */
export function transcriptEntries(transcript: Transcript): readonly TranscriptEntry[] {
  return transcript.entries.length === transcript.count
    ? transcript.entries
    : transcript.entries.slice(0, transcript.count);
}

export function applyTranscriptPage(
  state: DataState,
  attemptId: string,
  entries: readonly TranscriptEntry[],
  complete: boolean,
  /** History stopped early after this seq (fetch cap): what follows up to the live part was not loaded. */
  truncatedAfter: number | null = null,
): DataState {
  const current = state.transcripts[attemptId];
  const next = mergeEntries(current ? transcriptEntries(current) : [], entries, current ?? { dropped: 0, gap: null });
  const merged = next.entries;
  const tail = merged.at(-1) as StoredEntry | undefined;
  let gap = next.gap;
  if (truncatedAfter !== null) {
    const after = merged.find((e) => e.seq > truncatedAfter);
    // Live events after the last applied seq keep arriving; the gap ends before them.
    gap = { from: Math.min(truncatedAfter + 1, gap?.from ?? Infinity), to: after ? after.seq - 1 : state.seq };
  }
  const draft = new Draft(state);
  draft.map('transcripts')[attemptId] = {
    status: complete ? 'ready' : 'loading',
    entries: merged,
    count: merged.length,
    lastSeq: Math.max(tail?.through ?? tail?.seq ?? 0, current?.lastSeq ?? 0),
    error: null,
    dropped: next.dropped,
    gap,
  };
  const runId = state.attempts[attemptId]?.runId ?? null;
  // Seed diff stats from history the live stream did not deliver (also older changes when live events
  // arrived first).
  for (const entry of entries) {
    if (entry.event.type === 'file_change') addDiffStat(draft, attemptId, runId, entry.seq, entry.event);
  }
  // Seed activity lines from history when no live events have produced any yet.
  if (!state.activity[attemptId]) {
    // The last few lines only need the tail of the history.
    const lines = merged
      .slice(-64)
      .map((e) => activityLine(e.event))
      .filter((l): l is string => l !== null)
      .reduce<string[]>((acc, line) => pushActivity(acc, line), []);
    if (lines.length > 0)
      draft.map('activity')[attemptId] = {
        runId,
        seq: merged.at(-1)?.seq ?? 0,
        lines: lines.slice(-ACTIVITY_LINES),
      };
  }
  return draft.next;
}

export function failTranscript(state: DataState, attemptId: string, error: string): DataState {
  const current = state.transcripts[attemptId];
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [attemptId]: { ...(current ?? emptyTranscript()), status: 'error', error },
    },
  };
}

/** Forget an attempt's transcript (no tile has shown it for a while; it is refetched when needed again). */
export function dropTranscript(state: DataState, attemptId: string): DataState {
  if (!state.transcripts[attemptId]) return state;
  const transcripts = { ...state.transcripts };
  delete transcripts[attemptId];
  return { ...state, transcripts };
}

/** Drop per-attempt derived data (transcripts, activity, diff stats) of runs that are gone from the store. */
function pruneDerived(draft: Draft, goneRuns: ReadonlySet<string>): void {
  if (goneRuns.size === 0) return;
  const { activity, diffstats, attempts } = draft.next;
  const runOf = (attemptId: string) =>
    attempts[attemptId]?.runId ?? activity[attemptId]?.runId ?? diffstats[attemptId]?.runId ?? null;
  const gone = (attemptId: string) => {
    const run = runOf(attemptId);
    return run !== null && goneRuns.has(run);
  };
  for (const id of Object.keys(activity)) if (gone(id)) delete draft.map('activity')[id];
  for (const id of Object.keys(diffstats)) if (gone(id)) delete draft.map('diffstats')[id];
  for (const id of Object.keys(draft.next.transcripts)) if (gone(id)) delete draft.map('transcripts')[id];
}

// ---------------------------------------------------------------------------------------------
// Selectors (pure; memoized on collection identity so React selectors return stable references)
// ---------------------------------------------------------------------------------------------

function memoByRun<C extends object, R>(compute: (collection: C, runId: string) => R) {
  const cache = new WeakMap<C, Map<string, R>>();
  return (collection: C, runId: string): R => {
    let perRun = cache.get(collection);
    if (!perRun) {
      perRun = new Map();
      cache.set(collection, perRun);
    }
    if (!perRun.has(runId)) perRun.set(runId, compute(collection, runId));
    return perRun.get(runId) as R;
  };
}

export const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled']);

const runListCache = new WeakMap<Record<string, Run>, Run[]>();
const archivedCache = new WeakMap<Record<string, Run>, Run[]>();

/** Archived runs (only in the store when "Show archived" is on), most recently updated first. */
export function selectArchivedRuns(state: DataState): Run[] {
  const cached = archivedCache.get(state.runs);
  if (cached) return cached;
  const list = Object.values(state.runs)
    .filter(isArchived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  archivedCache.set(state.runs, list);
  return list;
}

/**
 * Runs for the rail: active runs oldest first (stable workspace numbers), then finished runs newest first.
 * Archived runs are left out (see `selectArchivedRuns`).
 */
export function selectRunList(state: DataState): Run[] {
  const cached = runListCache.get(state.runs);
  if (cached) return cached;
  const runs = Object.values(state.runs).filter((r) => !isArchived(r));
  const active = runs.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status)).sort((a, b) => a.createdAt - b.createdAt);
  const finished = runs.filter((r) => TERMINAL_RUN_STATUSES.has(r.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const list = [...active, ...finished];
  runListCache.set(state.runs, list);
  return list;
}

const compareNode = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b);

export const tasksOfRun = memoByRun((tasks: Record<string, Task>, runId: string) =>
  Object.values(tasks)
    .filter((t) => t.runId === runId)
    .sort((a, b) => compareNode(a.nodeId, b.nodeId)),
);

export const plansOfRun = memoByRun((plans: Record<string, Plan>, runId: string) =>
  Object.values(plans)
    .filter((p) => p.runId === runId)
    .sort((a, b) => a.version - b.version),
);

export const attemptsOfRun = memoByRun((attempts: Record<string, Attempt>, runId: string) =>
  Object.values(attempts)
    .filter((a) => a.runId === runId)
    .sort((a, b) => a.startedAt - b.startedAt),
);

export const reviewsOfRun = memoByRun((reviews: Record<string, Review>, runId: string) =>
  Object.values(reviews)
    .filter((r) => r.runId === runId)
    .sort((a, b) => a.createdAt - b.createdAt),
);

export const mergesOfRun = memoByRun((merges: Record<string, Merge>, runId: string) =>
  Object.values(merges)
    .filter((m) => m.runId === runId)
    .sort((a, b) => a.createdAt - b.createdAt),
);

export const verificationsOfRun = memoByRun((verifications: Record<string, Verification>, runId: string) =>
  Object.values(verifications)
    .filter((v) => v.runId === runId)
    .sort((a, b) => a.createdAt - b.createdAt),
);

/** Open (unresolved) inbox items, oldest first. runId '*' = all runs. */
export const openInbox = memoByRun((inbox: Record<string, InboxItem>, runId: string) =>
  Object.values(inbox)
    .filter((i) => i.resolvedAt === null && (runId === '*' || i.runId === runId))
    .sort((a, b) => a.createdAt - b.createdAt),
);

export function latestPlan(state: DataState, runId: string): Plan | null {
  return plansOfRun(state.plans, runId).at(-1) ?? null;
}

export function taskByNode(state: DataState, runId: string, nodeId: string): Task | null {
  return tasksOfRun(state.tasks, runId).find((t) => t.nodeId === nodeId) ?? null;
}

export function attemptsOfTask(state: DataState, task: Task): Attempt[] {
  return attemptsOfRun(state.attempts, task.runId).filter((a) => a.taskId === task.id);
}

/** Latest attempt for a task, optionally of one role. */
export function latestAttempt(state: DataState, task: Task, role?: Attempt['role']): Attempt | null {
  const attempts = attemptsOfTask(state, task).filter((a) => !role || a.role === role);
  return attempts.at(-1) ?? null;
}

export function latestReview(state: DataState, taskId: string | null, runId: string): Review | null {
  return (
    reviewsOfRun(state.reviews, runId)
      .filter((r) => r.taskId === taskId)
      .at(-1) ?? null
  );
}

export function runCost(state: DataState, runId: string): number {
  if (state.loadedRuns[runId] === undefined) return state.summaries[runId]?.costUsd ?? 0;
  return attemptsOfRun(state.attempts, runId).reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
}

export function taskCounts(state: DataState, runId: string): Partial<Record<TaskStatus, number>> {
  if (state.loadedRuns[runId] === undefined) return state.summaries[runId]?.taskCounts ?? {};
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const task of tasksOfRun(state.tasks, runId)) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

export function openInboxCount(state: DataState, runId: string): number {
  const count = openInbox(state.inbox, runId).length;
  return count > 0 || state.loadedRuns[runId] !== undefined ? count : (state.summaries[runId]?.openInbox ?? 0);
}

/** Running agent sessions (all runs, or one). */
export function runningAttempts(state: DataState, runId?: string): Attempt[] {
  return Object.values(state.attempts).filter((a) => a.status === 'running' && (!runId || a.runId === runId));
}
