/**
 * Version comparison. The rule worth testing is the quiet one: a difference
 * inside the declared tolerance is not a difference.
 */

import { describe, expect, it } from 'vitest';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type { WorldDocument } from '@m3xi/world-core';
import { diffWorlds } from '../logic/diff.js';

function withRooms(doc: WorldDocument, mutate: (rooms: WorldDocument['rooms']) => WorldDocument['rooms']): WorldDocument {
  return { ...doc, rooms: mutate(doc.rooms) };
}

describe('diffWorlds', () => {
  it('reports nothing when a world is compared with itself', () => {
    const d = diffWorlds(FLAT, { ...FLAT, version: 4 });
    expect(d.identical).toBe(true);
    expect(d.rooms.unchanged).toBe(FLAT.rooms.length);
    expect(d.fromVersion).toBe(3);
    expect(d.toVersion).toBe(4);
  });

  it('matches rooms by stableKey, not by id', () => {
    const next = withRooms(FLAT, (rooms) => rooms.map((r) => ({ ...r, id: `${r.id}_new` })));
    expect(diffWorlds(FLAT, next).identical).toBe(true);
  });

  it('notices a rename', () => {
    const next = withRooms(FLAT, (rooms) => rooms.map((r) => (
      r.stableKey === 'bedroom-2' ? { ...r, name: 'Study' } : r
    )));
    const d = diffWorlds(FLAT, next);
    expect(d.rooms.renamed).toEqual([{ stableKey: 'bedroom-2', from: 'Bedroom 2', to: 'Study' }]);
    expect(d.identical).toBe(false);
  });

  it('notices a kind change', () => {
    const next = withRooms(FLAT, (rooms) => rooms.map((r) => (
      r.stableKey === 'bedroom-2' ? { ...r, kind: 'office' as const } : r
    )));
    expect(diffWorlds(FLAT, next).rooms.kindChanged).toEqual([
      { stableKey: 'bedroom-2', from: 'bedroom', to: 'office' },
    ]);
  });

  it('ignores an area change inside the declared tolerance', () => {
    const next = withRooms(FLAT, (rooms) => rooms.map((r) => (
      // The fixture declares at least a 2.5% area tolerance, so 1% is noise.
      r.stableKey === 'kitchen-diner'
        ? { ...r, area: { ...r.area, value: r.area.value * 1.01 } }
        : r
    )));
    const d = diffWorlds(FLAT, next);
    expect(d.rooms.resized).toEqual([]);
    expect(d.identical).toBe(true);
  });

  it('reports an area change outside the tolerance, with its direction', () => {
    const next = withRooms(FLAT, (rooms) => rooms.map((r) => (
      r.stableKey === 'kitchen-diner'
        ? { ...r, area: { ...r.area, value: r.area.value * 0.88 } }
        : r
    )));
    const change = diffWorlds(FLAT, next).rooms.resized[0]!;
    expect(change.stableKey).toBe('kitchen-diner');
    expect(change.deltaFraction).toBeCloseTo(-0.12, 6);
    expect(change.to).toBeLessThan(change.from);
  });

  it('reports rooms that appeared and disappeared', () => {
    const fewer = withRooms(FLAT, (rooms) => rooms.filter((r) => r.stableKey !== 'bathroom'));
    const gone = diffWorlds(FLAT, fewer);
    expect(gone.rooms.removed).toEqual(['Bathroom']);
    const back = diffWorlds(fewer, FLAT);
    expect(back.rooms.added).toEqual(['Bathroom']);
  });

  it('reports quality checks that flipped', () => {
    const next: WorldDocument = {
      ...FLAT,
      quality: {
        ...FLAT.quality,
        verdict: 'pass',
        score: 0.96,
        checks: FLAT.quality.checks.map((c) => ({ ...c, pass: true })),
      },
    };
    const d = diffWorlds(FLAT, next);
    expect(d.quality.flipped).toEqual([
      { name: 'ceiling_observed_fraction', from: false, to: true },
    ]);
    expect(d.quality.fromVerdict).toBe('review');
    expect(d.quality.toVerdict).toBe('pass');
  });

  it('counts cameras and unobserved regions on both sides', () => {
    const d = diffWorlds(FLAT, FLAT);
    expect(d.coverage.fromCameras).toBe(FLAT.cameras.length);
    expect(d.coverage.toUnobservedRegions)
      .toBe(FLAT.regions.filter((r) => r.provenance !== 'observed').length);
  });

  it('tracks objects by stableKey as well', () => {
    const next: WorldDocument = {
      ...FLAT,
      entities: FLAT.entities.map((e, i) => (i === 0 ? { ...e, label: 'chaise longue' } : e)),
    };
    const d = diffWorlds(FLAT, next);
    expect(d.entities.relabelled).toHaveLength(1);
    expect(d.entities.relabelled[0]?.to).toBe('chaise longue');
  });
});
