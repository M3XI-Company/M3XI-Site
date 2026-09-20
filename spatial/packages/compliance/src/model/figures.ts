import type { Grounding, Quantity } from '@m3xi/world-core';
import { isDefensible, refusalReason } from '@m3xi/spatial-engine';
import { formatQuantity } from '@m3xi/viewer/headless';
import type {
  DeclaredBasis, Figure, FigurePresentation, UnpresentableFigure,
} from './document.js';
import type { MeasurementRecord } from './sources.js';

/**
 * TURNING A QUANTITY INTO SOMETHING A CERTIFICATE CAN SAY
 * =======================================================
 *
 * Four kinds of claim end up in the same table, and the entire value of the
 * table is that they stay distinguishable:
 *
 *   a wall the reconstruction measured               -> MEASURED
 *   a wall the reconstruction measured across infill -> INDICATIVE, with why
 *   a wall somebody measured with a laser            -> DECLARED, with what
 *   a wall somebody guessed at                       -> INDICATIVE (DECLARED)
 *
 * The first two are decided by the engine: `isDefensible(q)` reads
 * `basis.defensible`, which `measure.ts` sets false when the measurement
 * touched generated geometry or an unobserved volume. Nothing here second
 * guesses that. The second two are decided by a `wv_measurement` row's basis,
 * written by `wv-worlds` from the operator's declared method and instrument.
 *
 * The rule that matters most is the one about omission. A figure the engine
 * will not stand behind is PRINTED, with the reason, because a certificate
 * that silently drops the bedroom whose corner was never surveyed reads as a
 * complete certificate for a property with one fewer problem. Under the DMCC
 * Act 2024 an omission is automatically unfair whether or not it changed
 * anyone's decision, and this is precisely the omission that would.
 */

/** Reserved `Grounding.sources` prefix for a human correction receipt. */
export const CORRECTION_SOURCE_PREFIX = 'correction:';
/** Reserved `Grounding.sources` prefix for the operator who made it. */
export const OPERATOR_SOURCE_PREFIX = 'operator:';

/**
 * These two constants are declared in `@m3xi/review`'s `provenance.ts` and
 * repeated here rather than imported. `@m3xi/review` is another package's
 * work, it is not a dependency of this one, and a compliance document that
 * failed to build because the correction editor was absent would be exactly
 * the coupling the console's seam exists to prevent -- the console already
 * mounts each of us independently, on purpose.
 *
 * What the duplication costs: if the prefix ever changes, this file has to
 * change with it. That is survivable because the prefix is also a wire format
 * -- it is written into `wv_room.correction_sources` by an edge function and
 * read back by the document renderer, so it cannot change without a migration
 * either way.
 */

export interface Receipts {
  readonly correctionIds: readonly string[];
  readonly operators: readonly string[];
  readonly cameras: readonly string[];
}

export function readReceipts(g: Grounding | undefined | null): Receipts {
  const sources = g?.sources ?? [];
  const correctionIds: string[] = [];
  const operators: string[] = [];
  const cameras: string[] = [];
  for (const s of sources) {
    if (s.startsWith(CORRECTION_SOURCE_PREFIX)) {
      correctionIds.push(s.slice(CORRECTION_SOURCE_PREFIX.length));
    } else if (s.startsWith(OPERATOR_SOURCE_PREFIX)) {
      operators.push(s.slice(OPERATOR_SOURCE_PREFIX.length));
    } else {
      cameras.push(s);
    }
  }
  return { correctionIds, operators, cameras };
}

/**
 * Recover the declared basis from a `wv_measurement` row.
 *
 * Returns null when the row is a pipeline measurement rather than a human one.
 * `corrected: true` is the discriminator `wv-worlds` writes and the one
 * `@m3xi/review`'s `correctedQuantity` writes, so both producers are read by
 * the same predicate.
 *
 * Every field is read defensively. This basis crossed a database as JSON and a
 * `basis` of `{}` is valid per the column default; a reader that assumed
 * `method` was a string would throw inside a certificate.
 */
export function readDeclaredBasis(
  basis: Readonly<Record<string, unknown>> | undefined,
): DeclaredBasis | null {
  if (!basis || basis['corrected'] !== true) return null;
  const out: DeclaredBasis = {
    defensible: basis['defensible'] === true,
    ...str(basis, 'correctionId', 'correctionId'),
    ...str(basis, 'statedBy', 'statedBy'),
    ...str(basis, 'statedAt', 'statedAt'),
    ...str(basis, 'method', 'method'),
    ...str(basis, 'instrument', 'instrument'),
    ...str(basis, 'refusalReason', 'refusalReason'),
    ...str(basis, 'note', 'note'),
    ...str(basis, 'supersededStandard', 'supersededStandard'),
    ...str(basis, 'supersededToleranceUnit', 'supersededToleranceUnit'),
    ...num(basis, 'supersededValue', 'supersededValue'),
    ...num(basis, 'supersededTolerance', 'supersededTolerance'),
  };
  return out;
}

function str(
  o: Readonly<Record<string, unknown>>, key: string, as: string,
): Record<string, string> {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? { [as]: v } : {};
}

function num(
  o: Readonly<Record<string, unknown>>, key: string, as: string,
): Record<string, number> {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? { [as]: v } : {};
}

/**
 * The method and the instrument, in the words a certificate prints.
 *
 * A laser reading and somebody's estimate are not the same claim, so they do
 * not get the same sentence. An operator who declared a site measurement and
 * named no instrument gets the third sentence, which is neither -- the server
 * already refuses to call it defensible, and this says why in the document
 * rather than leaving a reader to infer it from a missing word.
 */
export function declaredMethodSentence(d: DeclaredBasis): string {
  const who = d.statedBy ? `operator ${d.statedBy}` : 'an operator';
  const instrument = instrumentPhrase(d.instrument);
  if (d.method === 'site-measure' && d.defensible) {
    return `Measured on site by ${who} ${instrument}.`;
  }
  if (d.method === 'site-measure') {
    return `Declared a site measurement by ${who}, but no instrument was named, `
      + 'so the accuracy behind it is undeclared and it is shown as indicative.';
  }
  if (d.method === 'estimate') {
    return `Entered by ${who} as an estimate, not measured. Shown as indicative.`;
  }
  return `Declared by ${who}${d.method ? ` by a method recorded as "${d.method}"` : ''}, `
    + `${instrument}. This document does not recognise that method, so the figure is `
    + 'shown as indicative.';
}

function instrumentPhrase(instrument: string | undefined): string {
  switch (instrument) {
    case 'laser': return 'with a laser distance meter (manufacturer accuracy ±3 mm)';
    case 'tape': return 'with a steel tape (±10 mm over a room-sized run)';
    case 'unknown': return 'with an instrument recorded as unknown';
    case undefined: return 'with no instrument recorded';
    default: return `with an instrument recorded as "${instrument}"`;
  }
}

export interface FigureInput {
  readonly id: string;
  readonly subject: string;
  readonly what: string;
  readonly quantity: Quantity;
  /** What produced the number, when the engine produced it. */
  readonly basis: string;
  /** The row grounding whose receipts say whether a person touched this fact. */
  readonly rowGrounding?: Grounding;
  readonly declared?: DeclaredBasis | null;
}

export type FigureResult =
  | { readonly ok: true; readonly figure: Figure }
  | { readonly ok: false; readonly figure: UnpresentableFigure };

/**
 * Build a printable figure, or a printable explanation of why there is none.
 *
 * `formatQuantity` calls `assertDisplayable`, which throws for a quantity with
 * no standard, no tolerance or no grounding. That throw is correct and this
 * catch does not soften it: the figure does not become a number, it becomes a
 * row that says a dimension in this world cannot be shown and why. The
 * alternative -- letting it propagate -- costs the other forty figures and
 * tells the operator nothing about which one was broken.
 */
export function buildFigure(input: FigureInput, locale = 'en-GB'): FigureResult {
  let formatted;
  try {
    formatted = formatQuantity(input.quantity, { locale });
  } catch (err) {
    return {
      ok: false,
      figure: {
        id: input.id,
        subject: input.subject,
        what: input.what,
        reason: `${err instanceof Error ? err.message : String(err)}. `
          + 'A dimension without a declared standard and a tolerance is not a measurement, '
          + 'so it is named here rather than printed as a number.',
      },
    };
  }

  const receipts = readReceipts(input.rowGrounding);
  const declared = input.declared ?? undefined;
  const presentation = presentationOf(input.quantity, declared);

  const reason = declared
    ? (declared.defensible ? undefined : plainDeclaredReason(declared))
    : (isDefensible(input.quantity) ? undefined : (formatted.statusNote
        ?? refusalReason(input.quantity)
        ?? 'The engine will not stand behind this figure as a measurement.'));

  return {
    ok: true,
    figure: {
      id: input.id,
      subject: input.subject,
      what: input.what,
      formatted,
      value: input.quantity.value,
      unit: input.quantity.unit,
      standard: input.quantity.standard,
      tolerance: input.quantity.tolerance,
      toleranceUnit: input.quantity.toleranceUnit,
      presentation,
      confidence: Number.isFinite(input.quantity.grounding?.confidence)
        ? input.quantity.grounding.confidence
        : 0,
      provenanceLabel: formatted.provenanceLabel,
      ...(reason ? { reason } : {}),
      basis: declared ? declaredMethodSentence(declared) : input.basis,
      ...(declared ? { declared } : {}),
      humanTouched: receipts.correctionIds.length > 0,
      operators: receipts.operators,
    },
  };
}

function presentationOf(q: Quantity, declared: DeclaredBasis | undefined): FigurePresentation {
  if (declared) return declared.defensible ? 'declared' : 'declared-indicative';
  return isDefensible(q) ? 'measured' : 'indicative';
}

function plainDeclaredReason(d: DeclaredBasis): string {
  if (d.refusalReason) return capitalise(d.refusalReason);
  if (d.method === 'estimate') {
    return 'This figure was entered by an operator as an estimate, not measured.';
  }
  return 'This figure was declared by a person and the accuracy behind it is undeclared.';
}

function capitalise(s: string): string {
  return s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;
}

// ---------------------------------------------------------------------------
// Attaching wv_measurement rows to the world
// ---------------------------------------------------------------------------

/**
 * The figure id a measurement row is about.
 *
 * `wv-worlds` writes `a` as `{ type, id, field }`. The ids below are the same
 * ones `certificate.ts` mints for the world's own dimensions, which is what
 * lets a declared measurement replace the reconstruction's figure in the table
 * rather than appearing beside it as a second, contradictory row.
 *
 * Returns null for a row this document cannot place. Those are not discarded:
 * the certificate lists them under measurements it could not attach, because a
 * measurement record nobody can see is a record that might as well not exist.
 */
export function figureIdOfRecord(record: MeasurementRecord): string | null {
  const a = record.a;
  const type = typeof a['type'] === 'string' ? a['type'] : null;
  const id = typeof a['id'] === 'string' ? a['id'] : null;
  const field = typeof a['field'] === 'string' ? a['field'] : null;
  if (!type || !id || !field) return null;
  if (type === 'room' && (field === 'area' || field === 'ceilingHeight')) {
    return `room:${id}:${field}`;
  }
  if (type === 'opening' && (field === 'width' || field === 'height' || field === 'sill')) {
    return `opening:${id}:${field}`;
  }
  return null;
}

export interface AttachedMeasurements {
  /** Figure id to the newest declared record for it. */
  readonly current: ReadonlyMap<string, MeasurementRecord>;
  /** Figure id to older declared records, newest first. */
  readonly superseded: ReadonlyMap<string, readonly MeasurementRecord[]>;
  /** Records that are not human declarations: pipeline or viewer measurements. */
  readonly pipeline: readonly MeasurementRecord[];
  /** Records whose subject is not in this world. */
  readonly unplaceable: readonly MeasurementRecord[];
}

/**
 * Index declared measurements by the figure they supersede.
 *
 * Newest wins, by `createdAt`. An operator who measures a room twice has
 * changed their mind, not created an ambiguity, and the older reading is kept
 * so the certificate can say how many times a figure has been restated -- a
 * dimension that has been declared three times is a fact about the survey
 * worth seeing.
 *
 * Ties are broken by id so that two rows written in the same millisecond
 * always order the same way. Two certificates of the same world must be
 * identical, and a Map iteration order that depended on fetch order would
 * break that for no reason a reader could ever diagnose.
 */
export function attachMeasurements(
  records: readonly MeasurementRecord[], knownFigureIds: ReadonlySet<string>,
): AttachedMeasurements {
  const byFigure = new Map<string, MeasurementRecord[]>();
  const pipeline: MeasurementRecord[] = [];
  const unplaceable: MeasurementRecord[] = [];

  for (const record of records) {
    if (readDeclaredBasis(record.basis) === null) { pipeline.push(record); continue; }
    const figureId = figureIdOfRecord(record);
    if (!figureId || !knownFigureIds.has(figureId)) { unplaceable.push(record); continue; }
    const list = byFigure.get(figureId);
    if (list) list.push(record); else byFigure.set(figureId, [record]);
  }

  const current = new Map<string, MeasurementRecord>();
  const superseded = new Map<string, readonly MeasurementRecord[]>();
  for (const [figureId, list] of byFigure) {
    const sorted = [...list].sort(byNewestThenId);
    current.set(figureId, sorted[0]!);
    if (sorted.length > 1) superseded.set(figureId, sorted.slice(1));
  }
  return { current, superseded, pipeline, unplaceable };
}

function byNewestThenId(a: MeasurementRecord, b: MeasurementRecord): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const va = Number.isNaN(ta) ? 0 : ta;
  const vb = Number.isNaN(tb) ? 0 : tb;
  if (va !== vb) return vb - va;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The quantity a declared measurement asserts.
 *
 * Built from the record rather than from the row, because the row's stored
 * tolerance is deliberately NOT the instrument's: `wv-worlds` keeps
 * `area_tol_pct` at the pipeline's value so that the world's recovered policy
 * does not retighten for every surface in the property because one room was
 * lasered. The defensible half-width lives on the measurement row, "which is
 * what a certificate is issued from" -- and this is that certificate, so it
 * issues from the row that says so.
 */
export function declaredQuantity(record: MeasurementRecord, grounding: Grounding): Quantity {
  const basis = readDeclaredBasis(record.basis);
  return {
    value: record.value,
    unit: record.unit,
    standard: record.standard as Quantity['standard'],
    tolerance: record.tolerance,
    toleranceUnit: record.toleranceUnit === 'pct' ? 'pct' : 'mm',
    grounding: {
      provenance: grounding.provenance,
      confidence: Number.isFinite(record.confidence) ? record.confidence : grounding.confidence,
      ...(grounding.sources ? { sources: grounding.sources } : {}),
    },
    basis: {
      ...record.basis,
      // `isDefensible` reads exactly this key, so a declared estimate renders
      // as indicative in the viewer's formatter with no special case here.
      defensible: basis?.defensible === true,
      measurementId: record.id,
      measuredAt: record.createdAt,
    },
  };
}
