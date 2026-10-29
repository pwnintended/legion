/**
 * `legion` — a single-session terminal agent for writing and running multi-agent workflows in the current
 * directory, over the Claude Code and Codex CLIs you already have.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import type { AccountKind } from './accounts/index.ts';
import {
  describeAccount,
  isAccountKind,
  type LoginSpec,
  loginSpec,
  migrateConfigFile,
  nextAccountName,
  prepareLoginDir,
  probeAccount,
  tokenHint,
} from './accounts/login.ts';
import { describeWorkflows } from './assistant/mcp.ts';
import { ConfigError, userConfigPath } from './config.ts';
import { Session } from './session.ts';
import { App } from './tui/app.tsx';
import { Controller } from './tui/controller.ts';
import { attention, HerdrReporter } from './tui/herdr.ts';
import { Terminal } from './tui/terminal.ts';
import { formatDuration } from './tui/theme.ts';
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
  legion login <claude|codex> [name] [--token]   log an account in with the official CLI (claude: --token for setup-token)
  legion accounts [reset [kind[/name]]|migrate]   list accounts and cooldowns; clear cooldowns; convert old profiles
  legion doctor                   check engines, accounts and configuration

Options:
  --remote, --local    run workflow steps on Upstash Boxes, or on this machine (over [remote] enabled)
  -h, --help

Config: ${userConfigPath()} and .legion/config.toml`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      continue: { type: 'boolean', short: 'c' },
      remote: { type: 'boolean' },
      local: { type: 'boolean' },
      input: { type: 'string' },
      as: { type: 'string' },
      token: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.remote && values.local) throw new UsageError('--remote and --local exclude each other');
  installSdkResolution();
  const [command, ...args] = positionals;
  const open = () =>
    Session.open({
      cwd: process.cwd(),
      continueLast: values.continue ?? false,
      fake: process.env.LEGION_FAKE_ENGINES === '1',
      ...(values.remote ? { remote: true } : values.local ? { remote: false } : {}),
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
    case 'login': {
      const kind = args[0];
      if (!isAccountKind(kind)) throw new UsageError('legion login <claude|codex> [name] [--token]');
      const session = await open();
      try {
        const name =
          args[1] ??
          nextAccountName(
            kind,
            session.listAccounts(kind).map((a) => a.name),
          );
        let spec: LoginSpec;
        try {
          spec = loginSpec(session.config, kind, name, {
            existing: session.listAccounts(kind).find((a) => a.name === name),
            token: values.token ?? false,
            legionHome: session.legionHome,
          });
        } catch (err) {
          throw new UsageError(err instanceof Error ? err.message : String(err));
        }
        prepareLoginDir(spec);
        console.log(`Logging in ${kind} account "${name}" (${spec.dir}): ${spec.command} ${spec.args.join(' ')}`);
        const r = spawnSync(spec.command, spec.args, { stdio: 'inherit', env: spec.env });
        if (r.error || r.status !== 0) {
          console.error(
            r.error ? `Could not run ${spec.command}: ${r.error.message}` : `${spec.command} exited with ${r.status}`,
          );
          return 1;
        }
        console.log(values.token ? tokenHint(spec) : `Account "${name}" is ready; Legion picks it up automatically.`);
        return 0;
      } finally {
        await session.close();
      }
    }
    case 'accounts': {
      if (args[0] === 'migrate') {
        const { changed, notes } = migrateConfigFile(userConfigPath());
        console.log(
          changed
            ? `Rewrote ${userConfigPath()} (backup: ${userConfigPath()}.bak)\n${notes.join('\n')}`
            : 'Nothing to migrate.',
        );
        return 0;
      }
      const session = await open();
      try {
        if (args[0] === 'reset') {
          const [kind, name] = (args[1] ?? '').split('/');
          if (kind && !isAccountKind(kind)) throw new UsageError('legion accounts reset [claude|codex][/name]');
          for (const k of kind ? [kind as AccountKind] : (['claude', 'codex'] as const))
            session.accounts.clear(k, name || undefined);
          console.log('Cooldowns cleared.');
          return 0;
        }
        if (args[0]) throw new UsageError('legion accounts [reset [kind[/name]]|migrate]');
        for (const kind of ['claude', 'codex'] as const) {
          for (const row of session.accounts.status(kind)) {
            const info = await probeAccount(() => session.engine(kind, row.account.name).probe());
            console.log(describeAccount({ ...row, ...info }));
          }
        }
        return 0;
      } finally {
        await session.close();
      }
    }
    case 'doctor':
      return doctor(await open());
    case 'run':
    case 'resume': {
      const session = await open();
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
      return interactive(session, positionals.join(' '));
    }
  }
}

class UsageError extends Error {}

async function interactive(session: Session, initial: string): Promise<number> {
  const started = Date.now();
  const controller = new Controller(session);
  const herdr = HerdrReporter.fromEnv(() =>
    attention(controller.store.get(), session.assistant.busy, session.runs.activeRuns().length),
  );
  if (herdr) {
    controller.herdr = herdr;
    controller.store.subscribe(herdr.changed);
    session.assistant.on('busy', herdr.changed);
    herdr.changed();
  }
  // Leave selection and link clicks to the terminal; LEGION_MOUSE=1 opts into wheel reporting.
  const terminal = new Terminal();
  process.once('exit', () => terminal.leave());
  // Raw mode before Ink starts: it asks the terminal about the kitty keyboard protocol right away, and with echo
  // still on the terminal would print the reply (`^[[?0u`) over the first frame.
  terminal.stdin.setRawMode(true);
  const instance = render(<App controller={controller} terminal={terminal} />, {
    stdin: terminal.stdin,
    exitOnCtrlC: false,
    maxFps: 30,
    // The whole window, like vim or less: redrawn in place, and the shell's screen comes back on exit.
    alternateScreen: true,
    // Terminals that speak the kitty keyboard protocol (Ghostty, kitty, WezTerm, iTerm2, …) report Shift+Enter
    // apart from Enter, so it can insert a newline. Ink asks the terminal first; others are left as they are.
    kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
  });
  terminal.enter();
  if (initial.trim()) void controller.submit(initial);
  await instance.waitUntilExit();
  terminal.leave();
  const active = session.runs.activeRuns();
  await herdr?.close();
  await session.close();
  console.log(
    farewell(
      Date.now() - started,
      controller.store.get().costUsd,
      active.map((r) => r.id),
    ),
  );
  return 0;
}

/** What the shell shows once the window closes: how long it ran, what it cost, how to pick it up again. */
function farewell(ms: number, costUsd: number | null, stopped: string[]): string {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const dim = (s: string) => (tty ? `\u001B[2m${s}\u001B[22m` : s);
  const bold = (s: string) => (tty ? `\u001B[1m${s}\u001B[22m` : s);
  const facts = [formatDuration(ms), ...(costUsd !== null ? [`$${costUsd.toFixed(2)}`] : [])];
  const lines = [`${bold('▓▒░ legion')} ${dim(`· ${facts.join(' · ')}`)}`];
  lines.push(dim(`  Continue this conversation:  legion -c`));
  if (stopped.length > 0) {
    lines.push(`  Stopped ${stopped.length} active run${stopped.length > 1 ? 's' : ''}. Pick them up with:`);
    for (const id of stopped) lines.push(`    legion resume ${id}`);
  }
  return lines.join('\n');
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
    for (const account of session.listAccounts(kind)) {
      const info = await session.engine(kind, account.name).probe();
      const status = !info.installed ? '✗ not installed' : info.loggedIn === false ? '✗ not logged in' : '✓';
      if (status !== '✓') ok = false;
      console.log(
        `${kind.padEnd(9)} ${status} account "${account.name}"${account.dir ? ` (${account.dir})` : ''} · ${info.path ?? kind} ${info.version ?? ''}${info.error ? `\n          ${info.error}` : ''}`,
      );
    }
  }
  const remote = session.config.remote;
  const problem = session.remoteProblem();
  if (session.remoteEnabled && problem) ok = false;
  console.log(
    `remote    ${session.remoteEnabled ? 'on' : 'off'}${problem ? ` · ${session.remoteEnabled ? '✗' : '⚠'} ${problem}` : ''} · ${remote.snapshot ? `snapshot ${remote.snapshot}` : `fresh ${remote.runtime} boxes`}, ${remote.size}`,
  );
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
