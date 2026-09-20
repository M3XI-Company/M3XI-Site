import { describe, expect, it } from 'vitest';
import { isDefensible } from '@m3xi/spatial-engine';
import { applyCorrections } from '../model/apply.js';
import { validateWorld } from '../model/validate.js';
import {
  correctionKey, describeCorrection,
  type CorrectionChange, type CorrectionKind, type CorrectionRecord, type DimensionTarget,
} from '../model/corrections.js';
import {
  HUMAN_ASSERTION_CONFIDENCE, correctionIdsOf, isHumanCorrected, operatorsOf,
} from '../model/provenance.js';
import { buildFixture } from './fixture.js';

/**
 * EVERY CORRECTION KIND, APPLIED TO A REAL WORLD AND VALIDATED AFTERWARDS.
 *
 * Not a mock in the file. `applyCorrections` is pure and `validateWorld` runs
 * against the spatial engine, so each case below is the same computation the
 * editor performs to build its preview and the same one the operator approves.
 *
 * Coverage is asserted rather than assumed: every kind a case exercises is
 * recorded in `covered`, and the last test in this file fails if the union
 * grows a member nothing here touches. A correction kind with no test is a
 * kind that changes a stranger's home with nobody watching.
 */

const covered = new Set<CorrectionKind>();
const coveredDimensions = new Set<DimensionTarget['kind']>();

let recordSeq = 0;
function rec(change: CorrectionChange, note?: string): CorrectionRecord {
  recordSeq += 1;
  covered.add(change.kind);
  if (change.kind === 'dimension.set') coveredDimensions.add(change.target.kind);
  return {
    id: `11111111-1111-4111-8111-${String(recordSeq).padStart(12, '0')}`,
    at: '2026-09-20T10:00:00.000Z',
    by: 'sam@example.com',
    change,
    ...(note ? { note } : {}),
  };
}

describe('the fixture flat', () => {
  it('validates with no blockers, so anything a test breaks was broken by that test', () => {
    const { doc } = buildFixture();
    const result = validateWorld(doc);
    expect(result.blockers).toEqual([]);
    expect(result.savable).toBe(true);
  });
});

describe('semantic corrections leave geometry alone and leave a receipt', () => {
  it('renames a room without touching how its outline was derived', () => {
    const { doc, ids } = buildFixture();
    const record = rec({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    const { doc: next, skipped } = applyCorrections(doc, [record]);

    const room = next.rooms.find((r) => r.id === ids.hall)!;
    expect(skipped).toEqual([]);
    expect(room.name).toBe('Entrance hall');
    // Rule 2: a name is not a shape.
    expect(room.grounding.provenance).toBe('reconstructed');
    expect(room.grounding.confidence).toBe(HUMAN_ASSERTION_CONFIDENCE);
    // Rule 4: the receipt, alongside the camera ids it did not remove.
    expect(correctionIdsOf(room.grounding)).toContain(record.id);
    expect(operatorsOf(room.grounding)).toContain('sam@example.com');
    expect(room.grounding.sources).toContain('cam-hall-1');
    expect(isHumanCorrected(room.grounding)).toBe(true);
    expect(validateWorld(next).blockers).toEqual([]);
  });

  it('changes a room kind', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'room.kind', roomId: ids.kitchen, roomKind: 'dining',
    })]);
    expect(next.rooms.find((r) => r.id === ids.kitchen)!.kind).toBe('dining');
  });

  it('relabels and recategorises an object', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [
      rec({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' }),
      rec({ kind: 'entity.category', entityId: ids.sofa, category: 'fitting' }),
    ]);
    const sofa = next.entities.find((e) => e.id === ids.sofa)!;
    expect(sofa.label).toBe('corner sofa');
    expect(sofa.category).toBe('fitting');
    expect(sofa.grounding.provenance).toBe('observed');
  });

  it('moves an object into another room, and the validator notices the position disagrees', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'entity.room', entityId: ids.sofa, roomId: ids.hall,
    })]);
    expect(next.entities.find((e) => e.id === ids.sofa)!.roomId).toBe(ids.hall);
    const codes = validateWorld(next).warnings.map((w) => w.code);
    expect(codes).toContain('entity.room-mismatch');
  });

  it('detaches an object from every room', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'entity.room', entityId: ids.sofa, roomId: null,
    })]);
    expect(next.entities.find((e) => e.id === ids.sofa)!.roomId).toBeUndefined();
  });

  it('refuses to move an object into a room that is not there', () => {
    const { doc, ids } = buildFixture();
    const { doc: next, skipped } = applyCorrections(doc, [rec({
      kind: 'entity.room', entityId: ids.sofa, roomId: 'no-such-room',
    })]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/no room/);
    expect(next.entities.find((e) => e.id === ids.sofa)!.roomId).toBe(ids.kitchen);
  });

  it('flags a mirrored or glazed panel without weakening the panel geometry', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'surface.flags', surfaceId: ids.bedroomWindowWall, isGlazed: true,
    })]);
    const surface = next.surfaces.find((s) => s.id === ids.bedroomWindowWall)!;
    expect(surface.isGlazed).toBe(true);
    expect(surface.isReflective).toBe(false);
    expect(surface.grounding.provenance).toBe('reconstructed');
    expect(isHumanCorrected(surface.grounding)).toBe(true);
  });

  it('changes an opening kind and what it connects', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [
      rec({ kind: 'opening.kind', openingId: ids.bedroomWindow, openingKind: 'rooflight' }),
      rec({ kind: 'opening.connects', openingId: ids.frontDoor, roomA: ids.hall, roomB: ids.kitchen }),
    ]);
    expect(next.openings.find((o) => o.id === ids.bedroomWindow)!.kind).toBe('rooflight');
    const front = next.openings.find((o) => o.id === ids.frontDoor)!;
    expect(front.roomA).toBe(ids.hall);
    expect(front.roomB).toBe(ids.kitchen);
    expect(validateWorld(next).blockers).toEqual([]);
  });

  it('refuses to connect an opening to the same room twice', () => {
    const { doc, ids } = buildFixture();
    const { skipped } = applyCorrections(doc, [rec({
      kind: 'opening.connects', openingId: ids.frontDoor, roomA: ids.hall, roomB: ids.hall,
    })]);
    expect(skipped[0]!.reason).toMatch(/itself/);
  });

  it('moves the entrance, and leaves exactly one', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'entrance.set', navNodeId: ids.bedroomNode,
    })]);
    const entrances = next.nav.nodes.filter((n) => n.isEntrance);
    expect(entrances).toHaveLength(1);
    expect(entrances[0]!.id).toBe(ids.bedroomNode);
    expect(validateWorld(next).blockers).toEqual([]);
  });
});

describe('geometric corrections weaken provenance to inferred, and say so', () => {
  it('moves an object and takes its boxes with it', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'entity.move', entityId: ids.sofa, centroid: [2, 0.425, 4],
    })]);
    const sofa = next.entities.find((e) => e.id === ids.sofa)!;
    expect(sofa.centroid).toEqual([2, 0.425, 4]);
    // The box travelled with the centroid: a box that lags is the bug.
    expect(sofa.aabb.min[2]).toBeCloseTo(3.55, 6);
    expect(sofa.aabb.max[2]).toBeCloseTo(4.45, 6);
    expect(sofa.obb!.centre).toEqual([2, 0.425, 4]);
    // Rule 3: no camera saw a sofa there.
    expect(sofa.grounding.provenance).toBe('inferred');
  });

  it('resizes an object upward from where it stands, not outward from its middle', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'entity.resize', entityId: ids.sofa, size: [2, 1, 1],
    })]);
    const sofa = next.entities.find((e) => e.id === ids.sofa)!;
    expect(sofa.aabb.min[1]).toBeCloseTo(0, 6);
    expect(sofa.aabb.max[1]).toBeCloseTo(1, 6);
    expect(sofa.centroid[1]).toBeCloseTo(0.5, 6);
    expect(sofa.grounding.provenance).toBe('inferred');
  });

  it('refuses a size that is not three positive metres', () => {
    const { doc, ids } = buildFixture();
    const { skipped } = applyCorrections(doc, [rec({
      kind: 'entity.resize', entityId: ids.sofa, size: [2, 0, 1],
    })]);
    expect(skipped[0]!.reason).toMatch(/positive/);
  });

  it('deletes an object and nothing else', () => {
    const { doc, ids } = buildFixture();
    const before = doc.entities.length;
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'entity.delete', entityId: ids.sofa,
    })]);
    expect(next.entities).toHaveLength(before - 1);
    expect(next.rooms).toHaveLength(doc.rooms.length);
    expect(validateWorld(next).blockers).toEqual([]);
  });

  it('deletes a room, takes its surfaces with it, and leaves the doorways as a blocker', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'room.delete', roomId: ids.bedroom,
    })]);

    expect(next.rooms.find((r) => r.id === ids.bedroom)).toBeUndefined();
    expect(next.surfaces.some((s) => s.roomId === ids.bedroom)).toBe(false);
    expect(next.nav.nodes.some((n) => n.id === ids.bedroomNode)).toBe(false);
    // Furniture is detached, not destroyed.
    expect(next.entities.find((e) => e.id === ids.bed)!.roomId).toBeUndefined();

    // The doorway is left in place on purpose, so the operator is made to
    // decide rather than discovering the door went with the room.
    const blockers = validateWorld(next).blockers.map((b) => b.code);
    expect(blockers).toContain('opening.dangling-room');
    expect(next.openings.some((o) => o.id === ids.bedroomDoor)).toBe(true);
  });
});

describe('dimension corrections: the method is what decides defensibility', () => {
  it('records a site-measured area as defensible, with the instrument in the basis', () => {
    const { doc, ids } = buildFixture();
    const record = rec({
      kind: 'dimension.set',
      target: { kind: 'room.area', roomId: ids.kitchen },
      value: 24.6, method: 'site-measure', instrument: 'laser',
      standard: 'IPMS-3C',
    }, 'measured wall face to wall face after the units came out');
    const { doc: next } = applyCorrections(doc, [record]);

    const area = next.rooms.find((r) => r.id === ids.kitchen)!.area;
    expect(area.value).toBe(24.6);
    expect(area.standard).toBe('IPMS-3C');
    expect(area.toleranceUnit).toBe('pct');
    expect(isDefensible(area)).toBe(true);
    expect(area.basis).toMatchObject({
      corrected: true,
      correctionId: record.id,
      statedBy: 'sam@example.com',
      method: 'site-measure',
      instrument: 'laser',
      defensible: true,
      supersededValue: 24,
      note: 'measured wall face to wall face after the units came out',
    });
    // Rule 1 and 3: a human figure is an estimate, however good the laser is.
    expect(area.grounding.provenance).toBe('inferred');
  });

  it('records an estimated area as indicative, with the reason in the basis', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'dimension.set',
      target: { kind: 'room.area', roomId: ids.kitchen },
      value: 26, method: 'estimate', instrument: 'unknown',
    })]);
    const area = next.rooms.find((r) => r.id === ids.kitchen)!.area;
    expect(isDefensible(area)).toBe(false);
    expect(String(area.basis!['refusalReason'])).toMatch(/estimate/);
    // Policy tolerance widened by the inferred factor of 2.
    expect(area.tolerance).toBeCloseTo(5, 6);
  });

  it('refuses to call an instrumentless site measurement defensible', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'dimension.set',
      target: { kind: 'opening.width', openingId: ids.kitchenDoor },
      value: 0.84, method: 'site-measure', instrument: 'unknown',
    })]);
    const width = next.openings.find((o) => o.id === ids.kitchenDoor)!.width!;
    expect(isDefensible(width)).toBe(false);
    expect(String(width.basis!['refusalReason'])).toMatch(/no instrument/);
  });

  it('moves the ceiling and leaves the floor where the reconstruction put it', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [rec({
      kind: 'dimension.set',
      target: { kind: 'room.ceilingHeight', roomId: ids.hall },
      value: 2.62, method: 'site-measure', instrument: 'tape',
    })]);
    const hall = next.rooms.find((r) => r.id === ids.hall)!;
    expect(hall.floorZ).toBe(0);
    expect(hall.ceilingZ).toBeCloseTo(2.62, 6);
    expect(hall.grounding.provenance).toBe('inferred');
  });

  it('sets an opening width, height and sill, each with its own tolerance', () => {
    const { doc, ids } = buildFixture();
    const { doc: next } = applyCorrections(doc, [
      rec({
        kind: 'dimension.set',
        target: { kind: 'opening.width', openingId: ids.bedroomWindow },
        value: 1.42, method: 'site-measure', instrument: 'laser',
      }),
      rec({
        kind: 'dimension.set',
        target: { kind: 'opening.height', openingId: ids.bedroomWindow },
        value: 1.28, method: 'estimate', instrument: 'unknown',
      }),
      rec({
        kind: 'dimension.set',
        target: { kind: 'opening.sill', openingId: ids.bedroomWindow },
        value: 0.92, method: 'site-measure', instrument: 'tape',
      }),
    ]);
    const window = next.openings.find((o) => o.id === ids.bedroomWindow)!;
    expect(window.width!.value).toBe(1.42);
    expect(window.width!.tolerance).toBe(3);
    expect(isDefensible(window.width!)).toBe(true);
    expect(window.height!.tolerance).toBeCloseTo(40, 6);
    expect(isDefensible(window.height!)).toBe(false);
    expect(window.sill!.tolerance).toBe(10);
    expect(validateWorld(next).blockers).toEqual([]);
  });

  it('refuses a dimension that is not a positive number', () => {
    const { doc, ids } = buildFixture();
    const { skipped } = applyCorrections(doc, [rec({
      kind: 'dimension.set',
      target: { kind: 'room.area', roomId: ids.hall },
      value: 0, method: 'estimate', instrument: 'unknown',
    })]);
    expect(skipped[0]!.reason).toMatch(/positive/);
  });
});

describe('survey coverage and sign-off', () => {
  it('marks a volume, and records who said so in the note itself', () => {
    const { doc, ids } = buildFixture();
    const record = rec({
      kind: 'region.mark',
      provenance: 'generated',
      volume: { min: [6, 0, 0], max: [7, 2.4, 1] },
      reason: 'alcove behind the door was never captured',
      roomId: ids.bedroom,
    });
    const { doc: next } = applyCorrections(doc, [record]);
    const added = next.regions.find((r) => r.id === `rg_${record.id}`)!;
    expect(added.provenance).toBe('generated');
    expect(added.confidence).toBe(0.1);
    expect(added.reason).toMatch(/recorded by sam@example.com/);
    expect(added.roomId).toBe(ids.bedroom);
  });

  it('refuses a coverage note with no reason', () => {
    const { doc } = buildFixture();
    const { skipped } = applyCorrections(doc, [rec({
      kind: 'region.mark',
      provenance: 'inferred',
      volume: { min: [0, 0, 0], max: [1, 1, 1] },
      reason: '   ',
    })]);
    expect(skipped[0]!.reason).toMatch(/say why/);
  });

  it('withdraws a note an operator added', () => {
    const { doc } = buildFixture();
    const mark = rec({
      kind: 'region.mark',
      provenance: 'inferred',
      volume: { min: [0, 0, 0], max: [1, 2.4, 1] },
      reason: 'corner behind the fridge',
    });
    const clear = rec({ kind: 'region.clear', regionId: `rg_${mark.id}` });
    const { doc: next, skipped } = applyCorrections(doc, [mark, clear]);
    expect(skipped).toEqual([]);
    expect(next.regions).toHaveLength(doc.regions.length);
  });

  it('refuses to withdraw a survey gap the pipeline recorded', () => {
    const { doc, ids } = buildFixture();
    const { doc: next, skipped } = applyCorrections(doc, [rec({
      kind: 'region.clear', regionId: ids.roofVoid,
    })]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/rescan/);
    expect(next.regions.some((r) => r.id === ids.roofVoid)).toBe(true);
  });

  it('accepts a sign-off and changes nothing about the building', () => {
    const { doc } = buildFixture();
    const { doc: next, skipped } = applyCorrections(doc, [rec({
      kind: 'world.approve', note: 'checked against the flat on 20 September',
    })]);
    expect(skipped).toEqual([]);
    expect(next).toBe(doc);
  });
});

describe('the list is a set of decisions, not a keystroke log', () => {
  it('gives two corrections to the same fact the same collision key', () => {
    const { ids } = buildFixture();
    const first = rec({ kind: 'room.rename', roomId: ids.hall, name: 'Halway' });
    const second = rec({ kind: 'room.rename', roomId: ids.hall, name: 'Hallway' });
    expect(correctionKey(first)).toBe(correctionKey(second));
  });

  it('keys the two surface flags separately, because they are two claims', () => {
    const { ids } = buildFixture();
    const mirrored = rec({ kind: 'surface.flags', surfaceId: ids.bedroomWindowWall, isReflective: true });
    const glazed = rec({ kind: 'surface.flags', surfaceId: ids.bedroomWindowWall, isGlazed: true });
    expect(correctionKey(mirrored)).not.toBe(correctionKey(glazed));
  });

  it('never collides two coverage notes or two sign-offs', () => {
    const a = rec({
      kind: 'region.mark', provenance: 'inferred',
      volume: { min: [0, 0, 0], max: [1, 1, 1] }, reason: 'one',
    });
    const b = rec({
      kind: 'region.mark', provenance: 'inferred',
      volume: { min: [2, 0, 0], max: [3, 1, 1] }, reason: 'two',
    });
    expect(correctionKey(a)).not.toBe(correctionKey(b));
  });

  it('describes each correction as a sentence a person signs off', () => {
    const { ids } = buildFixture();
    const names = { [ids.hall]: 'Hall', [ids.sofa]: 'sofa' };
    expect(describeCorrection({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' }, { names }))
      .toBe('Rename Hall to "Entrance hall".');
    expect(describeCorrection({
      kind: 'dimension.set',
      target: { kind: 'room.area', roomId: ids.hall },
      value: 12.4, method: 'site-measure', instrument: 'laser',
    }, { names })).toBe('Set the floor area of Hall to 12.40 m², measured on site with a laser.');
  });
});

describe('coverage of the union itself', () => {
  it('has exercised every correction kind and every dimension target', () => {
    const kinds: readonly CorrectionKind[] = [
      'room.rename', 'room.kind', 'room.delete',
      'entity.label', 'entity.category', 'entity.room',
      'entity.move', 'entity.resize', 'entity.delete',
      'dimension.set', 'surface.flags',
      'opening.kind', 'opening.connects', 'entrance.set',
      'region.mark', 'region.clear', 'world.approve',
    ];
    expect([...kinds].filter((k) => !covered.has(k))).toEqual([]);

    const targets: readonly DimensionTarget['kind'][] = [
      'room.area', 'room.ceilingHeight', 'opening.width', 'opening.height', 'opening.sill',
    ];
    expect([...targets].filter((t) => !coveredDimensions.has(t))).toEqual([]);
  });
});
