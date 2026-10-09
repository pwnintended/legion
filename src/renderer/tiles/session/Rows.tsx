/** Timeline row renderers (one compact row per folded event, see timeline.ts). */

import type { ApprovalDecision, EngineKind, InboxItem, InboxItemOf } from '@shared/domain';
import type { TodoItem } from '@shared/events';
import { memo, type ReactNode, useState } from 'react';
import { ChipList } from '../../attachments/Attachments';
import type { SentMessage } from './actions';
import { dismissSent } from './actions';
import { ApprovalCard, approvalLabel } from './approval';
import { Glyph, type GlyphName } from './glyphs';
import { Markdown } from './Markdown';
import type { TimelineRow } from './timeline';
import { askedQuestions } from './user-input';

export interface RowContext {
  engine: EngineKind;
  /** The attempt is running (shows live states and the caret). */
  running: boolean;
  focused: boolean;
  /** Approval inbox items of this attempt by request id (open or resolved). */
  approvals: ReadonlyMap<string, InboxItem>;
  onOpenDiff: ((path: string) => void) | null;
}

const ENGINE_LETTER: Record<EngineKind, string> = { claude: 'C', codex: 'X', fake: 'F' };

function Ev({
  icon,
  tone,
  children,
  className,
}: {
  icon: ReactNode;
  tone?: 'claude' | 'codex' | 'ok' | 'bad' | 'warn' | 'user' | 'muted';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ev ${className ?? ''}`}>
      <span className={`evi${tone ? ` evi-${tone}` : ''}`}>{icon}</span>
      <div className="ev-body">{children}</div>
    </div>
  );
}

const glyph = (name: GlyphName, size = 12) => <Glyph name={name} size={size} />;

function engineTone(engine: EngineKind): 'claude' | 'codex' {
  return engine === 'codex' ? 'codex' : 'claude';
}

function StatusMark({ status }: { status: 'running' | 'ok' | 'failed' }) {
  if (status === 'running') return <span className="dot live tl-running" title="running" />;
  if (status === 'ok')
    return (
      <span className="tl-ok" role="img" aria-label="succeeded">
        {glyph('check', 11)}
      </span>
    );
  return (
    <span className="tl-bad" role="img" aria-label="failed">
      {glyph('x', 11)}
    </span>
  );
}

function lastLines(text: string, n: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-n);
}

function CommandRow({ row }: { row: Extract<TimelineRow, { kind: 'command' }> }) {
  const [open, setOpen] = useState(false);
  const output = row.output?.trim() ? row.output : null;
  const lines = output ? output.replace(/\s+$/, '').split('\n') : [];
  const summary = lines.at(-1) ?? null;
  return (
    <Ev icon={glyph('command')} tone={row.status === 'failed' ? 'bad' : undefined}>
      <div className="tool tool-col">
        <button
          type="button"
          className="tool-line tool-toggle"
          onClick={() => setOpen((v) => !v)}
          disabled={lines.length <= 1}
          aria-expanded={lines.length > 1 ? open : undefined}
        >
          <span className="tool-cmd">
            <span className="faint">$</span> {row.command}
          </span>
          <StatusMark status={row.status} />
        </button>
        {open && lines.length > 1 ? (
          <pre className="tool-output">{lastLines(output ?? '', 40).join('\n')}</pre>
        ) : summary ? (
          <span className={`tool-summary ${row.status === 'failed' ? 'tl-bad' : row.status === 'ok' ? 'tl-ok' : ''}`}>
            {summary}
            {lines.length > 1 ? <span className="faint"> · {lines.length} lines</span> : null}
          </span>
        ) : null}
      </div>
    </Ev>
  );
}

function ReadsRow({ row }: { row: Extract<TimelineRow, { kind: 'reads' }> }) {
  const [open, setOpen] = useState(false);
  const shown = open ? row.paths : row.paths.slice(0, 4);
  const more = row.paths.length - shown.length;
  return (
    <Ev icon={glyph('read')}>
      <div className="tool">
        <span className="tool-verb">Read {row.paths.length === 1 ? '' : `${row.paths.length} files`}</span>
        {shown.map((path) => (
          <span key={path} className="tool-path muted" title={path}>
            {path}
          </span>
        ))}
        {more > 0 ? (
          <button type="button" className="tool-more" onClick={() => setOpen(true)}>
            +{more} more
          </button>
        ) : null}
        {row.failed > 0 ? <span className="tl-bad">{row.failed} failed</span> : null}
      </div>
    </Ev>
  );
}

function EditRow({
  row,
  onOpenDiff,
}: {
  row: Extract<TimelineRow, { kind: 'edit' }>;
  onOpenDiff: RowContext['onOpenDiff'];
}) {
  const body = (
    <>
      <span className="tool-verb">Edit</span>
      <span className="tool-path" title={row.path}>
        {row.path}
      </span>
      {row.added !== null ? <span className="add">+{row.added}</span> : null}
      {row.removed !== null && row.removed > 0 ? <span className="del">−{row.removed}</span> : null}
      {row.status !== 'ok' ? <StatusMark status={row.status} /> : null}
    </>
  );
  return (
    <Ev icon={glyph('edit')} tone={row.status === 'failed' ? 'bad' : undefined}>
      {onOpenDiff ? (
        <button
          type="button"
          className="tool tool-button"
          onClick={() => onOpenDiff(row.path)}
          title="Open the task's diff"
        >
          {body}
        </button>
      ) : (
        <div className="tool">{body}</div>
      )}
    </Ev>
  );
}

const MCP_LABEL: Record<string, string> = {
  report_progress: 'Progress',
  mark_task_done: 'Marked done',
  request_human_input: 'Asked you',
};

function McpRow({ row }: { row: Extract<TimelineRow, { kind: 'mcp' }> }) {
  const label = row.server === 'legion' ? MCP_LABEL[row.tool] : undefined;
  if (label)
    return (
      <Ev
        icon={glyph(row.tool === 'mark_task_done' ? 'flag' : 'spark')}
        tone={row.tool === 'mark_task_done' ? 'ok' : 'muted'}
      >
        <div className="ev-note">
          <span className="ev-note-label">{label}</span>
          <span>{row.summary}</span>
        </div>
      </Ev>
    );
  return (
    <Ev icon={glyph('plug')}>
      <div className="tool">
        <span className="tool-verb">
          {row.server} · {row.tool}
        </span>
        {row.summary ? <span className="muted tool-path">{row.summary}</span> : null}
        <StatusMark status={row.status} />
      </div>
    </Ev>
  );
}

function ToolRow({ row }: { row: Extract<TimelineRow, { kind: 'tool' }> }) {
  return (
    <Ev icon={glyph('tool')}>
      <div className="tool">
        <span className="tool-verb">{row.name}</span>
        {row.summary ? <span className="muted tool-path">{row.summary}</span> : null}
        <StatusMark status={row.status} />
      </div>
    </Ev>
  );
}

const TODO_MARK: Record<TodoItem['status'], ReactNode> = {
  completed: <span className="tl-ok">✓</span>,
  in_progress: <span className="tl-run">◐</span>,
  pending: <span className="faint">○</span>,
};

function TodoRow({ row, engine }: { row: Extract<TimelineRow, { kind: 'todo' }>; engine: EngineKind }) {
  const done = row.items.filter((i) => i.status === 'completed').length;
  return (
    <Ev icon={glyph('todo')} tone={engineTone(engine)}>
      <div className="todo">
        <span className="todo-head faint">
          Plan · {done}/{row.items.length}
        </span>
        {row.items.map((item, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: todo items have no ids
            key={i}
            className={`todo-item todo-${item.status}`}
          >
            {TODO_MARK[item.status]} {item.text}
          </span>
        ))}
      </div>
    </Ev>
  );
}

function ReasoningRow({ row }: { row: Extract<TimelineRow, { kind: 'reasoning' }> }) {
  const [open, setOpen] = useState(false);
  const first = row.text.trim().split('\n')[0] ?? '';
  return (
    <Ev icon={glyph('thought')} tone="muted">
      <button type="button" className="reasoning" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="reasoning-head">
          <Glyph name={open ? 'chevronDown' : 'chevronRight'} size={11} />
          Reasoning
          {open ? null : <span className="reasoning-peek">{first}</span>}
        </span>
        {open ? <span className="reasoning-text">{row.text.trim()}</span> : null}
      </button>
    </Ev>
  );
}

function ApprovalRow({
  row,
  item,
  focused,
}: {
  row: Extract<TimelineRow, { kind: 'approval' }>;
  item: InboxItem | undefined;
  focused: boolean;
}) {
  const label = approvalLabel(row.tool, row.input);
  if (item?.kind === 'approval' && item.resolvedAt === null)
    return <ApprovalCard item={item as InboxItemOf<'approval'>} focused={focused} />;
  const approval = item?.kind === 'approval' ? (item as InboxItemOf<'approval'>) : null;
  // The schema types `resolution` as the union over every inbox kind; approvals carry a decision.
  const decision = (approval?.resolution as { decision?: ApprovalDecision } | null)?.decision ?? null;
  const resolution = decision;
  const allowed = decision?.behavior === 'allow';
  const scope = decision?.behavior === 'allow' ? decision.scope : null;
  const asked = askedQuestions(row.tool, row.input) !== null;
  return (
    <Ev
      icon={glyph(resolution ? (allowed ? 'check' : 'x') : 'shield')}
      tone={resolution ? (allowed ? 'ok' : 'bad') : 'warn'}
    >
      <div className="ev-note" data-testid="approval-resolved">
        <span className="ev-note-label">
          {resolution
            ? asked
              ? allowed
                ? 'Answered'
                : 'Skipped'
              : allowed
                ? scope === 'session'
                  ? 'Accepted for task'
                  : 'Accepted'
                : 'Denied'
            : 'Asked'}
        </span>
        <span className="mono ev-note-mono">{label}</span>
      </div>
    </Ev>
  );
}

function Divider({ children, tone }: { children: ReactNode; tone?: 'bad' }) {
  return (
    <div className={`tl-divider${tone ? ` tl-divider-${tone}` : ''}`}>
      <span>{children}</span>
    </div>
  );
}

export const Row = memo(function Row({ row, ctx, last }: { row: TimelineRow; ctx: RowContext; last: boolean }) {
  switch (row.kind) {
    case 'start':
      return (
        <Divider>
          session started{row.model ? ` · ${row.model}` : ''}
          {row.version ? ` · v${row.version}` : ''}
        </Divider>
      );
    case 'text':
      return (
        <Ev
          icon={<span className="evi-letter">{ENGINE_LETTER[ctx.engine]}</span>}
          tone={engineTone(ctx.engine)}
          className="ev-text"
        >
          <Markdown text={row.text} streaming={row.streaming} caret={row.streaming || (last && ctx.running)} />
        </Ev>
      );
    case 'reasoning':
      return <ReasoningRow row={row} />;
    case 'reads':
      return <ReadsRow row={row} />;
    case 'edit':
      return <EditRow row={row} onOpenDiff={ctx.onOpenDiff} />;
    case 'command':
      return <CommandRow row={row} />;
    case 'mcp':
      return <McpRow row={row} />;
    case 'tool':
      return <ToolRow row={row} />;
    case 'todo':
      return <TodoRow row={row} engine={ctx.engine} />;
    case 'approval':
      return <ApprovalRow row={row} item={ctx.approvals.get(row.requestId)} focused={ctx.focused} />;
    case 'turn':
      return row.isError ? (
        <Divider tone="bad">turn failed{row.reason ? ` · ${row.reason}` : ''}</Divider>
      ) : (
        <Divider>turn complete{row.reason && row.reason !== 'end_turn' ? ` · ${row.reason}` : ''}</Divider>
      );
    case 'error':
      return (
        <Ev icon={glyph('warn')} tone="bad">
          <div className="ev-error">
            {row.message}
            {row.retryable ? <span className="chip chip-idle">retryable</span> : null}
          </div>
        </Ev>
      );
    case 'exited':
      return (
        <Divider tone={row.code ? 'bad' : undefined}>
          process exited{row.code !== null ? ` · code ${row.code}` : ''}
        </Divider>
      );
  }
});

export function SentRow({ message, attemptId }: { message: SentMessage; attemptId: string }) {
  return (
    <Ev icon={glyph('user')} tone="user" className="ev-you">
      <div className="you">
        <span className="you-text">{message.text}</span>
        {message.attachments.length ? (
          <ChipList chips={message.attachments} size="sm" label="Sent attachments" />
        ) : null}
        <span className="you-meta">
          {message.status === 'sending'
            ? 'sending…'
            : message.status === 'error'
              ? null
              : message.priority === 'now'
                ? 'sent · interrupting'
                : 'queued for next turn'}
          {message.status === 'error' ? (
            <>
              <span className="tl-bad">{message.error}</span>
              <button type="button" className="tool-more" onClick={() => dismissSent(attemptId, message.id)}>
                dismiss
              </button>
            </>
          ) : null}
        </span>
      </div>
    </Ev>
  );
}
