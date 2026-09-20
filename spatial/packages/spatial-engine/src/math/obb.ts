import type { Aabb, Obb, Quat, Vec3 } from '@m3xi/world-core';
import { QUAT_IDENTITY, quatAxes, quatNormalise, rotate, rotateInverse } from './quat.js';
import { add, dot, sub } from './vec3.js';

/**
 * Oriented bounding boxes. Separating-axis tests throughout; no convex hull
 * machinery, because every volume this engine handles is a box or a triangle.
 */

export function obbFromAabb(b: Aabb): Obb {
  return {
    centre: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
    half: [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2],
    quat: QUAT_IDENTITY,
  };
}

export function makeObb(centre: Vec3, half: Vec3, quat: Quat = QUAT_IDENTITY): Obb {
  return { centre, half, quat };
}

export function obbCorners(o: Obb): Vec3[] {
  const [ax, ay, az] = quatAxes(o.quat);
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const sx = (i & 1) ? o.half[0] : -o.half[0];
    const sy = (i & 2) ? o.half[1] : -o.half[1];
    const sz = (i & 4) ? o.half[2] : -o.half[2];
    out.push([
      o.centre[0] + ax[0] * sx + ay[0] * sy + az[0] * sz,
      o.centre[1] + ax[1] * sx + ay[1] * sy + az[1] * sz,
      o.centre[2] + ax[2] * sx + ay[2] * sy + az[2] * sz,
    ]);
  }
  return out;
}

/** World point -> box-local coordinates (axis aligned, centred on origin). */
export function obbToLocal(o: Obb, p: Vec3): Vec3 {
  return rotateInverse(o.quat, sub(p, o.centre));
}

export function obbFromLocal(o: Obb, p: Vec3): Vec3 {
  return add(o.centre, rotate(quatNormalise(o.quat), p));
}

export function obbContains(o: Obb, p: Vec3, eps = 0): boolean {
  const l = obbToLocal(o, p);
  return (
    Math.abs(l[0]) <= o.half[0] + eps &&
    Math.abs(l[1]) <= o.half[1] + eps &&
    Math.abs(l[2]) <= o.half[2] + eps
  );
}

export function obbClosestPoint(o: Obb, p: Vec3): Vec3 {
  const l = obbToLocal(o, p);
  const c: Vec3 = [
    Math.min(Math.max(l[0], -o.half[0]), o.half[0]),
    Math.min(Math.max(l[1], -o.half[1]), o.half[1]),
    Math.min(Math.max(l[2], -o.half[2]), o.half[2]),
  ];
  return obbFromLocal(o, c);
}

export function obbDistance(o: Obb, p: Vec3): number {
  const c = obbClosestPoint(o, p);
  const dx = c[0] - p[0], dy = c[1] - p[1], dz = c[2] - p[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Gottschalk's 15-axis OBB/OBB separating-axis test: 3 face normals each, plus
 * the 9 edge cross products. The epsilon on the cross-product axes is the
 * standard guard against near-parallel edges producing a near-zero axis and a
 * false "separated" verdict.
 */
export function obbIntersectsObb(a: Obb, b: Obb, margin = 0): boolean {
  const A = quatAxes(a.quat);
  const B = quatAxes(b.quat);
  const t = sub(b.centre, a.centre);
  const tA: [number, number, number] = [dot(t, A[0]), dot(t, A[1]), dot(t, A[2])];

  const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const AbsR: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const v = dot(A[i as 0 | 1 | 2], B[j as 0 | 1 | 2]);
      R[i]![j] = v;
      AbsR[i]![j] = Math.abs(v) + 1e-9;
    }
  }

  const ah: [number, number, number] = [a.half[0] + margin, a.half[1] + margin, a.half[2] + margin];
  const bh: [number, number, number] = [b.half[0], b.half[1], b.half[2]];

  // A's face normals
  for (let i = 0; i < 3; i++) {
    const ra = ah[i as 0 | 1 | 2];
    const rb = bh[0] * AbsR[i]![0]! + bh[1] * AbsR[i]![1]! + bh[2] * AbsR[i]![2]!;
    if (Math.abs(tA[i as 0 | 1 | 2]) > ra + rb) return false;
  }
  // B's face normals
  for (let j = 0; j < 3; j++) {
    const ra = ah[0] * AbsR[0]![j]! + ah[1] * AbsR[1]![j]! + ah[2] * AbsR[2]![j]!;
    const rb = bh[j as 0 | 1 | 2];
    const tv = tA[0] * R[0]![j]! + tA[1] * R[1]![j]! + tA[2] * R[2]![j]!;
    if (Math.abs(tv) > ra + rb) return false;
  }
  // Edge-edge axes A_i x B_j
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const i1 = (i + 1) % 3, i2 = (i + 2) % 3;
      const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      const ra = ah[i1 as 0 | 1 | 2] * AbsR[i2]![j]! + ah[i2 as 0 | 1 | 2] * AbsR[i1]![j]!;
      const rb = bh[j1 as 0 | 1 | 2] * AbsR[i]![j2]! + bh[j2 as 0 | 1 | 2] * AbsR[i]![j1]!;
      const tv = tA[i2 as 0 | 1 | 2] * R[i1]![j]! - tA[i1 as 0 | 1 | 2] * R[i2]![j]!;
      if (Math.abs(tv) > ra + rb) return false;
    }
  }
  return true;
}

/**
 * Akenine-Moller triangle/box overlap, run in the box's local frame so the box
 * is axis aligned. 13 axes: the box's 3 normals, the triangle normal, and the
 * 9 edge cross products.
 */
export function obbIntersectsTriangle(o: Obb, p0: Vec3, p1: Vec3, p2: Vec3): boolean {
  const v0 = obbToLocal(o, p0);
  const v1 = obbToLocal(o, p1);
  const v2 = obbToLocal(o, p2);
  const h = o.half;

  // Box face normals
  for (let ii = 0; ii < 3; ii++) {
    const i = ii as 0 | 1 | 2;
    const mn = Math.min(v0[i], v1[i], v2[i]);
    const mx = Math.max(v0[i], v1[i], v2[i]);
    if (mn > h[i] || mx < -h[i]) return false;
  }

  const e0 = sub(v1, v0);
  const e1 = sub(v2, v1);
  const e2 = sub(v0, v2);

  // Triangle plane against the box
  const n: Vec3 = [
    e0[1] * e1[2] - e0[2] * e1[1],
    e0[2] * e1[0] - e0[0] * e1[2],
    e0[0] * e1[1] - e0[1] * e1[0],
  ];
  const d = dot(n, v0);
  const r = h[0] * Math.abs(n[0]) + h[1] * Math.abs(n[1]) + h[2] * Math.abs(n[2]);
  if (Math.abs(d) > r) return false;

  const edges = [e0, e1, e2];
  const verts = [v0, v1, v2];
  for (const e of edges) {
    // Axis = box axis i cross edge, for i in {x, y, z}
    const axes: Vec3[] = [
      [0, -e[2], e[1]],
      [e[2], 0, -e[0]],
      [-e[1], e[0], 0],
    ];
    const rads = [
      h[1] * Math.abs(e[2]) + h[2] * Math.abs(e[1]),
      h[0] * Math.abs(e[2]) + h[2] * Math.abs(e[0]),
      h[0] * Math.abs(e[1]) + h[1] * Math.abs(e[0]),
    ];
    for (let k = 0; k < 3; k++) {
      const ax = axes[k]!;
      if (Math.abs(ax[0]) + Math.abs(ax[1]) + Math.abs(ax[2]) < 1e-12) continue;
      let mn = Infinity, mx = -Infinity;
      for (const v of verts) {
        const pv = dot(ax, v);
        if (pv < mn) mn = pv;
        if (pv > mx) mx = pv;
      }
      const rad = rads[k]!;
      if (mn > rad || mx < -rad) return false;
    }
  }
  return true;
}

/** Shortest distance between two boxes. Zero when they overlap. */
export function obbGap(a: Obb, b: Obb): number {
  if (obbIntersectsObb(a, b)) return 0;
  // Two rounds of alternating closest-point projection converge to well under a
  // millimetre for box pairs at furniture scale, and unlike a full GJK it cannot
  // fail to terminate on degenerate (zero-extent) boxes.
  let pa = a.centre;
  let pb = b.centre;
  for (let i = 0; i < 8; i++) {
    pa = obbClosestPoint(a, pb);
    pb = obbClosestPoint(b, pa);
  }
  const d = sub(pb, pa);
  return Math.sqrt(dot(d, d));
}

/** Footprint overlap of two boxes on the XZ plane, as a fraction of `b`'s area. */
export function footprintOverlapFraction(a: Aabb, b: Aabb): number {
  const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  if (ox <= 0 || oz <= 0) return 0;
  const bArea = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
  if (!(bArea > 0)) return 0;
  return Math.min(1, (ox * oz) / bArea);
}
