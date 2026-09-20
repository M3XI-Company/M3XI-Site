import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * IMPORTING @m3xi/review IN NODE MUST NOT PULL IN THREE.JS.
 *
 * This is a property of the package, not a preference, and it has three
 * consumers behind it:
 *
 *   - `console-ui`'s seam test imports this package in a Node test run to
 *     check the mount contract. A static three.js import would make that test
 *     load a WebGL renderer to find out whether a function exists;
 *   - the correction model is pure computation over a `WorldDocument` and has
 *     every reason to run on a server or in a script;
 *   - the console bundles this editor beside its own pages, and a renderer
 *     that is only opened by a button should only be downloaded by that button.
 *
 * So the test walks THIS PACKAGE'S OWN STATIC IMPORT GRAPH from `src/index.ts`
 * and fails if `three`, `@sparkjsdev/spark` or `@m3xi/viewer`'s root entry
 * appears anywhere in it. `@m3xi/viewer/headless` is allowed and is the point
 * of the distinction: it is pure computation, it imports cleanly in Node, and
 * it is where `formatQuantity` lives.
 *
 * A dynamic `import()` is not part of the static graph and is not matched --
 * that is exactly how `viewerBridge.ts` reaches the renderer, and exactly why
 * this can be true while the 3D view still works.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');

const FORBIDDEN = ['three', '@sparkjsdev/spark', '@m3xi/viewer'];

/**
 * Static `import`/`export ... from` only. A specifier reached through
 * `import(` is deliberately not matched: that is a run-time decision the
 * bundler splits out, and it is how the viewer is loaded.
 */
const FROM = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(FROM)) out.push(m[1]!);
  for (const m of source.matchAll(SIDE_EFFECT)) out.push(m[1]!);
  return out;
}

/** Every file reachable from `entry` by a static import, and the bare specifiers seen. */
function walk(entry: string): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of staticSpecifiers(source)) {
      if (!specifier.startsWith('.')) { bare.add(specifier); continue; }
      // TypeScript source writes `./x.js` for what is `./x.ts` on disk.
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      queue.push(target);
    }
  }
  return { files: [...seen], bare };
}

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...allSourceFiles(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the Node import property', () => {
  it('reaches no renderer from the package entry', () => {
    const { files, bare } = walk(join(SRC, 'index.ts'));
    // A guard on the guard: if the walk resolved nothing, the assertion below
    // would pass by finding nothing at all.
    expect(files.length).toBeGreaterThan(8);
    expect([...bare].filter((s) => FORBIDDEN.includes(s))).toEqual([]);
  });

  it('reaches no renderer from the model entry either', () => {
    const { bare } = walk(join(SRC, 'model', 'index.ts'));
    expect([...bare].filter((s) => FORBIDDEN.includes(s))).toEqual([]);
    // The model is not allowed the headless viewer either: it is the layer a
    // server or another package would import, and it needs nothing from it.
    expect([...bare]).toEqual(['@m3xi/world-core', '@m3xi/spatial-engine']
      .filter((s) => bare.has(s)));
  });

  it('never statically imports a renderer anywhere in the package', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN.includes(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does use the headless viewer, which is the whole point of the distinction', () => {
    const { bare } = walk(join(SRC, 'index.ts'));
    expect(bare.has('@m3xi/viewer/headless')).toBe(true);
  });

  it('imports the package entry in Node with no DOM present', async () => {
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    const mod = await import('../index.js');
    expect(typeof mod.mountCorrectionEditor).toBe('function');
    // `console-ui`'s seam checks the arity, and rejects a zero-argument export
    // that merely shares the name.
    expect(mod.mountCorrectionEditor.length).toBeGreaterThanOrEqual(2);
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
  });
});
