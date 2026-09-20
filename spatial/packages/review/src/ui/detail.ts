import type {
  Entity, Grounding, MeasurementStandard, OpeningKind, Provenance, Quantity, RoomKind, Surface,
  Vec3, WorldDocument,
} from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';
import { isDefensible } from '@m3xi/spatial-engine';
import { formatExtent, formatQuantity } from '@m3xi/viewer/headless';
import {
  INSTRUMENT_TOLERANCE_MM,
  type CorrectionChange, type DimensionMethod, type DimensionTarget, type Instrument,
} from '../model/corrections.js';
import {
  HUMAN_ASSERTION_CONFIDENCE, cameraSourcesOf, isHumanCorrected, operatorsOf, provenanceFloor,
} from '../model/provenance.js';
import { ceilingHeight, type PlanSelection } from './plan.js';

/**
 * WHAT IS CORRECTABLE ABOUT THE SELECTED THING, AND WHAT IT WILL COST
 * ===================================================================
 *
 * The detail panel is the only place in this editor where a human assertion
 * enters the world, so this file does two jobs and the second one is the
 * important one:
 *
 *   1. It says which fields of the selected object may be corrected, what they
 *      currently say, and how to turn an operator's input into a
 *      `CorrectionChange`. That is the easy half.
 *   2. It says, BEFORE the correction is made, what the correction will do to
 *      the object's provenance and to the defensibility of its figures. An
 *      editor that shows a text box and a Save button is asking someone to
 *      make an evidential claim with no indication that they are making one.
 *
 * Two rules from `provenance.ts` drive almost everything here, and both are
 * shown rather than assumed:
 *
 *   - a human correction is never `observed` and never `reconstructed`. It is
 *     an estimate, and the panel says so in those words every time, because
 *     "I typed the right number" and "a camera saw it" are different claims
 *     and only the second one is evidence.
 *   - a SEMANTIC correction leaves geometry alone. Renaming the hall does not
 *     make its polygon less reconstructed. The panel says that too, because
 *     an operator who believes every edit degrades the world is an operator
 *     who stops editing.
 *
 * Nothing here is a plain data structure with a `value` the caller writes back
 * into the document. Each field carries a `make`, which is the only way to
 * build the change it describes. That is what keeps `detailPanel.ts` free of
 * decisions: it renders controls and calls `make`, and if `make` returns null
 * the input was not sufficient and `problem` says why in a sentence.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * `RoomKind` from the world contract, which is also `wv_room_kind` on the
 * server. Listed rather than derived because a TypeScript union has no runtime
 * members; the server refuses anything outside this set by name, so a list
 * that drifts produces a control whose every use is rejected.
 */
export const ROOM_KINDS: readonly RoomKind[] = [
  'living', 'kitchen', 'bedroom', 'bathroom', 'wc', 'hall', 'landing', 'stairwell',
  'utility', 'storage', 'office', 'dining', 'conservatory', 'garage', 'balcony',
  'garden', 'exterior', 'unknown',
];

export const OPENING_KINDS: readonly OpeningKind[] = [
  'door', 'doorway', 'window', 'rooflight', 'stair', 'hatch', 'arch',
];

export const ENTITY_CATEGORIES: readonly Entity['category'][] = [
  'furniture', 'appliance', 'fixture', 'fitting', 'structure', 'other',
];

/**
 * Length standards only. `RICS-COMP-GIA`, `RICS-COMP-NIA` and `IPMS-3C` are
 * AREA standards: labelling a floor-to-ceiling height with one is a category
 * error, and the server hard-codes CLEAR-INTERNAL for every length it stores
 * for exactly that reason.
 */
export const LENGTH_STANDARDS: readonly MeasurementStandard[] = ['CLEAR-INTERNAL'];

export const AREA_STANDARDS: readonly MeasurementStandard[] = [
  'RICS-COMP-GIA', 'RICS-COMP-NIA', 'IPMS-3C', 'CLEAR-INTERNAL',
];

export const STANDARD_LABEL: Readonly<Record<MeasurementStandard, string>> = {
  'RICS-COMP-GIA': 'RICS Code of Measuring Practice — gross internal area',
  'RICS-COMP-NIA': 'RICS Code of Measuring Practice — net internal area',
  'IPMS-3C': 'IPMS 3C — occupier level, to the internal dominant face',
  'CLEAR-INTERNAL': 'Clear internal — wall face to wall face, no standard implied',
};

/**
 * One word per provenance member, for an operator.
 *
 * Finer-grained than the viewer's three display classes on purpose. A buyer
 * needs to know whether a thing was surveyed; the operator deciding what to
 * correct needs the four-member distinction, because it is the distinction
 * that drives refusal and it is the one they are about to weaken.
 */
export const PROVENANCE_WORD: Readonly<Record<Provenance, string>> = {
  observed: 'photographed — a camera saw this',
  reconstructed: 'measured from the photographs',
  inferred: 'estimated — no camera saw this directly',
  generated: 'not surveyed — a model filled this in and nothing observed supports it',
};

export const INSTRUMENT_LABEL: Readonly<Record<Instrument, string>> = {
  laser: 'Laser distance meter (±3 mm)',
  tape: 'Steel tape (±10 mm)',
  unknown: 'I measured it, but I cannot say with what (no accuracy claimed)',
};

// ---------------------------------------------------------------------------
// Provenance, before and after
// ---------------------------------------------------------------------------

export interface ProvenanceView {
  readonly provenance: Provenance;
  /** What the pipeline says now, in words. */
  readonly now: string;
  readonly confidence: number;
  readonly cameras: number;
  readonly corrected: boolean;
  readonly operators: readonly string[];
  /** What a semantic correction would leave it as. */
  readonly afterSemantic: string;
  /** What a geometric or measurement correction would make it. */
  readonly afterGeometric: string;
}

export function provenanceView(g: Grounding): ProvenanceView {
  const geometric = weakestProvenance(g.provenance, 'inferred');
  return {
    provenance: g.provenance,
    now: PROVENANCE_WORD[g.provenance],
    confidence: g.confidence,
    cameras: cameraSourcesOf(g).length,
    corrected: isHumanCorrected(g),
    operators: operatorsOf(g),
    afterSemantic: `unchanged (${PROVENANCE_WORD[g.provenance]}), because naming a thing does not change how its shape was derived. `
      + `Confidence becomes ${HUMAN_ASSERTION_CONFIDENCE} — an operator is usually right and occasionally in the wrong flat.`,
    afterGeometric: `${PROVENANCE_WORD[geometric]}. A figure you place or type is an estimate, never an observation, `
      + 'and measurements that cross it widen accordingly.',
  };
}

/** The sentence for one specific pending change, used beside the Apply button. */
export function provenanceConsequence(change: CorrectionChange, g: Grounding): string {
  const floor = provenanceFloor(change);
  if (floor === null) {
    return `Provenance stays ${PROVENANCE_WORD[g.provenance]}; confidence becomes ${HUMAN_ASSERTION_CONFIDENCE}, and your name goes on the row.`;
  }
  const after = weakestProvenance(g.provenance, floor);
  return after === g.provenance
    ? `Provenance stays ${PROVENANCE_WORD[after]}; your name goes on the row.`
    : `Provenance weakens from "${PROVENANCE_WORD[g.provenance]}" to "${PROVENANCE_WORD[after]}", because this is geometry a person placed rather than a camera saw.`;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface Option { readonly value: string; readonly label: string }

interface FieldBase {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
}

export interface TextField extends FieldBase {
  readonly control: 'text';
  readonly value: string;
  readonly maxLength: number;
  make(value: string): CorrectionChange | null;
}

export interface ChoiceField extends FieldBase {
  readonly control: 'choice';
  readonly value: string;
  readonly options: readonly Option[];
  make(value: string): CorrectionChange | null;
}

export interface Vec3Field extends FieldBase {
  readonly control: 'vec3';
  readonly value: Vec3;
  /** Axis labels, in world order. Metres, +Y up, right-handed. */
  readonly axes: readonly [string, string, string];
  make(value: Vec3): CorrectionChange | null;
}

export interface DimensionInput {
  readonly value: number;
  readonly method: DimensionMethod | null;
  readonly instrument: Instrument | null;
  readonly standard?: MeasurementStandard;
}

export interface DimensionField extends FieldBase {
  readonly control: 'dimension';
  readonly target: DimensionTarget;
  readonly unit: 'm' | 'm2';
  readonly current: Quantity | null;
  /** The current figure, formatted, or the sentence saying there is none. */
  readonly currentText: string;
  readonly currentIndicative: boolean;
  readonly standards: readonly Option[];
  readonly defaultStandard: MeasurementStandard;
  make(input: DimensionInput): CorrectionChange | null;
}

export interface SurfaceRow {
  readonly id: string;
  readonly label: string;
  readonly isReflective: boolean;
  readonly isGlazed: boolean;
}

export interface SurfaceField extends FieldBase {
  readonly control: 'surface';
  readonly surfaces: readonly SurfaceRow[];
  make(surfaceId: string, flags: { isReflective?: boolean; isGlazed?: boolean }): CorrectionChange | null;
}

export interface CoverageField extends FieldBase {
  readonly control: 'coverage';
  make(provenance: 'inferred' | 'generated', reason: string): CorrectionChange | null;
}

export interface DangerField extends FieldBase {
  readonly control: 'danger';
  /** What goes with it, in the operator's words. Shown before, not after. */
  readonly consequence: string;
  make(): CorrectionChange;
}

export type DetailField =
  | TextField | ChoiceField | Vec3Field | DimensionField
  | SurfaceField | CoverageField | DangerField;

export interface DetailModel {
  readonly selection: PlanSelection;
  readonly title: string;
  readonly subtitle: string;
  readonly provenance: ProvenanceView | null;
  readonly fields: readonly DetailField[];
  /** Set when the selection no longer exists in the corrected world. */
  readonly missing: string | null;
}

// ---------------------------------------------------------------------------
// Building the model
// ---------------------------------------------------------------------------

export function buildDetail(doc: WorldDocument, selection: PlanSelection): DetailModel {
  switch (selection.type) {
    case 'room': return roomDetail(doc, selection);
    case 'opening': return openingDetail(doc, selection);
    case 'entity': return entityDetail(doc, selection);
    case 'region': return regionDetail(doc, selection);
  }
}

function gone(selection: PlanSelection, what: string): DetailModel {
  return {
    selection,
    title: what,
    subtitle: '',
    provenance: null,
    fields: [],
    // A selection that vanished is almost always the operator's own delete
    // taking effect. Saying so is better than an empty panel, which reads as
    // a bug.
    missing: `${what} is no longer in this world. It was either deleted by a correction in the list, or removed with the room it belonged to.`,
  };
}

function roomDetail(doc: WorldDocument, selection: PlanSelection): DetailModel {
  const room = doc.rooms.find((r) => r.id === selection.id);
  if (!room) return gone(selection, `Room ${selection.id}`);

  const roomSurfaces = doc.surfaces.filter((s) => s.roomId === room.id);
  const height = ceilingHeight(room, doc);

  const fields: DetailField[] = [
    {
      control: 'text',
      key: 'room.name',
      label: 'Room name',
      value: room.name ?? '',
      maxLength: 120,
      hint: 'What this room is called in the particulars. Naming a room changes no geometry.',
      make: (value) => {
        const name = value.trim();
        return name ? { kind: 'room.rename', roomId: room.id, name } : null;
      },
    },
    {
      control: 'choice',
      key: 'room.kind',
      label: 'Room kind',
      value: room.kind,
      options: ROOM_KINDS.map((k) => ({ value: k, label: k })),
      hint: 'Drives the written tour and the room counts. A cupboard called a bedroom is a misleading representation.',
      make: (value) => (ROOM_KINDS.includes(value as RoomKind)
        ? { kind: 'room.kind', roomId: room.id, roomKind: value as RoomKind }
        : null),
    },
    dimensionField({
      key: 'room.area',
      label: 'Floor area',
      target: { kind: 'room.area', roomId: room.id },
      unit: 'm2',
      current: room.area ?? null,
      standards: AREA_STANDARDS,
      defaultStandard: room.area?.standard ?? doc.measurementPolicy.areaStandard,
      hint: 'A declared area that contradicts the outline is shown beside it on the certificate, never instead of it.',
    }),
    dimensionField({
      key: 'room.ceilingHeight',
      label: 'Floor to ceiling',
      target: { kind: 'room.ceilingHeight', roomId: room.id },
      unit: 'm',
      // Built rather than read: the contract stores a room as two planes, and
      // showing their difference without the tolerance and the standard that
      // qualify it would be the bare number this product refuses.
      current: height,
      standards: LENGTH_STANDARDS,
      defaultStandard: 'CLEAR-INTERNAL',
      hint: 'Correcting it moves the ceiling; the floor stays where the reconstruction put it.',
    }),
  ];

  if (roomSurfaces.length > 0) {
    fields.push({
      control: 'surface',
      key: 'surface.flags',
      label: 'Mirrors and glazing',
      hint: 'The two failure modes this pipeline has. A mirror invents a room behind it; glazing blows the depth out and '
        + 'puts a hole in the wall. You can tell in a second standing in the flat, and flagging it is what lets every later stage stop trusting it.',
      surfaces: roomSurfaces.map((s) => ({
        id: s.id,
        label: surfaceLabel(s, roomSurfaces),
        isReflective: s.isReflective,
        isGlazed: s.isGlazed,
      })),
      make: (surfaceId, flags) => {
        if (!roomSurfaces.some((s) => s.id === surfaceId)) return null;
        if (flags.isReflective === undefined && flags.isGlazed === undefined) return null;
        return {
          kind: 'surface.flags',
          surfaceId,
          ...(flags.isReflective === undefined ? {} : { isReflective: flags.isReflective }),
          ...(flags.isGlazed === undefined ? {} : { isGlazed: flags.isGlazed }),
        };
      },
    });
  }

  fields.push({
    control: 'coverage',
    key: 'region.mark',
    label: 'Record a survey gap in this room',
    hint: 'Marks this room\'s volume so the viewer hatches it, the camera will not walk into it and every measurement crossing it '
      + 'publishes as indicative. Use it when the capture missed something; it is an assertion about coverage, not about the building.',
    make: (provenance, reason) => {
      const why = reason.trim();
      if (!why) return null;
      return {
        kind: 'region.mark',
        provenance,
        volume: roomVolume(doc, room.id) ?? { min: [0, 0, 0], max: [0, 0, 0] },
        reason: why,
        roomId: room.id,
      };
    },
  });

  fields.push({
    control: 'danger',
    key: 'room.delete',
    label: 'Delete this room',
    consequence: 'Its walls, floor and ceiling go with it, and so does every doorway and window that names it. '
      + 'Its furniture, viewpoints and coverage notes stay, detached from any room. The preview keeps the doorways '
      + 'and reports each one as a blocker, so you decide what happens to them rather than finding out afterwards.',
    make: () => ({ kind: 'room.delete', roomId: room.id }),
  });

  return {
    selection,
    title: room.name ?? room.id,
    subtitle: `${room.kind} · ${quantityLine(height)} floor to ceiling · ${roomSurfaces.length} surfaces`,
    provenance: provenanceView(room.grounding),
    fields,
    missing: null,
  };
}

function openingDetail(doc: WorldDocument, selection: PlanSelection): DetailModel {
  const opening = doc.openings.find((o) => o.id === selection.id);
  if (!opening) return gone(selection, `Opening ${selection.id}`);

  const roomOptions: Option[] = [
    { value: '', label: 'Nothing (not connected on this side)' },
    ...doc.rooms.map((r) => ({ value: r.id, label: r.name ?? r.id })),
  ];
  const sides = (a: string | null, b: string | null): CorrectionChange | null => {
    if (a !== null && a === b) return null;
    return { kind: 'opening.connects', openingId: opening.id, roomA: a, roomB: b };
  };

  const fields: DetailField[] = [
    {
      control: 'choice',
      key: 'opening.kind',
      label: 'Opening kind',
      value: opening.kind,
      options: OPENING_KINDS.map((k) => ({ value: k, label: k })),
      make: (value) => (OPENING_KINDS.includes(value as OpeningKind)
        ? { kind: 'opening.kind', openingId: opening.id, openingKind: value as OpeningKind }
        : null),
    },
    {
      control: 'choice',
      key: 'opening.roomA',
      label: 'Connects from',
      value: opening.roomA ?? '',
      options: roomOptions,
      hint: 'An opening that connects nothing is drawn but never appears in the route through the property.',
      make: (value) => sides(value || null, opening.roomB ?? null),
    },
    {
      control: 'choice',
      key: 'opening.roomB',
      label: 'Connects to',
      value: opening.roomB ?? '',
      options: roomOptions,
      make: (value) => sides(opening.roomA ?? null, value || null),
    },
    dimensionField({
      key: 'opening.width',
      label: 'Width',
      target: { kind: 'opening.width', openingId: opening.id },
      unit: 'm',
      current: opening.width ?? null,
      standards: LENGTH_STANDARDS,
      defaultStandard: 'CLEAR-INTERNAL',
      hint: 'A clear opening width is what decides whether a wheelchair, a sofa or a fridge gets through. It is quoted, so it is checked.',
    }),
    dimensionField({
      key: 'opening.height',
      label: 'Height',
      target: { kind: 'opening.height', openingId: opening.id },
      unit: 'm',
      current: opening.height ?? null,
      standards: LENGTH_STANDARDS,
      defaultStandard: 'CLEAR-INTERNAL',
    }),
    dimensionField({
      key: 'opening.sill',
      label: 'Sill height',
      target: { kind: 'opening.sill', openingId: opening.id },
      unit: 'm',
      current: opening.sill ?? null,
      standards: LENGTH_STANDARDS,
      defaultStandard: 'CLEAR-INTERNAL',
      hint: 'Height above the floor. Zero for a door.',
    }),
  ];

  const surface = opening.surfaceId
    ? doc.surfaces.find((s) => s.id === opening.surfaceId)
    : undefined;
  if (surface) {
    fields.push({
      control: 'surface',
      key: 'surface.flags',
      label: 'The panel this sits in',
      hint: 'Flagging the glazing here is the same correction as flagging it from the room, on the same surface.',
      surfaces: [{
        id: surface.id,
        label: `${surface.kind} carrying this ${opening.kind}`,
        isReflective: surface.isReflective,
        isGlazed: surface.isGlazed,
      }],
      make: (surfaceId, flags) => {
        if (surfaceId !== surface.id) return null;
        if (flags.isReflective === undefined && flags.isGlazed === undefined) return null;
        return {
          kind: 'surface.flags',
          surfaceId,
          ...(flags.isReflective === undefined ? {} : { isReflective: flags.isReflective }),
          ...(flags.isGlazed === undefined ? {} : { isGlazed: flags.isGlazed }),
        };
      },
    });
  }

  return {
    selection,
    title: `${opening.kind} ${opening.id}`,
    subtitle: describeConnection(doc, opening.roomA, opening.roomB),
    provenance: provenanceView(opening.grounding),
    fields,
    missing: null,
  };
}

function entityDetail(doc: WorldDocument, selection: PlanSelection): DetailModel {
  const entity = doc.entities.find((e) => e.id === selection.id);
  if (!entity) return gone(selection, `Object ${selection.id}`);

  const size: Vec3 = [
    entity.aabb.max[0] - entity.aabb.min[0],
    entity.aabb.max[1] - entity.aabb.min[1],
    entity.aabb.max[2] - entity.aabb.min[2],
  ];

  const fields: DetailField[] = [
    {
      control: 'text',
      key: 'entity.label',
      label: 'Label',
      value: entity.label,
      maxLength: 120,
      hint: 'What this object is called in the written tour.',
      make: (value) => {
        const label = value.trim();
        return label ? { kind: 'entity.label', entityId: entity.id, label } : null;
      },
    },
    {
      control: 'choice',
      key: 'entity.category',
      label: 'Category',
      value: entity.category,
      options: ENTITY_CATEGORIES.map((c) => ({ value: c, label: c })),
      hint: 'Fixtures and fittings are what stays with the property. Furniture is not.',
      make: (value) => (ENTITY_CATEGORIES.includes(value as Entity['category'])
        ? { kind: 'entity.category', entityId: entity.id, category: value as Entity['category'] }
        : null),
    },
    {
      control: 'choice',
      key: 'entity.room',
      label: 'In room',
      value: entity.roomId ?? '',
      options: [
        { value: '', label: 'No room (detached)' },
        ...doc.rooms.map((r) => ({ value: r.id, label: r.name ?? r.id })),
      ],
      make: (value) => ({ kind: 'entity.room', entityId: entity.id, roomId: value || null }),
    },
    {
      control: 'vec3',
      key: 'entity.move',
      label: 'Centre position',
      value: entity.centroid,
      axes: ['x (east, m)', 'y (up, m)', 'z (south, m)'],
      hint: 'Moving an object moves its bounding boxes with it, and records the geometry as estimated from then on.',
      make: (value) => (value.every((v) => Number.isFinite(v))
        ? { kind: 'entity.move', entityId: entity.id, centroid: value }
        : null),
    },
    {
      control: 'vec3',
      key: 'entity.resize',
      label: 'Size',
      value: size,
      axes: ['width (m)', 'height (m)', 'depth (m)'],
      hint: 'Resizing grows the object upward from where it stands, not outward from its middle: furniture is on the floor.',
      make: (value) => (value.every((v) => Number.isFinite(v) && v > 0)
        ? { kind: 'entity.resize', entityId: entity.id, size: value }
        : null),
    },
    {
      control: 'danger',
      key: 'entity.delete',
      label: 'Delete this object',
      consequence: 'The object goes, along with everything the scene graph said about it. Nothing else is affected, '
        + 'and it does not come back. Use it when the object is not in the property.',
      make: () => ({ kind: 'entity.delete', entityId: entity.id }),
    },
  ];

  return {
    selection,
    title: entity.label,
    subtitle: `${entity.category} · ${formatExtent(size[0], size[2], doc.measurementPolicy.wallToleranceMm)} in plan, `
      + `${size[1].toFixed(2)} m high (same tolerance)`
      + (entity.roomId ? ` · in ${doc.rooms.find((r) => r.id === entity.roomId)?.name ?? entity.roomId}` : ' · in no room'),
    provenance: provenanceView(entity.grounding),
    fields,
    missing: null,
  };
}

function regionDetail(doc: WorldDocument, selection: PlanSelection): DetailModel {
  const region = doc.regions.find((r) => r.id === selection.id);
  if (!region) return gone(selection, `Coverage note ${selection.id}`);
  return {
    selection,
    title: 'Coverage note',
    subtitle: region.reason ?? (region.provenance === 'generated' ? 'Not surveyed' : 'Uncertain'),
    provenance: null,
    fields: [{
      control: 'danger',
      key: 'region.clear',
      label: 'Withdraw this coverage note',
      consequence: 'Only a note an operator added can be withdrawn. A survey gap the pipeline recorded is the record that '
        + 'no camera looked there, and the remedy for that is a rescan; the server refuses it by name.',
      make: () => ({ kind: 'region.clear', regionId: region.id }),
    }],
    missing: null,
  };
}

// ---------------------------------------------------------------------------
// Dimensions: the field that has to be hard to use carelessly
// ---------------------------------------------------------------------------

/**
 * Why a dimension field is not a number box.
 *
 * The tolerance and the defensibility of a corrected figure come from HOW the
 * operator knows it, and nothing else. A laser reading is ±3 mm and stands up;
 * a number read off a plan is an estimate, gets the policy tolerance widened
 * by the provenance factor, and publishes as INDICATIVE. The same digits, two
 * different claims.
 *
 * So `method` and `instrument` start unset and `make` returns null until both
 * are answered. There is deliberately no default, and in particular no default
 * of "site measure, laser", which is the flattering answer: a pre-ticked box
 * is an assertion nobody made, and this one would be the assertion that the
 * figure is defensible.
 */
function dimensionField(spec: {
  key: string;
  label: string;
  target: DimensionTarget;
  unit: 'm' | 'm2';
  current: Quantity | null;
  standards: readonly MeasurementStandard[];
  defaultStandard: MeasurementStandard;
  hint?: string;
}): DimensionField {
  return {
    control: 'dimension',
    key: spec.key,
    label: spec.label,
    target: spec.target,
    unit: spec.unit,
    current: spec.current,
    currentText: spec.current ? quantityLine(spec.current) : 'Not recorded.',
    currentIndicative: !!spec.current && !isDefensible(spec.current),
    standards: spec.standards.map((s) => ({ value: s, label: STANDARD_LABEL[s] })),
    defaultStandard: spec.defaultStandard,
    ...(spec.hint ? { hint: spec.hint } : {}),
    make: (input) => {
      if (dimensionProblem(input) !== null) return null;
      return {
        kind: 'dimension.set',
        target: spec.target,
        value: input.value,
        method: input.method as DimensionMethod,
        // An estimate has no instrument, and `unknown` is the union member
        // that says so. It carries no declared accuracy, which is exactly
        // right: an estimate is not defensible whatever it was eyeballed with.
        instrument: input.instrument ?? 'unknown',
        ...(input.standard ? { standard: input.standard } : {}),
      };
    },
  };
}

/**
 * The one sentence standing between an operator and an undeclared number.
 *
 * Returns null when the input is complete. Every other return is shown next to
 * a disabled Apply button, so the reason a control is unavailable is on the
 * screen in words rather than in a tooltip nobody hovers.
 */
export function dimensionProblem(input: Partial<DimensionInput>): string | null {
  if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value <= 0) {
    return 'Enter a positive figure.';
  }
  if (input.method !== 'estimate' && input.method !== 'site-measure') {
    return 'Say how you know this figure: did you estimate it, or measure it on site? '
      + 'That choice is what decides whether it can be published as a measurement.';
  }
  if (input.method === 'site-measure' && !input.instrument) {
    return 'Name what you measured with. If you cannot, say so — the figure is then recorded as undeclared rather than as accurate.';
  }
  return null;
}

/** What the declared method and instrument will produce, before it is applied. */
export function dimensionConsequence(
  method: DimensionMethod | null, instrument: Instrument | null, unit: 'm' | 'm2',
): string {
  if (method === null) return 'Choose how you know this figure to see what it will publish as.';
  const mm = instrument ? INSTRUMENT_TOLERANCE_MM[instrument] : null;
  if (method === 'site-measure' && mm !== null) {
    return unit === 'm'
      ? `Publishes as a measurement, ±${mm} mm, with the instrument printed beside it on the certificate.`
      : `Publishes as a measurement. Two readings at ±${mm} mm multiply out to a percentage half-width derived from the room's own size.`;
  }
  if (method === 'site-measure') {
    return 'Recorded as a site measurement with no instrument named, so no accuracy is claimed: it publishes as INDICATIVE, '
      + 'exactly like an estimate.';
  }
  return 'Recorded as an estimate. It publishes as INDICATIVE, with the world\'s tolerance doubled because an estimate is not an observation.';
}

/** True only when the declared method and instrument produce a defensible figure. */
export function willBeDefensible(method: DimensionMethod | null, instrument: Instrument | null): boolean {
  return method === 'site-measure' && instrument !== null && INSTRUMENT_TOLERANCE_MM[instrument] !== null;
}

export function quantityLine(q: Quantity): string {
  const f = formatQuantity(q);
  return f.status === 'indicative'
    ? `${f.full} — INDICATIVE${f.statusNote ? `: ${f.statusNote}` : ''}`
    : f.full;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function surfaceLabel(s: Surface, siblings: readonly Surface[]): string {
  if (s.kind !== 'wall') return s.kind;
  const walls = siblings.filter((w) => w.kind === 'wall');
  const index = walls.findIndex((w) => w.id === s.id);
  const flags = [s.isReflective ? 'mirrored' : null, s.isGlazed ? 'glazed' : null]
    .filter(Boolean).join(', ');
  return `wall ${index + 1} of ${walls.length}${flags ? ` (${flags})` : ''}`;
}

function describeConnection(doc: WorldDocument, a?: string, b?: string): string {
  const name = (id?: string): string | null =>
    (id ? doc.rooms.find((r) => r.id === id)?.name ?? id : null);
  const from = name(a);
  const to = name(b);
  if (from && to) return `between ${from} and ${to}`;
  if (from) return `off ${from}, connecting nothing on the other side`;
  if (to) return `off ${to}, connecting nothing on the other side`;
  return 'connected to nothing';
}

/**
 * The room's own volume, from its outline and its two planes.
 *
 * Used for `region.mark`, which needs an AABB and has no rubber-band tool to
 * get one from. Marking a whole room is coarse and it is honest: an operator
 * who knows the capture missed a corner can say the room is uncertain, and
 * that is a great deal better than nothing being sayable at all.
 */
export function roomVolume(doc: WorldDocument, roomId: string): { min: Vec3; max: Vec3 } | null {
  const room = doc.rooms.find((r) => r.id === roomId);
  if (!room || room.polygon.length < 3) return null;
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  for (const p of room.polygon) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { min: [minX, room.floorZ, minZ], max: [maxX, room.ceilingZ, maxZ] };
}
