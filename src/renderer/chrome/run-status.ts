/**
 * One-line run status (`executing · 2 agents`, `PR ready · 3/4 merged`, ...) for the rail and project activity.
 * What waits on the human leads: a run with open decisions says so in peach, whatever its agents are doing.
 */
import type { Run } from '@shared/domain';
import { runPr } from '../app/compat';
import type { Tone } from '../layout/describe';

export function runStatusLine(
  run: Run,
  agents: number,
  merged: number,
  total: number,
  urgent: number,
): { text: string; tone: Tone; live: boolean } {
  const paused = run.paused ? ' · paused' : '';
  const waiting = `${urgent} waiting for you`;
  switch (run.status) {
    case 'chatting':
      return { text: 'conversation', tone: agents > 0 ? 'run' : 'idle', live: agents > 0 };
    case 'session':
      if (urgent) return { text: waiting, tone: 'warn', live: false };
      return { text: 'session', tone: agents > 0 ? 'run' : 'idle', live: agents > 0 };
    case 'draft':
      return { text: `draft${paused}`, tone: 'idle', live: false };
    case 'clarifying':
      return urgent
        ? { text: 'questions for you', tone: 'warn', live: false }
        : { text: `clarifying${paused}`, tone: 'run', live: !run.paused };
    case 'planning':
      if (urgent) return { text: waiting, tone: 'warn', live: false };
      return { text: `planning${paused}`, tone: 'run', live: !run.paused };
    case 'awaiting_approval':
      return { text: 'plan ready for sign-off', tone: 'warn', live: false };
    case 'executing':
      if (urgent) return { text: waiting, tone: 'warn', live: false };
      return {
        text: `executing · ${agents} agent${agents === 1 ? '' : 's'}${paused}`,
        tone: run.paused ? 'warn' : 'run',
        live: !run.paused && agents > 0,
      };
    case 'integrating':
      if (urgent) return { text: waiting, tone: 'warn', live: false };
      return { text: `integrating · ${merged}/${total}${paused}`, tone: 'run', live: !run.paused };
    case 'finalizing':
      if (urgent) return { text: waiting, tone: 'warn', live: false };
      return { text: `final review${paused}`, tone: 'run', live: !run.paused };
    case 'pr_ready':
      return urgent
        ? { text: 'PR ready for you', tone: 'warn', live: false }
        : { text: `PR ready · ${merged}/${total} merged`, tone: 'ok', live: false };
    case 'done': {
      if (run.merged) return { text: `done · merged into ${run.merged.into}`, tone: 'ok', live: false };
      const pr = runPr(run);
      if (!pr) return { text: 'done', tone: 'ok', live: false };
      const n = pr.number ? ` #${pr.number}` : '';
      if (pr.state === 'merged') return { text: `done · PR${n} merged`, tone: 'ok', live: false };
      if (pr.state === 'closed') return { text: `done · PR${n} closed`, tone: 'idle', live: false };
      return { text: `done · ${pr.isDraft ? 'draft ' : ''}PR${n} open`, tone: 'ok', live: false };
    }
    case 'failed':
      return { text: 'failed', tone: 'bad', live: false };
    case 'cancelled':
      return { text: 'cancelled', tone: 'idle', live: false };
  }
}
