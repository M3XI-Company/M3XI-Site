import type { Vec3 } from '@m3xi/world-core';

/**
 * Plain, allocation-honest vector maths on the world contract's Vec3 tuple.
 *
 * Everything here returns a fresh tuple. That costs an allocation per call, so
 * the hot paths (BVH traversal, ray/triangle tests) deliberately work on raw
 * scalars instead of calling into this module. Correctness lives here; speed
 * lives in accel/.
 */

export const V3_ZERO: Vec3 = [0, 0, 0];
export const V3_UP: Vec3 = [0, 1, 0];

export function v3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function mul(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function lengthSq(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(distanceSq(a, b));
}

/**
 * Returns the zero vector for a zero-length or non-finite input rather than
 * producing NaNs. Reconstruction output contains both; a caller that gets a
 * zero direction back can test for it, a caller that gets NaN poisons every
 * downstream comparison silently.
 */
export function normalise(a: Vec3): Vec3 {
  const l2 = lengthSq(a);
  if (!Number.isFinite(l2) || l2 <= 0) return V3_ZERO;
  const inv = 1 / Math.sqrt(l2);
  return [a[0] * inv, a[1] * inv, a[2] * inv];
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function minV(a: Vec3, b: Vec3): Vec3 {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

export function maxV(a: Vec3, b: Vec3): Vec3 {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

export function isFiniteV3(a: unknown): a is Vec3 {
  return (
    Array.isArray(a) &&
    a.length === 3 &&
    Number.isFinite(a[0]) &&
    Number.isFinite(a[1]) &&
    Number.isFinite(a[2])
  );
}

export function approxEq(a: Vec3, b: Vec3, eps = 1e-9): boolean {
  return (
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps
  );
}

/** Closest point to `p` on the segment ab, clamped to the segment. */
export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  if (l2 <= 1e-20) return a;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
}
