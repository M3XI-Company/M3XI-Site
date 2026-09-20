/**
 * Rebuild a WorldDocument from its rows.
 *
 * The database is the world; the WorldDocument is the shape every other
 * package compiles against. This is the one place the two are reconciled, so
 * that wv-ask and wv-export cannot drift into describing the same property
 * differently -- which, in a product whose whole claim is that the numbers are
 * defensible, would be the worst possible bug.
 *
 * Every numeric column arrives from PostgREST as a string when it is a
 * `numeric`, so everything is coerced explicitly. A silent NaN here becomes a
 * refused measurement downstream, which is safe but useless.
 */

import type { Db, Row, Storage } from './deps.ts';
import { deterministicId } from './ids.ts';
import { sha256Hex, utf8 } from './zip.ts';

/**
 * Where the rendered document lives, and how it is recognised.
 *
 * The rendered document is itself a `wv_asset`, because it is a file in the
 * world's own storage prefix and everything else in that prefix is one. It
 * takes the `export_bundle` role rather than a new one: `AssetRole` in
 * world-core/src/types.ts is the contract and is not ours to extend, and a
 * role the contract does not know would make every document that listed it
 * invalid.
 *
 * The two reserved chunk keys are how the renderer tells its own container
 * from the world's content:
 *
 *   world-document  the rendered document. Listing it inside itself would mean
 *                   a checksum that can never settle, because writing the file
 *                   changes the row that the next render would include.
 *   world-raw       build/world.raw.json, the pipeline's assembled copy. It is
 *                   kept for diffing a build against what the database says,
 *                   and it is deliberately NOT what anything reads.
 */
export const ASSET_BUCKET = 'wv-assets';
export const DOCUMENT_ASSET_ROLE = 'export_bundle';
export const DOCUMENT_CHUNK_KEY = 'world-document';
export const RAW_DOCUMENT_CHUNK_KEY = 'world-raw';
export const DOCUMENT_OBJECT_NAME = 'world.json';
export const RAW_DOCUMENT_OBJECT_NAME = 'build/world.raw.json';

const RESERVED_CHUNK_KEYS: ReadonlySet<string> = new Set([
  DOCUMENT_CHUNK_KEY, RAW_DOCUMENT_CHUNK_KEY,
]);

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNum(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function vec3(v: unknown): [number, number, number] {
  return Array.isArray(v) && v.length === 3
    ? [num(v[0]), num(v[1]), num(v[2])]
    : [0, 0, 0];
}

function ring(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const p of v) {
    if (Array.isArray(p) && p.length >= 2) out.push([num(p[0]), num(p[1])]);
  }
  return out;
}

function provenance(v: unknown): 'observed' | 'reconstructed' | 'inferred' | 'generated' {
  return v === 'observed' || v === 'reconstructed' || v === 'inferred' || v === 'generated'
    ? v : 'inferred';
}

/**
 * Worst wins, matching weakestProvenance() in world-core/src/types.ts.
 *
 * Reimplemented here rather than imported because _wv_shared deliberately has
 * no dependency on the workspace packages: these files must run in Deno from
 * source, and importing the built package would put `npm run build` between a
 * migration and a working viewer.
 */
const PROVENANCE_RANK: Record<string, number> = {
  observed: 0, reconstructed: 1, inferred: 2, generated: 3,
};

type Provenance = 'observed' | 'reconstructed' | 'inferred' | 'generated';

function weakestProvenance(...p: readonly string[]): Provenance {
  let out: Provenance = 'observed';
  for (const q of p) {
    if ((PROVENANCE_RANK[q] ?? 3) > PROVENANCE_RANK[out]!) out = provenance(q);
  }
  return out;
}

/**
 * The grounding of a number that metric scale had a hand in.
 *
 * A room polygon is `reconstructed`, but the AREA computed from it is only as
 * good as the metre it was measured with, and no camera measured a metre. So
 * every derived quantity carries the weaker of its geometry's provenance and
 * the scale's, and the lower of the two confidences. Dropping this and
 * reporting the geometry's own provenance would publish an `inferred` number
 * wearing a `reconstructed` label, which is the one collapse types.ts exists
 * to forbid.
 *
 * It carries no `sources`, and that is deliberate. `correction_sources` is a
 * receipt for the ROW, not for one field of it: an operator who renamed a room
 * leaves a token on the room, and stamping that token onto the room's AREA
 * would tell `isHumanCorrected()` that a person declared a figure nobody
 * touched, which is the same class of lie in the opposite direction. What a
 * correction to the geometry DOES do to this quantity travels through
 * `row.provenance`, which rule 3 floors at 'inferred' -- so the number widens
 * and stops being defensible without ever claiming to have been measured by
 * hand. A dimension that really was declared by a person is a wv_measurement
 * row carrying its own basis, and that is where its receipt lives.
 */
function scaledGrounding(
  row: Record<string, unknown>, scale: { provenance: Provenance; confidence: number },
) {
  return {
    provenance: weakestProvenance(provenance(row['provenance']), scale.provenance),
    confidence: Math.min(nullableNum(row['confidence']) ?? 0.5, scale.confidence),
  };
}

/**
 * The human-correction receipt a row carries, rendered as it is stored.
 *
 * `correction_sources` is `text[]` on wv_room, wv_entity, wv_surface and
 * wv_opening, holding the reserved tokens rule 4 of
 * spatial/packages/review/src/model/provenance.ts defines:
 * `correction:<record id>` and `operator:<who>`. Rendering them into
 * `Grounding.sources` is the whole point of the column -- without it
 * `isHumanCorrected()` can only answer "did a person touch this fact" for a
 * dimension, because the receipt for a dimension survived in
 * `wv_measurement.basis` and the receipt for a renamed room survived nowhere.
 *
 * Tokens are emitted verbatim and in stored order, and never invented here: a
 * receipt is evidence, and evidence that this function could synthesise would
 * be worth nothing. A row with an empty array renders exactly as it did before
 * the column existed -- no `sources` key at all.
 *
 * VERBATIM INCLUDES `operator:<user id>`, AND THAT NEEDS A BOUNDARY. This
 * document is read by wv-ask, packed into an agency's export, and served to the
 * public by wv-view's /world.json. The rendering is not the place to decide who
 * may see which half of a receipt -- one cached object serves all three, and
 * dropping the operator here would take it out of the export and the
 * certificate trail as well. wv-view is the function whose stated job is that
 * nothing internal leaves, and its FORBIDDEN_KEYS list already refuses
 * `created_by` and `reviewed_by` as keys; the same judgement applies to an
 * operator id arriving as a VALUE inside `sources`, and it belongs in the same
 * sweep. Flagged rather than silently done, because wv-view is not this file.
 */
function receipts(row: Record<string, unknown>): readonly string[] {
  const v = row['correction_sources'];
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * `sources` carries camera ids FIRST and correction receipts after.
 *
 * `cameraSourcesOf()` and `correctionIdsOf()` both read this list by prefix, so
 * either order is machine-readable; the order is fixed anyway because a person
 * reading a raw document should see what observed the fact before what argued
 * with it, and because appending is the only operation the receipt column ever
 * performs -- a render that reordered the list would make two renders of the
 * same rows differ, and the document's checksum is meant to mean something.
 *
 * Deduplicated, preserving first position: a token repeated in the column is a
 * write-side bug, and repeating it here would make `correctionIdsOf()` report
 * one correction twice.
 */
function grounding(row: Record<string, unknown>, cameraSources?: readonly string[]) {
  const sources: string[] = [];
  for (const s of [...(cameraSources ?? []), ...receipts(row)]) {
    if (!sources.includes(s)) sources.push(s);
  }
  const g: Record<string, unknown> = {
    provenance: provenance(row['provenance']),
    // A missing confidence is not 1.0. Defaulting optimistically is how an
    // unmeasured thing acquires an authoritative-looking number.
    confidence: nullableNum(row['confidence']) ?? 0.5,
  };
  if (sources.length > 0) g['sources'] = sources;
  return g;
}

function lengthQuantity(
  value: number | undefined, standard: string, toleranceMm: number,
  row: Record<string, unknown>, scale: { provenance: Provenance; confidence: number },
) {
  if (value === undefined) return undefined;
  return {
    value, unit: 'm', standard, tolerance: toleranceMm, toleranceUnit: 'mm',
    grounding: scaledGrounding(row, scale),
  };
}

export interface WorldDocumentOptions {
  /** Include camera poses. The public manifest does; an export does too. */
  readonly includeCameras?: boolean;
}

export async function buildWorldDocument(
  db: Db, worldId: string, opts: WorldDocumentOptions = {},
): Promise<Record<string, unknown>> {
  const worlds = await db.select('wv_world', {
    columns: ['id', 'property_id', 'version', 'slug', 'status', 'published_at', 'created_at',
      'scale_source', 'scale_agreement', 'scale_provenance', 'scale_confidence', 'quality_score'],
    eq: { id: worldId }, limit: 1,
  });
  const world = worlds[0];
  if (!world) throw new Error(`no world '${worldId}'`);

  const [properties, floors, rooms, surfaces, openings, entities, rels, navNodes, navEdges,
    regions, cameras, assets, quality] = await Promise.all([
    db.select('wv_property', { columns: ['id', 'label'], eq: { id: String(world['property_id']) }, limit: 1 }),
    db.select('wv_floor', { columns: ['id', 'level', 'name', 'elevation_m', 'provenance', 'confidence'], eq: { world_id: worldId } }),
    // The four correctable tables select `correction_sources` as well. A column
    // a handler does not select reads as undefined through PostgREST exactly as
    // it does through FakeDb, so forgetting one here would silently render a
    // corrected room as a pipeline-written one -- which is the failure this
    // column was added to end.
    db.select('wv_room', {
      columns: ['id', 'floor_id', 'stable_key', 'name', 'kind', 'polygon', 'floor_z', 'ceiling_z',
        'area_m2', 'area_standard', 'area_tol_pct', 'wall_tol_mm', 'provenance', 'confidence',
        'correction_sources'],
      eq: { world_id: worldId },
    }),
    db.select('wv_surface', {
      columns: ['id', 'room_id', 'kind', 'plane', 'polygon', 'area_m2', 'is_reflective', 'is_glazed',
        'provenance', 'confidence', 'correction_sources'],
      eq: { world_id: worldId },
    }),
    db.select('wv_opening', {
      columns: ['id', 'kind', 'surface_id', 'room_a', 'room_b', 'centre', 'normal', 'width_m',
        'height_m', 'sill_m', 'provenance', 'confidence', 'correction_sources'],
      eq: { world_id: worldId },
    }),
    db.select('wv_entity', {
      columns: ['id', 'stable_key', 'label', 'category', 'room_id', 'centroid', 'aabb', 'obb',
        'observed_in', 'provenance', 'confidence', 'attributes', 'correction_sources'],
      eq: { world_id: worldId },
    }),
    db.select('wv_relationship', {
      columns: ['subject_type', 'subject_id', 'predicate', 'object_type', 'object_id', 'value',
        'provenance', 'confidence'],
      eq: { world_id: worldId },
    }),
    db.select('wv_nav_node', {
      columns: ['id', 'room_id', 'position', 'clearance_m', 'is_entrance', 'is_viewpoint'],
      eq: { world_id: worldId },
    }),
    db.select('wv_nav_edge', {
      columns: ['a', 'b', 'cost', 'width_m', 'kind', 'opening_id'], eq: { world_id: worldId },
    }),
    db.select('wv_region', {
      columns: ['id', 'provenance', 'volume', 'room_id', 'reason', 'confidence'], eq: { world_id: worldId },
    }),
    opts.includeCameras === false ? Promise.resolve([]) : db.select('wv_camera', {
      columns: ['id', 'capture_id', 'frame_index', 't_ms', 'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw',
        'intrinsics', 'pose_confidence', 'sharpness', 'room_id'],
      eq: { world_id: worldId },
    }),
    db.select('wv_asset', {
      columns: ['id', 'role', 'format', 'storage_path', 'bytes', 'checksum', 'lod', 'chunk_key', 'splat_count'],
      eq: { world_id: worldId },
    }),
    db.select('wv_quality', {
      columns: ['checks', 'score', 'verdict', 'created_at'], eq: { world_id: worldId },
      order: { column: 'created_at', ascending: false }, limit: 1,
    }),
  ]);

  // The measurement policy is declared once per world and applied to every
  // dimension. The schema denormalises it onto each room, and each room's
  // stored area_tol_pct is NOT the policy: the pipeline writes
  // max(policy, geometric), because a long thin room is more sensitive to a
  // wall-position error than a square one and quoting the policy figure there
  // would understate what the geometry supports.
  //
  // So the policy floor is recovered as the MINIMUM across rooms. Every stored
  // value is >= the policy, and any room that is not geometry-dominated stores
  // the policy exactly, so the minimum is the policy whenever at least one such
  // room exists -- which is every real property, because the alternative is a
  // building made entirely of corridors. Taking the first room's value instead
  // silently inflates every other room's tolerance to match the narrowest one.
  const areaTolerances = rooms
    .map((r) => nullableNum(r['area_tol_pct']))
    .filter((v): v is number => v !== undefined && v > 0);
  const wallTolerances = rooms
    .map((r) => nullableNum(r['wall_tol_mm']))
    .filter((v): v is number => v !== undefined && v > 0);
  const standardRoom = rooms.find((r) => typeof r['area_standard'] === 'string' && r['area_standard']);

  const measurementPolicy = {
    areaStandard: String(standardRoom?.['area_standard'] ?? 'CLEAR-INTERNAL'),
    areaTolerancePct: areaTolerances.length > 0 ? Math.min(...areaTolerances) : 3,
    wallToleranceMm: wallTolerances.length > 0 ? Math.min(...wallTolerances) : 25,
  };

  // Metric scale defaults to `inferred` and can never default to
  // `reconstructed`: monocular depth is a model's estimate of a metre, not a
  // triangulated one, and a world whose scale row predates the columns below
  // must degrade towards the weaker claim rather than the stronger.
  const scaleAgreement = nullableNum(world['scale_agreement']) ?? 0;
  const scaleGrounding = {
    provenance: provenance(world['scale_provenance'] ?? 'inferred'),
    confidence: nullableNum(world['scale_confidence']) ?? scaleAgreement,
  };

  return {
    formatVersion: 1,
    id: String(world['id']),
    propertyId: String(world['property_id']),
    version: num(world['version'], 1),
    slug: world['slug'] ?? undefined,
    label: String(properties[0]?.['label'] ?? 'Property'),
    createdAt: String(world['created_at'] ?? new Date(0).toISOString()),
    publishedAt: world['published_at'] ? String(world['published_at']) : undefined,

    units: { length: 'm', angle: 'rad' },
    upAxis: 'Y',
    handedness: 'right',

    scale: {
      source: String(world['scale_source'] ?? 'unrecorded'),
      agreement: scaleAgreement,
      grounding: { provenance: scaleGrounding.provenance, confidence: scaleGrounding.confidence },
    },

    floors: floors.map((f) => ({
      id: String(f['id']),
      level: num(f['level']),
      name: f['name'] ?? undefined,
      elevation: num(f['elevation_m']),
      grounding: grounding(f),
    })),

    rooms: rooms.map((r) => {
      const polygon = ring(r['polygon']);
      const areaValue = nullableNum(r['area_m2']) ?? 0;
      return {
        id: String(r['id']),
        stableKey: String(r['stable_key'] ?? r['id']),
        floorId: r['floor_id'] ?? undefined,
        name: r['name'] ?? undefined,
        kind: String(r['kind'] ?? 'unknown'),
        polygon,
        floorZ: nullableNum(r['floor_z']) ?? 0,
        ceilingZ: nullableNum(r['ceiling_z']) ?? 2.4,
        area: {
          value: areaValue,
          unit: 'm2',
          standard: String(r['area_standard'] ?? measurementPolicy.areaStandard),
          tolerance: nullableNum(r['area_tol_pct']) ?? measurementPolicy.areaTolerancePct,
          toleranceUnit: 'pct',
          // Weakened by the metre it was measured with. See scaledGrounding.
          grounding: scaledGrounding(r, scaleGrounding),
        },
        grounding: grounding(r),
      };
    }),

    surfaces: surfaces.map((s) => {
      const surfaceArea = nullableNum(s['area_m2']);
      return {
        id: String(s['id']),
        roomId: s['room_id'] ?? undefined,
        kind: String(s['kind'] ?? 'unknown'),
        plane: typeof s['plane'] === 'object' && s['plane'] !== null
          ? s['plane'] : { n: [0, 1, 0], d: 0 },
        polygon: Array.isArray(s['polygon']) ? (s['polygon'] as unknown[]).map(vec3) : [],
        isReflective: s['is_reflective'] === true,
        isGlazed: s['is_glazed'] === true,
        // A wall's area is measured wall-face to wall-face with no standard
        // implied -- it is not a habitable area and quoting GIA for it would
        // be a category error. The row has no standard column because there is
        // only ever one answer here.
        area: surfaceArea === undefined ? undefined : {
          value: surfaceArea,
          unit: 'm2',
          standard: 'CLEAR-INTERNAL',
          tolerance: measurementPolicy.areaTolerancePct,
          toleranceUnit: 'pct',
          grounding: scaledGrounding(s, scaleGrounding),
        },
        grounding: grounding(s),
      };
    }),

    openings: openings.map((o) => ({
      id: String(o['id']),
      kind: String(o['kind'] ?? 'doorway'),
      surfaceId: o['surface_id'] ?? undefined,
      roomA: o['room_a'] ?? undefined,
      roomB: o['room_b'] ?? undefined,
      centre: vec3(o['centre']),
      normal: o['normal'] ? vec3(o['normal']) : undefined,
      width: lengthQuantity(nullableNum(o['width_m']), 'CLEAR-INTERNAL', measurementPolicy.wallToleranceMm, o, scaleGrounding),
      height: lengthQuantity(nullableNum(o['height_m']), 'CLEAR-INTERNAL', measurementPolicy.wallToleranceMm, o, scaleGrounding),
      sill: lengthQuantity(nullableNum(o['sill_m']), 'CLEAR-INTERNAL', measurementPolicy.wallToleranceMm, o, scaleGrounding),
      grounding: grounding(o),
    })),

    entities: entities.map((e) => {
      const observedIn = Array.isArray(e['observed_in']) ? (e['observed_in'] as string[]) : [];
      return {
        id: String(e['id']),
        stableKey: String(e['stable_key'] ?? e['id']),
        label: String(e['label'] ?? 'object'),
        category: String(e['category'] ?? 'other'),
        roomId: e['room_id'] ?? undefined,
        centroid: vec3(e['centroid']),
        aabb: typeof e['aabb'] === 'object' && e['aabb'] !== null
          ? e['aabb'] : { min: [0, 0, 0], max: [0, 0, 0] },
        obb: e['obb'] ?? undefined,
        observedIn,
        grounding: grounding(e, observedIn),
        attributes: e['attributes'] ?? undefined,
      };
    }),

    relationships: rels.map((r) => ({
      subjectType: String(r['subject_type']),
      subjectId: String(r['subject_id']),
      predicate: String(r['predicate']),
      objectType: String(r['object_type']),
      objectId: String(r['object_id']),
      value: nullableNum(r['value']),
      grounding: grounding(r),
    })),

    nav: {
      nodes: navNodes.map((n) => ({
        id: String(n['id']),
        roomId: n['room_id'] ?? undefined,
        position: vec3(n['position']),
        clearance: nullableNum(n['clearance_m']) ?? 0.4,
        isEntrance: n['is_entrance'] === true,
        isViewpoint: n['is_viewpoint'] === true,
      })),
      edges: navEdges.map((e) => ({
        a: String(e['a']), b: String(e['b']),
        cost: num(e['cost'], 1),
        width: nullableNum(e['width_m']),
        kind: String(e['kind'] ?? 'walk'),
        openingId: e['opening_id'] ?? undefined,
      })),
    },

    regions: regions.map((r) => ({
      id: String(r['id']),
      provenance: provenance(r['provenance']),
      volume: typeof r['volume'] === 'object' && r['volume'] !== null
        ? r['volume'] : { min: [0, 0, 0], max: [0, 0, 0] },
      roomId: r['room_id'] ?? undefined,
      reason: r['reason'] ?? undefined,
      confidence: nullableNum(r['confidence']),
    })),

    cameras: cameras.map((c) => ({
      id: String(c['id']),
      captureId: c['capture_id'] ?? undefined,
      frameIndex: nullableNum(c['frame_index']),
      tMs: nullableNum(c['t_ms']),
      position: [num(c['px']), num(c['py']), num(c['pz'])],
      orientation: [num(c['qx']), num(c['qy']), num(c['qz']), num(c['qw'], 1)],
      intrinsics: c['intrinsics'] ?? {},
      poseConfidence: nullableNum(c['pose_confidence']),
      sharpness: nullableNum(c['sharpness']),
      roomId: c['room_id'] ?? undefined,
    })),

    // The document's own container and the pipeline's build artefact are not
    // part of the world. See RESERVED_CHUNK_KEYS.
    assets: assets.filter((a) => !RESERVED_CHUNK_KEYS.has(String(a['chunk_key'] ?? ''))).map((a) => ({
      id: String(a['id']),
      role: String(a['role']),
      format: String(a['format']),
      // The document carries a storage-relative path, never a signed URL: a
      // URL expires and an exported bundle must not rot in a year.
      url: `asset://${worldId}/${String(a['storage_path'])}`,
      bytes: nullableNum(a['bytes']),
      checksum: a['checksum'] ?? undefined,
      lod: nullableNum(a['lod']),
      chunkKey: a['chunk_key'] ?? undefined,
      splatCount: nullableNum(a['splat_count']),
    })),

    quality: quality[0]
      ? {
        checks: Array.isArray(quality[0]['checks']) ? quality[0]['checks'] : [],
        score: nullableNum(quality[0]['score']) ?? 0,
        verdict: String(quality[0]['verdict'] ?? 'review'),
        createdAt: String(quality[0]['created_at'] ?? ''),
      }
      : { checks: [], score: 0, verdict: 'review', createdAt: '' },

    measurementPolicy,
  };
}

// ---------------------------------------------------------------------------
// The cache: rendered once at publish, read as a file thereafter
// ---------------------------------------------------------------------------

/**
 * Why the document is a file and not a query.
 *
 * The database is the world: an operator renames a room, moves a misplaced
 * object, fixes a dimension, and that write lands in the rows, under the
 * row-level policies that make the correction safe. The document is what every
 * other package compiles against, so it has to exist — but it is a RENDERING
 * of those rows, the way a page is a rendering of a record, and nothing should
 * be reading a world by issuing thirteen selects and reassembling it on the
 * hot path of a public viewer.
 *
 * So `buildWorldDocument` stops running per request. It runs when the world is
 * published, and when a correction has invalidated what was published. In
 * between, readers fetch one object from storage.
 *
 * Staleness is recorded on the cache entry itself rather than on the world:
 * `meta.stale` on the `world-document` asset row. That is one indexed UPDATE
 * of one row, it needs no new column, and it cannot drift from the thing it
 * describes because it IS part of the thing it describes. The re-render is
 * lazy — the next reader pays for it — so an operator correcting fifteen rooms
 * in a row marks the cache stale fifteen times and re-renders once.
 */

/**
 * How the three callers wire into this, stated here because none of them lives
 * in this directory and a convention nobody can find is not a convention.
 *
 *   wv-jobs     `commitWorld` calls `renderWorldDocument` once the ingest has
 *               proved the rows match the build. Already wired.
 *
 *   wv-worlds   `publish` must call `renderWorldDocument(deps, worldId)` after
 *               it sets the world to published, so the object exists the
 *               moment the link does; `approve_corrections` must call
 *               `markWorldDocumentStale(deps, worldId, 'operator correction')`
 *               once, after the loop, when `applied > 0`; `unpublish` must
 *               call it too, because publication state is in the document.
 *               Two imports and three lines.
 *
 *   wv-export   `index.ts` should build its injected `buildWorldDocument` from
 *               `readWorldDocument(deps, worldId).then((r) => r.document)`
 *               rather than rendering per request. The handler needs no change.
 *
 *   wv-view     may serve the cached object instead of assembling a manifest
 *               from rows. It does not have to: the manifest it builds today
 *               is correct as soon as the rows exist. If it does, note that
 *               the document carries `asset://` paths, which its own privacy
 *               check exists to keep out of a public payload -- so it would
 *               need to sign and strip them exactly as `signAssets` does now.
 */

export interface WorldDocumentDeps {
  readonly db: Db;
  readonly storage: Storage;
  readonly clock: { now(): Date };
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

export interface RenderedWorldDocument {
  readonly document: Record<string, unknown>;
  readonly storagePath: string;
  readonly bytes: number;
  readonly checksum: string;
  /** True when the bytes came from storage rather than from a fresh render. */
  readonly fromCache: boolean;
}

const DOCUMENT_ASSET_COLUMNS = [
  'id', 'world_id', 'role', 'format', 'storage_path', 'bytes', 'checksum',
  'lod', 'chunk_key', 'meta',
] as const;

async function documentAssetRow(
  deps: WorldDocumentDeps, worldId: string,
): Promise<Row | undefined> {
  const rows = await deps.db.select('wv_asset', {
    columns: DOCUMENT_ASSET_COLUMNS,
    eq: { world_id: worldId, chunk_key: DOCUMENT_CHUNK_KEY },
    limit: 1,
  });
  return rows[0];
}

/** The deterministic id of a world's cached-document asset row. */
export function documentAssetId(worldId: string): Promise<string> {
  return deterministicId(worldId, 'asset', DOCUMENT_OBJECT_NAME);
}

/**
 * Render the world from its rows, write it to storage, and record it.
 *
 * Idempotent: the asset row's id is a pure function of the world id, so a
 * second render replaces the first rather than accumulating copies. The row is
 * written AFTER the object, because a row pointing at an object that is not
 * there yet is a 404 for every reader in the window between the two.
 */
export async function renderWorldDocument(
  deps: WorldDocumentDeps, worldId: string,
): Promise<RenderedWorldDocument> {
  const document = await buildWorldDocument(deps.db, worldId);
  const bytes = utf8(JSON.stringify(document));
  const checksum = await sha256Hex(bytes);
  const storagePath = `${worldId}/${DOCUMENT_OBJECT_NAME}`;

  await deps.storage.upload(ASSET_BUCKET, storagePath, bytes, 'application/json');

  await deps.db.upsert('wv_asset', {
    id: await documentAssetId(worldId),
    world_id: worldId,
    role: DOCUMENT_ASSET_ROLE,
    format: 'json',
    storage_path: storagePath,
    bytes: bytes.length,
    checksum,
    lod: 0,
    chunk_key: DOCUMENT_CHUNK_KEY,
    meta: {
      purpose: 'the WorldDocument rendered from this world\'s rows',
      stale: false,
      renderedAt: deps.clock.now().toISOString(),
      rooms: Array.isArray(document['rooms']) ? document['rooms'].length : 0,
      entities: Array.isArray(document['entities']) ? document['entities'].length : 0,
    },
  });

  deps.log('wv_document_rendered', {
    worldId, bytes: bytes.length, checksum,
    rooms: Array.isArray(document['rooms']) ? document['rooms'].length : 0,
  });
  return { document, storagePath, bytes: bytes.length, checksum, fromCache: false };
}

/**
 * The world document, from the cache when it is good and from the rows when it
 * is not.
 *
 * Three things force a re-render, and all three are "the cache cannot be
 * trusted" rather than "the cache is old": no entry, an entry marked stale by
 * a correction, and an entry whose object will not download or will not parse.
 * A corrupt cached file must not take a published tour down when the authority
 * for its contents is sitting in the database.
 */
export async function readWorldDocument(
  deps: WorldDocumentDeps, worldId: string,
): Promise<RenderedWorldDocument> {
  const row = await documentAssetRow(deps, worldId);
  const meta = (typeof row?.['meta'] === 'object' && row['meta'] !== null
    ? row['meta'] : {}) as Record<string, unknown>;
  const path = typeof row?.['storage_path'] === 'string' ? row['storage_path'] : null;

  if (!row || !path || meta['stale'] === true) {
    return renderWorldDocument(deps, worldId);
  }
  try {
    const raw = await deps.storage.download(ASSET_BUCKET, path);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('cached document is not an object');
    }
    return {
      document: parsed as Record<string, unknown>,
      storagePath: path,
      bytes: raw.length,
      checksum: String(row['checksum'] ?? ''),
      fromCache: true,
    };
  } catch (err) {
    deps.log('wv_document_cache_unusable', { worldId, path, error: String(err) });
    return renderWorldDocument(deps, worldId);
  }
}

/**
 * Mark the cached document stale. Called after any write that changes what a
 * render would produce — an operator correction, or a pipeline hand-off.
 *
 * Returns false when there was nothing to invalidate, which is the normal case
 * for a world that has never been published.
 */
export async function markWorldDocumentStale(
  deps: WorldDocumentDeps, worldId: string, reason: string,
): Promise<boolean> {
  const row = await documentAssetRow(deps, worldId);
  if (!row) return false;
  const meta = (typeof row['meta'] === 'object' && row['meta'] !== null
    ? row['meta'] : {}) as Record<string, unknown>;
  if (meta['stale'] === true) return true;   // already invalid; nothing to do

  await deps.db.update('wv_asset', {
    meta: { ...meta, stale: true, staleAt: deps.clock.now().toISOString(), staleReason: reason },
  }, { world_id: worldId, chunk_key: DOCUMENT_CHUNK_KEY });
  deps.log('wv_document_marked_stale', { worldId, reason });
  return true;
}
