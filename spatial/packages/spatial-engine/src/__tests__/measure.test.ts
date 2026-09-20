import { describe, expect, it } from 'vitest';
import {
  areaQuantity, combineInQuadrature, Evidence, isDefensible, lengthQuantity,
  PROVENANCE_TOLERANCE_FACTOR, refusalReason, toleranceFactor,
} from '../measure.js';
import { World } from '../world.js';
import { emptyDoc } from '../__fixtures__/minimal.js';
import { FLAT } from '../__fixtures__/flat.js';

const doc = emptyDoc();

describe('tolerance accumulation', () => {
  it('combines half-widths in quadrature, not linearly', () => {
    expect(combineInQuadrature([20])).toBeCloseTo(20, 12);
    expect(combineInQuadrature([20, 20])).toBeCloseTo(20 * Math.SQRT2, 12);
    expect(combineInQuadrature([3, 4])).toBeCloseTo(5, 12);
    expect(combineInQuadrature([])).toBe(0);
    expect(combineInQuadrature([20, NaN, 20])).toBeCloseTo(20 * Math.SQRT2, 12);
  });

  it('gives a single segment exactly the policy tolerance', () => {
    const ev = new Evidence().addProvenance('reconstructed');
    expect(lengthQuantity(doc, 3, ev, { segments: 1 }).tolerance).toBeCloseTo(20, 12);
  });

  it('grows a chain as sqrt(n), so twelve segments is 3.46x not 12x', () => {
    const ev = new Evidence().addProvenance('reconstructed');
    const one = lengthQuantity(doc, 1, ev, { segments: 1 }).tolerance;
    const twelve = lengthQuantity(doc, 12, ev, { segments: 12 }).tolerance;
    expect(twelve / one).toBeCloseTo(Math.sqrt(12), 9);
    expect(twelve).toBeLessThan(one * 12);
  });

  it('accepts per-segment half-widths', () => {
    const ev = new Evidence().addProvenance('reconstructed');
    const q = lengthQuantity(doc, 1, ev, { segmentToleranceMm: [3, 4] });
    expect(q.tolerance).toBeCloseTo(5, 12);
  });

  it('inflates the interval monotonically as provenance weakens', () => {
    const t = (p: Parameters<typeof toleranceFactor>[0]): number =>
      lengthQuantity(doc, 1, new Evidence().addProvenance(p), { segments: 1 }).tolerance;
    expect(t('observed')).toBeCloseTo(20, 9);
    expect(t('reconstructed')).toBeCloseTo(20, 9);
    expect(t('inferred')).toBeCloseTo(40, 9);
    expect(t('generated')).toBeCloseTo(80, 9);
    expect(PROVENANCE_TOLERANCE_FACTOR.observed)
      .toBeLessThanOrEqual(PROVENANCE_TOLERANCE_FACTOR.generated);
  });

  it('reports area tolerance as the larger of the policy floor and the geometry', () => {
    const ev = new Evidence().addProvenance('reconstructed');
    // Chunky room: policy floor wins.
    const chunky = areaQuantity(doc, 20, ev, { perimeter: 18 });
    expect(chunky.tolerance).toBeCloseTo(2.5, 9);
    // Long thin room: 20 mm on a 60 m perimeter over 6 m2 is 20%.
    const thin = areaQuantity(doc, 6, ev, { perimeter: 60 });
    expect(thin.tolerance).toBeCloseTo(20, 9);
    expect(thin.toleranceUnit).toBe('pct');
  });
});

describe('Evidence', () => {
  it('keeps the weakest provenance regardless of order', () => {
    expect(new Evidence().addProvenance('observed').addProvenance('inferred').provenance)
      .toBe('inferred');
    expect(new Evidence().addProvenance('inferred').addProvenance('observed').provenance)
      .toBe('inferred');
    expect(new Evidence()
      .addProvenance('observed').addProvenance('generated').addProvenance('reconstructed')
      .provenance).toBe('generated');
  });

  it('keeps the lowest confidence and the union of sources', () => {
    const ev = new Evidence()
      .addGrounding({ provenance: 'observed', confidence: 0.9, sources: ['cam_a'] })
      .addGrounding({ provenance: 'reconstructed', confidence: 0.4, sources: ['cam_b', 'cam_a'] });
    const gr = ev.grounding();
    expect(gr.provenance).toBe('reconstructed');
    expect(gr.confidence).toBeCloseTo(0.4, 12);
    expect([...(gr.sources ?? [])].sort()).toEqual(['cam_a', 'cam_b']);
  });

  it('defaults to inferred when nothing was consulted', () => {
    expect(new Evidence().provenance).toBe('inferred');
  });
});

describe('measurement honesty end to end', () => {
  const w = World.fromDocument(FLAT);

  it('propagates the weakest source into a distance', () => {
    // e_chest_drawers is inferred; everything around it is observed.
    const q = w.measureDistance({ entityId: 'e_chest_drawers' }, { entityId: 'e_bed_double' });
    expect(q.grounding.provenance).toBe('inferred');
    expect(q.tolerance).toBeCloseTo(40, 9);
    expect(isDefensible(q)).toBe(true);

    const observed = w.measureDistance({ entityId: 'e_bedside_a' }, { entityId: 'e_bed_double' });
    expect(observed.grounding.provenance).toBe('reconstructed');
    expect(observed.tolerance).toBeCloseTo(20, 9);
  });

  it('refuses a measurement that reaches into generated geometry', () => {
    const q = w.measureDistance([10.40, 1.00, 2.80], { entityId: 'e_bed_double' });
    expect(q.grounding.provenance).toBe('generated');
    expect(isDefensible(q)).toBe(false);
    expect(refusalReason(q)).toMatch(/generated/);
    expect(q.tolerance).toBeCloseTo(80, 9);
  });

  it('marks a room area that includes unobserved floor as not defensible', () => {
    const bed1 = w.measureArea('r_bed1');
    expect(bed1.grounding.provenance).toBe('generated');
    expect(isDefensible(bed1)).toBe(false);
    // ...while the rooms that were fully observed stay defensible.
    expect(isDefensible(w.measureArea('r_kitchen'))).toBe(true);
    expect(isDefensible(w.measureArea('r_hall'))).toBe(true);
  });

  it('ignores an unobserved ceiling when measuring a floor area', () => {
    // The bathroom ceiling is inferred, but area is a floor-plane measurement.
    const bath = w.measureArea('r_bath');
    expect(bath.grounding.provenance).toBe('reconstructed');
    expect(isDefensible(bath)).toBe(true);
  });

  it('carries provenance into a path length', () => {
    const path = w.findPath('r_kitchen', 'r_bed2')!;
    expect(path.length.grounding.provenance).toBe('reconstructed');
    const hops = path.nodes.length - 1;
    expect(path.length.tolerance).toBeCloseTo(20 * Math.sqrt(hops), 6);
  });
});
