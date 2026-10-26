/**
 * Connects a session to the UI store and turns what the user types into actions: messages for the assistant,
 * slash commands, and answers to the interaction at the head of the queue.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { describeWorkflows } from '../assistant/mcp.ts';
import {
  type ConfigLayer,
  defaultProjectConfig,
  type Effort,
  type RealKind,
  readToml,
  resolveAgentModel,
} from '../config.ts';
import { getPath, setTomlValue, type TomlScalar } from '../config-file.ts';
import { CodexEngine } from '../engine/codex/index.ts';
import type { ApprovalDecision } from '../engine/types.ts';
import type { Session } from '../session.ts';
import { ROOT } from '../team/team.ts';
import type { AskAnswer, GateAnswer } from '../workflow/host.ts';
import {
  builtinSourceDir,
  ejectWorkflow,
  findWorkflow,
  listWorkflowFiles,
  loadWorkflow,
  PACKAGE_ROOT,
  workflowSource,
} from '../workflow/loader.ts';
import type { PendingInteraction } from '../workflow/manager.ts';
import { formatReport, validateWorkflow } from '../workflow/validate.ts';
import type { CommandSpec } from './input.tsx';
import { type Line, type Seg, type TeamRow, type UiInteraction, UiStore } from './store.ts';
import { tildify } from './theme.ts';

interface Command extends CommandSpec {
  group: 'Workflows' | 'Runs' | 'Team' | 'Session';
}

export const COMMANDS: readonly Command[] = [
  { group: 'Workflows', name: 'workflows', args: '', description: 'browse workflows: inspect, run, set models' },
  { group: 'Workflows', name: 'run', args: '<name> [json]', description: 'start a workflow' },
  { group: 'Workflows', name: 'validate', args: '<name>', description: 'type-check and dry-run a workflow' },
  { group: 'Runs', name: 'runs', args: '', description: 'recent runs' },
  { group: 'Team', name: 'team', args: '', description: 'the leads: what each is doing, its plan and last report' },
  {
    group: 'Team',
    name: 'lead',
    args: '[name]',
    description: 'talk to a lead directly (no name: back to the orchestrator)',
  },
  { group: 'Team', name: 'stop', args: '<lead>', description: 'stop a lead, its sub-leads and their runs' },
  { group: 'Runs', name: 'steps', args: '[run]', description: "a run's steps" },
  { group: 'Runs', name: 'log', args: '<run> <step>', description: "an agent step's transcript" },
  { group: 'Runs', name: 'resume', args: '[run]', description: 'continue a stopped run' },
  { group: 'Runs', name: 'cancel', args: '[run]', description: 'stop an active run' },
  { group: 'Runs', name: 'takeover', args: '<run> <step>', description: "steer an agent's session in its own CLI" },
  { group: 'Session', name: 'config', args: '', description: 'settings: change them in a menu' },
  { group: 'Session', name: 'claude', args: '[profile]', description: 'show or switch the Claude account' },
  { group: 'Session', name: 'codex', args: '[profile]', description: 'show or switch the Codex account' },
  { group: 'Session', name: 'builtin', args: '', description: 'where the builtin workflows live' },
  { group: 'Session', name: 'help', args: '', description: 'commands and keys' },
  { group: 'Session', name: 'exit', args: '', description: 'quit (active runs stop; resume them later)' },
];

const seg = (text: string, style: Omit<Seg, 'text'> = {}): Seg => ({ text, ...style });
const dim = (text: string): Seg => ({ text, dim: true });

export function helpLines(): Line[] {
  const lines: Line[] = [[dim('Talk to the assistant: ask it to write, change or run workflows. Or use a command:')]];
  const width = Math.max(...COMMANDS.map((c) => c.name.length + c.args.length + 2));
  for (const group of ['Workflows', 'Runs', 'Team', 'Session'] as const) {
    lines.push([], [seg(group, { bold: true })]);
    for (const c of COMMANDS.filter((x) => x.group === group)) {
      const label = `/${c.name}${c.args ? ` ${c.args}` : ''}`;
      lines.push([seg(`  ${label.padEnd(width + 1)}`, { color: 'accent' }), dim(c.description)]);
    }
  }
  lines.push(
    [],
    [seg('Keys', { bold: true })],
    [
      seg('  Esc', { color: 'accent' }),
      dim(' interrupt the assistant   '),
      seg('Ctrl+C ×2', { color: 'accent' }),
      dim(' exit'),
    ],
    [
      seg('  ↑↓', { color: 'accent' }),
      dim(' history   '),
      seg('\\ Enter', { color: 'accent' }),
      dim(' new line   '),
      seg('Tab', { color: 'accent' }),
      dim(' complete a command, or switch between answering and chatting'),
    ],
  );
  return lines;
}

/** Where the settings menu saves. Parent-directory configs are read but not written from the menu. */
export type SaveScope = 'project' | 'local' | 'user';
export const SAVE_SCOPES: readonly SaveScope[] = ['project', 'local', 'user'];

export interface SettingRow {
  /** `assistant.model`, `profile.claude`, or `open` (the file in $EDITOR). */
  id: string;
  group: string;
  label: string;
  kind: 'choice' | 'text' | 'number' | 'action';
  /** The value in effect; null = not set (the default applies). */
  value: TomlScalar | null;
  choices?: readonly (string | null)[];
  min?: number;
  max?: number;
  hint: string;
  /** Which file sets the value in effect (`default` when none does). */
  source?: string;
  /** A file that applies after the one being saved to and sets this too, so saving changes nothing. */
  shadowedBy?: string;
}

const CONFIG_SETTINGS: readonly Omit<SettingRow, 'value'>[] = [
  {
    id: 'assistant.engine',
    group: 'Assistant',
    label: 'engine',
    kind: 'choice',
    choices: ['claude', 'codex'],
    hint: 'the engine you talk to',
  },
  {
    id: 'assistant.model',
    group: 'Assistant',
    label: 'model',
    kind: 'text',
    hint: "←→ picks from the engine's models, Enter types one; empty: the CLI's default",
  },
  {
    id: 'assistant.effort',
    group: 'Assistant',
    label: 'effort',
    kind: 'choice',
    choices: [null, 'low', 'medium', 'high', 'xhigh', 'max'],
    hint: 'reasoning effort',
  },
  {
    id: 'workflows.approvals',
    group: 'Workflows',
    label: 'approvals',
    kind: 'choice',
    choices: ['ask', 'auto'],
    hint: "ask: you answer agents' tool approvals · auto: the engine decides",
  },
  {
    id: 'workflows.maxAgents',
    group: 'Workflows',
    label: 'maxAgents',
    kind: 'number',
    min: 1,
    max: 32,
    hint: 'agent sessions alive at once per run',
  },
  {
    id: 'team.gates',
    group: 'Team',
    label: 'gates',
    kind: 'choice',
    choices: ['ask', 'decide'],
    hint: "your runs' gates and questions · ask: you answer · decide: the assistant does, escalating what it can't",
  },
  {
    id: 'team.maxDepth',
    group: 'Team',
    label: 'maxDepth',
    kind: 'number',
    min: 1,
    max: 6,
    hint: 'levels of team leads under the assistant',
  },
  {
    id: 'team.maxLeads',
    group: 'Team',
    label: 'maxLeads',
    kind: 'number',
    min: 1,
    max: 64,
    hint: 'lead sessions alive at once; the longest-idle ones close and resume later',
  },
];

export type WorkflowSummary = Awaited<ReturnType<typeof describeWorkflows>>[number];

export interface InputField {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  default: unknown;
}

/** An agent step of a workflow, as the dry run found it (one entry per key, however often it ran). */
export interface WorkflowAgent {
  key: string;
  engines: string[];
  steps: string[];
  /** What the code asks for. */
  model: string | null;
  effort: Effort | null;
}

export interface WorkflowDetail {
  name: string;
  source: string;
  file: string;
  overrides: string[];
  description: string;
  inputs: InputField[];
  agents: WorkflowAgent[];
  error: string | null;
}

export type ModelFieldName = 'engine' | 'model' | 'effort';

export interface ModelField {
  /** The value this row sets in the config, or null. */
  set: string | null;
  /** What applies when this row sets nothing, and where that comes from, for each engine the row may run on. */
  inherited: Record<RealKind, { value: string | null; from: string }>;
  /** The file that sets `set` (default: none). */
  source: string;
  shadowedBy?: string;
}

export interface ModelRow {
  /** The config table: `['workflow', 'feature', 'claude']` or `['workflow', 'feature', 'agent', 'plan']`. */
  path: string[];
  label: string;
  /** An engine's agents (`engine` is fixed), or one agent step (`engine` can move it). */
  kind: 'engine' | 'step';
  /** The engines the code runs this step on (an engine row: its own). */
  engines: RealKind[];
  steps: string[];
  engine: ModelField | null;
  model: ModelField;
  effort: ModelField;
}

/** A model a picker offers. */
export interface ModelChoice {
  id: string;
  description: string;
}

/**
 * Claude Code has no command that lists models, so its picker offers the aliases (they follow the newest model of
 * each family) and the current model IDs; `[claude] models = [...]` adds more.
 */
const CLAUDE_MODELS: readonly ModelChoice[] = [
  { id: 'opus', description: 'alias: the newest Opus, the most capable' },
  { id: 'sonnet', description: 'alias: the newest Sonnet, balanced' },
  { id: 'haiku', description: 'alias: the newest Haiku, fastest' },
  { id: 'claude-opus-5-5', description: 'Opus 5.5, pinned' },
  { id: 'claude-sonnet-5-5', description: 'Sonnet 5.5, pinned' },
  { id: 'claude-haiku-5-5', description: 'Haiku 5.5, pinned' },
  { id: 'claude-fable-5-1', description: 'Fable 5.1, pinned' },
];

/** A workflow's input fields from its zod schema. */
function inputFields(schema: z.ZodType): InputField[] {
  let json: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  try {
    json = z.toJSONSchema(schema, { io: 'input' }) as typeof json;
  } catch {
    return [];
  }
  return Object.entries(json.properties ?? {}).map(([name, p]) => ({
    name,
    type: typeof p.type === 'string' ? p.type : Array.isArray(p.enum) ? p.enum.map(String).join(' | ') : 'value',
    required: (json.required ?? []).includes(name),
    description: typeof p.description === 'string' ? p.description : null,
    default: p.default,
  }));
}

export interface ControllerHooks {
  /** Hands the terminal to a child process (agent takeover) and back. */
  suspend(run: () => void): Promise<void>;
  exit(): void;
}

export class Controller {
  readonly store: UiStore;
  private readonly session: Session;
  private hooks: ControllerHooks | null = null;
  private readonly modelCache = new Map<string, Promise<{ models: ModelChoice[]; error: string | null }>>();

  constructor(session: Session) {
    this.session = session;
    this.store = new UiStore({ profiles: session.profileNames() });
    this.store.push({ type: 'banner', banner: this.banner() });
    const { assistant, runs } = session;
    // The prompt talks to the orchestrator or to one lead (`/lead`): that one's conversation streams; the
    // orchestrator's replies still show while the user talks to a lead, other leads' do not.
    assistant.on('event', (e) => {
      if (this.target === ROOT) this.store.assistantEvent(e);
      else if (e.type === 'message' && e.text.trim()) {
        this.store.push({ type: 'assistant', text: e.text.trim(), speaker: ROOT });
      }
    });
    assistant.on('busy', (b) => {
      if (this.target === ROOT) this.store.setBusy(b);
    });
    assistant.on('approval', (a) => this.store.assistantApproval(a));
    assistant.on('resolved', (id) => this.store.resolved(id));
    runs.on('event', (e) => this.store.runEvent(e, (id) => runs.run(id)));
    // A lead answers its own runs' gates and questions; the user answers the orchestrator's. (The team tells the
    // owner when a run finishes.)
    runs.on('interaction', (p) => {
      if (this.shows(p)) this.store.runInteraction(p);
    });
    runs.on('resolved', (id) => this.store.resolved(id));
    const { team } = session;
    team.on('activity', (a) => this.store.push({ type: 'team', ...a, report: a.report ?? null, files: a.files ?? [] }));
    team.on('changed', () => {
      this.store.update({ team: this.teamRows() }, false);
      if (this.target !== ROOT) this.store.setBusy(team.busy(this.target));
    });
    team.on('lead-event', (lead, e) => {
      if (lead === this.target) this.store.assistantEvent(e, lead);
    });
    // Leads saved by an earlier session.
    this.store.update({ team: this.teamRows() });
    team.on('lead-approval', (lead, a) => this.store.assistantApproval(a, lead));
    team.on('lead-resolved', (id) => this.store.resolved(id));
  }

  attach(hooks: ControllerHooks): void {
    this.hooks = hooks;
  }

  // ---- input ---------------------------------------------------------------------------------

  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      await this.command(trimmed);
      return;
    }
    const to = this.target;
    this.store.push({ type: 'user', text: trimmed, ...(to === ROOT ? {} : { to }) });
    try {
      if (to === ROOT) await this.session.assistant.send(trimmed);
      else await this.session.team.message('user', to, trimmed);
    } catch (err) {
      this.store.error(err instanceof Error ? err.message : String(err));
    }
  }

  async interrupt(): Promise<void> {
    if (this.target !== ROOT) await this.session.team.interrupt(this.target);
    else if (this.session.assistant.busy) await this.session.assistant.interrupt();
  }

  // ---- team ----------------------------------------------------------------------------------

  /** Who the prompt talks to. */
  get target(): string {
    return this.store.get().target;
  }

  /**
   * Switches the prompt to a lead (or back to the orchestrator). While attached, the lead's conversation streams
   * here and its runs' gates and questions join the queue, so the user can answer them in its place.
   */
  talkTo(name: string): void {
    const { team, runs } = this.session;
    if (name !== ROOT && !team.get(name)) {
      const names = team.list().map((l) => l.name);
      throw new Error(`No lead called ${name}.${names.length ? ` Leads: ${names.join(', ')}` : ''}`);
    }
    const prev = this.target;
    if (prev === name) return;
    this.store.update({ target: name, streaming: '', activity: null });
    // Interactions that were shown only because of the old target go; the new target's come in.
    for (const p of runs.pendingInteractions()) {
      const owner = team.ownerOf(p.interaction.runId);
      if (owner === prev && !this.shows(p)) this.store.resolved(p.id);
      else if (owner === name && name !== ROOT && !this.store.get().interactions.some((i) => i.id === p.id)) {
        this.store.runInteraction(p);
      }
    }
    this.store.setBusy(name === ROOT ? this.session.assistant.busy : team.busy(name));
    if (name === ROOT) {
      this.store.info('Back to the orchestrator.');
      return;
    }
    const lead = team.get(name);
    if (!lead) return;
    const lines: Line[] = [
      [dim('role '), seg(lead.role, { bold: true }), dim(`  parent ${lead.parent}  status ${lead.status}`)],
      [],
      ...lead.brief
        .split('\n')
        .slice(0, 8)
        .map((l) => [dim(l)]),
    ];
    if (lead.lastReport) lines.push([], [dim(`last report (${lead.lastReport.kind}): `), seg(lead.lastReport.text)]);
    lines.push([], [dim('Messages now go to '), seg(name, { color: 'accent', bold: true }), dim('. /lead goes back.')]);
    this.store.panel(`Talking to ${name}`, lines);
  }

  /**
   * Whether the UI asks the user for this interaction: when its owner's gate mode says the user answers, and the
   * runs of the lead the user is talking to (stepping in for it).
   */
  private shows(p: PendingInteraction): boolean {
    const { team } = this.session;
    const owner = team.ownerOf(p.interaction.runId);
    return team.gateMode(owner) === 'ask' || (owner !== ROOT && owner === this.target);
  }

  /** Answers one of a run's interactions; when it belonged to a lead, the lead hears about it. */
  private answerRun(id: string, answer: GateAnswer | AskAnswer | ApprovalDecision, what: string): void {
    this.session.team.userAnswered(id, what);
    this.session.runs.answer(id, answer);
  }

  /** The live team panel: every lead that is not stopped, in tree order. */
  teamRows(): TeamRow[] {
    const { team } = this.session;
    const rows: TeamRow[] = [];
    const walk = (parent: string) => {
      for (const l of team.children(parent)) {
        if (l.status === 'stopped') continue;
        const items = l.plan?.items ?? [];
        const live = items.filter((i) => i.status !== 'dropped');
        rows.push({
          name: l.name,
          role: l.role,
          depth: l.depth,
          status: team.busy(l.name) ? 'working' : l.status,
          doing: items.find((i) => i.status === 'doing')?.title ?? null,
          progress: live.length ? { done: live.filter((i) => i.status === 'done').length, total: live.length } : null,
          runs: team.activeRuns(l.name).length,
          waiting: team.pending(l.name).length,
          inbox: l.inbox.length,
          costUsd: l.costUsd,
        });
        walk(l.name);
      }
    };
    walk(ROOT);
    return rows;
  }

  // ---- interactions --------------------------------------------------------------------------

  head(): UiInteraction | null {
    return this.store.get().interactions[0] ?? null;
  }

  answerGate(id: string, choice: 'approve' | 'changes' | 'abort', note: string | null = null): void {
    this.answerRun(id, { choice, note }, `${choice}${note ? ` (${note})` : ''}`);
  }

  answerAsk(id: string, answer: string): void {
    this.answerRun(id, { answer }, answer);
  }

  answerApproval(item: UiInteraction, decision: ApprovalDecision): void {
    if (item.source === 'assistant' && item.lead) this.session.team.answerLeadApproval(item.lead, item.id, decision);
    else if (item.source === 'assistant') void this.session.assistant.answer(item.id, decision);
    else this.answerRun(item.id, decision, decision.behavior === 'allow' ? 'allowed' : 'denied');
  }

  /** The lead tree under the orchestrator, each with its status, plan and last report. */
  teamLines(): Line[] {
    const { team } = this.session;
    const planLines = (name: string, pad: string): Line[] => {
      const plan = team.plan(name);
      if (!plan) return [];
      const mark = { todo: '○', doing: '◐', done: '●', blocked: '✗', dropped: '–' } as const;
      const color = { todo: 'muted', doing: 'accent', done: 'ok', blocked: 'error', dropped: 'muted' } as const;
      return [
        ...(plan.summary ? [[dim(`${pad}${plan.summary}`)]] : []),
        ...plan.items.map((i) => [
          seg(`${pad}${mark[i.status]} `, { color: color[i.status] }),
          seg(i.title, { dim: i.status === 'done' || i.status === 'dropped' }),
          ...(i.owner ? [dim(` · ${i.owner}`)] : []),
        ]),
      ];
    };
    const lines: Line[] = [[seg('orchestrator', { bold: true, color: 'accent' }), dim(' (you are talking to it)')]];
    lines.push(...planLines(ROOT, '  '));
    const walk = (parent: string, pad: string) => {
      for (const l of team.children(parent)) {
        const status = team.busy(l.name) ? 'working' : l.status;
        const runs = team.activeRuns(l.name);
        const waiting = team.pending(l.name).length;
        lines.push([
          seg(`${pad}${l.name}`, { bold: true }),
          dim(` ${l.role}  `),
          seg(status, {
            color:
              status === 'working' ? 'accent' : status === 'done' ? 'ok' : status === 'stopped' ? 'muted' : undefined,
          }),
          ...(runs.length ? [dim(`  ${runs.length} run${runs.length > 1 ? 's' : ''}`)] : []),
          ...(waiting ? [seg(`  ${waiting} waiting for it`, { color: 'warn' })] : []),
          ...(l.costUsd > 0 ? [dim(`  $${l.costUsd.toFixed(2)}`)] : []),
        ]);
        lines.push(...planLines(l.name, `${pad}  `));
        if (l.lastReport) {
          lines.push([dim(`${pad}  ↳ ${l.lastReport.kind}: `), seg(l.lastReport.text.split('\n')[0] ?? '')]);
        }
        walk(l.name, `${pad}  `);
      }
    };
    walk(ROOT, '  ');
    if (lines.length === 1 + (team.plan(ROOT) ? 1 : 0) && team.list().length === 0) {
      lines.push(
        [],
        [dim('No leads yet. Ask the assistant to spawn one for a big area of work (list_roles shows the kinds).')],
      );
    }
    return lines;
  }

  // ---- commands ------------------------------------------------------------------------------

  async command(line: string): Promise<void> {
    const [cmd = '', ...rest] = line.slice(1).split(/\s+/);
    const arg = line.slice(1 + cmd.length).trim();
    const { runs } = this.session;
    try {
      switch (cmd) {
        case 'help':
        case '?':
          this.store.panel('Help', helpLines());
          return;
        case 'exit':
        case 'quit':
          this.hooks?.exit();
          return;
        case 'workflows': {
          if (rest[0] !== 'list') {
            this.openWorkflows();
            return;
          }
          const list = await describeWorkflows(this.session.repo);
          if (list.length === 0) {
            this.store.info('No workflows.');
            return;
          }
          const width = Math.max(...list.map((w) => w.name.length));
          this.store.panel(
            'Workflows',
            list.map((w) => [
              seg(w.name.padEnd(width + 2), { color: 'accent', bold: true }),
              dim(`${w.source.padEnd(9)}`),
              'error' in w ? seg(`⚠ ${w.error}`, { color: 'warn' }) : seg(w.description),
            ]),
          );
          return;
        }
        case 'run': {
          const [name = '', ...json] = rest;
          if (!name) throw new Error('Usage: /run <workflow> [json input]');
          const input = json.length ? JSON.parse(json.join(' ')) : {};
          await runs.start(name, input);
          return;
        }
        case 'runs': {
          const list = runs.runs().slice(0, 15);
          if (list.length === 0) {
            this.store.info('No runs yet. Start one with /run <workflow>, or ask the assistant.');
            return;
          }
          this.store.panel(
            'Runs',
            list.map((r) => {
              const status = runs.isActive(r.id) ? 'active' : r.status;
              return [
                statusSeg(status),
                seg(` ${r.id}  `, { dim: true }),
                seg(r.workflow.padEnd(14), { bold: true }),
                ...(r.owner ? [dim(` ${r.owner}`)] : []),
                ...(r.error ? [seg(` ${r.error.split('\n')[0]}`, { color: 'error' })] : []),
              ];
            }),
          );
          return;
        }
        case 'team':
          this.store.panel('Team', this.teamLines());
          return;
        case 'lead':
          this.talkTo(rest[0] || ROOT);
          return;
        case 'stop': {
          if (!rest[0]) throw new Error('Usage: /stop <lead>');
          await this.session.team.stop('user', rest[0]);
          if (this.target === rest[0]) this.talkTo(ROOT);
          return;
        }
        case 'resume':
          await runs.resume(this.runId(rest[0]));
          return;
        case 'cancel':
          if (!runs.cancel(this.runId(rest[0]))) this.store.info('That run is not active.');
          return;
        case 'steps': {
          const id = this.runId(rest[0]);
          const steps = runs.journal(id).all();
          this.store.panel(
            `Steps of ${id}`,
            steps.length === 0
              ? [[dim('No steps yet.')]]
              : steps.map((s) => [
                  s.status === 'done'
                    ? seg('✓ ', { color: 'ok' })
                    : s.status === 'failed'
                      ? seg('✗ ', { color: 'error' })
                      : seg('… ', { color: 'warn' }),
                  dim(`${s.kind.padEnd(6)}`),
                  seg(s.key),
                  ...(typeof s.meta?.engine === 'string' ? [dim(` · ${s.meta.engine}`)] : []),
                  ...(s.error ? [seg(` ${s.error.split('\n')[0]}`, { color: 'error' })] : []),
                ]),
          );
          return;
        }
        case 'log':
          this.store.info(this.transcript(this.runId(rest[0]), rest[1] ?? ''));
          return;
        case 'takeover':
          await this.takeover(this.runId(rest[0]), rest[1] ?? '');
          return;
        case 'validate': {
          const found = findWorkflow(this.session.repo, arg);
          if (!found) throw new Error(`No workflow named "${arg}"`);
          this.store.info(formatReport(await validateWorkflow(found.file, { repo: this.session.repo })));
          return;
        }
        case 'config':
          await this.config(rest[0], rest[1]);
          return;
        case 'claude':
        case 'codex':
          await this.profile(cmd, rest[0]);
          return;
        case 'builtin':
          this.store.info(`Builtin workflow sources: ${builtinSourceDir()}`);
          return;
        default:
          throw new Error(`Unknown command /${cmd}. /help lists them.`);
      }
    } catch (err) {
      this.store.error(err instanceof Error ? err.message : String(err));
    }
  }

  /** A run id from an argument, accepting a unique prefix or suffix; default: the newest run. */
  private runId(arg: string | undefined): string {
    const all = this.session.runs.runs();
    if (!arg) {
      const latest = all[0];
      if (!latest) throw new Error('No runs yet.');
      return latest.id;
    }
    const matches = all.filter((r) => r.id === arg || r.id.startsWith(arg) || r.id.endsWith(arg));
    if (matches.length === 1 && matches[0]) return matches[0].id;
    throw new Error(matches.length ? `"${arg}" matches several runs` : `No run "${arg}"`);
  }

  private async profile(kind: RealKind, name: string | undefined): Promise<void> {
    if (!name) {
      const current = this.session.profile(kind).name;
      this.store.panel(
        `${kind} profiles`,
        this.session
          .availableProfiles(kind)
          .map((p) => [
            p === current ? seg('● ', { color: kind }) : dim('○ '),
            seg(p, { bold: p === current }),
            ...(p === current ? [dim('  in use')] : []),
          ]),
      );
      return;
    }
    const { setupOutput } = await this.session.switchProfile(kind, name);
    this.store.update({ profiles: this.session.profileNames() });
    this.store.info(
      `${kind} now uses profile "${name}" for new agents${setupOutput ? `\n${setupOutput}` : ''}` +
        (this.session.config.assistant.engine === kind ? '\nThe assistant starts a new conversation on it.' : ''),
    );
  }

  private banner() {
    const { session } = this;
    let version = '';
    try {
      version = (JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    } catch {}
    const branch = session.isGitRepo
      ? spawnSync('git', ['branch', '--show-current'], { cwd: session.cwd, encoding: 'utf8' }).stdout?.trim() || null
      : null;
    const { engine, model } = session.config.assistant;
    return {
      version,
      cwd: tildify(session.cwd, homedir()),
      branch,
      isGitRepo: session.isGitRepo,
      profiles: session.profileNames(),
      assistant: `${engine}${model ? ` · ${model}` : ''}`,
      workflows: listWorkflowFiles(session.repo).length,
      createdConfig: session.createdConfig
        ? relative(session.cwd, session.createdConfig) || session.createdConfig
        : null,
    };
  }

  /** `/config`, `/config edit [user|project|local|<n>]`, `/config reload`. */
  private async config(action: string | undefined, which: string | undefined): Promise<void> {
    const layers = this.session.configLayers();
    if (!action) {
      this.store.update({ menu: 'config' });
      return;
    }
    if (action === 'show') {
      this.store.panel('Configuration', this.configLines(layers));
      return;
    }
    if (action === 'reload') {
      await this.reload();
      return;
    }
    if (action !== 'edit') throw new Error('Usage: /config [edit [user|project|local]|reload]');
    const target = pickLayer(layers, which);
    if (!existsSync(target.path)) {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(
        target.path,
        target.scope === 'local'
          ? '# Machine-specific overrides for this project (gitignored). Same keys as config.toml.\n'
          : defaultProjectConfig(this.session.config),
      );
    }
    const before = readFileSync(target.path, 'utf8');
    await this.openInEditor(target.path);
    if (readFileSync(target.path, 'utf8') === before) {
      this.store.info(`No changes to ${this.showPath(target.path)}.`);
      return;
    }
    await this.reload();
  }

  // ---- settings menu -------------------------------------------------------------------------

  closeMenu(): void {
    this.store.update({ menu: null });
  }

  /** The menu's rows, with the values in effect and where they come from. */
  settings(scope: SaveScope): SettingRow[] {
    const origin = this.valueOrigins(scope);
    const effective = this.session.config as unknown as Record<string, unknown>;
    const rows: SettingRow[] = CONFIG_SETTINGS.map((def) => {
      const value = getPath(effective, def.id);
      return { ...def, value: value === undefined ? null : (value as TomlScalar), ...origin(def.id.split('.')) };
    });
    for (const kind of ['claude', 'codex'] as const) {
      rows.push({
        id: `profile.${kind}`,
        group: 'This session',
        label: kind,
        kind: 'choice',
        choices: this.session.availableProfiles(kind),
        value: this.session.profile(kind).name,
        hint: 'the account new agents use',
      });
    }
    rows.push({ id: 'open', group: 'Files', label: 'Open the file in $EDITOR', kind: 'action', value: null, hint: '' });
    return rows;
  }

  /**
   * For a config path: the file whose value is in effect (`default` when none sets it), and a file applying after
   * the one `scope` saves to that sets it too (saving there would then change nothing).
   */
  private valueOrigins(scope: SaveScope): (path: readonly string[]) => { source: string; shadowedBy?: string } {
    const layers = this.session.configLayers();
    const docs = layers.map((l) => {
      try {
        return l.exists ? readToml(l.path) : {};
      } catch {
        return {};
      }
    });
    const target = targetIndex(layers, scope);
    return (path) => {
      let source = 'default';
      let shadowedBy: string | undefined;
      docs.forEach((doc, i) => {
        if (getPath(doc, path) === undefined) return;
        source = layers[i]?.scope ?? source;
        if (i > target) shadowedBy = layers[i]?.scope;
      });
      return shadowedBy ? { source, shadowedBy } : { source };
    };
  }

  /** Writes settings into `scope`'s file in one go and reloads. Returns the file and what the reload changed. */
  private async writeConfig(
    scope: SaveScope,
    edits: readonly { path: readonly string[]; key: string; value: TomlScalar | null }[],
  ): Promise<{ file: string; notes: string[] }> {
    const layers = this.session.configLayers();
    const layer = layers[targetIndex(layers, scope)];
    if (!layer) throw new Error(`No ${scope} config file`);
    let text = existsSync(layer.path)
      ? readFileSync(layer.path, 'utf8')
      : scope === 'project'
        ? defaultProjectConfig(this.session.config)
        : scope === 'local'
          ? '# Machine-specific overrides for this project (gitignored). Same keys as config.toml.\n'
          : '# Legion user configuration: applies to every project.\n';
    for (const e of edits) text = setTomlValue(text, e.path, e.key, e.value);
    mkdirSync(dirname(layer.path), { recursive: true });
    writeFileSync(layer.path, text);
    return { file: layer.path, notes: await this.session.reloadConfig() };
  }

  /** Where `scope` saves, for the menu header. */
  scopePath(scope: SaveScope): string {
    const layers = this.session.configLayers();
    const layer = layers[targetIndex(layers, scope)];
    return layer ? this.showPath(layer.path) : scope;
  }

  /** Saves the menu's changes: config values into the chosen file (one write, one reload), then profile switches. */
  async applySettings(changes: ReadonlyMap<string, TomlScalar | null>, scope: SaveScope): Promise<void> {
    const before = new Map(this.settings(scope).map((r) => [r.id, r.value]));
    const config = [...changes].filter(([id]) => !id.startsWith('profile.'));
    const profiles = [...changes].filter(([id]) => id.startsWith('profile.'));
    const lines: Line[] = [];
    const show = (v: TomlScalar | null | undefined) => (v === null || v === undefined ? 'default' : String(v));
    const change = (label: string, id: string, value: TomlScalar | null): Line => [
      dim(label.padEnd(20)),
      dim(show(before.get(id))),
      dim(' → '),
      seg(show(value), { bold: true }),
    ];
    if (config.length > 0) {
      const { file, notes } = await this.writeConfig(
        scope,
        config.map(([id, value]) => {
          const path = id.split('.');
          const key = path.pop() ?? '';
          return { path, key, value };
        }),
      );
      lines.push([dim('saved to '), seg(this.showPath(file))]);
      for (const [id, value] of config) lines.push(change(id, id, value));
      for (const n of notes) lines.push([seg('• ', { color: 'accent' }), seg(n)]);
    }
    for (const [id, value] of profiles) {
      const kind = id.slice('profile.'.length) as RealKind;
      const { setupOutput } = await this.session.switchProfile(kind, String(value));
      lines.push(change(`${kind} profile`, id, value));
      if (setupOutput) lines.push([dim(`  ${setupOutput}`)]);
      if (this.session.config.assistant.engine === kind)
        lines.push([seg('• ', { color: 'accent' }), seg('the assistant starts a new conversation on it')]);
    }
    this.store.update({ profiles: this.session.profileNames() });
    if (lines.length > 0) this.store.panel('Settings changed', lines);
  }

  // ---- workflows menu ------------------------------------------------------------------------

  openWorkflows(): void {
    this.store.update({ menu: 'workflows' });
  }

  listWorkflows(): Promise<WorkflowSummary[]> {
    return describeWorkflows(this.session.repo);
  }

  /** Loads a workflow and dry-runs it (no type-check: that is `/validate`) to find its inputs and agent steps. */
  async inspectWorkflow(name: string): Promise<WorkflowDetail> {
    const found = findWorkflow(this.session.repo, name);
    if (!found) throw new Error(`No workflow named "${name}"`);
    const base = {
      name,
      source: found.source,
      file: this.showPath(workflowSource(found)),
      overrides: found.shadows.map((s) => s.source),
    };
    let def: Awaited<ReturnType<typeof loadWorkflow>>;
    try {
      def = await loadWorkflow(found.file);
    } catch (err) {
      return {
        ...base,
        description: '',
        inputs: [],
        agents: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const report = await validateWorkflow(found.file, { repo: this.session.repo, typecheck: false });
    const agents = new Map<string, WorkflowAgent>();
    for (const a of report.dryRun?.agents ?? []) {
      const seen = agents.get(a.key);
      if (!seen) {
        agents.set(a.key, { key: a.key, engines: [a.engine], steps: [a.step], model: a.model, effort: a.effort });
        continue;
      }
      if (!seen.engines.includes(a.engine)) seen.engines.push(a.engine);
      seen.steps.push(a.step);
      seen.model ??= a.model;
      seen.effort ??= a.effort;
    }
    return {
      ...base,
      description: def.description,
      inputs: inputFields(def.input),
      agents: [...agents.values()],
      error: report.dryRun && !report.dryRun.ok ? `dry run stopped early: ${report.dryRun.error}` : null,
    };
  }

  /**
   * The models an engine's picker offers: Codex asks its CLI (`model/list`, cached per profile), Claude has a built-in
   * list; both add `[claude|codex] models` from the config. `error` says why the CLI's list is missing.
   */
  async modelChoices(engine: RealKind): Promise<{ models: ModelChoice[]; error: string | null }> {
    const extra = (this.session.config[engine].models ?? []).map((id) => ({ id, description: 'from your config' }));
    const merge = (base: readonly ModelChoice[]) => {
      const seen = new Set(base.map((m) => m.id));
      return [...base, ...extra.filter((m) => !seen.has(m.id))];
    };
    if (engine === 'claude') return { models: merge(CLAUDE_MODELS), error: null };
    const key = `codex:${this.session.profile('codex').name}`;
    let listed = this.modelCache.get(key);
    if (!listed) {
      const impl = this.session.engine('codex');
      listed =
        impl instanceof CodexEngine
          ? impl
              .listModels()
              .then((ms) => ({
                models: ms.map((m) => ({
                  id: m.id,
                  description: `${m.description}${m.isDefault ? ' (default)' : ''}`,
                })),
                error: null,
              }))
              .catch((err: unknown) => {
                this.modelCache.delete(key);
                return {
                  models: [],
                  error: `could not list Codex models: ${err instanceof Error ? err.message : err}`,
                };
              })
          : Promise.resolve({ models: [], error: null });
      this.modelCache.set(key, listed);
    }
    const { models, error } = await listed;
    return { models: merge(models), error };
  }

  /** The rows of a workflow's menu page (`*`: every workflow): its engines' agents, then each agent step. */
  workflowModels(detail: Pick<WorkflowDetail, 'name' | 'agents'>, scope: SaveScope): ModelRow[] {
    const settings = this.session.config.workflow;
    const origin = this.valueOrigins(scope);
    const name = detail.name;
    const all = settings['*'];
    const kinds = ['claude', 'codex'] as const;
    const rows: ModelRow[] = [];
    for (const engine of kinds) {
      const field = (f: 'model' | 'effort'): ModelField => {
        const value = name === '*' ? null : (all?.[engine]?.[f] ?? null);
        const inherited = { value, from: value !== null ? 'all workflows' : 'default' };
        return {
          set: settings[name]?.[engine]?.[f] ?? null,
          inherited: { claude: inherited, codex: inherited },
          ...origin(['workflow', name, engine, f]),
        };
      };
      rows.push({
        path: ['workflow', name, engine],
        label: name === '*' ? `${engine} agents, every workflow` : `${engine} agents`,
        kind: 'engine',
        engines: [engine],
        steps: [],
        engine: null,
        model: field('model'),
        effort: field('effort'),
      });
    }
    const from: Record<string, string> = { code: 'workflow code', all: 'all workflows' };
    for (const a of detail.agents) {
      const code = (a.engines[0] ?? 'claude') as RealKind;
      // What applies without this step's own model/effort, were it on each engine.
      const without = (on: RealKind) =>
        resolveAgentModel(
          {
            ...settings,
            [name]: { ...settings[name], agent: { [a.key]: { engine: on } } },
            '*': { ...all, agent: {} },
          },
          { workflow: name, key: a.key, engine: code, model: a.model, effort: a.effort },
        );
      const field = (f: 'model' | 'effort'): ModelField => {
        const inherited = Object.fromEntries(
          kinds.map((k) => {
            const r = without(k);
            return [
              k,
              { value: r[f], from: from[r.origin[f]] ?? (r.origin[f] === 'workflow' ? `${k} agents` : 'default') },
            ];
          }),
        ) as ModelField['inherited'];
        return {
          set: settings[name]?.agent[a.key]?.[f] ?? null,
          inherited,
          ...origin(['workflow', name, 'agent', a.key, f]),
        };
      };
      const codeEngine = { value: a.engines.join(', '), from: 'workflow code' };
      rows.push({
        path: ['workflow', name, 'agent', a.key],
        label: a.key,
        kind: 'step',
        engines: a.engines as RealKind[],
        steps: a.steps,
        engine: {
          set: settings[name]?.agent[a.key]?.engine ?? null,
          inherited: { claude: codeEngine, codex: codeEngine },
          ...origin(['workflow', name, 'agent', a.key, 'engine']),
        },
        model: field('model'),
        effort: field('effort'),
      });
    }
    return rows;
  }

  /** Saves a workflow page's changes (`path` + `engine`/`model`/`effort`) into `scope`'s file. */
  async applyWorkflowModels(
    workflow: string,
    changes: readonly { row: ModelRow; field: ModelFieldName; value: string | null }[],
    scope: SaveScope,
  ): Promise<void> {
    if (changes.length === 0) return;
    const { file, notes } = await this.writeConfig(
      scope,
      changes.map((c) => ({ path: c.row.path, key: c.field, value: c.value })),
    );
    const show = (v: string | null) => v ?? 'default';
    this.store.panel(`Models for ${workflow === '*' ? 'every workflow' : workflow}`, [
      [dim('saved to '), seg(this.showPath(file))],
      ...changes.map((c) => [
        dim(`${c.row.label} ${c.field}`.padEnd(28)),
        dim(show(c.row[c.field]?.set ?? null)),
        dim(' → '),
        seg(show(c.value), { bold: true }),
      ]),
      ...notes.map((n) => [seg('• ', { color: 'accent' }), seg(n)]),
      [dim('Runs started from now on use these; running agents keep theirs.')],
    ]);
  }

  /** `/run` for a workflow from the menu: starts it when it needs no input, else puts the command in the prompt. */
  async runFromMenu(detail: WorkflowDetail): Promise<void> {
    this.store.update({ menu: null });
    const required = detail.inputs.filter((i) => i.required && i.default === undefined);
    if (required.length === 0) {
      await this.command(`/run ${detail.name}`);
      return;
    }
    const sample = Object.fromEntries(
      required.map((i) => [
        i.name,
        i.type === 'number' || i.type === 'integer' ? 0 : i.type === 'boolean' ? false : '',
      ]),
    );
    this.seed(`/run ${detail.name} ${JSON.stringify(sample)}`);
  }

  async validateFromMenu(name: string): Promise<boolean> {
    const found = findWorkflow(this.session.repo, name);
    if (!found) throw new Error(`No workflow named "${name}"`);
    const report = await validateWorkflow(found.file, { repo: this.session.repo });
    this.store.info(formatReport(report));
    return report.ok;
  }

  ejectFromMenu(name: string): string {
    const { path, from } = ejectWorkflow(this.session.repo, name);
    this.store.info(`Copied ${name} to ${this.showPath(path)}; it now overrides the ${from.source} one.`);
    return path;
  }

  /** Opens a project or user workflow in $EDITOR. */
  async editWorkflow(name: string): Promise<void> {
    const found = findWorkflow(this.session.repo, name);
    if (!found) throw new Error(`No workflow named "${name}"`);
    if (found.source === 'builtin') throw new Error(`${name} is builtin: eject it first (e) to get a copy to edit`);
    await this.openInEditor(found.file);
    this.store.info(`Back from editing ${this.showPath(found.file)}. /validate ${name} checks it.`);
  }

  /** Puts text in the prompt for the user to finish. */
  seed(text: string): void {
    this.store.update((s) => ({ seed: { text, n: (s.seed?.n ?? 0) + 1 } }));
  }

  private async openInEditor(file: string): Promise<number | null> {
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    let status: number | null = null;
    await this.hooks?.suspend(() => {
      status = spawnSync(process.env.SHELL || '/bin/sh', ['-c', `${editor} "$1"`, 'legion-editor', file], {
        stdio: 'inherit',
      }).status;
    });
    if (status !== 0 && status !== null) this.store.error(`${editor} exited with status ${status}`);
    return status;
  }

  /** Opens a scope's file in $EDITOR from the menu. */
  async editConfigFile(scope: SaveScope): Promise<void> {
    await this.config('edit', scope);
  }

  private async reload(): Promise<void> {
    const notes = await this.session.reloadConfig();
    this.store.update({ profiles: this.session.profileNames() });
    this.store.panel('Configuration reloaded', [
      ...notes.map((n) => [seg('• ', { color: 'accent' }), seg(n)]),
      [dim('New runs use the new workflow settings; running ones keep theirs.')],
    ]);
  }

  /** Inside the project: relative to where the session started; elsewhere: with `~`. */
  private showPath(path: string): string {
    const rel = relative(this.session.cwd, path);
    return path.startsWith(`${this.session.repo}/`) && rel ? rel : tildify(path, homedir());
  }

  private configLines(layers: ConfigLayer[]): Line[] {
    const { config } = this.session;
    const lines: Line[] = [[seg('Files', { bold: true }), dim('  later ones win')]];
    layers.forEach((l, n) => {
      lines.push([
        dim(`  ${n + 1}. `),
        l.exists ? seg('● ', { color: 'ok' }) : dim('○ '),
        seg(l.scope.padEnd(8), { bold: l.exists, dim: !l.exists }),
        seg(this.showPath(l.path), { dim: !l.exists }),
        ...(l.exists ? [] : [dim('  (none)')]),
      ]);
    });
    const kv = (k: string, v: string, note = ''): Line => [
      dim(`  ${k.padEnd(10)}`),
      seg(v),
      ...(note ? [dim(`  ${note}`)] : []),
    ];
    lines.push(
      [],
      [seg('Assistant', { bold: true })],
      kv('engine', config.assistant.engine),
      kv('model', config.assistant.model ?? 'default', config.assistant.model ? '' : "the CLI's own"),
      kv('effort', config.assistant.effort ?? 'default'),
      [],
      [seg('Workflows', { bold: true })],
      kv(
        'approvals',
        config.workflows.approvals,
        config.workflows.approvals === 'ask' ? "you answer agents' tool approvals" : "the engine's auto mode decides",
      ),
      kv('maxAgents', String(config.workflows.maxAgents), 'agent sessions at once per run'),
    );
    for (const kind of ['claude', 'codex'] as const) {
      const current = this.session.profile(kind);
      lines.push([], [seg(`${kind} profiles`, { bold: true })]);
      for (const name of this.session.availableProfiles(kind)) {
        const on = name === current.name;
        const raw = config[kind].profiles[name];
        const env = Object.keys(raw?.env ?? {});
        lines.push([
          on ? seg('  ● ', { color: kind }) : dim('  ○ '),
          seg(name.padEnd(12), { bold: on }),
          dim(`${raw?.command ?? kind}${raw?.args.length ? ` ${raw.args.join(' ')}` : ''}`),
          ...(env.length ? [dim(` · env ${env.join(', ')}`)] : []),
          ...(raw?.setup ? [dim(` · setup: ${raw.setup}`)] : []),
          ...(on ? [seg('  in use', { color: kind })] : []),
        ]);
      }
    }
    lines.push([], [dim('/config edit [user|project|local] opens a file in $EDITOR · /config reload re-reads them')]);
    return lines;
  }

  private stepEntry(runId: string, step: string) {
    const journal = this.session.runs.journal(runId);
    const entries = journal.all().filter((e) => e.kind === 'agent');
    const entry = entries.find((e) => e.key === step) ?? entries.find((e) => e.key.endsWith(step));
    if (!entry)
      throw new Error(
        `No agent step "${step}" in run ${runId}. Agent steps: ${entries.map((e) => e.key).join(', ') || 'none'}`,
      );
    return { journal, entry };
  }

  private transcript(runId: string, step: string): string {
    const { journal, entry } = this.stepEntry(runId, step);
    let text: string;
    try {
      text = readFileSync(journal.transcriptPath(entry.key), 'utf8');
    } catch {
      return `No transcript for ${entry.key} yet.`;
    }
    const lines: string[] = [`${entry.key} (${String(entry.meta?.engine ?? '?')}, ${entry.status})`];
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      const { event } = JSON.parse(raw) as { event: { type: string; [k: string]: unknown } };
      if (event.type === 'message') lines.push(`  ${String(event.text).split('\n').join('\n  ')}`);
      else if (event.type === 'tool_call')
        lines.push(`  → ${String(event.name)} ${JSON.stringify(event.input).slice(0, 160)}`);
      else if (event.type === 'error') lines.push(`  ! ${String(event.message)}`);
    }
    return lines.join('\n');
  }

  /** Opens an agent step's session in its own CLI, in the terminal; Legion's UI comes back when it exits. */
  private async takeover(runId: string, step: string): Promise<void> {
    const { entry } = this.stepEntry(runId, step);
    const sessionId = entry.meta?.sessionId;
    const engine = entry.meta?.engine;
    const profileName = entry.meta?.profile;
    if (typeof sessionId !== 'string' || (engine !== 'claude' && engine !== 'codex'))
      throw new Error(`${entry.key} has no resumable session`);
    const profile = this.session.profile(engine);
    if (profile.name !== profileName) {
      throw new Error(
        `${entry.key} ran on ${engine} profile "${String(profileName)}"; switch with /${engine} ${String(profileName)} first`,
      );
    }
    if (this.session.runs.isActive(runId) && entry.status === 'started') {
      throw new Error(`${entry.key} is still running; cancel the run first (/cancel ${runId})`);
    }
    const args =
      engine === 'claude' ? [...profile.args, '--resume', sessionId] : [...profile.args, 'resume', sessionId];
    // Claude finds sessions by working directory: resume where the agent ran.
    const cwd = typeof entry.meta?.cwd === 'string' ? entry.meta.cwd : this.session.repo;
    const env: Record<string, string | undefined> = { ...process.env, ...profile.env };
    const engineImpl = this.session.engine(engine);
    if (engineImpl instanceof CodexEngine) env.CODEX_HOME = await engineImpl.codexHome();
    await this.hooks?.suspend(() => {
      spawnSync(profile.command, args, { stdio: 'inherit', cwd, env });
    });
    this.store.info(`Back from ${entry.key}.`);
  }
}

function statusSeg(status: string): Seg {
  const map: Record<string, Seg> = {
    active: seg('● active   ', { color: 'info' }),
    running: seg('● running  ', { color: 'info' }),
    waiting: seg('⏸ waiting  ', { color: 'warn' }),
    done: seg('✓ done     ', { color: 'ok' }),
    failed: seg('✗ failed   ', { color: 'error' }),
    cancelled: seg('■ cancelled', { dim: true }),
    interrupted: seg('◌ stopped  ', { color: 'warn' }),
  };
  return map[status] ?? seg(status.padEnd(11));
}

/** The layer a save scope writes: the project's own file, its local file, or the user config. */
function targetIndex(layers: ConfigLayer[], scope: SaveScope): number {
  for (let i = layers.length - 1; i >= 0; i--) if (layers[i]?.scope === scope) return i;
  return -1;
}

/** The layer `/config edit` opens: by scope name or number; default the project's own file. */
function pickLayer(layers: ConfigLayer[], which: string | undefined): ConfigLayer {
  const want = which ?? 'project';
  const n = /^\d+$/.test(want) ? layers[Number(want) - 1] : undefined;
  const found = n ?? [...layers].reverse().find((l) => l.scope === want);
  if (!found) throw new Error(`No config file "${want}". Choose user, project, local, or a number from /config.`);
  return found;
}
