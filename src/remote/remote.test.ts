import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteConfig } from '../config.ts';
import { FakeEngine } from '../engine/fake/index.ts';
import { type AgentEvent, permissionProfile } from '../engine/types.ts';
import { type FixtureRepo, makeRepo, writeFiles } from '../git/test-helpers.ts';
import type { RunHost } from '../workflow/host.ts';
import { runShell } from '../workflow/shell.ts';
import { readImage } from './image.ts';
import { boxName, type Need, REMOTE_PROFILE_SUFFIX, Remote, runLabel } from './remote.ts';
import { type LocalBox, LocalBoxes } from './testing.ts';

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
  config = { enabled: true, size: 'medium', runtime: 'node', setup: [] };
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
    expect(host.engine('claude').profile.name).not.toContain(REMOTE_PROFILE_SUFFIX);
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
    const engine = host.engine('claude');
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

    expect(engine.profile.name).toMatch(new RegExp(`${REMOTE_PROFILE_SUFFIX}$`));
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
  require('node:child_process').execFileSync('legion-need', ['ffmpeg 7', 'capture videos']);
  for (const line of lines) if (line.dir === 'out') process.stdout.write(JSON.stringify(line.msg) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(script, 0o755);
}
