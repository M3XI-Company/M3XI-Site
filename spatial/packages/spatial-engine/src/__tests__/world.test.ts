import { describe, expect, it } from 'vitest';
import { World } from '../world.js';
import { isDefensible } from '../measure.js';
import { FLAT, FLAT_AREAS } from '../__fixtures__/flat.js';
import { quatFromYaw } from '../math/quat.js';
import type { Vec3 } from '@m3xi/world-core';

const w = World.fromDocument(FLAT);

describe('lookups', () => {
  it('resolves every id kind, and nothing else', () => {
    expect(w.room('r_kitchen')?.name).toBe('Kitchen/diner');
    expect(w.entity('e_sofa')?.label).toBe('sofa');
    expect(w.surface('s_r_hall_floor')?.kind).toBe('floor');
    expect(w.opening('o_front_door')?.kind).toBe('door');
    expect(w.room('nope')).toBeUndefined();
    expect(w.entity('nope')).toBeUndefined();
    expect(w.surface('nope')).toBeUndefined();
    expect(w.opening('nope')).toBeUndefined();
  });
});

describe('roomAt', () => {
  it('finds each room, including the concave one', () => {
    expect(w.roomAt([5.30, 1.0, 3.00])?.id).toBe('r_hall');
    expect(w.roomAt([3.00, 1.0, 1.50])?.id).toBe('r_kitchen');
    // The west leg of the L, past the re-entrant corner.
    expect(w.roomAt([1.40, 1.0, 5.00])?.id).toBe('r_kitchen');
    // The notch itself belongs to the bathroom, not the kitchen.
    expect(w.roomAt([3.50, 1.0, 5.00])?.id).toBe('r_bath');
    expect(w.roomAt([8.00, 1.0, 1.50])?.id).toBe('r_bed1');
    expect(w.roomAt([8.00, 1.0, 5.00])?.id).toBe('r_bed2');
  });

  it('rejects points outside the property and inside partitions', () => {
    expect(w.roomAt([20, 1, 20])).toBeUndefined();
    expect(w.roomAt([5.30, 1.0, -3])).toBeUndefined();
    // In the thickness of the hall/bedroom partition.
    expect(w.roomAt([6.20, 1.0, 3.00])).toBeUndefined();
  });

  it('respects the vertical extent', () => {
    expect(w.roomAt([5.30, 5.0, 3.00])).toBeUndefined();
    expect(w.roomAt([5.30, -1.0, 3.00])).toBeUndefined();
    expect(w.roomAt([5.30, 2.42, 3.00])?.id).toBe('r_hall');
  });

  it('is unbothered by non-finite input', () => {
    expect(w.roomAt([NaN, 1, 1])).toBeUndefined();
  });
});

describe('entity queries', () => {
  it('lists entities by room', () => {
    expect(w.entitiesIn('r_bath').map((e) => e.id).sort())
      .toEqual(['e_basin', 'e_bath', 'e_wc']);
    expect(w.entitiesIn('r_bed2')).toHaveLength(4);
    expect(w.entitiesIn('nope')).toEqual([]);
  });

  it('filters by label, category and room', () => {
    expect(w.findEntities({ label: 'chair' }).map((e) => e.id).sort())
      .toEqual(['e_chair_a', 'e_chair_b', 'e_chair_c', 'e_chair_d', 'e_desk_chair']);
    expect(w.findEntities({ label: 'CHAIR', roomId: 'r_bed2' }).map((e) => e.id))
      .toEqual(['e_desk_chair']);
    expect(w.findEntities({ category: 'appliance' }).map((e) => e.id).sort())
      .toEqual(['e_fridge', 'e_oven', 'e_tv']);
  });

  it('orders by distance to the box, not the centroid, and honours within/limit', () => {
    // Sitting on the sofa: it is the thing we are touching, and the dining
    // table is across the room.
    const at: Vec3 = [1.50, 0.40, 4.75];
    const nearest = w.findEntities({ near: at, within: 1.0 });
    expect(nearest[0]!.id).toBe('e_sofa');
    expect(nearest.every((e) => e.id !== 'e_dining_table')).toBe(true);
    expect(w.findEntities({ near: at, limit: 3 })).toHaveLength(3);
    expect(w.findEntities({ near: at, within: 0 }).map((e) => e.id)).toEqual(['e_sofa']);
  });

  it('returns everything for an empty query', () => {
    expect(w.findEntities()).toHaveLength(FLAT.entities.length);
  });
});

describe('raycast', () => {
  it('hits a known object at a hand-computed distance', () => {
    // From the hall, through the bedroom door (below the window sill so the
    // window punch is not in the way), into the side of the double bed at
    // x = 6.30.
    const hit = w.raycast([5.30, 0.50, 1.60], [1, 0, 0], { maxDistance: 20 });
    expect(hit).not.toBeNull();
    expect(hit!.entityId).toBe('e_bed_double');
    expect(hit!.distance).toBeCloseTo(1.0, 6);
    expect(hit!.normal[0]).toBeCloseTo(-1, 6);
    expect(hit!.point[0]).toBeCloseTo(6.30, 6);
  });

  it('skips ignored ids and carries on to the next surface', () => {
    const hit = w.raycast([5.30, 0.50, 1.60], [1, 0, 0], {
      maxDistance: 20, ignore: ['e_bed_double'],
    });
    expect(hit!.entityId).toBe('e_wardrobe');
    expect(hit!.distance).toBeCloseTo(4.65, 6);
  });

  it('is stopped by a solid wall at the wall face', () => {
    const hit = w.raycast([5.30, 1.00, 3.00], [-1, 0, 0], { maxDistance: 10 });
    expect(hit!.surfaceId).toBe('s_r_hall_wall_3');
    expect(hit!.distance).toBeCloseTo(0.85, 6);
  });

  it('passes through a doorway but not through the wall above it', () => {
    // The kitchen door head is at 1.981 m.
    const through = w.raycast([5.00, 1.60, 1.60], [-1, 0, 0], { maxDistance: 0.8 });
    expect(through).toBeNull();
    const above = w.raycast([5.00, 2.20, 1.60], [-1, 0, 0], { maxDistance: 0.8 });
    expect(above).not.toBeNull();
    expect(above!.distance).toBeCloseTo(0.55, 6);
  });

  it('respects maxDistance and refuses degenerate rays', () => {
    expect(w.raycast([5.30, 1.00, 3.00], [-1, 0, 0], { maxDistance: 0.5 })).toBeNull();
    expect(w.raycast([5.30, 1.00, 3.00], [0, 0, 0])).toBeNull();
    expect(w.raycast([NaN, 1, 1], [1, 0, 0])).toBeNull();
  });

  it('reports the weakest provenance of the surface and the point', () => {
    const hit = w.raycast([5.30, 1.00, 3.00], [-1, 0, 0])!;
    expect(hit.provenance).toBe('reconstructed');
  });
});

describe('checkVisibility', () => {
  it('sees an object across an open doorway', () => {
    expect(w.checkVisibility([5.30, 1.60, 1.00], 'e_bed_double').visible).toBe(true);
  });

  it('names the wall that blocks a hidden object', () => {
    const r = w.checkVisibility([5.30, 1.60, 1.00], 'e_wardrobe');
    expect(r.visible).toBe(false);
    expect(r.blockedBy).toBe('s_r_hall_wall_1');
  });

  it('sees the television from the sofa', () => {
    expect(w.checkVisibility([1.50, 1.00, 4.75], 'e_tv').visible).toBe(true);
  });

  it('handles rooms, openings and unknown ids', () => {
    expect(w.checkVisibility([5.30, 1.60, 1.00], 'o_front_door').visible).toBe(true);
    expect(w.checkVisibility([5.30, 1.60, 1.00], 'r_bed1').visible).toBe(true);
    expect(w.checkVisibility([5.30, 1.60, 1.00], 'nope').visible).toBe(false);
    expect(w.checkVisibility([NaN, 1, 1], 'e_sofa').visible).toBe(false);
  });
});

describe('checkCollision', () => {
  it('finds the entity a box overlaps', () => {
    const r = w.checkCollision({ centre: [1.50, 0.40, 4.70], half: [0.3, 0.3, 0.3], quat: [0, 0, 0, 1] });
    expect(r.collides).toBe(true);
    expect(r.with).toContain('e_sofa');
  });

  it('reports free space in the middle of the hall as free', () => {
    const r = w.checkCollision({ centre: [5.30, 1.00, 3.00], half: [0.2, 0.2, 0.2], quat: [0, 0, 0, 1] });
    expect(r).toEqual({ collides: false, with: [] });
  });

  it('does not call resting on the floor a collision', () => {
    // A 0.5 m cube standing exactly on the hall floor.
    const r = w.checkCollision({ centre: [5.30, 0.25, 2.20], half: [0.25, 0.25, 0.25], quat: [0, 0, 0, 1] });
    expect(r.collides).toBe(false);
  });

  it('finds walls and fixtures a box is pushed into', () => {
    const r = w.checkCollision({ centre: [4.50, 1.00, 3.40], half: [0.3, 0.3, 0.3], quat: [0, 0, 0, 1] });
    expect(r.collides).toBe(true);
    expect(r.with).toContain('e_hall_radiator');
    expect(r.with).toContain('s_r_hall_wall_3');
  });

  it('shrugs off a malformed box', () => {
    expect(w.checkCollision({ centre: [NaN, 0, 0], half: [1, 1, 1], quat: [0, 0, 0, 1] }))
      .toEqual({ collides: false, with: [] });
  });
});

describe('measurement', () => {
  it('reproduces every room area and states the declared standard', () => {
    for (const [id, expected] of Object.entries(FLAT_AREAS)) {
      const q = w.measureArea(id);
      expect(q.value).toBeCloseTo(expected, 9);
      expect(q.unit).toBe('m2');
      expect(q.standard).toBe('RICS-COMP-GIA');
      expect(q.toleranceUnit).toBe('pct');
      expect(q.tolerance).toBeGreaterThan(0);
    }
  });

  it('widens the area tolerance for a long thin room beyond the policy floor', () => {
    // Policy floor is 2.5%. The hall is 1.7 m x 5.9 m, so a 20 mm wall error is
    // worth more than that; the kitchen/diner is chunky enough that it is not.
    expect(w.measureArea('r_hall').tolerance).toBeGreaterThan(2.5);
    expect(w.measureArea('r_kitchen').tolerance).toBeCloseTo(2.5, 9);
  });

  it('measures distances between every target kind', () => {
    const a = w.measureDistance([0, 0, 0], [3, 4, 0]);
    expect(a.value).toBeCloseTo(5, 9);
    expect(a.unit).toBe('m');
    expect(a.toleranceUnit).toBe('mm');
    expect(a.standard).toBe('CLEAR-INTERNAL');

    const b = w.measureDistance({ entityId: 'e_sofa' }, { openingId: 'o_win_kitchen_s' });
    expect(b.value).toBeGreaterThan(1.5);
    expect(b.basis!['gapM']).toBeLessThan(b.value);

    expect(w.measureDistance({ roomId: 'r_hall' }, { roomId: 'r_bed1' }).value).toBeGreaterThan(0);
    expect(w.measureDistance({ surfaceId: 's_r_hall_floor' }, [5.3, 2.4, 3.2]).value)
      .toBeCloseTo(2.4, 6);
  });

  it('throws on an unknown target id rather than inventing a point', () => {
    expect(() => w.measureDistance({ entityId: 'nope' }, [0, 0, 0])).toThrow(/no entity/);
    expect(() => w.measureArea('nope')).toThrow(/no room/);
  });

  it('measures clearance against the nearest geometry', () => {
    // Mid-hall: the nearest thing is a wall face 0.85 m away.
    expect(w.measureClearance([5.30, 1.20, 2.00]).value).toBeCloseTo(0.85, 2);
    // Next to the hall radiator, which sticks out further than the wall.
    expect(w.measureClearance([5.30, 1.00, 3.00]).value).toBeLessThan(0.85);
  });

  it('reports zero clearance inside an object', () => {
    const q = w.measureClearance([1.50, 0.40, 4.70]);
    expect(q.value).toBe(0);
    expect(q.basis!['insideEntityId']).toBe('e_sofa');
  });

  it('survives a non-finite clearance query', () => {
    const q = w.measureClearance([NaN, 0, 0]);
    expect(q.value).toBe(0);
    expect(isDefensible(q)).toBe(false);
  });
});

describe('visibleFrom', () => {
  it('returns what a camera in the hall facing the kitchen can actually see', () => {
    const vis = w.visibleFrom({
      position: [5.30, 1.60, 1.00],
      orientation: quatFromYaw(Math.PI / 2), // forward becomes -X
      fov: 1.2,
    }, { maxDistance: 15 });
    const ids = vis.entities.map((e) => e.id);
    expect(ids).toContain('e_dining_table');
    expect(ids).toContain('e_sofa');
    // Behind the camera, and behind two walls.
    expect(ids).not.toContain('e_wardrobe');
    expect(vis.rooms.map((r) => r.id)).toContain('r_hall');
    expect(vis.rooms.map((r) => r.id)).toContain('r_kitchen');
    expect(vis.openings.map((o) => o.id)).toContain('o_door_kitchen');
  });

  it('prefers intrinsics over a stated fov', () => {
    const cam = FLAT.cameras.find((c) => c.id === 'cam_bed1_01')!;
    const vis = w.visibleFrom({
      position: cam.position, orientation: cam.orientation, intrinsics: cam.intrinsics,
    }, { maxDistance: 12 });
    expect(vis.entities.length).toBeGreaterThan(0);
    expect(vis.rooms.map((r) => r.id)).toContain('r_bed1');
  });

  it('returns nothing for a malformed pose', () => {
    const vis = w.visibleFrom({ position: [NaN, 0, 0], orientation: [0, 0, 0, 1] });
    expect(vis).toEqual({ rooms: [], entities: [], openings: [] });
  });
});
