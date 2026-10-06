import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Rollup } from 'vite';

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@engine': resolve(import.meta.dirname, 'src/engine'),
  '@renderer': resolve(import.meta.dirname, 'src/renderer'),
};

// zod ships comments Rollup can't interpret as annotations; the warning is noise.
const onwarn = (warning: Rollup.RollupLog, warn: (warning: Rollup.RollupLog) => void): void => {
  if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return;
  warn(warning);
};

export default defineConfig({
  // Main process + the engine (second entry, launched with utilityProcess.fork).
  // Both are ESM; `dependencies` from package.json stay external (node-pty is native).
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        onwarn,
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          engine: resolve(import.meta.dirname, 'src/engine/index.ts'),
        },
      },
    },
  },
  // Sandboxed preloads must be CommonJS.
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        onwarn,
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
