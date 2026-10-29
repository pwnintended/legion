import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, AccountPool, boxEnv } from '../accounts/index.ts';
import type { RemoteConfig } from '../config.ts';
import { FakeEngine } from '../engine/fake/index.ts';
import { type AgentEvent, permissionProfile } from '../engine/types.ts';
import { type FixtureRepo, makeRepo, writeFiles } from '../git/test-helpers.ts';
import type { RunHost } from '../workflow/host.ts';
import { Journal } from '../workflow/journal.ts';
import { agent, executeInRun } from '../workflow/runtime.ts';
import { runShell } from '../workflow/shell.ts';
import { exec } from './box.ts';
import { readImage } from './image.ts';
import { boxName, type Need, Remote, runLabel } from './remote.ts';
import { type LocalBox, LocalBoxes } from './testing.ts';
import { LAUNCHER } from './workspace.ts';

const RUN = '20261029-0007-ab12';

let repo: FixtureRepo;
let root: string;
let wt: string;
let boxes: LocalBoxes;
let enabled: boolean;
let config: RemoteConfig;
let remote: Remote;
let host: RunHost;
let localShells: string[];
let base: RunHost;
let needs: Need[];
let notes: string[];

beforeEach(async () => {
  repo = await makeRepo({ 'a.txt': 'a\n', '.gitignore': 'target/\n' });
  root = join(repo.scratch, 'worktrees');
  wt = join(root, RUN, 'task');
  await repo.git('worktree', 'add', '-q', '-b', 'task', wt);
  boxes = new LocalBoxes(join(repo.scratch, 'boxes'), [root]);
  enabled = true;
  config = { enabled: true, size: 'medium', ttlHours: 24, runtime: 'node', setup: [] };
  needs = [];
  notes = [];
  remote = new Remote({
    repo: repo.path,
    worktreeRoot: root,
    config: () => config,
    enabled: () => enabled,
    provider: () => boxes,
    onNeed: (need) => needs.push(need),
    notify: (text) => notes.push(text),
  });
  localShells = [];
  base = {
    repo: repo.path,
    dryRun: false,
    engine: () => new FakeEngine(),
    sh: (command: string, opts: Parameters<RunHost['sh']>[1]) => {
      localShells.push(command);
      return runShell(command, opts);
    },
  } as unknown as RunHost;
  host = remote.host(base, { id: RUN, workflow: 'test' });
});

afterEach(() => repo.cleanup());

const theBox = (): LocalBox => {
  const box = [...boxes.boxes.values()][0];
  if (!box) throw new Error('no box');
  return box;
};
const read = (path: string) => readFileSync(path, 'utf8');

describe('remote mode', () => {
  it('runs a worktree step in the box, with the uncommitted state, and brings its changes back', async () => {
    writeFileSync(join(wt, 'a.txt'), 'changed\n');
    writeFiles(wt, { 'b.txt': 'untracked\n', 'target/cache.bin': 'ignored\n' });

    const r = await host.sh(
      'cat a.txt b.txt && echo made > c.txt && rm b.txt && mkdir -p target && echo box > target/x',
      {
        cwd: wt,
      },
    );

    expect(r).toMatchObject({ code: 0, stdout: 'changed\nuntracked\n' });
    expect(localShells).toEqual([]);
    const box = theBox();
    expect(box.id).toBe(boxName(RUN, wt));
    expect(box.labels).toContain(runLabel(RUN));
    // Ignored files stay on their side: the local cache never went up, the box's never comes down.
    expect(existsSync(box.path(join(wt, 'target', 'cache.bin')))).toBe(false);
    expect(read(join(wt, 'target', 'cache.bin'))).toBe('ignored\n');
    expect(existsSync(join(wt, 'target', 'x'))).toBe(false);
    expect(read(join(wt, 'c.txt'))).toBe('made\n');
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
    expect(read(join(wt, 'a.txt'))).toBe('changed\n');
  });

  it('gives the box commits made here between steps, without redoing what came back', async () => {
    await host.sh('echo one > one.txt', { cwd: wt });
    await repo.git('-C', wt, 'add', '-A');
    await repo.git('-C', wt, 'commit', '-q', '-m', 'step one');
    const head = await repo.git('-C', wt, 'rev-parse', 'HEAD');

    const r = await host.sh('git rev-parse HEAD && git rev-parse --abbrev-ref HEAD && git status --porcelain', {
      cwd: wt,
    });

    expect(r.stdout).toBe(`${head}\ntask\n`);
    expect(await repo.git('-C', wt, 'status', '--porcelain')).toBe('');
  });

  it('keeps changes the box made since the last sync when the next step pushes', async () => {
    await host.sh('true', { cwd: wt });
    // Another step still running in the box wrote this; meanwhile a change was made here.
    writeFileSync(theBox().path(join(wt, 'from-box.txt')), 'box\n');
    writeFileSync(join(wt, 'from-here.txt'), 'here\n');

    const r = await host.sh('cat from-box.txt from-here.txt', { cwd: wt });

    expect(r.stdout).toBe('box\nhere\n');
    expect(read(join(wt, 'from-box.txt'))).toBe('box\n');
  });

  it('runs steps outside the run worktrees, and everything when it is off, on this machine', async () => {
    await host.sh('true', { cwd: repo.path });
    enabled = false;
    await host.sh('echo local > local.txt', { cwd: wt });

    expect(localShells).toEqual(['true', 'echo local > local.txt']);
    expect(boxes.boxes.size).toBe(0);
    expect(host.where?.(repo.path)).toBe('local');
  });

  it('runs `setup` once in a new box, with the prelude before every command', async () => {
    config = { ...config, setup: ['echo "$GREETING" > setup.log'], prelude: 'export GREETING=hello' };

    await host.sh('echo "$GREETING" > step.log', { cwd: wt });
    await host.sh('cat setup.log >> step.log', { cwd: wt });

    expect(read(join(wt, 'step.log'))).toBe('hello\nhello\n');
    // setup.log came back with the first step's pull, as a file the box made.
    expect(read(join(wt, 'setup.log'))).toBe('hello\n');
  });

  it('starts a warm clone from the snapshot as the worktree', async () => {
    const box = (await boxes.open(boxName(RUN, wt), ['legion', runLabel(RUN)], null)).box;
    const clone = join(root, 'warm');
    await repo.git('clone', '-q', repo.path, box.path(clone));
    mkdirSync(box.path(join(clone, 'target')), { recursive: true });
    writeFileSync(box.path(join(clone, 'target', 'build.cache')), 'warm\n');
    config = { ...config, clone };
    writeFileSync(join(wt, 'a.txt'), 'local\n');

    const r = await host.sh('cat a.txt target/build.cache', { cwd: wt });

    expect(r.stdout).toBe('local\nwarm\n');
    expect(existsSync(box.path(clone))).toBe(false);
  });

  it('deletes the boxes of a run that ended', async () => {
    await host.sh('true', { cwd: wt });
    await remote.release(RUN);
    expect(boxes.removed).toEqual([boxName(RUN, wt)]);
  });

  it('runs an agent in the box and has its edits here once the session is closed', async () => {
    const box = (await boxes.open(boxName(RUN, wt), ['legion', runLabel(RUN)], null)).box;
    installFakeClaude(box);
    const engine = host.engine('claude', 'default');
    const step = 'T1/code';

    const session = await engine.start({
      cwd: wt,
      prompt: 'Write agent.txt',
      permission: permissionProfile('workspace_write', { approvals: 'ask' }),
    });
    host.agentSession?.(step, session);
    const events: AgentEvent[] = [];
    for await (const event of session.events) {
      events.push(event);
      if (event.type === 'turn_complete') break;
    }
    await session.close();

    expect(host.where?.(wt)).toBe('box');
    expect(events.some((e) => e.type === 'message' && e.text === 'OK')).toBe(true);
    expect(read(join(wt, 'agent.txt'))).toBe('from the box\n');
    const argv = box.started.find((a) => a.includes('claude'));
    expect(argv?.slice(0, 2)).toEqual(['bash', '-c']);
    // Told to ask rather than install, and its request reached the assistant's side with its step.
    expect(argv?.some((a) => a.includes('legion-need'))).toBe(true);
    expect(needs).toMatchObject([{ what: 'ffmpeg 7', why: 'capture videos', runId: RUN, step }]);
    expect(remote.pendingNeeds()).toHaveLength(1);
  });
});

describe('accounts in boxes', () => {
  const SECRET = 'sk-ant-oat01-SECRET-SENTINEL';
  const acct = (over: Partial<Account>): Account => ({
    kind: 'claude',
    name: 'work',
    dir: null,
    token: null,
    env: {},
    remote: true,
    enabled: true,
    source: 'config',
    ...over,
  });
  let logs: string[];
  let picked: { kind: string; req: unknown }[];

  function withAccounts(list: Account[]): RunHost {
    logs = [];
    picked = [];
    const log = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const r = new Remote({
      repo: repo.path,
      worktreeRoot: root,
      config: () => config,
      enabled: () => enabled,
      provider: () => boxes,
      accounts: (kind) => list.filter((a) => a.kind === kind),
      log,
    });
    return r.host(
      {
        ...base,
        account: (kind: string, req: unknown) => {
          picked.push({ kind, req });
          const a = list.find((x) => x.kind === kind && x.enabled && x.remote);
          return a ? { account: a } : { exhausted: true, earliestReset: null };
        },
      } as unknown as RunHost,
      { id: RUN, workflow: 'test' },
    );
  }

  async function runClaude(h: RunHost, account: string, box: LocalBox): Promise<void> {
    installFakeClaude(box);
    const session = await h.engine('claude', account).start({
      cwd: wt,
      prompt: 'go',
      permission: permissionProfile('workspace_write', { approvals: 'ask' }),
    });
    for await (const event of session.events) if (event.type === 'turn_complete') break;
    await session.close();
  }

  it("starts a Claude token account's box session with its token, which no log shows", async () => {
    const tokenFile = join(repo.scratch, 'oauth-token');
    writeFileSync(tokenFile, `${SECRET}\n`);
    const h = withAccounts([acct({ token: { file: tokenFile } })]);
    const box = (await boxes.open(boxName(RUN, wt), ['legion', runLabel(RUN)], null)).box;

    const got = h.account('claude', { what: 's', where: 'box' });
    expect(got).toMatchObject({ account: { name: 'work' } });
    await runClaude(h, 'work', box);

    expect(read(join(box.home, 'seen-token'))).toBe(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(box.started.map((a) => a))).not.toContain(SECRET);
  });

  it('uses the implicit `box` account, with no auth env, when no account can go to a box', async () => {
    const h = withAccounts([acct({ remote: false })]);
    const box = (await boxes.open(boxName(RUN, wt), ['legion', runLabel(RUN)], null)).box;

    await runClaude(h, 'box', box);

    expect(read(join(box.home, 'seen-token'))).toBe('none');
    expect(host.engine('claude', 'box').account.name).toBe('box');
  });

  it('leaves steps outside boxes to the pool', () => {
    const h = withAccounts([acct({ remote: false })]);
    h.account('claude', { what: 's', where: 'local' });
    expect(picked).toHaveLength(1);
  });

  it("passes a Codex remote account's auth.json and name, never its local home", () => {
    const dir = join(repo.scratch, 'codex-p');
    mkdirSync(dir);
    writeFileSync(join(dir, 'auth.json'), '{"tokens":"X"}');
    const env = boxEnv(acct({ kind: 'codex', name: 'personal', dir }));

    expect(env.LEGION_CODEX_ACCOUNT).toBe('personal');
    expect(gunzipSync(Buffer.from(env.CODEX_AUTH_GZIP_B64 as string, 'base64')).toString()).toBe('{"tokens":"X"}');
    expect(env.CODEX_HOME).toBeUndefined();
    expect(() => boxEnv(acct({ kind: 'codex', name: '../x', dir }))).toThrow(/cannot be used in a box/);
  });

  describe('workflow steps through Remote', () => {
    const TOKEN = 'sk-ant-oat01-FLOW-SENTINEL';
    const AUTH = 'AUTH-JSON-SENTINEL';
    let jdir: string;
    let events: unknown[];
    let clock: number;
    let pool: AccountPool;
    let h: RunHost;
    let list: Account[];
    let box: LocalBox;

    async function setup(accounts: Account[]): Promise<void> {
      list = accounts;
      jdir = join(repo.scratch, 'journal');
      mkdirSync(jdir, { recursive: true });
      events = [];
      clock = 1_000_000;
      pool = new AccountPool({
        file: join(repo.scratch, 'pool.json'),
        accounts: (kind) => list.filter((a) => a.kind === kind),
        now: () => clock,
      });
      const r = new Remote({
        repo: repo.path,
        worktreeRoot: root,
        config: () => config,
        enabled: () => enabled,
        provider: () => boxes,
        accounts: (kind) => list.filter((a) => a.kind === kind),
        log: {
          info: (m: string) => events.push(m),
          warn: (m: string) => events.push(m),
          error: (m: string) => events.push(m),
        },
      });
      h = r.host(
        {
          ...base,
          maxAgents: 2,
          approvals: 'ask',
          emit: (e: unknown) => events.push(e),
          account: (kind: 'claude' | 'codex', req: Parameters<AccountPool['acquire']>[1]) => pool.acquire(kind, req),
          cooldown: (kind: 'claude' | 'codex', name: string, until: number, reason: string) =>
            pool.cooldown(kind, name, until, reason),
        } as unknown as RunHost,
        { id: RUN, workflow: 'test' },
      );
      box = (await boxes.open(boxName(RUN, wt), ['legion', runLabel(RUN)], null)).box;
      installFakeClaude(box);
    }

    const step = (key: string, extra: Record<string, unknown> = {}) =>
      executeInRun({ runId: 'r1', host: h, journal: new Journal(jdir), signal: new AbortController().signal }, () =>
        agent(key, { prompt: 'go', cwd: wt, ...extra }),
      );
    const argvLog = (): string[][] =>
      read(join(box.home, 'claude-argv.log'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
    const everything = () => JSON.stringify(events) + read(join(jdir, 'journal.jsonl'));
    const tokenAccount = (name: string): Account => {
      const file = join(repo.scratch, `${name}-token`);
      writeFileSync(file, `${TOKEN}-${name}\n`);
      return acct({ name, token: { file } });
    };

    it('journals the account and place, never the token, and resumes only on the same account in the box', async () => {
      await setup([tokenAccount('work'), tokenAccount('other')]);

      await step('a');
      const meta = new Journal(jdir).get('a')?.meta as Record<string, unknown>;
      expect(meta).toMatchObject({ engine: 'claude', account: 'work', where: 'box' });
      expect(read(join(box.home, 'seen-token'))).toBe(`${TOKEN}-work`);
      expect(everything()).not.toContain(TOKEN);
      const id = String(meta.sessionId);
      const seed = (key: string, over: Record<string, unknown>) =>
        new Journal(jdir).append({
          key,
          kind: 'agent',
          status: 'started',
          ts: 1,
          meta: { sessionId: id, engine: 'claude', account: 'work', where: 'box', ...over },
        });

      seed('same', {});
      await step('same');
      const last = () => argvLog().at(-1) as string[];
      expect(last()).toContain('--resume');
      expect(last()).toContain(id);

      seed('moved-account', { account: 'gone' });
      await step('moved-account');
      expect(last()).not.toContain('--resume');

      seed('moved-place', { where: 'local' });
      await step('moved-place');
      expect(last()).not.toContain('--resume');
      expect(everything()).not.toContain(TOKEN);
    });

    it('starts a Codex remote account with its auth.json in a per-account home, and journals none of it', async () => {
      const dir = join(repo.scratch, 'codex-home');
      mkdirSync(dir);
      writeFileSync(join(dir, 'auth.json'), AUTH);
      await setup([acct({ kind: 'codex', name: 'personal', dir })]);
      const bin = join(box.home, '.legion', 'cli', 'bin', 'codex');
      writeFileSync(
        bin,
        `#!/usr/bin/env node
const fs = require('node:fs');
const home = process.env.CODEX_HOME;
fs.writeFileSync(process.env.HOME + '/codex-seen', JSON.stringify({ home, auth: fs.readFileSync(home + '/auth.json', 'utf8'), b64: process.env.CODEX_AUTH_GZIP_B64 || null, name: process.env.LEGION_CODEX_ACCOUNT || null }));
process.exit(1);
`,
      );
      chmodSync(bin, 0o755);

      await step('c', { engine: 'codex' }).catch(() => undefined);

      const seen = JSON.parse(read(join(box.home, 'codex-seen')));
      expect(seen).toEqual({ home: `${box.home}/.legion/codex-home/personal`, auth: AUTH, b64: null, name: null });
      expect(everything()).not.toContain(AUTH);
      expect(everything()).not.toContain(gzipSync(AUTH).toString('base64'));
    }, 30_000);

    it('treats the implicit `box` account like any other: a limited one is not picked again until it recovers', async () => {
      await setup([acct({ remote: false })]);
      const ask = () => h.account('claude', { what: 's', where: 'box' });

      expect(ask()).toMatchObject({ account: { name: 'box' } });
      h.cooldown('claude', 'box', clock + 60_000, 'usage limit');
      expect(ask()).toEqual({ exhausted: true, earliestReset: clock + 60_000 });
      expect(h.account('claude', { what: 's', where: 'box', prefer: 'box' })).toMatchObject({ exhausted: true });
      clock += 61_000;
      expect(ask()).toMatchObject({ account: { name: 'box' } });
      expect(h.account('claude', { what: 's', where: 'box', avoid: ['box'] })).toMatchObject({ exhausted: true });
    });
  });

  describe('the launcher', () => {
    const launch = async (env: Record<string, string>, script: string) => {
      const box = (await boxes.open('launcher-box', ['legion'], null)).box;
      const r = await exec(box, ['bash', '-c', LAUNCHER, 'legion', repo.path, 'sh', '-c', script], { env });
      return { box, r };
    };
    const payload = (text: string) => gzipSync(text).toString('base64');

    it('gives each account its own CODEX_HOME, seeded once, and unsets the variables', async () => {
      const show = [
        'echo "$CODEX_HOME"',
        'cat "$CODEX_HOME/auth.json"',
        'echo "[$CODEX_AUTH_GZIP_B64$LEGION_CODEX_ACCOUNT]"',
      ].join('; ');
      const a = await launch({ CODEX_AUTH_GZIP_B64: payload('A'), LEGION_CODEX_ACCOUNT: 'acc-1' }, show);
      expect(a.r.stdout).toBe(`${a.box.home}/.legion/codex-home/acc-1\nA[]\n`);
      const b = await launch({ CODEX_AUTH_GZIP_B64: payload('B'), LEGION_CODEX_ACCOUNT: 'acc-2' }, show);
      expect(b.r.stdout).toContain('/codex-home/acc-2\nB[]');
      // Seeded once: the CLI's refreshed file is not overwritten.
      const again = await launch({ CODEX_AUTH_GZIP_B64: payload('NEW'), LEGION_CODEX_ACCOUNT: 'acc-1' }, show);
      expect(again.r.stdout).toContain('acc-1\nA[]');
    });

    it('keeps the box-wide home without an account, and refuses a bad name', async () => {
      const plain = await launch({}, 'echo "$CODEX_HOME"');
      expect(plain.r.stdout).toBe(`${plain.box.home}/.legion/codex-home\n`);
      const bad = await launch({ LEGION_CODEX_ACCOUNT: '../evil' }, 'echo ran');
      expect(bad.r.code).toBe(2);
      expect(bad.r.stdout).toBe('');
      const dots = await launch({ LEGION_CODEX_ACCOUNT: '..' }, 'echo ran');
      expect(dots.r.code).toBe(2);
    });
  });
});

describe('the box image', () => {
  const BOX_RUN = '20261029-0100-box1';
  let boxWt: string;
  let boxHost: RunHost;

  beforeEach(async () => {
    boxWt = join(root, BOX_RUN, 'box');
    await repo.git('worktree', 'add', '-q', '-b', 'box', boxWt);
    boxHost = remote.host(base, { id: BOX_RUN, workflow: 'box' });
  });

  /** What the box agent does: write the box files, run them, and have Legion save its box as the image. */
  async function makeImage(provision: string, env: string): Promise<string> {
    await boxHost.box?.prepare(boxWt);
    writeFiles(boxWt, { '.legion/box/provision.sh': provision, '.legion/box/env.sh': env });
    const r = await boxHost.sh('bash .legion/box/provision.sh', { cwd: boxWt });
    expect(r.code).toBe(0);
    const image = await boxHost.box?.snapshot(boxWt, { requests: ['greeting'], summary: 'greets' });
    return image?.snapshot ?? '';
  }

  it("runs the box agent's steps in a box even when remote mode is off, and makes boxes start from its image", async () => {
    enabled = false;
    const snapshot = await makeImage('touch "$HOME/provisioned"\n', 'export GREETING=from-env\n');
    enabled = true;

    expect(localShells).toEqual([]);
    expect(readImage(repo.path)).toMatchObject({ snapshot, clone: boxWt, requests: ['greeting'] });
    // The box files land in the user's checkout, to be committed.
    expect(read(join(repo.path, '.legion', 'box', 'env.sh'))).toBe('export GREETING=from-env\n');

    const r = await host.sh('echo "$GREETING" && test -f "$HOME/provisioned" && echo provisioned', { cwd: wt });

    expect(r.stdout).toBe('from-env\nprovisioned\n');
    expect(boxes.madeFrom.get(boxName(RUN, wt))).toBe(snapshot);
    expect(notes).toEqual([]);
  });

  it('brings a box made before the image up to it before its next step', async () => {
    await host.sh('true', { cwd: wt });
    expect(notes[0]).toMatch(/no box image/);
    await makeImage('echo run >> "$HOME/provision.log"\n', 'export GREETING=upgraded\n');

    const r = await host.sh('echo "$GREETING" && cat "$HOME/provision.log"', { cwd: wt });

    expect(r.stdout).toBe('upgraded\nrun\n');
  });

  it("gives the box agent the checkout's box files and replaces its old image", async () => {
    writeFiles(repo.path, { '.legion/box/provision.sh': 'echo from the checkout\n' });
    await boxHost.box?.prepare(boxWt);
    expect(read(join(boxWt, '.legion', 'box', 'provision.sh'))).toBe('echo from the checkout\n');

    const first = await makeImage('true\n', '\n');
    const second = await makeImage('true\n', 'export X=1\n');

    expect(second).not.toBe(first);
    expect(boxes.deletedSnapshots).toEqual([first]);
  });
});

/**
 * A `claude` on the box's PATH that writes a file, then plays the recorded `plain.jsonl` transcript's output and
 * exits when stdin ends.
 */
function installFakeClaude(box: LocalBox): void {
  const fixture = join(import.meta.dirname, '..', 'engine', 'claude', 'fixtures', 'plain.jsonl');
  const bin = join(box.home, '.legion', 'cli', 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'claude');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs');
const lines = fs.readFileSync(${JSON.stringify(fixture)}, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
let started = false;
process.stdin.on('data', () => {
  if (started) return;
  started = true;
  fs.writeFileSync('agent.txt', 'from the box\\n');
  fs.appendFileSync(process.env.HOME + '/claude-argv.log', JSON.stringify(process.argv.slice(2)) + '\\n');
  fs.writeFileSync(process.env.HOME + '/seen-token', process.env.CLAUDE_CODE_OAUTH_TOKEN || 'none');
  require('node:child_process').execFileSync('legion-need', ['ffmpeg 7', 'capture videos']);
  for (const line of lines) if (line.dir === 'out') process.stdout.write(JSON.stringify(line.msg) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(script, 0o755);
}
