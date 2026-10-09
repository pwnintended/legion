/**
 * legion.json prompts read/write (prompts.ts): reading a file with and without `prompts`, merging one role's
 * change and removing blank entries (and the key once empty), keeping other keys and the indent, the revision
 * check, the length limit and an invalid file.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_ADDITION_MAX } from '@shared/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmp } from '../git/test-helpers';
import { readProjectPrompts, writeProjectPrompts } from './prompts';

let dir: ReturnType<typeof tmp>;

beforeEach(() => {
  dir = tmp('legion-prompts-');
});

afterEach(() => {
  dir.cleanup();
});

const file = () => join(dir.path, 'legion.json');
const text = () => readFileSync(file(), 'utf8');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('project prompts', () => {
  it('reads an absent file as no prompts', async () => {
    expect(await readProjectPrompts(dir.path)).toEqual({
      path: file(),
      exists: false,
      revision: null,
      error: null,
      prompts: {},
    });
  });

  it('creates the file with one role, then merges a second and keeps the rest', async () => {
    const created = await writeProjectPrompts(dir.path, { revision: null, prompts: { coder: '  Run pnpm lint.  ' } });
    expect(created.prompts).toEqual({ coder: 'Run pnpm lint.' });
    expect(text()).toBe('{\n  "prompts": {\n    "coder": "Run pnpm lint."\n  }\n}\n');

    const next = await writeProjectPrompts(dir.path, {
      revision: created.revision,
      prompts: { reviewer: 'Flag missing tests first.' },
    });
    expect(next.prompts).toEqual({ coder: 'Run pnpm lint.', reviewer: 'Flag missing tests first.' });
  });

  it('keeps other keys, their order and the indent, and drops the key once every entry is blank', async () => {
    const original = '{\n    "setup": ["pnpm i"],\n    "prompts": { "coder": "Lint." },\n    "copy": [".env"]\n}\n';
    writeFileSync(file(), original);
    const cleared = await writeProjectPrompts(dir.path, { revision: sha(original), prompts: { coder: '  ' } });
    expect(cleared.prompts).toEqual({});
    expect(text()).toBe('{\n    "setup": [\n        "pnpm i"\n    ],\n    "copy": [\n        ".env"\n    ]\n}\n');
  });

  it('refuses a stale revision and leaves the file alone', async () => {
    writeFileSync(file(), '{}\n');
    await expect(
      writeProjectPrompts(dir.path, { revision: sha('{ }\n'), prompts: { coder: 'x' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(text()).toBe('{}\n');
  });

  it('refuses a text over the limit', async () => {
    await expect(
      writeProjectPrompts(dir.path, { revision: null, prompts: { coder: 'x'.repeat(PROMPT_ADDITION_MAX + 1) } }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('reports an invalid file instead of throwing, and refuses to edit it', async () => {
    writeFileSync(file(), '{ "prompts": ');
    const read = await readProjectPrompts(dir.path);
    expect(read.error).toMatch(/invalid JSON/);
    expect(read.prompts).toEqual({});
    await expect(
      writeProjectPrompts(dir.path, { revision: read.revision, prompts: { coder: 'x' } }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});
