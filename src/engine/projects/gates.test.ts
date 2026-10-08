/**
 * legion.json gates read/write (gates.ts): format-preserving round trips, creating and removing the key, moving a
 * `verify` entry into `gates.commands`, the revision check (also against concurrent writes and edits made while
 * the temp file is written), input validation, an invalid file, and the `projects.gates` / `projects.setGates`
 * RPCs on a real engine.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { ServerEvent } from '@shared/events';
import type { RpcContract } from '@shared/rpc';
import { createRpcClient } from '@shared/rpc-transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../context';
import { makeRepo, tmp } from '../git/test-helpers';
import { startEngine } from '../index';
import { readProjectGates, writeProjectGates } from './gates';

/** Runs after the engine writes a temp file (`*.tmp`), before it is renamed over legion.json. */
const hooks = vi.hoisted(() => ({ afterTempWrite: null as (() => void) | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof actual.writeFile = async (...args) => {
    await actual.writeFile(...args);
    if (String(args[0]).endsWith('.tmp')) hooks.afterTempWrite?.();
  };
  return { ...actual, default: { ...actual, writeFile }, writeFile };
});

let dir: ReturnType<typeof tmp>;

beforeEach(() => {
  dir = tmp('legion-gates-');
});

afterEach(() => {
  hooks.afterTempWrite = null;
  dir.cleanup();
});

const file = () => join(dir.path, 'legion.json');
const text = () => readFileSync(file(), 'utf8');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function writePackageJson(scripts: Record<string, string>): void {
  writeFileSync(join(dir.path, 'package.json'), JSON.stringify({ name: 'demo', scripts }, null, 2));
  writeFileSync(join(dir.path, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
}

describe('readProjectGates', () => {
  it('reports an absent file with the detected gates and the defaults', async () => {
    writePackageJson({ test: 'vitest run', lint: 'biome check .' });
    const gates = await readProjectGates(dir.path);
    expect(gates).toEqual({
      path: file(),
      exists: false,
      revision: null,
      error: null,
      gates: null,
      verify: [],
      detected: [
        { name: 'test', command: 'pnpm test', blocking: true, source: 'detected' },
        { name: 'lint', command: 'pnpm run lint', blocking: true, source: 'detected' },
      ],
      packageManager: 'pnpm',
      resolved: [
        { name: 'test', command: 'pnpm test', blocking: true, source: 'detected' },
        { name: 'lint', command: 'pnpm run lint', blocking: true, source: 'detected' },
      ],
      settings: { detect: true, scope: 'block', secrets: { mode: 'block', allow: [] } },
    });
  });

  it('reads gates and verify, and resolves them over the detected gates', async () => {
    writePackageJson({ test: 'vitest run', lint: 'biome check .' });
    const raw = `${JSON.stringify(
      {
        verify: ['cargo test'],
        gates: { commands: { lint: false, e2e: { run: 'pnpm e2e', blocking: false } }, scope: 'warn' },
      },
      null,
      2,
    )}\n`;
    writeFileSync(file(), raw);
    const gates = await readProjectGates(dir.path);
    expect(gates).toMatchObject({
      exists: true,
      revision: sha(raw),
      error: null,
      gates: { commands: { lint: false, e2e: { run: 'pnpm e2e', blocking: false } }, scope: 'warn' },
      verify: ['cargo test'],
      settings: { detect: true, scope: 'warn', secrets: { mode: 'block', allow: [] } },
    });
    expect(gates.resolved).toEqual([
      { name: 'e2e', command: 'pnpm e2e', blocking: false, source: 'config' },
      { name: 'cargo-test', command: 'cargo test', blocking: true, source: 'verify' },
      { name: 'test', command: 'pnpm test', blocking: true, source: 'detected' },
    ]);
  });

  it('reports an invalid file via error instead of throwing', async () => {
    writeFileSync(file(), '{ "verify": [');
    const broken = await readProjectGates(dir.path);
    expect(broken).toMatchObject({ exists: true, revision: sha('{ "verify": ['), gates: null, verify: [] });
    expect(broken.error).toMatch(/^legion\.json: invalid JSON/);

    writeFileSync(file(), JSON.stringify({ gates: { scope: 'sometimes' } }));
    const invalid = await readProjectGates(dir.path);
    expect(invalid.gates).toBeNull();
    expect(invalid.error).toMatch(/^legion\.json: .*scope/s);
    expect(invalid.settings.scope).toBe('block');
  });
});

describe('writeProjectGates', () => {
  it('round-trips, keeping the other keys, their order, a 4-space indent and the trailing newline', async () => {
    const original = [
      '{',
      '    "setup": [',
      '        "pnpm install"',
      '    ],',
      '    "gates": {',
      '        "scope": "warn"',
      '    },',
      '    "copy": [',
      '        ".env"',
      '    ],',
      '    "installCommand": "pnpm install --frozen-lockfile"',
      '}',
      '',
    ].join('\n');
    writeFileSync(file(), original);
    const before = await readProjectGates(dir.path);
    const after = await writeProjectGates(dir.path, {
      revision: before.revision,
      gates: { commands: { test: 'pnpm test' }, scope: 'block' },
    });
    expect(text()).toBe(
      [
        '{',
        '    "setup": [',
        '        "pnpm install"',
        '    ],',
        '    "gates": {',
        '        "commands": {',
        '            "test": "pnpm test"',
        '        },',
        '        "scope": "block"',
        '    },',
        '    "copy": [',
        '        ".env"',
        '    ],',
        '    "installCommand": "pnpm install --frozen-lockfile"',
        '}',
        '',
      ].join('\n'),
    );
    expect(after).toMatchObject({
      exists: true,
      revision: sha(text()),
      error: null,
      gates: { commands: { test: 'pnpm test' }, scope: 'block' },
    });
    expect(await readProjectGates(dir.path)).toEqual(after);

    // Writing back what was read changes nothing.
    const written = text();
    await writeProjectGates(dir.path, { revision: after.revision, gates: after.gates });
    expect(text()).toBe(written);
  });

  it('appends a new gates key at the end, keeping a tab indent and no trailing newline', async () => {
    writeFileSync(file(), '{\n\t"setup": ["pnpm i"],\n\t"copy": [".env"]\n}');
    await writeProjectGates(dir.path, { revision: sha(text()), gates: { detect: false } });
    expect(text()).toBe(
      '{\n\t"setup": [\n\t\t"pnpm i"\n\t],\n\t"copy": [\n\t\t".env"\n\t],\n\t"gates": {\n\t\t"detect": false\n\t}\n}',
    );
  });

  it('creates the file when absent', async () => {
    const result = await writeProjectGates(dir.path, {
      revision: null,
      gates: { secrets: { mode: 'warn', allow: ['fixtures/**'] } },
    });
    expect(text()).toBe(
      '{\n  "gates": {\n    "secrets": {\n      "mode": "warn",\n      "allow": [\n        "fixtures/**"\n      ]\n    }\n  }\n}\n',
    );
    expect(result).toMatchObject({ exists: true, revision: sha(text()), error: null });
    expect(result.settings.secrets).toEqual({ mode: 'warn', allow: ['fixtures/**'] });
    // Atomic: no temp file left behind.
    expect(readdirSync(dir.path)).toEqual(['legion.json']);
  });

  it('removes the gates key', async () => {
    writeFileSync(file(), '{\n  "setup": ["pnpm i"],\n  "gates": { "scope": "warn" },\n  "copy": [".env"]\n}\n');
    const result = await writeProjectGates(dir.path, { revision: sha(text()), gates: null });
    expect(JSON.parse(text())).toEqual({ setup: ['pnpm i'], copy: ['.env'] });
    expect(Object.keys(JSON.parse(text()))).toEqual(['setup', 'copy']);
    expect(result.gates).toBeNull();
  });

  it('moves a verify entry into gates.commands', async () => {
    writeFileSync(file(), `${JSON.stringify({ setup: ['pnpm i'], verify: ['pnpm test', 'cargo test'] }, null, 2)}\n`);
    const result = await writeProjectGates(dir.path, {
      revision: sha(text()),
      gates: { commands: { unit: 'pnpm test' } },
      verify: ['cargo test'],
    });
    expect(text()).toBe(
      `${JSON.stringify({ setup: ['pnpm i'], verify: ['cargo test'], gates: { commands: { unit: 'pnpm test' } } }, null, 2)}\n`,
    );
    expect(result.resolved.map((g) => [g.name, g.source])).toEqual([
      ['unit', 'config'],
      ['cargo-test', 'verify'],
    ]);

    // Moving the last one removes `verify`.
    await writeProjectGates(dir.path, {
      revision: result.revision,
      gates: { commands: { unit: 'pnpm test', cargo: 'cargo test' } },
      verify: [],
    });
    expect(Object.keys(JSON.parse(text()))).toEqual(['setup', 'gates']);
  });

  it('refuses a stale revision without writing', async () => {
    writeFileSync(file(), '{ "setup": ["pnpm i"] }\n');
    const read = await readProjectGates(dir.path);
    writeFileSync(file(), '{ "setup": ["pnpm i"], "copy": [".env"] }\n');
    const edited = text();
    await expect(
      writeProjectGates(dir.path, { revision: read.revision, gates: { detect: false } }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/changed on disk/),
      data: { revision: sha(edited) },
    });
    expect(text()).toBe(edited);

    // A file that appeared since an absent read is a conflict too.
    await expect(writeProjectGates(dir.path, { revision: null, gates: null })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('lets only one of two concurrent writes from the same revision through', async () => {
    writeFileSync(file(), '{\n  "setup": ["pnpm i"]\n}\n');
    const revision = sha(text());
    const results = await Promise.allSettled([
      writeProjectGates(dir.path, { revision, gates: { scope: 'warn' } }),
      writeProjectGates(dir.path, { revision, gates: { detect: false } }),
    ]);
    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
    expect(JSON.parse(text())).toEqual({ setup: ['pnpm i'], gates: { scope: 'warn' } });
    expect(readdirSync(dir.path)).toEqual(['legion.json']);
  });

  it('refuses to replace a file edited while the new text was being written', async () => {
    writeFileSync(file(), '{\n  "setup": ["pnpm i"]\n}\n');
    const revision = sha(text());
    const edited = '{\n  "setup": ["pnpm install"],\n  "copy": [".env"]\n}\n';
    hooks.afterTempWrite = () => writeFileSync(file(), edited);
    await expect(writeProjectGates(dir.path, { revision, gates: { scope: 'warn' } })).rejects.toMatchObject({
      code: 'conflict',
      data: { revision: sha(edited) },
    });
    expect(text()).toBe(edited);
    expect(readdirSync(dir.path)).toEqual(['legion.json']);
  });

  it('keeps a __proto__ key as an ordinary key', async () => {
    const original = '{\n  "__proto__": { "gates": { "detect": false } },\n  "setup": ["pnpm i"]\n}\n';
    writeFileSync(file(), original);
    const result = await writeProjectGates(dir.path, { revision: sha(original), gates: { scope: 'warn' } });
    expect(text()).toBe(
      '{\n  "__proto__": {\n    "gates": {\n      "detect": false\n    }\n  },\n  "setup": [\n    "pnpm i"\n  ],\n  "gates": {\n    "scope": "warn"\n  }\n}\n',
    );
    expect(result).toMatchObject({ error: null, gates: { scope: 'warn' }, settings: { detect: true, scope: 'warn' } });
  });

  it('rejects a gate whose name a verify entry kept from the file already uses', async () => {
    const original = '{\n  "verify": ["npm test"]\n}\n';
    writeFileSync(file(), original);
    await expect(
      writeProjectGates(dir.path, { revision: sha(original), gates: { commands: { test: 'pnpm test' } } }),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/duplicate gate name "test"/) });
    expect(text()).toBe(original);
    // The same command under the same name runs once: fine.
    await writeProjectGates(dir.path, { revision: sha(original), gates: { commands: { test: 'npm test' } } });
    expect(JSON.parse(text())).toEqual({ verify: ['npm test'], gates: { commands: { test: 'npm test' } } });
  });

  it('rejects an empty verify command kept from the file', async () => {
    const original = '{\n  "verify": ["   "]\n}\n';
    writeFileSync(file(), original);
    await expect(
      writeProjectGates(dir.path, { revision: sha(original), gates: { scope: 'warn' } }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/verify: empty command/),
    });
    expect(text()).toBe(original);
  });

  it('rejects a repeated verify command, also when a gate runs the same command', async () => {
    const original = '{\n  "setup": ["pnpm i"]\n}\n';
    writeFileSync(file(), original);
    await expect(
      writeProjectGates(dir.path, {
        revision: sha(original),
        gates: { commands: { test: 'npm test' } },
        verify: ['npm test', 'npm test'],
      }),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/"npm test" is listed twice/) });
    expect(text()).toBe(original);

    // Kept from the file, too.
    const repeated = '{\n  "verify": ["npm test", " npm test"]\n}\n';
    writeFileSync(file(), repeated);
    await expect(
      writeProjectGates(dir.path, { revision: sha(repeated), gates: { commands: { test: 'npm test' } } }),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/listed twice/) });
    expect(text()).toBe(repeated);
  });

  it('rejects invalid input with a readable error, leaving the file untouched', async () => {
    const original = '{\n  "setup": ["pnpm i"]\n}\n';
    writeFileSync(file(), original);
    const revision = sha(original);
    const attempt = (input: Parameters<typeof writeProjectGates>[1]) => writeProjectGates(dir.path, input);

    await expect(attempt({ revision, gates: { commands: { 'Bad Name': 'pnpm test' } } })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/gate name "Bad Name"/),
    });
    await expect(attempt({ revision, gates: { commands: { test: '   ' } } })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/gate "test": empty command/),
    });
    await expect(attempt({ revision, gates: { commands: { test: { run: '' } } } })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/empty command/),
    });
    await expect(attempt({ revision, gates: { secrets: { allow: [' '] } } })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/secrets\.allow: empty glob/),
    });
    await expect(attempt({ revision, gates: null, verify: ['  '] })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/verify: empty command/),
    });
    await expect(
      attempt({ revision, gates: { commands: { test: 'pnpm test' } }, verify: ['npm test'] }),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/duplicate gate name "test"/) });
    await expect(attempt({ revision, gates: null, verify: ['cargo test', 'cargo test'] })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/listed twice/),
    });
    // `scope` is not a valid mode (the whole result is validated too).
    await expect(
      attempt({
        revision,
        gates: { scope: 'sometimes' } as unknown as Parameters<typeof writeProjectGates>[1]['gates'],
      }),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/scope/) });
    expect(text()).toBe(original);
    expect(readdirSync(dir.path)).toEqual(['legion.json']);
  });

  it('refuses to edit a file that is not valid JSON or stays invalid', async () => {
    writeFileSync(file(), '{ "setup": [');
    await expect(writeProjectGates(dir.path, { revision: sha(text()), gates: null })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/invalid JSON/),
    });
    writeFileSync(file(), '{ "setup": "pnpm i" }');
    await expect(writeProjectGates(dir.path, { revision: sha(text()), gates: null })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/setup/),
    });
    expect(text()).toBe('{ "setup": "pnpm i" }');

    // An invalid `gates` key is fixed by replacing it.
    writeFileSync(file(), '{ "setup": ["pnpm i"], "gates": { "scope": "sometimes" } }\n');
    const fixed = await writeProjectGates(dir.path, { revision: sha(text()), gates: { scope: 'warn' } });
    expect(fixed).toMatchObject({ error: null, gates: { scope: 'warn' } });
  });

  it('keeps CRLF line endings', async () => {
    writeFileSync(file(), '{\r\n  "setup": ["pnpm i"]\r\n}\r\n');
    await writeProjectGates(dir.path, { revision: sha(text()), gates: { detect: false } });
    expect(text()).toBe(
      '{\r\n  "setup": [\r\n    "pnpm i"\r\n  ],\r\n  "gates": {\r\n    "detect": false\r\n  }\r\n}\r\n',
    );
  });
});

describe('projects.gates / projects.setGates', () => {
  it('reads and writes the legion.json of the project', async () => {
    const repo = await makeRepo({ 'legion.json': '{\n    "setup": ["pnpm i"]\n}\n' });
    const engine = await startEngine({
      dataDir: join(dir.path, 'home'),
      env: process.env,
      log: silentLogger,
      fakeEngines: true,
      probeOnStart: false,
    });
    const channel = new MessageChannel();
    engine.connect(channel.port1);
    const client = createRpcClient<RpcContract, ServerEvent>(channel.port2, { timeoutMs: 20_000 });
    try {
      const project = await client.call('projects.add', { path: repo.path });
      const read = await client.call('projects.gates', { projectId: project.id });
      expect(read).toMatchObject({ path: join(repo.path, 'legion.json'), exists: true, gates: null, error: null });

      const written = await client.call('projects.setGates', {
        projectId: project.id,
        revision: read.revision,
        gates: { scope: 'warn' },
      });
      expect(written.settings.scope).toBe('warn');
      expect(readFileSync(join(repo.path, 'legion.json'), 'utf8')).toBe(
        '{\n    "setup": [\n        "pnpm i"\n    ],\n    "gates": {\n        "scope": "warn"\n    }\n}\n',
      );
      await expect(
        client.call('projects.setGates', { projectId: project.id, revision: read.revision, gates: null }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(existsSync(join(repo.path, 'legion.json'))).toBe(true);
    } finally {
      client.close();
      channel.port2.close();
      await engine.close();
      repo.cleanup();
    }
  });
});
