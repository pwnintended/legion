/** How the conversation names agents and answered decisions (pure). */
import type { Attempt, EngineKind, InboxItem, InboxResolutionSchemas, QuestionAnswer, Role } from '@shared/domain';
import type { z } from 'zod';
import type { DataState } from '../app/data';
import { latestPlan } from '../app/data';
import { displayEngine, formatCost } from '../layout/describe';
import { approvalLabel } from '../tiles/session/approval';
import { askedQuestions, sentAnswers } from '../tiles/session/user-input';

export interface AgentLabel {
  /** `T3 · Enrollment UI`, `Lead`, `Researcher`. */
  name: string;
  /** `coder`, `reviewer`, ... (null when the name already says it). */
  role: string | null;
  engine: EngineKind;
  /** Plan node of a task agent. */
  nodeId: string | null;
}

const ROLE_NAME: Record<Role, string> = {
  planner: 'Planner',
  coder: 'Coder',
  reviewer: 'Reviewer',
  resolver: 'Conflict resolver',
  finalizer: 'Final review',
  lead: 'Lead',
  researcher: 'Researcher',
  research_lead: 'Research lead',
  assistant: 'Assistant',
  session: 'Session',
};

export function agentLabel(state: DataState, attemptId: string): AgentLabel {
  const attempt: Attempt | undefined = state.attempts[attemptId];
  if (!attempt) return { name: 'An agent', role: null, engine: 'claude', nodeId: null };
  const engine = displayEngine(state, attempt);
  const task = attempt.taskId ? state.tasks[attempt.taskId] : undefined;
  if (task) {
    const node = latestPlan(state, task.runId)?.dag.nodes.find((n) => n.id === task.nodeId);
    return {
      name: node ? `${task.nodeId} · ${node.title}` : task.nodeId,
      role: attempt.role === 'coder' ? null : attempt.role,
      engine,
      nodeId: task.nodeId,
    };
  }
  return { name: ROLE_NAME[attempt.role], role: null, engine, nodeId: null };
}

/** The label of a decision's kind, as the card header says it. */
export const DECISION_TITLE: Record<InboxItem['kind'], string> = {
  approval: 'Approval',
  question: 'Question',
  plan_signoff: 'Plan sign-off',
  escalation: 'Escalation',
  conflict: 'Merge conflict',
  pr_ready: 'Pull request',
  budget: 'Budget',
};

/** A card's title; an agent's question through its engine's own tool reads as a question, not an approval. */
export function decisionTitle(item: InboxItem): string {
  if (item.kind === 'approval' && askedQuestions(item.payload.tool, item.payload.input)) return DECISION_TITLE.question;
  return DECISION_TITLE[item.kind];
}

const ESCALATION_DONE: Record<string, string> = {
  retry: 'retried',
  restart: 'started over',
  skip: 'skipped',
  abort: 'stopped the run',
  edit: 'retried with a note',
};

type ResolutionOf<K extends InboxItem['kind']> = z.infer<(typeof InboxResolutionSchemas)[K]> | null;
/** The item's resolution, typed by its kind (zod's inferred item type does not narrow it). */
const resolutionOf = <K extends InboxItem['kind']>(item: InboxItem & { kind: K }) => item.resolution as ResolutionOf<K>;

/** One line for an answered decision: what was decided. */
export function receiptText(item: InboxItem, taskLabel: string | null): string {
  const task = taskLabel ?? 'the task';
  switch (item.kind) {
    case 'approval': {
      const subject = approvalLabel(item.payload.tool, item.payload.input);
      const decision = resolutionOf(item)?.decision;
      if (!decision) return `${subject}: lapsed when the agent's turn ended`;
      const questions = askedQuestions(item.payload.tool, item.payload.input);
      if (questions) {
        if (decision.behavior === 'deny') return `Skipped: ${subject}`;
        const answers = sentAnswers(item.payload.tool, decision.updatedInput);
        // A secret answer (Codex `isSecret`) stays off the receipt.
        return answers.length && !questions.some((q) => q.secret)
          ? `Answered: ${answers.join('; ')}`
          : `Answered: ${subject}`;
      }
      if (decision.behavior === 'deny') return `Denied ${subject}`;
      return decision.scope === 'session' ? `Allowed ${subject} for the rest of ${task}` : `Allowed ${subject}`;
    }
    case 'question': {
      const answers = (item.resolution as { answers?: QuestionAnswer[] } | null)?.answers ?? [];
      if (item.payload.source === 'clarify') {
        const n = item.payload.questions.length;
        return answers.length
          ? `Answered the planner's ${n === 1 ? 'question' : `${n} questions`}`
          : 'Questions closed';
      }
      const answer = answers[0]?.answer;
      return answer ? `Answered: ${answer}` : 'Question closed';
    }
    case 'plan_signoff': {
      const resolution = resolutionOf(item);
      const name = item.payload.amendment
        ? `the change to plan v${item.payload.version}`
        : `plan v${item.payload.version}`;
      if (!resolution) return `Sign-off of ${name} closed`;
      if (resolution.approved) return `Approved ${name}`;
      if (!resolution.feedback) return `Turned down ${name}`;
      const who = resolution.by === 'assistant' ? 'The assistant asked' : 'Asked';
      return `${who} for changes to ${name}: “${resolution.feedback}”`;
    }
    case 'escalation': {
      const action = resolutionOf(item)?.action;
      return action ? `${taskLabel ?? 'Task'} ${ESCALATION_DONE[action] ?? action}` : `${taskLabel ?? 'Task'}: closed`;
    }
    case 'conflict': {
      const action = resolutionOf(item)?.action;
      return action === 'retry'
        ? `Retried the conflict resolver on ${task}`
        : action === 'skip'
          ? `Skipped ${task}`
          : action === 'abort'
            ? 'Stopped the run over the conflict'
            : 'Conflict closed';
    }
    case 'pr_ready':
      if (!resolutionOf(item)?.approved) return 'Closed without opening a pull request';
      return resolutionOf(item)?.action === 'merge' ? 'Merged it locally' : 'Opened the draft pull request';
    case 'budget': {
      const resolution = resolutionOf(item);
      if (resolution?.action === 'raise' && resolution.newLimitUsd !== null)
        return `Raised the budget to ${formatCost(resolution.newLimitUsd)}`;
      return resolution?.action === 'stop' ? 'Stopped the run at its budget' : 'Budget notice closed';
    }
  }
}

/** A receipt reads as a positive outcome (green) or a closing one (muted). */
export function receiptTone(item: InboxItem): 'ok' | 'muted' | 'bad' {
  if (item.resolution === null) return 'muted';
  switch (item.kind) {
    case 'approval':
      return resolutionOf(item)?.decision.behavior === 'deny' ? 'bad' : 'ok';
    case 'plan_signoff':
      return resolutionOf(item)?.approved ? 'ok' : 'muted';
    case 'escalation':
      return resolutionOf(item)?.action === 'abort' ? 'bad' : 'ok';
    case 'conflict':
      return resolutionOf(item)?.action === 'abort' ? 'bad' : 'ok';
    case 'budget':
      return resolutionOf(item)?.action === 'stop' ? 'bad' : 'ok';
    default:
      return 'ok';
  }
}
