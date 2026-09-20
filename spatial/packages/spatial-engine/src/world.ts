import type {
  Aabb, Entity, Intrinsics, NavNode, Obb, Opening, Predicate, Provenance, Quantity, Quat,
  Relationship, Room, Surface, Vec3, WorldDocument,
} from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';

import { Bvh } from './accel/bvh.js';
import { XZGrid, type Bounds2 } from './accel/xzGrid.js';
import {
  aabbContains, aabbFromObb, aabbFromPoints, aabbGap, aabbOverlaps,
} from './math/aabb.js';
import { obbContains, obbFromAabb, obbIntersectsObb, obbIntersectsTriangle } from './math/obb.js';
import {
  distancePointToRing, pointInRing, ringArea, ringBounds, ringCentroid,
  ringPerimeter, sanitiseRing, type Ring2,
} from './math/polygon.js';
import { quatFromYaw, quatNormalise, rotate } from './math/quat.js';
import { triangleNormal } from './math/triangle.js';
import { add, distance, dot, isFiniteV3, normalise, scale, sub } from './math/vec3.js';
import { Evidence, areaQuantity, lengthQuantity } from './measure.js';
import { buildSoup, roomAnchor, type Soup } from './proxy.js';
import { buildSceneGraph } from './sceneGraph.js';
import type { ProxyMesh, RayHit, Target } from './types.js';

export interface VisibleSet {
  rooms: Room[];
  entities: Entity[];
  openings: Opening[];
}

export interface FitResult {
  fits: boolean;
  placements: Obb[];
  reason?: string;
}

export interface PathResult {
  nodes: NavNode[];
  length: Quantity;
}

/** Standing eye height used wherever a "from this room" viewpoint is needed. */
const EYE_HEIGHT_M = 1.6;
/** How far above/below a room's slab a point may sit and still be "in" it. */
const ROOM_HEIGHT_SLACK_M = 0.05;
/** Cap on the clearance query; beyond this the answer stops being useful. */
const MAX_CLEARANCE_M = 20;
/**
 * How far outside a room outline a point may sit and still take that room's
 * provenance. A doorway node, a wall-mounted TV and a radiator bracket all live
 * in the thickness of a partition, which belongs to the rooms it separates.
 * 0.3 m is a party wall; beyond that a point really is somewhere else.
 */
const WALL_THICKNESS_TOLERANCE_M = 0.3;

export class World {
  readonly doc: WorldDocument;

  private readonly rings: Ring2[];
  private readonly roomBounds: Bounds2[];
  private readonly roomGrid: XZGrid;
  private readonly roomById = new Map<string, number>();

  private readonly regionGrid: XZGrid;

  private readonly entityById = new Map<string, Entity>();
  private readonly surfaceById = new Map<string, Surface>();
  private readonly surfaceIndexById = new Map<string, number>();
  private readonly openingById = new Map<string, Opening>();
  private readonly entitiesByRoom = new Map<string, Entity[]>();

  private readonly navById = new Map<string, number>();
  private readonly navAdjacency: Array<Array<{ to: number; cost: number }>>;
  /** Scale keeping the A* heuristic admissible against declared edge costs. */
  private readonly navHeuristicScale: number;

  readonly soup: Soup;
  readonly bvh: Bvh;

  private derived: Relationship[] | null = null;
  private relationshipsBySubject: Map<string, Relationship[]> | null = null;

  static fromDocument(doc: WorldDocument, opts?: { proxyMesh?: ProxyMesh }): World {
    return new World(doc, opts?.proxyMesh);
  }

  private constructor(doc: WorldDocument, proxyMesh?: ProxyMesh) {
    this.doc = doc;

    this.rings = doc.rooms.map((r) => sanitiseRing(r.polygon));
    this.roomBounds = this.rings.map((ring) => (
      ring.length >= 3
        ? ringBounds(ring)
        : { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }
    ));
    this.roomGrid = new XZGrid(this.roomBounds);
    doc.rooms.forEach((r, i) => this.roomById.set(r.id, i));

    this.regionGrid = new XZGrid(doc.regions.map((r) => regionBounds2(r.volume)));

    for (const e of doc.entities) this.entityById.set(e.id, e);
    doc.surfaces.forEach((s, i) => {
      this.surfaceById.set(s.id, s);
      this.surfaceIndexById.set(s.id, i);
    });
    for (const o of doc.openings) this.openingById.set(o.id, o);

    for (const e of doc.entities) {
      const rid = e.roomId ?? this.roomAt(e.centroid)?.id;
      if (!rid) continue;
      let list = this.entitiesByRoom.get(rid);
      if (!list) { list = []; this.entitiesByRoom.set(rid, list); }
      list.push(e);
    }

    doc.nav.nodes.forEach((n, i) => this.navById.set(n.id, i));
    this.navAdjacency = doc.nav.nodes.map(() => []);
    let minRatio = 1;
    for (const edge of doc.nav.edges) {
      const ia = this.navById.get(edge.a);
      const ib = this.navById.get(edge.b);
      if (ia === undefined || ib === undefined) continue;
      const na = doc.nav.nodes[ia]!;
      const nb = doc.nav.nodes[ib]!;
      const geom = distance(na.position, nb.position);
      const cost = Number.isFinite(edge.cost) && edge.cost > 0 ? edge.cost : geom;
      this.navAdjacency[ia]!.push({ to: ib, cost });
      this.navAdjacency[ib]!.push({ to: ia, cost });
      if (geom > 1e-6) minRatio = Math.min(minRatio, cost / geom);
    }
    // A door edge may cost more than its length (a turn, a threshold) but a
    // pipeline is also free to make it cost less. Scaling the straight-line
    // heuristic by the smallest cost-per-metre in the graph keeps A* admissible
    // either way, so the path it returns is genuinely the cheapest.
    this.navHeuristicScale = Math.max(0, Math.min(1, minRatio));

    this.soup = buildSoup(doc, proxyMesh);
    this.bvh = new Bvh(this.soup.positions, this.soup.indices);
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  room(id: string): Room | undefined {
    const i = this.roomById.get(id);
    return i === undefined ? undefined : this.doc.rooms[i];
  }

  entity(id: string): Entity | undefined {
    return this.entityById.get(id);
  }

  surface(id: string): Surface | undefined {
    return this.surfaceById.get(id);
  }

  opening(id: string): Opening | undefined {
    return this.openingById.get(id);
  }

  /**
   * The room containing a world point. Grid lookup, then an exact ring test on
   * the few candidates. A point exactly on a shared wall face belongs to the
   * room whose interior it is strictly inside; if it is only ever on a boundary
   * the first such room wins, deterministically by document order.
   */
  roomAt(p: Vec3): Room | undefined {
    if (!isFiniteV3(p)) return undefined;
    const cand = this.roomGrid.candidates(p[0], p[2]);
    let onEdge = -1;
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k]!;
      const room = this.doc.rooms[i];
      const ring = this.rings[i];
      if (!room || !ring || ring.length < 3) continue;
      const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
      const ceilY = Number.isFinite(room.ceilingZ) && room.ceilingZ > floorY
        ? room.ceilingZ : floorY + 2.4;
      if (p[1] < floorY - ROOM_HEIGHT_SLACK_M || p[1] > ceilY + ROOM_HEIGHT_SLACK_M) continue;
      const c = pointInRing(ring, p[0], p[2]);
      if (c === 'in') return room;
      if (c === 'on' && onEdge < 0) onEdge = i;
    }
    return onEdge >= 0 ? this.doc.rooms[onEdge] : undefined;
  }

  /**
   * Rooms whose outline is within `tol` of the point, vertically in range.
   * Only used on the provenance path, and only when exact containment failed,
   * so the linear scan costs nothing in the common case.
   */
  private roomsNear(p: Vec3, tol: number): Room[] {
    const out: Room[] = [];
    for (let i = 0; i < this.doc.rooms.length; i++) {
      const room = this.doc.rooms[i]!;
      const ring = this.rings[i]!;
      if (ring.length < 3) continue;
      const b = this.roomBounds[i]!;
      if (p[0] < b.minX - tol || p[0] > b.maxX + tol) continue;
      if (p[2] < b.minZ - tol || p[2] > b.maxZ + tol) continue;
      const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
      const ceilY = Number.isFinite(room.ceilingZ) && room.ceilingZ > floorY
        ? room.ceilingZ : floorY + 2.4;
      if (p[1] < floorY - ROOM_HEIGHT_SLACK_M || p[1] > ceilY + ROOM_HEIGHT_SLACK_M) continue;
      if (distancePointToRing(ring, p[0], p[2]) > tol) continue;
      out.push(room);
    }
    return out;
  }

  entitiesIn(roomId: string): Entity[] {
    return [...(this.entitiesByRoom.get(roomId) ?? [])];
  }

  findEntities(q: {
    label?: string; category?: string; roomId?: string;
    near?: Vec3; within?: number; limit?: number;
  } = {}): Entity[] {
    const label = q.label?.trim().toLowerCase();
    const pool = q.roomId ? this.entitiesIn(q.roomId) : [...this.doc.entities];
    const near = q.near && isFiniteV3(q.near) ? q.near : undefined;
    const within = Number.isFinite(q.within) ? (q.within as number) : undefined;

    const scored: Array<{ e: Entity; d: number }> = [];
    for (const e of pool) {
      if (q.category && e.category !== q.category) continue;
      if (label && !e.label.toLowerCase().includes(label)) continue;
      let d = 0;
      if (near) {
        d = this.targetDistanceToPoint(e, near);
        if (within !== undefined && d > within) continue;
      }
      scored.push({ e, d });
    }
    // Nearest first when a point was given, otherwise document order, which is
    // stable and makes test expectations reproducible.
    if (near) scored.sort((a, b) => a.d - b.d || a.e.id.localeCompare(b.e.id));
    const limit = Number.isFinite(q.limit) ? Math.max(0, Math.floor(q.limit as number)) : undefined;
    const out = scored.map((s) => s.e);
    return limit === undefined ? out : out.slice(0, limit);
  }

  private targetDistanceToPoint(e: Entity, p: Vec3): number {
    // Distance to the box, not the centroid: "within 1 m of me" should mean the
    // sofa you can touch, not the sofa whose middle is a metre away.
    if (e.aabb && isFiniteV3(e.aabb.min) && isFiniteV3(e.aabb.max)) {
      return aabbGap(e.aabb, { min: p, max: p });
    }
    return distance(e.centroid, p);
  }

  // -------------------------------------------------------------------------
  // Rays and visibility
  // -------------------------------------------------------------------------

  raycast(
    origin: Vec3, dir: Vec3, opts?: { maxDistance?: number; ignore?: string[] },
  ): RayHit | null {
    if (!isFiniteV3(origin) || !isFiniteV3(dir)) return null;
    const d = normalise(dir);
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return null;
    const maxDistance = Number.isFinite(opts?.maxDistance) ? opts!.maxDistance! : Infinity;
    const skip = this.makeSkip(opts?.ignore);

    const hit = this.bvh.raycast(
      origin[0], origin[1], origin[2], d[0], d[1], d[2], maxDistance, skip,
    );
    if (!hit) return null;

    const point: Vec3 = [
      origin[0] + d[0] * hit.t, origin[1] + d[1] * hit.t, origin[2] + d[2] * hit.t,
    ];
    const [a, b, c] = this.triangleVertices(hit.tri);
    let n = triangleNormal(a, b, c);
    if (dot(n, d) > 0) n = [-n[0], -n[1], -n[2]];

    const si = this.soup.triSurface[hit.tri]!;
    const ei = this.soup.triEntity[hit.tri]!;
    const surfaceId = si >= 0 ? this.doc.surfaces[si]?.id : undefined;
    const entityId = ei >= 0 ? this.doc.entities[ei]?.id : undefined;

    const owner = ei >= 0
      ? this.doc.entities[ei]?.grounding.provenance
      : si >= 0 ? this.doc.surfaces[si]?.grounding.provenance : undefined;
    const provenance = weakestProvenance(owner ?? 'reconstructed', this.provenanceAt(point));

    const out: RayHit = { point, distance: hit.t, normal: n, provenance };
    if (surfaceId !== undefined) out.surfaceId = surfaceId;
    if (entityId !== undefined) out.entityId = entityId;
    return out;
  }

  private makeSkip(ignore?: string[]): ((tri: number) => boolean) | undefined {
    if (!ignore || ignore.length === 0) return undefined;
    const set = new Set(ignore);
    const surfaces = this.doc.surfaces;
    const entities = this.doc.entities;
    const rooms = this.doc.rooms;
    const soup = this.soup;
    return (tri: number): boolean => {
      const ei = soup.triEntity[tri]!;
      if (ei >= 0 && set.has(entities[ei]!.id)) return true;
      const si = soup.triSurface[tri]!;
      if (si >= 0 && set.has(surfaces[si]!.id)) return true;
      const ri = soup.triRoom[tri]!;
      if (ri >= 0 && set.has(rooms[ri]!.id)) return true;
      return false;
    };
  }

  private triangleVertices(tri: number): [Vec3, Vec3, Vec3] {
    const idx = this.soup.indices;
    const pos = this.soup.positions;
    const i0 = idx[tri * 3]! * 3, i1 = idx[tri * 3 + 1]! * 3, i2 = idx[tri * 3 + 2]! * 3;
    return [
      [pos[i0]!, pos[i0 + 1]!, pos[i0 + 2]!],
      [pos[i1]!, pos[i1 + 1]!, pos[i1 + 2]!],
      [pos[i2]!, pos[i2 + 1]!, pos[i2 + 2]!],
    ];
  }

  checkVisibility(from: Vec3, targetId: string): { visible: boolean; blockedBy?: string } {
    if (!isFiniteV3(from)) return { visible: false };
    const samples = this.visibilitySamples(targetId);
    if (samples.length === 0) return { visible: false };
    const blockers = new Map<string, number>();
    for (const s of samples) {
      const delta = sub(s, from);
      const dist = Math.sqrt(dot(delta, delta));
      if (dist < 1e-4) return { visible: true };
      // Stop 2 mm short so the target's own surface is never the blocker.
      const hit = this.raycast(from, delta, {
        maxDistance: dist - 0.002, ignore: [targetId],
      });
      if (!hit) return { visible: true };
      const id = hit.entityId ?? hit.surfaceId ?? this.roomAt(hit.point)?.id;
      if (id) blockers.set(id, (blockers.get(id) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [id, n] of blockers) if (n > bestN) { bestN = n; best = id; }
    return best === undefined ? { visible: false } : { visible: false, blockedBy: best };
  }

  /**
   * Points on a target that count as "seeing it". Corners are pulled 15% toward
   * the centre so a sample never lands exactly on the surface plane, where
   * floating point decides arbitrarily whether the ray hits the target itself.
   */
  private visibilitySamples(targetId: string): Vec3[] {
    const e = this.entityById.get(targetId);
    if (e) {
      const obb = e.obb ?? (e.aabb ? obbFromAabb(e.aabb) : undefined);
      const out: Vec3[] = [e.centroid];
      if (obb) {
        const q = quatNormalise(obb.quat);
        for (let i = 0; i < 8; i++) {
          const sx = (i & 1) ? 0.85 : -0.85;
          const sy = (i & 2) ? 0.85 : -0.85;
          const sz = (i & 4) ? 0.85 : -0.85;
          const local: Vec3 = [obb.half[0] * sx, obb.half[1] * sy, obb.half[2] * sz];
          out.push(add(obb.centre, rotate(q, local)));
        }
      }
      return out.filter(isFiniteV3);
    }

    const op = this.openingById.get(targetId);
    if (op) {
      const w = (op.width?.value ?? 0.85) * 0.35;
      const h = (op.height?.value ?? 2.0) * 0.35;
      const n = op.normal && isFiniteV3(op.normal) ? normalise(op.normal) : ([0, 0, 1] as Vec3);
      const tangent = normalise([-n[2], 0, n[0]]);
      const c = op.centre;
      return [
        c,
        add(c, scale(tangent, w)), add(c, scale(tangent, -w)),
        add(c, [0, h, 0]), add(c, [0, -h, 0]),
      ].filter(isFiniteV3);
    }

    const s = this.surfaceById.get(targetId);
    if (s) {
      const pts = s.polygon.filter(isFiniteV3);
      if (pts.length === 0) return [];
      const centre = scale(pts.reduce(add, [0, 0, 0] as Vec3), 1 / pts.length);
      return [centre, ...pts.map((p) => add(centre, scale(sub(p, centre), 0.85)))];
    }

    const r = this.room(targetId);
    if (r) {
      const i = this.roomById.get(targetId)!;
      const ring = this.rings[i]!;
      const anchor = roomAnchor(r);
      const floorY = Number.isFinite(r.floorZ) ? r.floorZ : 0;
      const eye = floorY + EYE_HEIGHT_M;
      const c = ring.length >= 3 ? ringCentroid(ring) : [anchor[0], anchor[2]] as const;
      const out: Vec3[] = [[c[0], eye, c[1]]];
      for (const v of ring) {
        // Pull inside the wall so the sample is in the room, not in the plaster.
        out.push([c[0] + (v[0] - c[0]) * 0.85, eye, c[1] + (v[1] - c[1]) * 0.85]);
      }
      return out;
    }
    return [];
  }

  visibleFrom(
    pose: { position: Vec3; orientation: Quat; intrinsics?: Intrinsics; fov?: number },
    opts?: { maxDistance?: number },
  ): VisibleSet {
    const empty: VisibleSet = { rooms: [], entities: [], openings: [] };
    if (!pose || !isFiniteV3(pose.position)) return empty;
    const maxDistance = Number.isFinite(opts?.maxDistance) ? opts!.maxDistance! : 30;

    const frustum = makeFrustum(pose, maxDistance);
    const origin = pose.position;

    const entities: Entity[] = [];
    for (const e of this.doc.entities) {
      const box = e.aabb && isFiniteV3(e.aabb.min) && isFiniteV3(e.aabb.max)
        ? e.aabb
        : { min: e.centroid, max: e.centroid };
      if (!frustum.containsAabb(box)) continue;
      if (this.checkVisibility(origin, e.id).visible) entities.push(e);
    }

    const openings: Opening[] = [];
    for (const o of this.doc.openings) {
      if (!isFiniteV3(o.centre)) continue;
      if (!frustum.containsPoint(o.centre)) continue;
      if (this.checkVisibility(origin, o.id).visible) openings.push(o);
    }

    const rooms: Room[] = [];
    const here = this.roomAt(origin);
    if (here) rooms.push(here);
    const seen = new Set<string>(here ? [here.id] : []);
    for (const e of entities) {
      const rid = e.roomId ?? this.roomAt(e.centroid)?.id;
      if (rid && !seen.has(rid)) {
        const r = this.room(rid);
        if (r) { rooms.push(r); seen.add(rid); }
      }
    }
    for (const o of openings) {
      for (const rid of [o.roomA, o.roomB]) {
        if (!rid || seen.has(rid)) continue;
        const r = this.room(rid);
        if (!r) continue;
        // An opening you can see means you can see into the room behind it,
        // but only if some point in that room is actually reachable by a ray.
        if (this.checkVisibility(origin, rid).visible) { rooms.push(r); seen.add(rid); }
      }
    }
    for (const r of this.doc.rooms) {
      if (seen.has(r.id)) continue;
      const i = this.roomById.get(r.id)!;
      const b = this.roomBounds[i]!;
      if (!Number.isFinite(b.minX)) continue;
      const floorY = Number.isFinite(r.floorZ) ? r.floorZ : 0;
      const box: Aabb = {
        min: [b.minX, floorY, b.minZ],
        max: [b.maxX, Number.isFinite(r.ceilingZ) ? r.ceilingZ : floorY + 2.4, b.maxZ],
      };
      if (!frustum.containsAabb(box)) continue;
      if (this.checkVisibility(origin, r.id).visible) { rooms.push(r); seen.add(r.id); }
    }

    return { rooms, entities, openings };
  }

  checkCollision(obb: Obb): { collides: boolean; with: string[] } {
    const hits = new Set<string>();
    if (!obb || !isFiniteV3(obb.centre) || !isFiniteV3(obb.half)) {
      return { collides: false, with: [] };
    }
    const query: Obb = {
      centre: obb.centre,
      half: [Math.abs(obb.half[0]), Math.abs(obb.half[1]), Math.abs(obb.half[2])],
      quat: obb.quat,
    };
    const box = aabbFromObb(query);

    for (const e of this.doc.entities) {
      if (!e.aabb || !aabbOverlaps(box, e.aabb)) continue;
      const other = e.obb ?? obbFromAabb(e.aabb);
      if (obbIntersectsObb(query, other)) hits.add(e.id);
    }

    // Structural geometry is tested with the box shrunk by 1 mm so that resting
    // on a floor or touching a wall is contact, not collision. Without this
    // every piece of furniture standing on the ground "collides" with its room.
    const shrunk: Obb = {
      centre: query.centre,
      half: [
        Math.max(0, query.half[0] - 0.001),
        Math.max(0, query.half[1] - 0.001),
        Math.max(0, query.half[2] - 0.001),
      ],
      quat: query.quat,
    };
    const tris: number[] = [];
    this.bvh.queryAabb(
      box.min[0], box.min[1], box.min[2], box.max[0], box.max[1], box.max[2],
      (t) => { tris.push(t); },
    );
    for (const t of tris) {
      if (this.soup.triEntity[t]! >= 0) continue; // already covered by the SAT pass
      const [a, b, c] = this.triangleVertices(t);
      if (!obbIntersectsTriangle(shrunk, a, b, c)) continue;
      const si = this.soup.triSurface[t]!;
      if (si >= 0) { hits.add(this.doc.surfaces[si]!.id); continue; }
      const ri = this.soup.triRoom[t]!;
      if (ri >= 0) hits.add(this.doc.rooms[ri]!.id);
    }

    const list = [...hits].sort();
    return { collides: list.length > 0, with: list };
  }

  // -------------------------------------------------------------------------
  // Measurement
  // -------------------------------------------------------------------------

  measureDistance(a: Target, b: Target): Quantity {
    const ra = this.resolveTarget(a);
    const rb = this.resolveTarget(b);
    const ev = new Evidence();
    ev.addGrounding(ra.grounding);
    ev.addGrounding(rb.grounding);
    this.addPointEvidence(ev, ra.point);
    this.addPointEvidence(ev, rb.point);

    const value = distance(ra.point, rb.point);
    const gap = ra.box && rb.box ? aabbGap(ra.box, rb.box) : undefined;

    return lengthQuantity(this.doc, value, ev, {
      segments: 1,
      basis: {
        kind: 'centre-to-centre',
        from: ra.point,
        to: rb.point,
        fromId: ra.id,
        toId: rb.id,
        // The nearest-surface gap is what a person usually means by "how far is
        // the sofa from the window", so it travels with the answer. The primary
        // value stays centre to centre because that is the only definition that
        // is meaningful for every Target kind, including a bare point.
        ...(gap === undefined ? {} : { gapM: gap }),
      },
    });
  }

  measureArea(roomId: string): Quantity {
    const i = this.roomById.get(roomId);
    const room = i === undefined ? undefined : this.doc.rooms[i];
    if (!room || i === undefined) throw new Error(`measureArea: no room '${roomId}'`);
    const ring = this.rings[i]!;
    const ev = new Evidence();
    ev.addGrounding(room.grounding);
    ev.addGrounding(room.area?.grounding);

    const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
    // Only regions overlapping the floor band matter: area is a floor-plane
    // measurement, and an unobserved ceiling void says nothing about it.
    const band: Aabb = {
      min: [this.roomBounds[i]!.minX, floorY - 0.05, this.roomBounds[i]!.minZ],
      max: [this.roomBounds[i]!.maxX, floorY + 0.3, this.roomBounds[i]!.maxZ],
    };
    for (const region of this.doc.regions) {
      if (!aabbOverlaps(band, region.volume)) continue;
      ev.addProvenance(region.provenance);
      if (region.provenance !== 'observed') ev.markUnobserved();
    }

    const area = ringArea(ring);
    return areaQuantity(this.doc, area, ev, {
      perimeter: ringPerimeter(ring),
      basis: {
        roomId,
        vertices: ring.length,
        degenerate: ring.length < 3,
        ...(room.area ? { declaredAreaM2: room.area.value } : {}),
      },
    });
  }

  /**
   * Radius of the largest empty sphere centred on p. Zero inside an entity,
   * because "clearance" there is not a distance, it is an obstruction.
   */
  measureClearance(p: Vec3): Quantity {
    const ev = new Evidence();
    this.addPointEvidence(ev, p);
    if (!isFiniteV3(p)) {
      return lengthQuantity(this.doc, 0, ev, { basis: { invalidPoint: true, capped: false } });
    }

    for (const e of this.doc.entities) {
      if (!e.aabb || !aabbContains(e.aabb, p)) continue;
      const obb = e.obb ?? obbFromAabb(e.aabb);
      if (!obbContains(obb, p)) continue;
      ev.addGrounding(e.grounding);
      return lengthQuantity(this.doc, 0, ev, {
        basis: { insideEntityId: e.id, capped: false },
      });
    }

    const near = this.bvh.closestPoint(p[0], p[1], p[2], MAX_CLEARANCE_M);
    if (!near) {
      return lengthQuantity(this.doc, MAX_CLEARANCE_M, ev, { basis: { capped: true } });
    }
    const si = this.soup.triSurface[near.tri]!;
    const ei = this.soup.triEntity[near.tri]!;
    if (ei >= 0) ev.addGrounding(this.doc.entities[ei]?.grounding);
    else if (si >= 0) ev.addGrounding(this.doc.surfaces[si]?.grounding);
    return lengthQuantity(this.doc, near.distance, ev, {
      basis: {
        capped: false,
        nearestPoint: [near.px, near.py, near.pz],
        ...(ei >= 0 ? { nearestEntityId: this.doc.entities[ei]?.id } : {}),
        ...(si >= 0 ? { nearestSurfaceId: this.doc.surfaces[si]?.id } : {}),
      },
    });
  }

  private addPointEvidence(ev: Evidence, p: Vec3): void {
    if (!isFiniteV3(p)) { ev.addProvenance('generated'); ev.markUnobserved(); return; }
    ev.addProvenance(this.provenanceAt(p));
    if (!this.isObserved(p)) ev.markUnobserved();
  }

  private resolveTarget(t: Target): {
    point: Vec3; box?: Aabb; grounding?: Entity['grounding']; id?: string;
  } {
    if (isFiniteV3(t)) return { point: t };
    if (typeof t !== 'object' || t === null) {
      throw new TypeError('measure target must be a Vec3 or an {entityId|roomId|openingId|surfaceId}');
    }
    if ('entityId' in t) {
      const e = this.entityById.get(t.entityId);
      if (!e) throw new Error(`no entity '${t.entityId}'`);
      const box = e.obb ? aabbFromObb(e.obb) : e.aabb;
      return { point: e.centroid, box, grounding: e.grounding, id: e.id };
    }
    if ('roomId' in t) {
      const r = this.room(t.roomId);
      if (!r) throw new Error(`no room '${t.roomId}'`);
      const i = this.roomById.get(t.roomId)!;
      const b = this.roomBounds[i]!;
      const floorY = Number.isFinite(r.floorZ) ? r.floorZ : 0;
      const ceilY = Number.isFinite(r.ceilingZ) && r.ceilingZ > floorY ? r.ceilingZ : floorY + 2.4;
      const box: Aabb | undefined = Number.isFinite(b.minX)
        ? { min: [b.minX, floorY, b.minZ], max: [b.maxX, ceilY, b.maxZ] }
        : undefined;
      return { point: roomAnchor(r), box, grounding: r.grounding, id: r.id };
    }
    if ('openingId' in t) {
      const o = this.openingById.get(t.openingId);
      if (!o) throw new Error(`no opening '${t.openingId}'`);
      const w = (o.width?.value ?? 0.85) / 2;
      const h = (o.height?.value ?? 2.0) / 2;
      const box: Aabb = {
        min: [o.centre[0] - w, o.centre[1] - h, o.centre[2] - w],
        max: [o.centre[0] + w, o.centre[1] + h, o.centre[2] + w],
      };
      return { point: o.centre, box, grounding: o.grounding, id: o.id };
    }
    if ('surfaceId' in t) {
      const s = this.surfaceById.get(t.surfaceId);
      if (!s) throw new Error(`no surface '${t.surfaceId}'`);
      const pts = s.polygon.filter(isFiniteV3);
      if (pts.length === 0) throw new Error(`surface '${t.surfaceId}' has no usable polygon`);
      const centre = scale(pts.reduce(add, [0, 0, 0] as Vec3), 1 / pts.length);
      return { point: centre, box: aabbFromPoints(pts), grounding: s.grounding, id: s.id };
    }
    throw new TypeError('unrecognised measure target');
  }

  // -------------------------------------------------------------------------
  // Fit
  // -------------------------------------------------------------------------

  fitTest(
    roomId: string, size: Vec3, opts?: { againstWall?: boolean; clearance?: number },
  ): FitResult {
    const i = this.roomById.get(roomId);
    const room = i === undefined ? undefined : this.doc.rooms[i];
    if (!room || i === undefined) return { fits: false, placements: [], reason: `no room '${roomId}'` };
    const ring = this.rings[i]!;
    if (ring.length < 3) {
      return { fits: false, placements: [], reason: 'room outline is degenerate' };
    }
    if (!isFiniteV3(size) || size[0] <= 0 || size[1] <= 0 || size[2] <= 0) {
      return { fits: false, placements: [], reason: 'size must be three positive metres' };
    }

    const clearance = Number.isFinite(opts?.clearance) ? Math.max(0, opts!.clearance!) : 0;
    const againstWall = opts?.againstWall === true;
    const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
    const ceilY = Number.isFinite(room.ceilingZ) && room.ceilingZ > floorY
      ? room.ceilingZ : floorY + 2.4;
    const clearHeight = ceilY - floorY;
    if (size[1] > clearHeight + 1e-6) {
      return {
        fits: false,
        placements: [],
        reason: `too tall: needs ${size[1].toFixed(2)} m of clear height, ${room.name ?? roomId} has ${clearHeight.toFixed(2)} m`,
      };
    }

    const obstacles = this.entitiesIn(roomId)
      .filter((e) => e.aabb && isFiniteV3(e.aabb.min) && isFiniteV3(e.aabb.max))
      .map((e) => ({ id: e.id, obb: e.obb ?? obbFromAabb(e.aabb) }));

    const hx = size[0] / 2 + clearance;
    const hz = size[2] / 2 + clearance;
    const centroid = ringCentroid(ring);
    const bounds = ringBounds(ring);

    const state = {
      anyFootprint: false,
      anyWall: false,
      blockers: new Set<string>(),
    };
    const placements: Obb[] = [];

    // Two passes. The coarse one answers almost every real query immediately;
    // the fine one exists for the awkward case where an object only fits at an
    // angle, in one position, with centimetres to spare.
    const passes: Array<{ step: number; yawStep: number }> = [
      { step: clampStep(Math.min(size[0], size[2]) * 0.5, 0.05, 0.25), yawStep: Math.PI / 12 },
      { step: clampStep(Math.min(size[0], size[2]) * 0.15, 0.025, 0.08), yawStep: Math.PI / 36 },
    ];

    for (const pass of passes) {
      this.sweepPlacements(
        ring, bounds, centroid, floorY, size, hx, hz, clearance,
        obstacles, againstWall, pass.step, pass.yawStep, placements, state,
      );
      if (placements.length > 0) break;
    }

    if (placements.length > 0) return { fits: true, placements };

    let reason: string;
    if (!state.anyFootprint) {
      reason = `footprint ${size[0].toFixed(2)} x ${size[2].toFixed(2)} m does not fit inside the outline of ${room.name ?? roomId} at any tested position or angle`;
    } else if (againstWall && !state.anyWall) {
      reason = 'fits in the room but never flush against a wall';
    } else if (state.blockers.size > 0) {
      reason = `no position clear of existing furniture (blocked by ${[...state.blockers].sort().join(', ')})`;
    } else {
      reason = 'no valid placement found';
    }
    return { fits: false, placements: [], reason };
  }

  private sweepPlacements(
    ring: Ring2,
    bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
    centroid: readonly [number, number],
    floorY: number,
    size: Vec3,
    hx: number,
    hz: number,
    clearance: number,
    obstacles: Array<{ id: string; obb: Obb }>,
    againstWall: boolean,
    step: number,
    yawStep: number,
    out: Obb[],
    state: { anyFootprint: boolean; anyWall: boolean; blockers: Set<string> },
  ): void {
    const maxPlacements = 8;
    const yawCount = Math.max(1, Math.round(Math.PI / yawStep));

    // The grid is anchored on the room centroid, not on its bounding box: a
    // diagonal fit in a symmetric room lives exactly at the centre, and a grid
    // anchored anywhere else can step straight over it.
    const i0 = -Math.ceil((centroid[0] - bounds.minX) / step) - 1;
    const i1 = Math.ceil((bounds.maxX - centroid[0]) / step) + 1;
    const j0 = -Math.ceil((centroid[1] - bounds.minZ) / step) - 1;
    const j1 = Math.ceil((bounds.maxZ - centroid[1]) / step) + 1;

    for (let k = 0; k < yawCount; k++) {
      const yaw = k * yawStep;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      for (let j = j0; j <= j1; j++) {
        const cz = centroid[1] + j * step;
        for (let i = i0; i <= i1; i++) {
          const cx = centroid[0] + i * step;
          if (!rectInsideRing(ring, cx, cz, hx, hz, cos, sin)) continue;
          state.anyFootprint = true;

          if (againstWall && !rectAgainstWall(ring, cx, cz, hx, hz, cos, sin, clearance)) continue;
          state.anyWall = true;

          const candidate: Obb = {
            centre: [cx, floorY + size[1] / 2, cz],
            half: [size[0] / 2 + clearance, size[1] / 2, size[2] / 2 + clearance],
            quat: quatFromYaw(yaw),
          };
          let blocked = false;
          for (const o of obstacles) {
            if (obbIntersectsObb(candidate, o.obb)) {
              state.blockers.add(o.id);
              blocked = true;
              break;
            }
          }
          if (blocked) continue;

          out.push({
            centre: [cx, floorY + size[1] / 2, cz],
            half: [size[0] / 2, size[1] / 2, size[2] / 2],
            quat: quatFromYaw(yaw),
          });
          if (out.length >= maxPlacements) return;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  findPath(from: Vec3 | string, to: Vec3 | string): PathResult | null {
    const startIdx = this.resolveNavNode(from);
    const goalIdx = this.resolveNavNode(to);
    if (startIdx < 0 || goalIdx < 0) return null;
    const nodes = this.doc.nav.nodes;

    if (startIdx === goalIdx) {
      const ev = new Evidence();
      ev.addProvenance(this.provenanceAt(nodes[startIdx]!.position));
      return {
        nodes: [nodes[startIdx]!],
        length: lengthQuantity(this.doc, 0, ev, { segments: 1, basis: { hops: 0 } }),
      };
    }

    const n = nodes.length;
    const gScore = new Float64Array(n).fill(Infinity);
    const fScore = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const goal = nodes[goalIdx]!.position;
    const h = (i: number): number => this.navHeuristicScale * distance(nodes[i]!.position, goal);

    gScore[startIdx] = 0;
    fScore[startIdx] = h(startIdx);
    // A linear-scan open set. Nav graphs in this system are tens of nodes, not
    // thousands, and a binary heap would cost more in code than it saves.
    const open = new Set<number>([startIdx]);

    while (open.size > 0) {
      let current = -1;
      let best = Infinity;
      for (const i of open) if (fScore[i]! < best) { best = fScore[i]!; current = i; }
      if (current < 0) break;
      if (current === goalIdx) break;
      open.delete(current);
      closed[current] = 1;
      for (const edge of this.navAdjacency[current]!) {
        if (closed[edge.to]) continue;
        const tentative = gScore[current]! + edge.cost;
        if (tentative < gScore[edge.to]!) {
          cameFrom[edge.to] = current;
          gScore[edge.to] = tentative;
          fScore[edge.to] = tentative + h(edge.to);
          open.add(edge.to);
        }
      }
    }

    if (!Number.isFinite(gScore[goalIdx]!)) return null;

    const path: number[] = [];
    for (let cur = goalIdx; cur >= 0; cur = cameFrom[cur]!) {
      path.push(cur);
      if (cur === startIdx) break;
    }
    path.reverse();
    if (path[0] !== startIdx) return null;

    const ev = new Evidence();
    const segments: number[] = [];
    let total = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = nodes[path[i]!]!;
      const b = nodes[path[i + 1]!]!;
      const d = distance(a.position, b.position);
      total += d;
      segments.push(d);
      this.addPointEvidence(ev, a.position);
    }
    this.addPointEvidence(ev, nodes[path[path.length - 1]!]!.position);

    return {
      nodes: path.map((i) => nodes[i]!),
      length: lengthQuantity(this.doc, total, ev, {
        segments: segments.length,
        basis: { hops: segments.length, graphCost: gScore[goalIdx], segmentLengthsM: segments },
      }),
    };
  }

  private resolveNavNode(t: Vec3 | string): number {
    const nodes = this.doc.nav.nodes;
    if (nodes.length === 0) return -1;
    if (typeof t === 'string') {
      const direct = this.navById.get(t);
      if (direct !== undefined) return direct;
      const room = this.room(t);
      if (room) {
        const inRoom = nodes.findIndex((n) => n.roomId === t);
        if (inRoom >= 0) return inRoom;
        return nearestNode(nodes, roomAnchor(room));
      }
      const e = this.entityById.get(t);
      if (e) return nearestNode(nodes, e.centroid);
      const o = this.openingById.get(t);
      if (o) return nearestNode(nodes, o.centre);
      return -1;
    }
    if (!isFiniteV3(t)) return -1;
    return nearestNode(nodes, t);
  }

  // -------------------------------------------------------------------------
  // Scene graph
  // -------------------------------------------------------------------------

  /**
   * Relationships the document declares, plus the ones derived from geometry.
   * A declared relationship always wins on a (subject, predicate, object)
   * collision: the pipeline had the raw observations and this engine only has
   * the tidied output.
   */
  relationships(subjectId: string, predicate?: Predicate): Relationship[] {
    if (this.relationshipsBySubject === null) {
      if (this.derived === null) {
        this.derived = buildSceneGraph(this.doc, { soup: this.soup, bvh: this.bvh });
      }
      const map = new Map<string, Relationship[]>();
      const seen = new Set<string>();
      const push = (r: Relationship): void => {
        const key = `${r.subjectId}|${r.predicate}|${r.objectId}`;
        if (seen.has(key)) return;
        seen.add(key);
        let list = map.get(r.subjectId);
        if (!list) { list = []; map.set(r.subjectId, list); }
        list.push(r);
      };
      for (const r of this.doc.relationships) push(r);
      for (const r of this.derived) push(r);
      this.relationshipsBySubject = map;
    }
    const all = this.relationshipsBySubject.get(subjectId) ?? [];
    return predicate ? all.filter((r) => r.predicate === predicate) : [...all];
  }

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  /**
   * Provenance of a world point: the weakest of every region containing it and
   * the room it sits in. A point supported by nothing at all is reported
   * 'generated' -- there is no observation, no reconstruction and no declared
   * region behind it, so it takes the same refusal path as invented geometry.
   */
  provenanceAt(p: Vec3): Provenance {
    if (!isFiniteV3(p)) return 'generated';
    let worst: Provenance | null = null;
    const cand = this.regionGrid.candidates(p[0], p[2]);
    for (let k = 0; k < cand.length; k++) {
      const region = this.doc.regions[cand[k]!];
      if (!region || !aabbContains(region.volume, p)) continue;
      worst = worst === null ? region.provenance : weakestProvenance(worst, region.provenance);
    }
    const room = this.roomAt(p);
    const supporting = room ? [room] : this.roomsNear(p, WALL_THICKNESS_TOLERANCE_M);
    for (const r of supporting) {
      worst = worst === null
        ? r.grounding.provenance
        : weakestProvenance(worst, r.grounding.provenance);
    }
    return worst ?? 'generated';
  }

  /**
   * True when a camera's observations support this point.
   *
   * An 'inferred' or 'generated' region is a declaration that nothing was
   * observed there, so it vetoes outright. Otherwise an explicitly observed
   * region, or a room whose own geometry came from observation, is enough.
   */
  isObserved(p: Vec3): boolean {
    if (!isFiniteV3(p)) return false;
    let explicitObserved = false;
    const cand = this.regionGrid.candidates(p[0], p[2]);
    for (let k = 0; k < cand.length; k++) {
      const region = this.doc.regions[cand[k]!];
      if (!region || !aabbContains(region.volume, p)) continue;
      if (region.provenance === 'observed') explicitObserved = true;
      else return false;
    }
    if (explicitObserved) return true;
    const room = this.roomAt(p);
    const supporting = room ? [room] : this.roomsNear(p, WALL_THICKNESS_TOLERANCE_M);
    if (supporting.length === 0) return false;
    return supporting.every((r) => {
      const pr = r.grounding.provenance;
      return pr === 'observed' || pr === 'reconstructed';
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function regionBounds2(v: Aabb): Bounds2 {
  if (!v || !isFiniteV3(v.min) || !isFiniteV3(v.max)) {
    return { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  }
  return { minX: v.min[0], minZ: v.min[2], maxX: v.max[0], maxZ: v.max[2] };
}

function nearestNode(nodes: readonly NavNode[], p: Vec3): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = distance(nodes[i]!.position, p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function clampStep(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return hi;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Is the rotated rectangle entirely inside the ring? Corner containment alone
 * is not enough: in an L-shaped room a rectangle can have all four corners
 * inside while its middle crosses the re-entrant corner, so every ring edge is
 * also tested against the rectangle.
 */
function rectInsideRing(
  ring: Ring2, cx: number, cz: number, hx: number, hz: number, cos: number, sin: number,
): boolean {
  const corners: Array<[number, number]> = [
    [cx + cos * hx - sin * hz, cz + sin * hx + cos * hz],
    [cx + cos * hx + sin * hz, cz + sin * hx - cos * hz],
    [cx - cos * hx + sin * hz, cz - sin * hx - cos * hz],
    [cx - cos * hx - sin * hz, cz - sin * hx + cos * hz],
  ];
  for (const c of corners) {
    if (pointInRing(ring, c[0], c[1], 1e-4) === 'out') return false;
  }
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if (segmentHitsRect(a[0], a[1], b[0], b[1], cx, cz, hx, hz, cos, sin)) return false;
  }
  return true;
}

/** Liang-Barsky clip of a segment against the rectangle, in rectangle space. */
function segmentHitsRect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, hx: number, hz: number, cos: number, sin: number,
): boolean {
  const toLocal = (x: number, z: number): [number, number] => {
    const dx = x - cx;
    const dz = z - cz;
    return [cos * dx + sin * dz, -sin * dx + cos * dz];
  };
  const p0 = toLocal(ax, az);
  const p1 = toLocal(bx, bz);
  let t0 = 0;
  let t1 = 1;
  const dx = p1[0] - p0[0];
  const dz = p1[1] - p0[1];
  // Shrink by 0.1 mm so an edge lying exactly on the rectangle's boundary --
  // a wardrobe pushed flat against a wall -- is contact, not a crossing.
  const ex = hx - 1e-4;
  const ez = hz - 1e-4;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, p0[0] + ex)) return false;
  if (!clip(dx, ex - p0[0])) return false;
  if (!clip(-dz, p0[1] + ez)) return false;
  if (!clip(dz, ez - p0[1])) return false;
  return t0 <= t1;
}

/** A side of the rectangle lies flush along (and parallel to) a ring edge. */
function rectAgainstWall(
  ring: Ring2, cx: number, cz: number, hx: number, hz: number,
  cos: number, sin: number, clearance: number,
): boolean {
  const tol = 0.03 + clearance;
  const sides: Array<[number, number]> = [
    [cx + cos * hx, cz + sin * hx],
    [cx - cos * hx, cz - sin * hx],
    [cx - sin * hz, cz + cos * hz],
    [cx + sin * hz, cz - cos * hz],
  ];
  for (const s of sides) {
    if (distancePointToRing(ring, s[0], s[1]) <= tol) return true;
  }
  return false;
}

interface Frustum {
  containsPoint(p: Vec3): boolean;
  containsAabb(b: Aabb): boolean;
}

/**
 * The view volume, expressed in camera-local coordinates so the test is six
 * scalar comparisons and no plane algebra.
 *
 * Intrinsics win when present: fovY = 2*atan(height / (2*fy)) and the aspect
 * comes from the sensor, which is what the capture actually saw. `fov` is read
 * as a VERTICAL field of view in radians, matching the contract's angle unit.
 */
function makeFrustum(
  pose: { position: Vec3; orientation: Quat; intrinsics?: Intrinsics; fov?: number },
  maxDistance: number,
): Frustum {
  const q = quatNormalise(pose.orientation ?? [0, 0, 0, 1]);
  const f = rotate(q, [0, 0, -1]);
  const u = rotate(q, [0, 1, 0]);
  const r = rotate(q, [1, 0, 0]);
  const o = pose.position;

  let tanY: number;
  let aspect: number;
  const k = pose.intrinsics;
  if (k && k.fy > 0 && k.height > 0 && k.width > 0) {
    tanY = k.height / (2 * k.fy);
    aspect = (k.width / k.height) * (k.fy / (k.fx > 0 ? k.fx : k.fy));
  } else {
    const fov = Number.isFinite(pose.fov) && (pose.fov as number) > 0
      ? (pose.fov as number)
      : (60 * Math.PI) / 180;
    tanY = Math.tan(Math.min(fov, Math.PI * 0.98) / 2);
    aspect = 16 / 9;
  }
  const tanX = tanY * aspect;
  const near = 0.02;

  const local = (p: Vec3): [number, number, number] => {
    const d = sub(p, o);
    return [dot(d, r), dot(d, u), dot(d, f)];
  };

  const planes = (l: [number, number, number]): [number, number, number, number, number, number] => [
    l[2] - near,
    maxDistance - l[2],
    tanX * l[2] - l[0],
    tanX * l[2] + l[0],
    tanY * l[2] - l[1],
    tanY * l[2] + l[1],
  ];

  return {
    containsPoint(p: Vec3): boolean {
      if (!isFiniteV3(p)) return false;
      return planes(local(p)).every((v) => v >= 0);
    },
    containsAabb(b: Aabb): boolean {
      if (!isFiniteV3(b.min) || !isFiniteV3(b.max)) return false;
      // Conservative: cull only when every corner fails the SAME plane.
      const outside = [true, true, true, true, true, true];
      for (let i = 0; i < 8; i++) {
        const p: Vec3 = [
          (i & 1) ? b.max[0] : b.min[0],
          (i & 2) ? b.max[1] : b.min[1],
          (i & 4) ? b.max[2] : b.min[2],
        ];
        const pl = planes(local(p));
        for (let k2 = 0; k2 < 6; k2++) if (pl[k2]! >= 0) outside[k2] = false;
      }
      return !outside.some((v) => v);
    },
  };
}
