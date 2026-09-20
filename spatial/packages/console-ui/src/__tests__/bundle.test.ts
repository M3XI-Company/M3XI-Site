/**
 * What the console says a bundle is, and what it says becomes of an asset that
 * does not fit inside one.
 *
 * The bug these tests exist for was not a crash and no type would have caught
 * it. `wv-export` used to answer an oversize property with a background job
 * that named a stage `wv-jobs` never hands out, so the row sat unclaimable,
 * nothing was ever packaged, and this package supplied the console the
 * sentence that told the customer their bundle was on its way. Every function
 * returned exactly what it promised; the product still lied.
 *
 * So the assertions here are about sentences as much as numbers. The catalogue
 * has to describe the export that exists, must not contain the one that never
 * worked, and the two numbers it repeats from the edge function have to still
 * be that function's numbers.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as bundleModule from '../logic/bundle.js';
import {
  BUNDLE_CONTENTS, INLINE_EXPORT_BUDGET_BYTES, OMITTED_ASSET_LINK_TTL_HOURS, PERMANENCE_PROMISE,
  willLinkAssets,
} from '../logic/bundle.js';
import type { ExportResult, OmittedAsset } from '../logic/api.js';

/**
 * The vocabulary of the old lie. "Background" and "queued" are not merely
 * out of date here: there is no queue behind this screen at all, so any of
 * these words in the catalogue would be describing something that does not
 * exist and cannot be waited for.
 */
const QUEUE_LANGUAGE = /queued|queue|background|packaged later|when it is done|appear in exports/i;

/**
 * The edge function these constants are copied from. It lives outside the
 * `spatial` workspace, so the tests that read it skip when it is absent rather
 * than failing a checkout that only has this package — the same rule
 * seam.test.ts follows for @m3xi/review.
 */
const HANDLER = fileURLToPath(new URL(
  '../../../../../supabase/functions/wv-export/handler.ts', import.meta.url,
));
const SERVER_BUNDLE = fileURLToPath(new URL(
  '../../../../../supabase/functions/wv-export/bundle.ts', import.meta.url,
));

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The value of a `const NAME = a * b * c;` in TypeScript source.
 *
 * Deliberately not an import: the edge function is Deno source with `.ts`
 * specifiers and no build in this workspace. Null means the constant is no
 * longer declared under that name, which is a broken mirror and is asserted
 * against rather than skipped over.
 */
function productOf(source: string, name: string): number | null {
  const match = new RegExp(`${name}\\s*=\\s*([0-9_*\\s]+);`).exec(source);
  const expression = match?.[1];
  if (!expression) return null;
  return expression.split('*')
    .reduce((total, part) => total * Number(part.trim().replace(/_/g, '')), 1);
}

describe('the catalogue describes the bundle that exists', () => {
  it('lists assets/DOWNLOAD.md and says what it is for', () => {
    const entry = BUNDLE_CONTENTS.find((f) => f.path === 'assets/DOWNLOAD.md');
    expect(entry, 'the bundle can contain assets/DOWNLOAD.md and the console must say so').toBeDefined();
    // Not "a file exists" but "an operator reading this knows what the
    // customer will find": that it is conditional, that it carries a link,
    // that the link dies, and what to do then.
    expect(entry!.what).toMatch(/only when|missing|did not fit/i);
    expect(entry!.why).toMatch(/link/i);
    expect(entry!.why).toMatch(/24 hours/i);
    expect(entry!.why).toMatch(/export again/i);
    expect(entry!.why).toMatch(/SHA-256/);
  });

  it('never promises a background export anywhere in the catalogue', () => {
    const text = `${JSON.stringify(BUNDLE_CONTENTS)} ${PERMANENCE_PROMISE.join(' ')}`;
    expect(text).not.toMatch(QUEUE_LANGUAGE);
  });

  it('still names every file the exporter writes unconditionally', () => {
    const paths = BUNDLE_CONTENTS.map((f) => f.path);
    for (const required of [
      'viewer.html', 'world.json', 'floorplan.svg', 'assets/', 'manifest.json',
      'CHECKSUMS.sha256', 'README.txt',
    ]) {
      expect(paths, required).toContain(required);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every entry both a what and a why', () => {
    for (const file of BUNDLE_CONTENTS) {
      expect(file.what.length, file.path).toBeGreaterThan(0);
      expect(file.why.length, file.path).toBeGreaterThan(0);
    }
  });
});

describe('the queue predicate is gone rather than deprecated', () => {
  it('exports nothing a caller could use to ask about queueing', () => {
    expect('willQueue' in bundleModule).toBe(false);
    expect(Object.keys(bundleModule).filter((k) => /queue/i.test(k))).toEqual([]);
  });
});

describe('the numbers this package repeats from wv-export', () => {
  it('pins the inline budget and the link life', () => {
    // Pinned as literals so that changing either one here is a deliberate act
    // with a failing test attached, exactly as USD_TO_GBP is pinned in
    // spend.test.ts. The mirror test below is what proves they are still the
    // edge function's numbers.
    expect(INLINE_EXPORT_BUDGET_BYTES).toBe(180 * 1024 * 1024);
    expect(OMITTED_ASSET_LINK_TTL_HOURS).toBe(24);
  });

  it('matches the budget the exporter actually enforces', async ({ skip }) => {
    const src = await readOrNull(HANDLER);
    if (src === null) skip();
    expect(
      productOf(src!, 'INLINE_ASSET_BUDGET_BYTES'),
      'wv-export no longer declares INLINE_ASSET_BUDGET_BYTES; this mirror is broken',
    ).toBe(INLINE_EXPORT_BUDGET_BYTES);
  });

  it('matches the link life the exporter actually signs', async ({ skip }) => {
    const src = await readOrNull(HANDLER);
    if (src === null) skip();
    expect(
      productOf(src!, 'OMITTED_ASSET_URL_TTL_SECONDS'),
      'wv-export no longer declares OMITTED_ASSET_URL_TTL_SECONDS; this mirror is broken',
    ).toBe(OMITTED_ASSET_LINK_TTL_HOURS * 60 * 60);
  });

  it('is describing a function that returns a bundle and queues nothing', async ({ skip }) => {
    const src = await readOrNull(HANDLER);
    if (src === null) skip();
    // The catalogue's promise — a bundle now, links for what did not fit — is
    // only true while the function answers this way. If an export job is ever
    // enqueued again, every sentence above becomes wrong at once.
    expect(src!).toMatch(/queued:\s*false/);
    expect(src!).not.toMatch(/insert\(\s*['"]wv_job['"]/);
  });

  it('is describing a bundle that really contains assets/DOWNLOAD.md', async ({ skip }) => {
    const src = await readOrNull(SERVER_BUNDLE);
    if (src === null) skip();
    expect(src!).toContain('assets/DOWNLOAD.md');
  });
});

describe('warning an operator before they build', () => {
  it('is true above the budget, where an asset cannot possibly fit', () => {
    expect(willLinkAssets(INLINE_EXPORT_BUDGET_BYTES + 1)).toBe(true);
    expect(willLinkAssets(3 * 1024 * 1024 * 1024)).toBe(true);
  });

  it('is false at and below the budget, which is not a promise that all of it fits', () => {
    expect(willLinkAssets(INLINE_EXPORT_BUDGET_BYTES)).toBe(false);
    expect(willLinkAssets(INLINE_EXPORT_BUDGET_BYTES - 1)).toBe(false);
    expect(willLinkAssets(0)).toBe(false);
  });

  it('says nothing about a world with no assets recorded', () => {
    // A world with nothing in wv_asset is not a world whose assets all fit; it
    // is a world with nothing to package, and the export button is disabled on
    // assetCount rather than on this.
    expect(willLinkAssets(0)).toBe(false);
  });
});

describe('the shape wv-export returns for an omitted asset', () => {
  /**
   * These two literals are the point of the test file as far as `api.ts` goes.
   * Vitest strips types, so nothing below asserts the widening at run time —
   * `tsc -b packages/console-ui` does, because this file is inside `src`. A
   * type that still said `{ role, bytes, reason }` would fail the build here
   * rather than silently discard the link the server sent.
   */
  const linked: OmittedAsset = {
    role: 'pointcloud',
    bytes: 3_221_225_472,
    reason: 'too large to package inline',
    format: 'ply',
    checksum: 'a'.repeat(64),
    url: 'https://storage.example.invalid/wv-assets/pointcloud.ply?token=signed',
    expiresAt: '2026-09-21T09:00:00.000Z',
  };

  const unlinked: OmittedAsset = {
    role: 'splat',
    bytes: 0,
    reason: 'could not be read from storage',
    format: null,
    checksum: null,
    url: null,
    expiresAt: null,
  };

  it('carries the link and the moment it dies', () => {
    expect(linked.url).toContain('pointcloud.ply');
    expect(linked.expiresAt).toBe('2026-09-21T09:00:00.000Z');
    expect(linked.checksum).toHaveLength(64);
  });

  it('expresses an asset for which no link could be issued', () => {
    // Absent and null mean the same thing, and both mean "there is no link".
    // The renderer keys off `url` alone, so an expiry must never survive it.
    expect(unlinked.url).toBeNull();
    expect(unlinked.expiresAt).toBeNull();
    expect(unlinked.reason.length).toBeGreaterThan(0);
  });

  it('is what a whole export result now looks like', () => {
    const built: ExportResult = {
      queued: false,
      url: 'https://storage.example.invalid/wv-exports/bundle.zip?token=signed',
      bytes: 26_114_880,
      checksum: 'b'.repeat(64),
      files: [{ path: 'assets/DOWNLOAD.md', bytes: 1_204 }],
      omittedAssets: [linked, unlinked],
      expiresInSeconds: OMITTED_ASSET_LINK_TTL_HOURS * 60 * 60,
    };
    expect(built.queued).toBe(false);
    expect(built.omittedAssets).toHaveLength(2);
    // One of the two is the case that needs a human, and it has to be
    // distinguishable without inspecting anything but `url`.
    expect((built.omittedAssets ?? []).filter((a) => !a.url)).toHaveLength(1);
    expect(built.expiresInSeconds).toBe(86_400);
  });
});
