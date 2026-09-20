import type {
  Grounding, MeasurementStandard, Provenance, Quantity, WorldDocument,
} from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';

/**
 * Measurement honesty lives here. Three rules, all of them deliberate.
 *
 * 1. PROVENANCE IS THE WEAKEST LINK. A number is only as trustworthy as the
 *    flimsiest piece of geometry it touched, so every measurement accumulates
 *    the groundings it consulted and reports `weakestProvenance` of them. A
 *    distance from an observed sofa to an inferred wall is an inferred
 *    distance, and saying otherwise is the misrepresentation the DMCC Act
 *    makes actionable.
 *
 * 2. TOLERANCE PROPAGATES IN QUADRATURE, NOT LINEARLY. The policy's
 *    `wallToleranceMm` is the half-width of the interval on a single
 *    reconstructed length -- one wall, one gap, one segment. Errors in
 *    independently reconstructed segments are not systematically aligned: they
 *    come from independent surface fits, so their variances add and their
 *    half-widths combine as sqrt(sum of squares). Adding them linearly would
 *    quote a 12-segment corridor path at 12x the wall tolerance, which
 *    overstates the uncertainty by about 3.5x and makes every path length
 *    useless. Adding them not at all would understate it.
 *
 *    Formally: for a chain of n segments with per-segment half-widths t_i,
 *      t_total = sqrt( sum_i t_i^2 ).
 *    For n identical segments this is t*sqrt(n), the standard random-walk
 *    result. A single segment returns exactly the policy tolerance, which is
 *    the behaviour the policy is written to describe.
 *
 * 3. WEAKER PROVENANCE WIDENS THE INTERVAL. The policy tolerance is stated for
 *    geometry that was actually reconstructed from observations. Inferred
 *    geometry (a wall closed by a layout prior) and generated geometry (infill
 *    behind a wardrobe nobody scanned) have no such guarantee, so the interval
 *    is inflated by a fixed, monotone factor. The factors below are a
 *    deliberately conservative engineering choice, not a derivation -- they
 *    live in one exported table so a surveyor can retune them against field
 *    data without touching the geometry code.
 */
export const PROVENANCE_TOLERANCE_FACTOR: Readonly<Record<Provenance, number>> = {
  observed: 1,
  reconstructed: 1,
  inferred: 2,
  generated: 4,
};

/**
 * Length measurements are reported against CLEAR-INTERNAL: face to face, no
 * standard implied. RICS GIA/NIA and IPMS 3C are area standards and saying a
 * sofa-to-window distance is "RICS GIA" would be a category error, whatever
 * the document's area policy says.
 */
export const LENGTH_STANDARD: MeasurementStandard = 'CLEAR-INTERNAL';

/** Accumulates every grounding a measurement touched. */
export class Evidence {
  private worst: Provenance | null = null;
  private minConfidence = 1;
  private readonly sourceSet = new Set<string>();
  private sawUnobserved = false;

  addGrounding(g: Grounding | undefined | null): this {
    if (!g) return this;
    this.addProvenance(g.provenance);
    if (Number.isFinite(g.confidence)) {
      this.minConfidence = Math.min(this.minConfidence, Math.max(0, Math.min(1, g.confidence)));
    }
    if (g.sources) for (const s of g.sources) this.sourceSet.add(s);
    return this;
  }

  addProvenance(p: Provenance): this {
    this.worst = this.worst === null ? p : weakestProvenance(this.worst, p);
    return this;
  }

  markUnobserved(): this {
    this.sawUnobserved = true;
    return this;
  }

  get unobserved(): boolean {
    return this.sawUnobserved;
  }

  /**
   * With nothing added we know nothing, and 'inferred' is the honest floor:
   * calling it 'observed' would assert a camera saw something we never looked
   * up, calling it 'generated' would refuse a measurement that may be fine.
   */
  get provenance(): Provenance {
    return this.worst ?? 'inferred';
  }

  get confidence(): number {
    return this.worst === null ? 0.5 : this.minConfidence;
  }

  grounding(): Grounding {
    const sources = [...this.sourceSet];
    return sources.length > 0
      ? { provenance: this.provenance, confidence: this.confidence, sources }
      : { provenance: this.provenance, confidence: this.confidence };
  }
}

export function toleranceFactor(p: Provenance): number {
  return PROVENANCE_TOLERANCE_FACTOR[p];
}

/** sqrt(sum of squares) of per-segment half-widths. See rule 2 above. */
export function combineInQuadrature(halfWidths: readonly number[]): number {
  let s = 0;
  for (const t of halfWidths) {
    if (!Number.isFinite(t)) continue;
    s += t * t;
  }
  return Math.sqrt(s);
}

export interface LengthOpts {
  /** Number of independently reconstructed segments the length is made of. */
  readonly segments?: number;
  readonly basis?: Readonly<Record<string, unknown>>;
  /** Per-segment half-widths, when they are not all the policy default. */
  readonly segmentToleranceMm?: readonly number[];
}

export function lengthQuantity(
  doc: WorldDocument, metres: number, ev: Evidence, opts: LengthOpts = {},
): Quantity {
  const policy = doc.measurementPolicy;
  const base = Number.isFinite(policy?.wallToleranceMm) ? policy.wallToleranceMm : 25;
  const factor = toleranceFactor(ev.provenance);
  const perSegment = opts.segmentToleranceMm
    ? opts.segmentToleranceMm.map((t) => t * factor)
    : new Array(Math.max(1, Math.floor(opts.segments ?? 1))).fill(base * factor) as number[];
  const tolerance = combineInQuadrature(perSegment);
  return {
    value: metres,
    unit: 'm',
    standard: LENGTH_STANDARD,
    tolerance,
    toleranceUnit: 'mm',
    grounding: ev.grounding(),
    basis: buildBasis(ev, {
      segments: perSegment.length,
      perSegmentToleranceMm: perSegment.length === 1 ? perSegment[0] : perSegment,
      provenanceToleranceFactor: factor,
      ...(opts.basis ?? {}),
    }),
  };
}

export interface AreaOpts {
  /** Boundary perimeter in metres, used to propagate an edge-offset error. */
  readonly perimeter?: number;
  readonly basis?: Readonly<Record<string, unknown>>;
}

/**
 * Area tolerance is a percentage, per the contract.
 *
 * The declared `areaTolerancePct` is a floor, not the whole story: a long thin
 * room is far more sensitive to a wall-position error than a square one. For a
 * polygon of area A and perimeter P, offsetting every edge outwards by delta
 * changes the area by about delta*P, so the relative half-width is delta*P/A
 * with delta = wallToleranceMm. We report the LARGER of that and the declared
 * policy percentage, because quoting the policy number on a 1.7 m wide hall
 * would understate what the geometry can actually support.
 */
export function areaQuantity(
  doc: WorldDocument, m2: number, ev: Evidence, opts: AreaOpts = {},
): Quantity {
  const policy = doc.measurementPolicy;
  const factor = toleranceFactor(ev.provenance);
  const policyPct = (Number.isFinite(policy?.areaTolerancePct) ? policy.areaTolerancePct : 3) * factor;
  const deltaM = ((Number.isFinite(policy?.wallToleranceMm) ? policy.wallToleranceMm : 25) / 1000) * factor;
  let geometricPct = 0;
  if (opts.perimeter && m2 > 1e-6 && Number.isFinite(opts.perimeter)) {
    geometricPct = (deltaM * opts.perimeter / m2) * 100;
  }
  const tolerance = Math.max(policyPct, geometricPct);
  return {
    value: m2,
    unit: 'm2',
    standard: policy?.areaStandard ?? 'CLEAR-INTERNAL',
    tolerance,
    toleranceUnit: 'pct',
    grounding: ev.grounding(),
    basis: buildBasis(ev, {
      policyTolerancePct: policyPct,
      geometricTolerancePct: geometricPct,
      perimeterM: opts.perimeter,
      provenanceToleranceFactor: factor,
      ...(opts.basis ?? {}),
    }),
  };
}

/**
 * Refusal, expressed inside the contract rather than beside it.
 *
 * `Quantity` has no refusal field and this engine does not get to change the
 * contract, so a measurement that leans on generated or unobserved geometry
 * still returns a number -- but carries `basis.defensible = false` plus the
 * reason, and its grounding says 'generated'. Callers use `isDefensible`; the
 * agent layer turns a false into "I can measure that, but nothing observed
 * supports it" rather than quoting the figure as fact.
 */
function buildBasis(
  ev: Evidence, extra: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const defensible = ev.provenance !== 'generated' && !ev.unobserved;
  const reasons: string[] = [];
  if (ev.provenance === 'generated') {
    reasons.push('measurement touches generated geometry: no observation supports it');
  }
  if (ev.unobserved) {
    reasons.push('measurement touches a volume no camera observed');
  }
  const basis: Record<string, unknown> = { ...extra, defensible };
  if (reasons.length > 0) basis['refusalReason'] = reasons.join('; ');
  return basis;
}

export function isDefensible(q: Quantity): boolean {
  return q.basis?.['defensible'] !== false;
}

export function refusalReason(q: Quantity): string | undefined {
  const r = q.basis?.['refusalReason'];
  return typeof r === 'string' ? r : undefined;
}
