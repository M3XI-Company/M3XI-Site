import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Standalone dev server for the viewer page: `npx vite` from this directory.
 *
 * The aliases point at package SOURCE rather than at built `dist`, so a change
 * in `@m3xi/viewer` hot-reloads without a `tsc -b` in between. `@m3xi/world-core`
 * is aliased at `types.ts` rather than `index.ts` for the same reason the root
 * vitest config does it: `index.ts` re-exports through a `./types.js`
 * specifier that only resolves after a TypeScript build.
 *
 * The page is also built as part of the main site from the repo-root
 * `vite.config.js`, which carries the same aliases.
 */
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@m3xi/viewer': r('../../packages/viewer/src/index.ts'),
      '@m3xi/spatial-engine/fixtures/flat': r('../../packages/spatial-engine/src/__fixtures__/flat.ts'),
      '@m3xi/spatial-engine': r('../../packages/spatial-engine/src/index.ts'),
      '@m3xi/world-core': r('../../packages/world-core/src/types.ts'),
    },
  },
  server: { port: 5183, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
