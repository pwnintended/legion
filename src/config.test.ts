import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  configLayers,
  defaultProjectConfig,
  ensureProjectConfig,
  loadConfig,
  resolveAgentModel,
} from './config.ts';

let root: string;
let xdg: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'legion-config-')));
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
});

afterEach(() => {
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

describe('config layers', () => {
  it('applies user, parent, project, subdirectory and local files in that order', () => {
    const repo = join(root, 'work', 'repo');
    const sub = join(repo, 'pkg');
    mkdirSync(sub, { recursive: true });
    write(join(root, 'xdg', 'legion', 'config.toml'), '[workflows]\nmaxAgents = 2\napprovals = "auto"\n');
    write(join(root, 'work', '.legion', 'config.toml'), '[workflows]\nmaxAgents = 3\n[assistant]\nmodel = "a"\n');
    write(join(repo, '.legion', 'config.toml'), '[assistant]\nmodel = "b"\n');
    write(join(sub, '.legion', 'config.toml'), '[assistant]\neffort = "low"\n');
    write(join(repo, '.legion', 'config.local.toml'), '[workflows]\nmaxAgents = 5\n');

    const layers = configLayers(repo, sub);
    expect(layers.map((l) => [l.scope, l.exists])).toEqual([
      ['user', true],
      ['parent', true],
      ['project', true],
      ['parent', true],
      ['local', true],
    ]);
    const config = loadConfig(repo, sub);
    expect(config.workflows).toEqual({ maxAgents: 5, approvals: 'auto' });
    expect(config.assistant).toMatchObject({ model: 'b', effort: 'low' });
  });

  it('lists the project file even when it does not exist yet', () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    expect(configLayers(repo).map((l) => [l.scope, l.exists])).toEqual([
      ['user', false],
      ['project', false],
      ['local', false],
    ]);
  });
});

describe('ensureProjectConfig', () => {
  it('writes a default with the settings in effect when there is no project config', () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    write(join(root, 'xdg', 'legion', 'config.toml'), '[workflows]\napprovals = "auto"\n[assistant]\nmodel = "opus"\n');
    const before = loadConfig(repo);
    const file = ensureProjectConfig(repo, repo, before);
    expect(file).toBe(join(repo, '.legion', 'config.toml'));
    expect(loadConfig(repo)).toEqual(before);
    expect(readFileSync(file as string, 'utf8')).toContain('approvals = "auto"');
    // Idempotent.
    expect(ensureProjectConfig(repo, repo, before)).toBeNull();
  });

  it('leaves things alone when a parent directory has a config', () => {
    const repo = join(root, 'work', 'repo');
    mkdirSync(repo, { recursive: true });
    write(join(root, 'work', '.legion', 'config.toml'), '');
    expect(ensureProjectConfig(repo, repo, loadConfig(repo))).toBeNull();
    expect(existsSync(join(repo, '.legion', 'config.toml'))).toBe(false);
  });

  it('produces TOML that parses to the same settings', () => {
    const config = ConfigSchema.parse({ assistant: { engine: 'codex', effort: 'high' }, workflows: { maxAgents: 7 } });
    const parsed = ConfigSchema.parse(parse(defaultProjectConfig(config)));
    expect(parsed.assistant).toEqual(config.assistant);
    expect(parsed.workflows).toEqual(config.workflows);
  });
});

describe('resolveAgentModel', () => {
  const settings = ConfigSchema.parse({
    workflow: {
      '*': { codex: { effort: 'high' }, agent: { review: { model: 'gpt-x' } } },
      feature: { claude: { model: 'sonnet' }, agent: { plan: { model: 'opus', effort: 'max' } } },
    },
  }).workflow;
  const req = (key: string, engine: string, model: string | null = null) => ({
    workflow: 'feature',
    key,
    engine,
    model,
    effort: null,
  });

  it('prefers the step setting, then the code, then the workflow engine default, then every workflow', () => {
    expect(resolveAgentModel(settings, req('plan', 'claude', 'haiku'))).toMatchObject({ model: 'opus', effort: 'max' });
    expect(resolveAgentModel(settings, req('code', 'claude', 'haiku'))).toMatchObject({
      model: 'haiku',
      origin: { model: 'code' },
    });
    expect(resolveAgentModel(settings, req('code', 'claude'))).toMatchObject({ model: 'sonnet', effort: null });
    expect(resolveAgentModel(settings, req('code', 'codex'))).toMatchObject({
      model: null,
      effort: 'high',
      origin: { model: 'default', effort: 'all' },
    });
    expect(resolveAgentModel(settings, req('review', 'codex'))).toMatchObject({ model: 'gpt-x' });
  });

  it("moves a step to the other engine, dropping the code's model for the old one", () => {
    const moved = ConfigSchema.parse({
      workflow: { feature: { codex: { model: 'gpt-y' }, agent: { code: { engine: 'codex' } } } },
    }).workflow;
    expect(resolveAgentModel(moved, req('code', 'claude', 'haiku'))).toMatchObject({
      engine: 'codex',
      model: 'gpt-y',
      origin: { engine: 'agent', model: 'workflow' },
    });
    expect(resolveAgentModel(moved, req('code', 'codex', 'gpt-z'))).toMatchObject({ engine: 'codex', model: 'gpt-z' });
  });
});
