import { ROLES } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { makeNode } from '../testing';
import { builtinSystemPrompts } from './builtin';
import { buildCoderPrompt, buildFixerPrompt } from './coder';
import { composeSystemPrompt, hasPromptLayers, missingToolNames, NO_PROMPT_LAYERS } from './layers';
import { buildLeadPrompt } from './lead';
import { DEFAULT_TOOL_NAMES } from './types';

describe('prompt layers', () => {
  it('leaves the built-in prompt alone without layers', () => {
    expect(composeSystemPrompt('Built in.', NO_PROMPT_LAYERS)).toBe('Built in.');
    expect(hasPromptLayers(NO_PROMPT_LAYERS)).toBe(false);
  });

  it('adds the global, then the repository instructions under their own headings', () => {
    const text = composeSystemPrompt('Built in.', {
      replace: null,
      append: 'Run pnpm lint.\n',
      project: ' Use pnpm. ',
    });
    expect(text).toBe(
      'Built in.\n\n## Additional instructions\n\nRun pnpm lint.\n\n## Additional instructions for this repository\n\nUse pnpm.',
    );
  });

  it('uses a replacement instead of the built-in, still with the additions', () => {
    const text = composeSystemPrompt('Built in.', { replace: 'Mine.', append: '', project: 'Here.' });
    expect(text).toBe('Mine.\n\n## Additional instructions for this repository\n\nHere.');
    expect(composeSystemPrompt('Built in.', { replace: '  ', append: '', project: null })).toBe('Built in.');
    expect(hasPromptLayers({ replace: '  ', append: ' ', project: null })).toBe(false);
  });

  it('lists the tool names a replacement no longer mentions', () => {
    const builtin = ['Call `mark_task_done` when done; report with `report_progress`.'];
    expect(missingToolNames(builtin, 'Report with report_progress.')).toEqual(['mark_task_done']);
    expect(missingToolNames(builtin, 'mcp__legion__mark_task_done and `report_progress`')).toEqual([]);
    expect(missingToolNames(builtin, 'call mark_task_done_now')).toEqual(['mark_task_done', 'report_progress']);
  });
});

describe('built-in prompts', () => {
  it('has at least one non-empty variant per role, with unique ids', () => {
    for (const role of ROLES) {
      const variants = builtinSystemPrompts(role, 'acme');
      expect(variants.length, role).toBeGreaterThan(0);
      expect(new Set(variants.map((v) => v.id)).size, role).toBe(variants.length);
      for (const v of variants) expect(v.text.trim().length, `${role}/${v.id}`).toBeGreaterThan(40);
      if (variants.length > 1) for (const v of variants) expect(v.label, `${role}/${v.id}`).toBeTruthy();
    }
  });

  it('is the text the builders send', () => {
    const coder = builtinSystemPrompts('coder');
    const node = makeNode('T1', []);
    const repo = { baseRef: 'main', verifyCommands: [], setupCommands: [], installCommand: null, conventions: null };
    const issue = { title: 'x', text: 'y', url: null };
    expect(coder[0]?.text).toBe(
      buildCoderPrompt({ node, planSummary: 'p', upstream: [], issue, repo, attempt: 1, lead: true }).systemPrompt,
    );
    expect(coder[1]?.text).toBe(
      buildFixerPrompt({
        node,
        round: 1,
        maxRounds: 2,
        findings: [],
        unmetCriteria: [],
        failedVerify: [],
      }).systemPrompt,
    );
    const lead = builtinSystemPrompts('lead');
    expect(lead[0]?.text).toBe(
      buildLeadPrompt({ issue, planMarkdown: 'p', nodes: [node], parent: true, tools: DEFAULT_TOOL_NAMES })
        .systemPrompt,
    );
  });
});
