import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type { Vec3 } from '@m3xi/world-core';
import { CameraConstraint, distanceToSegmentXZ } from '../nav/constraints.js';

const world = World.fromDocument(FLAT);
const constraint = (opts = {}): CameraConstraint => new CameraConstraint(world, opts);

describe('spawning', () => {
  it('starts at the entrance node, at eye height, in the entrance room', () => {
    const spawn = constraint().spawn();
    expect(spawn.nodeId).toBe('n_hall_a');
    expect(spawn.position[0]).toBeCloseTo(5.3, 6);
    expect(spawn.position[1]).toBeCloseTo(1.6, 6);
    expect(spawn.position[2]).toBeCloseTo(1.0, 6);
    expect(world.roomAt(spawn.position)?.id).toBe('r_hall');
  });

  it('faces the cheapest way onwards rather than an arbitrary yaw', () => {
    const spawn = constraint().spawn();
    expect(Number.isFinite(spawn.yaw)).toBe(true);
    expect(Math.abs(spawn.yaw)).toBeGreaterThan(0.1);
  });

  it('honours an explicit start node', () => {
    expect(constraint().spawn('n_bed2_a').nodeId).toBe('n_bed2_a');
  });
});

describe('canStand', () => {
  it('accepts an ordinary point in the middle of a room', () => {
    const check = constraint().canStand([5.3, 1.6, 3.2]);
    expect(check.ok).toBe(true);
    expect(check.roomId).toBe('r_hall');
  });

  it('refuses a point inside a volume no camera observed', () => {
    // rg_bed1_far_corner: x 9.95..10.76, z 2.05..3.36, generated.
    const check = constraint().canStand([10.3, 1.6, 2.7]);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('unsurveyed');
    expect(check.blockedBy).toBe('rg_bed1_far_corner');
    expect(check.provenance).toBe('generated');
  });

  it('lets an operator into unsurveyed space, and a visitor never', () => {
    expect(constraint({ allowUnsurveyed: true }).canStand([10.3, 1.6, 2.7]).ok).toBe(true);
    expect(constraint({ allowUnsurveyed: false }).canStand([10.3, 1.6, 2.7]).ok).toBe(false);
  });

  it('refuses a point outside every room and away from the nav graph', () => {
    const check = constraint().canStand([40, 1.6, 40]);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('offgraph');
  });

  it('refuses a point closer to geometry than the camera radius', () => {
    const check = constraint().canStand([4.55, 1.6, 3.2]);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('clearance');
  });

  it('refuses NaN', () => {
    const check = constraint().canStand([Number.NaN, 1.6, 0]);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('invalid');
  });
});

describe('move', () => {
  it('walks freely down an empty hall', () => {
    const result = constraint().move([5.3, 1.6, 1.4], [0, 0, 0.5]);
    expect(result.moved).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.position[2]).toBeCloseTo(1.9, 4);
    expect(result.roomId).toBe('r_hall');
  });

  it('stops short of a wall rather than passing through it', () => {
    const result = constraint().move([5.3, 1.6, 3.2], [-3, 0, 0]);
    expect(result.position[0]).toBeGreaterThan(4.45);
    expect(result.position[0]).toBeLessThan(4.45 + 0.6);
    expect(world.roomAt(result.position)?.id).toBe('r_hall');
  });

  it('slides along a wall when pushed into it at an angle', () => {
    const result = constraint().move([5.0, 1.6, 3.2], [-1.5, 0, 1.5]);
    expect(result.moved).toBe(true);
    expect(result.position[2]).toBeGreaterThan(3.2);
    expect(result.position[0]).toBeGreaterThan(4.45);
  });

  it('will not walk through a mirror', () => {
    const result = constraint().move([3.5, 1.6, 5.6], [0, 0, 1.2]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('mirror');
    expect(result.moved).toBe(false);
  });

  it('never crosses into unsurveyed space, however many steps it takes', () => {
    const c = constraint();
    let p: Vec3 = [9.4, 1.6, 2.7];
    for (let i = 0; i < 40; i++) {
      const r = c.move(p, [0.25, 0, 0]);
      p = r.position;
      expect(p[0]).toBeLessThan(9.95);
      expect(c.canStand(p).provenance).not.toBe('generated');
    }
  });

  it('ignores vertical input: a walking visitor does not fly', () => {
    const result = constraint().move([5.3, 1.6, 3.2], [0, 5, 0]);
    expect(result.moved).toBe(false);
    expect(result.position[1]).toBeCloseTo(1.6, 6);
  });

  it('keeps the camera at eye height above the floor slab', () => {
    const result = constraint().move([5.3, 1.6, 1.6], [-1.0, 0, 0]);
    expect(result.position[1]).toBeCloseTo(1.6, 6);
  });

  it('reports no movement and no block for a zero delta', () => {
    const result = constraint().move([5.3, 1.6, 3.2], [0, 0, 0]);
    expect(result.moved).toBe(false);
    expect(result.blocked).toBe(false);
  });
});

describe('corridors and viewpoints', () => {
  it('treats a doorway node as walkable even though it is inside a wall', () => {
    expect(constraint().nearCorridor([4.4, 1.6, 1.6])).toBe(true);
  });

  it('finds the nearest declared viewpoint in a given room', () => {
    expect(constraint().nearestViewpoint([9.0, 1.6, 1.7], 'r_bed1')?.id).toBe('n_bed1_a');
  });

  it('measures point-to-segment distance in the XZ plane only', () => {
    expect(distanceToSegmentXZ([1, 99, 0], [0, 0, 0], [2, 0, 0])).toBeCloseTo(0, 9);
  });
});
