import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rpcContract } from './rpc';

const REQUIRED = [
  'app.info',
  'engines.list',
  'engines.probe',
  'settings.get',
  'settings.set',
  'repos.inspect',
  'repos.recent',
  'repos.discover',
  'repos.branches',
  'runs.list',
  'runs.get',
  'runs.create',
  'runs.answerClarify',
  'runs.updatePlan',
  'runs.approvePlan',
  'runs.requestPlanRevision',
  'runs.pause',
  'runs.resume',
  'runs.cancel',
  'runs.createPr',
  'tasks.retry',
  'tasks.skip',
  'tasks.approveMerge',
  'tasks.requestChanges',
  'inbox.list',
  'inbox.resolve',
  'sessions.send',
  'sessions.interrupt',
  'sessions.takeover',
  'attempts.transcript',
  'diff.get',
  'terminals.open',
  'terminals.resize',
  'terminals.close',
  'subscribe',
];

describe('rpc contract', () => {
  it('covers every procedure the UI needs', () => {
    expect(Object.keys(rpcContract)).toEqual(expect.arrayContaining(REQUIRED));
  });

  it('every procedure has object input and a zod output', () => {
    for (const [name, procedure] of Object.entries(rpcContract)) {
      expect(procedure.input, name).toBeInstanceOf(z.ZodObject);
      expect(procedure.output, name).toBeInstanceOf(z.ZodType);
    }
  });

  it('inputs reject unknown shapes', () => {
    expect(rpcContract['runs.get'].input.safeParse({}).success).toBe(false);
    expect(rpcContract['runs.get'].input.safeParse({ runId: 'run_x' }).success).toBe(true);
    expect(rpcContract.subscribe.input.safeParse({ sinceSeq: -1 }).success).toBe(false);
  });
});
