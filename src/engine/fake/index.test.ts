import { expect, it } from 'vitest';
import { type AgentEvent, permissionProfile } from '../types.ts';
import { FakeEngine } from './index.ts';

it('isolates ordered scripted subagents from parent text and structured output across turns', async () => {
  const engine = new FakeEngine('fake', () => ({
    text: 'Parent reply',
    output: { answer: 42 },
    subagents: [
      { type: 'Explore', description: 'Find files', text: 'Child reply' },
      { description: 'Check', ok: false },
    ],
  }));
  const session = await engine.start({
    cwd: '.',
    prompt: 'Go',
    permission: permissionProfile('read_only'),
    outputSchema: { type: 'object' },
  });
  const ids: string[] = [];
  const iterator = session.events[Symbol.asyncIterator]();
  try {
    for (let turn = 0; turn < 2; turn++) {
      if (turn) await session.send('Again');
      const events: AgentEvent[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error('Session ended before turn completion');
        const event = next.value;
        if (event.type !== 'session_started') events.push(event);
        if (event.type === 'turn_complete') break;
      }
      expect(events.map((e) => e.type)).toEqual([
        'subagent_started',
        'subagent_event',
        'subagent_done',
        'subagent_started',
        'subagent_event',
        'subagent_done',
        'message',
        'usage',
        'turn_complete',
      ]);
      for (const [offset, text, ok] of [
        [0, 'Child reply', true],
        [3, '', false],
      ] as const) {
        const start = events[offset];
        expect(start).toMatchObject({ type: 'subagent_started', parent: null, prompt: null });
        if (start?.type !== 'subagent_started') throw new Error('Missing subagent');
        ids.push(start.id);
        expect(events[offset + 1]).toEqual({ type: 'subagent_event', id: start.id, event: { type: 'message', text } });
        expect(events[offset + 2]).toEqual({ type: 'subagent_done', id: start.id, ok, result: text });
      }
      expect(events[6]).toEqual({ type: 'message', text: 'Parent reply' });
      expect(events[8]).toEqual({
        type: 'turn_complete',
        structuredOutput: { answer: 42 },
        isError: false,
        reason: null,
      });
    }
    expect(new Set(ids).size).toBe(4);
  } finally {
    await session.close();
  }
});
