import type { Ring, Vec2 } from '@m3xi/world-core';

/**
 * Polygon maths on the contract's XZ rings. A Vec2 here is [x, z]; the ring's
 * height lives in the room's floorZ/ceilingZ, which are world *Y* values
 * despite the field names.
 *
 * Sign convention: `ringSignedArea` is the ordinary shoelace sum taken over
 * (x, z) as if they were (u, v) of a right-handed 2D frame. Because X x Z = -Y,
 * a ring that is counter-clockwise *viewed from above* (normal +Y, which is
 * what the contract asks for) comes out NEGATIVE here. Nothing outside this
 * module depends on that: area is always taken absolute, and inward normals are
 * found by probing rather than by trusting the winding, because real
 * reconstructions hand us rings wound either way.
 */

export type Ring2 = Vec2[];

const DUP_EPS = 1e-9;

/**
 * Malformed-ring policy, applied once here so every consumer sees the same
 * thing:
 *   - vertices containing NaN or Infinity are dropped outright (a reconstructed
 *     ring with one bad vertex is still mostly a room; throwing loses the room);
 *   - consecutive duplicates and an explicit closing vertex are collapsed;
 *   - a ring left with fewer than 3 vertices is returned empty, and every
 *     predicate below then reports "no area, contains nothing" rather than
 *     throwing.
 * Self-intersection is NOT repaired: see `pointInRing`.
 */
export function sanitiseRing(ring: Ring | undefined | null): Ring2 {
  if (!ring || ring.length === 0) return [];
  const out: Ring2 = [];
  for (const v of ring) {
    if (!v || v.length < 2) continue;
    const x = v[0];
    const z = v[1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) < DUP_EPS && Math.abs(last[1] - z) < DUP_EPS) continue;
    out.push([x, z]);
  }
  while (out.length >= 2) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.abs(a[0] - b[0]) < DUP_EPS && Math.abs(a[1] - b[1]) < DUP_EPS) out.pop();
    else break;
  }
  return out.length >= 3 ? out : [];
}

export function ringSignedArea(ring: Ring2): number {
  const n = ring.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * Unsigned area. For a self-intersecting ring the shoelace sum cancels the
 * oppositely-wound lobes, so a figure-of-eight reports the *net* area. That is
 * the honest answer for a ring we were handed rather than a repaired one, and
 * it is consistent with `pointInRing`'s even-odd rule: both treat a
 * doubly-wound region as outside.
 */
export function ringArea(ring: Ring2): number {
  return Math.abs(ringSignedArea(ring));
}

export function ringPerimeter(ring: Ring2): number {
  const n = ring.length;
  if (n < 2) return 0;
  let p = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

export function ringBounds(ring: Ring2): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const v of ring) {
    if (v[0] < minX) minX = v[0];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] < minZ) minZ = v[1];
    if (v[1] > maxZ) maxZ = v[1];
  }
  return { minX, minZ, maxX, maxZ };
}

/** Area-weighted centroid, falling back to the vertex mean for a zero-area ring. */
export function ringCentroid(ring: Ring2): Vec2 {
  const n = ring.length;
  if (n === 0) return [0, 0];
  const a2 = ringSignedArea(ring) * 2;
  if (Math.abs(a2) < 1e-12) {
    let sx = 0, sz = 0;
    for (const v of ring) { sx += v[0]; sz += v[1]; }
    return [sx / n, sz / n];
  }
  let cx = 0, cz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = ring[j]!;
    const q = ring[i]!;
    const cr = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * cr;
    cz += (p[1] + q[1]) * cr;
  }
  return [cx / (3 * a2), cz / (3 * a2)];
}

export type Containment = 'in' | 'on' | 'out';

/**
 * Even-odd (crossing parity) containment with explicit on-edge reporting.
 *
 * Even-odd rather than non-zero winding: a self-intersecting reconstruction
 * ring has no meaningful winding number, and even-odd at least agrees with the
 * shoelace area, so "is this point in the room" and "how big is the room" never
 * contradict each other.
 *
 * `edgeEps` defaults to 1 mm: below the tolerance of any reconstruction this
 * engine will ever see, so a point reported 'on' really is on the boundary.
 */
export function pointInRing(ring: Ring2, x: number, z: number, edgeEps = 1e-3): Containment {
  const n = ring.length;
  if (n < 3 || !Number.isFinite(x) || !Number.isFinite(z)) return 'out';

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if (distancePointToSegment2(x, z, a[0], a[1], b[0], b[1]) <= edgeEps) return 'on';
  }

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    // Half-open rule on z: an edge counts when it straddles the ray, with the
    // upper endpoint excluded, so a ray through a vertex is counted once.
    if ((a[1] > z) !== (b[1] > z)) {
      const t = (z - a[1]) / (b[1] - a[1]);
      if (x < a[0] + t * (b[0] - a[0])) inside = !inside;
    }
  }
  return inside ? 'in' : 'out';
}

export function ringContains(ring: Ring2, x: number, z: number, edgeEps = 1e-3): boolean {
  const c = pointInRing(ring, x, z, edgeEps);
  return c === 'in' || c === 'on';
}

export function distancePointToSegment2(
  px: number, pz: number, ax: number, az: number, bx: number, bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 <= 1e-20) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Distance from a point to the ring's boundary. Never signed; use with `pointInRing`. */
export function distancePointToRing(ring: Ring2, x: number, z: number): number {
  const n = ring.length;
  if (n < 2) return Infinity;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    const d = distancePointToSegment2(x, z, a[0], a[1], b[0], b[1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Inward normal of edge j -> i, found by probing rather than by winding, so it
 * is right even when the ring is wound the "wrong" way or is self-intersecting.
 * Returns a unit [x, z], or null when the edge is degenerate.
 */
export function edgeInwardNormal(ring: Ring2, edgeIndex: number): Vec2 | null {
  const n = ring.length;
  if (n < 3) return null;
  const a = ring[((edgeIndex % n) + n) % n]!;
  const b = ring[(((edgeIndex + 1) % n) + n) % n]!;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return null;
  const nx = -dz / len;
  const nz = dx / len;
  const mx = (a[0] + b[0]) / 2;
  const mz = (a[1] + b[1]) / 2;
  // 5 mm probe: smaller than any real wall offset, larger than ring noise.
  const probe = 0.005;
  if (pointInRing(ring, mx + nx * probe, mz + nz * probe, 0) === 'in') return [nx, nz];
  if (pointInRing(ring, mx - nx * probe, mz - nz * probe, 0) === 'in') return [-nx, -nz];
  return null;
}

function segmentsProperlyIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Diagnostic only; nothing in the engine refuses to work on a ring that self-intersects. */
export function ringSelfIntersects(ring: Ring2): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      const c = ring[j]!;
      const d = ring[(j + 1) % n]!;
      if (segmentsProperlyIntersect(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return true;
    }
  }
  return false;
}

/**
 * Ear clipping, returning index triples into `ring`.
 *
 * A self-intersecting ring has no valid ear decomposition. Rather than throw or
 * loop, the fallback clips the most convex remaining vertex when no true ear is
 * found in a full pass. The triangulation of such a ring is then not a faithful
 * cover, but it terminates, produces no degenerate triangles, and is only ever
 * used to feed collision/occlusion geometry -- areas are computed by shoelace,
 * never by summing triangles.
 */
export function earClip(ring: Ring2): number[] {
  const n = ring.length;
  if (n < 3) return [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  // Work in a known orientation so the convexity test has a fixed sign.
  if (ringSignedArea(ring) < 0) idx.reverse();

  const tris: number[] = [];
  let guard = 0;
  const maxGuard = n * n + 16;

  const cross2 = (i0: number, i1: number, i2: number): number => {
    const a = ring[i0]!, b = ring[i1]!, c = ring[i2]!;
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  };

  const pointInTri = (px: number, pz: number, i0: number, i1: number, i2: number): boolean => {
    const a = ring[i0]!, b = ring[i1]!, c = ring[i2]!;
    const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (pz - b[1]);
    const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (pz - c[1]);
    const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (pz - a[1]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  while (idx.length > 3 && guard++ < maxGuard) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length]!;
      const i1 = idx[k]!;
      const i2 = idx[(k + 1) % idx.length]!;
      const c = cross2(i0, i1, i2);
      if (c <= 1e-12) continue; // reflex or collinear
      let contains = false;
      for (let m = 0; m < idx.length; m++) {
        const im = idx[m]!;
        if (im === i0 || im === i1 || im === i2) continue;
        const p = ring[im]!;
        if (pointInTri(p[0], p[1], i0, i1, i2)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push(i0, i1, i2);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // No ear exists: the ring is self-intersecting or fully degenerate. Clip
      // the vertex with the largest turn so the loop always shrinks.
      let bestK = 0;
      let bestC = -Infinity;
      for (let k = 0; k < idx.length; k++) {
        const c = cross2(
          idx[(k + idx.length - 1) % idx.length]!, idx[k]!, idx[(k + 1) % idx.length]!,
        );
        if (c > bestC) { bestC = c; bestK = k; }
      }
      const i0 = idx[(bestK + idx.length - 1) % idx.length]!;
      const i1 = idx[bestK]!;
      const i2 = idx[(bestK + 1) % idx.length]!;
      if (Math.abs(cross2(i0, i1, i2)) > 1e-12) tris.push(i0, i1, i2);
      idx.splice(bestK, 1);
    }
  }
  if (idx.length === 3) {
    const i0 = idx[0]!, i1 = idx[1]!, i2 = idx[2]!;
    if (Math.abs(cross2(i0, i1, i2)) > 1e-12) tris.push(i0, i1, i2);
  }
  return tris;
}
