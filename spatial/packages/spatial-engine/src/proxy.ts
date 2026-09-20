import type { Opening, Room, Surface, Vec3, WorldDocument } from '@m3xi/world-core';
import type { ProxyMesh } from './types.js';
import { earClip, edgeInwardNormal, ringCentroid, sanitiseRing, type Ring2 } from './math/polygon.js';
import { obbCorners, obbFromAabb } from './math/obb.js';

/**
 * The collision and occlusion geometry the engine actually traces against.
 *
 * Every triangle carries back-references so a ray hit can say *what* it hit,
 * which is the whole point: "blocked by the kitchen island" is an answer,
 * "blocked by triangle 41,203" is not.
 */
export interface Soup {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Per triangle: index into doc.surfaces, or -1. */
  readonly triSurface: Int32Array;
  /** Per triangle: index into doc.entities, or -1. */
  readonly triEntity: Int32Array;
  /** Per triangle: index into doc.rooms, or -1. */
  readonly triRoom: Int32Array;
  /** True when the structural geometry was synthesised from room rings. */
  readonly synthesised: boolean;
}

/** Fallback opening sizes, in metres, when the document does not state them. */
const DEFAULT_OPENING: Record<string, { w: number; h: number; sill: number }> = {
  door: { w: 0.838, h: 1.981, sill: 0 },          // UK standard internal door leaf
  doorway: { w: 0.9, h: 2.04, sill: 0 },
  arch: { w: 1.0, h: 2.04, sill: 0 },
  window: { w: 1.2, h: 1.2, sill: 0.9 },
  rooflight: { w: 0.8, h: 0.8, sill: 0 },
  stair: { w: 0.9, h: 2.04, sill: 0 },
  hatch: { w: 0.6, h: 0.6, sill: 1.8 },
};

/** How far an opening's centre may sit from a wall face and still belong to it. */
const OPENING_WALL_TOLERANCE_M = 0.2;
/** Plane match tolerance when attributing synthesised geometry to a Surface. */
const SURFACE_MATCH_TOLERANCE_M = 0.08;

class SoupBuilder {
  readonly pos: number[] = [];
  readonly idx: number[] = [];
  readonly surf: number[] = [];
  readonly ent: number[] = [];
  readonly room: number[] = [];

  vertex(x: number, y: number, z: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    return i;
  }

  tri(a: number, b: number, c: number, surface: number, entity: number, room: number): void {
    this.idx.push(a, b, c);
    this.surf.push(surface);
    this.ent.push(entity);
    this.room.push(room);
  }

  quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, surface: number, entity: number, room: number): void {
    const a = this.vertex(p0[0], p0[1], p0[2]);
    const b = this.vertex(p1[0], p1[1], p1[2]);
    const c = this.vertex(p2[0], p2[1], p2[2]);
    const d = this.vertex(p3[0], p3[1], p3[2]);
    this.tri(a, b, c, surface, entity, room);
    this.tri(a, c, d, surface, entity, room);
  }

  finish(synthesised: boolean): Soup {
    return {
      positions: Float32Array.from(this.pos),
      indices: Uint32Array.from(this.idx),
      triSurface: Int32Array.from(this.surf),
      triEntity: Int32Array.from(this.ent),
      triRoom: Int32Array.from(this.room),
      synthesised,
    };
  }
}

export function buildSoup(doc: WorldDocument, proxyMesh?: ProxyMesh): Soup {
  const b = new SoupBuilder();
  const surfaceUsed = new Set<number>();
  let base: Soup | null = null;
  let synthesised = false;

  if (proxyMesh && proxyMesh.positions.length >= 9 && proxyMesh.indices.length >= 3) {
    base = adoptProxyMesh(proxyMesh, doc.surfaces.length);
    for (let i = 0; i < doc.surfaces.length; i++) surfaceUsed.add(i);
  } else {
    synthesised = true;
    appendRoomShells(b, doc, surfaceUsed);
    // Anything the room shells did not account for -- columns, soffits,
    // free-standing partitions -- still has to occlude, so triangulate it.
    for (let i = 0; i < doc.surfaces.length; i++) {
      if (surfaceUsed.has(i)) continue;
      appendSurface(b, doc.surfaces[i]!, i);
    }
  }

  appendEntityProxies(b, doc);
  const built = b.finish(synthesised);
  return base === null ? built : concatSoup(base, built, synthesised);
}

/**
 * Wrap a supplied proxy mesh without copying its vertex or index data. A
 * 200k-triangle mesh is several megabytes and the viewer loads one per
 * property; re-packing it through a JavaScript array costs most of a second
 * for no benefit.
 */
function adoptProxyMesh(mesh: ProxyMesh, surfaceCount: number): Soup {
  const triCount = Math.floor(mesh.indices.length / 3);
  const vertCount = Math.floor(mesh.positions.length / 3);
  const triSurface = new Int32Array(triCount).fill(-1);
  const ids = mesh.surfaceIds;
  if (ids) {
    const perTriangle = ids.length === triCount;
    const perVertex = ids.length === vertCount;
    if (perTriangle || perVertex) {
      for (let t = 0; t < triCount; t++) {
        const raw = perTriangle ? ids[t] : ids[mesh.indices[t * 3]!];
        if (raw !== undefined && raw < surfaceCount) triSurface[t] = raw;
      }
    }
  }
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    triSurface,
    triEntity: new Int32Array(triCount).fill(-1),
    triRoom: new Int32Array(triCount).fill(-1),
    synthesised: false,
  };
}

function concatSoup(a: Soup, bSoup: Soup, synthesised: boolean): Soup {
  const positions = new Float32Array(a.positions.length + bSoup.positions.length);
  positions.set(a.positions, 0);
  positions.set(bSoup.positions, a.positions.length);

  const vertexOffset = a.positions.length / 3;
  const indices = new Uint32Array(a.indices.length + bSoup.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < bSoup.indices.length; i++) {
    indices[a.indices.length + i] = bSoup.indices[i]! + vertexOffset;
  }

  const join = (x: Int32Array, y: Int32Array): Int32Array => {
    const out = new Int32Array(x.length + y.length);
    out.set(x, 0);
    out.set(y, x.length);
    return out;
  };

  return {
    positions,
    indices,
    triSurface: join(a.triSurface, bSoup.triSurface),
    triEntity: join(a.triEntity, bSoup.triEntity),
    triRoom: join(a.triRoom, bSoup.triRoom),
    synthesised,
  };
}

/**
 * Structural geometry from room rings: floor, ceiling, and wall panels with
 * openings punched out.
 *
 * Punching matters more than it looks. A `Surface` is a single ring and cannot
 * express a hole, so a wall built straight from the contract's surfaces is
 * solid -- and then every sightline through a doorway is reported blocked and
 * `visibleFrom` claims you cannot see the hall from the kitchen. Building the
 * walls from the room outline and subtracting the openings is the only way to
 * get door and window sightlines right without changing the contract.
 */
function appendRoomShells(b: SoupBuilder, doc: WorldDocument, surfaceUsed: Set<number>): void {
  const surfacesByRoom = new Map<string, Array<{ s: Surface; i: number }>>();
  doc.surfaces.forEach((s, i) => {
    if (!s.roomId) return;
    let list = surfacesByRoom.get(s.roomId);
    if (!list) { list = []; surfacesByRoom.set(s.roomId, list); }
    list.push({ s, i });
  });

  doc.rooms.forEach((room, roomIdx) => {
    const ring = sanitiseRing(room.polygon);
    if (ring.length < 3) return;
    const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
    const ceilYRaw = Number.isFinite(room.ceilingZ) ? room.ceilingZ : floorY + 2.4;
    // A ceiling at or below the floor is a reconstruction failure, not a room
    // 0 m tall; fall back to a typical UK storey height so the shell is usable.
    const ceilY = ceilYRaw > floorY + 0.05 ? ceilYRaw : floorY + 2.4;
    const cand = surfacesByRoom.get(room.id) ?? [];

    const floorSurf = matchSurface(cand, 'floor', [0, 1, 0], [ring[0]![0], floorY, ring[0]![1]]);
    const ceilSurf = matchSurface(cand, 'ceiling', [0, 1, 0], [ring[0]![0], ceilY, ring[0]![1]]);
    if (floorSurf >= 0) surfaceUsed.add(floorSurf);
    if (ceilSurf >= 0) surfaceUsed.add(ceilSurf);

    const tris = earClip(ring);
    for (let k = 0; k + 2 < tris.length; k += 3) {
      const p = ring[tris[k]!]!, q = ring[tris[k + 1]!]!, r = ring[tris[k + 2]!]!;
      const a = b.vertex(p[0], floorY, p[1]);
      const c = b.vertex(q[0], floorY, q[1]);
      const d = b.vertex(r[0], floorY, r[1]);
      b.tri(a, c, d, floorSurf, -1, roomIdx);
      const a2 = b.vertex(p[0], ceilY, p[1]);
      const c2 = b.vertex(q[0], ceilY, q[1]);
      const d2 = b.vertex(r[0], ceilY, r[1]);
      b.tri(a2, c2, d2, ceilSurf, -1, roomIdx);
    }

    for (let e = 0; e < ring.length; e++) {
      appendWall(b, doc, room, roomIdx, ring, e, floorY, ceilY, cand, surfaceUsed);
    }
  });
}

interface Punch { u0: number; u1: number; v0: number; v1: number }

function appendWall(
  b: SoupBuilder,
  doc: WorldDocument,
  room: Room,
  roomIdx: number,
  ring: Ring2,
  edgeIndex: number,
  floorY: number,
  ceilY: number,
  cand: Array<{ s: Surface; i: number }>,
  surfaceUsed: Set<number>,
): void {
  const a = ring[edgeIndex]!;
  const c = ring[(edgeIndex + 1) % ring.length]!;
  const dx = c[0] - a[0];
  const dz = c[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return;
  const ux = dx / len;
  const uz = dz / len;
  const inward = edgeInwardNormal(ring, edgeIndex) ?? [-uz, ux];
  const normal: Vec3 = [inward[0], 0, inward[1]];
  const surfIdx = matchSurface(cand, 'wall', normal, [a[0], (floorY + ceilY) / 2, a[1]]);
  if (surfIdx >= 0) surfaceUsed.add(surfIdx);

  const punches: Punch[] = [];
  for (const op of doc.openings) {
    if (op.roomA !== undefined && op.roomB !== undefined
      && op.roomA !== room.id && op.roomB !== room.id) continue;
    if (op.roomA !== undefined && op.roomB === undefined && op.roomA !== room.id) continue;
    const p = punchFor(op, a, ux, uz, len, floorY, ceilY);
    if (p) punches.push(p);
  }
  punches.sort((p, q) => p.u0 - q.u0);

  const at = (u: number, y: number): Vec3 => [a[0] + ux * u, y, a[1] + uz * u];
  const panel = (u0: number, u1: number, v0: number, v1: number): void => {
    if (!(u1 - u0 > 1e-4) || !(v1 - v0 > 1e-4)) return;
    b.quad(at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1), surfIdx, -1, roomIdx);
  };

  let cursor = 0;
  for (const p of punches) {
    if (p.u0 > cursor) panel(cursor, p.u0, floorY, ceilY);
    const lo = Math.max(cursor, p.u0);
    if (p.v0 > floorY) panel(lo, p.u1, floorY, p.v0);
    if (p.v1 < ceilY) panel(lo, p.u1, p.v1, ceilY);
    cursor = Math.max(cursor, p.u1);
  }
  if (cursor < len) panel(cursor, len, floorY, ceilY);
}

function punchFor(
  op: Opening, a: readonly [number, number],
  ux: number, uz: number, len: number, floorY: number, ceilY: number,
): Punch | null {
  const cx = op.centre?.[0];
  const cy = op.centre?.[1];
  const cz = op.centre?.[2];
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return null;
  const rx = cx! - a[0];
  const rz = cz! - a[1];
  const u = rx * ux + rz * uz;
  const perp = Math.abs(rx * -uz + rz * ux);
  if (perp > OPENING_WALL_TOLERANCE_M) return null;
  if (u < -OPENING_WALL_TOLERANCE_M || u > len + OPENING_WALL_TOLERANCE_M) return null;

  const def = DEFAULT_OPENING[op.kind] ?? { w: 0.9, h: 2.0, sill: 0 };
  const w = op.width?.value && op.width.value > 0 ? op.width.value : def.w;
  const h = op.height?.value && op.height.value > 0 ? op.height.value : def.h;
  const sill = op.sill?.value !== undefined && Number.isFinite(op.sill.value)
    ? op.sill.value
    : def.sill;

  // Openings whose centre carries a real height use it; otherwise sit the
  // opening on the floor plus its sill.
  const v0 = Number.isFinite(cy) && Math.abs(cy! - (floorY + sill + h / 2)) < 1.0
    ? cy! - h / 2
    : floorY + sill;
  const v1 = v0 + h;

  return {
    u0: Math.max(0, u - w / 2),
    u1: Math.min(len, u + w / 2),
    v0: Math.max(floorY, v0),
    v1: Math.min(ceilY, v1),
  };
}

function matchSurface(
  cand: Array<{ s: Surface; i: number }>,
  kind: Surface['kind'],
  normal: Vec3,
  point: Vec3,
): number {
  for (const { s, i } of cand) {
    if (s.kind !== kind) continue;
    const n = s.plane?.n;
    const d = s.plane?.d;
    if (!n || !Number.isFinite(d)) continue;
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (!(nl > 1e-6)) continue;
    const dotn = Math.abs((n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2]) / nl);
    if (dotn < 0.98) continue;
    const dist = Math.abs((n[0] * point[0] + n[1] * point[1] + n[2] * point[2]) / nl + d! / nl);
    if (dist > SURFACE_MATCH_TOLERANCE_M) continue;
    return i;
  }
  return -1;
}

function appendSurface(b: SoupBuilder, s: Surface, index: number): void {
  const poly = (s.polygon ?? []).filter(
    (p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]),
  );
  if (poly.length < 3) return;
  const n = s.plane?.n ?? [0, 1, 0];
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  // Drop the dominant axis so the projected polygon keeps its shape.
  const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const flat: Ring2 = poly.map((p) => (
    drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[0], p[2]] : [p[0], p[1]]
  ));
  const tris = earClip(flat);
  const base: number[] = poly.map((p) => b.vertex(p[0], p[1], p[2]));
  for (let k = 0; k + 2 < tris.length; k += 3) {
    b.tri(base[tris[k]!]!, base[tris[k + 1]!]!, base[tris[k + 2]!]!, index, -1, -1);
  }
}

function appendEntityProxies(b: SoupBuilder, doc: WorldDocument): void {
  doc.entities.forEach((e, entityIdx) => {
    const obb = e.obb ?? (e.aabb ? obbFromAabb(e.aabb) : undefined);
    if (!obb) return;
    const half = obb.half;
    if (!Number.isFinite(half[0] + half[1] + half[2])) return;
    // Clamp paper-thin proxies (rugs, wall-mounted panels) so they survive the
    // BVH's zero-area filter and still occlude and collide.
    const safe = {
      centre: obb.centre,
      half: [
        Math.max(Math.abs(half[0]), 0.002),
        Math.max(Math.abs(half[1]), 0.002),
        Math.max(Math.abs(half[2]), 0.002),
      ] as Vec3,
      quat: obb.quat,
    };
    if (!Number.isFinite(safe.centre[0] + safe.centre[1] + safe.centre[2])) return;
    const c = obbCorners(safe);
    const base = c.map((p) => b.vertex(p[0], p[1], p[2]));
    // Corner bit layout from obbCorners: bit0 = +x, bit1 = +y, bit2 = +z.
    const faces: Array<[number, number, number, number]> = [
      [0, 2, 3, 1], [4, 5, 7, 6],
      [0, 1, 5, 4], [2, 6, 7, 3],
      [0, 4, 6, 2], [1, 3, 7, 5],
    ];
    for (const f of faces) {
      b.tri(base[f[0]]!, base[f[1]]!, base[f[2]]!, -1, entityIdx, -1);
      b.tri(base[f[0]]!, base[f[2]]!, base[f[3]]!, -1, entityIdx, -1);
    }
  });
}

/** Centroid of a room ring at mid-height; the canonical "point in the room". */
export function roomAnchor(room: Room): Vec3 {
  const ring = sanitiseRing(room.polygon);
  const c = ring.length >= 3 ? ringCentroid(ring) : [0, 0] as const;
  const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
  const ceilY = Number.isFinite(room.ceilingZ) && room.ceilingZ > floorY ? room.ceilingZ : floorY + 2.4;
  return [c[0], (floorY + ceilY) / 2, c[1]];
}
