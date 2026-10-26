import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Real CLI sessions (cheapest models; costs a little): `pnpm test:live [file]`.
export default defineConfig({
  resolve: { alias: { legion: fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    testTimeout: 180_000,
  },
});
