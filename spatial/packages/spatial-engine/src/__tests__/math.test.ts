import { describe, expect, it } from 'vitest';
import {
  add, closestPointOnSegment, cross, distance, dot, isFiniteV3, length, normalise, sub,
} from '../math/vec3.js';
import {
  forwardOf, quatAngleBetween, quatFromAxisAngle, quatFromYaw, quatMul, quatNormalise,
  rightOf, rotate, rotateInverse, upOf,
} from '../math/quat.js';
import {
  distancePointToRing, earClip, edgeInwardNormal, pointInRing, ringArea, ringCentroid,
  ringPerimeter, ringSelfIntersects, ringSignedArea, sanitiseRing,
} from '../math/polygon.js';
import { closestPointOnTriangle, rayTriangle, triangleArea, triangleNormal } from '../math/triangle.js';
import {
  aabbGap, aabbClosestPoint, aabbContains, aabbFromPoints, aabbOverlaps,
} from '../math/aabb.js';
import {
  footprintOverlapFraction, obbContains, obbFromAabb, obbGap, obbIntersectsObb,
  obbIntersectsTriangle,
} from '../math/obb.js';
import type { Vec2, Vec3 } from '@m3xi/world-core';

const near = (a: number, b: number, eps = 1e-9): void => { expect(Math.abs(a - b)).toBeLessThan(eps); };
const nearV = (a: Vec3, b: Vec3, eps = 1e-9): void => {
  near(a[0], b[0], eps); near(a[1], b[1], eps); near(a[2], b[2], eps);
};

describe('vec3', () => {
  it('computes the hand-worked basics', () => {
    nearV(add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
    nearV(sub([1, 2, 3], [4, 5, 6]), [-3, -3, -3]);
    near(dot([1, 2, 3], [4, -5, 6]), 4 - 10 + 18);
    nearV(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
    nearV(cross([0, 1, 0], [0, 0, 1]), [1, 0, 0]);
    near(length([3, 4, 0]), 5);
    near(distance([1, 1, 1], [1, 1, 4]), 3);
    nearV(normalise([3, 4, 0]), [0.6, 0.8, 0]);
  });

  it('never returns NaN from a degenerate normalise', () => {
    nearV(normalise([0, 0, 0]), [0, 0, 0]);
    nearV(normalise([NaN, 1, 0]), [0, 0, 0]);
    expect(isFiniteV3(normalise([Infinity, 0, 0]))).toBe(true);
  });

  it('clamps segment projection to the segment', () => {
    nearV(closestPointOnSegment([0.5, 5, 0], [0, 0, 0], [1, 0, 0]), [0.5, 0, 0]);
    nearV(closestPointOnSegment([-3, 1, 0], [0, 0, 0], [1, 0, 0]), [0, 0, 0]);
    nearV(closestPointOnSegment([9, 1, 0], [0, 0, 0], [1, 0, 0]), [1, 0, 0]);
    nearV(closestPointOnSegment([1, 1, 1], [2, 2, 2], [2, 2, 2]), [2, 2, 2]);
  });
});

describe('quat', () => {
  it('rotates about +Y by the right-handed convention', () => {
    // R_y(90 deg) maps +X to -Z.
    nearV(rotate(quatFromYaw(Math.PI / 2), [1, 0, 0]), [0, 0, -1], 1e-12);
    nearV(rotate(quatFromYaw(Math.PI / 2), [0, 0, -1]), [-1, 0, 0], 1e-12);
    nearV(rotate(quatFromYaw(Math.PI), [1, 0, 0]), [-1, 0, 0], 1e-12);
  });

  it('rotates about +Z by the right-handed convention', () => {
    nearV(rotate(quatFromAxisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0], 1e-12);
  });

  it('composes rotations in the order a-after-b', () => {
    const half = quatFromYaw(Math.PI / 2);
    nearV(rotate(quatMul(half, half), [1, 0, 0]), [-1, 0, 0], 1e-12);
  });

  it('inverts exactly', () => {
    const q = quatFromAxisAngle([1, 2, 3], 0.7);
    nearV(rotateInverse(q, rotate(q, [0.3, -1.2, 5])), [0.3, -1.2, 5], 1e-12);
  });

  it('uses the three.js camera basis: forward -Z, up +Y, right +X', () => {
    nearV(forwardOf([0, 0, 0, 1]), [0, 0, -1]);
    nearV(upOf([0, 0, 0, 1]), [0, 1, 0]);
    nearV(rightOf([0, 0, 0, 1]), [1, 0, 0], 1e-12);
  });

  it('measures the angle between orientations', () => {
    near(quatAngleBetween([0, 0, 0, 1], quatFromYaw(Math.PI / 2)), Math.PI / 2, 1e-12);
    near(quatAngleBetween([0, 0, 0, 1], [0, 0, 0, 1]), 0, 1e-12);
  });

  it('falls back to identity for a degenerate quaternion', () => {
    expect(quatNormalise([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(quatNormalise([NaN, 0, 0, 1])).toEqual([0, 0, 0, 1]);
  });
});

const SQUARE: Vec2[] = [[0, 0], [2, 0], [2, 2], [0, 2]];
// L-shape: a 4x2 base with a 2x2 block on the left, so (3, 3) is in the notch.
const LSHAPE: Vec2[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];

describe('polygon', () => {
  it('computes known areas and perimeters', () => {
    near(ringArea(SQUARE), 4);
    near(ringPerimeter(SQUARE), 8);
    near(ringArea(LSHAPE), 12);
    near(ringArea([[0, 0], [1, 0], [0, 1]]), 0.5);
    nearV([...ringCentroid(SQUARE), 0] as Vec3, [1, 1, 0], 1e-12);
  });

  it('signs the shoelace so that CCW-from-above is negative in (x, z)', () => {
    // X x Z = -Y, so a ring that looks counter-clockwise from above has a
    // negative shoelace here. SQUARE as written is the other way round.
    expect(ringSignedArea(SQUARE)).toBeGreaterThan(0);
    expect(ringSignedArea([...SQUARE].reverse())).toBeLessThan(0);
  });

  it('classifies inside, outside and on-edge', () => {
    expect(pointInRing(SQUARE, 1, 1)).toBe('in');
    expect(pointInRing(SQUARE, 3, 1)).toBe('out');
    expect(pointInRing(SQUARE, -0.001, 1)).toBe('on');
    expect(pointInRing(SQUARE, 2, 1)).toBe('on');
    expect(pointInRing(SQUARE, 0, 0)).toBe('on');
    expect(pointInRing(SQUARE, 1, 2)).toBe('on');
  });

  it('handles the concave case', () => {
    expect(pointInRing(LSHAPE, 1, 3)).toBe('in');
    expect(pointInRing(LSHAPE, 3, 1)).toBe('in');
    expect(pointInRing(LSHAPE, 3, 3)).toBe('out');
    expect(pointInRing(LSHAPE, 2, 3)).toBe('on');
  });

  it('is robust to a ray passing exactly through a vertex', () => {
    // A horizontal ray at z = 2 grazes two vertices of the L; the half-open
    // rule has to count them once each.
    expect(pointInRing(LSHAPE, 1, 2, 0)).toBe('in');
    expect(pointInRing(LSHAPE, 3, 2, 0)).toBe('on');
    expect(pointInRing(LSHAPE, 4.5, 2, 0)).toBe('out');
    expect(pointInRing(LSHAPE, 3, 2.5, 0)).toBe('out');
  });

  it('measures distance to the boundary', () => {
    near(distancePointToRing(SQUARE, 1, 1), 1);
    near(distancePointToRing(SQUARE, -1, 1), 1);
    near(distancePointToRing(SQUARE, 3, 3), Math.SQRT2);
  });

  it('finds the inward normal regardless of winding', () => {
    const n = edgeInwardNormal(SQUARE, 0);
    expect(n).not.toBeNull();
    near(n![0], 0, 1e-12);
    near(n![1], 1, 1e-12);
    const r = edgeInwardNormal([...SQUARE].reverse(), 0);
    expect(r).not.toBeNull();
  });

  describe('malformed rings', () => {
    it('drops NaN and Infinity vertices', () => {
      const dirty = [[0, 0], [2, 0], [NaN, 1], [2, 2], [0, 2]] as Vec2[];
      expect(sanitiseRing(dirty)).toHaveLength(4);
      near(ringArea(sanitiseRing(dirty)), 4);
    });

    it('collapses duplicate and closing vertices', () => {
      const dirty = [[0, 0], [0, 0], [2, 0], [2, 2], [0, 2], [0, 0]] as Vec2[];
      expect(sanitiseRing(dirty)).toHaveLength(4);
    });

    it('returns an empty ring below three vertices, and answers "no" for it', () => {
      expect(sanitiseRing([[0, 0], [1, 1]])).toEqual([]);
      expect(sanitiseRing([])).toEqual([]);
      expect(sanitiseRing(undefined)).toEqual([]);
      expect(ringArea([])).toBe(0);
      expect(pointInRing([], 0, 0)).toBe('out');
      expect(ringPerimeter([])).toBe(0);
    });

    it('reports the NET area of a self-intersecting ring rather than throwing', () => {
      // A figure of eight: the two lobes are wound oppositely and cancel.
      const bowtie: Vec2[] = [[0, 0], [2, 0], [0, 2], [2, 2]];
      expect(ringSelfIntersects(bowtie)).toBe(true);
      near(ringArea(bowtie), 0);
      expect(() => pointInRing(bowtie, 1, 1)).not.toThrow();
    });

    it('terminates ear clipping on a self-intersecting ring', () => {
      const bowtie: Vec2[] = [[0, 0], [2, 0], [0, 2], [2, 2]];
      const tris = earClip(bowtie);
      expect(tris.length % 3).toBe(0);
      expect(tris.length).toBeLessThanOrEqual(3 * bowtie.length);
    });
  });

  it('triangulates a concave ring into triangles that sum to its area', () => {
    const tris = earClip(LSHAPE);
    expect(tris.length).toBe(3 * (LSHAPE.length - 2));
    let total = 0;
    for (let i = 0; i + 2 < tris.length; i += 3) {
      const a = LSHAPE[tris[i]!]!, b = LSHAPE[tris[i + 1]!]!, c = LSHAPE[tris[i + 2]!]!;
      total += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    near(total, ringArea(LSHAPE), 1e-9);
  });
});

describe('triangle', () => {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [1, 0, 0];
  const c: Vec3 = [0, 1, 0];

  it('computes normal and area', () => {
    nearV(triangleNormal(a, b, c), [0, 0, 1], 1e-12);
    near(triangleArea(a, b, c), 0.5);
    near(triangleArea(a, b, b), 0);
  });

  it('hits and misses analytically', () => {
    const hit = rayTriangle([0.25, 0.25, -3], [0, 0, 1], a, b, c);
    expect(hit).not.toBeNull();
    near(hit!.t, 3, 1e-12);
    near(hit!.u, 0.25, 1e-12);
    near(hit!.v, 0.25, 1e-12);

    expect(rayTriangle([0.9, 0.9, -3], [0, 0, 1], a, b, c)).toBeNull();
    expect(rayTriangle([0.25, 0.25, -3], [1, 0, 0], a, b, c)).toBeNull();
  });

  it('hits from behind, because a wall seen from the far side still blocks', () => {
    const hit = rayTriangle([0.25, 0.25, 3], [0, 0, -1], a, b, c);
    expect(hit).not.toBeNull();
    near(hit!.t, 3, 1e-12);
  });

  it('finds the closest point in every Voronoi region', () => {
    nearV(closestPointOnTriangle([0.25, 0.25, 5], a, b, c), [0.25, 0.25, 0], 1e-12);
    nearV(closestPointOnTriangle([-1, -1, 0], a, b, c), [0, 0, 0], 1e-12);
    nearV(closestPointOnTriangle([2, 0, 0], a, b, c), [1, 0, 0], 1e-12);
    nearV(closestPointOnTriangle([0.5, -1, 0], a, b, c), [0.5, 0, 0], 1e-12);
    expect(isFiniteV3(closestPointOnTriangle([1, 1, 1], a, b, b))).toBe(true);
  });
});

describe('aabb and obb', () => {
  it('does the basics', () => {
    const box = aabbFromPoints([[0, 0, 0], [1, 2, 3]]);
    expect(box.min).toEqual([0, 0, 0]);
    expect(box.max).toEqual([1, 2, 3]);
    expect(aabbContains(box, [0.5, 0.5, 0.5])).toBe(true);
    expect(aabbContains(box, [1.5, 0.5, 0.5])).toBe(false);
    nearV(aabbClosestPoint(box, [5, -5, 1]), [1, 0, 1]);
    expect(aabbOverlaps(box, { min: [0.5, 0.5, 0.5], max: [9, 9, 9] })).toBe(true);
  });

  it('ignores non-finite points when bounding', () => {
    const box = aabbFromPoints([[0, 0, 0], [NaN, 5, 5], [1, 1, 1]]);
    expect(box.max).toEqual([1, 1, 1]);
  });

  it('measures the gap between boxes', () => {
    near(aabbGap({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [3, 0, 0], max: [4, 1, 1] }), 2);
    near(aabbGap({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [0.5, 0, 0], max: [4, 1, 1] }), 0);
    near(aabbGap({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [4, 4, 0], max: [5, 5, 1] }), Math.hypot(3, 3));
  });

  it('separates and overlaps oriented boxes', () => {
    const unit = obbFromAabb({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    const far = { centre: [1.5, 0, 0] as Vec3, half: [0.5, 0.5, 0.5] as Vec3, quat: [0, 0, 0, 1] as const };
    const overlapping = { centre: [0.5, 0, 0] as Vec3, half: [0.5, 0.5, 0.5] as Vec3, quat: [0, 0, 0, 1] as const };
    const touching = { centre: [1, 0, 0] as Vec3, half: [0.5, 0.5, 0.5] as Vec3, quat: [0, 0, 0, 1] as const };
    expect(obbIntersectsObb(unit, far)).toBe(false);
    expect(obbIntersectsObb(unit, overlapping)).toBe(true);
    expect(obbIntersectsObb(unit, touching)).toBe(true);
    // Shrinking by a millimetre turns face contact back into separation.
    expect(obbIntersectsObb(unit, touching, -0.001)).toBe(false);

    // A box rotated 45 degrees about Y reaches sqrt(2)/2 along X instead of 0.5.
    const spun = { centre: [1.2, 0, 0] as Vec3, half: [0.5, 0.5, 0.5] as Vec3, quat: quatFromYaw(Math.PI / 4) };
    expect(obbIntersectsObb(unit, spun)).toBe(true);
    const spunFar = { ...spun, centre: [1.25, 0, 0] as Vec3 };
    expect(obbIntersectsObb(unit, spunFar)).toBe(false);
  });

  it('contains points in the rotated frame', () => {
    const o = { centre: [0, 0, 0] as Vec3, half: [1, 0.2, 0.2] as Vec3, quat: quatFromYaw(Math.PI / 2) };
    expect(obbContains(o, [0, 0, 0.9])).toBe(true);
    expect(obbContains(o, [0.9, 0, 0])).toBe(false);
  });

  it('measures the gap between oriented boxes', () => {
    const a = obbFromAabb({ min: [0, 0, 0], max: [1, 1, 1] });
    const b = obbFromAabb({ min: [3, 0, 0], max: [4, 1, 1] });
    near(obbGap(a, b), 2, 1e-6);
    near(obbGap(a, a), 0);
  });

  it('overlaps a triangle only when it really does', () => {
    const o = obbFromAabb({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(obbIntersectsTriangle(o, [-5, 0, 0], [5, 0, 0], [0, 5, 0])).toBe(true);
    expect(obbIntersectsTriangle(o, [-5, 9, 0], [5, 9, 0], [0, 14, 0])).toBe(false);
    // Bounds overlap the box, but the triangle is cut off by the diagonal
    // x + y >= 3 -- a separation only the edge-cross axes can find.
    expect(obbIntersectsTriangle(o, [0, 3, 0], [3, 0, 0], [3, 3, 0])).toBe(false);
  });

  it('computes footprint overlap as a fraction of the second box', () => {
    near(footprintOverlapFraction(
      { min: [0, 0, 0], max: [4, 1, 4] }, { min: [1, 0, 1], max: [3, 1, 3] },
    ), 1);
    near(footprintOverlapFraction(
      { min: [0, 0, 0], max: [2, 1, 2] }, { min: [1, 0, 0], max: [3, 1, 2] },
    ), 0.5);
    near(footprintOverlapFraction(
      { min: [0, 0, 0], max: [1, 1, 1] }, { min: [5, 0, 5], max: [6, 1, 6] },
    ), 0);
  });
});
