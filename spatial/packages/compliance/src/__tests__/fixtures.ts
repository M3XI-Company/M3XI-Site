import type { Quantity, WorldDocument } from '@m3xi/world-core';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type {
  ComplianceApi, MeasurementRecord, PropertyFacts, RedactionDetection, WorldFacts,
} from '../model/sources.js';

/**
 * Fixtures built ON the shared flat rather than beside it.
 *
 * `@m3xi/spatial-engine/fixtures/flat` is the world every package in this
 * system is tested against, and it already contains the two awkward cases this
 * package most needs: a generated volume in the corner of bedroom 1, so an
 * area measurement is genuinely not defensible, and an inferred bathroom
 * ceiling, so a height is genuinely estimated. Writing a private world here
 * would test this package against a building nobody else has, and the first
 * thing to drift would be the numbers.
 *
 * Mutation is through a JSON round trip. The contract is plain data with no
 * class instances, no dates and no undefined-valued keys that matter, so the
 * clone is exact, and it is a clone rather than a spread because the parts
 * these fixtures change are three levels down.
 */
export function cloneFlat(): WorldDocument {
  return JSON.parse(JSON.stringify(FLAT)) as WorldDocument;
}

/** The receipts a human correction leaves on a row, as the server writes them. */
export const CORRECTION_ID = 'c_7f2a1b04';
export const OPERATOR_ID = 'u_katherine';

/**
 * The bathroom, with an operator's correction receipt on the room row.
 *
 * This is what a corrected world actually looks like when it is rendered:
 * `correction_sources` lands in `Grounding.sources` verbatim, and the derived
 * area carries no receipt of its own -- deliberately, because the receipt is
 * for the ROW and stamping it onto a quantity nobody measured would claim a
 * person declared a figure they never touched.
 */
export function worldWithCorrectedRoom(): WorldDocument {
  const doc = cloneFlat();
  const bath = doc.rooms.find((r) => r.id === 'r_bath');
  if (!bath) throw new Error('fixture drift: the flat has no r_bath');
  mutate(bath.grounding, {
    provenance: 'inferred',
    confidence: 0.9,
    sources: [...(bath.grounding.sources ?? []), `correction:${CORRECTION_ID}`, `operator:${OPERATOR_ID}`],
  });
  return doc;
}

/**
 * A declared site measurement of the bathroom floor, exactly as `wv-worlds`
 * writes it: the value on the row, and a `wv_measurement` row whose basis
 * carries the method, the instrument, who, when and what it superseded.
 */
export function laserMeasurementRecord(): MeasurementRecord {
  return {
    id: 'm_bath_area_1',
    kind: 'area',
    a: { type: 'room', id: 'r_bath', field: 'area' },
    value: 3.61,
    unit: 'm2',
    standard: 'RICS-COMP-GIA',
    tolerance: 0.32,
    toleranceUnit: 'pct',
    confidence: 0.9,
    createdAt: '2026-03-02T14:20:00.000Z',
    basis: {
      corrected: true,
      correctionId: CORRECTION_ID,
      statedBy: OPERATOR_ID,
      statedAt: '2026-03-02T14:20:00.000Z',
      method: 'site-measure',
      instrument: 'laser',
      defensible: true,
      supersededValue: 3.57,
      supersededStandard: 'RICS-COMP-GIA',
      supersededTolerance: 2.5,
      supersededToleranceUnit: 'pct',
    },
  };
}

/** The same shape for a figure somebody typed rather than measured. */
export function estimateMeasurementRecord(): MeasurementRecord {
  return {
    id: 'm_bed2_height_1',
    kind: 'height',
    a: { type: 'room', id: 'r_bed2', field: 'ceilingHeight' },
    value: 2.45,
    unit: 'm',
    standard: 'CLEAR-INTERNAL',
    tolerance: 40,
    toleranceUnit: 'mm',
    confidence: 0.9,
    createdAt: '2026-03-02T14:25:00.000Z',
    basis: {
      corrected: true,
      correctionId: 'c_11aa22bb',
      statedBy: OPERATOR_ID,
      statedAt: '2026-03-02T14:25:00.000Z',
      method: 'estimate',
      instrument: 'unknown',
      defensible: false,
      refusalReason: 'this figure was entered by an operator as an estimate, not measured',
      supersededValue: 2.4,
    },
  };
}

/**
 * A world carrying a dimension that cannot be displayed.
 *
 * The standard is removed from a window's width, which is the failure
 * `assertDisplayable` exists to catch. A cast is used because the contract
 * forbids the shape -- which is the point: this is what a pipeline bug looks
 * like when it reaches a document, and the document has to survive it.
 */
export function worldWithBrokenQuantity(): WorldDocument {
  const doc = cloneFlat();
  const opening = doc.openings.find((o) => o.id === 'o_win_bath');
  if (!opening?.width) throw new Error('fixture drift: o_win_bath has no width');
  mutate(opening.width as Quantity, { standard: undefined as unknown as Quantity['standard'] });
  return doc;
}

export function redaction(over: Partial<RedactionDetection> = {}): RedactionDetection {
  return {
    id: 'r_1',
    cameraId: 'cam_hall_01',
    kind: 'face',
    bbox: [820, 410, 96, 130],
    detector: 'yunet',
    score: 0.91,
    applied: true,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: '2026-02-11T10:02:00.000Z',
    ...over,
  };
}

export const PROPERTY: PropertyFacts = {
  id: 'prop_demo_0001',
  ref: 'AB-1042',
  label: 'Flat 2, 14 Hollis Road',
  postcode: 'SE15 3QP',
  address: { line1: '14 Hollis Road', town: 'London' },
};

export const WORLD_FACTS: WorldFacts = {
  world: {
    id: 'world_flat_demo',
    version: 3,
    status: 'published',
    published_at: '2026-02-11T11:02:00.000Z',
    created_at: '2026-02-11T09:14:00.000Z',
  },
  lastCorrectionAt: null,
};

/** A client that answers, so the mount path can be exercised without a server. */
export function fixtureApi(over: Partial<ComplianceApi> = {}): ComplianceApi {
  return {
    isFixture: true,
    getProperty: async () => PROPERTY,
    getWorld: async () => WORLD_FACTS,
    ...over,
  };
}

/**
 * Write through a readonly view.
 *
 * The contract's types are readonly all the way down, which is right for
 * production and inconvenient for a fixture whose entire job is to produce the
 * awkward variants. Confined to this one helper so that a cast never appears
 * in a test body, where it would quietly weaken an assertion.
 */
function mutate<T extends object>(target: T, patch: Partial<Record<keyof T, unknown>>): void {
  Object.assign(target, patch);
}
