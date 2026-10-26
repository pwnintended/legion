import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workflow files import 'legion'; at runtime a Node resolution hook maps it, under vitest this alias does.
  resolve: { alias: { legion: fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'builtin/**/*.test.ts'],
    exclude: ['src/**/*.live.test.ts', 'node_modules/**', 'dist/**'],
    testTimeout: 15_000,
  },
});
