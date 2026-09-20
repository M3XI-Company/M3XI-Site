import type {
  Entity, Grounding, NavEdge, NavNode, Opening, Quantity, Ring, Room, Surface, Vec2, Vec3,
  WorldDocument,
} from '@m3xi/world-core';

/**
 * A small, structurally honest flat, with SERVER-SHAPED IDS.
 *
 * The ids are uuids rather than readable keys, and that is not decoration.
 * `wv-worlds` resolves every correction's target with `uuid()` and refuses
 * anything else by name, so a fixture with ids like `r_hall` would make every
 * wire test assert against a batch the real server would reject outright --
 * which is precisely the failure `wire.ts` exists to catch, and a fixture that
 * triggered it everywhere would drown it.
 *
 * `uuidFor` keeps them readable anyway: the tail digits are the sequence
 * number, so `…000003` is the third thing declared and a failing assertion
 * names something a person can find.
 *
 * The flat itself is three rectangular rooms off a hall, with the doorways,
 * one window, three pieces of furniture, a nav graph with one entrance, and a
 * roof void the pipeline recorded as never surveyed. It validates clean: the
 * tests that want a broken world break it themselves, so what broke it is
 * visible in the test rather than baked into the fixture.
 */

let seq = 0;
export function uuidFor(label: string): string {
  seq += 1;
  const tail = String(seq).padStart(12, '0');
  void label;
  return `00000000-0000-4000-8000-${tail}`;
}

/** Reset between test files that assert on specific ids. */
export function resetIds(): void {
  seq = 0;
}

const FLOOR_Y = 0;
const CEILING_Y = 2.4;
const AREA_TOL_PCT = 2.5;
const WALL_TOL_MM = 20;

function g(provenance: Grounding['provenance'], confidence: number, sources?: string[]): Grounding {
  return sources ? { provenance, confidence, sources } : { provenance, confidence };
}

function shoelace(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return s / 2;
}

/** Counter-clockwise viewed from above is the NEGATIVE shoelace in (x, z). */
function ccwFromAbove(ring: readonly Vec2[]): Ring {
  return shoelace(ring) > 0 ? [...ring].reverse() : [...ring];
}

function rect(x0: number, z0: number, x1: number, z1: number): Vec2[] {
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
}

function areaQ(ring: readonly Vec2[], grounding: Grounding): Quantity {
  return {
    value: Math.abs(shoelace(ring)),
    unit: 'm2',
    standard: 'RICS-COMP-GIA',
    tolerance: AREA_TOL_PCT,
    toleranceUnit: 'pct',
    grounding,
  };
}

function lenQ(v: number, grounding: Grounding): Quantity {
  return {
    value: v, unit: 'm', standard: 'CLEAR-INTERNAL',
    tolerance: WALL_TOL_MM, toleranceUnit: 'mm', grounding,
  };
}

export interface Fixture {
  readonly doc: WorldDocument;
  readonly ids: {
    readonly floor: string;
    readonly hall: string;
    readonly kitchen: string;
    readonly bedroom: string;
    readonly frontDoor: string;
    readonly kitchenDoor: string;
    readonly bedroomDoor: string;
    readonly bedroomWindow: string;
    readonly sofa: string;
    readonly bed: string;
    readonly console: string;
    readonly hallNode: string;
    readonly kitchenNode: string;
    readonly bedroomNode: string;
    readonly roofVoid: string;
    /** The wall carrying the bedroom window, for `surface.flags`. */
    readonly bedroomWindowWall: string;
    /** The hall's floor surface, for a surface correction with no glazing in it. */
    readonly hallFloor: string;
  };
}

export function buildFixture(): Fixture {
  resetIds();

  const floorId = uuidFor('floor');
  const hallId = uuidFor('hall');
  const kitchenId = uuidFor('kitchen');
  const bedroomId = uuidFor('bedroom');

  const outlines: Record<string, Vec2[]> = {
    [hallId]: rect(4, 0, 6, 6),
    [kitchenId]: rect(0, 0, 4, 6),
    [bedroomId]: rect(6, 0, 10, 6),
  };

  const groundings: Record<string, Grounding> = {
    [hallId]: g('reconstructed', 0.93, ['cam-hall-1', 'cam-hall-2']),
    [kitchenId]: g('reconstructed', 0.95, ['cam-kitchen-1']),
    [bedroomId]: g('reconstructed', 0.88, ['cam-bed-1', 'cam-bed-2']),
  };

  const rooms: Room[] = ([
    [hallId, 'Hall', 'hall'],
    [kitchenId, 'Kitchen', 'kitchen'],
    [bedroomId, 'Bedroom 1', 'bedroom'],
  ] as const).map(([id, name, kind]) => {
    const ring = outlines[id]!;
    const grounding = groundings[id]!;
    return {
      id,
      stableKey: name.toLowerCase().replace(/\s+/g, '-'),
      floorId,
      name,
      kind,
      polygon: ccwFromAbove(ring),
      floorZ: FLOOR_Y,
      ceilingZ: CEILING_Y,
      area: areaQ(ring, grounding),
      grounding,
    } satisfies Room;
  });

  // Floor, ceiling and one wall face per outline edge.
  const surfaces: Surface[] = [];
  const wallOf = new Map<string, string[]>();
  const floorOf = new Map<string, string>();
  for (const room of rooms) {
    const grounding = groundings[room.id]!;
    const floorSurfaceId = uuidFor('floor-surface');
    floorOf.set(room.id, floorSurfaceId);
    surfaces.push({
      id: floorSurfaceId,
      roomId: room.id,
      kind: 'floor',
      plane: { n: [0, 1, 0], d: -FLOOR_Y },
      polygon: room.polygon.map((p): Vec3 => [p[0], FLOOR_Y, p[1]]),
      isReflective: false,
      isGlazed: false,
      grounding,
    });
    surfaces.push({
      id: uuidFor('ceiling-surface'),
      roomId: room.id,
      kind: 'ceiling',
      plane: { n: [0, -1, 0], d: CEILING_Y },
      polygon: room.polygon.map((p): Vec3 => [p[0], CEILING_Y, p[1]]),
      isReflective: false,
      isGlazed: false,
      grounding,
    });
    const walls: string[] = [];
    for (let i = 0; i < room.polygon.length; i++) {
      const a = room.polygon[i]!;
      const b = room.polygon[(i + 1) % room.polygon.length]!;
      const id = uuidFor('wall');
      walls.push(id);
      surfaces.push({
        id,
        roomId: room.id,
        kind: 'wall',
        plane: { n: [0, 0, 1], d: 0 },
        polygon: [
          [a[0], FLOOR_Y, a[1]], [b[0], FLOOR_Y, b[1]],
          [b[0], CEILING_Y, b[1]], [a[0], CEILING_Y, a[1]],
        ],
        isReflective: false,
        isGlazed: false,
        grounding,
      });
    }
    wallOf.set(room.id, walls);
  }

  const doorG = g('reconstructed', 0.9, ['cam-hall-1']);
  const windowG = g('reconstructed', 0.86, ['cam-bed-1']);

  const frontDoorId = uuidFor('front-door');
  const kitchenDoorId = uuidFor('kitchen-door');
  const bedroomDoorId = uuidFor('bedroom-door');
  const bedroomWindowId = uuidFor('bedroom-window');
  const bedroomWindowWall = wallOf.get(bedroomId)![0]!;

  // The doors carry no `sill`. A door's sill really is 0 m, and `validate.ts`
  // reports any dimension that is not strictly positive as a blocker
  // (`quantity.non-positive`), so a literal zero here would make the fixture
  // unsavable for a reason that has nothing to do with corrections. Leaving it
  // out says "not recorded", which is true and is not a blocker. The
  // underlying rule is worth revisiting in `validate.ts`; it is not this
  // package's file to change.
  const openings: Opening[] = [
    {
      id: frontDoorId, kind: 'door', roomA: hallId,
      centre: [5, 1.02, 0], normal: [0, 0, -1],
      width: lenQ(0.9, doorG), height: lenQ(2.04, doorG),
      grounding: g('observed', 0.96, ['cam-hall-1']),
    },
    {
      id: kitchenDoorId, kind: 'door', roomA: hallId, roomB: kitchenId,
      centre: [4, 0.99, 1.5], normal: [-1, 0, 0],
      width: lenQ(0.838, doorG), height: lenQ(1.981, doorG),
      grounding: doorG,
    },
    {
      id: bedroomDoorId, kind: 'door', roomA: hallId, roomB: bedroomId,
      centre: [6, 0.99, 1.5], normal: [1, 0, 0],
      width: lenQ(0.838, doorG), height: lenQ(1.981, doorG),
      grounding: doorG,
    },
    {
      id: bedroomWindowId, kind: 'window', roomA: bedroomId,
      surfaceId: bedroomWindowWall,
      centre: [10, 1.55, 3], normal: [1, 0, 0],
      width: lenQ(1.4, windowG), height: lenQ(1.3, windowG), sill: lenQ(0.9, windowG),
      grounding: windowG,
    },
  ];

  const sofaId = uuidFor('sofa');
  const bedId = uuidFor('bed');
  const consoleId = uuidFor('console');

  const box = (
    id: string, stableKey: string, label: string, category: Entity['category'],
    roomId: string, min: Vec3, max: Vec3, grounding: Grounding, observedIn: string[],
  ): Entity => ({
    id,
    stableKey,
    label,
    category,
    roomId,
    centroid: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    aabb: { min, max },
    obb: {
      centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
      quat: [0, 0, 0, 1],
    },
    observedIn,
    grounding,
  });

  const entities: Entity[] = [
    box(sofaId, 'sofa', 'sofa', 'furniture', kitchenId,
      [1, 0, 1], [3, 0.85, 1.9], g('observed', 0.94), ['cam-kitchen-1']),
    box(bedId, 'bed', 'double bed', 'furniture', bedroomId,
      [6.5, 0, 1], [8.4, 0.6, 3], g('observed', 0.97), ['cam-bed-1']),
    box(consoleId, 'console', 'console table', 'furniture', hallId,
      [4.2, 0, 0.3], [5.2, 0.78, 0.65], g('inferred', 0.62), ['cam-hall-2']),
  ];

  const hallNode = uuidFor('hall-node');
  const kitchenNode = uuidFor('kitchen-node');
  const bedroomNode = uuidFor('bedroom-node');

  const nodes: NavNode[] = [
    { id: hallNode, roomId: hallId, position: [5, 1.6, 3], clearance: 0.9, isEntrance: true, isViewpoint: true },
    { id: kitchenNode, roomId: kitchenId, position: [2, 1.6, 3], clearance: 1.2, isEntrance: false, isViewpoint: true },
    { id: bedroomNode, roomId: bedroomId, position: [8, 1.6, 4.5], clearance: 1.1, isEntrance: false, isViewpoint: true },
  ];

  const edges: NavEdge[] = [
    { a: hallNode, b: kitchenNode, cost: 3.2, kind: 'door', width: 0.838, openingId: kitchenDoorId },
    { a: hallNode, b: bedroomNode, cost: 3.6, kind: 'door', width: 0.838, openingId: bedroomDoorId },
  ];

  const roofVoid = uuidFor('roof-void');

  const doc: WorldDocument = {
    formatVersion: 1,
    id: uuidFor('world'),
    propertyId: uuidFor('property'),
    version: 4,
    label: 'Flat 2, 14 Example Road',
    createdAt: '2026-09-01T09:00:00.000Z',
    units: { length: 'm', angle: 'rad' },
    upAxis: 'Y',
    handedness: 'right',
    scale: { source: 'arkit-lidar', agreement: 0.98, grounding: g('reconstructed', 0.95) },
    floors: [{ id: floorId, level: 0, name: 'Ground', elevation: 0, grounding: g('reconstructed', 0.95) }],
    rooms,
    surfaces,
    openings,
    entities,
    relationships: [],
    nav: { nodes, edges },
    regions: [{
      id: roofVoid,
      provenance: 'generated',
      // Above the ceiling, so it flags a volume without making any room's
      // floor area cross unobserved space.
      volume: { min: [0, 2.4, 0], max: [10, 3, 6] },
      reason: 'roof void: no camera looked above the ceiling line',
      confidence: 0.1,
    }],
    cameras: [],
    assets: [],
    quality: {
      checks: [{ name: 'coverage', value: 0.92, threshold: 0.8, higherIsBetter: true, pass: true }],
      score: 0.92,
      verdict: 'pass',
      createdAt: '2026-09-01T10:00:00.000Z',
    },
    measurementPolicy: {
      areaStandard: 'RICS-COMP-GIA',
      areaTolerancePct: AREA_TOL_PCT,
      wallToleranceMm: WALL_TOL_MM,
    },
  };

  return {
    doc,
    ids: {
      floor: floorId,
      hall: hallId,
      kitchen: kitchenId,
      bedroom: bedroomId,
      frontDoor: frontDoorId,
      kitchenDoor: kitchenDoorId,
      bedroomDoor: bedroomDoorId,
      bedroomWindow: bedroomWindowId,
      sofa: sofaId,
      bed: bedId,
      console: consoleId,
      hallNode,
      kitchenNode,
      bedroomNode,
      roofVoid,
      bedroomWindowWall,
      hallFloor: floorOf.get(hallId)!,
    },
  };
}
