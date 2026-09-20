import type { Grounding, Provenance, Quantity } from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';
import { toleranceFactor } from '@m3xi/spatial-engine';
import {
  INSTRUMENT_TOLERANCE_MM, correctionClass,
  type CorrectionChange, type CorrectionRecord, type DimensionMethod, type Instrument,
} from './corrections.js';

/**
 * HOW A HUMAN CORRECTION IS REPRESENTED IN THE PROVENANCE MODEL
 * ============================================================
 *
 * The contract's `Provenance` union has four members and none of them is
 * "a person said so":
 *
 *   observed      a camera saw this
 *   reconstructed geometry derived it from observations
 *   inferred      a model estimated it (semantics, metric scale, layout closure)
 *   generated     a model invented it; no observation supports it
 *
 * `world-core/src/types.ts` is the contract and is not ours to change, so the
 * question is which of the four an operator's assertion becomes, and where the
 * fact that a human made it is recorded. Four options were considered.
 *
 *   -- 'observed' is a lie. A camera did not see it. This is precisely the
 *      "silently present a guess as an observation" failure the brief names,
 *      and it is the one that would matter in a dispute, because `observed`
 *      is the strongest claim the system can make.
 *
 *   -- 'reconstructed' is a lie of the same shape, one notch quieter. It
 *      asserts that geometry was DERIVED from observations. A person dragging
 *      a sofa on a floorplan derived nothing.
 *
 *   -- 'generated' is a lie in the other direction, and a costly one. It means
 *      "a model invented it; no observation supports it", and the viewer
 *      renders it as not-surveyed hatching, refuses to walk into it, and marks
 *      every measurement crossing it indicative. An operator who was standing
 *      in the room and moved a mislabelled radiator 200 mm has not turned that
 *      corner of the flat into model infill. Worse, it makes correcting the
 *      world strictly worse for the operator than leaving it wrong, which is
 *      how you get a system nobody corrects.
 *
 *   -- 'inferred' -- "a model estimated it (semantics, metric scale, layout
 *      closure)" -- is the only member that means "this figure is an estimate
 *      rather than a direct measurement". A human estimate and a model
 *      estimate are different in origin and identical in epistemic standing:
 *      neither is an observation, both are somebody's best judgement, and both
 *      deserve the widened tolerance the engine already applies to `inferred`
 *      (`PROVENANCE_TOLERANCE_FACTOR.inferred === 2`).
 *
 * So the rule is:
 *
 *   RULE 1  A correction never STRENGTHENS provenance.
 *           `weakestProvenance(existing, floor)` always. A human cannot
 *           promote generated infill to observed geometry by typing over it.
 *           The fix for "nobody scanned that corner" is a rescan, not a claim.
 *
 *   RULE 2  A SEMANTIC correction leaves provenance alone.
 *           `Room.grounding.provenance` describes how the polygon was derived.
 *           Renaming the room does not touch the polygon, so the geometry is
 *           still exactly as reconstructed as it was. Downgrading it would
 *           corrupt every measurement that reads it, for a change that
 *           measured nothing. What DOES change is the receipt (Rule 4) and the
 *           confidence (Rule 5).
 *
 *   RULE 3  A GEOMETRIC correction floors provenance at 'inferred'.
 *           Moving, resizing or reshaping produces geometry no camera saw and
 *           no reconstruction derived. `inferred` is the honest member, and
 *           the engine's tolerance factor of 2 falls out of it automatically,
 *           so a hand-placed object's measurements widen without any special
 *           case in the measurement code.
 *
 *   RULE 4  EVERY correction leaves a receipt in `Grounding.sources`.
 *           The contract documents `sources` as "camera ids where relevant" --
 *           "where relevant" is doing real work there. A correction writes a
 *           reserved token, `correction:<record id>`, alongside the camera ids
 *           it does not remove. That token is how `isHumanCorrected` answers
 *           "did a person touch this fact", how the measurement certificate
 *           prints "declared by an operator" instead of "measured by the
 *           system", and how a rescan can tell which facts were hand-held.
 *           It is inside the contract, it is machine-readable, and it does not
 *           pretend to be a camera because nothing consumes `sources` as a
 *           camera list without checking the prefix.
 *
 *   RULE 5  Confidence becomes the OPERATOR'S confidence, and never rises
 *           above `HUMAN_ASSERTION_CONFIDENCE`.
 *           An operator who names a room is usually right and occasionally in
 *           the wrong flat. 0.9 is a deliberate, declared ceiling: high enough
 *           that a corrected fact outranks a 0.6 model guess, low enough that
 *           nothing downstream treats it as certain. Where the pipeline was
 *           already MORE confident than that and the correction only confirms
 *           the existing value, confidence is left alone -- a human agreeing
 *           with the model is not new information.
 *
 *   RULE 6  A declared SITE MEASUREMENT sets its own tolerance and stays
 *           defensible; a typed ESTIMATE does not.
 *           See `correctedQuantity`. This is the one place a human correction
 *           can make a number *better* than the reconstruction, and it is
 *           gated on the operator declaring an instrument, which the
 *           certificate then prints. A laser reading is genuinely tighter than
 *           a 20 mm reconstruction tolerance and refusing to say so would be
 *           its own inaccuracy.
 */

/** Ceiling on the confidence a human assertion may carry. Declared, not derived. */
export const HUMAN_ASSERTION_CONFIDENCE = 0.9;

/** Reserved `Grounding.sources` namespace for human corrections. */
export const CORRECTION_SOURCE_PREFIX = 'correction:';

/** Reserved `Grounding.sources` namespace for the operator who made them. */
export const OPERATOR_SOURCE_PREFIX = 'operator:';

export function correctionSource(recordId: string): string {
  return `${CORRECTION_SOURCE_PREFIX}${recordId}`;
}

export function operatorSource(by: string): string {
  return `${OPERATOR_SOURCE_PREFIX}${by}`;
}

/** True when any human correction has touched the fact this grounding backs. */
export function isHumanCorrected(g: Grounding | undefined | null): boolean {
  if (!g?.sources) return false;
  return g.sources.some((s) => s.startsWith(CORRECTION_SOURCE_PREFIX));
}

/** Correction record ids behind a fact, oldest first as they were appended. */
export function correctionIdsOf(g: Grounding | undefined | null): readonly string[] {
  if (!g?.sources) return [];
  return g.sources
    .filter((s) => s.startsWith(CORRECTION_SOURCE_PREFIX))
    .map((s) => s.slice(CORRECTION_SOURCE_PREFIX.length));
}

/** Operator identifiers behind a fact. */
export function operatorsOf(g: Grounding | undefined | null): readonly string[] {
  if (!g?.sources) return [];
  return g.sources
    .filter((s) => s.startsWith(OPERATOR_SOURCE_PREFIX))
    .map((s) => s.slice(OPERATOR_SOURCE_PREFIX.length));
}

/** Camera ids only: the receipts the pipeline wrote, with ours filtered out. */
export function cameraSourcesOf(g: Grounding | undefined | null): readonly string[] {
  if (!g?.sources) return [];
  return g.sources.filter(
    (s) => !s.startsWith(CORRECTION_SOURCE_PREFIX) && !s.startsWith(OPERATOR_SOURCE_PREFIX),
  );
}

/**
 * The provenance floor a correction imposes. Rules 2 and 3.
 *
 * `null` means "impose no floor": the fact's own provenance survives intact.
 */
export function provenanceFloor(change: CorrectionChange): Provenance | null {
  switch (correctionClass(change.kind)) {
    case 'semantic':
      return null;
    case 'geometric':
      return 'inferred';
    case 'measurement':
      // A site measurement is an assertion about the real building, made by
      // someone who was in it. It is still not an observation in this
      // contract's sense -- no camera saw it -- so it floors at 'inferred'
      // like any other human number. What distinguishes it is the tolerance
      // and the defensibility, handled in `correctedQuantity`.
      return 'inferred';
    case 'coverage':
    case 'signoff':
      return null;
  }
}

/**
 * Apply a correction's provenance consequences to a grounding. Rules 1, 4, 5.
 *
 * `confirmsExisting` is true when the correction sets a field to the value it
 * already had -- an operator ticking "yes, that really is a bathroom". That is
 * a confirmation, not new information, so it does not pull a 0.95 pipeline
 * confidence down to the human ceiling.
 */
export function correctGrounding(
  existing: Grounding,
  record: CorrectionRecord,
  opts: { readonly confirmsExisting?: boolean } = {},
): Grounding {
  const floor = provenanceFloor(record.change);
  const provenance = floor === null
    ? existing.provenance
    : weakestProvenance(existing.provenance, floor);

  // A correction that CHANGES the value carries the operator's confidence in
  // the new value, which may well be higher than the pipeline's confidence in
  // the old one -- that is the entire reason a human is in the loop. A
  // correction that merely CONFIRMS the existing value adds no information, so
  // it leaves a 0.95 pipeline confidence where it is rather than pulling it
  // down to the human ceiling.
  const confidence = opts.confirmsExisting
    ? clamp01(existing.confidence)
    : HUMAN_ASSERTION_CONFIDENCE;

  const sources = appendReceipt(existing.sources, record);
  return { provenance, confidence, sources };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function appendReceipt(
  existing: readonly string[] | undefined, record: CorrectionRecord,
): readonly string[] {
  const out = [...(existing ?? [])];
  const mine = correctionSource(record.id);
  const who = operatorSource(record.by);
  if (!out.includes(mine)) out.push(mine);
  if (!out.includes(who)) out.push(who);
  return out;
}

// ---------------------------------------------------------------------------
// Corrected quantities
// ---------------------------------------------------------------------------

export interface CorrectedQuantityOpts {
  readonly method: DimensionMethod;
  readonly instrument: Instrument;
  /** Fallback half-width when the instrument declares none, in mm or pct. */
  readonly policyTolerance: number;
  readonly policyToleranceUnit: 'mm' | 'pct';
}

/**
 * Build the `Quantity` a dimension correction produces. Rule 6.
 *
 * What goes in `basis` is the point of this function. `Quantity` has no field
 * for "a person typed this", so the basis record -- which the contract already
 * describes as "the geometry that produced it, so a measurement certificate
 * can be reissued and defended later" -- carries:
 *
 *   corrected        true, so the certificate never prints this as a survey result
 *   correctionId     the record it came from
 *   statedBy/At      who and when
 *   method           'estimate' or 'site-measure'
 *   instrument       what they measured it with, printed beside the number
 *   supersededValue  what the reconstruction said, so both survive
 *   defensible       false for an estimate, true for a declared site measure
 *
 * `defensible` is read by `isDefensible` in the engine and by the viewer's
 * formatter, so an estimate automatically renders as indicative everywhere,
 * with no cooperation needed from the display layer.
 */
export function correctedQuantity(
  previous: Quantity | undefined,
  value: number,
  unit: Quantity['unit'],
  standard: Quantity['standard'],
  record: CorrectionRecord,
  opts: CorrectedQuantityOpts,
): Quantity {
  const grounding = correctGrounding(
    previous?.grounding ?? { provenance: 'inferred', confidence: HUMAN_ASSERTION_CONFIDENCE },
    record,
  );

  const declared = INSTRUMENT_TOLERANCE_MM[opts.instrument];
  const siteMeasured = opts.method === 'site-measure' && declared !== null;

  let tolerance: number;
  let toleranceUnit: 'mm' | 'pct';
  if (siteMeasured && unit === 'm') {
    // The instrument's own accuracy, not the reconstruction's. This is the
    // whole reason an operator bothers to go and measure the room.
    tolerance = declared;
    toleranceUnit = 'mm';
  } else if (siteMeasured && unit === 'm2') {
    // An area measured on site is two length readings multiplied, so the
    // relative half-widths add: a 3 mm reading on each of two ~4 m sides is
    // about 0.15% on the product. Expressed as a percentage because that is
    // what the contract requires for areas, and derived rather than declared
    // so it tracks the room's actual size.
    const side = Math.sqrt(Math.max(value, 1e-6));
    tolerance = Math.max(0.1, (2 * (declared / 1000) / side) * 100);
    toleranceUnit = 'pct';
  } else {
    // An estimate gets the document policy widened by the provenance factor,
    // which is the same arithmetic the engine applies to any inferred length.
    tolerance = opts.policyTolerance * toleranceFactor(grounding.provenance);
    toleranceUnit = opts.policyToleranceUnit;
  }

  const basis: Record<string, unknown> = {
    corrected: true,
    correctionId: record.id,
    statedBy: record.by,
    statedAt: record.at,
    method: opts.method,
    instrument: opts.instrument,
    defensible: siteMeasured,
  };
  if (previous) {
    basis['supersededValue'] = previous.value;
    basis['supersededStandard'] = previous.standard;
    basis['supersededTolerance'] = previous.tolerance;
    basis['supersededToleranceUnit'] = previous.toleranceUnit;
  }
  if (!siteMeasured) {
    basis['refusalReason'] = opts.method === 'site-measure'
      ? 'an operator declared this a site measurement but named no instrument, so its accuracy is undeclared'
      : 'this figure was entered by an operator as an estimate, not measured';
  }
  if (record.note) basis['note'] = record.note;

  return { value, unit, standard, tolerance, toleranceUnit, grounding, basis };
}
