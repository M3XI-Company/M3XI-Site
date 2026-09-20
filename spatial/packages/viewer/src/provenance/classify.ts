import type { Entity, Provenance, Region, Room, Vec3 } from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';
import type { World } from '@m3xi/spatial-engine';

/**
 * PROVENANCE, MADE VISIBLE
 * ========================
 *
 * The design brief: regions the cameras never saw, and any generated geometry,
 * must be distinguishable in the view. The question is how, for an estate
 * agent, without making an honest world look like a broken one.
 *
 * What this does NOT do, and why:
 *
 *   - No red, no amber, no warning triangles. A hazard palette tells a buyer
 *     "something is wrong with this property". Nothing is wrong with the
 *     property; the survey simply did not reach behind the wardrobe. Punishing
 *     honesty with alarm colours is how you teach operators to suppress it.
 *   - No modal warning on entry. Consent dialogs are dismissed unread and then
 *     the information is gone for the rest of the session.
 *   - Not hidden, not silently rendered as real. Both are misrepresentation.
 *
 * What it does instead is borrow a convention the audience already reads
 * fluently: SURVEYOR'S HATCHING. On a measured building survey, an area the
 * surveyor did not enter is hatched and noted, not coloured. So:
 *
 *   observed / reconstructed -> rendered plainly. This is the property.
 *   inferred                 -> fine diagonal hatch, low contrast, in the
 *                               foreground ink colour of the current theme.
 *   generated                -> the same hatch at twice the weight, plus a
 *                               hairline boundary where it meets real geometry,
 *                               and the volume is not walkable.
 *
 * The hatch is a screen-space pattern, not a hue, so it survives colour
 * blindness, greyscale printing and both themes. It is reinforced in three
 * other places so it is never the only signal: the inspect readout names it in
 * words, every measurement that touches it is marked indicative, and the
 * written tour has a "What we could not see" section per room.
 *
 * `DisplayClass` is the whole vocabulary. Four contract provenances map onto
 * three treatments, because 'observed' and 'reconstructed' are both "this is
 * the building" as far as a viewer is concerned -- the difference between a
 * photographed wall and a wall fitted to photographs is a pipeline distinction,
 * not a customer-facing one, and the measurement layer already carries it.
 */
export type DisplayClass = 'real' | 'estimated' | 'unsurveyed';

export const DISPLAY_CLASS_OF: Readonly<Record<Provenance, DisplayClass>> = {
  observed: 'real',
  reconstructed: 'real',
  inferred: 'estimated',
  generated: 'unsurveyed',
};

export interface DisplayClassStyle {
  /** Hatch line spacing in device-independent pixels. 0 means no hatch. */
  readonly hatchPitch: number;
  /** Hatch opacity, 0..1, against the theme's ink colour. */
  readonly hatchAlpha: number;
  /** Whether to draw a hairline where this class meets another. */
  readonly boundary: boolean;
  /** Short label, used in the legend and the inspect readout. */
  readonly label: string;
  /** One sentence, used in tooltips, the legend and the written tour. */
  readonly description: string;
}

export const DISPLAY_STYLE: Readonly<Record<DisplayClass, DisplayClassStyle>> = {
  real: {
    hatchPitch: 0,
    hatchAlpha: 0,
    boundary: false,
    label: 'Surveyed',
    description: 'Photographed during the capture, or measured directly from those photographs.',
  },
  estimated: {
    hatchPitch: 9,
    hatchAlpha: 0.2,
    boundary: false,
    label: 'Estimated',
    description: 'Not fully visible during the capture. Its shape and position were estimated, so treat any measurement here as indicative.',
  },
  unsurveyed: {
    hatchPitch: 6,
    hatchAlpha: 0.42,
    boundary: true,
    label: 'Not surveyed',
    description: 'No camera saw this. What you see here was filled in by a model and is not evidence of anything. You cannot walk into it and we will not measure across it.',
  },
};

export interface RegionNote {
  readonly id: string;
  readonly provenance: Provenance;
  readonly reason: string;
  readonly roomId?: string;
  readonly confidence?: number;
  readonly volume: Region['volume'];
}

export interface PointProvenance {
  readonly provenance: Provenance;
  readonly display: DisplayClass;
  readonly observed: boolean;
  readonly roomId?: string;
  /** Non-observed regions containing the point, worst first. */
  readonly regions: readonly RegionNote[];
  /** Short sentence for the live region and the inspect readout. */
  readonly headline: string;
}

/**
 * Classify the point the camera is standing at, or the point under a cursor.
 * This is the function the inspect readout and the "you are here" announcement
 * both run through, so the 3D view and the screen reader never disagree.
 */
export function classifyPoint(world: World, p: Vec3): PointProvenance {
  const provenance = world.provenanceAt(p);
  const observed = world.isObserved(p);
  const room = world.roomAt(p);
  const regions = regionsAt(world, p);
  const display = DISPLAY_CLASS_OF[provenance];

  return {
    provenance,
    display,
    observed,
    ...(room ? { roomId: room.id } : {}),
    regions,
    headline: headlineFor(display, room, regions),
  };
}

/**
 * Classify a viewpoint: where the camera is AND what it can see from there.
 * A camera standing in a fully observed hall looking through a doorway at a
 * generated corner is not in an honest position just because its feet are.
 */
export interface ViewpointProvenance extends PointProvenance {
  /** Worst display class anywhere in the current view. */
  readonly worstVisible: DisplayClass;
  /** Rooms in view whose own geometry is not fully surveyed. */
  readonly unsurveyedInView: readonly RegionNote[];
  /** True when the view contains geometry no camera observed. */
  readonly showsUnsurveyed: boolean;
}

export function classifyViewpoint(
  world: World,
  pose: { position: Vec3; orientation: readonly [number, number, number, number]; fov?: number },
  opts: { maxDistance?: number } = {},
): ViewpointProvenance {
  const here = classifyPoint(world, pose.position);
  const visible = world.visibleFrom(
    { position: pose.position, orientation: pose.orientation, ...(pose.fov ? { fov: pose.fov } : {}) },
    { maxDistance: opts.maxDistance ?? 25 },
  );

  let worst: Provenance = here.provenance;
  for (const r of visible.rooms) worst = weakestProvenance(worst, r.grounding.provenance);
  for (const e of visible.entities) worst = weakestProvenance(worst, e.grounding.provenance);

  // A region counts as "in view" when its volume overlaps a visible room, or
  // when the camera is standing in it. Frustum-testing every region would be
  // more exact and would also make the readout flicker on every head turn.
  const visibleRoomIds = new Set(visible.rooms.map((r) => r.id));
  const inView: RegionNote[] = [];
  for (const region of world.doc.regions) {
    if (region.provenance === 'observed') continue;
    const touches = region.roomId !== undefined && visibleRoomIds.has(region.roomId);
    if (!touches && !here.regions.some((r) => r.id === region.id)) continue;
    worst = weakestProvenance(worst, region.provenance);
    inView.push(toNote(region));
  }
  inView.sort((a, b) => rank(b.provenance) - rank(a.provenance));

  const worstVisible = DISPLAY_CLASS_OF[worst];
  return {
    ...here,
    worstVisible,
    unsurveyedInView: inView,
    showsUnsurveyed: inView.some((r) => r.provenance === 'generated'),
  };
}

export function classifyEntity(entity: Entity): {
  display: DisplayClass; provenance: Provenance; note: string;
} {
  const display = DISPLAY_CLASS_OF[entity.grounding.provenance];
  const attrNote = typeof entity.attributes?.['note'] === 'string'
    ? ` ${entity.attributes['note'] as string}.`
    : '';
  const note = display === 'real'
    ? `Seen in ${entity.observedIn.length} ${entity.observedIn.length === 1 ? 'frame' : 'frames'}.`
    : `${DISPLAY_STYLE[display].label}.${attrNote}`;
  return { display, provenance: entity.grounding.provenance, note };
}

export function classifyRoom(world: World, roomId: string): {
  display: DisplayClass; provenance: Provenance; regions: readonly RegionNote[];
} {
  const room = world.room(roomId);
  const regions = world.doc.regions
    .filter((r) => r.provenance !== 'observed' && r.roomId === roomId)
    .map(toNote);
  let worst: Provenance = room?.grounding.provenance ?? 'generated';
  for (const r of regions) worst = weakestProvenance(worst, r.provenance);
  return { display: DISPLAY_CLASS_OF[worst], provenance: worst, regions };
}

export interface CoverageSummary {
  /** 0..1, from the pipeline's own quality check when it published one. */
  readonly observedFraction?: number;
  readonly unsurveyedRegions: readonly RegionNote[];
  readonly estimatedRegions: readonly RegionNote[];
  readonly roomsWithGaps: readonly string[];
  /** One sentence for the coverage chip. Always safe to display. */
  readonly headline: string;
  readonly qualityVerdict: 'pass' | 'review' | 'fail';
}

/**
 * The corner chip's content. It states coverage as a fact with a number when
 * the pipeline measured one, and without a number when it did not -- rather
 * than inventing a percentage, which would be the exact failure this feature
 * exists to prevent.
 */
export function coverageSummary(world: World): CoverageSummary {
  const doc = world.doc;
  const unobservedCheck = doc.quality.checks.find((c) => c.name === 'unobserved_volume_fraction');
  const observedFraction = unobservedCheck && Number.isFinite(unobservedCheck.value)
    ? 1 - unobservedCheck.value
    : undefined;

  const unsurveyed = doc.regions.filter((r) => r.provenance === 'generated').map(toNote);
  const estimated = doc.regions.filter((r) => r.provenance === 'inferred').map(toNote);
  const roomsWithGaps = [...new Set(
    [...unsurveyed, ...estimated].map((r) => r.roomId).filter((id): id is string => !!id),
  )];

  const pct = observedFraction !== undefined
    ? `${Math.round(observedFraction * 100)}% of this property was photographed`
    : 'Parts of this property were not photographed';
  const tail = unsurveyed.length === 0
    ? 'Everything you can walk to was seen by a camera.'
    : `${unsurveyed.length} ${unsurveyed.length === 1 ? 'area was' : 'areas were'} not, and ${unsurveyed.length === 1 ? 'it is' : 'they are'} marked.`;

  return {
    ...(observedFraction !== undefined ? { observedFraction } : {}),
    unsurveyedRegions: unsurveyed,
    estimatedRegions: estimated,
    roomsWithGaps,
    headline: `${pct}. ${tail}`,
    qualityVerdict: doc.quality.verdict,
  };
}

// ---------------------------------------------------------------------------

function regionsAt(world: World, p: Vec3): RegionNote[] {
  const out: RegionNote[] = [];
  for (const r of world.doc.regions) {
    if (r.provenance === 'observed') continue;
    const v = r.volume;
    if (p[0] < v.min[0] || p[0] > v.max[0]) continue;
    if (p[1] < v.min[1] || p[1] > v.max[1]) continue;
    if (p[2] < v.min[2] || p[2] > v.max[2]) continue;
    out.push(toNote(r));
  }
  out.sort((a, b) => rank(b.provenance) - rank(a.provenance));
  return out;
}

function toNote(r: Region): RegionNote {
  return {
    id: r.id,
    provenance: r.provenance,
    reason: r.reason ?? 'no reason recorded',
    volume: r.volume,
    ...(r.roomId ? { roomId: r.roomId } : {}),
    ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
  };
}

function rank(p: Provenance): number {
  return p === 'generated' ? 3 : p === 'inferred' ? 2 : p === 'reconstructed' ? 1 : 0;
}

function headlineFor(
  display: DisplayClass, room: Room | undefined, regions: readonly RegionNote[],
): string {
  const where = room?.name ?? room?.id;
  if (display === 'real') {
    return where ? `${where}. Surveyed.` : 'Surveyed.';
  }
  const worst = regions[0];
  const reason = worst ? ` ${capitalise(worst.reason)}.` : '';
  const label = DISPLAY_STYLE[display].label.toLowerCase();
  return where ? `${where}. ${capitalise(label)}.${reason}` : `${capitalise(label)}.${reason}`;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
