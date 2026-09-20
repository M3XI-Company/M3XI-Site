import { describe, expect, it } from 'vitest';
import { World } from '../world.js';
import { Bvh } from '../accel/bvh.js';
import { buildSoup } from '../proxy.js';
import { emptyDoc, rectRoom } from '../__fixtures__/minimal.js';
import type { Entity, Room, Vec3, WorldDocument } from '@m3xi/world-core';
import type { ProxyMesh } from '../types.js';

/**
 * The viewer casts rays and resolves the camera's room every frame, so these
 * two have a hard budget. The target in the brief is "well under 1 ms per
 * raycast on a full flat"; the assertions below are set at 10x the measured
 * headroom so they catch a regression without failing on a loaded machine.
 *
 * The workload is a 12-room flat with 300 entities and a proxy mesh of roughly
 * 200k triangles -- a tessellated shell rather than random triangles, because a
 * random soup gives a BVH an easy, unrealistically uniform job.
 */

const ROOM_COLS = 4;
const ROOM_ROWS = 3;
const ROOM_W = 4.0;
const ROOM_D = 3.5;
const CEILING = 2.5;
const ENTITY_COUNT = 300;
const TRIANGLE_TARGET = 200_000;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Workload { doc: WorldDocument; proxy: ProxyMesh; triangleCount: number }

function buildWorkload(): Workload {
  const rooms: Room[] = [];
  for (let r = 0; r < ROOM_ROWS; r++) {
    for (let c = 0; c < ROOM_COLS; c++) {
      const x0 = c * (ROOM_W + 0.1);
      const z0 = r * (ROOM_D + 0.1);
      rooms.push(rectRoom(`r_${r}_${c}`, x0, z0, x0 + ROOM_W, z0 + ROOM_D, { ceilingZ: CEILING }));
    }
  }

  const rand = mulberry32(0xc0ffee);
  const entities: Entity[] = [];
  for (let i = 0; i < ENTITY_COUNT; i++) {
    const room = rooms[i % rooms.length]!;
    const xs = room.polygon.map((p) => p[0]);
    const zs = room.polygon.map((p) => p[1]);
    const x0 = Math.min(...xs) + 0.3, x1 = Math.max(...xs) - 0.3;
    const z0 = Math.min(...zs) + 0.3, z1 = Math.max(...zs) - 0.3;
    const cx = x0 + rand() * (x1 - x0);
    const cz = z0 + rand() * (z1 - z0);
    const hw = 0.15 + rand() * 0.25;
    const hh = 0.2 + rand() * 0.6;
    entities.push({
      id: `e_${i}`, stableKey: `e_${i}`, label: `object ${i}`, category: 'furniture',
      roomId: room.id,
      centroid: [cx, hh, cz],
      aabb: { min: [cx - hw, 0, cz - hw], max: [cx + hw, 2 * hh, cz + hw] },
      observedIn: [], grounding: { provenance: 'reconstructed', confidence: 0.9 },
    });
  }

  const nodes = rooms.map((room, i) => {
    const xs = room.polygon.map((p) => p[0]);
    const zs = room.polygon.map((p) => p[1]);
    return {
      id: `n_${i}`, roomId: room.id,
      position: [
        (Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2,
      ] as Vec3,
      clearance: 1, isEntrance: i === 0, isViewpoint: true,
    };
  });
  const edges = [];
  for (let r = 0; r < ROOM_ROWS; r++) {
    for (let c = 0; c < ROOM_COLS; c++) {
      const i = r * ROOM_COLS + c;
      if (c + 1 < ROOM_COLS) edges.push({ a: `n_${i}`, b: `n_${i + 1}`, cost: ROOM_W + 0.1, kind: 'door' as const });
      if (r + 1 < ROOM_ROWS) edges.push({ a: `n_${i}`, b: `n_${i + ROOM_COLS}`, cost: ROOM_D + 0.1, kind: 'door' as const });
    }
  }

  // Tessellated shell: floor, ceiling and four walls per room, subdivided to a
  // cell size chosen so the whole property lands near the triangle target.
  const areaPerRoom = 2 * ROOM_W * ROOM_D + 2 * CEILING * (ROOM_W + ROOM_D);
  const cell = Math.sqrt((areaPerRoom * rooms.length * 2) / TRIANGLE_TARGET);
  const pos: number[] = [];
  const idx: number[] = [];
  const sIds: number[] = [];

  const grid = (
    origin: Vec3, u: Vec3, v: Vec3, uLen: number, vLen: number, surfaceId: number,
  ): void => {
    const nu = Math.max(1, Math.round(uLen / cell));
    const nv = Math.max(1, Math.round(vLen / cell));
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const s = (i / nu) * uLen;
        const t = (j / nv) * vLen;
        pos.push(
          origin[0] + u[0] * s + v[0] * t,
          origin[1] + u[1] * s + v[1] * t,
          origin[2] + u[2] * s + v[2] * t,
        );
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
        sIds.push(surfaceId, surfaceId);
      }
    }
  };

  rooms.forEach((room, ri) => {
    const xs = room.polygon.map((p) => p[0]);
    const zs = room.polygon.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const z0 = Math.min(...zs), z1 = Math.max(...zs);
    grid([x0, 0, z0], [1, 0, 0], [0, 0, 1], x1 - x0, z1 - z0, ri);
    grid([x0, CEILING, z0], [1, 0, 0], [0, 0, 1], x1 - x0, z1 - z0, ri);
    grid([x0, 0, z0], [1, 0, 0], [0, 1, 0], x1 - x0, CEILING, ri);
    grid([x0, 0, z1], [1, 0, 0], [0, 1, 0], x1 - x0, CEILING, ri);
    grid([x0, 0, z0], [0, 0, 1], [0, 1, 0], z1 - z0, CEILING, ri);
    grid([x1, 0, z0], [0, 0, 1], [0, 1, 0], z1 - z0, CEILING, ri);
  });

  return {
    doc: emptyDoc({ rooms, entities, nav: { nodes, edges } }),
    proxy: {
      positions: Float32Array.from(pos),
      indices: Uint32Array.from(idx),
      surfaceIds: Uint32Array.from(sIds),
    },
    triangleCount: idx.length / 3,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe('performance on a full flat', () => {
  const workload = buildWorkload();
  const t0 = performance.now();
  const world = World.fromDocument(workload.doc, { proxyMesh: workload.proxy });
  const buildMs = performance.now() - t0;

  // Split the cold build so a regression can be attributed, and repeat it once
  // warm: the first build in a process pays for the JIT as well as the work.
  const tSoup = performance.now();
  const soup = buildSoup(workload.doc, workload.proxy);
  const soupMs = performance.now() - tSoup;
  const tBvh = performance.now();
  const bvh = new Bvh(soup.positions, soup.indices);
  const bvhMs = performance.now() - tBvh;

  const rand = mulberry32(99);
  const minX = 0, maxX = ROOM_COLS * (ROOM_W + 0.1);
  const minZ = 0, maxZ = ROOM_ROWS * (ROOM_D + 0.1);
  const origins: Vec3[] = [];
  const dirs: Vec3[] = [];
  for (let i = 0; i < 20000; i++) {
    origins.push([
      minX + rand() * (maxX - minX), 0.2 + rand() * (CEILING - 0.4), minZ + rand() * (maxZ - minZ),
    ]);
    const th = rand() * Math.PI * 2;
    const ph = Math.acos(2 * rand() - 1);
    dirs.push([Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)]);
  }

  it('reports the workload it actually measured', () => {
    expect(world.doc.rooms).toHaveLength(ROOM_COLS * ROOM_ROWS);
    expect(world.doc.entities).toHaveLength(ENTITY_COUNT);
    // The proxy triangles plus 12 per entity proxy box.
    expect(world.bvh.triangleCount).toBeGreaterThan(150_000);
    // eslint-disable-next-line no-console
    console.log(
      `\n  workload: ${world.doc.rooms.length} rooms, ${world.doc.entities.length} entities, ` +
      `${world.bvh.triangleCount.toLocaleString()} triangles in the BVH ` +
      `(${workload.triangleCount.toLocaleString()} from the proxy mesh)\n` +
      `  world build (soup + BVH): ${buildMs.toFixed(1)} ms cold, ` +
      `${(soupMs + bvhMs).toFixed(1)} ms warm (soup ${soupMs.toFixed(1)} ms, BVH ${bvhMs.toFixed(1)} ms)`,
    );
  });

  it('casts a ray in well under a millisecond', () => {
    // Warm up so the measurement is of steady-state, jitted code.
    for (let i = 0; i < 2000; i++) world.raycast(origins[i]!, dirs[i]!);

    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const start = performance.now();
      let hits = 0;
      for (let i = 0; i < origins.length; i++) {
        if (world.raycast(origins[i]!, dirs[i]!)) hits++;
      }
      runs.push(((performance.now() - start) * 1000) / origins.length);
      expect(hits).toBeGreaterThan(origins.length * 0.5);
    }
    const us = median(runs);

    // The same rays straight at the BVH, to separate traversal cost from the
    // engine's per-hit work (normal, ownership, provenance of the hit point).
    for (let i = 0; i < 2000; i++) {
      const d = dirs[i]!;
      bvh.raycast(origins[i]![0], origins[i]![1], origins[i]![2], d[0], d[1], d[2]);
    }
    const rawRuns: number[] = [];
    for (let r = 0; r < 5; r++) {
      const start = performance.now();
      for (let i = 0; i < origins.length; i++) {
        const o = origins[i]!;
        const d = dirs[i]!;
        bvh.raycast(o[0], o[1], o[2], d[0], d[1], d[2]);
      }
      rawRuns.push(((performance.now() - start) * 1000) / origins.length);
    }

    // eslint-disable-next-line no-console
    console.log(
      `  raycast: ${us.toFixed(2)} us per ray including hit resolution ` +
      `(median of ${runs.length} runs of ${origins.length})\n` +
      `  raycast: ${median(rawRuns).toFixed(2)} us per ray, BVH traversal only`,
    );
    expect(us).toBeLessThan(100); // 0.1 ms, ten times the target headroom
  });

  it('resolves the room under a point essentially for free', () => {
    const pts = origins.slice(0, 20000);
    for (let i = 0; i < 2000; i++) world.roomAt(pts[i]!);
    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const start = performance.now();
      let found = 0;
      for (const p of pts) if (world.roomAt(p)) found++;
      runs.push(((performance.now() - start) * 1000) / pts.length);
      expect(found).toBeGreaterThan(0);
    }
    const us = median(runs);
    // eslint-disable-next-line no-console
    console.log(`  roomAt:  ${us.toFixed(3)} us per query (median of ${runs.length} runs of ${pts.length})`);
    expect(us).toBeLessThan(10);
  });

  it('finds a path across the flat quickly', () => {
    const last = `r_${ROOM_ROWS - 1}_${ROOM_COLS - 1}`;
    for (let i = 0; i < 100; i++) world.findPath('r_0_0', last);
    const start = performance.now();
    const n = 2000;
    for (let i = 0; i < n; i++) expect(world.findPath('r_0_0', last)).not.toBeNull();
    const us = ((performance.now() - start) * 1000) / n;
    // eslint-disable-next-line no-console
    console.log(`  findPath (corner to corner, 12 nodes): ${us.toFixed(2)} us per query\n`);
    expect(us).toBeLessThan(2000);
  });
});
