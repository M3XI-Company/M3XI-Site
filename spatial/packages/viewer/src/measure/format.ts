import type { MeasurementStandard, Provenance, Quantity } from '@m3xi/world-core';
import { isDefensible, refusalReason } from '@m3xi/spatial-engine';

/**
 * One formatter, and it cannot produce a bare number.
 *
 * `FormattedQuantity.full` always contains the value, the tolerance and the
 * standard, and every surface in the viewer renders `full` or renders the
 * three parts together. There is no code path that turns a `Quantity` into a
 * string of digits, which is the point: the UK mis-measurement record is what
 * happens when a number reaches a customer without the standard that defines
 * it, and under the DMCC Act 2024 that is directly enforceable against the
 * agent showing it.
 *
 * `status` is the second half of the promise. `isDefensible` on a Quantity is
 * false when the geometry behind it was generated or never observed. The
 * viewer does not hide those measurements -- hiding them is its own kind of
 * lie, because the customer then cannot tell "we didn't measure it" from "it
 * isn't there". It shows the number, plainly marked as indicative, with the
 * reason in words.
 */

export interface FormatOptions {
  readonly locale?: string;
  /** Add a feet-and-inches secondary. UK agency particulars still quote both. */
  readonly imperial?: boolean;
  /** Significant decimals for metres. 2 is a centimetre, which is honest. */
  readonly decimals?: number;
}

export interface FormattedQuantity {
  /** "13.95 m²" -- never shown without `tolerance` and `standardShort`. */
  readonly value: string;
  /** "±2.5% (±0.35 m²)" or "±20 mm". */
  readonly tolerance: string;
  /** "13.60 to 14.30 m²" -- the interval the number actually asserts. */
  readonly range: string;
  readonly standard: string;
  readonly standardShort: string;
  readonly provenance: Provenance;
  readonly provenanceLabel: string;
  readonly status: 'defensible' | 'indicative';
  /** Plain English reason when `status` is 'indicative'. */
  readonly statusNote?: string;
  /** Single line safe to render anywhere: value + tolerance + standard. */
  readonly full: string;
  /** Expanded for a screen reader: no symbols, no abbreviations. */
  readonly speech: string;
  readonly imperial?: string;
}

const STANDARD_LABEL: Record<MeasurementStandard, { long: string; short: string }> = {
  'RICS-COMP-GIA': {
    long: 'RICS Code of Measuring Practice, gross internal area',
    short: 'RICS GIA',
  },
  'RICS-COMP-NIA': {
    long: 'RICS Code of Measuring Practice, net internal area',
    short: 'RICS NIA',
  },
  'IPMS-3C': {
    long: 'IPMS 3C, occupier level, measured to the internal dominant face',
    short: 'IPMS 3C',
  },
  'CLEAR-INTERNAL': {
    long: 'clear internal, wall face to wall face, no standard implied',
    short: 'clear internal',
  },
};

const PROVENANCE_LABEL: Record<Provenance, string> = {
  observed: 'photographed',
  reconstructed: 'measured from the photographs',
  inferred: 'estimated',
  generated: 'not surveyed',
};

const UNIT_SYMBOL: Record<Quantity['unit'], string> = {
  m: 'm', m2: 'm²', m3: 'm³', deg: '°',
};

const UNIT_SPOKEN: Record<Quantity['unit'], [string, string]> = {
  m: ['metre', 'metres'],
  m2: ['square metre', 'square metres'],
  m3: ['cubic metre', 'cubic metres'],
  deg: ['degree', 'degrees'],
};

/**
 * Guard for the boundary. A Quantity that reached the viewer without a
 * standard or a tolerance is a pipeline bug, and rendering it anyway would
 * launder that bug into a claim. Throwing is the correct response.
 */
export function assertDisplayable(q: Quantity): void {
  if (!q || typeof q.value !== 'number' || !Number.isFinite(q.value)) {
    throw new TypeError('quantity has no finite value');
  }
  if (!q.standard) throw new TypeError('quantity has no declared standard; refusing to display it');
  if (typeof q.tolerance !== 'number' || !Number.isFinite(q.tolerance)) {
    throw new TypeError('quantity has no tolerance; refusing to display it');
  }
  if (!q.grounding) throw new TypeError('quantity has no grounding; refusing to display it');
}

export function formatQuantity(q: Quantity, opts: FormatOptions = {}): FormattedQuantity {
  assertDisplayable(q);
  const locale = opts.locale ?? 'en-GB';
  const decimals = opts.decimals ?? (q.unit === 'm' ? 2 : q.unit === 'deg' ? 0 : 2);
  const sym = UNIT_SYMBOL[q.unit];

  const num = (v: number, d = decimals): string =>
    v.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });

  const value = `${num(q.value)} ${sym}`;

  // Absolute half-width in the quantity's own unit, whichever way it was stated.
  const absolute = q.toleranceUnit === 'mm'
    ? q.tolerance / 1000
    : (q.tolerance / 100) * Math.abs(q.value);

  const tolerance = q.toleranceUnit === 'mm'
    ? `±${num(q.tolerance, 0)} mm`
    : `±${num(q.tolerance, 1)}% (±${num(absolute)} ${sym})`;

  const range = `${num(q.value - absolute)} to ${num(q.value + absolute)} ${sym}`;

  const label = STANDARD_LABEL[q.standard] ?? { long: q.standard, short: q.standard };
  const provenance = q.grounding.provenance;
  const defensible = isDefensible(q);
  const reason = refusalReason(q);

  const full = `${value} ${tolerance} · ${label.short}`;

  const [singular, plural] = UNIT_SPOKEN[q.unit];
  const unitWord = Math.abs(q.value - 1) < 1e-9 ? singular : plural;
  const spokenTolerance = q.toleranceUnit === 'mm'
    ? `plus or minus ${num(q.tolerance, 0)} millimetres`
    : `plus or minus ${num(q.tolerance, 1)} per cent`;
  const speechParts = [
    `${num(q.value)} ${unitWord}, ${spokenTolerance}, measured to ${label.long}`,
  ];
  if (!defensible) {
    speechParts.push(`This figure is indicative only. ${plainReason(reason, provenance)}`);
  }

  const out: FormattedQuantity = {
    value,
    tolerance,
    range,
    standard: label.long,
    standardShort: label.short,
    provenance,
    provenanceLabel: PROVENANCE_LABEL[provenance],
    status: defensible ? 'defensible' : 'indicative',
    full,
    speech: speechParts.join(' '),
    ...(defensible ? {} : { statusNote: plainReason(reason, provenance) }),
    ...(opts.imperial && (q.unit === 'm' || q.unit === 'm2')
      ? { imperial: toImperial(q, locale) }
      : {}),
  };
  return out;
}

/**
 * The engine's refusal reasons are written for engineers. A visitor gets the
 * same fact in the words an estate agent would have to use in writing.
 */
function plainReason(reason: string | undefined, provenance: Provenance): string {
  if (reason && reason.includes('generated geometry')) {
    return 'Part of what this measurement crosses was filled in by a model, not photographed, so we cannot stand behind the figure.';
  }
  if (reason && reason.includes('no camera observed')) {
    return 'This measurement reaches into a part of the property the cameras never saw, so we cannot stand behind the figure.';
  }
  if (provenance === 'inferred') {
    return 'Part of this measurement was estimated rather than measured directly.';
  }
  return 'We cannot stand behind this figure as a measurement.';
}

/** Feet and inches, rounded to the nearest inch; square feet to the unit. */
function toImperial(q: Quantity, locale: string): string {
  if (q.unit === 'm2') {
    const sqft = q.value * 10.7639104167;
    return `${Math.round(sqft).toLocaleString(locale)} sq ft`;
  }
  const totalInches = q.value * 39.3700787402;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - feet * 12);
  return inches === 12 ? `${feet + 1}′ 0″` : `${feet}′ ${inches}″`;
}

/**
 * Room dimensions as agencies write them: "4.50 m x 3.10 m (14′ 9″ x 10′ 2″)".
 * Both numbers carry the same tolerance, which is stated once after them.
 */
export function formatExtent(
  widthM: number, depthM: number, tolMm: number, opts: FormatOptions = {},
): string {
  const locale = opts.locale ?? 'en-GB';
  const n = (v: number): string =>
    v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const metric = `${n(widthM)} m × ${n(depthM)} m`;
  const tol = `±${tolMm.toLocaleString(locale, { maximumFractionDigits: 0 })} mm`;
  if (!opts.imperial) return `${metric} ${tol}`;
  const ft = (v: number): string => {
    const t = v * 39.3700787402;
    const f = Math.floor(t / 12);
    const i = Math.round(t - f * 12);
    return i === 12 ? `${f + 1}′ 0″` : `${f}′ ${i}″`;
  };
  return `${metric} (${ft(widthM)} × ${ft(depthM)}) ${tol}`;
}
