import type { Aabb, Opening, Quantity, Room, Vec2, WorldDocument } from '@m3xi/world-core';
import { isDefensible } from '@m3xi/spatial-engine';
import { formatExtent, formatQuantity } from '@m3xi/viewer/headless';
import { isHumanCorrected } from '../model/provenance.js';

/**
 * THE FLOORPLAN, AS DATA
 * ======================
 *
 * The SVG floorplan is the editor's primary pick surface, and this file is the
 * whole of the thinking behind it. `planView.ts` turns what is here into
 * elements and attaches listeners; it decides nothing.
 *
 * Why the plan and not the 3D view. Three reasons, in order of how much they
 * matter:
 *
 *   1. It works. The plan is arithmetic over polygons the document already
 *      carries. No WebGL context, no splat download, no GPU, no three.js. An
 *      operator on a locked-down agency laptop, on a train, or on a machine
 *      where the viewer will not start, can still correct the world -- and
 *      correcting the world is the thing that makes it publishable.
 *   2. It prints. The review of a property is a document someone signs off,
 *      and an SVG plan is the artefact that survives that conversation.
 *   3. It is how an operator thinks about a flat. "The bathroom door is on the
 *      wrong wall" is a plan-shaped observation. Finding that door in a
 *      first-person walkthrough is a navigation task before it is a review
 *      task, and the navigation is the part that wastes the afternoon.
 *
 * The 3D viewer is offered beside it, loaded on demand, for the cases the plan
 * genuinely cannot answer -- is that panel a mirror, is that ceiling really
 * that low. See `viewerBridge.ts`.
 *
 * COORDINATES. World is right-handed, +Y up, and a room footprint is an XZ
 * ring, so the plan is the XZ plane seen from above: SVG x is world x, SVG y
 * is world z, both in metres, and the viewBox is the property's own bounding
 * rectangle plus a margin. Nothing here scales to pixels, which is what keeps
 * the strokes below expressible as real widths -- a 0.1 m door leaf is 0.1 in
 * this coordinate system, and it stays 0.1 at any zoom.
 */

export type PlanTargetType = 'room' | 'opening' | 'entity' | 'region';

export interface PlanSelection {
  readonly type: PlanTargetType;
  readonly id: string;
}

export function sameSelection(a: PlanSelection | null, b: PlanSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.id === b.id;
}

export interface PlanRoomShape {
  readonly id: string;
  /** `points` for an SVG polygon, in metres. */
  readonly points: string;
  readonly label: string;
  /** The area line, or the sentence saying there is no defensible one. */
  readonly sub: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly ariaLabel: string;
  readonly corrected: boolean;
}

export interface PlanOpeningShape {
  readonly id: string;
  readonly x1: number; readonly y1: number;
  readonly x2: number; readonly y2: number;
  readonly window: boolean;
  readonly ariaLabel: string;
}

export interface PlanRectShape {
  readonly id: string;
  readonly x: number; readonly y: number;
  readonly width: number; readonly height: number;
  readonly ariaLabel: string;
}

export interface PlanModel {
  /** `minX minY width height`, in metres. */
  readonly viewBox: string;
  readonly rooms: readonly PlanRoomShape[];
  readonly openings: readonly PlanOpeningShape[];
  readonly entities: readonly PlanRectShape[];
  readonly regions: readonly PlanRectShape[];
  /** Every selectable object, in tab order: rooms, then openings, then objects. */
  readonly order: readonly PlanSelection[];
  /**
   * Set when the plan cannot be drawn at all, with the reason in it. The
   * editor shows this sentence instead of an empty rectangle: a blank plan and
   * a property with no outlines look identical, and only one of them is a bug.
   */
  readonly unavailable: string | null;
}

const MARGIN_M = 0.6;
/** A door with no recorded width still has to be clickable. */
const DEFAULT_OPENING_WIDTH_M = 0.8;

export function buildPlan(doc: WorldDocument): PlanModel {
  const rooms = doc.rooms.filter((r) => r.polygon.length >= 3);
  if (rooms.length === 0) {
    return {
      viewBox: '0 0 1 1',
      rooms: [], openings: [], entities: [], regions: [], order: [],
      unavailable: doc.rooms.length === 0
        ? 'This world has no rooms, so there is no plan to draw. Nothing here can be corrected until the build produces rooms.'
        : `None of the ${doc.rooms.length} rooms in this world has an outline of three or more points, so no floor can be drawn. `
          + 'That is a reconstruction failure, not an empty property.',
    };
  }

  const bounds = boundsOf(rooms, doc);
  const viewBox = `${round(bounds.minX - MARGIN_M)} ${round(bounds.minZ - MARGIN_M)} `
    + `${round(bounds.maxX - bounds.minX + MARGIN_M * 2)} ${round(bounds.maxZ - bounds.minZ + MARGIN_M * 2)}`;

  const tolMm = doc.measurementPolicy.wallToleranceMm;
  const planRooms = rooms.map((r) => roomShape(r, doc));
  const planOpenings = doc.openings.map((o) => openingShape(o, doc));
  const planEntities = doc.entities.map((e) => entityShape(e, tolMm));
  const planRegions = doc.regions.map(regionShape);

  const order: PlanSelection[] = [
    ...planRooms.map((r): PlanSelection => ({ type: 'room', id: r.id })),
    ...planOpenings.map((o): PlanSelection => ({ type: 'opening', id: o.id })),
    ...planEntities.map((e): PlanSelection => ({ type: 'entity', id: e.id })),
  ];

  return {
    viewBox,
    rooms: planRooms,
    openings: planOpenings,
    entities: planEntities,
    regions: planRegions,
    order,
    unavailable: null,
  };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function roomShape(room: Room, doc: WorldDocument): PlanRoomShape {
  const points = room.polygon.map((p) => `${round(p[0])},${round(p[1])}`).join(' ');
  const centre = ringCentroid(room.polygon);
  const label = room.name ?? room.id;
  const area = areaLine(room.area);
  const corrected = isHumanCorrected(room.grounding);

  // The accessible name carries everything the sighted operator reads off the
  // shape: what it is, how big, to what standard, and whether that figure is
  // defensible. A label of just the room name would make the plan usable for
  // picking and useless for reviewing, which is the actual job.
  const ariaLabel = [
    `${label}, ${room.kind}`,
    area,
    `${quantityPhrase(ceilingHeight(room, doc))} floor to ceiling`,
    corrected ? 'already corrected by an operator' : null,
  ].filter(Boolean).join('. ');

  return {
    id: room.id,
    points,
    label,
    sub: area,
    labelX: round(centre[0]),
    labelY: round(centre[1]),
    ariaLabel,
    corrected,
  };
}

/**
 * An opening is drawn as a segment across the wall it sits in: its centre, its
 * recorded width, and its normal rotated a quarter turn. A window is dashed
 * and a door is solid, and both carry the word in the accessible name, because
 * a dash is not a distinction a colour-blind or low-vision operator can rely
 * on and a dash is not a distinction at all on a printed A4 plan.
 */
function openingShape(o: Opening, doc: WorldDocument): PlanOpeningShape {
  const width = o.width?.value && o.width.value > 0 ? o.width.value : DEFAULT_OPENING_WIDTH_M;
  const half = width / 2;
  // Along-wall direction: the normal turned 90 degrees in the XZ plane.
  const nx = o.normal ? o.normal[0] : 1;
  const nz = o.normal ? o.normal[2] : 0;
  const len = Math.hypot(nx, nz);
  const ax = len > 1e-6 ? -nz / len : 1;
  const az = len > 1e-6 ? nx / len : 0;

  const rooms = [o.roomA, o.roomB].filter((id): id is string => !!id)
    .map((id) => doc.rooms.find((r) => r.id === id)?.name ?? id);
  const between = rooms.length === 2
    ? `between ${rooms[0]} and ${rooms[1]}`
    : rooms.length === 1 ? `off ${rooms[0]}` : 'connecting nothing';

  return {
    id: o.id,
    x1: round(o.centre[0] - ax * half),
    y1: round(o.centre[2] - az * half),
    x2: round(o.centre[0] + ax * half),
    y2: round(o.centre[2] + az * half),
    window: o.kind === 'window' || o.kind === 'rooflight',
    ariaLabel: `${o.kind} ${between}, ${o.width ? quantityPhrase(o.width) : 'width not recorded'}`,
  };
}

function entityShape(
  e: { id: string; label: string; aabb: Aabb; roomId?: string }, tolMm: number,
): PlanRectShape {
  const { min, max } = e.aabb;
  return {
    id: e.id,
    x: round(min[0]),
    y: round(min[2]),
    width: round(Math.max(max[0] - min[0], 0.05)),
    height: round(Math.max(max[2] - min[2], 0.05)),
    // `formatExtent` is the viewer's own room-dimension formatter, so the
    // tolerance travels with the pair of figures rather than being dropped
    // because this is "only" a bounding box on a plan.
    ariaLabel: `${e.label}, ${formatExtent(max[0] - min[0], max[2] - min[2], tolMm)} in plan`,
  };
}

function regionShape(r: { id: string; volume: Aabb; provenance: string; reason?: string }): PlanRectShape {
  const { min, max } = r.volume;
  return {
    id: r.id,
    x: round(min[0]),
    y: round(min[2]),
    width: round(Math.max(max[0] - min[0], 0.05)),
    height: round(Math.max(max[2] - min[2], 0.05)),
    ariaLabel: r.provenance === 'generated'
      ? `Not surveyed: ${r.reason ?? 'no camera looked here'}`
      : `Uncertain: ${r.reason ?? 'the reconstruction is not confident here'}`,
  };
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * A room's area line, or the sentence that replaces it.
 *
 * `formatQuantity` refuses to produce a bare number, and an area the engine
 * marks not-defensible comes back as INDICATIVE rather than being dropped.
 * Dropping it is the failure this product exists to avoid: a customer then
 * cannot tell "we did not measure it" from "it is not there".
 */
export function areaLine(q: Quantity | undefined): string {
  if (!q) return 'No declared area. This room cannot be published until it has one.';
  const f = formatQuantity(q);
  return f.status === 'indicative' ? `${f.full} — INDICATIVE` : f.full;
}

export function quantityPhrase(q: Quantity): string {
  const f = formatQuantity(q);
  return f.status === 'indicative' ? `${f.speech}, indicative` : f.speech;
}

/**
 * A room's floor-to-ceiling height, as a quantity rather than as a bare
 * difference of two numbers.
 *
 * The contract stores a room as two planes, so there is no `Quantity` to read:
 * the height has to be built. What it is built from is not a choice -- it is
 * exactly what `wv-worlds` writes when this height is corrected: CLEAR-INTERNAL
 * face to face, the world's own wall tolerance, and the room's own grounding,
 * because the height is only as well known as the two planes it spans. Showing
 * "2.40 m" with none of that attached would be the bare number this system is
 * built to refuse, in the one place an operator is most likely to quote it.
 */
export function ceilingHeight(room: Room, doc: WorldDocument): Quantity {
  return {
    value: Math.max(room.ceilingZ - room.floorZ, 0),
    unit: 'm',
    standard: 'CLEAR-INTERNAL',
    tolerance: doc.measurementPolicy.wallToleranceMm,
    toleranceUnit: 'mm',
    grounding: room.grounding,
  };
}

/** True when the engine would refuse to state this figure as a measurement. */
export function indicative(q: Quantity | undefined): boolean {
  return !!q && !isDefensible(q);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number }

function boundsOf(rooms: readonly Room[], doc: WorldDocument): Bounds {
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  const see = (x: number, z: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (x < minX) minX = x;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (z > maxZ) maxZ = z;
  };
  for (const room of rooms) for (const p of room.polygon) see(p[0], p[1]);
  // Objects and openings are included so a sofa dragged outside every room --
  // exactly the mistake `validate.ts` reports as a blocker -- is visible on the
  // plan rather than cropped out of it by the very outline it escaped.
  for (const e of doc.entities) { see(e.aabb.min[0], e.aabb.min[2]); see(e.aabb.max[0], e.aabb.max[2]); }
  for (const o of doc.openings) see(o.centre[0], o.centre[2]);
  if (!Number.isFinite(minX)) return { minX: 0, minZ: 0, maxX: 1, maxZ: 1 };
  return { minX, minZ, maxX, maxZ };
}

/**
 * Area centroid of a ring, so a label sits inside an L-shaped room instead of
 * in the notch. Falls back to the vertex mean for a degenerate ring, which is
 * wrong but bounded, and a degenerate ring is reported as a blocker anyway.
 */
export function ringCentroid(ring: readonly Vec2[]): Vec2 {
  let a = 0; let cx = 0; let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[j]!;
    const q = ring[i]!;
    const cross = p[0] * q[1] - q[0] * p[1];
    a += cross;
    cx += (p[0] + q[0]) * cross;
    cz += (p[1] + q[1]) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const n = Math.max(ring.length, 1);
    return [
      ring.reduce((s, p) => s + p[0], 0) / n,
      ring.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [cx / (6 * a), cz / (6 * a)];
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
