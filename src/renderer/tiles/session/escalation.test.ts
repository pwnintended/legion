import type { InboxItemOf } from '@shared/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { answerConfirm, confirmStore } from '../../app/confirm';
import { initialData } from '../../app/data';
import { dataStore } from '../../app/store';
import { connectStore, type EngineClient } from '../../app/sync';
import { canStartOver, retryChoice, startOver } from './escalation';

const calls: { method: string; input: unknown }[] = [];
const client: EngineClient = {
  getState: () => ({ status: 'connecting', generation: 0 }),
  seq: 0,
  onStatus: () => () => {},
  onEvents: () => () => {},
  onReset: () => () => {},
  call: (async (method: string, input: unknown) => {
    calls.push({ method, input });
    return {};
  }) as EngineClient['call'],
};
const sync = connectStore(client);
afterAll(() => sync.stop());

const escalation = (patch: Partial<InboxItemOf<'escalation'>['payload']> = {}): InboxItemOf<'escalation'> => ({
  id: 'inb_1',
  runId: 'run_a',
  taskId: 'task_1',
  attemptId: null,
  createdAt: 1,
  resolvedAt: null,
  kind: 'escalation',
  payload: { reason: 'attempts_exhausted', summary: 'stuck', actions: ['retry', 'edit', 'skip', 'abort'], ...patch },
  resolution: null,
});

beforeEach(() => {
  calls.length = 0;
  dataStore.setState(initialData(), true);
});

describe('escalation choices', () => {
  it('labels Retry by what it resumes and offers Start over wherever Retry is', () => {
    expect(retryChoice(escalation({ resume: 'review' })).label).toBe('Retry review');
    expect(retryChoice(escalation({ resume: 'code' })).label).toBe('Resume coding');
    expect(retryChoice(escalation()).label).toBe('Retry');
    expect(canStartOver(escalation())).toBe(true);
    expect(canStartOver(escalation({ actions: ['skip', 'abort'] }))).toBe(false);
    expect(canStartOver({ ...escalation(), taskId: null })).toBe(false);
  });

  it('starts over only after an explicit confirm, as a `restart` resolution', async () => {
    const item = escalation();
    const declined = startOver(item, 'T2');
    expect(confirmStore.getState().request?.confirmLabel).toBe('Start over');
    answerConfirm(false);
    await expect(declined).resolves.toBe(false);
    expect(calls).toEqual([]);

    const accepted = startOver(item, 'T2');
    answerConfirm(true);
    // The item resolves in the store (the inbox.updated event).
    queueMicrotask(() => dataStore.setState((s) => ({ inbox: { ...s.inbox, [item.id]: { ...item, resolvedAt: 2 } } })));
    await expect(accepted).resolves.toBe(true);
    expect(calls).toEqual([
      {
        method: 'inbox.resolve',
        input: { itemId: 'inb_1', resolution: { kind: 'escalation', action: 'restart', note: null } },
      },
    ]);
  });
});
