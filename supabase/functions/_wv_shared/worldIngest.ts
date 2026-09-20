/**
 * Writing a reconstructed world into the database, one section at a time.
 *
 * THE DECISION THIS FILE IMPLEMENTS. The database is the world. The pipeline
 * assembles a WorldDocument because that is the shape every package compiles
 * against, but the document is not the artefact of record -- the rows are. An
 * operator renames a room, moves a misplaced object, fixes a dimension,
 * approves a redaction; those writes have to land somewhere that row-level
 * security can protect and a portfolio query can read, and that is not a blob
 * in a bucket that we then patch. Versioning needs it too: `stable_key` only
 * carries forward across a rescan if there are rows for it to carry into.
 *
 * WHY SECTIONS. A two-bed flat's document is about 100 KB against a 256 KB
 * request cap, and a five-bed house with heavy semantics is several times
 * that. Designing for the flat and meeting the cap in production is a failure
 * mode we can avoid by never sending the document whole. So it arrives as
 * sections, each of which may itself arrive in chunks.
 *
 * WHY IT IS SAFE TO SEND TWICE. RunPod pods are preempted. A pod that dies
 * half way through the hand-off has its lease reclaimed and the job re-run,
 * and the second pass re-sends everything. Every row therefore carries a key
 * that is a pure function of its content, not of the attempt:
 *
 *   rooms, entities   id = uuid(world id, section, STABLE KEY). That is the
 *                     same key as the schema's `unique (world_id, stable_key)`,
 *                     expressed as the primary key so that every reference to
 *                     the room is stable too. Deriving it from the stable key
 *                     rather than from `rm_000` is what makes a rescan land on
 *                     the row it is superseding.
 *   everything else   id = uuid(world id, section, the pipeline's local id),
 *                     which is stable across a re-run because the pipeline's
 *                     ids are (`srf_000`, a frame id, `nav_00017`).
 *   relationships,    no natural id and a bigserial primary key, so these
 *   nav edges         upsert against a unique index over their endpoints and
 *                     let the sequence keep its own value.
 *
 * WHY ORDER STILL MATTERS A LITTLE. Chunk order within a section does not
 * matter at all -- every row is keyed, so they can land in any sequence. But
 * the schema has real foreign keys, and a surface cannot reference a room row
 * that does not exist yet. Rather than defer and fix up, each section declares
 * what it depends on and checks the specific ids it references; a section that
 * arrives early is refused with the name of the section that has to land
 * first. That is a retry the worker can act on, instead of a foreign-key
 * violation it cannot read.
 *
 * WHOSE WORLD. `worldId` is passed in by the caller, which reads it from the
 * claimed job row. Nothing in this file consults the request body for it. A
 * worker that has legitimately leased job X cannot write into another tenant's
 * world by naming it, for exactly the reason redactions cannot.
 */

import type { Row } from './deps.ts';
import { deterministicId } from './ids.ts';
import {
  ASSET_BUCKET, DOCUMENT_CHUNK_KEY, RAW_DOCUMENT_OBJECT_NAME,
  buildWorldDocument, markWorldDocumentStale, renderWorldDocument, type WorldDocumentDeps,
} from './worldDocument.ts';
import { compareWorldDocuments, summariseDifferences, type WorldDifference } from './worldDiff.ts';

// ---------------------------------------------------------------------------
// Vocabularies. Transcribed from the core migration's enums and from
// world-core/src/types.ts; a value outside them must never reach a table.
// ---------------------------------------------------------------------------

const PROVENANCES = new Set(['observed', 'reconstructed', 'inferred', 'generated']);
const REGION_PROVENANCES = new Set(['observed', 'inferred', 'generated']);
const ROOM_KINDS = new Set([
  'living', 'kitchen', 'bedroom', 'bathroom', 'wc', 'hall', 'landing',
  'stairwell', 'utility', 'storage', 'office', 'dining', 'conservatory',
  'garage', 'balcony', 'garden', 'exterior', 'unknown',
]);
const SURFACE_KINDS = new Set(['wall', 'floor', 'ceiling', 'soffit', 'column', 'unknown']);
const OPENING_KINDS = new Set(['door', 'doorway', 'window', 'rooflight', 'stair', 'hatch', 'arch']);
const ENTITY_CATEGORIES = new Set([
  'furniture', 'appliance', 'fixture', 'fitting', 'structure', 'other',
]);
const NODE_TYPES = new Set(['room', 'entity', 'surface', 'opening', 'floor']);
const PREDICATES = new Set([
  'inside', 'contains', 'adjacent_to', 'connected_to', 'near', 'far_from',
  'above', 'below', 'left_of', 'right_of', 'attached_to', 'intersects',
  'visible_from', 'blocks', 'opens_into', 'supports', 'located_on',
]);
const MEASUREMENT_STANDARDS = new Set([
  'RICS-COMP-GIA', 'RICS-COMP-NIA', 'IPMS-3C', 'CLEAR-INTERNAL',
]);
const ASSET_ROLES = new Set([
  'splat', 'splat_chunk', 'proxy_mesh', 'visual_mesh', 'pointcloud',
  'floorplan', 'cover', 'depth_archive', 'source_media', 'export_bundle',
]);
const NAV_EDGE_KINDS = new Set(['walk', 'door', 'stair']);
const VERDICTS = new Set(['pass', 'review', 'fail']);

/**
 * Sections, in the order the worker sends them.
 *
 * The order satisfies every foreign key in one pass. It is not enforced --
 * chunks may arrive in any order and sections may be resent -- but a worker
 * that follows it never sees a dependency refusal.
 */
export const INGEST_SECTIONS = [
  'header', 'floors', 'rooms', 'surfaces', 'openings', 'cameras', 'entities',
  'nav-nodes', 'nav-edges', 'regions', 'relationships', 'assets', 'quality',
  'commit',
] as const;

export type IngestSection = typeof INGEST_SECTIONS[number];

/**
 * Row caps per request, mirrored in the worker so a violation is a bug rather
 * than a surprise 400. They are generous where rows are small (a nav node is
 * ~120 bytes) and tight where they are not (a surface carries a polygon). The
 * worker additionally splits on serialised size, which is the real protection:
 * a single wall with a 400-vertex outline is worth fifty nav nodes.
 */
export const MAX_ROWS: Readonly<Record<string, number>> = {
  floors: 64,
  rooms: 200,
  surfaces: 300,
  openings: 400,
  cameras: 500,
  entities: 400,
  'nav-nodes': 1000,
  'nav-edges': 1000,
  regions: 500,
  relationships: 1000,
  assets: 256,
};

// ---------------------------------------------------------------------------
// Coercion. Nothing here throws: a worker sending nonsense gets a 400 with the
// row index, not a 500 with a stack.
// ---------------------------------------------------------------------------

export interface SectionFailure {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly detail?: unknown;
}

export interface SectionSuccess {
  readonly ok: true;
  readonly written: number;
  readonly detail?: Record<string, unknown>;
}

export type SectionResult = SectionSuccess | SectionFailure;

const bad = (error: string, detail?: unknown, status = 400): SectionFailure =>
  ({ ok: false, status, error, detail });

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown> : null;
}

function text(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function finite(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function optionalFinite(v: unknown): number | null {
  return v === null || v === undefined ? null : finite(v);
}

/** Exactly `n` finite numbers, or null. Used for every vector in the schema. */
function vector(v: unknown, n: number): number[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out: number[] = [];
  for (const x of v) {
    const f = finite(x);
    if (f === null) return null;
    out.push(f);
  }
  return out;
}

/** A closed XZ ring. Three vertices is the minimum that bounds any area. */
function ring(v: unknown): number[][] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out: number[][] = [];
  for (const p of v) {
    const q = vector(p, 2);
    if (!q) return null;
    out.push(q);
  }
  return out;
}

function polygon3(v: unknown, min = 3): number[][] | null {
  if (!Array.isArray(v) || v.length < min) return null;
  const out: number[][] = [];
  for (const p of v) {
    const q = vector(p, 3);
    if (!q) return null;
    out.push(q);
  }
  return out;
}

function unitInterval(v: unknown): number | null {
  const n = optionalFinite(v);
  if (n === null) return null;
  return Math.max(0, Math.min(1, n));
}

interface Grounded {
  readonly provenance: string;
  readonly confidence: number | null;
}

function grounding(v: unknown, allowed: ReadonlySet<string> = PROVENANCES): Grounded | null {
  const g = obj(v);
  if (!g) return null;
  const p = text(g['provenance'], 24);
  if (!p || !allowed.has(p)) return null;
  return { provenance: p, confidence: unitInterval(g['confidence']) };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The id sections used for each kind of object. These strings are part of the
 * on-disk identity of every world ever ingested: changing one re-keys every
 * row it names, so they are frozen.
 */
/**
 * The key an asset row's id is derived from.
 *
 * Not the object name alone. Object names are content checksums, so the same
 * bytes packaged under two roles -- a proxy mesh that is also the visual mesh,
 * say -- would name the same object, and two rows deriving the same primary
 * key inside one statement is an error Postgres raises rather than a
 * duplicate it tolerates. Both writers of wv_asset use this, so `complete` and
 * `ingest-world` converge on one row per asset instead of racing to create two.
 */
export function assetKey(
  role: string, chunkKey: string | null | undefined, lod: number | null | undefined,
  name: string,
): string {
  return `${role}\u0000${chunkKey ?? ''}\u0000${lod ?? ''}\u0000${name}`;
}

export const ID_SECTION = {
  floor: 'floor',
  room: 'room',
  surface: 'surface',
  opening: 'opening',
  camera: 'camera',
  entity: 'entity',
  navnode: 'navnode',
  region: 'region',
  asset: 'asset',
  quality: 'quality',
} as const;

/**
 * Every uuid the ingest will derive from an assembled document, mapped back to
 * the local id the pipeline used.
 *
 * This is what lets the rendered document be compared against the assembled
 * one: it names the same objects. An id the ingest would derive differently
 * simply fails to resolve, and the object it names is then reported missing --
 * which is the correct outcome, because a row written under the wrong key IS
 * missing as far as every reference to it is concerned.
 */
export async function worldObjectIds(
  worldId: string, assembled: Record<string, unknown>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = async (section: string, key: string, localId: string): Promise<void> => {
    out.set(await deterministicId(worldId, section, key), localId);
  };
  const rows = (k: string): Record<string, unknown>[] =>
    (Array.isArray(assembled[k]) ? assembled[k] as unknown[] : [])
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);

  for (const f of rows('floors')) {
    await add(ID_SECTION.floor, String(Number(f['level'] ?? 0)), String(f['id']));
  }
  for (const r of rows('rooms')) {
    await add(ID_SECTION.room, String(r['stableKey'] ?? r['id']), String(r['id']));
  }
  for (const e of rows('entities')) {
    await add(ID_SECTION.entity, String(e['stableKey'] ?? e['id']), String(e['id']));
  }
  for (const s of rows('surfaces')) await add(ID_SECTION.surface, String(s['id']), String(s['id']));
  for (const o of rows('openings')) await add(ID_SECTION.opening, String(o['id']), String(o['id']));
  for (const c of rows('cameras')) await add(ID_SECTION.camera, String(c['id']), String(c['id']));
  for (const g of rows('regions')) await add(ID_SECTION.region, String(g['id']), String(g['id']));
  const nav = obj(assembled['nav']) ?? {};
  for (const n of (Array.isArray(nav['nodes']) ? nav['nodes'] : [])) {
    const node = obj(n);
    if (node) await add(ID_SECTION.navnode, String(node['id']), String(node['id']));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

/**
 * The ids that already exist in this world, per table, so a reference can be
 * checked before it becomes a foreign-key violation nobody can read.
 *
 * Loaded once per request and no more: a section is at most a few hundred
 * rows, and a world's room list is at most a few dozen.
 */
class Existing {
  private readonly cache = new Map<string, Set<string>>();

  constructor(private readonly deps: WorldDocumentDeps, private readonly worldId: string) {}

  async ids(table: string): Promise<Set<string>> {
    const hit = this.cache.get(table);
    if (hit) return hit;
    const rows = await this.deps.db.select(table, {
      columns: ['id'], eq: { world_id: this.worldId },
    });
    const set = new Set(rows.map((r) => String(r['id'])));
    this.cache.set(table, set);
    return set;
  }
}

const REFERENCE_TABLE: Readonly<Record<string, { table: string; section: string }>> = {
  room: { table: 'wv_room', section: 'rooms' },
  entity: { table: 'wv_entity', section: 'entities' },
  surface: { table: 'wv_surface', section: 'surfaces' },
  opening: { table: 'wv_opening', section: 'openings' },
  floor: { table: 'wv_floor', section: 'floors' },
  camera: { table: 'wv_camera', section: 'cameras' },
  navnode: { table: 'wv_nav_node', section: 'nav-nodes' },
};

/** A reference that could not be satisfied, and the section that provides it. */
interface Unresolved {
  readonly kind: string;
  readonly key: string;
  readonly section: string;
}

class Resolver {
  readonly missing: Unresolved[] = [];

  constructor(private readonly worldId: string, private readonly existing: Existing) {}

  /**
   * Resolve a reference to the uuid of the row it names, checking that the row
   * is actually there. Returns null for an absent reference, and records an
   * unresolved one rather than returning a dangling uuid.
   */
  async ref(kind: keyof typeof REFERENCE_TABLE, key: unknown): Promise<string | null> {
    const k = text(key, 240);
    if (!k) return null;
    const section = ID_SECTION[kind as keyof typeof ID_SECTION] ?? kind;
    const id = await deterministicId(this.worldId, section, k);
    const target = REFERENCE_TABLE[kind]!;
    if (!(await this.existing.ids(target.table)).has(id)) {
      this.missing.push({ kind, key: k, section: target.section });
      return null;
    }
    return id;
  }
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

export interface IngestRequest {
  readonly section: string;
  readonly rows: unknown;
  /** Declared for logging and for the worker's own bookkeeping. */
  readonly chunkIndex?: unknown;
  readonly chunkCount?: unknown;
  /** Required by `rooms`: the world's declared measurement policy. */
  readonly policy?: unknown;
  /** Required by `header`. */
  readonly scale?: unknown;
  readonly propertyId?: unknown;
  readonly version?: unknown;
  /** Required by `quality`. */
  readonly quality?: unknown;
}

export async function ingestSection(
  deps: WorldDocumentDeps, worldId: string, body: IngestRequest,
): Promise<SectionResult> {
  const section = text(body.section, 32);
  if (!section || !(INGEST_SECTIONS as readonly string[]).includes(section)) {
    return bad(`Unknown ingest section ${String(body.section)}.`);
  }
  if (section === 'header') return header(deps, worldId, body);
  if (section === 'quality') return quality(deps, worldId, body);
  if (section === 'commit') return bad('commit is handled by the caller.', undefined, 500);

  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) return bad('rows must be an array.');
  const cap = MAX_ROWS[section] ?? 100;
  if (rows.length > cap) {
    return bad(`Too many rows for ${section} in one request; the cap is ${cap}.`);
  }
  if (rows.length === 0) return { ok: true, written: 0 };

  const existing = new Existing(deps, worldId);
  const resolver = new Resolver(worldId, existing);
  let built: { table: string; values: Row[]; onConflict?: readonly string[] } | SectionFailure;

  switch (section) {
    case 'floors': built = await floors(worldId, rows); break;
    case 'rooms': built = await roomsSection(deps, worldId, rows, body, resolver); break;
    case 'surfaces': built = await surfaces(worldId, rows, resolver); break;
    case 'openings': built = await openings(worldId, rows, resolver); break;
    case 'cameras': built = await cameras(worldId, rows, resolver); break;
    case 'entities': built = await entitiesSection(deps, worldId, rows, resolver); break;
    case 'nav-nodes': built = await navNodes(worldId, rows, resolver); break;
    case 'nav-edges': built = await navEdges(worldId, rows, resolver); break;
    case 'regions': built = await regions(worldId, rows, resolver); break;
    case 'relationships': built = await relationships(worldId, rows, resolver); break;
    case 'assets': built = await assets(worldId, rows); break;
    default: return bad(`Section ${section} has no handler.`, undefined, 500);
  }
  if ('ok' in built) return built;

  if (resolver.missing.length > 0) {
    // 422 rather than 400: the request is well formed, it simply names rows
    // that are not there yet. 409 is reserved for the lease -- the worker
    // treats that one as "another pod owns this world now, go quiet", which is
    // the opposite of what an unresolved reference should provoke.
    return {
      ok: false,
      status: 422,
      error: 'This section references rows that have not been ingested yet.',
      detail: {
        needs: [...new Set(resolver.missing.map((m) => m.section))].sort(),
        missing: resolver.missing.slice(0, 10),
      },
    };
  }

  // A chunk can legitimately reduce to nothing -- a nav-edge chunk whose rows
  // were all duplicates of each other, say -- and an empty write is a request
  // with no purpose rather than an error.
  if (built.values.length > 0) {
    await deps.db.upsert(built.table, built.values,
      built.onConflict ? { onConflict: built.onConflict } : undefined);
  }
  return { ok: true, written: built.values.length };
}

// -- header -----------------------------------------------------------------

/**
 * Metric scale, and an assertion that this really is the world the build was
 * for.
 *
 * `propertyId` and `version` are checked, never written: they are decided when
 * the world version is created, and a build that thinks it belongs to a
 * different property has gone wrong somewhere the ingest cannot fix.
 */
async function header(
  deps: WorldDocumentDeps, worldId: string, body: IngestRequest,
): Promise<SectionResult> {
  const scale = obj(body.scale);
  if (!scale) return bad('header requires a scale block.');
  const source = text(scale['source'], 120);
  if (!source) return bad('scale.source required.');
  const agreement = unitInterval(scale['agreement']);
  if (agreement === null) return bad('scale.agreement must be a number in [0,1].');
  const g = grounding(scale['grounding']);
  if (!g) return bad('scale.grounding must carry a known provenance.');
  if (g.provenance === 'observed') {
    // No camera measures a metre. A capture that claims to have observed the
    // scale has mislabelled an estimate, and every dimension downstream would
    // inherit the stronger claim.
    return bad('Metric scale cannot be `observed`; it is estimated, not measured.');
  }

  const worlds = await deps.db.select('wv_world', {
    columns: ['id', 'property_id', 'version'], eq: { id: worldId }, limit: 1,
  });
  const world = worlds[0];
  if (!world) return bad('No such world.', undefined, 404);

  const claimedProperty = text(body.propertyId, 64);
  if (claimedProperty && claimedProperty !== String(world['property_id'])) {
    return bad('This build was assembled for a different property.', {
      expected: String(world['property_id']), got: claimedProperty,
    }, 422);
  }
  const claimedVersion = optionalFinite(body.version);
  if (claimedVersion !== null && claimedVersion !== Number(world['version'])) {
    return bad('This build was assembled for a different world version.', {
      expected: Number(world['version']), got: claimedVersion,
    }, 422);
  }

  await deps.db.update('wv_world', {
    scale_source: source,
    scale_agreement: agreement,
    scale_provenance: g.provenance,
    scale_confidence: g.confidence,
  }, { id: worldId });

  // `header` is the first section of every hand-off, so this is the earliest
  // moment the rows can start disagreeing with a document published from an
  // earlier build of the same world. Invalidating here rather than only at
  // commit closes the window in which a rebuild that fails half way leaves
  // readers on the previous world's document while the rows are the new one's.
  await markWorldDocumentStale(deps, worldId, 'a new build is being ingested');
  return { ok: true, written: 1 };
}

// -- floors -----------------------------------------------------------------

async function floors(worldId: string, rows: unknown[]) {
  const values: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`floors[${i}] is not an object.`);
    const level = finite(r['level']);
    if (level === null || !Number.isInteger(level)) return bad(`floors[${i}].level must be an integer.`);
    const elevation = finite(r['elevation']);
    if (elevation === null) return bad(`floors[${i}].elevation must be a number.`);
    const g = grounding(r['grounding']);
    if (!g) return bad(`floors[${i}].grounding is missing or invalid.`);
    values.push({
      id: await deterministicId(worldId, ID_SECTION.floor, String(level)),
      world_id: worldId,
      level,
      name: text(r['name'], 80),
      elevation_m: elevation,
      provenance: g.provenance,
      confidence: g.confidence,
    });
  }
  return { table: 'wv_floor', values };
}

// -- rooms ------------------------------------------------------------------

/**
 * A room, with the measurement policy denormalised onto it.
 *
 * `name` is written only when the build has one. That is not tidiness: an
 * operator's rename lives in this column, and a resumed ingest re-sending the
 * same build must not silently undo it. An upsert only writes the columns it
 * names, so omitting `name` leaves the correction standing.
 */
async function roomsSection(
  deps: WorldDocumentDeps, worldId: string, rows: unknown[], body: IngestRequest,
  resolver: Resolver,
) {
  const policy = obj(body.policy);
  if (!policy) return bad('rooms requires the measurement policy.');
  const standard = text(policy['areaStandard'], 32);
  const areaTol = finite(policy['areaTolerancePct']);
  const wallTol = finite(policy['wallToleranceMm']);
  if (!standard || !MEASUREMENT_STANDARDS.has(standard)) {
    return bad('policy.areaStandard is not a declared measurement standard.');
  }
  if (areaTol === null || areaTol <= 0) return bad('policy.areaTolerancePct must be positive.');
  if (wallTol === null || wallTol <= 0) return bad('policy.wallToleranceMm must be positive.');

  const values: Row[] = [];
  const keys = new Map<string, string>();
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`rooms[${i}] is not an object.`);
    const stableKey = text(r['stableKey'], 200);
    if (!stableKey) return bad(`rooms[${i}].stableKey is required.`);
    const kind = text(r['kind'], 24);
    if (!kind || !ROOM_KINDS.has(kind)) return bad(`rooms[${i}].kind is not a known room kind.`);
    const poly = ring(r['polygon']);
    if (!poly) return bad(`rooms[${i}].polygon must be at least three [x, z] pairs.`);
    const floorZ = finite(r['floorZ']);
    const ceilingZ = finite(r['ceilingZ']);
    if (floorZ === null || ceilingZ === null || ceilingZ <= floorZ) {
      return bad(`rooms[${i}]: ceilingZ must be above floorZ.`);
    }
    const area = obj(r['area']);
    const areaValue = area ? finite(area['value']) : null;
    if (areaValue === null || areaValue <= 0) return bad(`rooms[${i}].area.value must be positive.`);
    const areaStandard = text(area!['standard'], 32);
    if (!areaStandard || !MEASUREMENT_STANDARDS.has(areaStandard)) {
      return bad(`rooms[${i}].area.standard is not a declared measurement standard.`);
    }
    const areaTolerance = finite(area!['tolerance']);
    if (areaTolerance === null || areaTolerance <= 0) {
      return bad(`rooms[${i}].area.tolerance must be positive.`);
    }
    const g = grounding(r['grounding']);
    if (!g) return bad(`rooms[${i}].grounding is missing or invalid.`);

    const id = await deterministicId(worldId, ID_SECTION.room, stableKey);
    keys.set(stableKey, id);
    const name = text(r['name'], 120);
    const floorLevel = optionalFinite(r['floorLevel']);
    values.push({
      id,
      world_id: worldId,
      floor_id: floorLevel === null ? null : await resolver.ref('floor', String(floorLevel)),
      stable_key: stableKey,
      kind,
      polygon: poly,
      floor_z: floorZ,
      ceiling_z: ceilingZ,
      area_m2: areaValue,
      area_standard: areaStandard,
      area_tol_pct: areaTolerance,
      wall_tol_mm: wallTol,
      provenance: g.provenance,
      confidence: g.confidence,
      ...(name ? { name } : {}),
    });
  }

  const clash = await stableKeyClash(deps, 'wv_room', worldId, keys);
  if (clash) return clash;
  return { table: 'wv_room', values };
}

/**
 * Catch a row that already holds this stable key under a different id.
 *
 * The primary key IS the stable key, hashed, so this cannot happen from this
 * code path. It can happen if a row was ever written by something that chose
 * its own uuid, and the symptom would otherwise be an opaque unique-violation
 * 500 that the worker retries three times and gives up on.
 */
async function stableKeyClash(
  deps: WorldDocumentDeps, table: string, worldId: string, wanted: Map<string, string>,
): Promise<SectionFailure | null> {
  const rows = await deps.db.select(table, {
    columns: ['id', 'stable_key'], eq: { world_id: worldId },
  });
  for (const row of rows) {
    const key = String(row['stable_key'] ?? '');
    const expected = wanted.get(key);
    if (expected && String(row['id']) !== expected) {
      return bad(
        `${table} already holds stable key '${key}' under a different id; refusing to `
        + 'create a second row for the same thing.',
        { stableKey: key, existing: row['id'], expected }, 422,
      );
    }
  }
  return null;
}

// -- surfaces ---------------------------------------------------------------

async function surfaces(worldId: string, rows: unknown[], resolver: Resolver) {
  const values: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`surfaces[${i}] is not an object.`);
    const localId = text(r['id'], 120);
    if (!localId) return bad(`surfaces[${i}].id is required.`);
    const kind = text(r['kind'], 24);
    if (!kind || !SURFACE_KINDS.has(kind)) return bad(`surfaces[${i}].kind is not a known surface kind.`);
    const plane = obj(r['plane']);
    const n = plane ? vector(plane['n'], 3) : null;
    const d = plane ? finite(plane['d']) : null;
    if (!n || d === null) return bad(`surfaces[${i}].plane must be {n:[x,y,z], d}.`);
    const norm = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (Math.abs(norm - 1) > 1e-3) return bad(`surfaces[${i}].plane.n must be a unit normal.`);
    const poly = polygon3(r['polygon']);
    if (!poly) return bad(`surfaces[${i}].polygon must be at least three [x, y, z] points.`);
    const g = grounding(r['grounding']);
    if (!g) return bad(`surfaces[${i}].grounding is missing or invalid.`);
    values.push({
      id: await deterministicId(worldId, ID_SECTION.surface, localId),
      world_id: worldId,
      room_id: await resolver.ref('room', r['roomKey']),
      kind,
      plane: { n, d },
      polygon: poly,
      area_m2: optionalFinite(r['areaM2']),
      is_reflective: r['isReflective'] === true,
      is_glazed: r['isGlazed'] === true,
      provenance: g.provenance,
      confidence: g.confidence,
    });
  }
  return { table: 'wv_surface', values };
}

// -- openings ---------------------------------------------------------------

async function openings(worldId: string, rows: unknown[], resolver: Resolver) {
  const values: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`openings[${i}] is not an object.`);
    const localId = text(r['id'], 120);
    if (!localId) return bad(`openings[${i}].id is required.`);
    const kind = text(r['kind'], 24);
    if (!kind || !OPENING_KINDS.has(kind)) return bad(`openings[${i}].kind is not a known opening kind.`);
    const centre = vector(r['centre'], 3);
    if (!centre) return bad(`openings[${i}].centre must be three finite numbers.`);
    const normal = r['normal'] === null || r['normal'] === undefined ? null : vector(r['normal'], 3);
    if (r['normal'] !== null && r['normal'] !== undefined && !normal) {
      return bad(`openings[${i}].normal must be three finite numbers.`);
    }
    const g = grounding(r['grounding']);
    if (!g) return bad(`openings[${i}].grounding is missing or invalid.`);
    values.push({
      id: await deterministicId(worldId, ID_SECTION.opening, localId),
      world_id: worldId,
      kind,
      surface_id: await resolver.ref('surface', r['surfaceKey']),
      room_a: await resolver.ref('room', r['roomAKey']),
      room_b: await resolver.ref('room', r['roomBKey']),
      centre,
      normal,
      width_m: optionalFinite(r['widthM']),
      height_m: optionalFinite(r['heightM']),
      sill_m: optionalFinite(r['sillM']),
      provenance: g.provenance,
      confidence: g.confidence,
    });
  }
  return { table: 'wv_opening', values };
}

// -- cameras ----------------------------------------------------------------

async function cameras(worldId: string, rows: unknown[], resolver: Resolver) {
  const values: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`cameras[${i}] is not an object.`);
    const localId = text(r['id'], 120);
    if (!localId) return bad(`cameras[${i}].id is required.`);
    const p = vector(r['position'], 3);
    if (!p) return bad(`cameras[${i}].position must be three finite numbers.`);
    const q = vector(r['orientation'], 4);
    if (!q) return bad(`cameras[${i}].orientation must be four finite numbers.`);
    const qn = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
    if (Math.abs(qn - 1) > 1e-3) return bad(`cameras[${i}].orientation must be a unit quaternion.`);
    const intr = obj(r['intrinsics']);
    if (!intr) return bad(`cameras[${i}].intrinsics is required.`);
    for (const key of ['fx', 'fy', 'cx', 'cy']) {
      if (finite(intr[key]) === null) return bad(`cameras[${i}].intrinsics.${key} is invalid.`);
    }
    const w = finite(intr['width']);
    const h = finite(intr['height']);
    if (w === null || h === null || w <= 0 || h <= 0) {
      return bad(`cameras[${i}].intrinsics width and height must be positive.`);
    }
    if (finite(intr['fx'])! <= 0 || finite(intr['fy'])! <= 0) {
      return bad(`cameras[${i}].intrinsics focal lengths must be positive.`);
    }
    values.push({
      id: await deterministicId(worldId, ID_SECTION.camera, localId),
      world_id: worldId,
      frame_index: optionalFinite(r['frameIndex']),
      t_ms: optionalFinite(r['tMs']),
      px: p[0], py: p[1], pz: p[2],
      qx: q[0], qy: q[1], qz: q[2], qw: q[3],
      intrinsics: intr,
      pose_confidence: unitInterval(r['poseConfidence']),
      sharpness: optionalFinite(r['sharpness']),
      room_id: await resolver.ref('room', r['roomKey']),
    });
  }
  return { table: 'wv_camera', values };
}

// -- entities ---------------------------------------------------------------

async function entitiesSection(
  deps: WorldDocumentDeps, worldId: string, rows: unknown[], resolver: Resolver,
) {
  const values: Row[] = [];
  const keys = new Map<string, string>();
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`entities[${i}] is not an object.`);
    const stableKey = text(r['stableKey'], 200);
    if (!stableKey) return bad(`entities[${i}].stableKey is required.`);
    const label = text(r['label'], 120);
    if (!label) return bad(`entities[${i}].label is required.`);
    const category = text(r['category'], 24);
    if (!category || !ENTITY_CATEGORIES.has(category)) {
      return bad(`entities[${i}].category is not a known category.`);
    }
    const centroid = vector(r['centroid'], 3);
    if (!centroid) return bad(`entities[${i}].centroid must be three finite numbers.`);
    const aabb = obj(r['aabb']);
    const min = aabb ? vector(aabb['min'], 3) : null;
    const max = aabb ? vector(aabb['max'], 3) : null;
    if (!min || !max) return bad(`entities[${i}].aabb must be {min:[..], max:[..]}.`);
    if (min.some((v, k) => max[k]! < v)) return bad(`entities[${i}].aabb is inverted.`);
    const g = grounding(r['grounding']);
    if (!g) return bad(`entities[${i}].grounding is missing or invalid.`);

    const observed = Array.isArray(r['observedIn']) ? r['observedIn'] : [];
    const observedIds: string[] = [];
    for (const cameraKey of observed) {
      const id = await resolver.ref('camera', cameraKey);
      if (id) observedIds.push(id);
    }
    // An entity no camera established is not an entity, it is a guess with a
    // bounding box, and the contract says so: its provenance must admit it.
    if (observedIds.length === 0 && g.provenance !== 'inferred' && g.provenance !== 'generated') {
      return bad(
        `entities[${i}] has no observing camera, so its provenance cannot be `
        + `'${g.provenance}'.`,
      );
    }

    const id = await deterministicId(worldId, ID_SECTION.entity, stableKey);
    keys.set(stableKey, id);
    values.push({
      id,
      world_id: worldId,
      stable_key: stableKey,
      label,
      category,
      room_id: await resolver.ref('room', r['roomKey']),
      centroid,
      aabb: { min, max },
      obb: obj(r['obb']),
      observed_in: observedIds,
      provenance: g.provenance,
      confidence: g.confidence,
      attributes: obj(r['attributes']) ?? {},
    });
  }
  const clash = await stableKeyClash(deps, 'wv_entity', worldId, keys);
  if (clash) return clash;
  return { table: 'wv_entity', values };
}

// -- navigation -------------------------------------------------------------

async function navNodes(worldId: string, rows: unknown[], resolver: Resolver) {
  const values: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`nav-nodes[${i}] is not an object.`);
    const localId = text(r['id'], 120);
    if (!localId) return bad(`nav-nodes[${i}].id is required.`);
    const position = vector(r['position'], 3);
    if (!position) return bad(`nav-nodes[${i}].position must be three finite numbers.`);
    const clearance = finite(r['clearance']);
    if (clearance === null || clearance < 0) return bad(`nav-nodes[${i}].clearance must be >= 0.`);
    values.push({
      id: await deterministicId(worldId, ID_SECTION.navnode, localId),
      world_id: worldId,
      room_id: await resolver.ref('room', r['roomKey']),
      position,
      clearance_m: clearance,
      is_entrance: r['isEntrance'] === true,
      is_viewpoint: r['isViewpoint'] === true,
    });
  }
  return { table: 'wv_nav_node', values };
}

/**
 * Nav edges have no id of their own and a bigserial primary key, so they
 * upsert against `wv_nav_edge_identity` -- (world_id, a, b) -- and let the
 * sequence keep whatever value it assigned first. Deriving a bigint primary
 * key from a hash was the alternative and was rejected: a JavaScript number
 * carries 53 bits, and 53 bits of key space is a birthday collision between
 * two tenants' worlds at a scale this product intends to reach.
 */
async function navEdges(worldId: string, rows: unknown[], resolver: Resolver) {
  const values: Row[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`nav-edges[${i}] is not an object.`);
    const a = await resolver.ref('navnode', r['a']);
    const b = await resolver.ref('navnode', r['b']);
    const cost = finite(r['cost']);
    if (cost === null || cost < 0) return bad(`nav-edges[${i}].cost must be >= 0.`);
    const kind = text(r['kind'], 16) ?? 'walk';
    if (!NAV_EDGE_KINDS.has(kind)) return bad(`nav-edges[${i}].kind is not walk, door or stair.`);
    if (!a || !b) continue;   // unresolved; reported by the resolver
    // One statement may not name the same conflict target twice. The graph
    // stage does not emit a duplicate edge, but a chunk boundary re-sent by
    // hand could, and Postgres would reject the whole section for it.
    if (seen.has(`${a}\u0000${b}`)) continue;
    seen.add(`${a}\u0000${b}`);
    values.push({
      world_id: worldId,
      a, b, cost,
      width_m: optionalFinite(r['widthM']),
      kind,
      opening_id: await resolver.ref('opening', r['openingKey']),
    });
  }
  return { table: 'wv_nav_edge', values, onConflict: ['world_id', 'a', 'b'] as const };
}

// -- regions ----------------------------------------------------------------

async function regions(worldId: string, rows: unknown[], resolver: Resolver) {
  const values: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`regions[${i}] is not an object.`);
    const localId = text(r['id'], 120);
    if (!localId) return bad(`regions[${i}].id is required.`);
    const p = text(r['provenance'], 24);
    // types.ts: Exclude<Provenance, 'reconstructed'>. Geometry does not derive
    // a volume nobody looked at.
    if (!p || !REGION_PROVENANCES.has(p)) {
      return bad(`regions[${i}].provenance must be observed, inferred or generated.`);
    }
    const volume = obj(r['volume']);
    const min = volume ? vector(volume['min'], 3) : null;
    const max = volume ? vector(volume['max'], 3) : null;
    if (!min || !max) return bad(`regions[${i}].volume must be {min:[..], max:[..]}.`);
    values.push({
      id: await deterministicId(worldId, ID_SECTION.region, localId),
      world_id: worldId,
      provenance: p,
      volume: { min, max },
      room_id: await resolver.ref('room', r['roomKey']),
      reason: text(r['reason'], 300),
      confidence: unitInterval(r['confidence']),
    });
  }
  return { table: 'wv_region', values };
}

// -- relationships ----------------------------------------------------------

async function relationships(worldId: string, rows: unknown[], resolver: Resolver) {
  const values: Row[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`relationships[${i}] is not an object.`);
    const subjectType = text(r['subjectType'], 16);
    const objectType = text(r['objectType'], 16);
    const predicate = text(r['predicate'], 24);
    if (!subjectType || !NODE_TYPES.has(subjectType)) return bad(`relationships[${i}].subjectType is invalid.`);
    if (!objectType || !NODE_TYPES.has(objectType)) return bad(`relationships[${i}].objectType is invalid.`);
    if (!predicate || !PREDICATES.has(predicate)) return bad(`relationships[${i}].predicate is invalid.`);
    const g = grounding(r['grounding']);
    if (!g) return bad(`relationships[${i}].grounding is missing or invalid.`);
    const subjectId = await resolver.ref(subjectType as keyof typeof REFERENCE_TABLE, r['subjectKey']);
    const objectId = await resolver.ref(objectType as keyof typeof REFERENCE_TABLE, r['objectKey']);
    if (!subjectId || !objectId) continue;   // unresolved; reported by the resolver
    // The unique index is over the endpoints, so a chunk that repeats one
    // would make Postgres reject the whole statement ("cannot affect row a
    // second time"). Collapsing here keeps a duplicated edge from failing an
    // otherwise good ingest.
    const key = `${subjectType}|${subjectId}|${predicate}|${objectType}|${objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      world_id: worldId,
      subject_type: subjectType,
      subject_id: subjectId,
      predicate,
      object_type: objectType,
      object_id: objectId,
      value: optionalFinite(r['value']),
      provenance: g.provenance,
      confidence: g.confidence,
    });
  }
  return {
    table: 'wv_relationship',
    values,
    onConflict: ['world_id', 'subject_type', 'subject_id', 'predicate', 'object_type', 'object_id'] as const,
  };
}

// -- assets -----------------------------------------------------------------

/**
 * Packaged files, keyed by the object name the worker uploaded them under.
 *
 * The name is content-addressed (`<ab>/<sha256>.spz`), so it is stable across
 * a re-run that produced identical bytes, and the storage prefix is added here
 * from the job's world rather than taken from the worker -- the same rule
 * `upload-urls` follows, for the same reason.
 */
async function assets(worldId: string, rows: unknown[]) {
  const values: Row[] = [];
  const seenAssets = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = obj(rows[i]);
    if (!r) return bad(`assets[${i}] is not an object.`);
    const name = text(r['name'], 180);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(name)
        || name.split('/').some((seg) => seg === '.' || seg === '..')) {
      return bad(`assets[${i}].name is not an acceptable object name.`);
    }
    const role = text(r['role'], 32);
    if (!role || !ASSET_ROLES.has(role)) return bad(`assets[${i}].role is not a known asset role.`);
    const format = text(r['format'], 16);
    if (!format) return bad(`assets[${i}].format is required.`);
    const chunkKey = text(r['chunkKey'], 120);
    if (chunkKey === DOCUMENT_CHUNK_KEY) {
      // The rendered document is written by this function, at commit. A worker
      // that could claim that chunk key could replace what every viewer reads
      // with a file it chose.
      return bad(`assets[${i}] may not claim the reserved '${DOCUMENT_CHUNK_KEY}' chunk key.`);
    }
    const lod = optionalFinite(r['lod']);
    const id = await deterministicId(
      worldId, ID_SECTION.asset, assetKey(role, chunkKey, lod, name));
    if (seenAssets.has(id)) {
      return bad(`assets[${i}] repeats an asset already named in this request.`);
    }
    seenAssets.add(id);
    values.push({
      id,
      world_id: worldId,
      role,
      format,
      storage_path: `${worldId}/${name}`,
      bytes: optionalFinite(r['bytes']),
      checksum: text(r['checksum'], 128),
      lod,
      chunk_key: chunkKey,
      splat_count: optionalFinite(r['splatCount']),
      meta: obj(r['meta']) ?? {},
    });
  }
  return { table: 'wv_asset', values };
}

// -- quality ----------------------------------------------------------------

/**
 * The gate's own record. Upserted on a deterministic id derived from the
 * report's timestamp, so a resumed hand-off replaces its own row instead of
 * leaving the world with two verdicts and a coin toss over which is latest.
 */
async function quality(
  deps: WorldDocumentDeps, worldId: string, body: IngestRequest,
): Promise<SectionResult> {
  const q = obj(body.quality);
  if (!q) return bad('quality requires a report.');
  const verdict = text(q['verdict'], 16);
  if (!verdict || !VERDICTS.has(verdict)) return bad('quality.verdict is not pass, review or fail.');
  const score = finite(q['score']);
  if (score === null || score < 0 || score > 1) return bad('quality.score must be in [0,1].');
  const checks = Array.isArray(q['checks']) ? q['checks'] : null;
  if (!checks || checks.length === 0) return bad('quality.checks must be a non-empty array.');
  const createdAt = text(q['createdAt'], 40);
  if (!createdAt) return bad('quality.createdAt is required.');

  await deps.db.upsert('wv_quality', {
    id: await deterministicId(worldId, ID_SECTION.quality, createdAt),
    world_id: worldId,
    checks,
    score,
    verdict: coherentVerdict(verdict, checks, deps, worldId),
    created_at: createdAt,
  });
  return { ok: true, written: 1 };
}

/**
 * The worker computes the gate, so this cannot re-derive the verdict. But a
 * `pass` submitted alongside a check that did not pass is incoherent on its
 * face, and the safe reading of an incoherent gate result is the conservative
 * one. Same rule as `complete`, and it has to be the same rule: two places
 * that disagree about what a pass means is worse than either answer.
 */
function coherentVerdict(
  verdict: string, checks: unknown[], deps: WorldDocumentDeps, worldId: string,
): string {
  const anyFailed = checks.some((c) => obj(c)?.['pass'] === false);
  if (verdict === 'pass' && anyFailed) {
    deps.log('wv_ingest_verdict_downgraded', { worldId });
    return 'review';
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export interface CommitOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly verdict?: string;
  readonly differences?: readonly WorldDifference[];
  readonly summary?: string;
  readonly document?: { readonly storagePath: string; readonly bytes: number; readonly checksum: string };
  readonly error?: string;
}

/**
 * Close the hand-off: prove the database says what the build said, apply the
 * publication decision, and render the document every reader will use.
 *
 * The proof is the point. The pipeline uploaded its assembled document to
 * `build/world.raw.json` before the ingest started; this downloads that file,
 * renders the world back out of the rows, and compares the two. Doing it this
 * way -- rather than having the worker send a digest -- keeps the comparison
 * in one language with one implementation, so a false failure cannot come from
 * two hashers disagreeing about float formatting.
 *
 * A material difference fails the commit and leaves the world unpublished. It
 * means a room, a surface or a measurement did not survive the write, and a
 * world that publishes anyway is a world that shows a buyer something the
 * reconstruction did not find.
 */
export async function commitWorld(
  deps: WorldDocumentDeps, worldId: string,
): Promise<CommitOutcome> {
  const rawPath = `${worldId}/${RAW_DOCUMENT_OBJECT_NAME}`;
  let assembled: Record<string, unknown>;
  try {
    const bytes = await deps.storage.download(ASSET_BUCKET, rawPath);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    assembled = parsed as Record<string, unknown>;
  } catch (err) {
    // No build artefact means nothing to check the rows against, and an
    // unverified world must not publish. This is a failure, not a shortcut.
    return {
      ok: false, status: 422,
      error: `Could not read the build artefact at ${RAW_DOCUMENT_OBJECT_NAME}, so the `
        + `ingest cannot be verified: ${String(err)}`,
    };
  }

  // Rendered, but not yet written: a world that fails the check must leave no
  // cached document behind for a reader to find.
  const rendered = await buildWorldDocument(deps.db, worldId);
  const localIdByUuid = await worldObjectIds(worldId, assembled);
  const differences = compareWorldDocuments(assembled, rendered, localIdByUuid);
  if (differences.length > 0) {
    const summary = summariseDifferences(differences);
    deps.log('wv_ingest_divergence', { worldId, count: differences.length, summary });
    return {
      ok: false, status: 422, differences, summary,
      error: `The world in the database does not match the world that was built: ${summary}`,
    };
  }

  const verdict = await applyPublicationDecision(deps, worldId);
  const doc = await renderWorldDocument(deps, worldId);
  deps.log('wv_ingest_committed', {
    worldId, verdict, bytes: doc.bytes, checksum: doc.checksum,
  });
  return {
    ok: true, status: 200, verdict,
    document: { storagePath: doc.storagePath, bytes: doc.bytes, checksum: doc.checksum },
  };
}

/**
 * A world becomes viewable because it passed, not because a pipeline finished.
 * `published_at` is set here and nowhere else on this path.
 */
async function applyPublicationDecision(
  deps: WorldDocumentDeps, worldId: string,
): Promise<string> {
  const rows = await deps.db.select('wv_quality', {
    columns: ['score', 'verdict', 'created_at'], eq: { world_id: worldId },
    order: { column: 'created_at', ascending: false }, limit: 1,
  });
  const latest = rows[0];
  if (!latest) {
    // No verdict is not a pass. A world nobody assessed is indistinguishable
    // from one that failed.
    await deps.db.update('wv_world', { status: 'review', published_at: null }, { id: worldId });
    return 'review';
  }
  const verdict = String(latest['verdict']);
  const status = verdict === 'pass' ? 'published' : verdict === 'review' ? 'review' : 'failed';
  const now = deps.clock.now().toISOString();
  await deps.db.update('wv_world', {
    status,
    quality_score: optionalFinite(latest['score']),
    published_at: status === 'published' ? now : null,
  }, { id: worldId });
  return verdict;
}
