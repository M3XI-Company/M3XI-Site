import type {
  Aabb, Camera, Entity, Grounding, Obb, Opening, Provenance, Quantity, Ring, Room, Surface,
  Vec2, Vec3, WorldDocument,
} from '@m3xi/world-core';

/**
 * A synthetic but structurally honest two-bedroom UK flat.
 *
 * It exists so that every package in the system can be tested against the same
 * world, so the numbers in one package's tests mean something in another's. The
 * dimensions are ordinary: 0.25 m external walls, 0.10 m partitions, a 2.4 m
 * ceiling, a 0.838 m internal door leaf, a 1.98 m door height. Room outlines
 * are the INTERNAL wall faces, so the areas below are clear internal areas and
 * the two faces of one partition sit 0.10 m apart -- which is what makes the
 * shared-wall adjacency derivation a real test rather than a coincidence test.
 *
 * Deliberate awkwardness, all of it the kind a real reconstruction produces:
 *   - the kitchen/diner is L-shaped, so point-in-polygon has a concave case;
 *   - the far corner of bedroom 1 is generated, not observed;
 *   - the bathroom ceiling is inferred;
 *   - a rug is 12 mm thick, which is thin enough to exercise the degenerate
 *     proxy-geometry path, and the coffee table stands on it;
 *   - one entity's dimensions are inferred rather than reconstructed.
 */

const FLOOR_Y = 0;
const CEILING_Y = 2.4;
const AREA_TOLERANCE_PCT = 2.5;
const WALL_TOLERANCE_MM = 20;

function g(provenance: Provenance, confidence: number, sources?: string[]): Grounding {
  return sources ? { provenance, confidence, sources } : { provenance, confidence };
}

function shoelace(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return s / 2;
}

/**
 * The contract asks for rings counter-clockwise viewed from above. With X to
 * the right and Z into the page that is the NEGATIVE shoelace direction in
 * (x, z), because X x Z = -Y. Outlines below are written in whichever order
 * reads best and normalised here.
 */
function ccwFromAbove(ring: readonly Vec2[]): Ring {
  return shoelace(ring) > 0 ? [...ring].reverse() : [...ring];
}

function perimeter(ring: readonly Vec2[]): number {
  let p = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    p += Math.hypot(ring[i]![0] - ring[j]![0], ring[i]![1] - ring[j]![1]);
  }
  return p;
}

function areaQ(ring: readonly Vec2[], grounding: Grounding): Quantity {
  const a = Math.abs(shoelace(ring));
  const geometricPct = ((WALL_TOLERANCE_MM / 1000) * perimeter(ring) / a) * 100;
  return {
    value: a,
    unit: 'm2',
    standard: 'RICS-COMP-GIA',
    tolerance: Math.max(AREA_TOLERANCE_PCT, geometricPct),
    toleranceUnit: 'pct',
    grounding,
  };
}

function lenQ(v: number, grounding: Grounding): Quantity {
  return {
    value: v, unit: 'm', standard: 'CLEAR-INTERNAL',
    tolerance: WALL_TOLERANCE_MM, toleranceUnit: 'mm', grounding,
  };
}

// ---------------------------------------------------------------------------
// Outlines (internal wall faces), metres on the XZ plane
// ---------------------------------------------------------------------------

const OUTLINE: Record<string, readonly Vec2[]> = {
  r_hall: [[4.45, 0.25], [6.15, 0.25], [6.15, 6.15], [4.45, 6.15]],
  // L-shaped kitchen/diner: cooking end north, sitting end in the west leg.
  r_kitchen: [
    [0.25, 0.25], [4.35, 0.25], [4.35, 3.95], [2.55, 3.95], [2.55, 6.15], [0.25, 6.15],
  ],
  r_bath: [[2.65, 4.05], [4.35, 4.05], [4.35, 6.15], [2.65, 6.15]],
  r_bed1: [[6.25, 0.25], [10.75, 0.25], [10.75, 3.35], [6.25, 3.35]],
  r_bed2: [[6.25, 3.45], [10.75, 3.45], [10.75, 6.15], [6.25, 6.15]],
};

const ROOM_GROUNDING: Record<string, Grounding> = {
  r_hall: g('reconstructed', 0.93, ['cam_hall_01', 'cam_hall_02']),
  r_kitchen: g('reconstructed', 0.95, ['cam_kitchen_01', 'cam_kitchen_02', 'cam_kitchen_03']),
  r_bath: g('reconstructed', 0.82, ['cam_bath_01']),
  r_bed1: g('reconstructed', 0.94, ['cam_bed1_01', 'cam_bed1_02']),
  r_bed2: g('reconstructed', 0.91, ['cam_bed2_01']),
};

const rooms: Room[] = [
  { id: 'r_hall', stableKey: 'hall', floorId: 'f_ground', name: 'Hall', kind: 'hall' },
  { id: 'r_kitchen', stableKey: 'kitchen-diner', floorId: 'f_ground', name: 'Kitchen/diner', kind: 'kitchen' },
  { id: 'r_bath', stableKey: 'bathroom', floorId: 'f_ground', name: 'Bathroom', kind: 'bathroom' },
  { id: 'r_bed1', stableKey: 'bedroom-1', floorId: 'f_ground', name: 'Bedroom 1', kind: 'bedroom' },
  { id: 'r_bed2', stableKey: 'bedroom-2', floorId: 'f_ground', name: 'Bedroom 2', kind: 'bedroom' },
].map((r) => {
  const outline = OUTLINE[r.id]!;
  const grounding = ROOM_GROUNDING[r.id]!;
  return {
    ...r,
    kind: r.kind as Room['kind'],
    polygon: ccwFromAbove(outline),
    floorZ: FLOOR_Y,
    ceilingZ: CEILING_Y,
    area: areaQ(outline, grounding),
    grounding,
  };
});

// ---------------------------------------------------------------------------
// Surfaces: floor, ceiling and one wall face per outline edge
// ---------------------------------------------------------------------------

/** Inward normal of edge i, found by probing so it never depends on winding. */
function inwardNormal(ring: readonly Vec2[], i: number): Vec2 {
  const a = ring[i]!;
  const b = ring[(i + 1) % ring.length]!;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz);
  const nx = -dz / l;
  const nz = dx / l;
  const mx = (a[0] + b[0]) / 2 + nx * 0.01;
  const mz = (a[1] + b[1]) / 2 + nz * 0.01;
  return inside(ring, mx, mz) ? [nx, nz] : [-nx, -nz];
}

function inside(ring: readonly Vec2[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if ((a[1] > z) !== (b[1] > z)) {
      const t = (z - a[1]) / (b[1] - a[1]);
      if (x < a[0] + t * (b[0] - a[0])) hit = !hit;
    }
  }
  return hit;
}

/** Wall faces carrying a window are glazed; the bathroom's west wall is mirrored. */
const GLAZED_WALLS = new Set([
  'r_kitchen:5', 'r_kitchen:4', 'r_bath:2', 'r_bed1:1', 'r_bed2:1',
]);

const surfaces: Surface[] = [];
for (const room of rooms) {
  const ring = room.polygon;
  const grounding = ROOM_GROUNDING[room.id]!;
  const ceilingGrounding = room.id === 'r_bath'
    ? g('inferred', 0.55, ['cam_bath_01'])
    : grounding;

  surfaces.push({
    id: `s_${room.id}_floor`,
    roomId: room.id,
    kind: 'floor',
    plane: { n: [0, 1, 0], d: -FLOOR_Y },
    polygon: ring.map((v): Vec3 => [v[0], FLOOR_Y, v[1]]),
    isReflective: false,
    isGlazed: false,
    grounding,
  });
  surfaces.push({
    id: `s_${room.id}_ceiling`,
    roomId: room.id,
    kind: 'ceiling',
    plane: { n: [0, -1, 0], d: CEILING_Y },
    polygon: ring.map((v): Vec3 => [v[0], CEILING_Y, v[1]]),
    isReflective: false,
    isGlazed: false,
    grounding: ceilingGrounding,
  });

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const n = inwardNormal(ring, i);
    const key = `${room.id}:${i}`;
    surfaces.push({
      id: `s_${room.id}_wall_${i}`,
      roomId: room.id,
      kind: 'wall',
      plane: { n: [n[0], 0, n[1]], d: -(n[0] * a[0] + n[1] * a[1]) },
      polygon: [
        [a[0], FLOOR_Y, a[1]], [b[0], FLOOR_Y, b[1]],
        [b[0], CEILING_Y, b[1]], [a[0], CEILING_Y, a[1]],
      ],
      // A bathroom mirror is the classic reconstruction trap: it invents a room
      // behind it. Flagged so the viewer will not walk a camera through it.
      isReflective: room.id === 'r_bath' && i === 0,
      isGlazed: GLAZED_WALLS.has(key),
      grounding,
    });
  }
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

const DOOR_G = g('reconstructed', 0.9);
const WINDOW_G = g('reconstructed', 0.88);

const openings: Opening[] = [
  {
    id: 'o_front_door', kind: 'door', roomA: 'r_hall',
    surfaceId: 's_r_hall_wall_0',
    centre: [5.30, 1.02, 0.25], normal: [0, 0, -1],
    width: lenQ(0.90, DOOR_G), height: lenQ(2.04, DOOR_G), sill: lenQ(0, DOOR_G),
    grounding: g('observed', 0.96, ['cam_hall_01']),
  },
  {
    id: 'o_door_kitchen', kind: 'door', roomA: 'r_hall', roomB: 'r_kitchen',
    centre: [4.40, 0.99, 1.60], normal: [-1, 0, 0],
    width: lenQ(0.838, DOOR_G), height: lenQ(1.981, DOOR_G), sill: lenQ(0, DOOR_G),
    grounding: DOOR_G,
  },
  {
    id: 'o_door_bath', kind: 'door', roomA: 'r_hall', roomB: 'r_bath',
    centre: [4.40, 0.99, 5.20], normal: [-1, 0, 0],
    width: lenQ(0.762, DOOR_G), height: lenQ(1.981, DOOR_G), sill: lenQ(0, DOOR_G),
    grounding: DOOR_G,
  },
  {
    id: 'o_door_bed1', kind: 'door', roomA: 'r_hall', roomB: 'r_bed1',
    centre: [6.20, 0.99, 1.60], normal: [1, 0, 0],
    width: lenQ(0.838, DOOR_G), height: lenQ(1.981, DOOR_G), sill: lenQ(0, DOOR_G),
    grounding: DOOR_G,
  },
  {
    id: 'o_door_bed2', kind: 'door', roomA: 'r_hall', roomB: 'r_bed2',
    centre: [6.20, 0.99, 4.90], normal: [1, 0, 0],
    width: lenQ(0.838, DOOR_G), height: lenQ(1.981, DOOR_G), sill: lenQ(0, DOOR_G),
    grounding: DOOR_G,
  },
  {
    id: 'o_win_kitchen_w', kind: 'window', roomA: 'r_kitchen',
    surfaceId: 's_r_kitchen_wall_5',
    centre: [0.25, 1.55, 2.10], normal: [-1, 0, 0],
    width: lenQ(1.40, WINDOW_G), height: lenQ(1.30, WINDOW_G), sill: lenQ(0.90, WINDOW_G),
    grounding: WINDOW_G,
  },
  {
    id: 'o_win_kitchen_s', kind: 'window', roomA: 'r_kitchen',
    surfaceId: 's_r_kitchen_wall_4',
    centre: [1.40, 1.55, 6.15], normal: [0, 0, 1],
    width: lenQ(1.40, WINDOW_G), height: lenQ(1.30, WINDOW_G), sill: lenQ(0.90, WINDOW_G),
    grounding: WINDOW_G,
  },
  {
    id: 'o_win_bath', kind: 'window', roomA: 'r_bath',
    centre: [3.50, 1.80, 6.15], normal: [0, 0, 1],
    width: lenQ(0.60, WINDOW_G), height: lenQ(0.60, WINDOW_G), sill: lenQ(1.50, WINDOW_G),
    grounding: g('reconstructed', 0.78),
  },
  {
    id: 'o_win_bed1', kind: 'window', roomA: 'r_bed1',
    centre: [10.75, 1.55, 1.80], normal: [1, 0, 0],
    width: lenQ(1.40, WINDOW_G), height: lenQ(1.30, WINDOW_G), sill: lenQ(0.90, WINDOW_G),
    grounding: WINDOW_G,
  },
  {
    id: 'o_win_bed2', kind: 'window', roomA: 'r_bed2',
    centre: [10.75, 1.55, 4.80], normal: [1, 0, 0],
    width: lenQ(1.40, WINDOW_G), height: lenQ(1.30, WINDOW_G), sill: lenQ(0.90, WINDOW_G),
    grounding: WINDOW_G,
  },
];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function axisBox(
  id: string, label: string, category: Entity['category'], roomId: string,
  min: Vec3, max: Vec3, grounding: Grounding, observedIn: string[],
  attributes?: Record<string, unknown>,
): Entity {
  const aabb: Aabb = { min, max };
  const centroid: Vec3 = [
    (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
  ];
  const obb: Obb = {
    centre: centroid,
    half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
    quat: [0, 0, 0, 1],
  };
  return {
    id, stableKey: id.replace(/^e_/, ''), label, category, roomId,
    centroid, aabb, obb, observedIn, grounding,
    ...(attributes ? { attributes } : {}),
  };
}

/** A box rotated about +Y; its AABB is the world bound of the rotated box. */
function yawBox(
  id: string, label: string, category: Entity['category'], roomId: string,
  centre: Vec3, size: Vec3, yawRad: number, grounding: Grounding, observedIn: string[],
): Entity {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  const hx = size[0] / 2;
  const hz = size[2] / 2;
  const ex = Math.abs(c * hx) + Math.abs(s * hz);
  const ez = Math.abs(s * hx) + Math.abs(c * hz);
  const aabb: Aabb = {
    min: [centre[0] - ex, centre[1] - size[1] / 2, centre[2] - ez],
    max: [centre[0] + ex, centre[1] + size[1] / 2, centre[2] + ez],
  };
  return {
    id, stableKey: id.replace(/^e_/, ''), label, category, roomId,
    centroid: centre, aabb,
    obb: {
      centre,
      half: [hx, size[1] / 2, hz],
      quat: [0, Math.sin(yawRad / 2), 0, Math.cos(yawRad / 2)],
    },
    observedIn, grounding,
  };
}

const KIT = ['cam_kitchen_01', 'cam_kitchen_02'];
const BED1 = ['cam_bed1_01', 'cam_bed1_02'];
const BED2 = ['cam_bed2_01'];
const BATH = ['cam_bath_01'];
const HALL = ['cam_hall_01', 'cam_hall_02'];

const entities: Entity[] = [
  // Kitchen/diner -- cooking end
  axisBox('e_fridge', 'fridge freezer', 'appliance', 'r_kitchen',
    [0.28, 0, 0.28], [0.92, 1.85, 0.95], g('observed', 0.94), KIT),
  axisBox('e_oven', 'oven', 'appliance', 'r_kitchen',
    [0.95, 0, 0.28], [1.55, 0.90, 0.90], g('observed', 0.92), KIT),
  axisBox('e_worktop', 'worktop', 'fitting', 'r_kitchen',
    [1.55, 0.80, 0.28], [3.60, 0.92, 0.90], g('reconstructed', 0.9), KIT),
  axisBox('e_sink', 'sink', 'fixture', 'r_kitchen',
    [2.20, 0.82, 0.35], [2.90, 0.94, 0.85], g('observed', 0.88), KIT),
  axisBox('e_dining_table', 'dining table', 'furniture', 'r_kitchen',
    [1.60, 0, 1.80], [3.40, 0.75, 2.70], g('observed', 0.95), KIT),
  yawBox('e_chair_a', 'dining chair', 'furniture', 'r_kitchen',
    [1.95, 0.46, 1.55], [0.45, 0.92, 0.45], 0.12, g('observed', 0.86), KIT),
  yawBox('e_chair_b', 'dining chair', 'furniture', 'r_kitchen',
    [3.05, 0.46, 1.55], [0.45, 0.92, 0.45], -0.08, g('observed', 0.85), KIT),
  yawBox('e_chair_c', 'dining chair', 'furniture', 'r_kitchen',
    [1.95, 0.46, 2.95], [0.45, 0.92, 0.45], Math.PI + 0.15, g('observed', 0.84), KIT),
  yawBox('e_chair_d', 'dining chair', 'furniture', 'r_kitchen',
    [3.05, 0.46, 2.95], [0.45, 0.92, 0.45], Math.PI - 0.05, g('observed', 0.83), KIT),
  // Kitchen/diner -- sitting end, in the west leg of the L
  axisBox('e_sofa', 'sofa', 'furniture', 'r_kitchen',
    [0.55, 0, 4.30], [2.45, 0.85, 5.20], g('observed', 0.96), KIT),
  axisBox('e_rug', 'rug', 'fitting', 'r_kitchen',
    [0.60, 0, 5.20], [2.40, 0.012, 6.00], g('reconstructed', 0.72), KIT),
  axisBox('e_coffee_table', 'coffee table', 'furniture', 'r_kitchen',
    [1.10, 0.012, 5.35], [1.90, 0.43, 5.85], g('observed', 0.9), KIT),
  axisBox('e_tv', 'television', 'appliance', 'r_kitchen',
    [1.00, 0.60, 6.05], [2.10, 1.25, 6.13], g('observed', 0.91), KIT),

  // Hall
  axisBox('e_hall_console', 'console table', 'furniture', 'r_hall',
    [4.50, 0, 0.30], [5.40, 0.78, 0.65], g('observed', 0.87), HALL),
  axisBox('e_hall_radiator', 'radiator', 'fixture', 'r_hall',
    [4.45, 0.15, 3.00], [4.52, 0.75, 3.80], g('observed', 0.83), HALL),
  // Deliberately clear of both bedroom doorways: hooks hung across a door
  // opening would be a modelling mistake, not a test of anything.
  axisBox('e_coat_hooks', 'coat hooks', 'fitting', 'r_hall',
    [6.08, 1.55, 2.40], [6.15, 1.70, 3.20], g('reconstructed', 0.7), HALL),

  // Bathroom
  axisBox('e_bath', 'bath', 'fixture', 'r_bath',
    [2.70, 0, 4.10], [4.30, 0.55, 4.85], g('observed', 0.93), BATH),
  axisBox('e_wc', 'wc', 'fixture', 'r_bath',
    [2.70, 0, 5.30], [3.10, 0.78, 5.95], g('observed', 0.9), BATH),
  axisBox('e_basin', 'basin', 'fixture', 'r_bath',
    [3.60, 0.72, 5.55], [4.25, 0.90, 6.10], g('observed', 0.89), BATH),

  // Bedroom 1
  axisBox('e_bed_double', 'double bed', 'furniture', 'r_bed1',
    [6.30, 0, 1.00], [8.20, 0.62, 2.35], g('observed', 0.97), BED1),
  axisBox('e_bedside_a', 'bedside table', 'furniture', 'r_bed1',
    [6.30, 0, 0.50], [6.75, 0.55, 0.95], g('observed', 0.88), BED1),
  axisBox('e_wardrobe', 'wardrobe', 'furniture', 'r_bed1',
    [9.95, 0, 0.30], [10.73, 2.05, 1.80], g('observed', 0.95), BED1),
  axisBox('e_chest_drawers', 'chest of drawers', 'furniture', 'r_bed1',
    [7.20, 0, 3.02], [8.20, 0.85, 3.33], g('inferred', 0.61), ['cam_bed1_02'],
    { note: 'partially occluded by the bed; depth estimated from the class prior' }),

  // Bedroom 2
  axisBox('e_bed_single', 'single bed', 'furniture', 'r_bed2',
    [6.30, 0, 3.60], [7.20, 0.55, 5.50], g('observed', 0.94), BED2),
  axisBox('e_desk', 'desk', 'furniture', 'r_bed2',
    [9.90, 0, 3.60], [10.73, 0.74, 5.00], g('observed', 0.92), BED2),
  yawBox('e_desk_chair', 'desk chair', 'furniture', 'r_bed2',
    [9.48, 0.46, 4.38], [0.55, 0.92, 0.55], 0.44, g('observed', 0.86), BED2),
  axisBox('e_bookshelf', 'bookshelf', 'furniture', 'r_bed2',
    [8.00, 0, 5.85], [9.00, 1.80, 6.13], g('observed', 0.9), BED2),
];

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

const INTRINSICS = {
  fx: 1443.2, fy: 1443.2, cx: 960, cy: 540, width: 1920, height: 1080,
  model: 'pinhole' as const,
};

/** Quaternion for a yaw about +Y; cameras look down their own -Z. */
function yawQuat(rad: number): [number, number, number, number] {
  return [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
}

const cameras: Camera[] = [
  {
    id: 'cam_hall_01', captureId: 'cap_001', frameIndex: 12, tMs: 400,
    position: [5.30, 1.58, 1.10], orientation: yawQuat(Math.PI),
    intrinsics: INTRINSICS, poseConfidence: 0.96, sharpness: 182, roomId: 'r_hall',
  },
  {
    id: 'cam_hall_02', captureId: 'cap_001', frameIndex: 48, tMs: 1600,
    position: [5.30, 1.58, 4.60], orientation: yawQuat(0),
    intrinsics: INTRINSICS, poseConfidence: 0.94, sharpness: 156, roomId: 'r_hall',
  },
  {
    id: 'cam_kitchen_01', captureId: 'cap_001', frameIndex: 96, tMs: 3200,
    position: [3.10, 1.58, 2.20], orientation: yawQuat(Math.PI / 2),
    intrinsics: INTRINSICS, poseConfidence: 0.95, sharpness: 210, roomId: 'r_kitchen',
  },
  {
    id: 'cam_kitchen_02', captureId: 'cap_001', frameIndex: 140, tMs: 4600,
    position: [1.60, 1.58, 3.20], orientation: yawQuat(Math.PI),
    intrinsics: INTRINSICS, poseConfidence: 0.93, sharpness: 198, roomId: 'r_kitchen',
  },
  {
    id: 'cam_kitchen_03', captureId: 'cap_001', frameIndex: 176, tMs: 5900,
    position: [1.50, 1.58, 4.80], orientation: yawQuat(Math.PI),
    intrinsics: INTRINSICS, poseConfidence: 0.92, sharpness: 171, roomId: 'r_kitchen',
  },
  {
    id: 'cam_bath_01', captureId: 'cap_001', frameIndex: 214, tMs: 7100,
    position: [3.60, 1.58, 4.60], orientation: yawQuat(0),
    intrinsics: INTRINSICS, poseConfidence: 0.84, sharpness: 121, roomId: 'r_bath',
  },
  {
    id: 'cam_bed1_01', captureId: 'cap_001', frameIndex: 268, tMs: 8900,
    position: [7.20, 1.58, 0.90], orientation: yawQuat(-Math.PI / 2),
    intrinsics: INTRINSICS, poseConfidence: 0.95, sharpness: 205, roomId: 'r_bed1',
  },
  {
    id: 'cam_bed1_02', captureId: 'cap_001', frameIndex: 302, tMs: 10100,
    position: [9.30, 1.58, 2.60], orientation: yawQuat(Math.PI / 2 + 0.5),
    intrinsics: INTRINSICS, poseConfidence: 0.92, sharpness: 189, roomId: 'r_bed1',
  },
  {
    id: 'cam_bed2_01', captureId: 'cap_001', frameIndex: 350, tMs: 11700,
    position: [8.40, 1.58, 4.60], orientation: yawQuat(-Math.PI / 2),
    intrinsics: INTRINSICS, poseConfidence: 0.9, sharpness: 174, roomId: 'r_bed2',
  },
];

// ---------------------------------------------------------------------------
// Navigation graph
// ---------------------------------------------------------------------------

interface NodeSpec {
  id: string; roomId?: string; position: Vec3; clearance: number;
  isEntrance?: boolean; isViewpoint?: boolean;
}

const navSpecs: NodeSpec[] = [
  { id: 'n_hall_a', roomId: 'r_hall', position: [5.30, 0, 1.00], clearance: 0.80, isEntrance: true, isViewpoint: true },
  { id: 'n_hall_b', roomId: 'r_hall', position: [5.30, 0, 3.20], clearance: 0.82, isViewpoint: true },
  { id: 'n_hall_c', roomId: 'r_hall', position: [5.30, 0, 5.30], clearance: 0.78 },
  { id: 'n_door_kitchen', position: [4.40, 0, 1.60], clearance: 0.42 },
  { id: 'n_kitchen_a', roomId: 'r_kitchen', position: [3.60, 0, 1.40], clearance: 0.85, isViewpoint: true },
  { id: 'n_kitchen_b', roomId: 'r_kitchen', position: [1.45, 0, 3.40], clearance: 1.05, isViewpoint: true },
  { id: 'n_door_bath', position: [4.40, 0, 5.20], clearance: 0.38 },
  { id: 'n_bath_a', roomId: 'r_bath', position: [3.55, 0, 5.25], clearance: 0.55, isViewpoint: true },
  { id: 'n_door_bed1', position: [6.20, 0, 1.60], clearance: 0.42 },
  { id: 'n_bed1_a', roomId: 'r_bed1', position: [9.10, 0, 1.70], clearance: 1.10, isViewpoint: true },
  { id: 'n_door_bed2', position: [6.20, 0, 4.90], clearance: 0.42 },
  { id: 'n_bed2_a', roomId: 'r_bed2', position: [8.50, 0, 4.20], clearance: 0.95, isViewpoint: true },
];

const navNodes = navSpecs.map((n) => ({
  id: n.id,
  ...(n.roomId ? { roomId: n.roomId } : {}),
  position: n.position,
  clearance: n.clearance,
  isEntrance: n.isEntrance === true,
  isViewpoint: n.isViewpoint === true,
}));

const navPositions = new Map(navSpecs.map((n) => [n.id, n.position]));

function edge(a: string, b: string, kind: 'walk' | 'door' | 'stair', openingId?: string) {
  const pa = navPositions.get(a)!;
  const pb = navPositions.get(b)!;
  const len = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
  // A doorway costs a little more than its length: a threshold, a turn, and a
  // camera that has to slow down. Walk edges cost exactly their length, which
  // keeps the A* heuristic tight.
  const cost = kind === 'door' ? len * 1.15 : len;
  return {
    a, b, cost, kind,
    ...(kind === 'door' ? { width: 0.838 } : {}),
    ...(openingId ? { openingId } : {}),
  };
}

const navEdges = [
  edge('n_hall_a', 'n_hall_b', 'walk'),
  edge('n_hall_b', 'n_hall_c', 'walk'),
  edge('n_hall_a', 'n_door_kitchen', 'door', 'o_door_kitchen'),
  edge('n_door_kitchen', 'n_kitchen_a', 'door', 'o_door_kitchen'),
  edge('n_kitchen_a', 'n_kitchen_b', 'walk'),
  edge('n_hall_c', 'n_door_bath', 'door', 'o_door_bath'),
  edge('n_door_bath', 'n_bath_a', 'door', 'o_door_bath'),
  edge('n_hall_a', 'n_door_bed1', 'door', 'o_door_bed1'),
  edge('n_door_bed1', 'n_bed1_a', 'door', 'o_door_bed1'),
  edge('n_hall_c', 'n_door_bed2', 'door', 'o_door_bed2'),
  edge('n_door_bed2', 'n_bed2_a', 'door', 'o_door_bed2'),
];

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const FLAT: WorldDocument = {
  formatVersion: 1,
  id: 'world_flat_demo',
  propertyId: 'prop_demo_0001',
  version: 3,
  slug: 'two-bed-flat-demo',
  label: 'Two-bedroom flat, ground floor',
  createdAt: '2026-02-11T09:14:00.000Z',
  publishedAt: '2026-02-11T11:02:00.000Z',

  units: { length: 'm', angle: 'rad' },
  upAxis: 'Y',
  handedness: 'right',

  scale: {
    source: 'ARKit depth + door-leaf prior (2 estimators)',
    agreement: 0.981,
    grounding: g('reconstructed', 0.94),
  },

  floors: [
    { id: 'f_ground', level: 0, name: 'Ground floor', elevation: 0, grounding: g('reconstructed', 0.95) },
  ],
  rooms,
  surfaces,
  openings,
  entities,
  // Left empty on purpose: the scene graph is derived from geometry by
  // buildSceneGraph, and a fixture that pre-declares it would test nothing.
  relationships: [],
  nav: { nodes: navNodes, edges: navEdges },
  regions: [
    {
      id: 'rg_hall_observed',
      provenance: 'observed',
      volume: { min: [4.45, 0, 0.25], max: [6.15, 2.40, 6.15] },
      roomId: 'r_hall',
      reason: 'walked end to end with continuous coverage',
      confidence: 0.97,
    },
    {
      // Deliberately clear of every entity: the point of this region is that a
      // measurement reaching INTO it is refused, not that an observed wardrobe
      // standing next to it becomes undefendable.
      id: 'rg_bed1_far_corner',
      provenance: 'generated',
      volume: { min: [9.95, 0, 2.05], max: [10.76, 2.40, 3.36] },
      roomId: 'r_bed1',
      reason: 'corner occluded by the wardrobe for the whole capture; volume is model infill',
      confidence: 0.3,
    },
    {
      id: 'rg_bath_ceiling',
      provenance: 'inferred',
      volume: { min: [2.65, 2.10, 4.05], max: [4.35, 2.42, 6.15] },
      roomId: 'r_bath',
      reason: 'ceiling plane never in view; closed from the neighbouring rooms',
      confidence: 0.55,
    },
    {
      id: 'rg_hall_ceiling_void',
      provenance: 'generated',
      volume: { min: [4.45, 2.40, 0.25], max: [6.15, 2.85, 6.15] },
      reason: 'void above the hall ceiling; nothing was observed there',
      confidence: 0.1,
    },
  ],
  cameras,
  assets: [
    {
      id: 'a_proxy', role: 'proxy_mesh', format: 'glb',
      url: 'asset://prop_demo_0001/proxy.glb', bytes: 812_444, lod: 0,
    },
    {
      id: 'a_splat_kitchen', role: 'splat_chunk', format: 'spz',
      url: 'asset://prop_demo_0001/splat/r_kitchen.spz',
      bytes: 18_220_100, chunkKey: 'r_kitchen', splatCount: 1_240_000,
    },
    {
      id: 'a_cover', role: 'cover', format: 'jpg',
      url: 'asset://prop_demo_0001/cover.jpg', bytes: 244_100,
    },
  ],

  quality: {
    checks: [
      { name: 'scale_agreement', value: 0.981, threshold: 0.95, higherIsBetter: true, pass: true },
      { name: 'pose_coverage', value: 0.93, threshold: 0.85, higherIsBetter: true, pass: true },
      { name: 'unobserved_volume_fraction', value: 0.041, threshold: 0.08, higherIsBetter: false, pass: true },
      {
        name: 'ceiling_observed_fraction', value: 0.79, threshold: 0.85, higherIsBetter: true,
        pass: false, detail: 'bathroom ceiling never in view',
      },
    ],
    score: 0.91,
    verdict: 'review',
    createdAt: '2026-02-11T10:58:00.000Z',
  },

  measurementPolicy: {
    areaStandard: 'RICS-COMP-GIA',
    areaTolerancePct: AREA_TOLERANCE_PCT,
    wallToleranceMm: WALL_TOLERANCE_MM,
  },
};

/** Clear internal areas, m2, for assertions that should not re-derive them. */
export const FLAT_AREAS: Readonly<Record<string, number>> = {
  r_hall: 1.70 * 5.90,
  r_kitchen: 4.10 * 3.70 + 2.30 * 2.20,
  r_bath: 1.70 * 2.10,
  r_bed1: 4.50 * 3.10,
  r_bed2: 4.50 * 2.70,
};
