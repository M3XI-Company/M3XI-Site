import { describe, expect, it } from 'vitest';
import { World } from '../world.js';
import { FLAT } from '../__fixtures__/flat.js';
import { emptyDoc, grounding, rectRoom } from '../__fixtures__/minimal.js';

const w = World.fromDocument(FLAT);

describe('provenanceAt', () => {
  it('takes the room when nothing else applies', () => {
    expect(w.provenanceAt([8.00, 1.00, 5.00])).toBe('reconstructed');
  });

  it('takes the weakest of overlapping regions and the room', () => {
    // Generated corner of bedroom 1, inside a reconstructed room.
    expect(w.provenanceAt([10.40, 1.00, 2.80])).toBe('generated');
    // Inferred ceiling void of the bathroom.
    expect(w.provenanceAt([3.50, 2.20, 5.00])).toBe('inferred');
    // Observed region inside the hall.
    expect(w.provenanceAt([5.30, 1.00, 3.00])).toBe('reconstructed');
  });

  it('calls a point supported by nothing generated', () => {
    expect(w.provenanceAt([50, 50, 50])).toBe('generated');
    expect(w.provenanceAt([NaN, 0, 0])).toBe('generated');
    // Above the hall ceiling: inside a declared generated void.
    expect(w.provenanceAt([5.30, 2.60, 3.00])).toBe('generated');
  });

  it('gives a point in the thickness of a partition the rooms it separates', () => {
    // A doorway node sits between two rooms and belongs to both.
    expect(w.provenanceAt([6.20, 1.00, 1.60])).toBe('reconstructed');
  });
});

describe('isObserved', () => {
  it('is true inside rooms reconstructed from observations', () => {
    expect(w.isObserved([5.30, 1.00, 3.00])).toBe(true);
    expect(w.isObserved([3.00, 1.00, 1.50])).toBe(true);
  });

  it('is false in inferred and generated volumes', () => {
    expect(w.isObserved([10.40, 1.00, 2.80])).toBe(false);
    expect(w.isObserved([3.50, 2.20, 5.00])).toBe(false);
    expect(w.isObserved([5.30, 2.60, 3.00])).toBe(false);
  });

  it('is false where the world says nothing at all', () => {
    expect(w.isObserved([50, 50, 50])).toBe(false);
    expect(w.isObserved([NaN, 0, 0])).toBe(false);
  });

  it('follows a room whose own geometry was only inferred', () => {
    const inferredWorld = World.fromDocument(emptyDoc({
      rooms: [rectRoom('r_a', 0, 0, 4, 4, { grounding: grounding('inferred', 0.5) })],
    }));
    expect(inferredWorld.provenanceAt([2, 1, 2])).toBe('inferred');
    expect(inferredWorld.isObserved([2, 1, 2])).toBe(false);
  });

  it('lets an explicit observed region override a weaker room', () => {
    const mixed = World.fromDocument(emptyDoc({
      rooms: [rectRoom('r_a', 0, 0, 4, 4, { grounding: grounding('inferred', 0.5) })],
      regions: [{
        id: 'rg', provenance: 'observed',
        volume: { min: [1, 0, 1], max: [2, 2, 2] },
      }],
    }));
    expect(mixed.isObserved([1.5, 1, 1.5])).toBe(true);
    expect(mixed.isObserved([3, 1, 3])).toBe(false);
  });
});

describe('raycast provenance', () => {
  it('reports the weakest of the hit surface and the point it landed on', () => {
    // Landing in the generated corner of bedroom 1: the wall face itself is
    // reconstructed, but the volume the ray lands in was never observed, and
    // the weaker of the two is what the hit has to report.
    const hit = w.raycast([8.00, 1.00, 2.80], [1, 0, 0], { maxDistance: 5 });
    expect(hit).not.toBeNull();
    expect(hit!.point[0]).toBeCloseTo(10.75, 6);
    expect(hit!.provenance).toBe('generated');

    const clean = w.raycast([8.00, 1.00, 5.00], [0, 0, 1], { maxDistance: 3 })!;
    expect(clean.provenance).toBe('reconstructed');
  });
});
