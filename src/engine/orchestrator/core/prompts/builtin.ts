/**
 * Legion's built-in system prompt of every role, as Settings → Agents shows it: the text each builder sends,
 * with the plain tool names and placeholders where a run fills in its own (the project, the requester). A role
 * whose prompt differs by situation (a coder implementing vs fixing, a lead with or without the assistant) has
 * one variant per situation; a replacement applies to all of them.
 */
import type { Role } from '@shared/domain';
import { assistantSystem } from './assistant';
import { coderSystem, fixerSystem, resolverSystem } from './coder';
import { leadSystem } from './lead';
import { PLANNER_SYSTEM } from './planner';
import { researcherSystem, researchLeadSystem } from './research';
import { FINALIZER_SYSTEM, REVIEWER_SYSTEM } from './review';
import { sessionSystem } from './session';
import { DEFAULT_TOOL_NAMES } from './types';

export interface BuiltinPromptVariant {
  readonly id: string;
  /** The situation, when the role has more than one; null for a role with one prompt. */
  readonly label: string | null;
  /** When it is used, in a sentence. */
  readonly when: string;
  readonly text: string;
}

export function builtinSystemPrompts(role: Role, projectName = 'your-project'): BuiltinPromptVariant[] {
  const tools = DEFAULT_TOOL_NAMES;
  const one = (when: string, text: string): BuiltinPromptVariant[] => [{ id: role, label: null, when, text }];
  switch (role) {
    case 'planner':
      return one('Both planner steps: the clarifying questions and the plan.', PLANNER_SYSTEM);
    case 'coder':
      return [
        {
          id: 'implement',
          label: 'Implement',
          when: 'A task’s first session. The lead rule is left out when runs have no implementation lead.',
          text: coderSystem(tools, true),
        },
        {
          id: 'fix',
          label: 'Fix round',
          when: 'A fresh session for a fix round, when the coder’s own session can’t be resumed.',
          text: fixerSystem(tools),
        },
      ];
    case 'reviewer':
      return one('Every task review and re-review.', REVIEWER_SYSTEM);
    case 'resolver':
      return one(
        'A merge of the integration branch into a task branch that stopped on conflicts.',
        resolverSystem(tools),
      );
    case 'finalizer':
      return one('The review of the whole change before the pull request.', FINALIZER_SYSTEM);
    case 'lead':
      return [
        {
          id: 'assistant',
          label: 'With the assistant',
          when: 'Runs started from a conversation: the lead reports to the assistant.',
          text: leadSystem(tools, true),
        },
        {
          id: 'direct',
          label: 'Without',
          when: 'Runs planned directly: the lead asks you itself.',
          text: leadSystem(tools, false),
        },
      ];
    case 'researcher':
      return one(
        'Every research brief. “implementation lead” is whoever asked.',
        researcherSystem('implementation lead'),
      );
    case 'research_lead':
      return one(
        'Broad research briefs. “implementation lead” is whoever asked.',
        researchLeadSystem('implementation lead'),
      );
    case 'assistant':
      return one('Every conversation. The project’s name is filled in.', assistantSystem(projectName, tools));
    case 'session':
      return [
        {
          id: 'checkout',
          label: 'In your checkout',
          when: 'A direct session that edits your working tree.',
          text: sessionSystem({ project: projectName, baseRef: 'main', worktreeBranch: null }),
        },
        {
          id: 'worktree',
          label: 'In a worktree',
          when: 'A direct session in a worktree of its own. Branches are filled in.',
          text: sessionSystem({ project: projectName, baseRef: 'main', worktreeBranch: 'legion/…/integration' }),
        },
      ];
  }
}
