import { defineConfig } from 'vitest/config';
import { alias } from './vitest.config';

// Live tests talk to the real `claude` / `codex` CLIs. Run with `pnpm test:live` (sets LEGION_LIVE=1).
export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    testTimeout: 180_000,
    passWithNoTests: true,
  },
});
