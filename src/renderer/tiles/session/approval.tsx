/**
 * Approval UI shared by the session timeline and the inbox: what exactly the agent wants to do (command, edit,
 * patch or raw input), and the Accept / Accept for task / Deny decision.
 */
import type { InboxItemOf } from '@shared/domain';
import { Kbd } from '../../chrome/ui';
import { type ApprovalChoice, resolveApproval, usePendingResolution } from './actions';
import { Glyph } from './glyphs';
import { commandText, toolPath } from './timeline';

export type ApprovalSubject =
  | { kind: 'command'; command: string }
  | { kind: 'edit'; path: string; lines: { sign: '+' | '-' | ' '; text: string }[] }
  | { kind: 'other'; tool: string; text: string };

const MAX_LINES = 14;

function patchLines(patch: string) {
  return patch
    .split('\n')
    .filter((l) => !l.startsWith('***') && !l.startsWith('@@') && !l.startsWith('---') && !l.startsWith('+++'))
    .map((l) => ({
      sign: (l.startsWith('+') ? '+' : l.startsWith('-') ? '-' : ' ') as '+' | '-' | ' ',
      text: l.replace(/^[+\- ]/, ''),
    }));
}

/** Turn a tool name + input (Claude or Codex shapes) into something a human can judge at a glance. */
export function describeApproval(tool: string, input: unknown): ApprovalSubject {
  const command = commandText(input);
  if (command !== null) return { kind: 'command', command };
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = toolPath(input);
  if (path && (typeof r.old_string === 'string' || typeof r.new_string === 'string')) {
    const lines = [
      ...String(r.old_string ?? '')
        .split('\n')
        .filter(Boolean)
        .map((text) => ({ sign: '-' as const, text })),
      ...String(r.new_string ?? '')
        .split('\n')
        .filter(Boolean)
        .map((text) => ({ sign: '+' as const, text })),
    ];
    return { kind: 'edit', path, lines };
  }
  if (path && typeof r.content === 'string')
    return { kind: 'edit', path, lines: r.content.split('\n').map((text) => ({ sign: '+' as const, text })) };
  if (typeof r.patch === 'string')
    return {
      kind: 'edit',
      path: path ?? /\*\*\* \w+ File: (.+)/.exec(r.patch)?.[1] ?? 'patch',
      lines: patchLines(r.patch),
    };
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  return { kind: 'other', tool, text };
}

/** One-line label: `pnpm add …` / `Edit web/src/x.ts` / `WebFetch`. */
export function approvalLabel(tool: string, input: unknown): string {
  const subject = describeApproval(tool, input);
  if (subject.kind === 'command') return subject.command;
  if (subject.kind === 'edit') return `Edit ${subject.path}`;
  return tool;
}

export function ApprovalSubjectView({ subject, compact = false }: { subject: ApprovalSubject; compact?: boolean }) {
  if (subject.kind === 'command')
    return (
      <div className="ap-subject mono">
        <span className="faint">$</span> {subject.command}
      </div>
    );
  if (subject.kind === 'edit') {
    const shown = subject.lines.slice(0, compact ? 4 : MAX_LINES);
    const more = subject.lines.length - shown.length;
    return (
      <div className="ap-subject ap-edit mono">
        <div className="ap-edit-path">
          <Glyph name="edit" size={11} /> {subject.path}
        </div>
        {shown.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines
          <div key={i} className={`ap-line ap-line-${line.sign === '+' ? 'add' : line.sign === '-' ? 'del' : 'ctx'}`}>
            <span className="ap-sign">{line.sign}</span>
            {line.text || ' '}
          </div>
        ))}
        {more > 0 ? <div className="faint ap-more">… {more} more lines</div> : null}
      </div>
    );
  }
  return (
    <div className="ap-subject mono">
      <span className="faint">{subject.tool}</span>
      <pre className="ap-raw">
        {subject.text
          .split('\n')
          .slice(0, compact ? 4 : MAX_LINES)
          .join('\n')}
      </pre>
    </div>
  );
}

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  accept: 'Accepting…',
  acceptTask: 'Accepting for task…',
  deny: 'Denying…',
};

/** Accept / Accept for task / Deny, with in-flight and error state. */
export function ApprovalButtons({
  item,
  showKeys,
  compact = false,
}: {
  item: InboxItemOf<'approval'>;
  showKeys: boolean;
  compact?: boolean;
}) {
  const pending = usePendingResolution(item.id);
  const busy = pending?.state === 'pending';
  const size = compact ? ' btn-sm' : '';
  return (
    <div className="ap-actions">
      <button
        type="button"
        className={`btn btn-warn${size}`}
        disabled={busy}
        onClick={() => void resolveApproval(item, 'accept')}
        data-testid="approval-accept"
      >
        Accept{showKeys ? <Kbd>A</Kbd> : null}
      </button>
      <button
        type="button"
        className={`btn${size}`}
        disabled={busy}
        onClick={() => void resolveApproval(item, 'acceptTask')}
        title="Allow this and similar requests for the rest of the task"
      >
        Accept for task{showKeys ? <Kbd>⇧A</Kbd> : null}
      </button>
      <button
        type="button"
        className={`btn btn-ghost${size}`}
        disabled={busy}
        onClick={() => void resolveApproval(item, 'deny')}
      >
        Deny{showKeys ? <Kbd>D</Kbd> : null}
      </button>
      {pending ? (
        <span className={`ap-status${pending.state === 'error' ? ' ap-status-error' : ''}`} role="status">
          {pending.state === 'pending' ? CHOICE_LABEL[pending.choice] : pending.message}
        </span>
      ) : null}
    </div>
  );
}

/** The peach inline card in the session timeline. */
export function ApprovalCard({ item, focused }: { item: InboxItemOf<'approval'>; focused: boolean }) {
  const subject = describeApproval(item.payload.tool, item.payload.input);
  return (
    <section className="ap-card" data-testid="approval-card" aria-label="Approval needed">
      <div className="ap-title">
        <Glyph name="warn" size={14} />
        Approval needed
        <span className="ap-tool mono">{item.payload.tool}</span>
      </div>
      <ApprovalSubjectView subject={subject} />
      {item.payload.reason ? <div className="ap-reason">{item.payload.reason}</div> : null}
      <ApprovalButtons item={item} showKeys={focused} />
    </section>
  );
}
