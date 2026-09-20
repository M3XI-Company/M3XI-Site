import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type { Vec3 } from '@m3xi/world-core';
import { CameraConstraint } from '../nav/constraints.js';
import { buildCameraPath, lerpAngle, pitchTo, yawTo } from '../nav/path.js';

const world = World.fromDocument(FLAT);
const constraint = new CameraConstraint(world);

function path(from: string, to: string) {
  const p = world.findPath(from, to);
  if (!p) throw new Error(`no path ${from} -> ${to}`);
  return p;
}

describe('camera path along a nav route', () => {
  const route = path('n_hall_a', 'r_bed2');

  it('begins at the first nav node, lifted to eye height', () => {
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6 });
    const start = cam.sample(0);
    expect(start.position[0]).toBeCloseTo(route.nodes[0]!.position[0], 3);
    expect(start.position[2]).toBeCloseTo(route.nodes[0]!.position[2], 3);
    expect(start.position[1]).toBeCloseTo(1.6, 3);
  });

  it('ends exactly at the last nav node', () => {
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6 });
    const end = cam.sample(cam.duration);
    const last = route.nodes[route.nodes.length - 1]!.position;
    expect(end.position[0]).toBeCloseTo(last[0], 3);
    expect(end.position[2]).toBeCloseTo(last[2], 3);
  });

  it('clamps beyond the end rather than extrapolating past it', () => {
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6 });
    const a = cam.sample(cam.duration);
    const b = cam.sample(cam.duration * 10);
    expect(b.position[0]).toBeCloseTo(a.position[0], 9);
    expect(b.position[2]).toBeCloseTo(a.position[2], 9);
  });

  it('advances monotonically along the route', () => {
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6 });
    let travelled = 0;
    let previous = cam.sample(0).position;
    for (let i = 1; i <= 60; i++) {
      const p = cam.sample((i / 60) * cam.duration).position;
      const step = Math.hypot(p[0] - previous[0], p[2] - previous[2]);
      travelled += step;
      previous = p;
    }
    // Never backtracks, and the spline stays close to the graph length.
    expect(travelled).toBeGreaterThan(cam.length * 0.9);
    expect(travelled).toBeLessThan(cam.length * 1.25);
  });

  it('takes a plausible amount of time at walking pace', () => {
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6, speedMps: 1.2 });
    expect(cam.duration).toBeGreaterThan(cam.length / 1.6);
    expect(cam.duration).toBeLessThan(cam.length / 0.8);
  });

  it('stays inside the walkable world at every sample', () => {
    const cam = buildCameraPath(route, 0, {
      eyeHeight: 1.6,
      validate: (p) => constraint.canStand(p).ok,
    });
    for (let i = 0; i <= 80; i++) {
      const p = cam.sample((i / 80) * cam.duration).position;
      // Every sample must be somewhere a visitor could legally stand, or on
      // the nav polyline itself (doorway nodes sit inside a partition).
      const standable = constraint.canStand(p).ok;
      const onGraph = constraint.nearCorridor(p);
      expect(standable || onGraph).toBe(true);
    }
  });

  it('cuts instantly under prefers-reduced-motion', () => {
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6, reducedMotion: true });
    expect(cam.instant).toBe(true);
    expect(cam.duration).toBe(0);
    const last = route.nodes[route.nodes.length - 1]!.position;
    expect(cam.sample(0).position[0]).toBeCloseTo(last[0], 3);
  });

  it('faces the requested target on arrival', () => {
    const lookAt: Vec3 = [10.7, 1.4, 4.8];
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6, lookAt });
    const end = cam.sample(cam.duration);
    expect(end.yaw).toBeCloseTo(yawTo(end.position, lookAt), 2);
  });

  it('handles a single-node path without dividing by zero', () => {
    const cam = buildCameraPath({ nodes: [world.doc.nav.nodes[0]!], length: path('n_hall_a', 'n_hall_a').length }, 0.5);
    expect(cam.instant).toBe(true);
    expect(Number.isFinite(cam.sample(0).yaw)).toBe(true);
  });

  it('falls back to the straight line when every spline sample is refused', () => {
    const cam = buildCameraPath(route, 0, { eyeHeight: 1.6, validate: () => false });
    for (let i = 0; i <= 20; i++) {
      const p = cam.sample((i / 20) * cam.duration).position;
      expect(nearestPolylineDistance(p, route.nodes.map((n) => n.position), 1.6)).toBeLessThan(0.02);
    }
  });
});

describe('angles', () => {
  it('interpolates the short way round the circle', () => {
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(Math.PI, 5);
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 9);
  });

  it('computes yaw with 0 looking down negative Z', () => {
    expect(yawTo([0, 0, 0], [0, 0, -1])).toBeCloseTo(0, 9);
    expect(yawTo([0, 0, 0], [-1, 0, 0])).toBeCloseTo(Math.PI / 2, 9);
  });

  it('computes pitch from the vertical offset', () => {
    expect(pitchTo([0, 0, 0], [0, 1, -1])).toBeCloseTo(Math.PI / 4, 9);
    expect(pitchTo([0, 0, 0], [0, 0, -1])).toBeCloseTo(0, 9);
  });
});

function nearestPolylineDistance(p: Vec3, nodes: readonly Vec3[], lift: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a: Vec3 = [nodes[i]![0], nodes[i]![1] + lift, nodes[i]![2]];
    const b: Vec3 = [nodes[i + 1]![0], nodes[i + 1]![1] + lift, nodes[i + 1]![2]];
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const l2 = abx * abx + aby * aby + abz * abz;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1,
      ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2));
    best = Math.min(best, Math.hypot(
      p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t), p[2] - (a[2] + abz * t),
    ));
  }
  return best;
}
