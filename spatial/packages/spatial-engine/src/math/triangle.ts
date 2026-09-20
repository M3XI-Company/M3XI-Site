import type { Vec3 } from '@m3xi/world-core';
import { cross, dot, sub } from './vec3.js';

export function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const n = cross(sub(b, a), sub(c, a));
  const l = Math.sqrt(dot(n, n));
  if (!Number.isFinite(l) || l <= 0) return [0, 0, 0];
  return [n[0] / l, n[1] / l, n[2] / l];
}

export function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const n = cross(sub(b, a), sub(c, a));
  const l2 = dot(n, n);
  if (!Number.isFinite(l2)) return 0;
  return 0.5 * Math.sqrt(l2);
}

export interface TriHit { readonly t: number; readonly u: number; readonly v: number }

/**
 * Moller-Trumbore, double sided. A wall seen from behind still blocks a ray, so
 * back-face culling would be a bug here, not an optimisation.
 *
 * `eps` rejects near-parallel rays and, with it, triangles whose area is close
 * to zero -- a category reconstruction produces constantly.
 */
export function rayTriangle(
  origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3, eps = 1e-12,
): TriHit | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < eps) return null;
  const inv = 1 / det;
  const tv = sub(origin, a);
  const u = dot(tv, p) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = cross(tv, e1);
  const v = dot(dir, q) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = dot(e2, q) * inv;
  if (!Number.isFinite(t)) return null;
  return { t, u, v };
}

/**
 * Ericson's Voronoi-region closest point. Handles degenerate triangles by
 * falling through to the vertex/edge regions, so a zero-area triangle returns a
 * point on its longest edge rather than NaN.
 */
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const denom = d1 - d3;
    const v = denom !== 0 ? d1 / denom : 0;
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const denom = d2 - d6;
    const w = denom !== 0 ? d2 / denom : 0;
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const denom = (d4 - d3) + (d5 - d6);
    const w = denom !== 0 ? (d4 - d3) / denom : 0;
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }

  const denom = va + vb + vc;
  if (!(Math.abs(denom) > 0)) return a;
  const v = vb / denom;
  const w = vc / denom;
  return [
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ];
}
