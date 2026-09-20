import type { NavNode, Vec3 } from '@m3xi/world-core';
import type { PathResult } from '@m3xi/spatial-engine';

/**
 * Turning a `findPath` result into a camera move.
 *
 * The nav graph gives a polyline through doorways. Walking it literally looks
 * like a robot: instant turns at every node, dead stops in door frames. A
 * centripetal Catmull-Rom spline through the same nodes reads as a person
 * walking, and centripetal (alpha = 0.5) specifically because the uniform
 * variant self-intersects on the tight 90-degree turn out of a hall into a
 * bedroom -- which would put the camera inside the wall it just came through.
 *
 * Even so a spline can bulge outside the corridor, so every sample is offered
 * to `validate` and falls back to the exact polyline point at the same arc
 * length when refused. The spline is a comfort, never an authority: the nav
 * graph is what the building supports.
 */

export interface CameraSample {
  readonly position: Vec3;
  readonly yaw: number;
  readonly pitch: number;
}

export interface CameraPathOptions {
  readonly eyeHeight?: number;
  /** Comfortable indoor walking pace. 1.2 m/s is a real one. */
  readonly speedMps?: number;
  /** When true the path has zero duration and is applied as a cut. */
  readonly reducedMotion?: boolean;
  /** Face this world point on arrival instead of the direction of travel. */
  readonly lookAt?: Vec3;
  /** Rejects samples the constraint solver would not allow. */
  readonly validate?: (p: Vec3) => boolean;
  readonly minDurationS?: number;
  readonly maxDurationS?: number;
}

export interface CameraPath {
  readonly duration: number;
  readonly length: number;
  readonly instant: boolean;
  readonly nodes: readonly NavNode[];
  /** t in seconds, clamped to [0, duration]. */
  sample(t: number): CameraSample;
}

const DEFAULTS = {
  eyeHeight: 1.6,
  speedMps: 1.2,
  reducedMotion: false,
  minDurationS: 0.45,
  maxDurationS: 14,
} as const;

/** Resolution of the arc-length table. 24 samples per segment is smooth at 60fps. */
const SAMPLES_PER_SEGMENT = 24;

export function buildCameraPath(
  path: PathResult, startYaw: number, opts: CameraPathOptions = {},
): CameraPath {
  const o = { ...DEFAULTS, ...stripUndefined(opts) };
  const points = path.nodes.map((n): Vec3 => [n.position[0], n.position[1] + o.eyeHeight, n.position[2]]);

  if (points.length === 0) {
    const at: Vec3 = [0, o.eyeHeight, 0];
    return {
      duration: 0, length: 0, instant: true, nodes: path.nodes,
      sample: () => ({ position: at, yaw: startYaw, pitch: 0 }),
    };
  }
  if (points.length === 1) {
    const at = points[0]!;
    const yaw = o.lookAt ? yawTo(at, o.lookAt) : startYaw;
    const pitch = o.lookAt ? pitchTo(at, o.lookAt) : 0;
    return {
      duration: 0, length: 0, instant: true, nodes: path.nodes,
      sample: () => ({ position: at, yaw, pitch }),
    };
  }

  const table = buildArcTable(points, o.validate);
  const length = table.total;
  const duration = o.reducedMotion
    ? 0
    : clamp(length / Math.max(0.1, o.speedMps), o.minDurationS, o.maxDurationS);

  const endYaw = o.lookAt
    ? yawTo(points[points.length - 1]!, o.lookAt)
    : yawTo(points[points.length - 2]!, points[points.length - 1]!);
  const endPitch = o.lookAt ? pitchTo(points[points.length - 1]!, o.lookAt) : 0;

  const sample = (t: number): CameraSample => {
    if (duration <= 0) {
      return { position: table.at(1), yaw: endYaw, pitch: endPitch };
    }
    const raw = clamp(t / duration, 0, 1);
    const u = easeInOut(raw);
    const position = table.at(u);

    // Look where you are going, then settle onto the target over the last
    // quarter of the walk. Turning early reads as anticipation; turning at the
    // end reads as arrival. Both beat snapping.
    const ahead = table.at(Math.min(1, u + 0.02));
    const travelYaw = yawTo(position, ahead);
    const blend = raw <= 0.75 ? 0 : (raw - 0.75) / 0.25;
    const startBlend = raw >= 0.12 ? 1 : raw / 0.12;
    const yawFromStart = lerpAngle(startYaw, travelYaw, startBlend);
    return {
      position,
      yaw: lerpAngle(yawFromStart, endYaw, blend),
      pitch: endPitch * blend,
    };
  };

  return { duration, length, instant: duration <= 0, nodes: path.nodes, sample };
}

// ---------------------------------------------------------------------------
// Arc-length parameterisation
// ---------------------------------------------------------------------------

interface ArcTable {
  readonly total: number;
  /** u in [0,1] of total arc length. */
  at(u: number): Vec3;
}

function buildArcTable(points: readonly Vec3[], validate?: (p: Vec3) => boolean): ArcTable {
  const pts: Vec3[] = [];
  const cum: number[] = [];
  let total = 0;

  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(n - 1, i + 2)]!;
    for (let s = 0; s <= SAMPLES_PER_SEGMENT; s++) {
      // s === 0 of every segment but the first repeats the previous segment's
      // final sample, which would put a zero-length span in the arc table.
      if (i > 0 && s === 0) continue;
      const t = s / SAMPLES_PER_SEGMENT;
      let p = catmullRom(p0, p1, p2, p3, t);
      // The spline is advice. If it leaves the walkable world, take the
      // straight line between the two nav nodes instead.
      if (validate && !validate(p)) p = lerp3(p1, p2, t);
      const prev = pts[pts.length - 1];
      if (prev) total += dist3(prev, p);
      pts.push(p);
      cum.push(total);
    }
  }
  if (pts.length === 0) {
    const only = points[0]!;
    return { total: 0, at: () => only };
  }

  return {
    total,
    at(u: number): Vec3 {
      if (total <= 0) return pts[0]!;
      const target = clamp(u, 0, 1) * total;
      // Binary search the cumulative table; linear scan would be fine at these
      // sizes but this runs once per frame during a flight.
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! < target) lo = mid + 1; else hi = mid;
      }
      const i = Math.max(1, lo);
      const a = cum[i - 1]!;
      const b = cum[i]!;
      const f = b - a < 1e-9 ? 0 : (target - a) / (b - a);
      return lerp3(pts[i - 1]!, pts[i]!, f);
    },
  };
}

/** Centripetal Catmull-Rom (alpha = 0.5). */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  // Knot spacing. The floor keeps a duplicated endpoint (the clamped p0 == p1
  // at the start of a path) from dividing by zero; with p0 and p1 identical the
  // weights still sum to one, so the sample is exactly p1.
  const knot = (a: Vec3, b: Vec3): number => Math.max(Math.sqrt(dist3(a, b)), 1e-3);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const tt = t1 + (t2 - t1) * t;

  const a1 = mix(p0, p1, (t1 - tt) / (t1 - t0), (tt - t0) / (t1 - t0));
  const a2 = mix(p1, p2, (t2 - tt) / (t2 - t1), (tt - t1) / (t2 - t1));
  const a3 = mix(p2, p3, (t3 - tt) / (t3 - t2), (tt - t2) / (t3 - t2));
  const b1 = mix(a1, a2, (t2 - tt) / (t2 - t0), (tt - t0) / (t2 - t0));
  const b2 = mix(a2, a3, (t3 - tt) / (t3 - t1), (tt - t1) / (t3 - t1));
  return mix(b1, b2, (t2 - tt) / (t2 - t1), (tt - t1) / (t2 - t1));
}

function mix(a: Vec3, b: Vec3, wa: number, wb: number): Vec3 {
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function yawTo(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return Math.atan2(-dx, -dz);
}

export function pitchTo(from: Vec3, to: Vec3): number {
  const dy = to[1] - from[1];
  const flat = Math.hypot(to[0] - from[0], to[2] - from[2]);
  if (flat < 1e-6) return dy > 0 ? Math.PI / 2 : -Math.PI / 2;
  return Math.atan2(dy, flat);
}

/** Shortest-arc angular interpolation; never spins the long way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * clamp(t, 0, 1);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
