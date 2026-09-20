import { describe, expect, it } from 'vitest';
import { World } from '../world.js';
import { FLAT } from '../__fixtures__/flat.js';
import { emptyDoc, rectRoom } from '../__fixtures__/minimal.js';
import { obbContains } from '../math/obb.js';
import { pointInRing, sanitiseRing } from '../math/polygon.js';
import type { Obb, Vec3 } from '@m3xi/world-core';

const w = World.fromDocument(FLAT);

/** Yaw of a rotation that is only about +Y, in [0, pi). */
function yawOf(o: Obb): number {
  return 2 * Math.atan2(o.quat[1], o.quat[3]);
}

describe('fitTest', () => {
  it('fits a normal wardrobe into bedroom 2, against a wall', () => {
    const r = w.fitTest('r_bed2', [1.0, 2.05, 0.6], { againstWall: true, clearance: 0.02 });
    expect(r.fits).toBe(true);
    expect(r.placements.length).toBeGreaterThan(0);
    expect(r.reason).toBeUndefined();

    const ring = sanitiseRing(FLAT.rooms.find((x) => x.id === 'r_bed2')!.polygon);
    for (const p of r.placements) {
      // Every placement sits on the floor and inside the room outline.
      expect(p.centre[1]).toBeCloseTo(2.05 / 2, 9);
      expect(pointInRing(ring, p.centre[0], p.centre[2])).not.toBe('out');
      // ...and clear of the furniture already there.
      for (const e of w.entitiesIn('r_bed2')) {
        expect(obbContains(p, e.centroid)).toBe(false);
      }
    }
  });

  it('refuses something taller than the room and says so', () => {
    const r = w.fitTest('r_bed2', [0.6, 2.60, 0.6]);
    expect(r.fits).toBe(false);
    expect(r.placements).toEqual([]);
    expect(r.reason).toMatch(/too tall/);
    expect(r.reason).toMatch(/2\.40 m/);
  });

  it('refuses a footprint the room cannot hold, at any angle', () => {
    const r = w.fitTest('r_bath', [2.2, 2.05, 0.9]);
    expect(r.fits).toBe(false);
    expect(r.reason).toMatch(/does not fit inside the outline/);
  });

  it('names the furniture in the way when the room itself is big enough', () => {
    // Bedroom 1 is 4.5 m x 3.1 m, so a 4.4 m x 2.9 m object fits the outline
    // but nothing like it can clear the bed and the wardrobe.
    const r = w.fitTest('r_bed1', [4.4, 1.0, 2.9]);
    expect(r.fits).toBe(false);
    expect(r.reason).toMatch(/blocked by/);
    expect(r.reason).toMatch(/e_bed_double|e_wardrobe/);
  });

  it('handles bad input without throwing', () => {
    expect(w.fitTest('nope', [1, 1, 1]).fits).toBe(false);
    expect(w.fitTest('r_bed2', [0, 1, 1]).reason).toMatch(/positive metres/);
    expect(w.fitTest('r_bed2', [NaN, 1, 1]).fits).toBe(false);
  });

  it('refuses a room whose outline is degenerate', () => {
    const broken = World.fromDocument(emptyDoc({
      rooms: [{ ...rectRoom('r_a', 0, 0, 4, 4), polygon: [[0, 0], [1, 1]] }],
    }));
    expect(broken.fitTest('r_a', [0.5, 0.5, 0.5]).reason).toMatch(/degenerate/);
  });
});

describe('fitTest: the diagonal case', () => {
  // A 1.8 m square room. A 2.0 m x 0.4 m board cannot go in square -- 2.0 > 1.8
  // on both axes -- but at 45 degrees it needs (2.0 + 0.4) / sqrt(2) = 1.697 m,
  // which fits with about 50 mm to spare on each side.
  const square = World.fromDocument(emptyDoc({
    rooms: [rectRoom('r_sq', 0, 0, 1.8, 1.8)],
  }));

  it('fits only when it is allowed to turn', () => {
    const r = square.fitTest('r_sq', [2.0, 0.5, 0.4]);
    expect(r.fits).toBe(true);
    expect(r.placements.length).toBeGreaterThan(0);
    for (const p of r.placements) {
      const yaw = yawOf(p);
      // Not axis aligned: sin(2 * yaw) is zero at 0 and 90 degrees.
      expect(Math.abs(Math.sin(2 * yaw))).toBeGreaterThan(0.5);
    }
  });

  it('still refuses when even the diagonal is too short', () => {
    // (2.6 + 0.4) / sqrt(2) = 2.12 m, which is wider than the room.
    expect(square.fitTest('r_sq', [2.6, 0.5, 0.4]).fits).toBe(false);
  });

  it('fits the same object square-on once the room is wide enough', () => {
    const wide = World.fromDocument(emptyDoc({
      rooms: [rectRoom('r_wide', 0, 0, 3.0, 3.0)],
    }));
    const r = wide.fitTest('r_wide', [2.0, 0.5, 0.4]);
    expect(r.fits).toBe(true);
    expect(r.placements.some((p) => Math.abs(Math.sin(2 * yawOf(p))) < 1e-6)).toBe(true);
  });

  it('respects a requested clearance margin', () => {
    // 0.1 m all round takes the diagonal requirement to (2.2 + 0.6)/sqrt(2)
    // = 1.98 m, past what a 1.8 m room can hold.
    expect(square.fitTest('r_sq', [2.0, 0.5, 0.4], { clearance: 0.1 }).fits).toBe(false);
  });

  it('will not put a free-standing object against a wall it cannot reach', () => {
    const big = World.fromDocument(emptyDoc({
      rooms: [rectRoom('r_big', 0, 0, 6, 6)],
    }));
    const flush = big.fitTest('r_big', [1.0, 0.5, 0.5], { againstWall: true });
    expect(flush.fits).toBe(true);
    const ring = sanitiseRing(big.room('r_big')!.polygon);
    for (const p of flush.placements) {
      const c: Vec3 = p.centre;
      const toEdge = Math.min(c[0], c[2], 6 - c[0], 6 - c[2]);
      // Half the object's smaller dimension, plus the 30 mm flush tolerance.
      expect(toEdge).toBeLessThan(0.5 + 0.031);
      expect(pointInRing(ring, c[0], c[2])).toBe('in');
    }
  });
});
