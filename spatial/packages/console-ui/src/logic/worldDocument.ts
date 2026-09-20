/**
 * Assemble a `WorldDocument` from the rows a signed-in member can already read.
 *
 * There is no endpoint that returns an operator's world as a document: wv-view
 * serves published worlds only, and returns a manifest of rows rather than the
 * contract type. But RLS grants a member SELECT on every `wv_*` table in their
 * own org, so the console builds the document itself from PostgREST reads.
 * That is what lets an operator walk an *unpublished* world before deciding
 * whether the public should see it, which is the whole point of the review
 * step.
 *
 * The rule this file exists to enforce: a dimension without a declared
 * standard and tolerance must not reach a customer. `world-core` makes
 * `Room.area` a required `Quantity`, so a room whose `area_standard` is null
 * cannot simply be dropped — instead it inherits the world's declared policy
 * and is recorded as a problem, so the review screen can show exactly which
 * rooms are carrying a borrowed standard. A world where NO room declares one
 * is a blocker and no document is produced at all.
 */

import type {
  Aabb, Asset, AssetRole, Camera, Entity, Floor, Grounding, Intrinsics, MeasurementStandard,
  NavEdge, NavNode, Opening, Plane, Provenance, Quantity, Region, Relationship, Ring, Room,
  Surface, Vec2, Vec3, WorldDocument,
} from '@m3xi/world-core';
import { parseQualityRow } from './publishGate.js';

export type Row = Record<string, unknown>;

export interface WorldRows {
  readonly world: Row;
  readonly property: Row;
  readonly floors: readonly Row[];
  readonly rooms: readonly Row[];
  readonly surfaces: readonly Row[];
  readonly openings: readonly Row[];
  readonly entities: readonly Row[];
  readonly relationships: readonly Row[];
  readonly navNodes: readonly Row[];
  readonly navEdges: readonly Row[];
  readonly regions: readonly Row[];
  readonly cameras: readonly Row[];
  readonly assets: readonly Row[];
  readonly quality: Row | null;
}

export interface DataProblem {
  /** A blocker means no document; a warning means a document with a caveat. */
  readonly level: 'blocker' | 'warning';
  readonly code: string;
  readonly message: string;
  /** The row this is about, for a link straight to it. */
  readonly ref?: string;
}

export interface AssembledWorld {
  readonly doc: WorldDocument | null;
  readonly problems: readonly DataProblem[];
}

const STANDARDS: readonly MeasurementStandard[] = [
  'RICS-COMP-GIA', 'RICS-COMP-NIA', 'IPMS-3C', 'CLEAR-INTERNAL',
];

const PROVENANCES: readonly Provenance[] = ['observed', 'reconstructed', 'inferred', 'generated'];

/**
 * Chunk keys the pipeline reserves for the rendered document itself, from
 * `supabase/functions/_wv_shared/worldDocument.ts`. They are `wv_asset` rows
 * like any other, so they must be filtered out of the document's own asset
 * list — a document that listed itself would grow every time it was rendered.
 */
export const RESERVED_CHUNK_KEYS: ReadonlySet<string> = new Set(['world-document', 'world-raw']);

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function maybeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function provenanceOf(v: unknown, fallback: Provenance = 'reconstructed'): Provenance {
  return PROVENANCES.includes(v as Provenance) ? (v as Provenance) : fallback;
}

function grounding(row: Row, fallback: Provenance = 'reconstructed'): Grounding {
  const confidence = maybeNum(row['confidence']);
  return {
    provenance: provenanceOf(row['provenance'], fallback),
    // A missing confidence is not 1.0. Half is the honest "we did not say".
    confidence: confidence === null ? 0.5 : Math.max(0, Math.min(1, confidence)),
  };
}

function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const x = maybeNum(v[0]); const y = maybeNum(v[1]); const z = maybeNum(v[2]);
  return x === null || y === null || z === null ? null : [x, y, z];
}

function ring2(v: unknown): Ring | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out: Vec2[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = maybeNum(p[0]); const z = maybeNum(p[1]);
    if (x === null || z === null) return null;
    out.push([x, z]);
  }
  return out;
}

function ring3(v: unknown): Vec3[] | null {
  if (!Array.isArray(v)) return null;
  const out: Vec3[] = [];
  for (const p of v) {
    const w = vec3(p);
    if (!w) return null;
    out.push(w);
  }
  return out;
}

function aabb(v: unknown): Aabb | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const min = vec3(o['min']); const max = vec3(o['max']);
  return min && max ? { min, max } : null;
}

function plane(v: unknown): Plane | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const n = vec3(o['n']);
  const d = maybeNum(o['d']);
  return n && d !== null ? { n, d } : null;
}

/**
 * Decide the world's measurement policy from what the rooms declare.
 *
 * Majority wins; ties go to the first declared, which is stable because rooms
 * arrive ordered. Tolerances take the WORST declared value, never the best: a
 * policy that quotes the tightest tolerance in the building is a claim the
 * building does not support.
 */
function derivePolicy(rooms: readonly Row[]): {
  policy: WorldDocument['measurementPolicy'] | null;
  borrowed: string[];
} {
  const counts = new Map<MeasurementStandard, number>();
  const borrowed: string[] = [];
  let areaTol = 0;
  let wallTol = 0;

  for (const r of rooms) {
    const declared = r['area_standard'];
    if (STANDARDS.includes(declared as MeasurementStandard)) {
      const s = declared as MeasurementStandard;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    } else if (r['area_m2'] !== null && r['area_m2'] !== undefined) {
      borrowed.push(String(r['id'] ?? 'unknown room'));
    }
    areaTol = Math.max(areaTol, num(r['area_tol_pct']));
    wallTol = Math.max(wallTol, num(r['wall_tol_mm']));
  }

  if (counts.size === 0) return { policy: null, borrowed };

  let best: MeasurementStandard = 'CLEAR-INTERNAL';
  let bestCount = -1;
  for (const s of STANDARDS) {
    const c = counts.get(s) ?? 0;
    if (c > bestCount) { best = s; bestCount = c; }
  }

  return {
    policy: {
      areaStandard: best,
      areaTolerancePct: areaTol > 0 ? areaTol : 2.5,
      wallToleranceMm: wallTol > 0 ? wallTol : 20,
    },
    borrowed,
  };
}

export interface AssembleOptions {
  /**
   * Turns a `wv_asset.storage_path` into something the viewer can fetch. When
   * omitted the asset keeps an `asset://` URL, which the viewer treats as a
   * missing file and falls back to the proxy-only shell — a real product
   * state, and the one an operator reviews before any splat exists.
   */
  readonly resolveAssetUrl?: (storagePath: string, row: Row) => string;
}

export function assembleWorldDocument(
  rows: WorldRows,
  options: AssembleOptions = {},
): AssembledWorld {
  const problems: DataProblem[] = [];
  const w = rows.world;

  if (rows.rooms.length === 0) {
    problems.push({
      level: 'blocker', code: 'no_rooms',
      message: 'This world has no rooms. The build has not reached room segmentation, or it failed there.',
    });
  }

  const { policy, borrowed } = derivePolicy(rows.rooms);
  if (!policy) {
    problems.push({
      level: 'blocker', code: 'no_measurement_standard',
      message: 'No room declares a measurement standard, so no area in this world can be shown to a customer. A dimension without a declared standard is a liability, not a feature.',
    });
  }
  for (const id of borrowed) {
    problems.push({
      level: 'warning', code: 'borrowed_standard', ref: id,
      message: 'This room has an area but no declared measurement standard, so it is shown under the world’s policy rather than its own.',
    });
  }

  if (!policy || rows.rooms.length === 0) return { doc: null, problems };

  const floors: Floor[] = rows.floors.map((f) => ({
    id: String(f['id']),
    level: num(f['level']),
    ...(text(f['name']) ? { name: text(f['name'])! } : {}),
    elevation: num(f['elevation_m']),
    grounding: grounding(f),
  }));

  const rooms: Room[] = [];
  for (const r of rows.rooms) {
    const polygon = ring2(r['polygon']);
    const id = String(r['id']);
    if (!polygon) {
      problems.push({
        level: 'warning', code: 'bad_polygon', ref: id,
        message: 'This room’s outline is not a ring of [x, z] points, so it has been left out of the world.',
      });
      continue;
    }
    const g = grounding(r);
    const declared = STANDARDS.includes(r['area_standard'] as MeasurementStandard)
      ? (r['area_standard'] as MeasurementStandard)
      : policy.areaStandard;
    const tolerance = num(r['area_tol_pct'], policy.areaTolerancePct);
    const area: Quantity = {
      value: num(r['area_m2']),
      unit: 'm2',
      standard: declared,
      tolerance: tolerance > 0 ? tolerance : policy.areaTolerancePct,
      toleranceUnit: 'pct',
      grounding: g,
    };
    rooms.push({
      id,
      stableKey: String(r['stable_key'] ?? id),
      ...(text(r['floor_id']) ? { floorId: text(r['floor_id'])! } : {}),
      ...(text(r['name']) ? { name: text(r['name'])! } : {}),
      kind: (text(r['kind']) ?? 'unknown') as Room['kind'],
      polygon,
      floorZ: num(r['floor_z']),
      ceilingZ: num(r['ceiling_z'], 2.4),
      area,
      grounding: g,
    });
  }

  const surfaces: Surface[] = [];
  for (const s of rows.surfaces) {
    const p = plane(s['plane']);
    const poly = ring3(s['polygon']);
    if (!p || !poly) {
      problems.push({
        level: 'warning', code: 'bad_surface', ref: String(s['id']),
        message: 'This surface has no usable plane or outline and has been left out.',
      });
      continue;
    }
    surfaces.push({
      id: String(s['id']),
      ...(text(s['room_id']) ? { roomId: text(s['room_id'])! } : {}),
      kind: (text(s['kind']) ?? 'unknown') as Surface['kind'],
      plane: p,
      polygon: poly,
      isReflective: s['is_reflective'] === true,
      isGlazed: s['is_glazed'] === true,
      grounding: grounding(s),
    });
  }

  const lengthQuantity = (v: unknown, g: Grounding): Quantity | undefined => {
    const value = maybeNum(v);
    if (value === null) return undefined;
    return {
      value, unit: 'm', standard: 'CLEAR-INTERNAL',
      tolerance: policy.wallToleranceMm, toleranceUnit: 'mm', grounding: g,
    };
  };

  const openings: Opening[] = [];
  for (const o of rows.openings) {
    const centre = vec3(o['centre']);
    if (!centre) {
      problems.push({
        level: 'warning', code: 'bad_opening', ref: String(o['id']),
        message: 'This opening has no usable centre point and has been left out.',
      });
      continue;
    }
    const g = grounding(o);
    const normal = vec3(o['normal']);
    const width = lengthQuantity(o['width_m'], g);
    const height = lengthQuantity(o['height_m'], g);
    const sill = lengthQuantity(o['sill_m'], g);
    openings.push({
      id: String(o['id']),
      kind: (text(o['kind']) ?? 'doorway') as Opening['kind'],
      ...(text(o['surface_id']) ? { surfaceId: text(o['surface_id'])! } : {}),
      ...(text(o['room_a']) ? { roomA: text(o['room_a'])! } : {}),
      ...(text(o['room_b']) ? { roomB: text(o['room_b'])! } : {}),
      centre,
      ...(normal ? { normal } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(sill ? { sill } : {}),
      grounding: g,
    });
  }

  const entities: Entity[] = [];
  for (const e of rows.entities) {
    const centroid = vec3(e['centroid']);
    const box = aabb(e['aabb']);
    if (!centroid || !box) {
      problems.push({
        level: 'warning', code: 'bad_entity', ref: String(e['id']),
        message: 'This object has no usable position or bounding box and has been left out.',
      });
      continue;
    }
    const observed = Array.isArray(e['observed_in'])
      ? (e['observed_in'] as unknown[]).map((x) => String(x))
      : [];
    entities.push({
      id: String(e['id']),
      stableKey: String(e['stable_key'] ?? e['id']),
      label: String(e['label'] ?? 'object'),
      category: (text(e['category']) ?? 'other') as Entity['category'],
      ...(text(e['room_id']) ? { roomId: text(e['room_id'])! } : {}),
      centroid,
      aabb: box,
      observedIn: observed,
      grounding: grounding(e, 'inferred'),
      ...(typeof e['attributes'] === 'object' && e['attributes'] !== null
        ? { attributes: e['attributes'] as Record<string, unknown> }
        : {}),
    });
  }

  const relationships: Relationship[] = rows.relationships.map((r) => ({
    subjectType: String(r['subject_type']) as Relationship['subjectType'],
    subjectId: String(r['subject_id']),
    predicate: String(r['predicate']) as Relationship['predicate'],
    objectType: String(r['object_type']) as Relationship['objectType'],
    objectId: String(r['object_id']),
    ...(maybeNum(r['value']) !== null ? { value: maybeNum(r['value'])! } : {}),
    grounding: grounding(r),
  }));

  const navNodes: NavNode[] = [];
  for (const n of rows.navNodes) {
    const position = vec3(n['position']);
    if (!position) continue;
    navNodes.push({
      id: String(n['id']),
      ...(text(n['room_id']) ? { roomId: text(n['room_id'])! } : {}),
      position,
      clearance: num(n['clearance_m'], 0.3),
      isEntrance: n['is_entrance'] === true,
      isViewpoint: n['is_viewpoint'] === true,
    });
  }

  const navEdges: NavEdge[] = rows.navEdges.map((e) => ({
    a: String(e['a']),
    b: String(e['b']),
    cost: num(e['cost'], 1),
    ...(maybeNum(e['width_m']) !== null ? { width: maybeNum(e['width_m'])! } : {}),
    kind: (text(e['kind']) ?? 'walk') as NavEdge['kind'],
    ...(text(e['opening_id']) ? { openingId: text(e['opening_id'])! } : {}),
  }));

  const regions: Region[] = [];
  for (const r of rows.regions) {
    const volume = aabb(r['volume']);
    if (!volume) continue;
    const p = provenanceOf(r['provenance'], 'inferred');
    regions.push({
      id: String(r['id']),
      // The contract excludes 'reconstructed' here: a region records what was
      // NOT derived from observation.
      provenance: (p === 'reconstructed' ? 'inferred' : p) as Region['provenance'],
      volume,
      ...(text(r['room_id']) ? { roomId: text(r['room_id'])! } : {}),
      ...(text(r['reason']) ? { reason: text(r['reason'])! } : {}),
      ...(maybeNum(r['confidence']) !== null ? { confidence: maybeNum(r['confidence'])! } : {}),
    });
  }

  const cameras: Camera[] = [];
  for (const c of rows.cameras) {
    const intr = parseIntrinsics(c['intrinsics']);
    if (!intr) continue;
    cameras.push({
      id: String(c['id']),
      ...(maybeNum(c['frame_index']) !== null ? { frameIndex: maybeNum(c['frame_index'])! } : {}),
      ...(maybeNum(c['t_ms']) !== null ? { tMs: maybeNum(c['t_ms'])! } : {}),
      position: [num(c['px']), num(c['py']), num(c['pz'])],
      orientation: [num(c['qx']), num(c['qy']), num(c['qz']), num(c['qw'], 1)],
      intrinsics: intr,
      ...(maybeNum(c['pose_confidence']) !== null ? { poseConfidence: maybeNum(c['pose_confidence'])! } : {}),
      ...(maybeNum(c['sharpness']) !== null ? { sharpness: maybeNum(c['sharpness'])! } : {}),
      ...(text(c['room_id']) ? { roomId: text(c['room_id'])! } : {}),
    });
  }

  const assets: Asset[] = [];
  for (const a of rows.assets) {
    const storagePath = text(a['storage_path']);
    if (!storagePath) continue;
    if (RESERVED_CHUNK_KEYS.has(String(a['chunk_key'] ?? ''))) continue;
    const url = options.resolveAssetUrl
      ? options.resolveAssetUrl(storagePath, a)
      : `asset://${storagePath}`;
    assets.push({
      id: String(a['id']),
      role: String(a['role']) as AssetRole,
      format: String(a['format'] ?? 'bin'),
      url,
      ...(maybeNum(a['bytes']) !== null ? { bytes: maybeNum(a['bytes'])! } : {}),
      ...(text(a['checksum']) ? { checksum: text(a['checksum'])! } : {}),
      ...(maybeNum(a['lod']) !== null ? { lod: maybeNum(a['lod'])! } : {}),
      ...(text(a['chunk_key']) ? { chunkKey: text(a['chunk_key'])! } : {}),
      ...(maybeNum(a['splat_count']) !== null ? { splatCount: maybeNum(a['splat_count'])! } : {}),
    });
  }

  const quality = parseQualityRow(rows.quality as never).report ?? {
    checks: [], score: 0, verdict: 'fail' as const,
    createdAt: new Date(0).toISOString(),
  };
  if (!rows.quality) {
    problems.push({
      level: 'warning', code: 'no_quality',
      message: 'This world has no quality report, so it cannot be published. The document below carries a failing placeholder verdict so nothing downstream reads it as passed.',
    });
  }

  const doc: WorldDocument = {
    formatVersion: 1,
    id: String(w['id']),
    propertyId: String(w['property_id'] ?? rows.property['id'] ?? ''),
    version: num(w['version'], 1),
    ...(text(w['slug']) ? { slug: text(w['slug'])! } : {}),
    label: String(rows.property['label'] ?? 'Property'),
    createdAt: text(w['created_at']) ?? new Date(0).toISOString(),
    ...(text(w['published_at']) ? { publishedAt: text(w['published_at'])! } : {}),
    units: { length: 'm', angle: 'rad' },
    upAxis: 'Y',
    handedness: 'right',
    scale: {
      source: text(w['scale_source']) ?? 'not recorded',
      agreement: num(w['scale_agreement']),
      grounding: {
        // Never 'observed' and never assumed 'reconstructed': no camera
        // measures a metre, a model estimates one, and every dimension in the
        // world inherits the weaker of its geometry's provenance and this.
        // An unrecorded provenance degrades to 'inferred', which is the
        // weaker claim, not the stronger one.
        provenance: scaleProvenance(w['scale_provenance']),
        // Agreement is not confidence: two estimators can agree closely on a
        // capture neither should be trusted on. Use the recorded confidence
        // when there is one and fall back to agreement only when there is not.
        confidence: maybeNum(w['scale_confidence']) ?? num(w['scale_agreement'], 0.5),
      },
    },
    floors,
    rooms,
    surfaces,
    openings,
    entities,
    relationships,
    nav: { nodes: navNodes, edges: navEdges },
    regions,
    cameras,
    assets,
    quality,
    measurementPolicy: policy,
  };

  return { doc, problems };
}

/** 'observed' is not a possible answer here, so it is refused rather than passed on. */
function scaleProvenance(v: unknown): Provenance {
  const p = provenanceOf(v, 'inferred');
  return p === 'observed' ? 'inferred' : p;
}

function parseIntrinsics(v: unknown): Intrinsics | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const fx = maybeNum(o['fx']); const fy = maybeNum(o['fy']);
  const cx = maybeNum(o['cx']); const cy = maybeNum(o['cy']);
  // The schema comment writes these as `w` and `h`; the contract calls them
  // width and height. Accept both rather than silently producing a 0x0 camera.
  const width = maybeNum(o['width'] ?? o['w']);
  const height = maybeNum(o['height'] ?? o['h']);
  if (fx === null || fy === null || cx === null || cy === null || width === null || height === null) {
    return null;
  }
  const model = o['model'];
  const dist = Array.isArray(o['dist'])
    ? (o['dist'] as unknown[]).map((d) => num(d))
    : undefined;
  return {
    fx, fy, cx, cy, width, height,
    ...(model === 'pinhole' || model === 'opencv' || model === 'fisheye' ? { model } : {}),
    ...(dist ? { dist } : {}),
  };
}

/** Blockers stop the review screen; warnings annotate it. */
export function hasBlocker(problems: readonly DataProblem[]): boolean {
  return problems.some((p) => p.level === 'blocker');
}
