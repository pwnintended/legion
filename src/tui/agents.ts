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
