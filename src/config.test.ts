import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  ConfigSchema,
  configLayers,
  defaultProjectConfig,
  ensureProjectConfig,
  loadConfig,
  migrateProfiles,
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

describe('engine profiles are gone', () => {
  const profiles = {
    claude: {
      default: 'claude-1',
      profiles: {
        'claude-1': { setup: 'claude-share check', command: 'claude', env: { CLAUDE_CONFIG_DIR: '~/.claude-1' } },
        work: { env: { CLAUDE_CONFIG_DIR: '~/.claude-w', FOO: 'bar' } },
      },
    },
    codex: { profiles: { default: { env: { CODEX_HOME: '~/.codex-x' } } } },
  };

  it('migrateProfiles converts profiles, default and setup, with notes', () => {
    const { doc, notes } = migrateProfiles(structuredClone(profiles));
    expect(doc.accounts).toEqual({
      claude: { 'claude-1': { dir: '~/.claude-1' }, work: { dir: '~/.claude-w', env: { FOO: 'bar' } } },
      codex: { default: { dir: '~/.codex-x' } },
    });
    expect(doc.claude).toEqual({ command: 'claude' });
    expect(doc.codex).toEqual({});
    expect(notes.join('\n')).toMatch(/setup was dropped/);
    expect(notes.join('\n')).toMatch(/default "claude-1" was dropped/);
  });

  it('leaves a document without profiles alone', () => {
    const input = { claude: { models: ['x'] }, workflows: { maxAgents: 2 } };
    expect(migrateProfiles(input)).toEqual({ doc: input, notes: [] });
  });

  it('loadConfig throws a ConfigError showing the equivalent accounts', () => {
    write(
      join(root, 'xdg', 'legion', 'config.toml'),
      '[claude]\ndefault = "w"\n[claude.profiles.w]\nenv = { CLAUDE_CONFIG_DIR = "~/.claude-w" }\n',
    );
    const run = () => loadConfig(join(root, 'repo'));
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/\[accounts\.claude\.w\]/);
    expect(run).toThrow(/dir = "~\/\.claude-w"/);
    expect(run).toThrow(/legion accounts migrate/);
  });

  it('never shows env values, and drops forbidden keys with guidance', () => {
    const doc = {
      claude: {
        profiles: {
          w: {
            env: {
              CLAUDE_CODE_OAUTH_TOKEN: 'FAKE_TOKEN_SENTINEL',
              ANTHROPIC_BASE_URL: 'http://x',
              API_KEY: 'OTHER_SENTINEL',
            },
          },
        },
      },
    };
    const { doc: out, notes } = migrateProfiles(doc);
    expect(JSON.stringify(out)).not.toContain('FAKE_TOKEN_SENTINEL');
    expect(JSON.stringify(out)).not.toContain('http://x');
    expect(notes.join('\n')).toMatch(/tokenEnv or tokenFile/);
    write(
      join(root, 'xdg', 'legion', 'config.toml'),
      '[claude.profiles.w]\nenv = { CLAUDE_CODE_OAUTH_TOKEN = "FAKE_TOKEN_SENTINEL", API_KEY = "OTHER_SENTINEL" }\n',
    );
    let message = '';
    try {
      loadConfig(join(root, 'repo'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/tokenEnv or tokenFile/);
    expect(message).not.toContain('FAKE_TOKEN_SENTINEL');
    expect(message).not.toContain('OTHER_SENTINEL');
  });

  it('parses [accounts] and rejects forbidden env', () => {
    const config = ConfigSchema.parse({
      claude: { command: 'cl', args: ['--x'] },
      accounts: { cooldownMinutes: 5, claude: { work: { dir: '~/w', tokenEnv: 'T' } } },
    });
    expect(config.claude.command).toBe('cl');
    expect(config.accounts.cooldownMinutes).toBe(5);
    expect(config.accounts.claude.work?.enabled).toBe(true);
    expect(ConfigSchema.parse({}).accounts.cooldownMinutes).toBe(60);
    expect(() => ConfigSchema.parse({ accounts: { codex: { a: { env: { OPENAI_BASE_URL: 'x' } } } } })).toThrow();
  });
});
