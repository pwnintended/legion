/**
 * Connects a session to the UI store and turns what the user types into actions: messages for the assistant,
 * slash commands, and answers to the interaction at the head of the queue.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describeWorkflows } from '../assistant/mcp.ts';
import type { RealKind } from '../config.ts';
import { CodexEngine } from '../engine/codex/index.ts';
import type { ApprovalDecision } from '../engine/types.ts';
import type { Session } from '../session.ts';
import { builtinSourceDir, findWorkflow } from '../workflow/loader.ts';
import { formatReport, validateWorkflow } from '../workflow/validate.ts';
import { type UiInteraction, UiStore } from './store.ts';

export const HELP = `Talk to the assistant, or:
  /workflows               list workflows        /run <name> [json input]   start one
  /runs                    recent runs           /resume <run> · /cancel <run>
  /steps <run>             a run's steps         /log <run> <step>          an agent step's transcript
  /validate <name>         type-check + dry-run  /takeover <run> <step>     open that agent's session in its CLI
  /claude [profile] · /codex [profile]           show or switch the account used for new agents
  /help · /exit            Esc interrupts the assistant; Ctrl+C twice exits`;

export interface ControllerHooks {
  /** Hands the terminal to a child process (agent takeover) and back. */
  suspend(run: () => void): Promise<void>;
  exit(): void;
}

export class Controller {
  readonly store: UiStore;
  private readonly session: Session;
  private hooks: ControllerHooks | null = null;

  constructor(session: Session) {
    this.session = session;
    this.store = new UiStore({ profiles: session.profileNames() });
    const { assistant, runs } = session;
    assistant.on('event', (e) => this.store.assistantEvent(e));
    assistant.on('busy', (b) => this.store.setBusy(b));
    assistant.on('approval', (a) => this.store.assistantApproval(a));
    assistant.on('resolved', (id) => this.store.resolved(id));
    runs.on('event', (e) => this.store.runEvent(e, (id) => runs.run(id)));
    runs.on('interaction', (p) => this.store.runInteraction(p));
    runs.on('resolved', (id) => this.store.resolved(id));
    runs.on('finished', (record) => {
      const note =
        `[Legion] Run ${record.id} (${record.workflow}) ended: ${record.status}.` +
        (record.error ? ` Error: ${record.error}` : '') +
        (record.result ? ` Result: ${JSON.stringify(record.result)}` : '');
      void assistant.notify(note).catch((err: unknown) => session.log.warn('notify failed', err));
    });
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
    this.store.push({ type: 'user', text: trimmed });
    try {
      await this.session.assistant.send(trimmed);
    } catch (err) {
      this.store.error(err instanceof Error ? err.message : String(err));
    }
  }

  async interrupt(): Promise<void> {
    if (this.session.assistant.busy) await this.session.assistant.interrupt();
  }

  // ---- interactions --------------------------------------------------------------------------

  head(): UiInteraction | null {
    return this.store.get().interactions[0] ?? null;
  }

  answerGate(id: string, choice: 'approve' | 'changes' | 'abort', note: string | null = null): void {
    this.session.runs.answer(id, { choice, note });
  }

  answerAsk(id: string, answer: string): void {
    this.session.runs.answer(id, { answer });
  }

  answerApproval(item: UiInteraction, decision: ApprovalDecision): void {
    if (item.source === 'assistant') void this.session.assistant.answer(item.id, decision);
    else this.session.runs.answer(item.id, decision);
  }

  // ---- commands ------------------------------------------------------------------------------

  private async command(line: string): Promise<void> {
    const [cmd = '', ...rest] = line.slice(1).split(/\s+/);
    const arg = line.slice(1 + cmd.length).trim();
    const { runs } = this.session;
    try {
      switch (cmd) {
        case 'help':
        case '?':
          this.store.info(HELP);
          return;
        case 'exit':
        case 'quit':
          this.hooks?.exit();
          return;
        case 'workflows': {
          const list = await describeWorkflows(this.session.repo);
          this.store.info(
            list.length === 0
              ? 'No workflows.'
              : list
                  .map(
                    (w) =>
                      `${w.name.padEnd(16)} ${w.source.padEnd(8)} ${'error' in w ? `⚠ ${w.error}` : w.description}`,
                  )
                  .join('\n'),
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
          this.store.info(
            list.length === 0
              ? 'No runs yet.'
              : list
                  .map(
                    (r) =>
                      `${r.id}  ${(runs.isActive(r.id) ? 'active' : r.status).padEnd(10)} ${r.workflow}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`,
                  )
                  .join('\n'),
          );
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
          this.store.info(
            steps
              .map(
                (s) =>
                  `${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '…'} ${s.kind.padEnd(5)} ${s.key}${s.error ? ` — ${s.error.split('\n')[0]}` : ''}`,
              )
              .join('\n') || 'No steps yet.',
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
      const all = this.session.availableProfiles(kind);
      this.store.info(`${kind}: ${this.session.profile(kind).name} (available: ${all.join(', ')})`);
      return;
    }
    const { setupOutput } = await this.session.switchProfile(kind, name);
    this.store.update({ profiles: this.session.profileNames() });
    this.store.info(
      `${kind} now uses profile "${name}" for new agents${setupOutput ? `\n${setupOutput}` : ''}` +
        (this.session.config.assistant.engine === kind ? '\nThe assistant starts a new conversation on it.' : ''),
    );
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
