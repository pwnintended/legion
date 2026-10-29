import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeEngine } from './engine/fake/index.ts';
import { type FixtureRepo, makeRepo } from './git/test-helpers.ts';
import { Session } from './session.ts';

let repo: FixtureRepo;
let session: Session | null = null;

beforeEach(async () => {
  repo = await makeRepo({ 'a.txt': 'a\n' });
  process.env.XDG_CONFIG_HOME = join(repo.path, '.xdg');
});

afterEach(async () => {
  await session?.close();
  session = null;
  repo.cleanup();
});

async function resumes(state: Record<string, string>): Promise<void> {
  mkdirSync(join(repo.path, '.legion', 'session'), { recursive: true });
  writeFileSync(join(repo.path, '.legion', 'session', 'state.json'), JSON.stringify({ assistant: state }));
  session = await Session.open({ cwd: repo.path, fake: true, continueLast: true });
  await session.assistant.send('hello again');
  await new Promise((r) => setTimeout(r, 50));
  const engine = session.engine('claude', 'default') as FakeEngine;
  expect(engine.calls[0]).toMatchObject({ resumed: true, sessionId: 's-old' });
}

describe('Session.open --continue', () => {
  it('resumes the saved assistant conversation on its account', () =>
    resumes({ sessionId: 's-old', account: 'default', kind: 'claude' }));

  it('resumes one saved before the account pool (profile = account)', () =>
    resumes({ sessionId: 's-old', profile: 'default', kind: 'claude' }));
});

describe('Session.engineAccount', () => {
  it('picks up an oauth-token added to an existing directory account after the engine was cached', async () => {
    const home = join(repo.path, 'home');
    const dir = join(home, 'accounts', 'claude', 'work');
    mkdirSync(dir, { recursive: true });
    session = await Session.open({ cwd: repo.path, fake: true, legionHome: home });
    const [account] = session.listAccounts('claude');
    if (!account) throw new Error('no account discovered');
    const cached = session.engineAccount(account);
    expect(cached.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    writeFileSync(join(dir, 'oauth-token'), 'tok\n');
    expect(cached.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });
});
