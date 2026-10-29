import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, AccountPool } from '../accounts/index.ts';
import { FakeEngine, type FakeScript } from '../engine/fake/index.ts';
import type { AgentEvent } from '../engine/types.ts';
import { Assistant } from './assistant.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-assistant-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const account = (name: string): Account => ({
  kind: 'claude',
  name,
  dir: null,
  token: null,
  env: {},
  remote: false,
  enabled: true,
  source: 'config',
});

function setup(script: FakeScript) {
  const pool = new AccountPool({ file: join(dir, 'pool.json'), accounts: () => ['a', 'b'].map(account) });
  const engines = new Map<string, FakeEngine>();
  let prefer: string | null = null;
  const assistant = new Assistant({
    cwd: dir,
    engine: () => {
      const picked = pool.acquire('claude', { what: 'assistant', prefer });
      if ('exhausted' in picked) throw new Error('exhausted');
      const name = picked.account.name;
      prefer = name;
      const engine = engines.get(name) ?? new FakeEngine('claude', script, name);
      engines.set(name, engine);
      return engine;
    },
    onLimit: (engine, event) => {
      pool.cooldown('claude', engine.account.name, event.resetsAt ?? Date.now() + 60_000, 'usage limit');
      prefer = null;
      return `account ${engine.account.name} is at its limit`;
    },
    systemPrompt: () => '',
    mcp: {},
  });
  const turn = async (text: string): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    const onEvent = (e: AgentEvent) => events.push(e);
    assistant.on('event', onEvent);
    const done = new Promise<void>((resolve) => {
      assistant.on('event', (e) => {
        if (e.type === 'turn_complete') resolve();
      });
    });
    await assistant.send(text);
    await done;
    assistant.off('event', onEvent);
    return events;
  };
  return { assistant, engines, turn };
}

describe('assistant accounts', () => {
  it('keeps its account across messages', async () => {
    const { assistant, engines, turn } = setup((call) => ({ text: `on ${call.account}` }));
    await turn('one');
    await turn('two');
    expect([...engines.keys()]).toEqual(['a']);
    expect(engines.get('a')?.calls).toHaveLength(1);
    expect(engines.get('a')?.calls[0]?.prompts).toEqual(['one', 'two']);
    await assistant.close();
  });

  it('moves to another account after a limit and starts a new conversation there', async () => {
    const { assistant, engines, turn } = setup((call) =>
      call.account === 'a' ? { limit: { resetsAt: Date.now() + 3_600_000 } } : { text: `on ${call.account}` },
    );
    const first = await turn('one');
    expect(first.some((e) => e.type === 'error' && e.message.includes('at its limit'))).toBe(true);
    await turn('two');
    expect(engines.get('a')?.calls).toHaveLength(1);
    expect(engines.get('b')?.calls).toHaveLength(1);
    expect(engines.get('b')?.calls[0]).toMatchObject({ resumed: false, prompts: ['two'] });
    await assistant.close();
  });
});
