/**
 * Phrasing.
 *
 * Templates, not a model. A distance answer has one correct shape and putting
 * a language model in charge of it buys nothing and risks everything: the
 * number, the tolerance and the standard all have to appear, and a model that
 * drops the tolerance to sound natural has manufactured a liability.
 *
 * Under the Digital Markets, Competition and Consumers Act 2024 a misleading
 * representation about a property is directly enforceable, and the UK
 * mis-measurement record -- roughly one in eight London properties out by more
 * than 100 sq ft, most of them overstated -- is what happens when nobody
 * declares which standard they used. So every quantity this file prints
 * carries its tolerance, and area additionally carries its standard.
 */

import type { Provenance, Quantity } from '@m3xi/world-core';
import { isDefensible, refusalReason } from '@m3xi/spatial-engine';

const SQ_FT_PER_SQ_M = 10.7639104167;
const FT_PER_M = 3.280839895;

export function formatLength(q: Quantity): string {
  const m = q.value;
  const tol = q.tolerance;
  const feet = Math.floor(m * FT_PER_M);
  const inches = Math.round((m * FT_PER_M - feet) * 12);
  const imperial = inches === 12
    ? `${feet + 1} ft`
    : inches === 0 ? `${feet} ft` : `${feet} ft ${inches} in`;
  // Tolerance is printed in millimetres because that is the unit the
  // measurement policy is written in, and rounding it away would be the exact
  // sleight of hand this product exists to avoid.
  return `${m.toFixed(2)} m (${imperial}), give or take ${Math.round(tol)} mm`;
}

export function formatShortLength(q: Quantity): string {
  return `${q.value.toFixed(2)} m`;
}

export function formatArea(q: Quantity): string {
  const sqft = Math.round(q.value * SQ_FT_PER_SQ_M);
  return `${q.value.toFixed(1)} m² (${sqft} sq ft), ±${q.tolerance.toFixed(1)}%, measured to ${standardName(q.standard)}`;
}

export function standardName(s: string): string {
  switch (s) {
    case 'RICS-COMP-GIA': return 'RICS gross internal area';
    case 'RICS-COMP-NIA': return 'RICS net internal area';
    case 'IPMS-3C': return 'IPMS 3C';
    case 'CLEAR-INTERNAL': return 'clear internal, wall face to wall face';
    default: return s;
  }
}

/**
 * The sentence that keeps a soft number honest. Returned as a suffix rather
 * than folded into the number so a caller can decide to refuse outright.
 */
export function provenanceCaveat(p: Provenance, confidence: number): string | null {
  switch (p) {
    case 'observed':
      return null;
    case 'reconstructed':
      // The normal case for geometry. Saying so on every sentence would be
      // noise; the tolerance already carries the uncertainty.
      return confidence < 0.7
        ? 'the reconstruction here is less certain than elsewhere in the capture'
        : null;
    case 'inferred':
      return 'this part was estimated rather than directly observed, so treat it as indicative';
    case 'generated':
      return 'no camera saw this — the geometry here was filled in by a model';
  }
}

/** A quantity that cannot be defended is never quoted as a fact. */
export function quantityRefusal(q: Quantity): string | null {
  if (isDefensible(q)) return null;
  const why = refusalReason(q) ?? 'the capture does not support this measurement';
  return `I can compute a figure, but I won't quote it: ${why}.`;
}

export function joinList(items: readonly string[], conjunction = 'and'): string {
  const xs = items.filter((s) => s.length > 0);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0]!;
  if (xs.length === 2) return `${xs[0]} ${conjunction} ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')} ${conjunction} ${xs[xs.length - 1]}`;
}

/** "3 chairs" / "1 chair", with the label already singular. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  if (n === 1) return `1 ${singular}`;
  return `${n} ${pluralForm ?? pluraliseLabel(singular)}`;
}

export function pluraliseLabel(label: string): string {
  if (/(s|x|z|ch|sh)$/i.test(label)) return `${label}es`;
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

/**
 * Group repeated labels: four dining chairs read as "4 dining chairs", not as
 * four separate sentences.
 */
export function summariseLabels(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const parts: string[] = [];
  for (const [label, n] of counts) parts.push(plural(n, label));
  return joinList(parts);
}

export function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
