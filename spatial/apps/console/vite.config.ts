import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Standalone dev server and build for the operator console: `npx vite` or
 * `npx vite build` from this directory.
 *
 * The aliases point at package SOURCE rather than built `dist`, matching
 * `apps/view/vite.config.ts`, so a change in `@m3xi/console-ui` or
 * `@m3xi/viewer` hot-reloads with no `tsc -b` in between. `@m3xi/world-core`
 * is aliased at `types.ts` for the same reason the root vitest config does it:
 * `index.ts` re-exports through a `./types.js` specifier that only resolves
 * after a TypeScript build.
 *
 * `@m3xi/review` and `@m3xi/compliance` are deliberately NOT aliased. They are
 * another builder's packages, they may not exist, and `src/seams.ts` imports
 * them dynamically so that their absence is a runtime state rather than a
 * build failure.
 */
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@m3xi/console-ui': r('../../packages/console-ui/src/index.ts'),
      '@m3xi/viewer': r('../../packages/viewer/src/index.ts'),
      '@m3xi/spatial-engine/fixtures/flat': r('../../packages/spatial-engine/src/__fixtures__/flat.ts'),
      '@m3xi/spatial-engine': r('../../packages/spatial-engine/src/index.ts'),
      '@m3xi/world-core': r('../../packages/world-core/src/types.ts'),
    },
  },
  server: { port: 5184, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // The seam packages are optional at runtime; rollup must not fail the
      // build looking for them.
      external: ['@m3xi/review', '@m3xi/compliance'],
    },
  },
});
