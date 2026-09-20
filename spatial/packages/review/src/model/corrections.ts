import type {
  Aabb, Entity, MeasurementStandard, OpeningKind, RoomKind, Vec3,
} from '@m3xi/world-core';

/**
 * WHAT A CORRECTION IS
 * ====================
 *
 * A correction is a typed, reviewable proposal to change one fact about the
 * world, made by a named person at a named time. It is not a mutation.
 *
 * That distinction is the whole design. The alternative -- letting an operator
 * edit fields in place and calling the result "the world" -- loses three
 * things this product cannot afford to lose:
 *
 *   1. WHO SAID SO. A published dimension is a representation to a consumer.
 *      Under the DMCC Act 2024 regime an agency may have to show where a
 *      number came from. "The operator changed it" is not an answer; "Sam
 *      Okonjo replaced the reconstructed 3.10 m with a 3.08 m laser reading on
 *      12 March, and here is the geometry both were computed from" is.
 *   2. REVIEWABILITY BEFORE COMMIT. A list can be read, argued with, and
 *      partially undone. Scattered mutations cannot.
 *   3. THE ABILITY TO REPLAY. Because every record is data and `applyToDocument`
 *      is pure, the corrected world is a function of (base world, record list).
 *      Undo is dropping a record and recomputing, not an inverse operation that
 *      has to be written correctly for every field.
 *
 * Correction records are also the only place a *human* assertion is allowed to
 * enter the world. Everything else in the contract came from a camera, a
 * reconstruction or a model. See `provenance.ts` for how that is represented
 * without lying about it.
 */

// ---------------------------------------------------------------------------
// The change payloads
// ---------------------------------------------------------------------------

/**
 * How an operator came by a number they typed in.
 *
 * `estimate` is someone reading a plan or eyeballing the view. `site-measure`
 * is someone standing in the room with an instrument. They are not the same
 * claim and they must not carry the same tolerance, so the difference is in
 * the type rather than in a free-text note nobody parses.
 */
export type DimensionMethod = 'estimate' | 'site-measure';

/**
 * Instruments an operator can declare, with the half-width each one supports.
 *
 * These are the manufacturers' stated accuracies for the common tools, not a
 * measured field result, and they are deliberately the pessimistic end:
 *   - a consumer laser distance meter is typically +/-1.5 mm to +/-3 mm;
 *   - a steel tape over a room-sized run, read by one person, is a few mm but
 *     10 mm is what survives a disputed reading;
 *   - `unknown` gets no credit at all and falls back to the document policy.
 *
 * A surveyor retuning these touches one table, and the certificate prints the
 * instrument beside the number, so the claim is inspectable rather than
 * implied.
 */
export type Instrument = 'laser' | 'tape' | 'unknown';

export const INSTRUMENT_TOLERANCE_MM: Readonly<Record<Instrument, number | null>> = {
  laser: 3,
  tape: 10,
  unknown: null,
};

/** Which measurable field on which object a dimension correction targets. */
export type DimensionTarget =
  | { readonly kind: 'room.area'; readonly roomId: string }
  | { readonly kind: 'room.ceilingHeight'; readonly roomId: string }
  | { readonly kind: 'opening.width'; readonly openingId: string }
  | { readonly kind: 'opening.height'; readonly openingId: string }
  | { readonly kind: 'opening.sill'; readonly openingId: string };

export type CorrectionChange =
  // --- semantics -----------------------------------------------------------
  | { readonly kind: 'room.rename'; readonly roomId: string; readonly name: string }
  | { readonly kind: 'room.kind'; readonly roomId: string; readonly roomKind: RoomKind }
  | { readonly kind: 'room.delete'; readonly roomId: string }
  | { readonly kind: 'entity.label'; readonly entityId: string; readonly label: string }
  | { readonly kind: 'entity.category'; readonly entityId: string; readonly category: Entity['category'] }
  | { readonly kind: 'entity.room'; readonly entityId: string; readonly roomId: string | null }
  // --- geometry ------------------------------------------------------------
  | { readonly kind: 'entity.move'; readonly entityId: string; readonly centroid: Vec3 }
  | { readonly kind: 'entity.resize'; readonly entityId: string; readonly size: Vec3 }
  | { readonly kind: 'entity.delete'; readonly entityId: string }
  // --- measurement ---------------------------------------------------------
  | {
      readonly kind: 'dimension.set';
      readonly target: DimensionTarget;
      /** Metres, or square metres for an area. Always SI, always positive. */
      readonly value: number;
      readonly method: DimensionMethod;
      readonly instrument: Instrument;
      /** Standard the operator is measuring to; defaults to the world policy. */
      readonly standard?: MeasurementStandard;
    }
  // --- the two known reconstruction failure modes --------------------------
  | {
      readonly kind: 'surface.flags';
      readonly surfaceId: string;
      readonly isReflective?: boolean;
      readonly isGlazed?: boolean;
    }
  // --- topology ------------------------------------------------------------
  | { readonly kind: 'opening.kind'; readonly openingId: string; readonly openingKind: OpeningKind }
  | {
      readonly kind: 'opening.connects';
      readonly openingId: string;
      readonly roomA: string | null;
      readonly roomB: string | null;
    }
  | { readonly kind: 'entrance.set'; readonly navNodeId: string }
  // --- survey coverage -----------------------------------------------------
  | {
      readonly kind: 'region.mark';
      /** 'inferred' is "we are not sure"; 'generated' is "nobody looked". */
      readonly provenance: 'inferred' | 'generated';
      readonly volume: Aabb;
      readonly reason: string;
      readonly roomId?: string;
    }
  | { readonly kind: 'region.clear'; readonly regionId: string }
  // --- sign-off ------------------------------------------------------------
  | { readonly kind: 'world.approve'; readonly note?: string };

export type CorrectionKind = CorrectionChange['kind'];

/**
 * A correction as it sits in the list: the change, plus the receipt.
 *
 * `by` is an operator identifier (a user id or an email), not a display name,
 * because the audit trail has to survive somebody changing their name.
 */
export interface CorrectionRecord {
  readonly id: string;
  /** ISO 8601, UTC. */
  readonly at: string;
  readonly by: string;
  readonly change: CorrectionChange;
  /** Free text from the operator. Shown in the list and in the audit payload. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Whether a correction changes what a thing *is called* or what it *is*.
 *
 * This drives the provenance rule (`provenance.ts`): renaming a room does not
 * change how its polygon was derived, so the room's geometric provenance must
 * not move. Dragging a sofa two metres does change geometry, and pretending
 * otherwise would launder a hand placement into a reconstructed one.
 */
export type CorrectionClass = 'semantic' | 'geometric' | 'measurement' | 'coverage' | 'signoff';

const CLASS_OF: Readonly<Record<CorrectionKind, CorrectionClass>> = {
  'room.rename': 'semantic',
  'room.kind': 'semantic',
  'room.delete': 'geometric',
  'entity.label': 'semantic',
  'entity.category': 'semantic',
  'entity.room': 'semantic',
  'entity.move': 'geometric',
  'entity.resize': 'geometric',
  'entity.delete': 'geometric',
  'dimension.set': 'measurement',
  'surface.flags': 'semantic',
  'opening.kind': 'semantic',
  'opening.connects': 'semantic',
  'entrance.set': 'semantic',
  'region.mark': 'coverage',
  'region.clear': 'coverage',
  'world.approve': 'signoff',
};

export function correctionClass(kind: CorrectionKind): CorrectionClass {
  return CLASS_OF[kind];
}

/** The world object a correction acts on, for grouping and for the plan view. */
export interface CorrectionTargetRef {
  readonly type: 'room' | 'entity' | 'surface' | 'opening' | 'navNode' | 'region' | 'world';
  readonly id: string;
}

export function correctionTarget(change: CorrectionChange): CorrectionTargetRef {
  switch (change.kind) {
    case 'room.rename': case 'room.kind': case 'room.delete':
      return { type: 'room', id: change.roomId };
    case 'entity.label': case 'entity.category': case 'entity.room':
    case 'entity.move': case 'entity.resize': case 'entity.delete':
      return { type: 'entity', id: change.entityId };
    case 'surface.flags':
      return { type: 'surface', id: change.surfaceId };
    case 'opening.kind': case 'opening.connects':
      return { type: 'opening', id: change.openingId };
    case 'entrance.set':
      return { type: 'navNode', id: change.navNodeId };
    case 'region.mark':
      return { type: 'region', id: change.roomId ?? 'new' };
    case 'region.clear':
      return { type: 'region', id: change.regionId };
    case 'dimension.set':
      return dimensionTargetRef(change.target);
    case 'world.approve':
      return { type: 'world', id: 'world' };
  }
}

function dimensionTargetRef(t: DimensionTarget): CorrectionTargetRef {
  switch (t.kind) {
    case 'room.area': case 'room.ceilingHeight':
      return { type: 'room', id: t.roomId };
    case 'opening.width': case 'opening.height': case 'opening.sill':
      return { type: 'opening', id: t.openingId };
  }
}

/**
 * The key two corrections collide on. A second rename of the same room
 * replaces the first rather than stacking, so the list stays a set of
 * decisions rather than a keystroke log.
 *
 * `region.mark` and `world.approve` deliberately have unique keys: two marked
 * regions are two regions, and two sign-offs are two sign-offs.
 */
export function correctionKey(record: CorrectionRecord): string {
  const change = record.change;
  if (change.kind === 'region.mark' || change.kind === 'world.approve') return record.id;
  if (change.kind === 'dimension.set') {
    const t = change.target;
    return `dimension.set:${t.kind}:${'roomId' in t ? t.roomId : t.openingId}`;
  }
  if (change.kind === 'surface.flags') {
    // Reflective and glazed are independent claims about the same surface, so
    // correcting one must not silently discard a pending correction to the
    // other. They key separately and `applyToDocument` merges them in order.
    const fields = [
      change.isReflective !== undefined ? 'reflective' : null,
      change.isGlazed !== undefined ? 'glazed' : null,
    ].filter(Boolean).join('+');
    return `surface.flags:${change.surfaceId}:${fields}`;
  }
  const target = correctionTarget(change);
  return `${change.kind}:${target.type}:${target.id}`;
}

// ---------------------------------------------------------------------------
// Human-readable description
// ---------------------------------------------------------------------------

export interface DescribeContext {
  /** id -> display name, for rooms and entities. Optional. */
  readonly names?: Readonly<Record<string, string>>;
}

function nameOf(id: string | null | undefined, ctx: DescribeContext): string {
  if (!id) return 'nothing';
  return ctx.names?.[id] ?? id;
}

const DIMENSION_LABEL: Readonly<Record<DimensionTarget['kind'], string>> = {
  'room.area': 'floor area',
  'room.ceilingHeight': 'ceiling height',
  'opening.width': 'width',
  'opening.height': 'height',
  'opening.sill': 'sill height',
};

/**
 * One sentence, in the past-conditional, describing what the correction will
 * do if saved. The list shows these, so they must read as a review document
 * rather than as a diff.
 */
export function describeCorrection(change: CorrectionChange, ctx: DescribeContext = {}): string {
  switch (change.kind) {
    case 'room.rename':
      return `Rename ${nameOf(change.roomId, ctx)} to "${change.name}".`;
    case 'room.kind':
      return `Set ${nameOf(change.roomId, ctx)} to be a ${change.roomKind} room.`;
    case 'room.delete':
      return `Delete the room ${nameOf(change.roomId, ctx)}, and everything that only belonged to it.`;
    case 'entity.label':
      return `Relabel ${nameOf(change.entityId, ctx)} as "${change.label}".`;
    case 'entity.category':
      return `Recategorise ${nameOf(change.entityId, ctx)} as ${change.category}.`;
    case 'entity.room':
      return change.roomId === null
        ? `Detach ${nameOf(change.entityId, ctx)} from every room.`
        : `Move ${nameOf(change.entityId, ctx)} into ${nameOf(change.roomId, ctx)}.`;
    case 'entity.move':
      return `Reposition ${nameOf(change.entityId, ctx)} to ${fmtVec(change.centroid)}.`;
    case 'entity.resize':
      return `Resize ${nameOf(change.entityId, ctx)} to ${fmtSize(change.size)}.`;
    case 'entity.delete':
      return `Delete ${nameOf(change.entityId, ctx)}: it is not in the property.`;
    case 'dimension.set': {
      const t = change.target;
      const subject = 'roomId' in t ? nameOf(t.roomId, ctx) : nameOf(t.openingId, ctx);
      const unit = t.kind === 'room.area' ? 'm²' : 'm';
      const how = change.method === 'site-measure'
        ? `measured on site with a ${change.instrument === 'unknown' ? 'declared instrument' : change.instrument}`
        : 'entered as an estimate';
      return `Set the ${DIMENSION_LABEL[t.kind]} of ${subject} to ${change.value.toFixed(t.kind === 'room.area' ? 2 : 3)} ${unit}, ${how}.`;
    }
    case 'surface.flags': {
      const parts: string[] = [];
      if (change.isReflective !== undefined) {
        parts.push(change.isReflective ? 'mirrored' : 'not mirrored');
      }
      if (change.isGlazed !== undefined) parts.push(change.isGlazed ? 'glazed' : 'not glazed');
      return `Mark surface ${change.surfaceId} as ${parts.join(' and ')}.`;
    }
    case 'opening.kind':
      return `Change opening ${change.openingId} to a ${change.openingKind}.`;
    case 'opening.connects':
      return `Connect opening ${change.openingId} between ${nameOf(change.roomA, ctx)} and ${nameOf(change.roomB, ctx)}.`;
    case 'entrance.set':
      return `Make ${change.navNodeId} the entrance a visitor arrives at.`;
    case 'region.mark':
      return change.provenance === 'generated'
        ? `Mark ${fmtVolume(change.volume)} as not surveyed: ${change.reason}`
        : `Mark ${fmtVolume(change.volume)} as uncertain: ${change.reason}`;
    case 'region.clear':
      return `Remove the operator-added coverage note ${change.regionId}.`;
    case 'world.approve':
      return change.note
        ? `Approve this world for publication. ${change.note}`
        : 'Approve this world for publication.';
  }
}

function fmtVec(v: Vec3): string {
  return `${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)} m`;
}

function fmtSize(v: Vec3): string {
  return `${v[0].toFixed(2)} × ${v[1].toFixed(2)} × ${v[2].toFixed(2)} m`;
}

function fmtVolume(v: Aabb): string {
  const w = v.max[0] - v.min[0];
  const h = v.max[1] - v.min[1];
  const d = v.max[2] - v.min[2];
  return `a ${w.toFixed(2)} × ${h.toFixed(2)} × ${d.toFixed(2)} m volume`;
}
