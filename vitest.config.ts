import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@engine': resolve(import.meta.dirname, 'src/engine'),
  '@renderer': resolve(import.meta.dirname, 'src/renderer'),
};

// Unit tests only: pure TS + engine code in plain Node. Never imports electron or node-pty.
export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.live.test.ts', 'node_modules/**', 'out/**'],
    testTimeout: 15_000,
  },
});
