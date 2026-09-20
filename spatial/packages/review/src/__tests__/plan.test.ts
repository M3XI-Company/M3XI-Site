import { describe, expect, it } from 'vitest';
import type { Quantity, WorldDocument } from '@m3xi/world-core';
import { areaLine, buildPlan, ringCentroid } from '../ui/plan.js';
import {
  buildDetail, dimensionConsequence, dimensionProblem, provenanceConsequence, provenanceView,
  willBeDefensible, type ChoiceField, type DimensionField, type SurfaceField, type TextField,
} from '../ui/detail.js';
import { applyCorrections } from '../model/apply.js';
import { buildFixture } from './fixture.js';

/**
 * The plan and the detail panel, as data.
 *
 * Both files are pure functions over a `WorldDocument`, which is what lets the
 * pick surface and the correction form be tested without a browser at all.
 * What is asserted here is what an operator actually relies on: that the
 * accessible name of a shape carries the figure AND its standard AND whether
 * that figure is defensible, and that a dimension cannot be turned into a
 * correction until the operator has said how they know it.
 */

function field<T>(doc: WorldDocument, id: string, type: 'room' | 'entity' | 'opening', key: string): T {
  const model = buildDetail(doc, { type, id });
  const found = model.fields.find((f) => f.key === key);
  if (!found) throw new Error(`no field '${key}' on ${type} ${id}; has ${model.fields.map((f) => f.key).join(', ')}`);
  return found as unknown as T;
}

describe('the floorplan model', () => {
  it('draws every room, opening and object, and lists them in a stable pick order', () => {
    const { doc } = buildFixture();
    const plan = buildPlan(doc);

    expect(plan.unavailable).toBeNull();
    expect(plan.rooms).toHaveLength(3);
    expect(plan.openings).toHaveLength(4);
    expect(plan.entities).toHaveLength(3);
    expect(plan.regions).toHaveLength(1);
    expect(plan.order).toHaveLength(10);
    expect(plan.order.slice(0, 3).every((o) => o.type === 'room')).toBe(true);
    expect(plan.order.at(-1)!.type).toBe('entity');
  });

  it('frames the property in metres, with a margin', () => {
    const { doc } = buildFixture();
    // World XZ seen from above: SVG x is world x, SVG y is world z.
    expect(buildPlan(doc).viewBox).toBe('-0.6 -0.6 11.2 7.2');
  });

  it('gives every shape an accessible name carrying the figure and its standard', () => {
    const { doc, ids } = buildFixture();
    const plan = buildPlan(doc);
    const hall = plan.rooms.find((r) => r.id === ids.hall)!;

    expect(hall.label).toBe('Hall');
    expect(hall.ariaLabel).toContain('Hall, hall');
    expect(hall.ariaLabel).toContain('12.00 m²');
    // No bare numbers anywhere, including in an accessible name.
    expect(hall.ariaLabel).toContain('RICS GIA');
    // The floor-to-ceiling height is not a Quantity in the contract -- a room
    // is two planes -- so it is built as one rather than spoken as a bare
    // difference of two numbers.
    expect(hall.ariaLabel).toContain('2.40 metres, plus or minus 20 millimetres');
    expect(hall.ariaLabel).toContain('floor to ceiling');
    expect(hall.corrected).toBe(false);
  });

  it('says in words which openings are windows, rather than only dashing them', () => {
    const { doc, ids } = buildFixture();
    const plan = buildPlan(doc);
    const window = plan.openings.find((o) => o.id === ids.bedroomWindow)!;
    expect(window.window).toBe(true);
    expect(window.ariaLabel).toContain('window');
    expect(window.ariaLabel).toContain('Bedroom 1');
    // Length along the wall equals the recorded width.
    expect(Math.hypot(window.x2 - window.x1, window.y2 - window.y1)).toBeCloseTo(1.4, 6);
  });

  it('marks a corrected room as corrected, from the receipt alone', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [{
      id: '44444444-4444-4444-8444-000000000001',
      at: '2026-09-20T12:00:00.000Z',
      by: 'sam@example.com',
      change: { kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' },
    }]);
    const hall = buildPlan(next).rooms.find((r) => r.id === ids.hall)!;
    expect(hall.corrected).toBe(true);
    expect(hall.ariaLabel).toContain('already corrected by an operator');
  });

  it('refuses to draw an empty rectangle when there is nothing to draw', () => {
    const { doc } = buildFixture();
    const empty = buildPlan({ ...doc, rooms: [] });
    expect(empty.unavailable).toMatch(/no rooms/);

    const degenerate = buildPlan({
      ...doc,
      rooms: doc.rooms.map((r) => ({ ...r, polygon: [] })),
    });
    expect(degenerate.unavailable).toMatch(/reconstruction failure/);
  });

  it('keeps an out-of-bounds object inside the frame, because that is the mistake to see', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [{
      id: '44444444-4444-4444-8444-000000000002',
      at: '2026-09-20T12:00:00.000Z',
      by: 'sam@example.com',
      change: { kind: 'entity.move', entityId: ids.sofa, centroid: [-4, 0.425, 3] },
    }]);
    const plan = buildPlan(next);
    expect(plan.viewBox.startsWith('-5.6 ')).toBe(true);
  });

  it('puts a label inside a concave room rather than in the notch', () => {
    // An L: the vertex mean would land in the missing corner.
    const centroid = ringCentroid([[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]);
    expect(centroid[0]).toBeLessThan(2);
    expect(centroid[1]).toBeLessThan(2);
  });
});

describe('figures on the plan', () => {
  const base: Quantity = {
    value: 13.95, unit: 'm2', standard: 'RICS-COMP-GIA',
    tolerance: 2.5, toleranceUnit: 'pct',
    grounding: { provenance: 'reconstructed', confidence: 0.9 },
  };

  it('never shows a bare number', () => {
    expect(areaLine(base)).toContain('13.95 m²');
    expect(areaLine(base)).toContain('RICS GIA');
    expect(areaLine(base)).toContain('±2.5%');
  });

  it('shows an undefensible figure as indicative rather than dropping it', () => {
    const indicative = areaLine({ ...base, basis: { defensible: false } });
    expect(indicative).toContain('13.95 m²');
    expect(indicative).toContain('INDICATIVE');
  });

  it('says plainly when there is no area at all', () => {
    expect(areaLine(undefined)).toMatch(/cannot be published/);
  });
});

describe('what is correctable about a selection', () => {
  it('offers a room its name, kind, area, height, surfaces, coverage and deletion', () => {
    const { doc, ids } = buildFixture();
    const model = buildDetail(doc, { type: 'room', id: ids.hall });
    expect(model.fields.map((f) => f.key)).toEqual([
      'room.name', 'room.kind', 'room.area', 'room.ceilingHeight',
      'surface.flags', 'region.mark', 'room.delete',
    ]);
    expect(model.title).toBe('Hall');
    expect(model.subtitle).toContain('2.40 m ±20 mm · clear internal floor to ceiling');
  });

  it('gives the floor-to-ceiling height a standard and a tolerance rather than a bare figure', () => {
    const { doc, ids } = buildFixture();
    const height = field<DimensionField>(doc, ids.hall, 'room', 'room.ceilingHeight');
    expect(height.current).not.toBeNull();
    expect(height.current!.standard).toBe('CLEAR-INTERNAL');
    expect(height.current!.tolerance).toBe(doc.measurementPolicy.wallToleranceMm);
    expect(height.currentText).toContain('±20 mm');
  });

  it('offers an opening its kind, both sides, and three dimensions', () => {
    const { doc, ids } = buildFixture();
    const model = buildDetail(doc, { type: 'opening', id: ids.bedroomWindow });
    expect(model.fields.map((f) => f.key)).toEqual([
      'opening.kind', 'opening.roomA', 'opening.roomB',
      'opening.width', 'opening.height', 'opening.sill', 'surface.flags',
    ]);
  });

  it('says so when the selection has been deleted by a correction in the list', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [{
      id: '44444444-4444-4444-8444-000000000003',
      at: '2026-09-20T12:00:00.000Z',
      by: 'sam@example.com',
      change: { kind: 'entity.delete', entityId: ids.sofa },
    }]);
    const model = buildDetail(next, { type: 'entity', id: ids.sofa });
    expect(model.missing).toMatch(/no longer in this world/);
    expect(model.fields).toEqual([]);
  });

  it('will not make a correction out of an empty name', () => {
    const { doc, ids } = buildFixture();
    const name = field<TextField>(doc, ids.hall, 'room', 'room.name');
    expect(name.make('   ')).toBeNull();
    expect(name.make('  Entrance hall  ')).toEqual({
      kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall',
    });
  });

  it('will not make a correction out of a kind the schema does not have', () => {
    const { doc, ids } = buildFixture();
    const kind = field<ChoiceField>(doc, ids.hall, 'room', 'room.kind');
    expect(kind.make('conservatory')).toEqual({
      kind: 'room.kind', roomId: ids.hall, roomKind: 'conservatory',
    });
    expect(kind.make('ballroom')).toBeNull();
  });

  it('will not connect an opening to the same room on both sides', () => {
    const { doc, ids } = buildFixture();
    const sideB = field<ChoiceField>(doc, ids.bedroomDoor, 'opening', 'opening.roomB');
    expect(sideB.make(ids.hall)).toBeNull();
    expect(sideB.make('')).toEqual({
      kind: 'opening.connects', openingId: ids.bedroomDoor, roomA: ids.hall, roomB: null,
    });
  });

  it('emits only the surface flags that differ from what the world says', () => {
    const { doc, ids } = buildFixture();
    const surfaces = field<SurfaceField>(doc, ids.hall, 'room', 'surface.flags');
    expect(surfaces.make(ids.hallFloor, {})).toBeNull();
    expect(surfaces.make(ids.hallFloor, { isGlazed: true }))
      .toEqual({ kind: 'surface.flags', surfaceId: ids.hallFloor, isGlazed: true });
    expect(surfaces.make('not-a-surface-here', { isGlazed: true })).toBeNull();
  });
});

describe('a dimension cannot be entered without saying how it is known', () => {
  it('refuses to build a correction until the method is declared', () => {
    const { doc, ids } = buildFixture();
    const area = field<DimensionField>(doc, ids.kitchen, 'room', 'room.area');

    expect(area.make({ value: 24.6, method: null, instrument: null })).toBeNull();
    expect(dimensionProblem({ value: 24.6, method: null, instrument: null }))
      .toMatch(/how you know this figure/);
  });

  it('refuses a site measurement until the instrument is named', () => {
    const { doc, ids } = buildFixture();
    const area = field<DimensionField>(doc, ids.kitchen, 'room', 'room.area');
    expect(area.make({ value: 24.6, method: 'site-measure', instrument: null })).toBeNull();
    expect(dimensionProblem({ value: 24.6, method: 'site-measure', instrument: null }))
      .toMatch(/what you measured with/);
  });

  it('refuses a figure that is not positive', () => {
    expect(dimensionProblem({ value: 0, method: 'estimate', instrument: null }))
      .toMatch(/positive/);
    expect(dimensionProblem({ value: Number.NaN, method: 'estimate', instrument: null }))
      .toMatch(/positive/);
  });

  it('records an estimate as having no instrument, rather than a flattering one', () => {
    const { doc, ids } = buildFixture();
    const area = field<DimensionField>(doc, ids.kitchen, 'room', 'room.area');
    expect(area.make({
      value: 24.6, method: 'estimate', instrument: null, standard: area.defaultStandard,
    })).toEqual({
      kind: 'dimension.set',
      target: { kind: 'room.area', roomId: ids.kitchen },
      value: 24.6, method: 'estimate', instrument: 'unknown',
      standard: 'RICS-COMP-GIA',
    });
    // With no standard named, the change carries none and `apply.ts` falls
    // back to the figure's own standard and then to the world policy, rather
    // than this layer inventing one.
    expect(area.make({ value: 24.6, method: 'estimate', instrument: null }))
      .not.toHaveProperty('standard');
    expect(willBeDefensible('estimate', 'laser')).toBe(false);
    expect(willBeDefensible('site-measure', 'unknown')).toBe(false);
    expect(willBeDefensible('site-measure', 'laser')).toBe(true);
  });

  it('states the consequence of each answer before it is given', () => {
    expect(dimensionConsequence(null, null, 'm')).toMatch(/Choose how you know/);
    expect(dimensionConsequence('estimate', null, 'm')).toMatch(/INDICATIVE/);
    expect(dimensionConsequence('site-measure', 'unknown', 'm')).toMatch(/INDICATIVE/);
    expect(dimensionConsequence('site-measure', 'laser', 'm')).toMatch(/±3 mm/);
    expect(dimensionConsequence('site-measure', 'tape', 'm2')).toMatch(/percentage half-width/);
  });

  it('offers area standards for an area and only clear internal for a length', () => {
    const { doc, ids } = buildFixture();
    const area = field<DimensionField>(doc, ids.kitchen, 'room', 'room.area');
    const height = field<DimensionField>(doc, ids.kitchen, 'room', 'room.ceilingHeight');
    expect(area.standards.map((s) => s.value))
      .toEqual(['RICS-COMP-GIA', 'RICS-COMP-NIA', 'IPMS-3C', 'CLEAR-INTERNAL']);
    // GIA, NIA and IPMS are area standards; labelling a height with one is a
    // category error, and the server hard-codes CLEAR-INTERNAL for lengths.
    expect(height.standards.map((s) => s.value)).toEqual(['CLEAR-INTERNAL']);
  });
});

describe('provenance is stated before it is changed', () => {
  it('says a name change leaves the geometry exactly as derived', () => {
    const { doc, ids } = buildFixture();
    const view = provenanceView(doc.rooms.find((r) => r.id === ids.hall)!.grounding);
    expect(view.now).toMatch(/measured from the photographs/);
    expect(view.cameras).toBe(2);
    expect(view.corrected).toBe(false);
    expect(view.afterSemantic).toMatch(/unchanged/);
    expect(view.afterGeometric).toMatch(/estimated/);
  });

  it('says a move weakens provenance, and a rename does not', () => {
    const { doc, ids } = buildFixture();
    const g = doc.entities.find((e) => e.id === ids.sofa)!.grounding;
    expect(provenanceConsequence({ kind: 'entity.label', entityId: ids.sofa, label: 'x' }, g))
      .toMatch(/stays/);
    expect(provenanceConsequence({ kind: 'entity.move', entityId: ids.sofa, centroid: [1, 1, 1] }, g))
      .toMatch(/weakens/);
  });

  it('never strengthens provenance, whatever the correction', () => {
    const { doc, ids } = buildFixture();
    // The console table is already inferred. Moving it cannot make it worse,
    // and nothing may make it better.
    const g = doc.entities.find((e) => e.id === ids.console)!.grounding;
    const sentence = provenanceConsequence(
      { kind: 'entity.move', entityId: ids.console, centroid: [4.7, 0.39, 0.5] }, g,
    );
    expect(sentence).toMatch(/stays/);
    expect(sentence).not.toMatch(/photographed/);
  });
});
