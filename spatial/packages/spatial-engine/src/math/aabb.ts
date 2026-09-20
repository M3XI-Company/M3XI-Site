import type { Aabb, Obb, Vec3 } from '@m3xi/world-core';
import { obbCorners } from './obb.js';

/** An AABB with min > max on any axis is empty; every predicate treats it as such. */
export function aabbIsEmpty(b: Aabb): boolean {
  return !(
    b.min[0] <= b.max[0] &&
    b.min[1] <= b.max[1] &&
    b.min[2] <= b.max[2] &&
    Number.isFinite(b.min[0] + b.min[1] + b.min[2] + b.max[0] + b.max[1] + b.max[2])
  );
}

export function aabbFromPoints(points: readonly Vec3[]): Aabb {
  let nx = Infinity, ny = Infinity, nz = Infinity;
  let xx = -Infinity, xy = -Infinity, xz = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue;
    if (p[0] < nx) nx = p[0];
    if (p[1] < ny) ny = p[1];
    if (p[2] < nz) nz = p[2];
    if (p[0] > xx) xx = p[0];
    if (p[1] > xy) xy = p[1];
    if (p[2] > xz) xz = p[2];
  }
  return { min: [nx, ny, nz], max: [xx, xy, xz] };
}

export function aabbCentre(b: Aabb): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function aabbHalf(b: Aabb): Vec3 {
  return [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
}

export function aabbSize(b: Aabb): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function aabbVolume(b: Aabb): number {
  if (aabbIsEmpty(b)) return 0;
  const s = aabbSize(b);
  return s[0] * s[1] * s[2];
}

export function aabbContains(b: Aabb, p: Vec3, eps = 0): boolean {
  if (aabbIsEmpty(b)) return false;
  return (
    p[0] >= b.min[0] - eps && p[0] <= b.max[0] + eps &&
    p[1] >= b.min[1] - eps && p[1] <= b.max[1] + eps &&
    p[2] >= b.min[2] - eps && p[2] <= b.max[2] + eps
  );
}

export function aabbOverlaps(a: Aabb, b: Aabb, eps = 0): boolean {
  if (aabbIsEmpty(a) || aabbIsEmpty(b)) return false;
  return (
    a.min[0] - eps <= b.max[0] && a.max[0] + eps >= b.min[0] &&
    a.min[1] - eps <= b.max[1] && a.max[1] + eps >= b.min[1] &&
    a.min[2] - eps <= b.max[2] && a.max[2] + eps >= b.min[2]
  );
}

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  if (aabbIsEmpty(a)) return b;
  if (aabbIsEmpty(b)) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function aabbExpand(b: Aabb, by: number): Aabb {
  return {
    min: [b.min[0] - by, b.min[1] - by, b.min[2] - by],
    max: [b.max[0] + by, b.max[1] + by, b.max[2] + by],
  };
}

export function aabbClosestPoint(b: Aabb, p: Vec3): Vec3 {
  return [
    Math.min(Math.max(p[0], b.min[0]), b.max[0]),
    Math.min(Math.max(p[1], b.min[1]), b.max[1]),
    Math.min(Math.max(p[2], b.min[2]), b.max[2]),
  ];
}

/** Zero when p is inside. */
export function aabbDistance(b: Aabb, p: Vec3): number {
  if (aabbIsEmpty(b)) return Infinity;
  const c = aabbClosestPoint(b, p);
  const dx = c[0] - p[0], dy = c[1] - p[1], dz = c[2] - p[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Shortest distance between the two boxes; zero when they overlap. */
export function aabbGap(a: Aabb, b: Aabb): number {
  if (aabbIsEmpty(a) || aabbIsEmpty(b)) return Infinity;
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const lo = a.min[i as 0 | 1 | 2];
    const hi = a.max[i as 0 | 1 | 2];
    const blo = b.min[i as 0 | 1 | 2];
    const bhi = b.max[i as 0 | 1 | 2];
    const d = blo > hi ? blo - hi : lo > bhi ? lo - bhi : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

export function aabbFromObb(o: Obb): Aabb {
  return aabbFromPoints(obbCorners(o));
}
