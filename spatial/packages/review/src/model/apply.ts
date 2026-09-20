import type {
  Aabb, Entity, NavEdge, NavNode, Obb, Opening, Quantity, Region, Room, Surface, Vec3,
  WorldDocument,
} from '@m3xi/world-core';
import type { CorrectionChange, CorrectionRecord, DimensionTarget } from './corrections.js';
import { CORRECTION_SOURCE_PREFIX, correctGrounding, correctedQuantity } from './provenance.js';

/**
 * Applying a correction list to a world document. Pure, total and ordered.
 *
 * "Pure" is load-bearing, not stylistic. Because the corrected world is a
 * function of (base document, record list):
 *
 *   - undo is dropping a record and recomputing, so there is no inverse
 *     operation per field that could be written wrong;
 *   - the preview the operator reviews is literally the document that will be
 *     saved, not a separate rendering of intent that could drift from it;
 *   - validation runs against the prospective world, so "this correction
 *     breaks the world" is answerable BEFORE the operator commits;
 *   - the same function runs in a test, so every correction type is
 *     round-tripped against the fixture rather than against a mock.
 *
 * Records apply in list order. Later records win, which is what makes a second
 * rename of the same room a replacement rather than a conflict.
 *
 * `version` is deliberately NOT incremented here. A version belongs to the
 * database, which allocates it when a new world row is created; inventing one
 * client-side would produce two different worlds claiming the same version.
 */

export interface ApplyResult {
  readonly doc: WorldDocument;
  /** Records that could not be applied, with the reason, in list order. */
  readonly skipped: readonly { readonly record: CorrectionRecord; readonly reason: string }[];
}

export function applyCorrections(
  base: WorldDocument, records: readonly CorrectionRecord[],
): ApplyResult {
  let doc = base;
  const skipped: { record: CorrectionRecord; reason: string }[] = [];
  for (const record of records) {
    const step = applyOne(doc, record);
    if (step.reason) skipped.push({ record, reason: step.reason });
    else doc = step.doc;
  }
  return { doc, skipped };
}

interface Step { readonly doc: WorldDocument; readonly reason?: string }

function skip(doc: WorldDocument, reason: string): Step {
  return { doc, reason };
}

function applyOne(doc: WorldDocument, record: CorrectionRecord): Step {
  const change = record.change;
  switch (change.kind) {
    case 'room.rename': return editRoom(doc, change.roomId, (r) => ({
      ...r,
      name: change.name,
      grounding: correctGrounding(r.grounding, record, { confirmsExisting: r.name === change.name }),
    }));

    case 'room.kind': return editRoom(doc, change.roomId, (r) => ({
      ...r,
      kind: change.roomKind,
      grounding: correctGrounding(r.grounding, record, { confirmsExisting: r.kind === change.roomKind }),
    }));

    case 'room.delete': return deleteRoom(doc, change.roomId);

    case 'entity.label': return editEntity(doc, change.entityId, (e) => ({
      ...e,
      label: change.label,
      grounding: correctGrounding(e.grounding, record, { confirmsExisting: e.label === change.label }),
    }));

    case 'entity.category': return editEntity(doc, change.entityId, (e) => ({
      ...e,
      category: change.category,
      grounding: correctGrounding(e.grounding, record, { confirmsExisting: e.category === change.category }),
    }));

    case 'entity.room': {
      if (change.roomId !== null && !doc.rooms.some((r) => r.id === change.roomId)) {
        return skip(doc, `no room '${change.roomId}' to move it into`);
      }
      return editEntity(doc, change.entityId, (e) => {
        const next: Entity = {
          ...e,
          grounding: correctGrounding(e.grounding, record, { confirmsExisting: (e.roomId ?? null) === change.roomId }),
        } as Entity;
        return change.roomId === null
          ? stripRoom(next)
          : { ...next, roomId: change.roomId };
      });
    }

    case 'entity.move': {
      if (!finiteVec(change.centroid)) return skip(doc, 'a position must be three finite metres');
      return editEntity(doc, change.entityId, (e) => moveEntity(e, change.centroid, record));
    }

    case 'entity.resize': {
      if (!finiteVec(change.size) || change.size.some((v) => v <= 0)) {
        return skip(doc, 'a size must be three positive metres');
      }
      return editEntity(doc, change.entityId, (e) => resizeEntity(e, change.size, record));
    }

    case 'entity.delete': {
      if (!doc.entities.some((e) => e.id === change.entityId)) {
        return skip(doc, `no entity '${change.entityId}'`);
      }
      return {
        doc: {
          ...doc,
          entities: doc.entities.filter((e) => e.id !== change.entityId),
          relationships: doc.relationships.filter(
            (r) => r.subjectId !== change.entityId && r.objectId !== change.entityId,
          ),
        },
      };
    }

    case 'dimension.set': return setDimension(doc, record, change.target, change);

    case 'surface.flags': return editSurface(doc, change.surfaceId, (s) => {
      const nextReflective = change.isReflective ?? s.isReflective;
      const nextGlazed = change.isGlazed ?? s.isGlazed;
      return {
        ...s,
        isReflective: nextReflective,
        isGlazed: nextGlazed,
        grounding: correctGrounding(s.grounding, record, {
          confirmsExisting: nextReflective === s.isReflective && nextGlazed === s.isGlazed,
        }),
      };
    });

    case 'opening.kind': return editOpening(doc, change.openingId, (o) => ({
      ...o,
      kind: change.openingKind,
      grounding: correctGrounding(o.grounding, record, { confirmsExisting: o.kind === change.openingKind }),
    }));

    case 'opening.connects': {
      for (const id of [change.roomA, change.roomB]) {
        if (id !== null && !doc.rooms.some((r) => r.id === id)) {
          return skip(doc, `no room '${id}' for this opening to connect`);
        }
      }
      if (change.roomA !== null && change.roomA === change.roomB) {
        return skip(doc, 'an opening cannot connect a room to itself');
      }
      return editOpening(doc, change.openingId, (o) => {
        const base: Opening = {
          ...o,
          grounding: correctGrounding(o.grounding, record, {
            confirmsExisting: (o.roomA ?? null) === change.roomA && (o.roomB ?? null) === change.roomB,
          }),
        } as Opening;
        return withRooms(base, change.roomA, change.roomB);
      });
    }

    case 'entrance.set': {
      if (!doc.nav.nodes.some((n) => n.id === change.navNodeId)) {
        return skip(doc, `no navigation node '${change.navNodeId}'`);
      }
      // Exactly one entrance. A world with two entrances has no defined
      // arrival point, and the viewer picks whichever it finds first.
      const nodes: NavNode[] = doc.nav.nodes.map((n) => ({
        ...n, isEntrance: n.id === change.navNodeId,
      }));
      return { doc: { ...doc, nav: { ...doc.nav, nodes } } };
    }

    case 'region.mark': {
      if (!finiteAabb(change.volume)) return skip(doc, 'a marked volume must be finite');
      if (!change.reason.trim()) return skip(doc, 'a coverage note must say why');
      const region: Region = {
        id: `rg_${record.id}`,
        provenance: change.provenance,
        volume: normaliseAabb(change.volume),
        ...(change.roomId ? { roomId: change.roomId } : {}),
        reason: `${change.reason.trim()} (recorded by ${record.by})`,
        // A human marking a gap is an assertion about coverage, not a
        // measurement of it, so it carries the human ceiling rather than a
        // number that looks computed.
        confidence: change.provenance === 'generated' ? 0.1 : 0.5,
      };
      return { doc: { ...doc, regions: [...doc.regions, region] } };
    }

    case 'region.clear': {
      const existing = doc.regions.find((r) => r.id === change.regionId);
      if (!existing) return skip(doc, `no region '${change.regionId}'`);
      if (!isOperatorRegion(existing)) {
        // An operator may withdraw their OWN coverage note. They may not
        // withdraw the pipeline's, because that note records that no camera
        // looked, and no amount of operator confidence makes a camera have
        // looked. The remedy for a wrongly-flagged gap is a rescan.
        return skip(doc, 'only an operator-added coverage note can be removed; a survey gap the pipeline recorded needs a rescan, not a deletion');
      }
      return { doc: { ...doc, regions: doc.regions.filter((r) => r.id !== change.regionId) } };
    }

    case 'world.approve':
      // Sign-off changes no fact about the building, so it changes no document.
      // It exists in the list because the list is the audit trail, and because
      // `save` refuses to run without one.
      return { doc };
  }
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function editRoom(
  doc: WorldDocument, roomId: string, fn: (r: Room) => Room,
): Step {
  const i = doc.rooms.findIndex((r) => r.id === roomId);
  if (i < 0) return skip(doc, `no room '${roomId}'`);
  const rooms = [...doc.rooms];
  rooms[i] = fn(doc.rooms[i]!);
  return { doc: { ...doc, rooms } };
}

/**
 * Deleting a room takes its walls, floor and ceiling with it, detaches its
 * furniture and nav nodes, and LEAVES its openings alone.
 *
 * That last part is deliberate. An opening whose room has gone is a broken
 * world, and `validate.ts` reports it as a blocker naming both. Quietly
 * deleting the door, or quietly rewriting it to connect nothing, would hide
 * the consequence of the operator's decision at exactly the moment they need
 * to see it. The editor's job is to show what will break, not to tidy it away.
 */
function deleteRoom(doc: WorldDocument, roomId: string): Step {
  if (!doc.rooms.some((r) => r.id === roomId)) return skip(doc, `no room '${roomId}'`);

  const surfaceIds = new Set(doc.surfaces.filter((s) => s.roomId === roomId).map((s) => s.id));
  const nodeIds = new Set(doc.nav.nodes.filter((n) => n.roomId === roomId).map((n) => n.id));
  const gone = new Set<string>([roomId, ...surfaceIds, ...nodeIds]);

  const nodes = doc.nav.nodes.filter((n) => !nodeIds.has(n.id));
  const edges: NavEdge[] = doc.nav.edges.filter((e) => !nodeIds.has(e.a) && !nodeIds.has(e.b));

  return {
    doc: {
      ...doc,
      rooms: doc.rooms.filter((r) => r.id !== roomId),
      surfaces: doc.surfaces.filter((s) => !surfaceIds.has(s.id)),
      entities: doc.entities.map((e) => (e.roomId === roomId ? stripRoom(e) : e)),
      regions: doc.regions.map((r) => (r.roomId === roomId ? stripRegionRoom(r) : r)),
      relationships: doc.relationships.filter(
        (r) => !gone.has(r.subjectId) && !gone.has(r.objectId),
      ),
      nav: { nodes, edges },
    },
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function editEntity(
  doc: WorldDocument, entityId: string, fn: (e: Entity) => Entity,
): Step {
  const i = doc.entities.findIndex((e) => e.id === entityId);
  if (i < 0) return skip(doc, `no entity '${entityId}'`);
  const entities = [...doc.entities];
  entities[i] = fn(doc.entities[i]!);
  return { doc: { ...doc, entities } };
}

/** Translate centroid, aabb and obb together. A box that lags its centroid is a bug. */
function moveEntity(e: Entity, to: Vec3, record: CorrectionRecord): Entity {
  const d: Vec3 = [to[0] - e.centroid[0], to[1] - e.centroid[1], to[2] - e.centroid[2]];
  const aabb: Aabb = {
    min: [e.aabb.min[0] + d[0], e.aabb.min[1] + d[1], e.aabb.min[2] + d[2]],
    max: [e.aabb.max[0] + d[0], e.aabb.max[1] + d[1], e.aabb.max[2] + d[2]],
  };
  const obb: Obb | undefined = e.obb
    ? { ...e.obb, centre: [e.obb.centre[0] + d[0], e.obb.centre[1] + d[1], e.obb.centre[2] + d[2]] }
    : undefined;
  const moved = Math.hypot(d[0], d[1], d[2]) > 1e-6;
  return {
    ...e,
    centroid: to,
    aabb,
    ...(obb ? { obb } : {}),
    grounding: correctGrounding(e.grounding, record, { confirmsExisting: !moved }),
  };
}

/**
 * Resize about the base, not about the centre.
 *
 * Furniture stands on a floor. Scaling a wardrobe about its centroid buries
 * half of it in the slab and floats the other half, and then the collision
 * test and the fit test both disagree with the room. Keeping `aabb.min[1]`
 * fixed is the only version of "make it 2.1 m tall" that means what an
 * operator means. A ceiling-mounted fitting is the exception, and it is
 * handled by the operator moving it afterwards, which is one extra correction
 * with its own receipt rather than a hidden rule about which way is up.
 */
function resizeEntity(e: Entity, size: Vec3, record: CorrectionRecord): Entity {
  const baseY = e.aabb.min[1];
  const cx = e.centroid[0];
  const cz = e.centroid[2];
  const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const centroid: Vec3 = [cx, baseY + half[1], cz];
  const aabb: Aabb = {
    min: [cx - half[0], baseY, cz - half[2]],
    max: [cx + half[0], baseY + size[1], cz + half[2]],
  };
  const obb: Obb | undefined = e.obb ? { ...e.obb, centre: centroid, half } : undefined;
  const unchanged = e.obb
    ? vecClose(e.obb.half, half)
    : vecClose(
        [(e.aabb.max[0] - e.aabb.min[0]) / 2, (e.aabb.max[1] - e.aabb.min[1]) / 2, (e.aabb.max[2] - e.aabb.min[2]) / 2],
        half,
      );
  return {
    ...e,
    centroid,
    aabb,
    ...(obb ? { obb } : {}),
    grounding: correctGrounding(e.grounding, record, { confirmsExisting: unchanged }),
  };
}

/**
 * `exactOptionalPropertyTypes` is off in this repo, so `roomId: undefined`
 * would serialise as an explicit null-ish key. Rebuilding without the key
 * keeps the document JSON identical to one the pipeline would have written.
 */
function stripRoom(e: Entity): Entity {
  const { roomId: _drop, ...rest } = e;
  return rest as Entity;
}

function stripRegionRoom(r: Region): Region {
  const { roomId: _drop, ...rest } = r;
  return rest as Region;
}

// ---------------------------------------------------------------------------
// Surfaces and openings
// ---------------------------------------------------------------------------

function editSurface(
  doc: WorldDocument, surfaceId: string, fn: (s: Surface) => Surface,
): Step {
  const i = doc.surfaces.findIndex((s) => s.id === surfaceId);
  if (i < 0) return skip(doc, `no surface '${surfaceId}'`);
  const surfaces = [...doc.surfaces];
  surfaces[i] = fn(doc.surfaces[i]!);
  return { doc: { ...doc, surfaces } };
}

function editOpening(
  doc: WorldDocument, openingId: string, fn: (o: Opening) => Opening,
): Step {
  const i = doc.openings.findIndex((o) => o.id === openingId);
  if (i < 0) return skip(doc, `no opening '${openingId}'`);
  const openings = [...doc.openings];
  openings[i] = fn(doc.openings[i]!);
  return { doc: { ...doc, openings } };
}

function withRooms(o: Opening, roomA: string | null, roomB: string | null): Opening {
  const { roomA: _a, roomB: _b, ...rest } = o;
  return {
    ...(rest as Opening),
    ...(roomA === null ? {} : { roomA }),
    ...(roomB === null ? {} : { roomB }),
  };
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

function setDimension(
  doc: WorldDocument,
  record: CorrectionRecord,
  target: DimensionTarget,
  change: Extract<CorrectionChange, { kind: 'dimension.set' }>,
): Step {
  if (!Number.isFinite(change.value) || change.value <= 0) {
    return skip(doc, 'a dimension must be a positive number of metres');
  }
  const policy = doc.measurementPolicy;

  if (target.kind === 'room.area') {
    return editRoom(doc, target.roomId, (r) => ({
      ...r,
      area: correctedQuantity(
        r.area, change.value, 'm2',
        change.standard ?? r.area?.standard ?? policy.areaStandard, record,
        {
          method: change.method,
          instrument: change.instrument,
          policyTolerance: policy.areaTolerancePct,
          policyToleranceUnit: 'pct',
        },
      ),
    }));
  }

  if (target.kind === 'room.ceilingHeight') {
    return editRoom(doc, target.roomId, (r) => {
      const floorZ = Number.isFinite(r.floorZ) ? r.floorZ : 0;
      return {
        ...r,
        ceilingZ: floorZ + change.value,
        // The ceiling plane moved, which is geometry, so the room's own
        // grounding takes the geometric floor even though its polygon did not
        // change. A room is a volume, not an outline.
        grounding: correctGrounding(r.grounding, record, {
          confirmsExisting: Math.abs((r.ceilingZ - floorZ) - change.value) < 1e-6,
        }),
      };
    });
  }

  const field = target.kind === 'opening.width' ? 'width'
    : target.kind === 'opening.height' ? 'height' : 'sill';
  return editOpening(doc, target.openingId, (o) => {
    const previous: Quantity | undefined = o[field];
    const q = correctedQuantity(
      previous, change.value, 'm',
      change.standard ?? previous?.standard ?? 'CLEAR-INTERNAL', record,
      {
        method: change.method,
        instrument: change.instrument,
        policyTolerance: policy.wallToleranceMm,
        policyToleranceUnit: 'mm',
      },
    );
    return { ...o, [field]: q };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A region this editor created, identifiable by its reserved id prefix. */
export function isOperatorRegion(r: Region): boolean {
  return r.id.startsWith('rg_');
}

/** The correction record a marked region came from, when it came from one. */
export function regionCorrectionId(r: Region): string | null {
  return isOperatorRegion(r) ? r.id.slice(3) : null;
}

function finiteVec(v: Vec3): boolean {
  return v.length === 3 && v.every((n) => Number.isFinite(n));
}

function finiteAabb(b: Aabb): boolean {
  return !!b && finiteVec(b.min) && finiteVec(b.max);
}

function normaliseAabb(b: Aabb): Aabb {
  return {
    min: [Math.min(b.min[0], b.max[0]), Math.min(b.min[1], b.max[1]), Math.min(b.min[2], b.max[2])],
    max: [Math.max(b.min[0], b.max[0]), Math.max(b.min[1], b.max[1]), Math.max(b.min[2], b.max[2])],
  };
}

function vecClose(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;
}

/** Every correction record id whose receipt appears anywhere in the document. */
export function receiptsIn(doc: WorldDocument): ReadonlySet<string> {
  const out = new Set<string>();
  const scan = (sources: readonly string[] | undefined): void => {
    for (const s of sources ?? []) {
      if (s.startsWith(CORRECTION_SOURCE_PREFIX)) out.add(s.slice(CORRECTION_SOURCE_PREFIX.length));
    }
  };
  for (const r of doc.rooms) { scan(r.grounding.sources); scan(r.area?.grounding.sources); }
  for (const e of doc.entities) scan(e.grounding.sources);
  for (const s of doc.surfaces) scan(s.grounding.sources);
  for (const o of doc.openings) {
    scan(o.grounding.sources);
    scan(o.width?.grounding.sources);
    scan(o.height?.grounding.sources);
    scan(o.sill?.grounding.sources);
  }
  for (const r of doc.regions) { const id = regionCorrectionId(r); if (id) out.add(id); }
  return out;
}
