/**
 * `legion` — a single-session terminal agent for writing and running multi-agent workflows in the current
 * directory, over the Claude Code and Codex CLIs you already have.
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { describeWorkflows } from './assistant/mcp.ts';
import { ConfigError, type RealKind, runSetup, userConfigPath } from './config.ts';
import { Session } from './session.ts';
import { App } from './tui/app.tsx';
import { Controller } from './tui/controller.ts';
import type { Interaction, RunEvent } from './workflow/host.ts';
import { ejectWorkflow, findWorkflow, installSdkResolution } from './workflow/loader.ts';
import type { PendingInteraction } from './workflow/manager.ts';
import { formatReport, validateWorkflow } from './workflow/validate.ts';

const USAGE = `Usage:
  legion [prompt]                 start a session here (the assistant writes and runs workflows)
  legion -c, --continue           continue the last conversation in this directory
  legion run <workflow> [--input <json>]   run a workflow without the UI
  legion resume <run-id>          resume a stopped run without the UI
  legion workflows                list workflows (project, user, builtin)
  legion runs                     list recent runs
  legion validate <workflow>      type-check and dry-run a workflow
  legion eject <workflow> [--as <name>]    copy a workflow into .legion/workflows to edit it
  legion doctor                   check engines, profiles and configuration

Options:
  --claude <profile>   Claude Code profile (account) for this session
  --codex <profile>    Codex profile for this session
  -h, --help

Config: ${userConfigPath()} and .legion/config.toml`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      claude: { type: 'string' },
      codex: { type: 'string' },
      continue: { type: 'boolean', short: 'c' },
      input: { type: 'string' },
      as: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  installSdkResolution();
  const profiles: Partial<Record<RealKind, string>> = {
    ...(values.claude ? { claude: values.claude } : {}),
    ...(values.codex ? { codex: values.codex } : {}),
  };
  const [command, ...args] = positionals;
  const open = () =>
    Session.open({
      cwd: process.cwd(),
      profiles,
      continueLast: values.continue ?? false,
      fake: process.env.LEGION_FAKE_ENGINES === '1',
    });

  switch (command) {
    case 'workflows': {
      const session = await open();
      for (const w of await describeWorkflows(session.repo)) {
        const over = 'overrides' in w && w.overrides?.length ? ` (overrides ${w.overrides.join(', ')})` : '';
        console.log(
          `${w.name.padEnd(18)} ${w.source.padEnd(8)} ${'error' in w ? `⚠ ${w.error}` : w.description}${over}`,
        );
      }
      await session.close();
      return 0;
    }
    case 'runs': {
      const session = await open();
      for (const r of session.runs.runs().slice(0, 30)) {
        console.log(`${r.id}  ${r.status.padEnd(10)} ${r.workflow}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
      }
      await session.close();
      return 0;
    }
    case 'validate': {
      const name = args[0];
      if (!name) throw new UsageError('legion validate <workflow>');
      const found = findWorkflow(process.cwd(), name);
      if (!found) throw new UsageError(`No workflow named "${name}"`);
      const report = await validateWorkflow(found.file, { repo: process.cwd() });
      console.log(formatReport(report));
      return report.ok ? 0 : 1;
    }
    case 'eject': {
      const name = args[0];
      if (!name) throw new UsageError('legion eject <workflow> [--as <name>]');
      try {
        const { path, from } = ejectWorkflow(process.cwd(), name, values.as);
        console.log(`Copied to ${path}; it now overrides the ${from.source} one.`);
      } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
      return 0;
    }
    case 'doctor':
      return doctor(await open());
    case 'run':
    case 'resume': {
      const session = await open();
      setup(session);
      const target = args[0];
      if (!target) throw new UsageError(`legion ${command} <${command === 'run' ? 'workflow' : 'run-id'}>`);
      return headless(
        session,
        command === 'run'
          ? () => session.runs.start(target, values.input ? JSON.parse(values.input) : {})
          : () => session.runs.resume(target),
      );
    }
    default: {
      const session = await open();
      setup(session);
      return interactive(session, positionals.join(' '));
    }
  }
}

class UsageError extends Error {}

/** Runs the session profiles' setup commands while Legion still has a plain terminal. */
function setup(session: Session): void {
  for (const kind of ['claude', 'codex'] as const) {
    const profile = session.profile(kind);
    if (!profile.setup) continue;
    const result = runSetup(profile);
    if (!result.ok) console.error(`warning: setup of ${kind} profile "${profile.name}" exited with ${result.code}`);
  }
}

async function interactive(session: Session, initial: string): Promise<number> {
  const controller = new Controller(session);
  const instance = render(<App controller={controller} />, {
    exitOnCtrlC: false,
    maxFps: 30,
    // Terminals that speak the kitty keyboard protocol (Ghostty, kitty, WezTerm, iTerm2, …) report Shift+Enter
    // apart from Enter, so it can insert a newline. Ink asks the terminal first; others are left as they are.
    kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
  });
  if (initial.trim()) void controller.submit(initial);
  await instance.waitUntilExit();
  const active = session.runs.activeRuns();
  await session.close();
  if (active.length > 0) {
    console.log(
      `Stopped ${active.length} active run(s). Pick them up with: ${active.map((r) => `legion resume ${r.id}`).join(' · ')}`,
    );
  }
  return 0;
}

/** A workflow run on a plain terminal: progress as lines, interactions as prompts. */
async function headless(session: Session, start: () => Promise<string>): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queue: PendingInteraction[] = [];
  let answering = false;
  const answerNext = async () => {
    if (answering) return;
    answering = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift() as PendingInteraction;
        await answer(session, rl, item);
      }
    } finally {
      answering = false;
    }
  };
  session.runs.on('event', (e) => printEvent(e));
  session.runs.on('interaction', (p) => {
    queue.push(p);
    void answerNext();
  });
  const onSigint = () => {
    for (const r of session.runs.activeRuns()) session.runs.cancel(r.id);
  };
  process.on('SIGINT', onSigint);
  try {
    const runId = await start();
    console.log(`run ${runId}`);
    const record = await session.runs.wait(runId);
    if (record?.status === 'done') {
      if (record.result !== null) console.log(JSON.stringify(record.result, null, 2));
      return 0;
    }
    console.error(`${record?.status}: ${record?.error ?? ''}\nResume with: legion resume ${runId}`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    rl.close();
    await session.close();
  }
}

function printEvent(e: RunEvent): void {
  if (e.type === 'step' && e.kind !== 'loop') {
    const icon = { started: '…', done: '✓', failed: '✗', cached: '↺' }[e.status];
    console.log(
      `${icon} ${e.label}${e.status === 'failed' && e.detail ? `\n  ${e.detail.split('\n').join('\n  ')}` : ''}`,
    );
  } else if (e.type === 'log') {
    console.log(`· ${e.message}`);
  }
}

async function answer(
  session: Session,
  rl: ReturnType<typeof createInterface>,
  item: PendingInteraction,
): Promise<void> {
  const i: Interaction = item.interaction;
  if (i.kind === 'gate') {
    if (i.body) console.log(`\n${i.body}\n`);
    const a = (await rl.question(`⏸ ${i.title} [y]es / [c]hanges / [x] abort: `)).trim().toLowerCase();
    if (a.startsWith('x')) session.runs.answer(item.id, { choice: 'abort', note: null });
    else if (a.startsWith('c') || a.startsWith('n')) {
      session.runs.answer(item.id, {
        choice: 'changes',
        note: (await rl.question('What should change? ')).trim() || null,
      });
    } else session.runs.answer(item.id, { choice: 'approve', note: null });
  } else if (i.kind === 'ask') {
    for (const [n, o] of i.options.entries()) console.log(`  ${n + 1}. ${o}`);
    const a = (await rl.question(`? ${i.question} `)).trim();
    const n = /^\d+$/.test(a) ? i.options[Number(a) - 1] : undefined;
    session.runs.answer(item.id, { answer: n ?? a });
  } else if (i.kind === 'questions') {
    const answers: Record<string, string[]> = {};
    for (const q of i.questions) {
      for (const [n, o] of q.options.entries())
        console.log(`  ${n + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
      const hint = q.multiSelect ? ' (numbers separated by commas, or text)' : '';
      const a = (await rl.question(`? ${q.question}${hint} `)).trim();
      const picked = a
        .split(',')
        .map((x) => x.trim())
        .map((x) => (/^\d+$/.test(x) ? q.options[Number(x) - 1]?.label : undefined));
      answers[q.id] = picked.every(Boolean) && a ? (picked as string[]) : [a];
    }
    session.runs.answer(item.id, { answers });
  } else {
    const input = JSON.stringify(i.input);
    const a = (await rl.question(`Allow ${i.tool} ${input.slice(0, 200)} (${i.key})? [y]es / [s]ession / [n]o: `))
      .trim()
      .toLowerCase();
    session.runs.answer(
      item.id,
      a.startsWith('n')
        ? { behavior: 'deny', message: 'The user denied this.', interrupt: false }
        : { behavior: 'allow', scope: a.startsWith('s') ? 'session' : 'once', updatedInput: null },
    );
  }
}

async function doctor(session: Session): Promise<number> {
  let ok = true;
  console.log(`repo      ${session.repo}${session.isGitRepo ? '' : ' (not a git repository)'}`);
  console.log(`config    ${userConfigPath()}${existsSync(userConfigPath()) ? '' : ' (not present: defaults)'}`);
  for (const kind of ['claude', 'codex'] as const) {
    const profile = session.profile(kind);
    const info = await session.engine(kind).probe();
    const status = !info.installed ? '✗ not installed' : info.loggedIn === false ? '✗ not logged in' : '✓';
    if (status !== '✓') ok = false;
    const env = Object.entries(profile.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `${kind.padEnd(9)} ${status} profile "${profile.name}" (${session.availableProfiles(kind).join(', ')}) · ${info.path ?? profile.command} ${info.version ?? ''}${env ? ` · ${env}` : ''}${profile.setup ? ` · setup: ${profile.setup}` : ''}${info.error ? `\n          ${info.error}` : ''}`,
    );
  }
  const workflows = await describeWorkflows(session.repo);
  console.log(`workflows ${workflows.map((w) => `${w.name}${'error' in w ? ' ⚠' : ''}`).join(', ')}`);
  await session.close();
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError || err instanceof ConfigError) console.error(err.message);
    else console.error(err);
    process.exit(err instanceof UsageError ? 2 : 1);
  },
);
