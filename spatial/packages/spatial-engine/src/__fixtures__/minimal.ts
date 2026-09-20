import type {
  Grounding, Quantity, Ring, Room, Vec2, WorldDocument,
} from '@m3xi/world-core';

/**
 * Minimal document scaffolding for tests that need a world with one specific
 * property and nothing else. Every field the contract requires is present, so a
 * document built here is a valid WorldDocument, not a cast.
 */

export function grounding(
  provenance: Grounding['provenance'] = 'reconstructed', confidence = 0.9,
): Grounding {
  return { provenance, confidence };
}

export function emptyDoc(over: Partial<WorldDocument> = {}): WorldDocument {
  return {
    formatVersion: 1,
    id: 'w_test',
    propertyId: 'p_test',
    version: 1,
    label: 'test world',
    createdAt: '2026-01-01T00:00:00.000Z',
    units: { length: 'm', angle: 'rad' },
    upAxis: 'Y',
    handedness: 'right',
    scale: { source: 'test', agreement: 1, grounding: grounding() },
    floors: [],
    rooms: [],
    surfaces: [],
    openings: [],
    entities: [],
    relationships: [],
    nav: { nodes: [], edges: [] },
    regions: [],
    cameras: [],
    assets: [],
    quality: { checks: [], score: 1, verdict: 'pass', createdAt: '2026-01-01T00:00:00.000Z' },
    measurementPolicy: {
      areaStandard: 'CLEAR-INTERNAL',
      areaTolerancePct: 2.5,
      wallToleranceMm: 20,
    },
    ...over,
  };
}

function shoelace(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return s / 2;
}

function areaQ(a: number, g: Grounding): Quantity {
  return {
    value: a, unit: 'm2', standard: 'CLEAR-INTERNAL',
    tolerance: 2.5, toleranceUnit: 'pct', grounding: g,
  };
}

/** An axis-aligned rectangular room, wound counter-clockwise viewed from above. */
export function rectRoom(
  id: string, x0: number, z0: number, x1: number, z1: number,
  over: Partial<Room> = {},
): Room {
  const raw: Vec2[] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const polygon: Ring = shoelace(raw) > 0 ? [...raw].reverse() : raw;
  const g = over.grounding ?? grounding();
  return {
    id,
    stableKey: id,
    kind: 'unknown',
    polygon,
    floorZ: 0,
    ceilingZ: 2.4,
    area: areaQ(Math.abs((x1 - x0) * (z1 - z0)), g),
    grounding: g,
    ...over,
  };
}
