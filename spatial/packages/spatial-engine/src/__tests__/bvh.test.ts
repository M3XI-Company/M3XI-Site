import { describe, expect, it } from 'vitest';
import { Bvh } from '../accel/bvh.js';
import { XZGrid } from '../accel/xzGrid.js';

/** A unit quad on the plane x = at, spanning y and z in [-1, 1]. */
function wall(at: number): { positions: number[]; indices: number[] } {
  return {
    positions: [at, -1, -1, at, 1, -1, at, 1, 1, at, -1, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

function build(parts: Array<{ positions: number[]; indices: number[] }>): Bvh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const p of parts) {
    const base = pos.length / 3;
    pos.push(...p.positions);
    for (const i of p.indices) idx.push(base + i);
  }
  return new Bvh(Float32Array.from(pos), Uint32Array.from(idx));
}

describe('bvh raycast', () => {
  it('hits an analytically known triangle', () => {
    const bvh = build([wall(1)]);
    const hit = bvh.raycast(0, 0, 0, 1, 0, 0);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1, 12);
  });

  it('returns the nearest of several walls', () => {
    const bvh = build([wall(1), wall(3), wall(7), wall(-2)]);
    expect(bvh.raycast(0, 0, 0, 1, 0, 0)!.t).toBeCloseTo(1, 12);
    expect(bvh.raycast(2, 0, 0, 1, 0, 0)!.t).toBeCloseTo(1, 12);
    expect(bvh.raycast(0, 0, 0, -1, 0, 0)!.t).toBeCloseTo(2, 12);
    expect(bvh.raycast(4, 0, 0, 1, 0, 0)!.t).toBeCloseTo(3, 12);
  });

  it('misses when the ray passes outside the geometry', () => {
    const bvh = build([wall(1)]);
    expect(bvh.raycast(0, 5, 0, 1, 0, 0)).toBeNull();
    expect(bvh.raycast(0, 0, 0, -1, 0, 0)).toBeNull();
    expect(bvh.raycast(0, 0, 0, 0, 1, 0)).toBeNull();
  });

  it('respects maxDistance', () => {
    const bvh = build([wall(5)]);
    expect(bvh.raycast(0, 0, 0, 1, 0, 0, 4.99)).toBeNull();
    expect(bvh.raycast(0, 0, 0, 1, 0, 0, 5.01)).not.toBeNull();
  });

  it('honours the skip predicate', () => {
    const bvh = build([wall(1), wall(3)]);
    const first = bvh.raycast(0, 0, 0, 1, 0, 0)!;
    const second = bvh.raycast(0, 0, 0, 1, 0, 0, Infinity, (t) => t === first.tri || t === first.tri + 1);
    expect(second!.t).toBeCloseTo(3, 12);
  });

  it('is robust to a zero direction and to non-finite input', () => {
    const bvh = build([wall(1)]);
    expect(bvh.raycast(0, 0, 0, 0, 0, 0)).toBeNull();
    expect(bvh.raycast(NaN, 0, 0, 1, 0, 0)).toBeNull();
  });

  it('drops degenerate and non-finite triangles at build time', () => {
    const zeroArea = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] };
    const nanTri = { positions: [0, 0, 0, NaN, 1, 0, 0, 1, 1], indices: [0, 1, 2] };
    const bvh = build([wall(1), zeroArea, nanTri]);
    expect(bvh.triangleCount).toBe(2);
    expect(bvh.skippedTriangles).toBe(2);
    expect(bvh.raycast(0, 0, 0, 1, 0, 0)!.t).toBeCloseTo(1, 12);
  });

  it('handles an empty soup', () => {
    const bvh = new Bvh(new Float32Array(0), new Uint32Array(0));
    expect(bvh.triangleCount).toBe(0);
    expect(bvh.raycast(0, 0, 0, 1, 0, 0)).toBeNull();
    expect(bvh.closestPoint(0, 0, 0)).toBeNull();
  });

  it('agrees with brute force over a scattered soup', () => {
    // Deterministic pseudo-random scatter: the point is that the acceleration
    // structure never changes the answer, so the seed only has to be fixed.
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < 400; i++) {
      const cx = rand() * 10 - 5, cy = rand() * 10 - 5, cz = rand() * 10 - 5;
      const base = pos.length / 3;
      pos.push(cx, cy, cz, cx + 0.6, cy + 0.1, cz - 0.2, cx - 0.1, cy + 0.7, cz + 0.4);
      idx.push(base, base + 1, base + 2);
    }
    const positions = Float32Array.from(pos);
    const indices = Uint32Array.from(idx);
    const bvh = new Bvh(positions, indices);

    const brute = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number => {
      let best = Infinity;
      for (let t = 0; t < indices.length / 3; t++) {
        const i0 = indices[t * 3]! * 3, i1 = indices[t * 3 + 1]! * 3, i2 = indices[t * 3 + 2]! * 3;
        const ax = positions[i0]!, ay = positions[i0 + 1]!, az = positions[i0 + 2]!;
        const e1x = positions[i1]! - ax, e1y = positions[i1 + 1]! - ay, e1z = positions[i1 + 2]! - az;
        const e2x = positions[i2]! - ax, e2y = positions[i2 + 1]! - ay, e2z = positions[i2 + 2]! - az;
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > 1e-9 && tt < best) best = tt;
      }
      return best;
    };

    for (let k = 0; k < 120; k++) {
      const o = [rand() * 12 - 6, rand() * 12 - 6, rand() * 12 - 6] as const;
      let d = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1] as const;
      const l = Math.hypot(d[0], d[1], d[2]);
      if (l < 1e-6) continue;
      d = [d[0] / l, d[1] / l, d[2] / l] as const;
      const hit = bvh.raycast(o[0], o[1], o[2], d[0], d[1], d[2]);
      const ref = brute(o[0], o[1], o[2], d[0], d[1], d[2]);
      if (ref === Infinity) expect(hit).toBeNull();
      else expect(hit!.t).toBeCloseTo(ref, 5);
    }
  });
});

describe('bvh closestPoint', () => {
  it('finds the distance to a known plane', () => {
    const bvh = build([wall(2)]);
    const near = bvh.closestPoint(0, 0, 0);
    expect(near).not.toBeNull();
    expect(near!.distance).toBeCloseTo(2, 9);
    expect(near!.px).toBeCloseTo(2, 9);
  });

  it('returns null beyond maxDistance', () => {
    const bvh = build([wall(2)]);
    expect(bvh.closestPoint(0, 0, 0, 1.5)).toBeNull();
  });

  it('picks the nearer of two walls', () => {
    const bvh = build([wall(2), wall(-1)]);
    expect(bvh.closestPoint(0, 0, 0)!.distance).toBeCloseTo(1, 9);
  });
});

describe('bvh queryAabb', () => {
  it('returns only the triangles whose bounds overlap the box', () => {
    const bvh = build([wall(1), wall(5), wall(9)]);
    const seen: number[] = [];
    bvh.queryAabb(0, -2, -2, 2, 2, 2, (t) => seen.push(t));
    expect(seen.sort()).toEqual([0, 1]);
  });
});

describe('XZGrid', () => {
  it('buckets by bounds and returns candidates for a point', () => {
    const grid = new XZGrid([
      { minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
      { minX: 10, minZ: 10, maxX: 11, maxZ: 11 },
    ]);
    expect([...grid.candidates(0.5, 0.5)]).toContain(0);
    expect([...grid.candidates(0.5, 0.5)]).not.toContain(1);
    expect([...grid.candidates(10.5, 10.5)]).toContain(1);
    expect([...grid.candidates(100, 100)]).toHaveLength(0);
    expect([...grid.candidates(NaN, 0)]).toHaveLength(0);
  });

  it('survives an empty or degenerate input', () => {
    expect(new XZGrid([]).empty).toBe(true);
    expect([...new XZGrid([]).candidates(0, 0)]).toHaveLength(0);
    const bad = new XZGrid([{ minX: NaN, minZ: 0, maxX: 1, maxZ: 1 }]);
    expect([...bad.candidates(0.5, 0.5)]).toHaveLength(0);
  });
});
