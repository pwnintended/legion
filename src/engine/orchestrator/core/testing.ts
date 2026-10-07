/** Test fixtures for the orchestrator core (not exported from index.ts). */
import type { TaskNode, Touch } from '@shared/domain';

export function makeNode(
  id: string,
  dependsOn: string[] = [],
  overrides: Partial<Omit<TaskNode, 'id' | 'dependsOn'>> & { writes?: string[] } = {},
): TaskNode {
  const { writes, ...rest } = overrides;
  const touches: Touch[] = writes
    ? writes.map((glob) => ({ glob, mode: 'modify' as const }))
    : [{ glob: `src/${id.toLowerCase()}/**`, mode: 'create' }];
  return {
    id,
    title: `Task ${id}`,
    goal: `Implement ${id}.`,
    kind: 'feature',
    dependsOn,
    acceptanceCriteria: [{ id: 'AC1', text: `${id} works` }],
    touches,
    size: 'M',
    verify: { commands: ['pnpm test'] },
    contextHints: { files: [], notes: '' },
    agent: { effort: null },
    risk: 'low',
    ...rest,
  };
}
