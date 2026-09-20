/**
 * The compass conversion.
 *
 * Worth a test out of proportion to its size, for the reason the module header
 * gives: a sign error here still produces a plausible "turning too fast" cue,
 * so nothing looks broken, while `FovEstimator` quietly fails to correlate the
 * gyro with pixel flow and the whole capture falls back to a default field of
 * view. A bug that cannot be seen from the outside is exactly the kind that
 * needs pinning from the inside.
 */

import { describe, expect, it } from 'vitest';
import { normalise, orientationFrom } from './orientation.js';

const DEG = Math.PI / 180;

describe('orientationFrom', () => {
  it('turns alpha into a yaw that increases CLOCKWISE', () => {
    // alpha counts counter-clockwise, so a quarter-turn to the right takes
    // alpha from 0 to 270 -- and yaw must go from 0 to pi/2, not to 3pi/2.
    const facingNorth = orientationFrom({ alpha: 0, beta: 0, gamma: 0 }, 0)!;
    const quarterRight = orientationFrom({ alpha: 270, beta: 0, gamma: 0 }, 100)!;
    expect(facingNorth.yaw).toBeCloseTo(0, 6);
    expect(quarterRight.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('uses the iOS compass heading directly, because it is already clockwise', () => {
    const sample = orientationFrom(
      { alpha: 10, beta: 0, gamma: 0, webkitCompassHeading: 90 }, 0)!;
    expect(sample.yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(sample.absolute).toBe(true);
  });

  it('reports pitch and roll in radians', () => {
    const sample = orientationFrom({ alpha: 0, beta: 30, gamma: -15 }, 0)!;
    expect(sample.pitch).toBeCloseTo(30 * DEG, 6);
    expect(sample.roll).toBeCloseTo(-15 * DEG, 6);
  });

  it('is absolute only when it really is referenced to north', () => {
    expect(orientationFrom({ alpha: 12, beta: 0, gamma: 0, absolute: true }, 0)!.absolute).toBe(true);
    expect(orientationFrom({ alpha: 12, beta: 0, gamma: 0, absolute: false }, 0)!.absolute).toBe(false);
    expect(orientationFrom({ alpha: 12, beta: 0, gamma: 0 }, 0)!.absolute).toBe(false);
  });

  it('returns null for an event with nothing in it, rather than a perfect north', () => {
    // Desktop browsers and some tablets fire this event with null angles. A
    // stream of zeros would tell the coverage model the operator faced one
    // direction for the entire walk.
    expect(orientationFrom({ alpha: null, beta: null, gamma: null }, 0)).toBeNull();
    expect(orientationFrom({ alpha: Number.NaN, beta: 0, gamma: 0 }, 0)).toBeNull();
  });

  it('keeps the timestamp it was given', () => {
    expect(orientationFrom({ alpha: 0, beta: 0, gamma: 0 }, 1234)!.tMs).toBe(1234);
  });
});

describe('normalise', () => {
  it('wraps into [0, 2pi), which is the range the yaw bins are indexed off', () => {
    expect(normalise(0)).toBe(0);
    expect(normalise(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 10);
    expect(normalise(Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(normalise(Math.PI * 2)).toBeCloseTo(0, 10);
  });
});
