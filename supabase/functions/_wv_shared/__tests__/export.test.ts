/**
 * THE EXPORT CONTRACT.
 *
 * `wv-export` is where the permanence promise is either kept or broken, so
 * these tests are written against the promise rather than against the code:
 * a customer asks for their property and receives it, every time, whatever
 * size it is, and is told the exact truth about what they got.
 *
 * The bug this file exists to prevent from returning: a world whose assets
 * exceeded the inline budget used to get 202, an `export` job row and the
 * sentence "it is being packaged in the background". `wv-jobs` hands out
 * thirteen pipeline stages and `export` is not one of them, so the job was
 * unclaimable, nothing ever packaged anything, and the customer waited for a
 * file that was never coming. Nothing errored. Nothing alerted. The only
 * symptom was a person who never got their bundle.
 *
 * So the central assertion here is a NEGATIVE one -- `wv_job` stays empty --
 * paired with a positive one: the oversize world gets a real bundle, with the
 * world document inside it and a signed link for every file too large to
 * travel in a zip. A test that only checked the response was 200 would pass
 * against a handler that had quietly gone back to queueing.
 */

import { describe, expect, it } from 'vitest';

import { handleExport, type ExportDeps } from '../../wv-export/handler.ts';
import { readWorldDocument } from '../worldDocument.ts';
import type { HttpRequest } from '../http.ts';
import { crc32, sha256Hex } from '../zip.ts';
import { type TestDeps, bearer, makeTestDeps, seedTenant } from './fakes.ts';

/** Caller ids are compared as strings, but real ones are uuids, so these are. */
const OWNER = '00000000-0000-4000-8000-00000000d001';
const STRANGER = '00000000-0000-4000-8000-00000000d002';

const EXPORTED_AT = '2026-09-20T12:00:00.000Z';
/** 24 hours after EXPORTED_AT: the expiry every link in a bundle carries. */
const LINK_DIES_AT = '2026-09-21T12:00:00.000Z';

function post(body: Record<string, unknown>, headers: Record<string, string> = {}): HttpRequest {
  return { method: 'POST', path: '/', query: {}, headers, body };
}

/**
 * The same wiring `wv-export/index.ts` uses, and it has to stay the same.
 *
 * The handler takes its document from an injected function; production injects
 * `readWorldDocument`, which serves the cached object and re-renders only when
 * the cache is absent, stale or unreadable. Injecting a canned document here
 * would make these tests pass whichever of the two the function was wired to,
 * and the cache tests at the bottom of this file would be testing nothing.
 */
function exportDeps(deps: TestDeps): ExportDeps {
  return {
    ...deps,
    buildWorldDocument: (worldId: string) => readWorldDocument(deps, worldId).then((r) => r.document),
  };
}

function rig() {
  const deps = makeTestDeps({
    users: { 'owner-token': OWNER, 'stranger-token': STRANGER },
    now: EXPORTED_AT,
  });
  const tenant = seedTenant(deps.db, { userId: OWNER, role: 'owner', label: 'Flat 2, 14 Example Road' });
  // One real room, so the floorplan and the viewer have something to draw and
  // world.json is a document rather than a shell.
  deps.db.seed('wv_room', [{
    id: deps.db.nextId(), world_id: tenant.worldId, stable_key: 'living', name: 'Living room',
    kind: 'living', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], floor_z: 0, ceiling_z: 2.4,
    area_m2: 12, area_standard: 'RICS-COMP-GIA', area_tol_pct: 2.5, wall_tol_mm: 20,
    provenance: 'reconstructed', confidence: 0.93,
  }]);
  return { deps, tenant };
}

/**
 * Seed one asset row, and optionally the object behind it.
 *
 * `declaredBytes` is deliberately separate from the object's real length: the
 * handler decides what to inline from the row's recorded size BEFORE it
 * downloads anything, which is the only way a three-gigabyte splat can be
 * refused without first being pulled into memory. Tests exercise that path by
 * declaring a size no test machine should ever have to allocate.
 */
function seedAsset(
  deps: TestDeps, worldId: string,
  opts: {
    role: string; format: string; path: string; declaredBytes: number;
    body?: string; checksum?: string; unreadable?: boolean;
  },
): string {
  const id = deps.db.nextId();
  deps.db.seed('wv_asset', [{
    id, world_id: worldId, role: opts.role, format: opts.format,
    storage_path: opts.path, bytes: opts.declaredBytes,
    checksum: opts.checksum ?? null, chunk_key: null, lod: 0, meta: {},
  }]);
  if (opts.body !== undefined) deps.storage.put('wv-assets', opts.path, opts.body);
  if (opts.unreadable) deps.storage.unreadable.add(`wv-assets/${opts.path}`);
  return id;
}

/** The archive the handler wrote, straight out of storage. */
function exportedZip(deps: TestDeps): Uint8Array {
  const key = [...deps.storage.objects.keys()].find((k) => k.startsWith('wv-exports/'));
  if (!key) throw new Error('no export was written to wv-exports');
  return deps.storage.objects.get(key)!.bytes;
}

/**
 * Read a STORE-only zip back.
 *
 * Deliberately not the writer's own tables run backwards: this walks the local
 * file headers the way a stock unzip does, so a bundle that only this
 * repository can open would fail here rather than pass.
 */
function unzip(zip: Uint8Array): Map<string, { bytes: Uint8Array; crc: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, { bytes: Uint8Array; crc: number }>();
  let at = 0;
  while (at + 30 <= zip.length && view.getUint32(at, true) === 0x0403_4B50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 22, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const dataAt = at + 30 + nameLen + extraLen;
    out.set(name, { bytes: zip.subarray(dataAt, dataAt + size), crc });
    at = dataAt + size;
  }
  return out;
}

function text(files: Map<string, { bytes: Uint8Array }>, path: string): string {
  const entry = files.get(path);
  if (!entry) throw new Error(`bundle has no ${path}: ${[...files.keys()].join(', ')}`);
  return new TextDecoder().decode(entry.bytes);
}

interface ExportBody {
  queued: boolean;
  url: string;
  bytes: number;
  checksum: string;
  files: { path: string; bytes: number }[];
  omittedAssets: {
    role: string; bytes: number; reason: string;
    format: string | null; checksum: string | null; url: string | null; expiresAt: string | null;
  }[];
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// A world small enough to travel whole
// ---------------------------------------------------------------------------

describe('a world that fits inside the budget', () => {
  async function smallExport() {
    const { deps, tenant } = rig();
    seedAsset(deps, tenant.worldId, {
      role: 'cover', format: 'jpg', path: `${tenant.worldId}/cover.jpg`,
      declaredBytes: 40_000, body: 'jpeg-ish bytes',
    });
    seedAsset(deps, tenant.worldId, {
      role: 'proxy_mesh', format: 'glb', path: `${tenant.worldId}/proxy.glb`,
      declaredBytes: 900_000, body: 'glTF-ish bytes',
    });
    const res = await handleExport(
      post({ worldId: tenant.worldId }, bearer('owner-token')), exportDeps(deps),
    );
    return { deps, tenant, res, body: res.body as ExportBody };
  }

  it('returns a bundle with every file a customer needs', async () => {
    const { res, body } = await smallExport();
    expect(res.status).toBe(200);
    expect(body.queued).toBe(false);
    expect(body.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresInSeconds).toBe(24 * 60 * 60);

    const paths = body.files.map((f) => f.path);
    for (const required of [
      'world.json', 'floorplan.svg', 'viewer.html', 'README.txt',
      'manifest.json', 'CHECKSUMS.sha256',
    ]) {
      expect(paths, `${required} missing from the bundle`).toContain(required);
    }
    // The name carries the role and the level of detail, not the storage
    // path: a customer should be able to tell what a file is without opening
    // the manifest.
    expect(paths).toContain('assets/cover-lod0.jpg');
    expect(paths).toContain('assets/proxy_mesh-lod0.glb');
    // Nothing was left out, so there is nothing to explain.
    expect(paths).not.toContain('assets/DOWNLOAD.md');
    expect(body.omittedAssets).toEqual([]);
  });

  it('stores the archive and records the export', async () => {
    const { deps, tenant } = await smallExport();
    const exports = deps.db.rows('wv_export');
    expect(exports).toHaveLength(1);
    expect(exports[0]!['world_id']).toBe(tenant.worldId);
    expect(String(exports[0]!['checksum'])).toMatch(/^[0-9a-f]{64}$/);
    expect([...deps.storage.objects.keys()].some((k) => k.startsWith('wv-exports/'))).toBe(true);
  });

  it('queues nothing, because nothing else has to happen', async () => {
    const { deps } = await smallExport();
    expect(deps.db.rows('wv_job')).toEqual([]);
  });

  it('inlines the small useful files before the large archival ones', async () => {
    const { deps, tenant } = rig();
    // Seeded worst-first, so a handler that simply took the rows in order
    // would fail this.
    seedAsset(deps, tenant.worldId, { role: 'pointcloud', format: 'ply', path: `${tenant.worldId}/cloud.ply`, declaredBytes: 40_000_000, body: 'ply' });
    seedAsset(deps, tenant.worldId, { role: 'splat', format: 'spz', path: `${tenant.worldId}/scan.spz`, declaredBytes: 20_000_000, body: 'spz' });
    seedAsset(deps, tenant.worldId, { role: 'visual_mesh', format: 'glb', path: `${tenant.worldId}/visual.glb`, declaredBytes: 5_000_000, body: 'glb' });
    seedAsset(deps, tenant.worldId, { role: 'proxy_mesh', format: 'glb', path: `${tenant.worldId}/proxy.glb`, declaredBytes: 400_000, body: 'glb' });
    seedAsset(deps, tenant.worldId, { role: 'cover', format: 'jpg', path: `${tenant.worldId}/cover.jpg`, declaredBytes: 40_000, body: 'jpg' });

    const res = await handleExport(
      post({ worldId: tenant.worldId }, bearer('owner-token')), exportDeps(deps),
    );
    const body = res.body as ExportBody;
    const order = body.files.map((f) => f.path).filter((p) => p.startsWith('assets/'));
    expect(order).toEqual([
      'assets/cover-lod0.jpg',
      'assets/proxy_mesh-lod0.glb',
      'assets/visual_mesh-lod0.glb',
      'assets/splat-lod0.spz',
      'assets/pointcloud-lod0.ply',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A world too large to travel whole -- the live bug
// ---------------------------------------------------------------------------

describe('a world with an asset too large to package', () => {
  async function oversizeExport() {
    const { deps, tenant } = rig();
    seedAsset(deps, tenant.worldId, {
      role: 'cover', format: 'jpg', path: `${tenant.worldId}/cover.jpg`,
      declaredBytes: 40_000, body: 'jpeg-ish bytes',
    });
    // Three gigabytes, declared and never allocated. The object is not seeded
    // at all: if the handler tried to download it before checking the declared
    // size, the reason below would say "could not be read from storage".
    seedAsset(deps, tenant.worldId, {
      role: 'splat', format: 'spz', path: `${tenant.worldId}/scan.spz`,
      declaredBytes: 3 * 1024 * 1024 * 1024,
      checksum: 'a'.repeat(64),
    });
    const res = await handleExport(
      post({ worldId: tenant.worldId }, bearer('owner-token')), exportDeps(deps),
    );
    return { deps, tenant, res, body: res.body as ExportBody };
  }

  it('queues no job at all', async () => {
    const { deps, res, body } = await oversizeExport();
    // The regression test. An `export` job is unclaimable: wv-jobs hands out
    // thirteen pipeline stages and this is not one of them, so a row here is a
    // customer waiting forever for a bundle nothing will ever build.
    expect(deps.db.rows('wv_job')).toEqual([]);
    expect(res.status).toBe(200);
    expect(body.queued).toBe(false);
    expect(deps.logs.some((l) => l.event === 'wv_export_queued')).toBe(false);
  });

  it('still delivers the world document, the floorplan and the viewer', async () => {
    const { deps } = await oversizeExport();
    const files = unzip(exportedZip(deps));
    const doc = JSON.parse(text(files, 'world.json')) as Record<string, unknown>;
    expect(doc['formatVersion']).toBe(1);
    expect((doc['rooms'] as unknown[]).length).toBe(1);
    expect(text(files, 'floorplan.svg')).toContain('<svg');
    expect(text(files, 'viewer.html')).toContain('<script type="application/json" id="world">');
    // The small asset still travelled; only the 3 GB one did not.
    expect(files.has('assets/cover-lod0.jpg')).toBe(true);
    expect(files.has('assets/splat-lod0.spz')).toBe(false);
  });

  it('signs a 24-hour link for the file that did not fit', async () => {
    const { deps, tenant, body } = await oversizeExport();
    expect(body.omittedAssets).toHaveLength(1);
    const splat = body.omittedAssets[0]!;
    expect(splat.role).toBe('splat');
    expect(splat.format).toBe('spz');
    expect(splat.checksum).toBe('a'.repeat(64));
    expect(splat.bytes).toBe(3 * 1024 * 1024 * 1024);
    // Refused on its declared size, before any attempt to read it.
    expect(splat.reason).toMatch(/too large/);
    expect(splat.url).toContain(`${tenant.worldId}/scan.spz`);
    expect(splat.expiresAt).toBe(LINK_DIES_AT);

    const signed = deps.storage.signed.filter((s) => s.path === `${tenant.worldId}/scan.spz`);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.bucket).toBe('wv-assets');
    expect(signed[0]!.seconds).toBe(24 * 60 * 60);
    expect(signed[0]!.kind).toBe('read');
  });

  it('explains the missing file in assets/DOWNLOAD.md', async () => {
    const { deps, body } = await oversizeExport();
    const files = unzip(exportedZip(deps));
    const md = text(files, 'assets/DOWNLOAD.md');

    expect(md).toContain('splat');
    expect(md).toContain(body.omittedAssets[0]!.url!);
    expect(md).toContain(LINK_DIES_AT);
    expect(md).toContain('a'.repeat(64));
    // Why it is not here, in words a customer can act on.
    expect(md).toMatch(/memory budget/);
    // What to do once the link is dead.
    expect(md).toMatch(/export the property again|export\s+the property again/);
    // And the reassurance that has to be there, or the note reads as a defect
    // report on the bundle the customer is holding.
    expect(md).toContain('This bundle is complete without those files');
    expect(md).toContain('world.json');
  });

  it('records the same list in manifest.json and the README', async () => {
    const { deps } = await oversizeExport();
    const files = unzip(exportedZip(deps));
    const manifest = JSON.parse(text(files, 'manifest.json')) as {
      omittedAssets: { role: string; url: string | null; expiresAt: string | null; checksum: string | null }[];
      files: { path: string }[];
    };
    expect(manifest.omittedAssets).toHaveLength(1);
    expect(manifest.omittedAssets[0]!.role).toBe('splat');
    expect(manifest.omittedAssets[0]!.url).toContain('scan.spz');
    expect(manifest.omittedAssets[0]!.expiresAt).toBe(LINK_DIES_AT);
    // DOWNLOAD.md is part of the record, not a loose note beside it.
    expect(manifest.files.map((f) => f.path)).toContain('assets/DOWNLOAD.md');

    const readme = text(files, 'README.txt');
    expect(readme).toContain('ASSETS NOT INCLUDED');
    expect(readme).toContain('assets/DOWNLOAD.md');
    // Gigabytes, not four digits of megabytes: this list is read by a person
    // deciding whether to start a download.
    expect(readme).toContain('3.0 GB');
  });
});

// ---------------------------------------------------------------------------
// Storage misbehaving
// ---------------------------------------------------------------------------

describe('an asset that cannot be read', () => {
  async function brokenAssetExport() {
    const { deps, tenant } = rig();
    seedAsset(deps, tenant.worldId, {
      role: 'cover', format: 'jpg', path: `${tenant.worldId}/cover.jpg`,
      declaredBytes: 40_000, body: 'jpeg-ish bytes',
    });
    seedAsset(deps, tenant.worldId, {
      role: 'splat', format: 'spz', path: `${tenant.worldId}/scan.spz`,
      declaredBytes: 20_000, body: 'spz bytes', unreadable: true,
    });
    const res = await handleExport(
      post({ worldId: tenant.worldId }, bearer('owner-token')), exportDeps(deps),
    );
    return { deps, tenant, res, body: res.body as ExportBody };
  }

  it('reports it and exports everything else anyway', async () => {
    const { deps, res, body } = await brokenAssetExport();
    expect(res.status).toBe(200);
    expect(body.omittedAssets).toHaveLength(1);
    expect(body.omittedAssets[0]!.reason).toMatch(/storage/);
    expect(deps.logs.some((l) => l.event === 'wv_export_asset_failed')).toBe(true);

    const files = unzip(exportedZip(deps));
    expect(files.has('assets/cover-lod0.jpg')).toBe(true);
    expect(files.has('world.json')).toBe(true);
  });

  it('says no link could be issued rather than inventing one', async () => {
    const { deps, body } = await brokenAssetExport();
    // FakeStorage fails signing for the same object it fails to download, so
    // this is the path where the handler has nothing at all to offer.
    expect(body.omittedAssets[0]!.url).toBeNull();
    expect(body.omittedAssets[0]!.expiresAt).toBeNull();
    expect(deps.logs.some((l) => l.event === 'wv_export_sign_failed')).toBe(true);

    const md = text(unzip(exportedZip(deps)), 'assets/DOWNLOAD.md');
    expect(md).toContain('no link could be issued');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('null');
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe('a caller from outside the org', () => {
  it('gets 404, and no bundle is built at all', async () => {
    const { deps, tenant } = rig();
    seedAsset(deps, tenant.worldId, {
      role: 'cover', format: 'jpg', path: `${tenant.worldId}/cover.jpg`,
      declaredBytes: 40_000, body: 'jpeg-ish bytes',
    });

    const res = await handleExport(
      post({ worldId: tenant.worldId }, bearer('stranger-token')), exportDeps(deps),
    );
    // Not 403: "this world is not yours" and "this world does not exist" must
    // be indistinguishable, or the endpoint enumerates every customer's
    // portfolio one uuid at a time.
    expect(res.status).toBe(404);
    expect(deps.db.rows('wv_export')).toEqual([]);
    expect([...deps.storage.objects.keys()].some((k) => k.startsWith('wv-exports/'))).toBe(false);
    // Nothing was signed, so nothing leaked even as a URL.
    expect(deps.storage.signed).toEqual([]);
    expect(deps.logs.some((l) => l.event === 'wv_export_cross_tenant_denied')).toBe(true);
  });

  it('refuses an anonymous caller before it touches the database', async () => {
    const { deps, tenant } = rig();
    const res = await handleExport(post({ worldId: tenant.worldId }), exportDeps(deps));
    expect(res.status).toBe(401);
    expect(deps.db.calls.filter((c) => c.op !== 'select' || c.table !== 'wv_member')).not.toContainEqual(
      expect.objectContaining({ op: 'select', table: 'wv_asset' }),
    );
  });
});

// ---------------------------------------------------------------------------
// The checksums have to be checksums of what is actually there
// ---------------------------------------------------------------------------

describe('CHECKSUMS.sha256', () => {
  it('matches the bytes actually written into the zip', async () => {
    const { deps, tenant } = rig();
    seedAsset(deps, tenant.worldId, {
      role: 'cover', format: 'jpg', path: `${tenant.worldId}/cover.jpg`,
      declaredBytes: 40_000, body: 'jpeg-ish bytes',
    });
    seedAsset(deps, tenant.worldId, {
      role: 'pointcloud', format: 'ply', path: `${tenant.worldId}/cloud.ply`,
      declaredBytes: 9 * 1024 * 1024 * 1024,
    });

    await handleExport(post({ worldId: tenant.worldId }, bearer('owner-token')), exportDeps(deps));
    const zip = exportedZip(deps);
    const files = unzip(zip);

    // Parsed the way `sha256sum -c` parses it: "<hex>  <path>".
    const sums = new Map<string, string>();
    for (const line of text(files, 'CHECKSUMS.sha256').split('\n')) {
      if (!line.trim()) continue;
      const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
      expect(m, `unparseable checksum line: ${line}`).not.toBeNull();
      sums.set(m![2]!, m![1]!);
    }

    // Every file it names is in the archive and hashes to what it claims.
    for (const [path, expected] of sums) {
      const entry = files.get(path);
      expect(entry, `CHECKSUMS names ${path}, which is not in the zip`).toBeDefined();
      expect(await sha256Hex(entry!.bytes), path).toBe(expected);
      // And the zip's own integrity check agrees, so an unzip tool that never
      // reads CHECKSUMS still catches a corrupted entry.
      expect(crc32(entry!.bytes), `crc mismatch for ${path}`).toBe(entry!.crc);
    }

    // The two files that cannot checksum themselves are the only omissions:
    // manifest.json contains the list, and CHECKSUMS.sha256 IS the list.
    const unchecksummed = [...files.keys()].filter((p) => !sums.has(p));
    expect(unchecksummed.sort()).toEqual(['CHECKSUMS.sha256', 'manifest.json']);
    expect(sums.has('assets/DOWNLOAD.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The document comes from the cache (P2.14)
// ---------------------------------------------------------------------------

describe('the world document behind an export', () => {
  /** A cached document that is visibly not what a fresh render would produce. */
  const CACHED = JSON.stringify({
    formatVersion: 1, id: 'cached', label: 'SERVED FROM CACHE',
    rooms: [], entities: [], regions: [], assets: [], floors: [], surfaces: [],
    openings: [], relationships: [], cameras: [], nav: { nodes: [], edges: [] },
    measurementPolicy: { areaStandard: 'RICS-COMP-GIA', areaTolerancePct: 3, wallToleranceMm: 25 },
  });

  function withCache(stale: boolean) {
    const { deps, tenant } = rig();
    const path = `${tenant.worldId}/world.json`;
    deps.db.seed('wv_asset', [{
      id: deps.db.nextId(), world_id: tenant.worldId, role: 'export_bundle', format: 'json',
      storage_path: path, bytes: CACHED.length, checksum: null, lod: 0,
      chunk_key: 'world-document', meta: { stale },
    }]);
    deps.storage.put('wv-assets', path, CACHED);
    return { deps, tenant, path };
  }

  it('is served from the cache when the cached object is fresh', async () => {
    const { deps, tenant, path } = withCache(false);
    const before = deps.storage.objects.get(`wv-assets/${path}`)!.bytes;

    const res = await handleExport(
      post({ worldId: tenant.worldId }, bearer('owner-token')), exportDeps(deps),
    );
    expect(res.status).toBe(200);

    // Nothing re-rendered: no render log, and the cached object was not
    // rewritten. An upload here would mean the export had paid for thirteen
    // selects and a write it did not need.
    expect(deps.logs.some((l) => l.event === 'wv_document_rendered')).toBe(false);
    expect(deps.storage.objects.get(`wv-assets/${path}`)!.bytes).toBe(before);

    // And the bundle really does contain that document rather than a fresh one
    // that happens to look similar.
    const doc = JSON.parse(text(unzip(exportedZip(deps)), 'world.json')) as Record<string, unknown>;
    expect(doc['label']).toBe('SERVED FROM CACHE');
  });

  it('is re-rendered when a correction has marked the cache stale', async () => {
    const { deps, tenant } = withCache(true);
    const res = await handleExport(
      post({ worldId: tenant.worldId }, bearer('owner-token')), exportDeps(deps),
    );
    expect(res.status).toBe(200);
    expect(deps.logs.some((l) => l.event === 'wv_document_rendered')).toBe(true);

    // The stale copy is gone from the bundle and from storage, replaced by the
    // rows' own answer: one room, and the property's real label.
    const doc = JSON.parse(text(unzip(exportedZip(deps)), 'world.json')) as Record<string, unknown>;
    expect(doc['label']).toBe('Flat 2, 14 Example Road');
    expect((doc['rooms'] as unknown[]).length).toBe(1);
  });
});
