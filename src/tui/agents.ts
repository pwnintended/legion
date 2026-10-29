import { oneLine } from './store.ts';

export type AgentOwner =
  | { kind: 'orchestrator' }
  | { kind: 'lead'; name: string }
  | { kind: 'step'; runId: string; key: string };

export type AgentRef = AgentOwner | { kind: 'sub'; owner: AgentOwner; id: string };

export function agentKey(ref: AgentRef): string {
  switch (ref.kind) {
    case 'orchestrator':
      return 'orchestrator';
    case 'lead':
      return `lead:${ref.name}`;
    case 'step':
      return `step:${ref.runId}:${ref.key}`;
    case 'sub':
      return `${agentKey(ref.owner)}/sub:${ref.id}`;
  }
}

export interface SubagentView {
  owner: AgentOwner;
  id: string;
  parent: string | null;
  agentType: string | null;
  description: string | null;
  status: 'working' | 'done' | 'failed';
  activity: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface AgentNode {
  ref: AgentRef | null;
  key: string;
  depth: number;
  kind: 'orchestrator' | 'lead' | 'run' | 'step' | 'sub';
  label: string;
  detail: string | null;
  status: 'working' | 'idle' | 'done' | 'failed' | 'stopped';
  talkable: boolean;
}

export function subagentLabel(v: SubagentView): string {
  return ['sub agent', v.agentType, v.description === null ? null : oneLine(v.description, 80)]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Every visible agent in display order; run headers are not selectable. */
export function buildAgentTree(state: import('./store.ts').UiState): AgentNode[] {
  const nodes: AgentNode[] = [];
  const subs = (owner: AgentOwner, depth: number) => {
    const entries = state.subagents.filter((s) => agentKey(s.owner) === agentKey(owner));
    const seen = new Set<string>();
    const visit = (s: SubagentView, level: number) => {
      if (seen.has(s.id)) return;
      seen.add(s.id);
      const ref: AgentRef = { kind: 'sub', owner, id: s.id };
      nodes.push({
        ref,
        key: agentKey(ref),
        depth: level,
        kind: 'sub',
        label: subagentLabel(s),
        detail: s.activity,
        status: s.status,
        talkable: false,
      });
      for (const child of entries.filter((child) => child.parent === s.id)) visit(child, level + 1);
    };
    for (const s of entries.filter((s) => s.parent === null || !entries.some((p) => p.id === s.parent)))
      visit(s, depth);
    for (const s of entries) if (!seen.has(s.id)) visit(s, depth);
  };
  const runs = (owner: string | undefined, depth: number) => {
    for (const run of [...state.runs, ...state.finishedRuns].filter((r) => r.owner === owner)) {
      nodes.push({
        ref: null,
        key: `run:${run.id}`,
        depth,
        kind: 'run',
        label: `${run.workflow} ${run.id}`,
        detail: null,
        status: state.runs.includes(run) ? 'working' : run.steps.some((s) => s.status === 'failed') ? 'failed' : 'done',
        talkable: false,
      });
      for (const step of run.steps.filter((s) => s.kind === 'agent')) {
        const ref: AgentOwner = { kind: 'step', runId: run.id, key: step.key };
        nodes.push({
          ref,
          key: agentKey(ref),
          depth: depth + 1,
          kind: 'step',
          label: step.label,
          detail: step.activity,
          status: step.status === 'started' ? 'working' : step.status === 'failed' ? 'failed' : 'done',
          talkable: false,
        });
        subs(ref, depth + 2);
      }
    }
  };
  const root: AgentOwner = { kind: 'orchestrator' };
  nodes.push({
    ref: root,
    key: agentKey(root),
    depth: 0,
    kind: 'orchestrator',
    label: 'orchestrator',
    detail: state.activity,
    status: state.busy ? 'working' : 'idle',
    talkable: true,
  });
  subs(root, 1);
  runs(undefined, 1);
  for (const lead of state.team) {
    const ref: AgentOwner = { kind: 'lead', name: lead.name };
    const depth = lead.depth + 1;
    nodes.push({
      ref,
      key: agentKey(ref),
      depth,
      kind: 'lead',
      label: lead.name,
      detail: lead.doing,
      status: lead.status === 'starting' ? 'working' : lead.status,
      talkable: true,
    });
    subs(ref, depth + 1);
    runs(lead.name, depth + 1);
  }
  return nodes;
}
