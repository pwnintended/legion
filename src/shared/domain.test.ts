import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  applySettingsPatch,
  canTransition,
  DEFAULT_SETTINGS,
  InboxItemSchema,
  isTerminal,
  normalizeSettings,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  reviewPasses,
  SettingsSchema,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type TransitionTable,
} from './domain';
import { isId, newId, runShort, slugify } from './ids';

function checkTable<S extends string>(statuses: readonly S[], table: TransitionTable<S>) {
  expect(Object.keys(table).sort()).toEqual([...statuses].sort());
  for (const [from, targets] of Object.entries(table) as [S, readonly S[]][]) {
    for (const to of targets) {
      expect(statuses).toContain(to);
      expect(to).not.toBe(from);
    }
    expect(new Set(targets).size).toBe(targets.length);
  }
}

describe('status machines', () => {
  it('cover every status with valid targets', () => {
    checkTable(RUN_STATUSES, RUN_TRANSITIONS);
    checkTable(TASK_STATUSES, TASK_TRANSITIONS);
    checkTable(ATTEMPT_STATUSES, ATTEMPT_TRANSITIONS);
  });

  it('has the expected terminal states', () => {
    expect(RUN_STATUSES.filter((s) => isTerminal(RUN_TRANSITIONS, s))).toEqual(['done', 'failed', 'cancelled']);
    expect(TASK_STATUSES.filter((s) => isTerminal(TASK_TRANSITIONS, s))).toEqual(['merged', 'skipped', 'cancelled']);
    expect(ATTEMPT_STATUSES.filter((s) => isTerminal(ATTEMPT_TRANSITIONS, s))).toEqual([
      'succeeded',
      'failed',
      'cancelled',
    ]);
  });

  it('allows the happy path of a task', () => {
    const path = [
      'blocked',
      'queued',
      'provisioning',
      'running',
      'verifying',
      'reviewing',
      'approved',
      'merging',
      'merged',
    ] as const;
    for (let i = 1; i < path.length; i++) {
      expect(
        canTransition(TASK_TRANSITIONS, path[i - 1] as (typeof path)[number], path[i] as (typeof path)[number]),
      ).toBe(true);
    }
    expect(canTransition(TASK_TRANSITIONS, 'blocked', 'merged')).toBe(false);
  });

  it('every non-terminal run status can be cancelled', () => {
    for (const status of RUN_STATUSES) {
      if (!isTerminal(RUN_TRANSITIONS, status)) expect(RUN_TRANSITIONS[status]).toContain('cancelled');
    }
  });

  it('every non-terminal task status can be cancelled', () => {
    for (const status of TASK_STATUSES) {
      if (!isTerminal(TASK_TRANSITIONS, status)) expect(TASK_TRANSITIONS[status]).toContain('cancelled');
    }
  });
});

describe('settings', () => {
  it('defaults are valid', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('applies deep patches and validates', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      concurrency: { perEngine: { codex: 1 } },
      roles: { reviewer: { models: { claude: 'opus' } } },
    });
    expect(next.concurrency.global).toBe(3);
    expect(next.concurrency.perEngine).toEqual({ claude: 3, codex: 1, fake: 8 });
    expect(next.roles.reviewer).toEqual({
      engine: 'codex',
      models: { claude: 'opus', codex: null },
      effort: null,
      prompt: { append: '', replace: null },
    });
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { concurrency: { global: 0 } })).toThrow();
  });

  it('patches a role prompt one layer at a time', () => {
    const added = applySettingsPatch(DEFAULT_SETTINGS, { roles: { coder: { prompt: { append: 'Run pnpm lint.' } } } });
    expect(added.roles.coder.prompt).toEqual({ append: 'Run pnpm lint.', replace: null });
    const replaced = applySettingsPatch(added, { roles: { coder: { prompt: { replace: 'You write code.' } } } });
    expect(replaced.roles.coder.prompt).toEqual({ append: 'Run pnpm lint.', replace: 'You write code.' });
    expect(
      applySettingsPatch(replaced, { roles: { coder: { prompt: { replace: null } } } }).roles.coder.prompt,
    ).toEqual({ append: 'Run pnpm lint.', replace: null });
  });

  it('gives settings stored before role prompts existed empty ones', () => {
    const stored = { roles: { coder: { engine: 'codex', models: { claude: null, codex: 'gpt-5' }, effort: 'high' } } };
    expect(normalizeSettings(stored).roles.coder).toEqual({
      engine: 'codex',
      models: { claude: null, codex: 'gpt-5' },
      effort: 'high',
      prompt: { append: '', replace: null },
    });
  });

  it('normalizes partial or invalid stored settings', () => {
    expect(normalizeSettings({ budget: { perRunUsd: 5 } }).budget).toEqual({ perRunUsd: 5, warnAtPct: 80 });
    expect(normalizeSettings({ concurrency: { global: 'x' } })).toEqual(DEFAULT_SETTINGS);
  });
});

describe('settings: MCP servers and agent access', () => {
  const linear = { type: 'http' as const, url: 'https://mcp.linear.app/mcp', headers: {} };
  const local = { type: 'stdio' as const, command: 'npx', args: ['-y', 'x'], env: {} };

  it('adds servers and grants them per project and role', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      mcpServers: { linear, local },
      access: { p1: { coder: { mcp: ['linear'], skills: ['zebra'] }, reviewer: { mcp: [], skills: null } } },
    });
    expect(Object.keys(next.mcpServers)).toEqual(['linear', 'local']);
    // A role with nothing granted and the default skills is not stored.
    expect(next.access).toEqual({ p1: { coder: { mcp: ['linear'], skills: ['zebra'] } } });
  });

  it('replaces a role entry and clears it with null', () => {
    const base = applySettingsPatch(DEFAULT_SETTINGS, {
      mcpServers: { linear, local },
      access: { p1: { coder: { mcp: ['linear', 'local'], skills: null } } },
    });
    const replaced = applySettingsPatch(base, { access: { p1: { coder: { mcp: ['local'], skills: null } } } });
    expect(replaced.access.p1?.coder?.mcp).toEqual(['local']);
    const cleared = applySettingsPatch(replaced, { access: { p1: { coder: null } } });
    expect(cleared.access).toEqual({});
  });

  it('removing a server removes its grants', () => {
    const base = applySettingsPatch(DEFAULT_SETTINGS, {
      mcpServers: { linear, local },
      access: {
        p1: { coder: { mcp: ['linear', 'local'], skills: null }, resolver: { mcp: ['linear'], skills: null } },
      },
    });
    const next = applySettingsPatch(base, { mcpServers: { linear: null } });
    expect(Object.keys(next.mcpServers)).toEqual(['local']);
    expect(next.access).toEqual({ p1: { coder: { mcp: ['local'], skills: null } } });
  });

  it('refuses a reserved or malformed server name and a grant of an unknown server', () => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { mcpServers: { legion: linear } })).toThrow();
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { mcpServers: { a__b: linear } })).toThrow();
    const next = applySettingsPatch(DEFAULT_SETTINGS, { access: { p1: { coder: { mcp: ['ghost'], skills: null } } } });
    expect(next.access).toEqual({});
  });

  it('keeps settings stored before these fields existed valid', () => {
    const { mcpServers: _m, access: _a, ...old } = DEFAULT_SETTINGS;
    expect(normalizeSettings(old)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('domain helpers', () => {
  it('reviewPasses requires all criteria met and no blocker/major', () => {
    const met = [{ id: 'AC1', status: 'met' as const, evidence: '' }];
    const finding = (severity: 'blocker' | 'major' | 'minor' | 'nit') => ({
      severity,
      file: null,
      line: null,
      title: 't',
      body: 'b',
      suggestedFix: null,
    });
    expect(reviewPasses({ criteria: met, findings: [finding('minor'), finding('nit')] })).toBe(true);
    expect(reviewPasses({ criteria: met, findings: [finding('major')] })).toBe(false);
    expect(reviewPasses({ criteria: [{ id: 'AC1', status: 'unclear', evidence: '' }], findings: [] })).toBe(false);
  });

  it('inbox items are typed per kind', () => {
    const base = {
      id: 'inb_1',
      runId: 'run_1',
      taskId: null,
      attemptId: null,
      createdAt: 1,
      resolvedAt: null,
      resolution: null,
    };
    expect(InboxItemSchema.safeParse({ ...base, kind: 'budget', payload: { spentUsd: 1, limitUsd: 2 } }).success).toBe(
      true,
    );
    expect(InboxItemSchema.safeParse({ ...base, kind: 'budget', payload: { planId: 'x', version: 1 } }).success).toBe(
      false,
    );
  });

  it('ids', () => {
    const id = newId('run');
    expect(isId('run', id)).toBe(true);
    expect(isId('task', id)).toBe(false);
    expect(runShort(id)).toHaveLength(8);
    expect(slugify('Add OAuth2 login (GitHub & Google)!')).toBe('add-oauth2-login-github-google');
    expect(slugify('***')).toBe('task');
  });
});
