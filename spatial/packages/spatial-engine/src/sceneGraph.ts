import type {
  Aabb, Entity, Grounding, NodeType, Obb, Predicate, Relationship, Room, Vec3, WorldDocument,
} from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';

import { Bvh } from './accel/bvh.js';
import { aabbOverlaps } from './math/aabb.js';
import { footprintOverlapFraction, obbFromAabb, obbIntersectsObb } from './math/obb.js';
import { pointInRing, ringCentroid, sanitiseRing, type Ring2 } from './math/polygon.js';
import { quatNormalise, rotate } from './math/quat.js';
import { add, distance, isFiniteV3, sub } from './math/vec3.js';
import { buildSoup, type Soup } from './proxy.js';
import type { ProxyMesh } from './types.js';

/**
 * Every threshold the derivation uses, in one place, because each one is a
 * product decision rather than a mathematical fact and a reviewer should be
 * able to argue with them without reading the algorithms.
 */
export const SCENE_GRAPH_THRESHOLDS = {
  /**
   * Two rooms are adjacent when their outlines run parallel within this
   * distance. 0.35 m covers a UK stud partition (about 0.1 m), a masonry
   * partition (0.15 m) and a cavity party wall (0.3 m), and stops short of
   * calling two rooms with a cupboard between them adjacent.
   *
   * Matches ADJACENT_M in pipeline/worldengine/stages/graph.py. The four
   * constants marked this way are deliberately kept identical to the pipeline's
   * so that a world whose graph the pipeline derived and a world whose graph
   * this engine derived describe the same property. If one moves, both move.
   */
  wallSeparationM: 0.35,
  /** Shared run below this is a corner touch, not a shared wall. */
  minSharedWallM: 0.3,
  /**
   * "Near" is about reach and conversation: 1.5 m is roughly the length of a
   * two-seat sofa and the distance at which two pieces of furniture read as
   * belonging together in a photograph. Matches NEAR_M in the pipeline.
   */
  nearM: 1.5,
  /**
   * "Far" has to exceed the short dimension of an ordinary UK domestic room,
   * or every bedroom would contain pairs of far-apart objects. 4 m does. The
   * pipeline does not derive far_from at all, so this one is ours alone.
   */
  farM: 4.0,
  /**
   * Vertical contact tolerance: an object's base within this of another's top
   * is standing on it. Matches ON_GAP_M in the pipeline.
   */
  contactM: 0.12,
  /**
   * Footprint overlap needed before one object counts as on top of another.
   * Matches ON_OVERLAP in the pipeline.
   */
  supportOverlap: 0.33,
  /** Footprint overlap needed before "above"/"below" is meaningful at all. */
  aboveOverlap: 0.33,
  /**
   * Lateral separation needed for left_of/right_of. Below this the two objects
   * are side by side only in the sense that everything is, and the label is
   * noise.
   */
  lateralM: 0.2,
  /** Eye height for the sampled visibility rays. */
  eyeHeightM: 1.6,
  /** A blocker has to spoil more than half the samples before we name it. */
  blockFraction: 0.5,
} as const;

export interface SceneGraphOpts {
  readonly proxyMesh?: ProxyMesh;
  /** Reuse an engine's geometry instead of rebuilding it. */
  readonly soup?: Soup;
  readonly bvh?: Bvh;
  /** Skip the sampled-raycast predicates when only the cheap ones are wanted. */
  readonly skipVisibility?: boolean;
}

/**
 * Derive the scene graph from geometry.
 *
 * Every predicate in the contract's `Predicate` union that can be settled by
 * measurement is settled here. Nothing in this file asks a model what is next
 * to what -- that is the point. A language model that is handed these
 * relationships can phrase them; a language model asked to invent them will
 * produce a confident, plausible, unfalsifiable answer, which is precisely the
 * failure mode this product exists to avoid.
 */
export function buildSceneGraph(doc: WorldDocument, opts: SceneGraphOpts = {}): Relationship[] {
  const out: Relationship[] = [];
  const seen = new Set<string>();

  const emit = (
    subjectType: NodeType, subjectId: string, predicate: Predicate,
    objectType: NodeType, objectId: string, grounding: Grounding, value?: number,
  ): void => {
    if (subjectId === objectId && subjectType === objectType) return;
    const key = `${subjectId}|${predicate}|${objectId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value === undefined
      ? { subjectType, subjectId, predicate, objectType, objectId, grounding }
      : { subjectType, subjectId, predicate, objectType, objectId, grounding, value });
  };

  const rings: Ring2[] = doc.rooms.map((r) => sanitiseRing(r.polygon));
  const roomIndex = new Map<string, number>();
  doc.rooms.forEach((r, i) => roomIndex.set(r.id, i));

  deriveFloors(doc, emit);
  deriveContainment(doc, rings, roomIndex, emit);
  deriveAdjacency(doc, rings, emit);
  deriveConnectivity(doc, emit);
  deriveAttachment(doc, emit);
  deriveProximity(doc, rings, roomIndex, emit);
  deriveVertical(doc, emit);
  deriveLateral(doc, rings, roomIndex, emit);
  deriveIntersections(doc, emit);
  deriveSupport(doc, emit);

  if (!opts.skipVisibility) {
    const soup = opts.soup ?? buildSoup(doc, opts.proxyMesh);
    const bvh = opts.bvh ?? new Bvh(soup.positions, soup.indices);
    deriveVisibility(doc, rings, roomIndex, soup, bvh, emit);
  }

  return out;
}

type Emit = (
  subjectType: NodeType, subjectId: string, predicate: Predicate,
  objectType: NodeType, objectId: string, grounding: Grounding, value?: number,
) => void;

function pair(a: Grounding | undefined, b: Grounding | undefined): Grounding {
  const pa = a?.provenance ?? 'inferred';
  const pb = b?.provenance ?? 'inferred';
  const ca = Number.isFinite(a?.confidence) ? a!.confidence : 0.5;
  const cb = Number.isFinite(b?.confidence) ? b!.confidence : 0.5;
  return { provenance: weakestProvenance(pa, pb), confidence: Math.min(ca, cb) };
}

function boxOf(e: Entity): Aabb | undefined {
  if (e.aabb && isFiniteV3(e.aabb.min) && isFiniteV3(e.aabb.max)) return e.aabb;
  if (isFiniteV3(e.centroid)) return { min: e.centroid, max: e.centroid };
  return undefined;
}

function obbOf(e: Entity): Obb | undefined {
  if (e.obb && isFiniteV3(e.obb.centre) && isFiniteV3(e.obb.half)) return e.obb;
  const b = boxOf(e);
  return b ? obbFromAabb(b) : undefined;
}

// ---------------------------------------------------------------------------

function deriveFloors(doc: WorldDocument, emit: Emit): void {
  const floors = new Map(doc.floors.map((f) => [f.id, f]));
  for (const room of doc.rooms) {
    if (!room.floorId) continue;
    const f = floors.get(room.floorId);
    if (!f) continue;
    const g = pair(room.grounding, f.grounding);
    emit('room', room.id, 'inside', 'floor', f.id, g);
    emit('floor', f.id, 'contains', 'room', room.id, g);
  }
}

/** Containment is a polygon test, not a trust of the declared roomId. */
function deriveContainment(
  doc: WorldDocument, rings: Ring2[], roomIndex: Map<string, number>, emit: Emit,
): void {
  for (const e of doc.entities) {
    if (!isFiniteV3(e.centroid)) continue;
    let hit: Room | undefined;
    for (let i = 0; i < doc.rooms.length; i++) {
      const ring = rings[i]!;
      if (ring.length < 3) continue;
      const room = doc.rooms[i]!;
      const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
      const ceilY = Number.isFinite(room.ceilingZ) && room.ceilingZ > floorY
        ? room.ceilingZ : floorY + 2.4;
      if (e.centroid[1] < floorY - 0.05 || e.centroid[1] > ceilY + 0.05) continue;
      if (pointInRing(ring, e.centroid[0], e.centroid[2]) === 'out') continue;
      hit = room;
      break;
    }
    // A declared roomId that geometry contradicts is still worth honouring for
    // wall-mounted things whose centroid sits inside the wall itself.
    const room = hit ?? (e.roomId !== undefined
      ? doc.rooms[roomIndex.get(e.roomId) ?? -1]
      : undefined);
    if (!room) continue;
    const g = pair(e.grounding, room.grounding);
    emit('entity', e.id, 'inside', 'room', room.id, g);
    emit('room', room.id, 'contains', 'entity', e.id, g);
  }
}

interface Edge { ax: number; az: number; bx: number; bz: number; ux: number; uz: number; len: number }

function ringEdges(ring: Ring2): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    out.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], ux: dx / len, uz: dz / len, len });
  }
  return out;
}

/**
 * Adjacency from shared wall planes: two edges that are parallel, close, and
 * overlap along their shared direction describe the two faces of one partition.
 * The reported value is the length of the shared run, which is what a caller
 * needs to know whether a door could ever go there.
 */
function deriveAdjacency(doc: WorldDocument, rings: Ring2[], emit: Emit): void {
  const edges = rings.map(ringEdges);
  const T = SCENE_GRAPH_THRESHOLDS;
  for (let i = 0; i < doc.rooms.length; i++) {
    const a = doc.rooms[i]!;
    const aFloor = Number.isFinite(a.floorZ) ? a.floorZ : 0;
    const aCeil = Number.isFinite(a.ceilingZ) ? a.ceilingZ : aFloor + 2.4;
    for (let j = i + 1; j < doc.rooms.length; j++) {
      const b = doc.rooms[j]!;
      const bFloor = Number.isFinite(b.floorZ) ? b.floorZ : 0;
      const bCeil = Number.isFinite(b.ceilingZ) ? b.ceilingZ : bFloor + 2.4;
      // Rooms on different storeys share a slab, not a wall.
      if (Math.min(aCeil, bCeil) - Math.max(aFloor, bFloor) < 0.5) continue;

      let best = 0;
      for (const ea of edges[i]!) {
        for (const eb of edges[j]!) {
          const parallel = Math.abs(ea.ux * eb.uz - ea.uz * eb.ux);
          if (parallel > 0.02) continue; // ~1.1 degrees
          // Perpendicular distance from eb's start to ea's line.
          const px = eb.ax - ea.ax;
          const pz = eb.az - ea.az;
          const perp = Math.abs(px * -ea.uz + pz * ea.ux);
          if (perp > T.wallSeparationM) continue;
          // Overlap of the two runs projected onto ea's direction.
          const s0 = 0;
          const s1 = ea.len;
          const t0 = px * ea.ux + pz * ea.uz;
          const t1 = (eb.bx - ea.ax) * ea.ux + (eb.bz - ea.az) * ea.uz;
          const lo = Math.max(s0, Math.min(t0, t1));
          const hi = Math.min(s1, Math.max(t0, t1));
          const overlap = hi - lo;
          if (overlap > best) best = overlap;
        }
      }
      if (best < T.minSharedWallM) continue;
      const g = pair(a.grounding, b.grounding);
      emit('room', a.id, 'adjacent_to', 'room', b.id, g, best);
      emit('room', b.id, 'adjacent_to', 'room', a.id, g, best);
    }
  }
}

function deriveConnectivity(doc: WorldDocument, emit: Emit): void {
  const rooms = new Map(doc.rooms.map((r) => [r.id, r]));
  for (const op of doc.openings) {
    const a = op.roomA ? rooms.get(op.roomA) : undefined;
    const b = op.roomB ? rooms.get(op.roomB) : undefined;
    for (const r of [a, b]) {
      if (!r) continue;
      const g = pair(op.grounding, r.grounding);
      emit('opening', op.id, 'opens_into', 'room', r.id, g);
    }
    if (a && b) {
      const g = pair(a.grounding, b.grounding);
      emit('room', a.id, 'connected_to', 'room', b.id, g);
      emit('room', b.id, 'connected_to', 'room', a.id, g);
    }
  }
}

function deriveAttachment(doc: WorldDocument, emit: Emit): void {
  const surfaces = new Map(doc.surfaces.map((s) => [s.id, s]));
  const rooms = new Map(doc.rooms.map((r) => [r.id, r]));
  for (const s of doc.surfaces) {
    if (!s.roomId) continue;
    const r = rooms.get(s.roomId);
    if (!r) continue;
    const g = pair(s.grounding, r.grounding);
    emit('surface', s.id, 'attached_to', 'room', r.id, g);
    emit('room', r.id, 'contains', 'surface', s.id, g);
  }
  for (const op of doc.openings) {
    if (!op.surfaceId) continue;
    const s = surfaces.get(op.surfaceId);
    if (!s) continue;
    emit('opening', op.id, 'attached_to', 'surface', s.id, pair(op.grounding, s.grounding));
  }
}

/**
 * near/far only between things in the same room. Across a wall the centroid
 * distance is real but the relationship is not: a bed 1.2 m from a bath with a
 * partition between them is not "near" it in any sense a buyer cares about.
 */
function deriveProximity(
  doc: WorldDocument, rings: Ring2[], roomIndex: Map<string, number>, emit: Emit,
): void {
  const T = SCENE_GRAPH_THRESHOLDS;
  const byRoom = groupEntitiesByRoom(doc, rings, roomIndex);
  for (const list of byRoom.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (!isFiniteV3(a.centroid) || !isFiniteV3(b.centroid)) continue;
        const d = distance(a.centroid, b.centroid);
        const g = pair(a.grounding, b.grounding);
        if (d <= T.nearM) {
          emit('entity', a.id, 'near', 'entity', b.id, g, d);
          emit('entity', b.id, 'near', 'entity', a.id, g, d);
        } else if (d >= T.farM) {
          emit('entity', a.id, 'far_from', 'entity', b.id, g, d);
          emit('entity', b.id, 'far_from', 'entity', a.id, g, d);
        }
      }
    }
  }
}

function groupEntitiesByRoom(
  doc: WorldDocument, rings: Ring2[], roomIndex: Map<string, number>,
): Map<string, Entity[]> {
  const byRoom = new Map<string, Entity[]>();
  for (const e of doc.entities) {
    let rid = e.roomId;
    if (rid === undefined && isFiniteV3(e.centroid)) {
      for (let i = 0; i < doc.rooms.length; i++) {
        const ring = rings[i]!;
        if (ring.length >= 3 && pointInRing(ring, e.centroid[0], e.centroid[2]) !== 'out') {
          rid = doc.rooms[i]!.id;
          break;
        }
      }
    }
    if (rid === undefined || !roomIndex.has(rid)) continue;
    let list = byRoom.get(rid);
    if (!list) { list = []; byRoom.set(rid, list); }
    list.push(e);
  }
  return byRoom;
}

/**
 * above/below, in the world frame: +Y is up by contract, so this one needs no
 * observer. Requires a real footprint overlap, otherwise "the lamp is above the
 * rug on the other side of the room" comes out true.
 */
function deriveVertical(doc: WorldDocument, emit: Emit): void {
  const T = SCENE_GRAPH_THRESHOLDS;
  for (let i = 0; i < doc.entities.length; i++) {
    for (let j = 0; j < doc.entities.length; j++) {
      if (i === j) continue;
      const a = doc.entities[i]!;
      const b = doc.entities[j]!;
      const ba = boxOf(a);
      const bb = boxOf(b);
      if (!ba || !bb) continue;
      const overlap = Math.max(
        footprintOverlapFraction(ba, bb), footprintOverlapFraction(bb, ba),
      );
      if (overlap < T.aboveOverlap) continue;
      if (ba.min[1] >= bb.max[1] - 1e-6) {
        const g = pair(a.grounding, b.grounding);
        const gapM = ba.min[1] - bb.max[1];
        emit('entity', a.id, 'above', 'entity', b.id, g, gapM);
        emit('entity', b.id, 'below', 'entity', a.id, g, gapM);
      }
    }
  }
}

/**
 * left_of / right_of in an explicitly stated frame.
 *
 * FRAME: each room defines one. Its forward axis is the inward normal of its
 * longest wall, as if an observer stood against that wall looking into the
 * room; up is world +Y; right is forward x up, which is the right-handed
 * convention the contract fixes. So "the bedside table is left of the bed"
 * means left as seen by someone standing against the room's longest wall.
 *
 * This is arbitrary, but it is *stated* and it is stable across rescans as long
 * as the longest wall stays the longest wall. A frame chosen per query from the
 * camera would be more natural to a viewer and useless in a stored graph,
 * because the relationship would stop being a property of the world.
 */
function deriveLateral(
  doc: WorldDocument, rings: Ring2[], roomIndex: Map<string, number>, emit: Emit,
): void {
  const T = SCENE_GRAPH_THRESHOLDS;
  const byRoom = groupEntitiesByRoom(doc, rings, roomIndex);
  for (const [roomId, list] of byRoom) {
    const ri = roomIndex.get(roomId);
    if (ri === undefined) continue;
    const frame = roomFrame(rings[ri]!);
    if (!frame) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (!isFiniteV3(a.centroid) || !isFiniteV3(b.centroid)) continue;
        const d = sub(a.centroid, b.centroid);
        const lateral = d[0] * frame.rightX + d[2] * frame.rightZ;
        const forward = d[0] * frame.forwardX + d[2] * frame.forwardZ;
        if (Math.abs(lateral) < T.lateralM) continue;
        // Only claim a side when the offset is mostly sideways; otherwise the
        // honest answer is "in front of", which the contract has no word for.
        if (Math.abs(lateral) <= Math.abs(forward)) continue;
        const g = pair(a.grounding, b.grounding);
        if (lateral > 0) {
          emit('entity', a.id, 'right_of', 'entity', b.id, g, Math.abs(lateral));
          emit('entity', b.id, 'left_of', 'entity', a.id, g, Math.abs(lateral));
        } else {
          emit('entity', a.id, 'left_of', 'entity', b.id, g, Math.abs(lateral));
          emit('entity', b.id, 'right_of', 'entity', a.id, g, Math.abs(lateral));
        }
      }
    }
  }
}

export interface RoomFrame {
  forwardX: number; forwardZ: number;
  rightX: number; rightZ: number;
}

/**
 * See `deriveLateral` for what this frame means. Exported so callers can state
 * it too.
 *
 * The longest wall is chosen with an explicit tie-break: a rectangular room has
 * two equally long walls, and picking whichever the ring happened to list first
 * would flip left and right when a rescan rewinds the outline. Ties therefore
 * go to the wall whose midpoint is lowest in (x, z), which depends only on
 * where the room is, not on how it was written down.
 */
export function roomFrame(ring: Ring2): RoomFrame | null {
  if (ring.length < 3) return null;
  let bestLen = 0;
  let bestIdx = -1;
  let bestMid: [number, number] = [0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const longer = len > bestLen + 1e-6;
    const tied = Math.abs(len - bestLen) <= 1e-6
      && (mid[1] < bestMid[1] - 1e-9
        || (Math.abs(mid[1] - bestMid[1]) <= 1e-9 && mid[0] < bestMid[0] - 1e-9));
    if (bestIdx < 0 || longer || tied) { bestLen = Math.max(bestLen, len); bestIdx = i; bestMid = mid; }
  }
  if (bestIdx < 0 || bestLen < 1e-6) return null;
  const a = ring[bestIdx]!;
  const b = ring[(bestIdx + 1) % ring.length]!;
  const ux = (b[0] - a[0]) / bestLen;
  const uz = (b[1] - a[1]) / bestLen;
  let nx = -uz;
  let nz = ux;
  const mx = (a[0] + b[0]) / 2;
  const mz = (a[1] + b[1]) / 2;
  if (pointInRing(ring, mx + nx * 0.01, mz + nz * 0.01, 0) !== 'in') { nx = -nx; nz = -nz; }
  // right = forward x up, with up = +Y: (fx, 0, fz) x (0, 1, 0) = (-fz, 0, fx).
  return { forwardX: nx, forwardZ: nz, rightX: -nz, rightZ: nx };
}

function deriveIntersections(doc: WorldDocument, emit: Emit): void {
  for (let i = 0; i < doc.entities.length; i++) {
    const a = doc.entities[i]!;
    const ba = boxOf(a);
    const oa = obbOf(a);
    if (!ba || !oa) continue;
    for (let j = i + 1; j < doc.entities.length; j++) {
      const b = doc.entities[j]!;
      const bb = boxOf(b);
      const ob = obbOf(b);
      if (!bb || !ob) continue;
      if (!aabbOverlaps(ba, bb)) continue;
      // Shrunk by 1 mm: a coffee table standing ON a rug touches it, and
      // reporting that as an intersection would make every stacked object pair
      // look like a reconstruction error.
      if (!obbIntersectsObb(oa, ob, -0.001)) continue;
      // Overlap volume as a fraction of the smaller box: the contract wants
      // 0..1 here and "how much of the smaller thing is inside the bigger one"
      // is the reading that survives a reconstruction with sloppy boxes.
      const ox = Math.max(0, Math.min(ba.max[0], bb.max[0]) - Math.max(ba.min[0], bb.min[0]));
      const oy = Math.max(0, Math.min(ba.max[1], bb.max[1]) - Math.max(ba.min[1], bb.min[1]));
      const oz = Math.max(0, Math.min(ba.max[2], bb.max[2]) - Math.max(ba.min[2], bb.min[2]));
      const va = volume(ba);
      const vb = volume(bb);
      const small = Math.min(va, vb);
      const frac = small > 1e-9 ? Math.min(1, (ox * oy * oz) / small) : 0;
      if (!(ox * oy * oz > 1e-9)) continue;
      const g = pair(a.grounding, b.grounding);
      emit('entity', a.id, 'intersects', 'entity', b.id, g, frac);
      emit('entity', b.id, 'intersects', 'entity', a.id, g, frac);
    }
  }
}

function volume(b: Aabb): number {
  return Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1])
    * Math.max(0, b.max[2] - b.min[2]);
}

/**
 * supports / located_on from contact: a top face within `contactM` of another
 * object's bottom face, with enough footprint overlap that the upper object
 * could actually rest there. Also resolves the floor case against the room's
 * floor surface where one exists, so "what is the lamp standing on" has an
 * answer even in an empty room.
 */
function deriveSupport(doc: WorldDocument, emit: Emit): void {
  const T = SCENE_GRAPH_THRESHOLDS;
  const supported = new Set<string>();
  for (const upper of doc.entities) {
    const bu = boxOf(upper);
    if (!bu) continue;
    let bestId: string | undefined;
    let bestTop = -Infinity;
    let bestGrounding: Grounding | undefined;
    for (const lower of doc.entities) {
      if (lower.id === upper.id) continue;
      const bl = boxOf(lower);
      if (!bl) continue;
      if (Math.abs(bu.min[1] - bl.max[1]) > T.contactM) continue;
      if (footprintOverlapFraction(bl, bu) < T.supportOverlap) continue;
      // Choose the highest qualifying supporter: a book on a table on a rug is
      // on the table.
      if (bl.max[1] > bestTop) {
        bestTop = bl.max[1];
        bestId = lower.id;
        bestGrounding = lower.grounding;
      }
    }
    if (bestId) {
      const g = pair(upper.grounding, bestGrounding);
      emit('entity', bestId, 'supports', 'entity', upper.id, g);
      emit('entity', upper.id, 'located_on', 'entity', bestId, g);
      supported.add(upper.id);
    }
  }

  const floorSurfaceByRoom = new Map<string, string>();
  const surfaceGrounding = new Map<string, Grounding>();
  for (const s of doc.surfaces) {
    if (s.kind !== 'floor' || !s.roomId) continue;
    if (!floorSurfaceByRoom.has(s.roomId)) floorSurfaceByRoom.set(s.roomId, s.id);
    surfaceGrounding.set(s.id, s.grounding);
  }
  const rooms = new Map(doc.rooms.map((r) => [r.id, r]));
  for (const e of doc.entities) {
    if (supported.has(e.id)) continue;
    const b = boxOf(e);
    const rid = e.roomId;
    if (!b || !rid) continue;
    const room = rooms.get(rid);
    if (!room) continue;
    const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
    if (Math.abs(b.min[1] - floorY) > T.contactM) continue;
    const sid = floorSurfaceByRoom.get(rid);
    if (sid) {
      const g = pair(e.grounding, surfaceGrounding.get(sid));
      emit('entity', e.id, 'located_on', 'surface', sid, g);
      emit('surface', sid, 'supports', 'entity', e.id, g);
    } else {
      const g = pair(e.grounding, room.grounding);
      emit('entity', e.id, 'located_on', 'room', rid, g);
    }
  }
}

/**
 * visible_from and blocks, by sampled raycast.
 *
 * Viewpoints are the room's declared nav viewpoints when it has them, and its
 * centroid at eye height otherwise, because that is where a viewer actually
 * stands. Entities in the room and in every room joined to it by an opening are
 * tested -- a sightline through a doorway is exactly the case worth recording.
 */
function deriveVisibility(
  doc: WorldDocument, rings: Ring2[], roomIndex: Map<string, number>,
  soup: Soup, bvh: Bvh, emit: Emit,
): void {
  const T = SCENE_GRAPH_THRESHOLDS;
  const byRoom = groupEntitiesByRoom(doc, rings, roomIndex);
  const neighbours = new Map<string, Set<string>>();
  for (const op of doc.openings) {
    if (!op.roomA || !op.roomB) continue;
    if (!neighbours.has(op.roomA)) neighbours.set(op.roomA, new Set());
    if (!neighbours.has(op.roomB)) neighbours.set(op.roomB, new Set());
    neighbours.get(op.roomA)!.add(op.roomB);
    neighbours.get(op.roomB)!.add(op.roomA);
  }

  const viewpointsFor = (roomId: string): Vec3[] => {
    const declared = doc.nav.nodes
      .filter((n) => n.roomId === roomId && n.isViewpoint && isFiniteV3(n.position))
      .map((n): Vec3 => [n.position[0], n.position[1] + T.eyeHeightM, n.position[2]]);
    if (declared.length > 0) return declared.slice(0, 4);
    const ri = roomIndex.get(roomId);
    if (ri === undefined) return [];
    const ring = rings[ri]!;
    if (ring.length < 3) return [];
    const room = doc.rooms[ri]!;
    const c = ringCentroid(ring);
    const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
    return [[c[0], floorY + T.eyeHeightM, c[1]]];
  };

  for (const room of doc.rooms) {
    const eyes = viewpointsFor(room.id);
    if (eyes.length === 0) continue;
    const candidates: Entity[] = [...(byRoom.get(room.id) ?? [])];
    for (const nb of neighbours.get(room.id) ?? []) {
      for (const e of byRoom.get(nb) ?? []) candidates.push(e);
    }

    for (const e of candidates) {
      const samples = entitySamples(e);
      if (samples.length === 0) continue;
      let ok = 0;
      let total = 0;
      const blockers = new Map<string, number>();
      for (const eye of eyes) {
        for (const s of samples) {
          total++;
          const blocker = firstBlocker(soup, bvh, doc, eye, s, e.id);
          if (blocker === null) ok++;
          else if (blocker !== undefined) blockers.set(blocker, (blockers.get(blocker) ?? 0) + 1);
        }
      }
      if (total === 0) continue;
      const frac = ok / total;
      if (ok > 0) {
        const g: Grounding = {
          provenance: weakestProvenance(e.grounding.provenance, room.grounding.provenance),
          confidence: Math.min(e.grounding.confidence, room.grounding.confidence) * frac,
        };
        emit('entity', e.id, 'visible_from', 'room', room.id, g, frac);
      }
      for (const [id, n] of blockers) {
        if (n / total < T.blockFraction) continue;
        const other = doc.entities.find((x) => x.id === id);
        if (!other) continue;
        emit('entity', id, 'blocks', 'entity', e.id, pair(other.grounding, e.grounding), n / total);
      }
    }
  }
}

function entitySamples(e: Entity): Vec3[] {
  const o = obbOf(e);
  if (!o) return isFiniteV3(e.centroid) ? [e.centroid] : [];
  const q = quatNormalise(o.quat);
  const out: Vec3[] = [o.centre];
  // Four corners at 80% extent: enough to catch a partly-occluded object
  // without turning the derivation into a renderer.
  const signs: Array<[number, number, number]> = [
    [0.8, 0.8, 0.8], [-0.8, 0.8, 0.8], [0.8, 0.8, -0.8], [-0.8, 0.8, -0.8],
  ];
  for (const s of signs) {
    out.push(add(o.centre, rotate(q, [o.half[0] * s[0], o.half[1] * s[1], o.half[2] * s[2]])));
  }
  return out.filter(isFiniteV3);
}

/**
 * null  -> nothing in the way
 * string-> the entity id that blocked it
 * undefined -> blocked by structure (a wall), which is not worth a `blocks` edge
 */
function firstBlocker(
  soup: Soup, bvh: Bvh, doc: WorldDocument, from: Vec3, to: Vec3, targetId: string,
): string | null | undefined {
  const d = sub(to, from);
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-4)) return null;
  const ux = d[0] / len, uy = d[1] / len, uz = d[2] / len;
  const hit = bvh.raycast(from[0], from[1], from[2], ux, uy, uz, len - 0.002, (tri) => {
    const ei = soup.triEntity[tri]!;
    return ei >= 0 && doc.entities[ei]!.id === targetId;
  });
  if (!hit) return null;
  const ei = soup.triEntity[hit.tri]!;
  return ei >= 0 ? doc.entities[ei]!.id : undefined;
}
