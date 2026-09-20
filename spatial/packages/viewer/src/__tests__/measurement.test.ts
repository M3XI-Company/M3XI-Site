import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type { Quantity } from '@m3xi/world-core';
import { assertDisplayable, formatExtent, formatQuantity } from '../measure/format.js';
import { COMMON_FITS, MeasurementSession } from '../measure/session.js';

const world = World.fromDocument(FLAT);

describe('a number never leaves this system alone', () => {
  const area = world.measureArea('r_kitchen');
  const f = formatQuantity(area, { locale: 'en-GB' });

  it('renders the value with its unit', () => {
    expect(f.value).toMatch(/^[\d.,]+ m²$/);
  });

  it('renders a percentage tolerance with its absolute equivalent', () => {
    expect(f.tolerance).toMatch(/^±[\d.]+% \(±[\d.,]+ m²\)$/);
  });

  it('names the declared standard in full and in short', () => {
    expect(f.standard).toBe('RICS Code of Measuring Practice, gross internal area');
    expect(f.standardShort).toBe('RICS GIA');
  });

  it('puts value, tolerance and standard in the one-line form', () => {
    expect(f.full).toContain(f.value);
    expect(f.full).toContain('±');
    expect(f.full).toContain('RICS GIA');
  });

  it('states the interval the figure actually asserts', () => {
    expect(f.range).toMatch(/ to /);
    const lo = Number(f.range.split(' to ')[0]!.replace(/,/g, ''));
    expect(lo).toBeLessThan(area.value);
  });

  it('spells the whole thing out for a screen reader', () => {
    expect(f.speech).toContain('square metres');
    expect(f.speech).toContain('per cent');
    expect(f.speech).toContain('RICS Code of Measuring Practice');
    expect(f.speech).not.toContain('±');
  });

  it('offers an imperial secondary when asked, and not otherwise', () => {
    expect(formatQuantity(area, { imperial: true }).imperial).toMatch(/sq ft$/);
    expect(formatQuantity(area).imperial).toBeUndefined();
  });

  it('formats a length tolerance in millimetres', () => {
    const d = world.measureDistance({ entityId: 'e_sofa' }, { entityId: 'e_tv' });
    const lf = formatQuantity(d);
    expect(lf.tolerance).toMatch(/^±\d+ mm$/);
    expect(lf.standardShort).toBe('clear internal');
  });
});

describe('a measurement that is not defensible says so', () => {
  // The bathroom ceiling was never in view: rg_bath_ceiling is 'inferred'.
  const ceiling = world.measureDistance([3.5, 0, 5.1], [3.5, 2.4, 5.1]);
  const f = formatQuantity(ceiling);

  it('is marked indicative rather than suppressed', () => {
    expect(f.status).toBe('indicative');
    expect(f.value).toMatch(/2\.40 m/);
  });

  it('explains why, in words a customer can act on', () => {
    expect(f.statusNote).toBeTruthy();
    expect(f.statusNote).toMatch(/cameras never saw|filled in by a model/);
    expect(f.statusNote).not.toContain('provenance');
  });

  it('carries the warning into the spoken form too', () => {
    expect(f.speech).toContain('indicative');
  });

  it('widens the tolerance rather than quoting the clean one', () => {
    // A length wholly inside the hall's observed volume is the control case.
    const cleanQ = world.measureDistance([4.6, 1.2, 1.0], [6.0, 1.2, 1.0]);
    const clean = formatQuantity(cleanQ);
    expect(clean.status).toBe('defensible');
    expect(clean.statusNote).toBeUndefined();
    expect(ceiling.tolerance).toBeGreaterThan(cleanQ.tolerance);
  });

  it('marks a floor-to-ceiling measurement that ends in a generated void', () => {
    // rg_hall_ceiling_void starts exactly at the hall ceiling plane, so a
    // measurement taken to that plane touches invented geometry and is not
    // quotable as fact -- which is the behaviour, not a rounding artefact.
    const hallHeight = formatQuantity(world.measureDistance([5.3, 0, 3.2], [5.3, 2.4, 3.2]));
    expect(hallHeight.status).toBe('indicative');
    expect(hallHeight.statusNote).toBeTruthy();
  });
});

describe('the display guard', () => {
  const base = world.measureArea('r_hall');

  it('refuses a quantity with no standard', () => {
    const bad = { ...base, standard: undefined } as unknown as Quantity;
    expect(() => assertDisplayable(bad)).toThrow(/standard/);
  });

  it('refuses a quantity with no tolerance', () => {
    const bad = { ...base, tolerance: Number.NaN } as Quantity;
    expect(() => assertDisplayable(bad)).toThrow(/tolerance/);
  });

  it('refuses a quantity with no grounding', () => {
    const bad = { ...base, grounding: undefined } as unknown as Quantity;
    expect(() => assertDisplayable(bad)).toThrow(/grounding/);
  });

  it('refuses a non-finite value', () => {
    expect(() => assertDisplayable({ ...base, value: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('room extents', () => {
  it('quotes both systems with one tolerance', () => {
    const s = formatExtent(4.5, 3.1, 20, { imperial: true });
    expect(s).toContain('4.50 m × 3.10 m');
    expect(s).toContain('±20 mm');
    expect(s).toMatch(/\d+′ \d+″/);
  });
});

describe('measurement session', () => {
  const session = (): MeasurementSession => new MeasurementSession(world, { locale: 'en-GB' });

  it('needs two points for a distance and says so in between', () => {
    const s = session();
    expect(s.state.prompt).toMatch(/first point/i);
    const after = s.addPoint([5.0, 1.0, 1.0]);
    expect(after.result).toBeUndefined();
    expect(after.prompt).toMatch(/second point/i);
    const done = s.addPoint([5.0, 1.0, 4.0]);
    expect(done.result?.primary?.value).toMatch(/3\.00 m/);
    expect(done.result?.headline).toContain('±');
  });

  it('measures a room area from a point inside it', () => {
    const s = session();
    s.setTool('area');
    const state = s.addPoint([1.5, 1.0, 3.0]);
    expect(state.result?.primary?.standardShort).toBe('RICS GIA');
    expect(state.result?.overlay.polygons.length).toBe(1);
    expect(state.result?.supporting[0]?.label).toBe('Floor to ceiling');
  });

  it('says plainly when a point is not in any surveyed room', () => {
    const s = session();
    s.setTool('area');
    const state = s.addPoint([40, 1.0, 40]);
    expect(state.result?.headline).toBe('No room here');
    expect(state.result?.overlay.polygons.length).toBe(0);
  });

  it('reports zero clearance inside an object, and names it', () => {
    const s = session();
    s.setTool('clearance');
    const state = s.addPoint([7.2, 0.3, 1.6]); // inside the double bed
    expect(state.result?.primary?.value).toMatch(/0\.00 m/);
    expect(state.result?.detail).toContain('double bed');
  });

  it('draws a footprint for a fit that works', () => {
    const s = session();
    s.setTool('fit');
    s.setFit({ label: 'Bedside table', size: [0.45, 0.55, 0.45], clearance: 0.1 });
    const state = s.addPoint([9.2, 1.0, 1.7]);
    expect(state.result?.fits).toBe(true);
    expect(state.result!.overlay.footprints.length).toBeGreaterThan(0);
    expect(state.result!.overlay.footprints[0]!.corners).toHaveLength(4);
    expect(state.result?.detail).toContain('Bedroom 1');
  });

  it('gives a reason when a fit fails, and still draws what was tried', () => {
    const s = session();
    s.setTool('fit');
    s.setFit({ label: 'Absurd wardrobe', size: [9, 2.0, 2.0] });
    const state = s.addPoint([9.2, 1.0, 1.7]);
    expect(state.result?.fits).toBe(false);
    expect(state.result?.fitReason).toBeTruthy();
    expect(state.result!.overlay.footprints[0]!.ok).toBe(false);
  });

  it('refuses a fit that is taller than the room', () => {
    const s = session();
    s.setTool('fit');
    s.setFit({ label: 'Very tall thing', size: [0.5, 3.0, 0.5] });
    const state = s.addPoint([9.2, 1.0, 1.7]);
    expect(state.result?.fits).toBe(false);
    expect(state.result?.fitReason).toMatch(/too tall/);
  });

  it('every supporting figure carries a standard and a tolerance', () => {
    const s = session();
    s.setTool('fit');
    s.setFit(COMMON_FITS[0]!);
    const state = s.addPoint([9.2, 1.0, 1.7]);
    for (const sup of state.result!.supporting) {
      expect(sup.value.tolerance).toMatch(/^±/);
      expect(sup.value.standard.length).toBeGreaterThan(5);
    }
  });

  it('undo drops the last point and the stale result with it', () => {
    const s = session();
    s.addPoint([5.0, 1.0, 1.0]);
    s.addPoint([5.0, 1.0, 4.0]);
    expect(s.state.result).toBeDefined();
    expect(s.undo().result).toBeUndefined();
    expect(s.state.points).toHaveLength(1);
  });

  it('changing tool clears the collected points', () => {
    const s = session();
    s.addPoint([5.0, 1.0, 1.0]);
    expect(s.setTool('clearance').points).toHaveLength(0);
  });
});
