/**
 * The team: the orchestrator (the assistant the user talks to) and the leads under it. A lead is a long-lived
 * agent session with a role, a brief, a plan and an inbox. It runs workflows and spawns sub-leads, answers its
 * own runs' gates and questions, and reports to its parent. Each lead only hears about its own children, so a
 * parent's context stays small however much happens below it.
 *
 * Messages to a lead go to its inbox and are delivered as one bundled message when it is not busy. State lives in
 * `.legion/team/team.json`; a lead's session resumes after a restart on the next message it gets.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Assistant, type AssistantApproval, type AssistantQuestion } from '../assistant/assistant.ts';
import type { Config, RealKind } from '../config.ts';
import type { AgentEngine, AgentEvent, ApprovalDecision, McpServer, QuestionAnswers } from '../engine/types.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import type { GateAnswer, Interaction } from '../workflow/host.ts';
import type { RunRecord } from '../workflow/journal.ts';
import type { PendingInteraction, RunManager } from '../workflow/manager.ts';
import { allows, findRole, type Role } from './roles.ts';
import type { LeadWorkspace, Workspaces } from './workspace.ts';

export const ROOT = 'orchestrator';

export const REPORT_KINDS = ['progress', 'done', 'blocked', 'question', 'review', 'coordinate'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface InboxItem {
  at: number;
  /** A lead's name, `user`, or `legion` (runs, gates). */
  from: string;
  kind: 'report' | 'message' | 'run' | 'interaction' | 'note';
  report?: ReportKind;
  text: string;
  files?: string[];
}

export const PLAN_STATUSES = ['todo', 'doing', 'done', 'blocked', 'dropped'] as const;
export interface PlanItem {
  id: string;
  title: string;
  status: (typeof PLAN_STATUSES)[number];
  owner?: string | null;
  note?: string | null;
}

export interface Plan {
  summary: string | null;
  items: PlanItem[];
  updatedAt: number;
}

/** One thing the orchestrator shows the user: an image, another file, or a web page. */
export interface PresentedItem {
  kind: 'image' | 'file' | 'url';
  /** An absolute path, or a URL. */
  target: string;
  caption: string | null;
}

/** What `present` shows: images inline when the terminal can draw them, a link to each item either way. */
export interface Presentation {
  title: string;
  items: PresentedItem[];
}

export type LeadStatus = 'starting' | 'working' | 'idle' | 'done' | 'stopped';

export interface LeadRecord {
  name: string;
  role: string;
  parent: string;
  brief: string;
  depth: number;
  engine: RealKind;
  status: LeadStatus;
  createdAt: number;
  sessionId: string | null;
  profile: string | null;
  plan: Plan | null;
  inbox: InboxItem[];
  lastReport: { kind: ReportKind; text: string; at: number } | null;
  costUsd: number;
  /** Its own worktree and branch (absent: it works in the user's checkout; leads from before workspaces, too). */
  workspace?: LeadWorkspace | null;
}

interface LiveLead {
  record: LeadRecord;
  role: Role;
  assistant: Assistant;
  token: string;
  lastActive: number;
}

export interface TeamEvents {
  /** The tree, a status, a plan or an inbox changed. */
  changed: [];
  /** A line for the activity feed: a spawn, a report (in full), a lead stopping. `text` follows the lead's name. */
  activity: [
    {
      lead: string;
      kind: 'spawn' | 'report' | 'stop' | 'message';
      text: string;
      report?: ReportKind;
      files?: string[];
    },
  ];
  /** A lead's own session events (for the UI when the user is talking to that lead). */
  'lead-event': [string, AgentEvent];
  /** A lead's own tool approval, when its role says the human answers them. */
  'lead-approval': [string, AssistantApproval];
  /** A lead asks the user questions itself (`AskUserQuestion`); the user answers them in the UI. */
  'lead-question': [string, AssistantQuestion];
  'lead-resolved': [string];
  /** The orchestrator shows the user something (`present`). */
  present: [Presentation];
}

export interface TeamOptions {
  repo: string;
  runs: RunManager;
  config: () => Config;
  engine: (kind: RealKind) => AgentEngine;
  /** MCP servers every lead gets besides its own Legion endpoint. */
  mcp: () => Readonly<Record<string, McpServer>>;
  /** A lead's system prompt. */
  prompt: (lead: LeadRecord, role: Role) => string;
  /** Lead worktrees (null outside a git repository: every lead shares the checkout). */
  workspaces?: Workspaces | null;
  log?: Logger;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

export class TeamManager extends EventEmitter<TeamEvents> {
  readonly rootToken = randomBytes(24).toString('base64url');
  private readonly opts: TeamOptions;
  private readonly log: Logger;
  private readonly leads = new Map<string, LiveLead>();
  private readonly tokenOwners = new Map<string, string>([[this.rootToken, ROOT]]);
  private rootPlan: Plan | null = null;
  private rootInbox: InboxItem[] = [];
  private root: Assistant | null = null;
  private mcpUrl: string | null = null;
  private closed = false;
  private readonly ensuring = new Map<string, Promise<void>>();

  constructor(opts: TeamOptions) {
    super();
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    opts.runs.on('finished', (record) => this.runFinished(record));
    opts.runs.on('interaction', (pending) => this.runInteraction(pending));
  }

  /**
   * The orchestrator's session and the Legion MCP endpoint, which exist only after the team does. Saved leads are
   * loaded here, since their sessions need the endpoint.
   */
  bind(root: Assistant, mcpUrl: string): void {
    this.root = root;
    this.mcpUrl = mcpUrl;
    this.load();
    root.on('busy', (busy) => {
      if (!busy) void this.flush(ROOT);
    });
  }

  /** Bearer tokens for the MCP server and who each belongs to. */
  tokens(): IterableIterator<[string, string]> {
    return this.tokenOwners.entries();
  }

  // ---- reading ---------------------------------------------------------------------------------

  list(): LeadRecord[] {
    return [...this.leads.values()].map((l) => l.record).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(name: string): LeadRecord | null {
    return this.leads.get(name)?.record ?? null;
  }

  role(name: string): Role | null {
    return this.leads.get(name)?.role ?? null;
  }

  children(name: string): LeadRecord[] {
    return this.list().filter((l) => l.parent === name);
  }

  /** `name` and everything under it. */
  subtree(name: string): LeadRecord[] {
    const out: LeadRecord[] = [];
    const walk = (n: string) => {
      for (const c of this.children(n)) {
        out.push(c);
        walk(c.name);
      }
    };
    walk(name);
    return out;
  }

  plan(name: string): Plan | null {
    return name === ROOT ? this.rootPlan : (this.leads.get(name)?.record.plan ?? null);
  }

  busy(name: string): boolean {
    return name === ROOT ? (this.root?.busy ?? false) : (this.leads.get(name)?.assistant.busy ?? false);
  }

  /** The lead a run belongs to. */
  ownerOf(runId: string): string {
    return this.opts.runs.run(runId)?.owner ?? ROOT;
  }

  /** Active runs a lead started. */
  activeRuns(name: string): RunRecord[] {
    return this.opts.runs.activeRuns().filter((r) => (r.owner ?? ROOT) === name);
  }

  /** Gates and questions of a lead's runs that wait for its answer (tool approvals are the user's). */
  pending(name: string): PendingInteraction[] {
    return this.opts.runs
      .pendingInteractions()
      .filter((p) => this.ownerOf(p.interaction.runId) === name && p.interaction.kind !== 'approval');
  }

  // ---- acting (the MCP tools and the UI call these) --------------------------------------------

  spawn(caller: string, opts: { role: string; name: string; brief: string }): LeadRecord {
    const parent = this.requireCaller(caller);
    const config = this.opts.config();
    if (!NAME.test(opts.name)) throw new Error(`Lead names are lowercase letters, digits and dashes: "${opts.name}"`);
    if (opts.name === ROOT || this.leads.has(opts.name)) throw new Error(`There is already a lead called ${opts.name}`);
    const depth = (parent?.record.depth ?? 0) + 1;
    if (depth > config.team.maxDepth) {
      throw new Error(`${caller} is at the deepest level of leads (${config.team.maxDepth}); run workflows instead`);
    }
    if (parent && !allows(parent.role.spawns, opts.role)) {
      throw new Error(
        `Role ${parent.role.name} may not spawn ${opts.role} (allowed: ${parent.role.spawns === '*' ? 'any' : parent.role.spawns.join(', ') || 'none'})`,
      );
    }
    const role = findRole(this.opts.repo, opts.role);
    const record: LeadRecord = {
      name: opts.name,
      role: role.name,
      parent: caller,
      brief: opts.brief,
      depth,
      engine: role.engine,
      status: 'starting',
      createdAt: Date.now(),
      sessionId: null,
      profile: null,
      plan: null,
      inbox: [],
      lastReport: null,
      costUsd: 0,
      workspace:
        role.workspace === 'branch' && this.opts.workspaces
          ? // A sub-lead branches off its parent's branch; the orchestrator's leads off the user's (when created).
            this.opts.workspaces.plan(opts.name, parent?.record.workspace?.branch ?? null)
          : null,
    };
    this.attach(record, role);
    this.save();
    this.emit('activity', {
      lead: record.name,
      kind: 'spawn',
      text: `(${role.name}) started by ${caller}: ${clip(opts.brief.split('\n')[0] ?? '', 160)}`,
    });
    this.emit('changed');
    void this.send(record.name, `${opts.brief}\n\n(Your brief, from ${caller}.)`);
    return record;
  }

  /** A message from a parent (or the user) to a lead: queued, delivered when the lead is free. */
  message(from: string, to: string, text: string): Promise<void> | undefined {
    const lead = this.leads.get(to);
    if (!lead) throw new Error(`No lead called ${to}`);
    if (from !== 'user' && lead.record.parent !== from) {
      throw new Error(`${to} is not your lead; message your own leads, or report to your parent`);
    }
    if (from === 'user') {
      // The user is talking to the lead directly: no bundling, no waiting (and it wakes a stopped lead).
      return this.send(to, `[User] ${text}`);
    }
    if (lead.record.status === 'stopped') throw new Error(`${to} was stopped`);
    this.enqueue(to, { at: Date.now(), from, kind: 'message', text });
  }

  report(caller: string, kind: ReportKind, text: string, files: string[] = []): void {
    const lead = this.leads.get(caller);
    if (!lead) throw new Error('The orchestrator reports to the user directly, in the conversation');
    lead.record.lastReport = { kind, text: clip(text, 400), at: Date.now() };
    if (kind === 'done') lead.record.status = 'done';
    this.enqueue(lead.record.parent, { at: Date.now(), from: caller, kind: 'report', report: kind, text, files });
    this.emit('activity', {
      lead: caller,
      kind: 'report',
      report: kind,
      files,
      text: `→ ${lead.record.parent}: ${text}`,
    });
  }

  updatePlan(caller: string, plan: { summary?: string | null; items: PlanItem[] }): Plan {
    const next: Plan = { summary: plan.summary ?? null, items: plan.items, updatedAt: Date.now() };
    if (caller === ROOT) this.rootPlan = next;
    else this.requireLead(caller).record.plan = next;
    this.save();
    this.emit('changed');
    return next;
  }

  /** Stops a lead, everything under it and their runs. Its session stays resumable if it is messaged again. */
  async stop(caller: string, name: string): Promise<void> {
    const lead = this.requireLead(name);
    if (caller !== 'user' && lead.record.parent !== caller) throw new Error(`${name} is not your lead`);
    for (const child of this.children(name)) await this.stop('user', child.name);
    for (const run of this.activeRuns(name)) this.opts.runs.cancel(run.id);
    lead.record.status = 'stopped';
    lead.record.inbox = [];
    await lead.assistant.close();
    this.save();
    this.emit('activity', { lead: name, kind: 'stop', text: `stopped by ${caller}` });
    this.emit('changed');
  }

  /** Who answers the interactions of `owner`'s runs: the user (`ask`) or the owner (`decide`, `tell`). */
  gateMode(owner: string): 'ask' | 'decide' | 'tell' {
    if (owner === ROOT) return this.opts.config().team.gates;
    return this.leads.get(owner)?.role.gates ?? 'ask';
  }

  /**
   * Whether the user answers this interaction of a run. Tool approvals always are the user's (they only exist with
   * `approvals = "ask"`, which means "ask me"): routing them through a lead's turn made agents wait minutes per
   * command. Gates and questions follow the owner's gate mode.
   */
  userAnswers(p: PendingInteraction): boolean {
    return p.interaction.kind === 'approval' || this.gateMode(this.ownerOf(p.interaction.runId)) === 'ask';
  }

  /** Tells a lead the user answered one of its runs' interactions in its place. */
  userAnswered(id: string, what: string): void {
    const pending = this.opts.runs.pendingInteractions().find((p) => p.id === id);
    if (!pending) return;
    const owner = this.ownerOf(pending.interaction.runId);
    if (owner === ROOT) return;
    this.enqueue(owner, {
      at: Date.now(),
      from: 'user',
      kind: 'note',
      text: `The user answered ${pending.interaction.kind} ${id} of run ${pending.interaction.runId} (step ${pending.interaction.key}) for you: ${what}`,
    });
  }

  /** A lead (or the user) answers a gate, question or approval of one of its runs. */
  answer(
    caller: string,
    id: string,
    answer: {
      choice?: GateAnswer['choice'];
      note?: string | null;
      answer?: string;
      allow?: boolean;
      answers?: Record<string, string[]> | null;
    },
  ): string {
    const pending = this.opts.runs.pendingInteractions().find((p) => p.id === id);
    if (!pending) throw new Error(`Nothing is waiting with id ${id} (answered already, or its run ended)`);
    const i = pending.interaction;
    if (caller !== 'user' && this.ownerOf(i.runId) !== caller)
      throw new Error(`Interaction ${id} is not from your runs`);
    let said: string;
    if (i.kind === 'gate') {
      if (!answer.choice) throw new Error('A gate takes choice: approve | changes | abort (and a note for changes)');
      this.opts.runs.answer(id, { choice: answer.choice, note: answer.note ?? null });
      said = `gate "${i.title}": ${answer.choice}${answer.note ? ` (${answer.note})` : ''}`;
    } else if (i.kind === 'ask') {
      if (answer.answer === undefined) throw new Error('A question takes answer: "<text>"');
      this.opts.runs.answer(id, { answer: answer.answer });
      said = `question "${i.question}": ${answer.answer}`;
    } else if (i.kind === 'questions') {
      if (answer.answers === undefined) {
        throw new Error('Questions take answers: { "<question id>": ["<option label or text>"] } (or null to decline)');
      }
      this.opts.runs.answer(id, { answers: answer.answers });
      said = answer.answers
        ? `${i.questions.map((q) => `"${q.question}": ${(answer.answers?.[q.id] ?? []).join(', ') || '(none)'}`).join('; ')}`
        : 'questions: declined';
    } else {
      if (answer.allow === undefined) throw new Error('A tool approval takes allow: true | false');
      const decision: ApprovalDecision = answer.allow
        ? { behavior: 'allow', scope: 'once', updatedInput: null }
        : { behavior: 'deny', message: answer.note ?? 'Denied by the lead.', interrupt: false };
      this.opts.runs.answer(id, decision);
      said = `${i.tool}: ${answer.allow ? 'allowed' : 'denied'}`;
    }
    const lead = this.leads.get(caller);
    if (lead && lead.role.gates === 'tell') {
      // Decide-and-tell: the parent hears every answer (and can overrule it with a message).
      this.enqueue(lead.record.parent, {
        at: Date.now(),
        from: caller,
        kind: 'note',
        text: `${caller} answered ${said} in run ${i.runId}.`,
      });
    }
    // Decisions show in the feed; routine tool approvals do not.
    if ((caller === ROOT || lead) && i.kind !== 'approval') {
      this.emit('activity', { lead: caller, kind: 'message', text: `answered ${said}` });
    }
    return said;
  }

  /** May `caller` start this workflow now? Throws why not. */
  checkRun(caller: string, workflow: string): void {
    const lead = this.leads.get(caller);
    if (!lead) return;
    if (!allows(lead.role.workflows, workflow)) {
      throw new Error(
        `Role ${lead.role.name} may not run ${workflow} (allowed: ${lead.role.workflows === '*' ? 'any' : lead.role.workflows.join(', ')})`,
      );
    }
    const active = this.activeRuns(caller).length;
    if (active >= lead.role.maxRuns) {
      throw new Error(`${caller} already has ${active} runs going (role limit ${lead.role.maxRuns}); wait for one`);
    }
  }

  answerLeadApproval(name: string, id: string, decision: ApprovalDecision): void {
    void this.leads.get(name)?.assistant.answer(id, decision);
  }

  answerLeadQuestions(name: string, id: string, answers: QuestionAnswers | null): void {
    void this.leads.get(name)?.assistant.answerQuestions(id, answers);
  }

  interrupt(name: string): Promise<void> {
    return this.leads.get(name)?.assistant.interrupt() ?? Promise.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.save();
    await Promise.all([...this.leads.values()].map((l) => l.assistant.close()));
  }

  // ---- delivery --------------------------------------------------------------------------------

  private enqueue(to: string, item: InboxItem): void {
    if (to === ROOT) this.rootInbox.push(item);
    else {
      const lead = this.leads.get(to);
      if (!lead || lead.record.status === 'stopped') return;
      lead.record.inbox.push(item);
    }
    this.save();
    this.emit('changed');
    void this.flush(to);
  }

  /** Delivers a lead's inbox as one message, unless it is in the middle of a turn (then: when it ends). */
  private async flush(name: string): Promise<void> {
    if (this.closed) return;
    const items = name === ROOT ? this.rootInbox : this.leads.get(name)?.record.inbox;
    if (!items || items.length === 0 || this.busy(name)) return;
    const text = formatInbox(items);
    const taken = items.splice(0, items.length);
    this.save();
    this.emit('changed');
    try {
      // Before the user has said anything there is no conversation to tell: the news is in the UI anyway.
      if (name === ROOT) await this.root?.notify(text);
      else await this.send(name, text);
    } catch (err) {
      this.log.warn(`delivering to ${name} failed`, err);
      items.unshift(...taken);
      this.save();
    }
  }

  private async send(name: string, text: string): Promise<void> {
    const lead = this.requireLead(name);
    lead.lastActive = Date.now();
    if (lead.record.status === 'idle' || lead.record.status === 'done' || lead.record.status === 'stopped') {
      lead.record.status = 'working';
    }
    await this.makeRoom(name);
    try {
      await this.ensureWorkspace(lead);
    } catch {
      return; // Reported in the feed; the next message tries again.
    }
    await lead.assistant.send(text);
  }

  /** Creates a lead's worktree before its session starts in it (and again if its directory went away). */
  private ensureWorkspace(lead: LiveLead): Promise<void> {
    const name = lead.record.name;
    // Messages arriving together share one creation.
    let pending = this.ensuring.get(name);
    if (!pending) {
      pending = this.createWorkspace(lead).finally(() => this.ensuring.delete(name));
      this.ensuring.set(name, pending);
    }
    return pending;
  }

  private async createWorkspace(lead: LiveLead): Promise<void> {
    const ws = lead.record.workspace;
    if (!ws || !this.opts.workspaces) return;
    // A sub-lead branches off its parent's branch, which exists once the parent's worktree does.
    const parent = this.leads.get(lead.record.parent);
    if (parent) await this.ensureWorkspace(parent);
    try {
      const hadBase = ws.base !== null;
      await this.opts.workspaces.ensure(ws);
      if (!hadBase) this.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`lead ${lead.record.name}: could not create its worktree`, err);
      lead.record.status = 'idle';
      this.emit('activity', {
        lead: lead.record.name,
        kind: 'message',
        text: `could not create its worktree ${ws.path} (${ws.branch}): ${message}`,
      });
      this.emit('changed');
      throw err;
    }
  }

  /** Shows the user images, files or pages (the orchestrator's `present`). */
  present(presentation: Presentation): void {
    this.emit('present', presentation);
  }

  /** Where a lead's runs start from and work (its branch and worktree), for `run_workflow`. */
  runPlace(caller: string): { base?: string; cwd?: string } {
    const ws = caller === ROOT ? null : this.leads.get(caller)?.record.workspace;
    return ws && existsSync(ws.path) ? { base: ws.branch, cwd: ws.path } : {};
  }

  /** Uncommitted files where a caller's runs start from (what their worktrees will not have). */
  async uncommitted(caller: string): Promise<string[]> {
    if (!this.opts.workspaces) return [];
    try {
      return await this.opts.workspaces.uncommitted(this.checkoutOf(caller));
    } catch {
      return [];
    }
  }

  /** The checkout a caller works in: its worktree, or the user's checkout. */
  checkoutOf(caller: string): string {
    return (caller === ROOT ? null : this.leads.get(caller)?.record.workspace?.path) ?? this.opts.repo;
  }

  /**
   * Merges a lead's branch into the caller's: its parent's branch, or (for the orchestrator, or a parent without
   * a worktree) the branch checked out in the user's checkout. What the lead left uncommitted is committed first.
   */
  async mergeLead(
    caller: string,
    name: string,
    message?: string,
  ): Promise<{ into: string; sha: string; files: string[] }> {
    const lead = this.requireLead(name);
    if (lead.record.parent !== caller) throw new Error(`${name} is not your lead`);
    const ws = lead.record.workspace;
    const workspaces = this.opts.workspaces;
    if (!ws || !workspaces) throw new Error(`${name} works in the shared checkout; there is no branch to merge`);
    const mine = caller === ROOT ? null : this.leads.get(caller)?.record.workspace;
    const into = mine?.branch ?? (await workspaces.main()).branch;
    if (!into) throw new Error("The user's checkout is on a detached HEAD; there is no branch to merge into");
    const result = await workspaces.merge(ws, into, message ?? `Merge ${name} (${lead.record.role})`);
    this.emit('activity', {
      lead: name,
      kind: 'message',
      text: `merged into ${into} by ${caller}: ${result.files.length} file${result.files.length === 1 ? '' : 's'}`,
    });
    return { into, ...result };
  }

  /** Keeps at most `team.maxLeads` lead processes alive by closing the longest-idle ones (they resume later). */
  private async makeRoom(except: string): Promise<void> {
    const max = this.opts.config().team.maxLeads;
    const alive = [...this.leads.values()].filter((l) => l.assistant.id !== null && l.record.name !== except);
    const idle = alive.filter((l) => !l.assistant.busy).sort((a, b) => a.lastActive - b.lastActive);
    while (alive.length >= max && idle.length > 0) {
      const victim = idle.shift() as LiveLead;
      alive.splice(alive.indexOf(victim), 1);
      await victim.assistant.restart();
    }
  }

  // ---- runs ------------------------------------------------------------------------------------

  private runFinished(record: RunRecord): void {
    const owner = record.owner ?? ROOT;
    const outcome =
      record.status === 'done'
        ? `finished${record.result !== null && record.result !== undefined ? `. Result: ${clip(JSON.stringify(record.result), 3000)}` : ''}`
        : `${record.status}${record.error ? `: ${clip(record.error, 1500)}` : ''}. resume_run continues it from where it stopped.`;
    this.enqueue(owner, {
      at: Date.now(),
      from: 'legion',
      kind: 'run',
      text: `Run ${record.id} (${record.workflow}) ${outcome}`,
    });
  }

  private runInteraction(pending: PendingInteraction): void {
    const owner = this.ownerOf(pending.interaction.runId);
    const run = this.opts.runs.run(pending.interaction.runId);
    if (this.userAnswers(pending)) {
      // The user answers it in the UI; a lead hears why its run is waiting (not for each tool approval).
      if (owner !== ROOT && pending.interaction.kind !== 'approval') {
        this.enqueue(owner, {
          at: Date.now(),
          from: 'legion',
          kind: 'note',
          text: `Run ${pending.interaction.runId}${run ? ` (${run.workflow})` : ''} waits for the user to answer ${pending.interaction.kind} "${interactionTitle(pending.interaction)}".`,
        });
      }
      return;
    }
    this.enqueue(owner, {
      at: Date.now(),
      from: 'legion',
      kind: 'interaction',
      text: describeInteraction(pending.id, pending.interaction, run),
    });
  }

  // ---- lead sessions ---------------------------------------------------------------------------

  private attach(record: LeadRecord, role: Role): LiveLead {
    const token = randomBytes(24).toString('base64url');
    this.tokenOwners.set(token, record.name);
    const assistant = new Assistant({
      cwd: record.workspace?.path ?? this.opts.repo,
      engine: () => this.opts.engine(role.engine),
      systemPrompt: () => this.opts.prompt(record, role),
      mcp: {
        ...this.opts.mcp(),
        legion: { type: 'http', url: this.mcpUrl ?? '', headers: { Authorization: `Bearer ${token}` } },
      },
      model: () => role.model,
      effort: () => role.effort,
      approvals: role.approvals,
      sessionId: record.sessionId,
      log: this.log,
    });
    const live: LiveLead = { record, role, assistant, token, lastActive: Date.now() };
    this.leads.set(record.name, live);
    assistant.on('session', ({ id, profile }) => {
      record.sessionId = id;
      record.profile = profile;
      this.save();
    });
    assistant.on('busy', (busy) => {
      if (!busy && (record.status === 'working' || record.status === 'starting')) record.status = 'idle';
      if (busy && record.status !== 'done') record.status = 'working';
      this.emit('changed');
      if (!busy) void this.flush(record.name);
    });
    assistant.on('event', (event) => {
      if (event.type === 'usage' && event.costUsd !== null && event.costUsd > record.costUsd) {
        record.costUsd = event.costUsd;
      }
      this.emit('lead-event', record.name, event);
    });
    assistant.on('approval', (a) => this.emit('lead-approval', record.name, a));
    assistant.on('question', (q) => this.emit('lead-question', record.name, q));
    assistant.on('resolved', (id) => this.emit('lead-resolved', id));
    return live;
  }

  private requireCaller(caller: string): LiveLead | null {
    if (caller === ROOT) return null;
    return this.requireLead(caller);
  }

  private requireLead(name: string): LiveLead {
    const lead = this.leads.get(name);
    if (!lead) throw new Error(`No lead called ${name}`);
    return lead;
  }

  // ---- persistence -----------------------------------------------------------------------------

  private file(): string {
    return join(this.opts.repo, '.legion', 'team', 'team.json');
  }

  private load(): void {
    let state: { leads?: LeadRecord[]; root?: { plan?: Plan | null; inbox?: InboxItem[] } };
    try {
      state = JSON.parse(readFileSync(this.file(), 'utf8'));
    } catch {
      return;
    }
    this.rootPlan = state.root?.plan ?? null;
    this.rootInbox = state.root?.inbox ?? [];
    for (const record of state.leads ?? []) {
      let role: Role;
      try {
        role = findRole(this.opts.repo, record.role);
      } catch (err) {
        this.log.warn(`lead ${record.name}: role ${record.role} is gone`, err);
        continue;
      }
      // Its process ended with the last session; it picks up again on its next message.
      if (record.status === 'working' || record.status === 'starting') record.status = 'idle';
      this.attach(record, role);
    }
  }

  private save(): void {
    try {
      const file = this.file();
      mkdirSync(join(file, '..'), { recursive: true });
      const state = { root: { plan: this.rootPlan, inbox: this.rootInbox }, leads: this.list() };
      writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.log.warn('could not save the team', err);
    }
  }
}

/** One message for a lead with everything that arrived since its last turn. */
export function formatInbox(items: readonly InboxItem[]): string {
  const lines = items.map((i) => {
    const files = i.files?.length ? `\n  Files: ${i.files.join(', ')}` : '';
    switch (i.kind) {
      case 'report':
        return `- Report from ${i.from} (${i.report}):\n${indent(i.text)}${files}`;
      case 'message':
        return `- Message from ${i.from}:\n${indent(i.text)}`;
      case 'interaction':
        return `- Waiting for your answer:\n${indent(i.text)}`;
      default:
        return `- ${i.text}`;
    }
  });
  return `[Legion] ${items.length === 1 ? 'An update' : `${items.length} updates`} since your last turn:\n${lines.join('\n')}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

function interactionTitle(i: Interaction): string {
  if (i.kind === 'gate') return i.title;
  if (i.kind === 'ask') return i.question;
  if (i.kind === 'questions') return i.questions.map((q) => q.question).join(' / ');
  return i.tool;
}

function describeInteraction(id: string, i: Interaction, run: RunRecord | null): string {
  const where = `run ${i.runId}${run ? ` (${run.workflow})` : ''}, step ${i.key}`;
  if (i.kind === 'gate') {
    return `Gate "${i.title}" in ${where}. id: ${id}\n${i.body ? `${clip(i.body, 6000)}\n` : ''}Answer with answer_interaction({ id: "${id}", choice: "approve" | "changes" | "abort", note }).`;
  }
  if (i.kind === 'ask') {
    return `Question in ${where}: ${i.question}${i.options.length ? `\nOptions: ${i.options.join(' | ')}` : ''}\nid: ${id}. Answer with answer_interaction({ id: "${id}", answer }).`;
  }
  if (i.kind === 'questions') {
    const list = i.questions
      .map(
        (q) =>
          `- id "${q.id}": ${q.question}${q.options.length ? `\n  Options: ${q.options.map((o) => o.label).join(' | ')}` : ''}${q.multiSelect ? ' (several may be picked)' : ''}`,
      )
      .join('\n');
    return `Questions from the agent in ${where}. id: ${id}\n${list}\nAnswer with answer_interaction({ id: "${id}", answers: { "<question id>": ["<label or text>"] } }), or answers: null to decline.`;
  }
  return `Tool approval in ${where}: ${i.tool} ${clip(JSON.stringify(i.input), 1500)}${i.reason ? `\nReason: ${i.reason}` : ''}\nid: ${id}. Answer with answer_interaction({ id: "${id}", allow: true | false, note }).`;
}
