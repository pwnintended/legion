/**
 * A review finding as a card (review tile and inline in the diff), with "send to agent" for minor findings
 * and a per-session dismiss.
 */
import type { EngineKind, FindingSeverity, Task } from '@shared/domain';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { rpc } from '../../app/hooks';
import { Chip, EngineChip } from '../../chrome/ui';
import type { Tone } from '../../layout/describe';
import { useAction } from '../plan/kit';
import type { TrackedFinding } from './evidence';

export const SEVERITY_TONE: Record<FindingSeverity, Tone> = {
  blocker: 'bad',
  major: 'warn',
  minor: 'idle',
  nit: 'idle',
};

const dismissed = createStore<Record<string, true>>(() => ({}));

export function useDismissed(key: string): boolean {
  return useStore(dismissed, (s) => s[key] === true);
}

export function setDismissed(key: string, value: boolean): void {
  const next = { ...dismissed.getState() };
  if (value) next[key] = true;
  else delete next[key];
  dismissed.setState(next);
}

/** Can the coder be asked for changes right now? */
export function canRequestChanges(task: Task | null): boolean {
  return !!task && ['awaiting_human', 'approved', 'reviewing', 'verifying', 'failed'].includes(task.status);
}

export function findingFeedback(f: TrackedFinding): string {
  const where = f.finding.file ? ` (${f.finding.file}${f.finding.line ? `:${f.finding.line}` : ''})` : '';
  const fix = f.finding.suggestedFix ? `\n\nSuggested fix:\n${f.finding.suggestedFix}` : '';
  return `${f.finding.title}${where}: ${f.finding.body}${fix}`;
}

export function FindingCard({
  tracked,
  reviewer,
  task,
  scope,
  compact = false,
  showRound = true,
  active = false,
  onOpen,
}: {
  tracked: TrackedFinding;
  reviewer: EngineKind;
  task: Task | null;
  /** Prefix for the dismissed-state key (one per task). */
  scope: string;
  compact?: boolean;
  /** Hide the round label (single-review contexts like the final review). */
  showRound?: boolean;
  active?: boolean;
  onOpen?: () => void;
}) {
  const { finding, state, round } = tracked;
  const key = `${scope}:${tracked.key}`;
  const isDismissed = useDismissed(key);
  const [send, { pending, error }] = useAction(async () => {
    if (!task) return;
    await rpc('tasks.requestChanges', { taskId: task.id, feedback: findingFeedback(tracked) });
  });
  const resolved = state === 'resolved';
  const minor = finding.severity === 'minor' || finding.severity === 'nit';
  const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : null;
  return (
    <div
      className="lg-finding"
      data-state={resolved ? 'resolved' : 'open'}
      data-sev={finding.severity}
      data-active={active}
      data-testid="finding"
      style={isDismissed ? { opacity: 0.55 } : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        {resolved ? (
          <Chip tone="ok">resolved</Chip>
        ) : (
          <Chip tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Chip>
        )}
        <EngineChip engine={reviewer} />
        <span className="faint text-[12px]">
          {[
            showRound ? `round ${round}` : null,
            resolved ? finding.severity : minor && !isDismissed ? 'goes to PR notes' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          {isDismissed ? ' · dismissed' : ''}
        </span>
        {where && !compact ? (
          onOpen ? (
            <button type="button" className="lg-link mono ml-auto text-[11px]" onClick={onOpen} title="Show in diff">
              {where}
            </button>
          ) : (
            <span className="faint mono ml-auto text-[11px]">{where}</span>
          )
        ) : null}
      </div>
      <div className={resolved ? 'lg-strike' : undefined}>
        <span className="font-medium">{finding.title}.</span>{' '}
        <span className={resolved ? '' : 'text-subtext1'}>{finding.body}</span>
      </div>
      {finding.suggestedFix && !resolved ? <SuggestedFix text={finding.suggestedFix} /> : null}
      {error ? <div className="text-[12px] text-red">{error}</div> : null}
      {!resolved && minor ? (
        <div className="flex gap-1.5">
          {task ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!canRequestChanges(task) || pending || isDismissed}
              title={
                canRequestChanges(task) ? 'Ask the coder to fix this now' : 'The coder is busy; it goes to the PR notes'
              }
              onClick={() => void send()}
            >
              {pending ? 'Sending…' : 'Send to agent'}
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissed(key, !isDismissed)}>
            {isDismissed ? 'Restore' : 'Dismiss'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SuggestedFix({ text }: { text: string }) {
  const lines = text.split('\n');
  const diffish = lines.some((l) => l.startsWith('+ ') || l.startsWith('- '));
  return (
    <pre>
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static lines
          key={i}
          className={
            diffish && line.startsWith('+') ? 'lg-add' : diffish && line.startsWith('-') ? 'lg-del' : undefined
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
