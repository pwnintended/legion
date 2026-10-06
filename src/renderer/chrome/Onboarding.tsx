/** First screen when there are no runs: what Legion does, engine detection, and one obvious next step (⌘N). */

import type { EngineInfo } from '@shared/engine';
import type { AppInfo } from '@shared/rpc';
import { Fragment } from 'react';
import { commandTooltip, executeCommand } from '../app/commands';
import { useConnectionState, useRpcQuery } from '../app/engine';
import { useEngines } from '../app/hooks';
import { ENGINE_NAME } from '../layout/describe';
import { Icon, type IconName, LegionMark } from './icons';
import { CommandKbd, Dot } from './ui';

const STEPS: { icon: IconName; label: string; note: string }[] = [
  { icon: 'list', label: 'Plan', note: 'clarify + draft' },
  { icon: 'dag', label: 'DAG', note: 'you sign off' },
  { icon: 'layers', label: 'Agents', note: 'parallel worktrees' },
  { icon: 'eye', label: 'Review', note: 'cross-engine' },
  { icon: 'pr', label: 'PR', note: 'one draft' },
];

export function Onboarding() {
  const engines = useEngines();
  return (
    <div className="flex min-h-0 flex-1 overflow-auto" data-testid="onboarding">
      <div
        className="m-auto flex w-full max-w-[680px] flex-col items-center gap-9 px-6 py-12 text-center"
        style={{ animation: 'lg-rise 0.4s var(--ease-out) both' }}
      >
        <div className="flex flex-col items-center gap-5">
          <div
            className="grid size-16 place-items-center rounded-[18px] border-[1.5px] border-surface0 bg-base"
            style={{ boxShadow: '0 0 0 1px rgb(203 166 247 / 0.12), 0 12px 48px rgb(203 166 247 / 0.14)' }}
          >
            <LegionMark size={32} />
          </div>
          <div className="flex flex-col gap-2.5">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-text">Point Legion at an issue.</h1>
            <p className="mx-auto max-w-[520px] text-[14px] leading-relaxed text-subtext0">
              It drafts a plan and a task graph for your sign-off, runs Claude Code and Codex side by side in their own
              worktrees, has each engine review the other’s work, and hands you a single draft PR.
            </p>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary h-9 px-4"
              onClick={() => void executeCommand('composer.open')}
              title={commandTooltip('composer.open')}
            >
              <Icon name="plus" strokeWidth={2.4} />
              Start a run
              <CommandKbd id="composer.open" />
            </button>
            <button type="button" className="btn btn-ghost h-9" onClick={() => void executeCommand('palette.open')}>
              All commands
              <CommandKbd id="palette.open" />
            </button>
          </div>
        </div>

        <ol className="flex w-full items-center justify-center gap-1.5" aria-label="How a run flows">
          {STEPS.map((step, i) => (
            <Fragment key={step.label}>
              {i > 0 ? <li aria-hidden="true" className="h-px w-5 flex-none bg-surface1" /> : null}
              <li
                className="flex w-[92px] flex-none flex-col items-center gap-1.5"
                style={{ animation: `lg-rise 0.4s var(--ease-out) ${120 + i * 60}ms both` }}
              >
                <span className="grid size-9 place-items-center rounded-[10px] border-[1.5px] border-surface0 bg-base text-subtext1">
                  <Icon name={step.icon} size={15} />
                </span>
                <span className="text-xs font-semibold">{step.label}</span>
                <span className="faint text-[11px]">{step.note}</span>
              </li>
            </Fragment>
          ))}
        </ol>

        <section className="grid w-full grid-cols-2 gap-2.5 text-left max-[640px]:grid-cols-1" aria-label="Engines">
          {(['claude', 'codex'] as const).map((kind) => (
            <EngineCard
              key={kind}
              kind={kind}
              info={engines.list.find((e) => e.kind === kind) ?? null}
              detecting={engines.status === 'unknown'}
            />
          ))}
        </section>

        <Diagnostics />
      </div>
    </div>
  );
}

function EngineCard({
  kind,
  info,
  detecting,
}: {
  kind: 'claude' | 'codex';
  info: EngineInfo | null;
  detecting: boolean;
}) {
  const color = kind === 'codex' ? 'var(--teal)' : 'var(--mauve)';
  let status: { text: string; tone: string; live?: boolean };
  if (!info)
    status = detecting
      ? { text: 'detecting…', tone: 'var(--overlay2)', live: true }
      : { text: 'not detected yet', tone: 'var(--overlay2)' };
  else if (!info.installed) status = { text: 'not installed', tone: 'var(--red)' };
  else if (info.loggedIn === false) status = { text: 'installed · not logged in', tone: 'var(--peach)' };
  else status = { text: info.loggedIn ? 'ready' : 'installed', tone: 'var(--green)' };
  const hint = !info?.installed
    ? kind === 'claude'
      ? 'npm i -g @anthropic-ai/claude-code'
      : 'npm i -g @openai/codex'
    : info.loggedIn === false
      ? `${kind} login`
      : (info.account ?? info.path ?? '');
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border-[1.5px] border-surface0 bg-base px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Dot color={color} />
        <span className="text-[13px] font-semibold">{ENGINE_NAME[kind]}</span>
        <span className="mono faint ml-auto text-[11px]">{info?.version ?? ''}</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs" style={{ color: status.tone }}>
        <Dot color={status.tone} live={status.live} />
        {status.text}
      </div>
      {hint ? (
        <div className="mono faint truncate text-[11px]" title={hint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/** Engine process facts. Also what the smoke test checks for (`engine-info`, `info-engine-pid`). */
function Diagnostics() {
  const { generation } = useConnectionState();
  const info = useRpcQuery('app.info', {}, generation);
  return (
    <section
      data-testid="engine-info"
      className="w-full rounded-[12px] border border-[var(--hairline)] bg-mantle px-4 py-3 text-left"
      aria-label="Engine diagnostics"
    >
      <div className="mb-2 flex items-center gap-2 text-xs text-subtext1">
        {info.status === 'success' ? (
          <>
            <Dot color="var(--green)" /> engine ready
          </>
        ) : info.status === 'error' ? (
          <>
            <Dot color="var(--red)" /> <span className="text-red">{info.error.message}</span>
          </>
        ) : (
          <>
            <Dot color="var(--peach)" live /> connecting to engine…
          </>
        )}
      </div>
      {info.status === 'success' ? <InfoRows info={info.data} /> : null}
    </section>
  );
}

function InfoRows({ info }: { info: AppInfo }) {
  const rows: [string, string][] = [
    ['version', info.version],
    ['runtime', `node ${info.runtime.node}${info.runtime.electron ? ` · electron ${info.runtime.electron}` : ''}`],
    ['platform', `${info.runtime.platform} ${info.runtime.arch}`],
    ['engine pid', String(info.pid)],
    ['database', info.dbPath],
    ['schema', `v${info.schemaVersion} · head seq ${info.headSeq}`],
  ];
  return (
    <dl className="mono grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 text-[11px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="faint">{label}</dt>
          <dd className="truncate text-subtext1" title={value} data-testid={`info-${label.replace(' ', '-')}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
