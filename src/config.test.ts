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
  providerEngine,
  resolveAgentModel,
  resolveTier,
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
    expect(config.workflows).toMatchObject({ maxAgents: 5, approvals: 'auto' });
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

describe('[remote]', () => {
  it('is off by default', () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    expect(loadConfig(repo).remote).toMatchObject({ enabled: false, size: 'medium', setup: [] });
  });

  it('takes the API key from the user and local files', () => {
    const repo = join(root, 'repo');
    write(join(root, 'xdg', 'legion', 'config.toml'), '[remote]\napiKey = "box_user"\n');
    expect(loadConfig(repo).remote.apiKey).toBe('box_user');
    write(join(repo, '.legion', 'config.local.toml'), '[remote]\napiKey = "box_local"\nenabled = true\n');
    expect(loadConfig(repo).remote).toMatchObject({ apiKey: 'box_local', enabled: true });
  });

  it('refuses an API key in a project file that may be committed', () => {
    const repo = join(root, 'repo');
    write(join(repo, '.legion', 'config.toml'), '[remote]\nenabled = true\napiKey = "box_secret"\n');
    expect(() => loadConfig(repo)).toThrow(/apiKey.*config\.local\.toml/);
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
  const config = (doc: Record<string, unknown>) => ConfigSchema.parse(doc);
  const req = (key: string, engine: string, extra: { tier?: 'hard' | 'medium' | 'easy'; model?: string } = {}) => ({
    workflow: 'feature',
    key,
    engine,
    tier: extra.tier ?? null,
    model: extra.model ?? null,
    effort: null,
  });

  it('takes the tier from the step setting, then the code, then the workflow, then every workflow', () => {
    const c = config({
      workflow: {
        '*': { tier: 'easy', agent: { review: { tier: 'hard' } } },
        feature: { tier: 'medium', agent: { plan: { tier: 'hard' } } },
        other: {},
      },
    });
    expect(resolveAgentModel(c, req('plan', 'claude', { tier: 'easy' }))).toMatchObject({
      tier: 'hard',
      model: 'opus',
      effort: 'high',
      origin: { tier: 'agent', model: 'tier' },
    });
    expect(resolveAgentModel(c, req('review', 'claude'))).toMatchObject({ tier: 'hard', origin: { tier: 'agent' } });
    expect(resolveAgentModel(c, req('code', 'claude', { tier: 'easy' }))).toMatchObject({
      tier: 'easy',
      model: 'haiku',
      origin: { tier: 'code' },
    });
    expect(resolveAgentModel(c, req('code', 'claude'))).toMatchObject({ tier: 'medium', origin: { tier: 'workflow' } });
    expect(resolveAgentModel(c, { ...req('code', 'claude'), workflow: 'other' })).toMatchObject({
      tier: 'easy',
      model: 'haiku',
      origin: { tier: 'all' },
    });
    expect(resolveAgentModel(config({}), req('code', 'codex'))).toMatchObject({
      tier: 'medium',
      model: null,
      effort: 'medium',
      origin: { tier: 'default', model: 'default', effort: 'tier' },
    });
  });

  it("puts a step's or the code's own model over the tier's, on its engine only", () => {
    const c = config({ workflow: { feature: { agent: { plan: { model: 'claude-x', effort: 'max' } } } } });
    expect(resolveAgentModel(c, req('plan', 'claude', { model: 'haiku' }))).toMatchObject({
      model: 'claude-x',
      effort: 'max',
      origin: { model: 'agent' },
    });
    expect(resolveAgentModel(c, req('code', 'claude', { model: 'haiku' }))).toMatchObject({
      model: 'haiku',
      origin: { model: 'code' },
    });
    const codex = config({ models: { provider: 'codex' }, workflow: c.workflow });
    expect(resolveAgentModel(codex, req('plan', 'claude', { model: 'haiku' }))).toMatchObject({
      engine: 'codex',
      model: null,
      effort: 'medium',
      origin: { engine: 'provider', model: 'default', effort: 'tier' },
    });
  });

  it("moves a step to the other engine in mixed mode, dropping the code's model for the old one", () => {
    const moved = config({
      models: { codex: { medium: { model: 'gpt-y' } } },
      workflow: { feature: { agent: { code: { engine: 'codex' } } } },
    });
    expect(resolveAgentModel(moved, req('code', 'claude', { model: 'haiku' }))).toMatchObject({
      engine: 'codex',
      model: 'gpt-y',
      effort: 'medium',
      origin: { engine: 'agent', model: 'tier' },
    });
    expect(resolveAgentModel(moved, req('code', 'codex', { model: 'gpt-z' }))).toMatchObject({
      engine: 'codex',
      model: 'gpt-z',
    });
  });

  it('runs everything on a single provider, whatever the code and the step settings say', () => {
    const c = config({
      models: { provider: 'claude' },
      workflow: { feature: { agent: { code: { engine: 'codex' } } } },
    });
    expect(resolveAgentModel(c, req('code', 'codex', { tier: 'hard' }))).toMatchObject({
      engine: 'claude',
      model: 'opus',
      effort: 'high',
      origin: { engine: 'provider' },
    });
    expect(resolveAgentModel(c, req('other', 'fake'))).toMatchObject({ engine: 'fake', model: null });
  });
});

describe('tiers', () => {
  it('overrides a tier field by field and keeps the defaults of the rest', () => {
    const models = ConfigSchema.parse({ models: { claude: { hard: { model: 'sonnet' } } } }).models;
    expect(models.provider).toBe('mixed');
    expect(models.claude.hard).toEqual({ model: 'sonnet', effort: 'high' });
    expect(models.claude.medium).toEqual({ model: 'sonnet' });
    expect(models.codex.easy).toEqual({ effort: 'low' });
  });

  it("gives the assistant or a lead the provider's engine, and its own model only on its own engine", () => {
    const models = ConfigSchema.parse({}).models;
    expect(resolveTier(models, 'assistant', { engine: 'claude', model: 'claude-x' })).toEqual({
      engine: 'claude',
      model: 'claude-x',
      effort: null,
    });
    const codex = { ...models, provider: 'codex' as const };
    expect(resolveTier(codex, 'lead', { engine: 'claude', model: 'claude-x', effort: 'max' })).toEqual({
      engine: 'codex',
      model: null,
      effort: 'high',
    });
    expect(providerEngine(codex, 'fake')).toBe('fake');
  });
});
