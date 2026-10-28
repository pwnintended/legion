/**
 * Live test against real Upstash Boxes, excluded from the default run: `LEGION_LIVE=1 pnpm test:live src/remote`.
 * The API key comes from `UPSTASH_BOX_API_KEY` or `[remote] apiKey` in the user config. It makes one small box
 * (no snapshot), syncs a worktree into it and back, and deletes it. `LEGION_LIVE_REMOTE_AGENT=1` also runs one tiny
 * Claude turn there (the box needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the account env).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type RemoteConfig } from '../config.ts';
import { FakeEngine } from '../engine/fake/index.ts';
import { permissionProfile } from '../engine/types.ts';
import { type FixtureRepo, makeRepo } from '../git/test-helpers.ts';
import type { RunHost } from '../workflow/host.ts';
import { runShell } from '../workflow/shell.ts';
import { UpstashBoxes } from './box.ts';
import { Remote } from './remote.ts';

const LIVE = process.env.LEGION_LIVE === '1';
const RUN = `live-${Date.now().toString(36)}`;

describe.skipIf(!LIVE)('Upstash Boxes (live)', () => {
  let repo: FixtureRepo;
  let wt: string;
  let remote: Remote;
  let host: RunHost;

  beforeAll(async () => {
    const user = loadConfig(process.cwd()).remote;
    const key = process.env.UPSTASH_BOX_API_KEY || user.apiKey;
    if (!key) throw new Error('no Upstash Box API key (UPSTASH_BOX_API_KEY or [remote] apiKey in the user config)');
    const config: RemoteConfig = { enabled: true, size: 'small', runtime: 'node', setup: [] };
    repo = await makeRepo({ 'a.txt': 'a\n', '.gitignore': 'target/\n' });
    const root = join(repo.scratch, 'worktrees');
    wt = join(root, RUN, 'task');
    await repo.git('worktree', 'add', '-q', '-b', 'task', wt);
    const provider = new UpstashBoxes(() => config, key);
    remote = new Remote({
      repo: repo.path,
      worktreeRoot: root,
      config: () => config,
      enabled: () => true,
      provider: () => provider,
    });
    const base = { repo: repo.path, dryRun: false, engine: () => new FakeEngine(), sh: runShell };
    host = remote.host(base as unknown as RunHost, { id: RUN, workflow: 'test' });
  });

  afterAll(async () => {
    await remote?.release(RUN);
    repo?.cleanup();
  });

  it('syncs a worktree into a box and back', async () => {
    writeFileSync(join(wt, 'a.txt'), 'changed\n');
    writeFileSync(join(wt, 'b.txt'), 'untracked\n');

    const r = await host.sh('uname -s && cat a.txt b.txt && echo box > c.txt && rm b.txt', { cwd: wt });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Linux\nchanged\nuntracked\n');
    expect(readFileSync(join(wt, 'c.txt'), 'utf8')).toBe('box\n');
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
  });

  it.skipIf(process.env.LEGION_LIVE_REMOTE_AGENT !== '1')('runs a Claude turn in the box', async () => {
    const session = await host.engine('claude').start({
      cwd: wt,
      prompt: 'Create the file hello.txt containing exactly the word hi, then reply with just: OK',
      model: 'haiku',
      permission: permissionProfile('workspace_write', { approvals: 'ask', allowedCommands: [] }),
    });
    for await (const event of session.events) if (event.type === 'turn_complete') break;
    await session.close();

    expect(readFileSync(join(wt, 'hello.txt'), 'utf8').trim()).toBe('hi');
  });
});
