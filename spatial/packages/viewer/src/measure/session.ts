import type { Quantity, Vec3 } from '@m3xi/world-core';
import { math, type Target, type World } from '@m3xi/spatial-engine';
import type { MeasurementOverlay } from '../types.js';
import { formatQuantity, type FormatOptions, type FormattedQuantity } from './format.js';

const { add, scale } = math;

export type MeasureTool = 'distance' | 'area' | 'clearance' | 'fit';

/** What the user is trying to fit. Sizes are width x height x depth, metres. */
export interface FitSpec {
  readonly label: string;
  readonly size: Vec3;
  /** Walking space to leave around it. */
  readonly clearance?: number;
  readonly againstWall?: boolean;
}

export const COMMON_FITS: readonly FitSpec[] = [
  { label: 'Double bed (1.35 × 1.90 m)', size: [1.35, 0.6, 1.9], clearance: 0.45 },
  { label: 'King bed (1.50 × 2.00 m)', size: [1.5, 0.6, 2.0], clearance: 0.45 },
  { label: 'Wardrobe, 2 m wide', size: [2.0, 2.0, 0.6], clearance: 0.6, againstWall: true },
  { label: 'Three-seat sofa (2.20 m)', size: [2.2, 0.85, 0.95], clearance: 0.4 },
  { label: 'Dining table, six seats', size: [1.8, 0.75, 0.9], clearance: 0.75 },
  { label: 'Washing machine', size: [0.6, 0.85, 0.6], clearance: 0.1, againstWall: true },
];

export interface MeasurementResult {
  readonly id: string;
  readonly tool: MeasureTool;
  readonly overlay: MeasurementOverlay;
  /** The headline quantity. Always present except for a failed fit test. */
  readonly primary?: FormattedQuantity;
  readonly supporting: readonly { readonly label: string; readonly value: FormattedQuantity }[];
  /** One line, already carrying standard and tolerance. */
  readonly headline: string;
  /** A sentence a person can read out. */
  readonly detail: string;
  readonly quantity?: Quantity;
  readonly fits?: boolean;
  readonly fitReason?: string;
}

export interface SessionState {
  readonly tool: MeasureTool;
  readonly points: readonly Vec3[];
  readonly prompt: string;
  readonly fit: FitSpec;
  readonly result?: MeasurementResult;
}

let counter = 0;
const nextId = (): string => `m${++counter}`;

/**
 * The measuring tape, as a state machine with no DOM in it.
 *
 * Each tool collects the points it needs and then asks the spatial engine for
 * a `Quantity`. Nothing here computes a length itself -- if the viewer did its
 * own arithmetic the number would arrive without a tolerance or a grounding,
 * and the whole measurement-honesty chain would have a hole in it exactly
 * where the customer is looking.
 */
export class MeasurementSession {
  private tool: MeasureTool = 'distance';
  private points: Vec3[] = [];
  private fit: FitSpec = COMMON_FITS[2]!;
  private result: MeasurementResult | undefined;

  constructor(private readonly world: World, private readonly fmt: FormatOptions = {}) {}

  get state(): SessionState {
    return {
      tool: this.tool,
      points: [...this.points],
      prompt: this.prompt(),
      fit: this.fit,
      ...(this.result ? { result: this.result } : {}),
    };
  }

  setTool(tool: MeasureTool): SessionState {
    if (tool !== this.tool) { this.tool = tool; this.points = []; this.result = undefined; }
    return this.state;
  }

  setFit(fit: FitSpec): SessionState {
    this.fit = fit;
    if (this.tool === 'fit' && this.points.length > 0) this.evaluate();
    return this.state;
  }

  reset(): SessionState {
    this.points = [];
    this.result = undefined;
    return this.state;
  }

  undo(): SessionState {
    this.points.pop();
    this.result = undefined;
    return this.state;
  }

  /** Feed a world point: a click on the proxy, or the camera's own crosshair. */
  addPoint(p: Vec3, target?: Target): SessionState {
    this.points.push(p);
    if (this.tool === 'distance' && this.points.length > 2) this.points = [p];
    if (this.tool !== 'distance' && this.points.length > 1) this.points = [p];
    this.result = undefined;
    this.evaluate(target);
    return this.state;
  }

  private prompt(): string {
    switch (this.tool) {
      case 'distance':
        return this.points.length === 0
          ? 'Pick the first point.'
          : this.points.length === 1 ? 'Pick the second point.' : 'Pick a point to start again.';
      case 'area':
        return 'Pick a point inside the room you want measured.';
      case 'clearance':
        return 'Pick a point to measure the free space around it.';
      case 'fit':
        return `Pick a point in the room you want to fit the ${this.fit.label.toLowerCase()} into.`;
    }
  }

  private evaluate(target?: Target): void {
    switch (this.tool) {
      case 'distance': return this.evaluateDistance(target);
      case 'area': return this.evaluateArea();
      case 'clearance': return this.evaluateClearance();
      case 'fit': return this.evaluateFit();
    }
  }

  private evaluateDistance(target?: Target): void {
    if (this.points.length < 2) return;
    const a = this.points[0]!;
    const b = this.points[1]!;
    const q = this.world.measureDistance(a, target ?? b);
    const f = formatQuantity(q, this.fmt);
    const mid = scale(add(a, b), 0.5);
    const gap = typeof q.basis?.['gapM'] === 'number' ? (q.basis['gapM'] as number) : undefined;
    this.result = {
      id: nextId(),
      tool: 'distance',
      quantity: q,
      primary: f,
      supporting: [],
      headline: f.full,
      detail: gap === undefined
        ? `Straight-line distance, ${f.value} ${f.tolerance}, ${f.standard}.`
        : `Straight-line distance, ${f.value} ${f.tolerance}, ${f.standard}. The nearest faces are ${gap.toFixed(2)} m apart.`,
      overlay: {
        id: nextId(),
        kind: 'distance',
        lines: [[a, b]],
        polygons: [],
        footprints: [],
        labels: [{ at: mid, text: f.value, detail: `${f.tolerance} · ${f.standardShort}`, status: f.status }],
      },
    };
  }

  private evaluateArea(): void {
    const p = this.points[0];
    if (!p) return;
    const room = this.world.roomAt(p);
    if (!room) {
      this.result = {
        id: nextId(), tool: 'area', supporting: [],
        headline: 'No room here',
        detail: 'That point is not inside a room the survey covers, so there is no floor area to report.',
        overlay: { id: nextId(), kind: 'area', lines: [], polygons: [], labels: [], footprints: [] },
      };
      return;
    }
    const q = this.world.measureArea(room.id);
    const f = formatQuantity(q, this.fmt);
    const ring = room.polygon.map((v): Vec3 => [v[0], room.floorZ + 0.01, v[1]]);
    const centre = ringCentre(ring);
    const height = this.world.measureDistance(
      [centre[0], room.floorZ, centre[2]], [centre[0], room.ceilingZ, centre[2]],
    );
    const hf = formatQuantity(height, this.fmt);
    this.result = {
      id: nextId(),
      tool: 'area',
      quantity: q,
      primary: f,
      supporting: [{ label: 'Floor to ceiling', value: hf }],
      headline: f.full,
      detail: `${room.name ?? room.id}: ${f.value} ${f.tolerance}, measured to ${f.standard}. Floor to ceiling ${hf.value} ${hf.tolerance}.`,
      overlay: {
        id: nextId(),
        kind: 'area',
        lines: [[...ring, ring[0]!]],
        polygons: [ring],
        footprints: [],
        labels: [{
          at: [centre[0], room.floorZ + 0.02, centre[2]],
          text: f.value,
          detail: `${f.tolerance} · ${f.standardShort}`,
          status: f.status,
        }],
      },
    };
  }

  private evaluateClearance(): void {
    const p = this.points[0];
    if (!p) return;
    const q = this.world.measureClearance(p);
    const f = formatQuantity(q, this.fmt);
    const near = q.basis?.['nearestPoint'];
    const line: Vec3[] = Array.isArray(near) && near.length === 3
      ? [p, [near[0] as number, near[1] as number, near[2] as number]]
      : [];
    const blockedBy = q.basis?.['insideEntityId'];
    this.result = {
      id: nextId(),
      tool: 'clearance',
      quantity: q,
      primary: f,
      supporting: [],
      headline: f.full,
      detail: typeof blockedBy === 'string'
        ? `That point is inside the ${labelOf(this.world, blockedBy)}, so there is no clearance to report.`
        : `Nothing comes closer than ${f.value} ${f.tolerance} to this point, ${f.standard}.`,
      overlay: {
        id: nextId(),
        kind: 'clearance',
        lines: line.length === 2 ? [line] : [],
        polygons: [circleAt(p, q.value)],
        footprints: [],
        labels: [{ at: p, text: f.value, detail: `${f.tolerance} · ${f.standardShort}`, status: f.status }],
      },
    };
  }

  private evaluateFit(): void {
    const p = this.points[0];
    if (!p) return;
    const room = this.world.roomAt(p);
    if (!room) {
      this.result = {
        id: nextId(), tool: 'fit', supporting: [], fits: false,
        fitReason: 'that point is not inside a surveyed room',
        headline: `${this.fit.label}: cannot test here`,
        detail: 'Pick a point inside a room.',
        overlay: { id: nextId(), kind: 'fit', lines: [], polygons: [], labels: [], footprints: [] },
      };
      return;
    }
    const res = this.world.fitTest(room.id, this.fit.size, {
      ...(this.fit.clearance !== undefined ? { clearance: this.fit.clearance } : {}),
      ...(this.fit.againstWall !== undefined ? { againstWall: this.fit.againstWall } : {}),
    });
    const height = this.world.measureDistance(
      [p[0], room.floorZ, p[2]], [p[0], room.ceilingZ, p[2]],
    );
    const hf = formatQuantity(height, this.fmt);
    const area = formatQuantity(this.world.measureArea(room.id), this.fmt);

    const footprints = res.placements.map((obb) => ({
      corners: obbFloorCorners(obb, room.floorZ + 0.012),
      ok: true,
    }));

    const name = this.fit.label;
    const roomName = room.name ?? room.id;
    const headline = res.fits
      ? `${name} fits in ${roomName}`
      : `${name} does not fit in ${roomName}`;
    const clearanceNote = this.fit.clearance
      ? ` This allows ${this.fit.clearance.toFixed(2)} m of walking space around it.`
      : '';
    const detail = res.fits
      ? `${name} fits in ${roomName}${footprints.length > 1 ? `, in ${footprints.length} tested positions` : ''}.${clearanceNote} Room area ${area.value} ${area.tolerance}, ${area.standard}.`
      : `${name} does not fit in ${roomName}: ${res.reason ?? 'no valid placement found'}.`;

    this.result = {
      id: nextId(),
      tool: 'fit',
      supporting: [
        { label: 'Room area', value: area },
        { label: 'Floor to ceiling', value: hf },
      ],
      fits: res.fits,
      ...(res.reason ? { fitReason: res.reason } : {}),
      headline,
      detail,
      overlay: {
        id: nextId(),
        kind: 'fit',
        lines: [],
        polygons: [],
        footprints: footprints.length > 0
          ? footprints
          : [{ corners: axisFootprint(p, this.fit.size, room.floorZ + 0.012), ok: false }],
        labels: [{
          at: footprints[0] ? centreOf(footprints[0].corners) : p,
          text: res.fits ? 'Fits' : 'Does not fit',
          detail: res.fits ? `${name} · ${area.standardShort}` : res.reason ?? '',
          status: area.status,
        }],
      },
    };
  }
}

// ---------------------------------------------------------------------------

function labelOf(world: World, entityId: string): string {
  return world.entity(entityId)?.label ?? entityId;
}

function ringCentre(ring: readonly Vec3[]): Vec3 {
  if (ring.length === 0) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const p of ring) { x += p[0]; y += p[1]; z += p[2]; }
  return [x / ring.length, y / ring.length, z / ring.length];
}

function centreOf(corners: readonly Vec3[]): Vec3 {
  return ringCentre(corners);
}

/** A 24-gon at floor level, used to draw the clearance sphere's footprint. */
function circleAt(p: Vec3, r: number): Vec3[] {
  const out: Vec3[] = [];
  const radius = Math.min(r, 6);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    out.push([p[0] + Math.cos(a) * radius, p[1], p[2] + Math.sin(a) * radius]);
  }
  return out;
}

function obbFloorCorners(
  obb: { centre: Vec3; half: Vec3; quat: readonly number[] }, y: number,
): [Vec3, Vec3, Vec3, Vec3] {
  // Yaw-only boxes come out of fitTest, so the floor rectangle is the box's
  // XZ half-extents rotated about +Y. Recovering yaw from the quaternion keeps
  // this independent of how the engine chose to build it.
  const q = obb.quat;
  const yaw = Math.atan2(
    2 * ((q[3] ?? 1) * (q[1] ?? 0) + (q[0] ?? 0) * (q[2] ?? 0)),
    1 - 2 * ((q[1] ?? 0) ** 2 + (q[0] ?? 0) ** 2),
  );
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hx = obb.half[0];
  const hz = obb.half[2];
  const at = (sx: number, sz: number): Vec3 => [
    obb.centre[0] + c * (hx * sx) + s * (hz * sz),
    y,
    obb.centre[2] - s * (hx * sx) + c * (hz * sz),
  ];
  return [at(1, 1), at(1, -1), at(-1, -1), at(-1, 1)];
}

function axisFootprint(p: Vec3, size: Vec3, y: number): [Vec3, Vec3, Vec3, Vec3] {
  const hx = size[0] / 2;
  const hz = size[2] / 2;
  return [
    [p[0] + hx, y, p[2] + hz], [p[0] + hx, y, p[2] - hz],
    [p[0] - hx, y, p[2] - hz], [p[0] - hx, y, p[2] + hz],
  ];
}
