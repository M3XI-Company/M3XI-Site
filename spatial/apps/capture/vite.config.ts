import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Standalone dev server and build for the capture app: `npx vite` or
 * `npx vite build` from this directory.
 *
 * The site's own build (the root `vite.config.js`) already has an entry for
 * `spatial/apps/capture/index.html`, the `@m3xi/capture-core` alias and
 * `worker: { format: 'es' }`. This file exists so the app can be worked on
 * without building the whole of m3xi.com, and it repeats those three settings
 * because a dev server that resolves packages differently from the production
 * build is a dev server that hides exactly the problems it should be finding.
 *
 * `worker.format: 'es'` is not optional. The analysis worker imports
 * `@m3xi/capture-core`, and Vite's default `iife` worker build cannot carry
 * module imports — the failure is a worker that never posts `ready`, which on
 * a phone looks like an app that simply does not guide.
 *
 * HTTPS IS THE POINT OF `host: true`. `getUserMedia` and
 * `DeviceOrientationEvent.requestPermission` both refuse outside a secure
 * context, and `localhost` counts as one only on the machine itself. Testing
 * this app means opening it on an actual phone, which means the dev server has
 * to be reachable on the network AND served over https — see the README for
 * the tunnel that does it, because Vite cannot issue a certificate a phone
 * will trust on its own.
 */
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@m3xi/capture-core': r('../../packages/capture-core/src/index.ts'),
      // types.ts rather than index.ts, for the reason the root config and the
      // vitest config both give: index.ts re-exports through a './types.js'
      // specifier that only resolves after a TypeScript build.
      '@m3xi/world-core': r('../../packages/world-core/src/types.ts'),
    },
  },
  worker: { format: 'es' },
  server: { port: 5185, host: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
