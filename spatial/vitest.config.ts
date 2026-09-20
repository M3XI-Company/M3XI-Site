import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The engine imports @m3xi/world-core, whose package entry points at dist/.
// Aliasing straight at the source keeps `vitest run` independent of build order.
// types.ts is targeted rather than index.ts because index.ts re-exports through
// a './types.js' specifier that only resolves after a TypeScript build.
export default defineConfig({
  resolve: {
    alias: {
      '@m3xi/world-core': fileURLToPath(new URL('./packages/world-core/src/types.ts', import.meta.url)),
    },
  },
  test: {
    // apps/ is included as well as packages/. It was not, which meant the
    // console's API client, its pages and the viewer app's transport were
    // covered by `tsc` and by reading, and by nothing else -- and those are
    // exactly the files where a wrong assumption about the server shows up.
    // The environment stays `node`, so anything an app wants tested has to be
    // separable from the DOM. That is a constraint worth having: batching,
    // offset arithmetic and resume rules are the parts that must be right, and
    // they have no business touching a document.
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      '../supabase/functions/**/__tests__/*.test.ts',
    ],
    environment: 'node',
  },
});
