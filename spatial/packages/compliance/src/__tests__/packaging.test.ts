import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { World } from '@m3xi/spatial-engine';
import * as pkg from '../index.js';
import { normaliseWorld } from '../ui/mount.js';

/**
 * The package boundary, tested rather than asserted in a comment.
 *
 * Three promises are made elsewhere in this repo about this package, and all
 * three are the kind that rot silently:
 *
 *   -- it imports in Node. The console mounts it in a browser, but the
 *      compliance models are the sort of thing that ends up rendered on a
 *      server or in a scheduled job, and every one of these documents is a
 *      file somebody wants produced without a browser open;
 *   -- it does not pull three.js. `@m3xi/viewer` is a dependency for
 *      `buildNarrative` and `formatQuantity`, and both live behind
 *      `@m3xi/viewer/headless`. One careless import of the package root drags
 *      in a WebGL renderer, and the failure mode is a stack trace about
 *      `document` in a Node process;
 *   -- it exports the shape the console's seam checks for. That check is
 *      structural and at run time, so a rename here fails as "compliance
 *      centre could not be mounted" on somebody else's screen.
 */

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { out.push(...sourceFiles(path)); continue; }
    if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('the package imports in Node', () => {
  it('loads without a DOM', () => {
    // This test file runs under `environment: 'node'`, so the import at the
    // top of it is the assertion. If anything in the module graph touched
    // `document` or `window` at module scope, the file would not have loaded.
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof pkg.mountComplianceCentre).toBe('function');
  });

  it('never imports the viewer package root, only its headless entry', () => {
    const offenders = sourceFiles(SRC).filter((path) => {
      const text = readFileSync(path, 'utf8');
      return /from '@m3xi\/viewer'/.test(text);
    });
    expect(offenders, 'these files would pull three.js into a Node process').toEqual([]);
  });

  it('imports three.js nowhere, directly or by name', () => {
    const offenders = sourceFiles(SRC).filter((path) => (
      /from ['"](three|@sparkjsdev\/spark)['"]/.test(readFileSync(path, 'utf8'))
    ));
    expect(offenders).toEqual([]);
  });

  it('declares no dependency this workspace does not already carry', () => {
    const manifest = JSON.parse(
      readFileSync(join(dirname(SRC), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort())
      .toEqual(['@m3xi/spatial-engine', '@m3xi/viewer', '@m3xi/world-core']);
  });
});

describe('the seam with the console', () => {
  it('exports exactly one thing at run time', () => {
    expect(Object.keys(pkg)).toEqual(['mountComplianceCentre']);
  });

  /**
   * `console-ui/src/logic/seam.ts` accepts a module only if it carries a
   * function of the right name with at least two declared parameters, and a
   * handle only if it has a `destroy`. The predicate is repeated here rather
   * than imported: `@m3xi/console-ui` is not a dependency of this package, and
   * taking one for a test would couple a compliance document's build to the
   * console's. What is copied is four lines of duck-typing, and the thing it
   * guards against is a rename in THIS file, which is what the test is for.
   */
  it('satisfies the structural check the console applies at run time', () => {
    const mod = pkg as unknown as Record<string, unknown>;
    const fn = mod['mountComplianceCentre'];
    expect(typeof fn).toBe('function');
    expect((fn as (...args: never[]) => unknown).length).toBeGreaterThanOrEqual(2);
  });
});

describe('what the console actually passes as `world`', () => {
  it('accepts the WorldDocument the review page hands it', () => {
    // `pages/worldReview.ts` passes `doc`, not an engine World, whatever the
    // seam's type comment says. This is the case that matters in production.
    const result = normaliseWorld(FLAT);
    expect('world' in result).toBe(true);
    if ('world' in result) expect(result.world.doc.id).toBe(FLAT.id);
  });

  it('accepts an engine World, which is what the seam documents', () => {
    const result = normaliseWorld(World.fromDocument(FLAT));
    expect('world' in result).toBe(true);
  });

  it('accepts an object wrapping a document under `doc`', () => {
    expect('world' in normaliseWorld({ doc: FLAT })).toBe(true);
  });

  it('refuses anything else in words, rather than rendering an empty document', () => {
    for (const junk of [null, undefined, 42, 'a world', {}, { rooms: [] }]) {
      const result = normaliseWorld(junk);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.length).toBeGreaterThan(40);
        expect(result.error).toMatch(/world|certified|produced/i);
      }
    }
  });
});
