import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp } from '../git/test-helpers.ts';
import { ejectWorkflow, projectWorkflowDir } from './loader.ts';

describe('ejectWorkflow helpers', () => {
  it('copies transitive helpers and handles shared or circular imports', () => {
    const repo = tmp('legion-eject-');
    try {
      writeFileSync(join(repo.path, 'custom.ts'), "import './unused.ts';\nimport { task } from './_tasks.ts';\n");
      writeFileSync(join(repo.path, '_tasks.ts'), "export { review } from './_review.ts';\n");
      writeFileSync(join(repo.path, '_review.ts'), "export { task } from './_tasks.ts';\n");
      ejectWorkflow(repo.path, './custom.ts');
      const dir = projectWorkflowDir(repo.path);
      expect(existsSync(join(dir, 'custom.ts'))).toBe(true);
      expect(readFileSync(join(dir, '_tasks.ts'), 'utf8')).toContain('./_review.ts');
      expect(readFileSync(join(dir, '_review.ts'), 'utf8')).toContain('./_tasks.ts');
    } finally {
      repo.cleanup();
    }
  });

  it('preserves existing project helpers and does not copy their upstream dependencies', () => {
    const repo = tmp('legion-eject-');
    try {
      writeFileSync(join(repo.path, 'custom.ts'), "import { task } from './_tasks.ts';\n");
      writeFileSync(join(repo.path, '_tasks.ts'), "export { review } from './_review.ts';\n");
      const dir = projectWorkflowDir(repo.path);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '_tasks.ts'), 'export const task = 1;\n');
      ejectWorkflow(repo.path, './custom.ts');
      expect(readFileSync(join(dir, '_tasks.ts'), 'utf8')).toBe('export const task = 1;\n');
      expect(existsSync(join(dir, '_review.ts'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});
