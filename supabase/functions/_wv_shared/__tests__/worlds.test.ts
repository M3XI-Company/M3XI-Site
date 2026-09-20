/**
 * WHO MAY CHANGE A WORLD, AND WHAT A CORRECTION IS ALLOWED TO SAY.
 *
 * Two things are pinned here and they are the two that cost real money or real
 * credibility.
 *
 * The first is the role gate. `viewer` is defined by the console's own
 * ROLE_DESCRIPTIONS as "Read-only ... changes nothing", and until this file
 * existed only `resume_build` checked it: a viewer could start a build, which
 * commits a GPU bill, and publish a stranger's home to the open web. The
 * console never drew those buttons, which is exactly why the test has to be
 * here -- nothing requires a request to come from the console.
 *
 * The second is that a corrected number is never a bare number. Every
 * dimension correction writes a wv_measurement row carrying the standard, the
 * tolerance, its unit, the confidence and a basis naming who said so and what
 * they measured it with; and geometry a human moved comes out `inferred`,
 * never `reconstructed`, because no reconstruction derived it.
 *
 * The rig seeds one world with one of everything the correction vocabulary can
 * name, so a test asserts on the row that changed rather than on a mock.
 */

import { describe, expect, it } from 'vitest';

import { handleWorlds } from '../../wv-worlds/handler.ts';
import type { HttpRequest } from '../http.ts';
import { bearer, makeTestDeps, seedTenant } from './fakes.ts';
import type { TestDeps } from './fakes.ts';

type Row = Record<string, unknown>;

function post(body: Record<string, unknown>, headers: Record<string, string> = {}): HttpRequest {
  return { method: 'POST', path: '/', query: {}, headers, body };
}

const TOKEN = 'operator-token';
const AUTH = bearer(TOKEN);

interface Rig {
  readonly deps: TestDeps;
  readonly worldId: string;
  readonly orgId: string;
  readonly livingRoom: string;
  readonly kitchen: string;
  readonly sofa: string;
  readonly wall: string;
  /** The living room's other three panels, so a cascade has something to take. */
  readonly floorSurface: string;
  readonly ceilingSurface: string;
  readonly wall2: string;
  /** The neighbour's wall. It must still be there afterwards. */
  readonly kitchenWall: string;
  readonly doorway: string;
  /** A door naming the living room on its FAR side, so both directions cascade. */
  readonly innerDoor: string;
  /** The kitchen's own window, which no deletion of the living room may touch. */
  readonly kitchenWindow: string;
  readonly hallNode: string;
  readonly gardenNode: string;
  readonly camera: string;
}

/**
 * `wv_delete_world_row`, as
 * supabase/migrations/20260920140000_world_viewer_corrections.sql defines it
 * and as exercising it against the live project proved it behaves.
 *
 * FakeDb's own header says what it is and is not: a faithful model of
 * PostgREST's SHAPE, and not a model of Postgres -- no constraints, and no
 * referential actions. So the cascade has to be written here, once, in the
 * place the handler cannot see, rather than asserted into existence by a test.
 * Every line below is a foreign key from the core migration:
 *
 *   wv_surface.room_id        ON DELETE CASCADE
 *   wv_opening.room_a/room_b  ON DELETE CASCADE
 *   wv_entity.room_id         ON DELETE SET NULL
 *   wv_nav_node.room_id       ON DELETE SET NULL
 *   wv_camera.room_id         ON DELETE SET NULL
 *   wv_region.room_id         ON DELETE SET NULL
 *
 * wv_relationship has no foreign key -- subject_id and object_id are bare
 * uuids over four kinds of object -- so the FUNCTION deletes the edges naming
 * the deleted row itself, in the same statement. That is modelled below too,
 * because it is behaviour of wv_delete_world_row rather than of Postgres, and
 * because the alternative it replaced was a rendered world in which wv-ask
 * could answer a question about a room an operator had deleted.
 */
function installDeleteRpc(db: TestDeps['db']): void {
  db.rpcs.set('wv_delete_world_row', (args) => {
    const table = String(args['p_table']);
    const world = args['p_world'];
    const id = args['p_id'];

    // The allowlist is a CASE in the function, and anything else raises
    // invalid_parameter_value rather than deleting from a table nobody vetted.
    if (table !== 'wv_room' && table !== 'wv_entity' && table !== 'wv_region') {
      throw new Error(`wv_delete_world_row: ${table} is not a table an operator may delete from`);
    }

    // Every branch filters world_id as well as id: a row of another tenant's
    // world is not reachable even with its uuid in hand.
    const rows = db.rows(table);
    const at = rows.findIndex((r) => r['id'] === id && r['world_id'] === world);
    if (at < 0) return 0;
    rows.splice(at, 1);

    if (table === 'wv_room') {
      for (const child of ['wv_surface', 'wv_opening'] as const) {
        const list = db.rows(child);
        for (let i = list.length - 1; i >= 0; i--) {
          const row = list[i]!;
          const touches = child === 'wv_surface'
            ? row['room_id'] === id
            : row['room_a'] === id || row['room_b'] === id;
          if (touches) list.splice(i, 1);
        }
      }
      for (const detached of ['wv_entity', 'wv_nav_node', 'wv_camera', 'wv_region'] as const) {
        for (const row of db.rows(detached)) {
          if (row['room_id'] === id) row['room_id'] = null;
        }
      }
    }

    // The scene graph, removed by the function rather than by a key. Scoped by
    // world as well as by id, exactly as the SQL is.
    const edges = db.rows('wv_relationship');
    for (let i = edges.length - 1; i >= 0; i--) {
      const edge = edges[i]!;
      if (edge['world_id'] !== world) continue;
      if (edge['subject_id'] === id || edge['object_id'] === id) edges.splice(i, 1);
    }
    return 1;
  });
}

/**
 * One world, furnished.
 *
 * `verdict` decides what the quality gate will say; 'none' seeds no quality
 * row at all, which is the case a publish must refuse rather than default-allow.
 */
function rig(opts: {
  role?: 'owner' | 'admin' | 'operator' | 'viewer';
  verdict?: 'pass' | 'review' | 'none';
} = {}): Rig {
  const deps = makeTestDeps({ users: { [TOKEN]: 'user-1' } });
  const tenant = seedTenant(deps.db, { userId: 'user-1', role: opts.role ?? 'operator' });
  const db = deps.db;

  installDeleteRpc(db);

  const livingRoom = db.nextId();
  const kitchen = db.nextId();
  const sofa = db.nextId();
  const wall = db.nextId();
  const floorSurface = db.nextId();
  const ceilingSurface = db.nextId();
  const wall2 = db.nextId();
  const kitchenWall = db.nextId();
  const doorway = db.nextId();
  const innerDoor = db.nextId();
  const kitchenWindow = db.nextId();
  const hallNode = db.nextId();
  const gardenNode = db.nextId();
  const camera = db.nextId();

  db.seed('wv_room', [
    {
      id: livingRoom, world_id: tenant.worldId, stable_key: 'r-living', name: 'Living room',
      kind: 'living', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], floor_z: 0, ceiling_z: 2.4,
      area_m2: 12, area_standard: 'RICS-COMP-GIA', area_tol_pct: 3, wall_tol_mm: 25,
      provenance: 'reconstructed', confidence: 0.82, updated_at: '2026-09-10T09:00:00.000Z',
    },
    {
      id: kitchen, world_id: tenant.worldId, stable_key: 'r-kitchen', name: 'Kitchen',
      kind: 'kitchen', polygon: [[4, 0], [7, 0], [7, 3], [4, 3]], floor_z: 0, ceiling_z: 2.4,
      area_m2: 9, area_standard: 'RICS-COMP-GIA', area_tol_pct: 3, wall_tol_mm: 25,
      provenance: 'reconstructed', confidence: 0.8, updated_at: '2026-09-10T09:00:00.000Z',
    },
  ]);
  db.seed('wv_entity', [{
    id: sofa, world_id: tenant.worldId, stable_key: 'e-sofa', label: 'Sofa',
    category: 'furniture', room_id: livingRoom,
    centroid: [1, 0.4, 1],
    aabb: { min: [0.5, 0, 0.5], max: [1.5, 0.8, 1.5] },
    obb: { centre: [1, 0.4, 1], half: [0.5, 0.4, 0.5], quat: [0, 0, 0, 1] },
    // A real camera list, so a test can prove a correction receipt never gets
    // anywhere near it. `observed_in` is uuid[]; a 'correction:...' token in
    // there would corrupt the one field that genuinely lists frames.
    observed_in: [camera], provenance: 'reconstructed', confidence: 0.71, attributes: {},
    updated_at: '2026-09-10T09:00:00.000Z',
  }]);
  // Four panels in the living room and one in the kitchen. The count is not
  // decoration: deleting a room has to take its own four and leave the
  // neighbour's one, and a rig with a single surface could not tell the
  // difference between "cascaded correctly" and "deleted everything".
  db.seed('wv_surface', [
    {
      id: wall, world_id: tenant.worldId, room_id: livingRoom, kind: 'wall',
      plane: { n: [0, 0, 1], d: 0 }, polygon: [], area_m2: 8,
      is_reflective: false, is_glazed: false, provenance: 'reconstructed', confidence: 0.8,
      updated_at: '2026-09-10T09:00:00.000Z',
    },
    {
      id: wall2, world_id: tenant.worldId, room_id: livingRoom, kind: 'wall',
      plane: { n: [1, 0, 0], d: 0 }, polygon: [], area_m2: 7,
      is_reflective: false, is_glazed: false, provenance: 'reconstructed', confidence: 0.8,
    },
    {
      id: floorSurface, world_id: tenant.worldId, room_id: livingRoom, kind: 'floor',
      plane: { n: [0, 1, 0], d: 0 }, polygon: [], area_m2: 12,
      is_reflective: false, is_glazed: false, provenance: 'reconstructed', confidence: 0.9,
    },
    {
      id: ceilingSurface, world_id: tenant.worldId, room_id: livingRoom, kind: 'ceiling',
      plane: { n: [0, -1, 0], d: 2.4 }, polygon: [], area_m2: 12,
      is_reflective: false, is_glazed: false, provenance: 'reconstructed', confidence: 0.6,
    },
    {
      id: kitchenWall, world_id: tenant.worldId, room_id: kitchen, kind: 'wall',
      plane: { n: [0, 0, 1], d: 0 }, polygon: [], area_m2: 6,
      is_reflective: false, is_glazed: false, provenance: 'reconstructed', confidence: 0.8,
    },
  ]);
  // Two openings touch the living room, and they touch it from opposite sides
  // of the pair: the doorway names it as room_a, the inner door as room_b.
  // Both foreign keys cascade, and a rig that only ever used room_a would let
  // a handler counting one side look correct.
  db.seed('wv_opening', [
    {
      id: doorway, world_id: tenant.worldId, kind: 'doorway', surface_id: null,
      room_a: livingRoom, room_b: null, centre: [4, 1, 1.5], normal: [1, 0, 0],
      width_m: 0.8, height_m: 2.0, sill_m: null,
      provenance: 'reconstructed', confidence: 0.75, updated_at: '2026-09-10T09:00:00.000Z',
    },
    {
      id: innerDoor, world_id: tenant.worldId, kind: 'door', surface_id: null,
      room_a: kitchen, room_b: livingRoom, centre: [4, 1, 2.5], normal: [1, 0, 0],
      width_m: 0.76, height_m: 2.0, sill_m: null,
      provenance: 'reconstructed', confidence: 0.7,
    },
    {
      id: kitchenWindow, world_id: tenant.worldId, kind: 'window', surface_id: null,
      room_a: kitchen, room_b: null, centre: [7, 1.2, 1.5], normal: [1, 0, 0],
      width_m: 1.2, height_m: 1.1, sill_m: 0.9,
      provenance: 'reconstructed', confidence: 0.7,
    },
  ]);
  // One scene-graph edge naming the room. It has no foreign key behind it, so
  // it survives the room and the handler has to say so.
  db.seed('wv_relationship', [{
    id: 1, world_id: tenant.worldId,
    subject_type: 'entity', subject_id: sofa,
    predicate: 'inside', object_type: 'room', object_id: livingRoom,
    value: null, provenance: 'reconstructed', confidence: 0.9,
  }]);
  db.seed('wv_nav_node', [
    {
      id: hallNode, world_id: tenant.worldId, room_id: livingRoom, position: [0.5, 1.6, 0.5],
      clearance_m: 0.6, is_entrance: true, is_viewpoint: false,
    },
    {
      id: gardenNode, world_id: tenant.worldId, room_id: kitchen, position: [6.5, 1.6, 2.5],
      clearance_m: 0.6, is_entrance: false, is_viewpoint: false,
    },
  ]);
  db.seed('wv_camera', [{
    id: camera, world_id: tenant.worldId, capture_id: null, frame_index: 12, t_ms: 4000,
    px: 1, py: 1.6, pz: 1, qx: 0, qy: 0, qz: 0, qw: 1,
    intrinsics: { fx: 900, fy: 900, cx: 640, cy: 360, w: 1280, h: 720, model: 'pinhole' },
    pose_confidence: 0.9, sharpness: 120, room_id: livingRoom,
  }]);

  // The cached document, so `markWorldDocumentStale` has something to mark.
  // Without it the call is a no-op and the test could not tell the difference
  // between "invalidated the cache" and "never tried".
  db.seed('wv_asset', [{
    id: db.nextId(), world_id: tenant.worldId, role: 'export_bundle', format: 'json',
    storage_path: `${tenant.worldId}/world.json`, chunk_key: 'world-document', lod: 0,
    bytes: 100, checksum: 'seed', meta: { stale: false },
  }]);

  const verdict = opts.verdict ?? 'pass';
  if (verdict !== 'none') {
    db.seed('wv_quality', [{
      id: db.nextId(), world_id: tenant.worldId,
      checks: verdict === 'pass'
        ? [{ name: 'ceiling_observed_fraction', pass: true }]
        : [{ name: 'ceiling_observed_fraction', pass: false }],
      score: verdict === 'pass' ? 0.93 : 0.61,
      verdict,
      created_at: '2026-09-19T12:00:00.000Z',
    }]);
  }

  return {
    deps, worldId: tenant.worldId, orgId: tenant.orgId,
    livingRoom, kitchen, sofa, wall, floorSurface, ceilingSurface, wall2, kitchenWall,
    doorway, innerDoor, kitchenWindow, hallNode, gardenNode, camera,
  };
}

/** Apply one correction through the real handler and hand back the body. */
async function correct(
  r: Rig, change: Record<string, unknown>, headers: Record<string, string> = AUTH,
): Promise<{
  status: number; applied: number; changed: number; rejected: string[]; cascades: string[];
}> {
  const res = await handleWorlds(
    post({ action: 'approve_corrections', worldId: r.worldId, corrections: [change] }, headers),
    r.deps,
  );
  const body = res.body as {
    applied?: number; changed?: number; rejected?: string[]; cascades?: string[];
  };
  return {
    status: res.status,
    applied: body.applied ?? 0,
    changed: body.changed ?? 0,
    rejected: body.rejected ?? [],
    cascades: body.cascades ?? [],
  };
}

/** The receipt tokens on a row, or [] when nothing has ever corrected it. */
function receipts(r: Rig, table: string, id: string): string[] {
  const value = rowById(r, table, id)['correction_sources'];
  return Array.isArray(value) ? value.map(String) : [];
}

function rowById(r: Rig, table: string, id: string): Row {
  const row = r.deps.db.rows(table).find((x) => x['id'] === id);
  expect(row, `${table}:${id} vanished`).toBeDefined();
  return row!;
}

function documentIsStale(r: Rig): boolean {
  const asset = r.deps.db.rows('wv_asset').find((a) => a['chunk_key'] === 'world-document');
  return (asset?.['meta'] as { stale?: boolean } | undefined)?.stale === true;
}

// ---------------------------------------------------------------------------
// The role gate
// ---------------------------------------------------------------------------

describe('who may change a world', () => {
  /** Every action that spends money, rewrites a fact, or changes who can see it. */
  const CHANGING_ACTIONS = (r: Rig): Record<string, unknown>[] => ([
    { action: 'request_build', worldId: r.worldId },
    { action: 'resume_build', worldId: r.worldId },
    { action: 'publish', worldId: r.worldId },
    { action: 'unpublish', worldId: r.worldId },
    {
      action: 'approve_corrections', worldId: r.worldId,
      corrections: [{ kind: 'room.rename', roomId: r.livingRoom, name: 'Pwned' }],
    },
    {
      action: 'register_capture', worldId: r.worldId, kind: 'video',
      storagePath: `${r.worldId}/walkthrough.mp4`,
    },
  ]);

  it('refuses a viewer every one of them, with a reason', async () => {
    const r = rig({ role: 'viewer' });
    for (const body of CHANGING_ACTIONS(r)) {
      const res = await handleWorlds(post(body, AUTH), r.deps);
      expect(res.status, String(body['action'])).toBe(403);
      // A refusal with no reason is how a user concludes the product is broken.
      expect(String((res.body as { error: string }).error)).toMatch(/operator, admin or owner/);
    }
    // And nothing happened: no GPU queued, nothing published, nothing renamed,
    // no capture row. A 403 that still wrote would be the worst of both.
    expect(r.deps.db.rows('wv_job')).toHaveLength(0);
    expect(r.deps.db.rows('wv_capture')).toHaveLength(0);
    expect(rowById(r, 'wv_room', r.livingRoom)['name']).toBe('Living room');
    expect(rowById(r, 'wv_world', r.worldId)['status']).toBe('draft');
  });

  it('lets a viewer read the world it is a member of', async () => {
    // The gate is on CHANGE, not on access. A viewer who could not read the
    // portfolio would not be a viewer.
    const r = rig({ role: 'viewer' });
    const res = await handleWorlds(post({ action: 'get_world', worldId: r.worldId }, AUTH), r.deps);
    expect(res.status).toBe(200);
  });

  it('allows an operator to build, correct, publish and unpublish', async () => {
    const r = rig({ role: 'operator' });

    const build = await handleWorlds(post({ action: 'request_build', worldId: r.worldId }, AUTH), r.deps);
    expect(build.status).toBe(202);

    const correction = await correct(r, { kind: 'room.rename', roomId: r.livingRoom, name: 'Sitting room' });
    expect(correction.applied).toBe(1);

    const published = await handleWorlds(post({ action: 'publish', worldId: r.worldId }, AUTH), r.deps);
    expect(published.status).toBe(200);
    expect(rowById(r, 'wv_world', r.worldId)['status']).toBe('published');

    const offline = await handleWorlds(post({ action: 'unpublish', worldId: r.worldId }, AUTH), r.deps);
    expect(offline.status).toBe(200);
    expect(rowById(r, 'wv_world', r.worldId)['status']).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// The publish gate
// ---------------------------------------------------------------------------

describe('the publish gate', () => {
  it('refuses a world that has never been assessed', async () => {
    // Missing is not the same as passing. A world with no quality row is
    // indistinguishable from one that failed, so it is refused.
    const r = rig({ verdict: 'none' });
    const res = await handleWorlds(post({ action: 'publish', worldId: r.worldId }, AUTH), r.deps);
    expect(res.status).toBe(409);
    expect(String((res.body as { error: string }).error)).toMatch(/quality gate/);
    expect(rowById(r, 'wv_world', r.worldId)['status']).toBe('draft');
  });

  it('refuses a verdict that is not a pass, and names the check that failed', async () => {
    const r = rig({ verdict: 'review' });
    const res = await handleWorlds(post({ action: 'publish', worldId: r.worldId }, AUTH), r.deps);
    expect(res.status).toBe(409);
    const error = String((res.body as { error: string }).error);
    expect(error).toMatch(/review/);
    expect(error).toMatch(/ceiling_observed_fraction/);
    expect(rowById(r, 'wv_world', r.worldId)['published_at'] ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Semantics
// ---------------------------------------------------------------------------

describe('semantic corrections', () => {
  it('renames a room without touching how its polygon was derived', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'room.rename', roomId: r.livingRoom, name: 'Sitting room' });
    expect(out.applied).toBe(1);

    const room = rowById(r, 'wv_room', r.livingRoom);
    expect(room['name']).toBe('Sitting room');
    // Rule 2: renaming measured nothing, so the geometry is exactly as
    // reconstructed as it was. Downgrading it would corrupt every measurement
    // that reads the polygon.
    expect(room['provenance']).toBe('reconstructed');
    // Rule 5: what DOES move is the confidence, to the declared human ceiling.
    expect(room['confidence']).toBe(0.9);
    expect(documentIsStale(r)).toBe(true);
  });

  it('refuses a room kind the schema does not have', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'room.kind', roomId: r.livingRoom, roomKind: 'dungeon' });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/not a room kind/);
    expect(rowById(r, 'wv_room', r.livingRoom)['kind']).toBe('living');
  });

  it('will not move an entity into a room that is not in this world', async () => {
    const r = rig();
    const elsewhere = r.deps.db.nextId();
    const out = await correct(r, { kind: 'entity.room', entityId: r.sofa, roomId: elsewhere });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/no room/);
    expect(rowById(r, 'wv_entity', r.sofa)['room_id']).toBe(r.livingRoom);
  });

  it('detaches an entity from every room when asked for null', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'entity.room', entityId: r.sofa, roomId: null });
    expect(out.applied).toBe(1);
    expect(rowById(r, 'wv_entity', r.sofa)['room_id']).toBeNull();
  });

  it('still accepts the five-field shape the console sends', async () => {
    // spatial/apps/console's fallback room table writes {target, id, field,
    // value} today. Breaking it to tidy up a wire format would take away the
    // only correction UI that ships.
    const r = rig();
    const res = await handleWorlds(post({
      action: 'approve_corrections', worldId: r.worldId,
      corrections: [
        { target: 'room', id: r.livingRoom, field: 'name', value: 'Sitting room' },
        // A hand-edited polygon, and a bare area with no standard, tolerance
        // or instrument. Both still refused.
        { target: 'room', id: r.livingRoom, field: 'polygon', value: '[[0,0]]' },
        { target: 'room', id: r.livingRoom, field: 'area_m2', value: '99' },
      ],
    }, AUTH), r.deps);
    const body = res.body as { applied: number; rejected: string[] };
    expect(body.applied).toBe(1);
    expect(body.rejected).toHaveLength(2);
    const room = rowById(r, 'wv_room', r.livingRoom);
    expect(room['name']).toBe('Sitting room');
    expect(room['area_m2']).toBe(12);
  });

  it('refuses a kind it does not know rather than ignoring it', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'room.demolish', roomId: r.livingRoom });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/is not a correction this endpoint knows/);
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe('geometry a human moved', () => {
  it('moves the centroid, the box and the oriented box together, and calls it inferred', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'entity.move', entityId: r.sofa, centroid: [2, 0.4, 2] });
    expect(out.applied).toBe(1);

    const sofa = rowById(r, 'wv_entity', r.sofa);
    expect(sofa['centroid']).toEqual([2, 0.4, 2]);
    // The whole box travelled by the same delta. A box that lags its centroid
    // is a bug you find months later in a fit test.
    expect(sofa['aabb']).toEqual({ min: [1.5, 0, 1.5], max: [2.5, 0.8, 2.5] });
    expect((sofa['obb'] as { centre: number[] })['centre']).toEqual([2, 0.4, 2]);
    // Rule 3, and the reason this test exists: no camera saw the sofa there
    // and no reconstruction derived it, so the row must stop claiming it was
    // reconstructed.
    expect(sofa['provenance']).toBe('inferred');
    expect(sofa['confidence']).toBe(0.9);
  });

  it('never strengthens provenance', async () => {
    // Rule 1. A human cannot promote model infill to observed geometry by
    // typing over it; the fix for "nobody scanned that" is a rescan.
    const r = rig();
    await r.deps.db.update('wv_entity', { provenance: 'generated' }, { id: r.sofa });
    await correct(r, { kind: 'entity.move', entityId: r.sofa, centroid: [2, 0.4, 2] });
    expect(rowById(r, 'wv_entity', r.sofa)['provenance']).toBe('generated');
  });

  it('resizes about the base, so the furniture stays on the floor', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'entity.resize', entityId: r.sofa, size: [2, 1, 1] });
    expect(out.applied).toBe(1);

    const sofa = rowById(r, 'wv_entity', r.sofa);
    const box = sofa['aabb'] as { min: number[]; max: number[] };
    // Base held at y = 0: a wardrobe scaled about its centroid buries half of
    // itself in the slab.
    expect(box.min[1]).toBe(0);
    expect(box.max[1]).toBe(1);
    expect(box.min[0]).toBeCloseTo(0, 6);
    expect(box.max[0]).toBeCloseTo(2, 6);
    expect(sofa['centroid']).toEqual([1, 0.5, 1]);
    expect(sofa['provenance']).toBe('inferred');
  });

  it('refuses a size that is not three positive metres', async () => {
    const r = rig();
    for (const size of [[0, 1, 1], [1, 1], [1, 'x', 1], [1, Infinity, 1]]) {
      const out = await correct(r, { kind: 'entity.resize', entityId: r.sofa, size });
      expect(out.applied, JSON.stringify(size)).toBe(0);
    }
    expect(rowById(r, 'wv_entity', r.sofa)['aabb']).toEqual({ min: [0.5, 0, 0.5], max: [1.5, 0.8, 1.5] });
  });
});

// ---------------------------------------------------------------------------
// Dimensions — a number alone never enters the system
// ---------------------------------------------------------------------------

describe('a corrected dimension', () => {
  function measurements(r: Rig): Row[] {
    return r.deps.db.rows('wv_measurement');
  }

  it('records a site measurement with the instrument that supports it', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'dimension.set',
      target: { kind: 'opening.width', openingId: r.doorway },
      value: 0.835, method: 'site-measure', instrument: 'laser',
    });
    expect(out.applied).toBe(1);

    expect(rowById(r, 'wv_opening', r.doorway)['width_m']).toBe(0.835);

    const m = measurements(r);
    expect(m).toHaveLength(1);
    const row = m[0]!;
    expect(row['world_id']).toBe(r.worldId);
    expect(row['value']).toBe(0.835);
    expect(row['unit']).toBe('m');
    expect(row['standard']).toBe('CLEAR-INTERNAL');
    // The laser's own accuracy, not the reconstruction's 25 mm. This is the
    // entire reason an operator goes and measures the room.
    expect(row['tolerance']).toBe(3);
    expect(row['tolerance_unit']).toBe('mm');
    expect(row['confidence']).toBe(0.9);

    const basis = row['basis'] as Record<string, unknown>;
    expect(basis['corrected']).toBe(true);
    expect(basis['defensible']).toBe(true);
    expect(basis['method']).toBe('site-measure');
    expect(basis['instrument']).toBe('laser');
    // Who said so, and when. The receipt is the point.
    expect(basis['statedBy']).toBe('user-1');
    expect(basis['statedAt']).toBe('2026-09-20T12:00:00.000Z');
    // Both answers survive: the reconstruction's and the operator's.
    expect(basis['supersededValue']).toBe(0.8);
    expect(basis['refusalReason']).toBeUndefined();

    // And the opening itself is now an inferred dimension, not a reconstructed one.
    expect(rowById(r, 'wv_opening', r.doorway)['provenance']).toBe('inferred');
  });

  it('widens an estimate instead of dressing it up as a measurement', async () => {
    const r = rig();
    await correct(r, {
      kind: 'dimension.set',
      target: { kind: 'opening.height', openingId: r.doorway },
      value: 2.04, method: 'estimate', instrument: 'unknown',
    });
    const row = measurements(r)[0]!;
    // The document policy (25 mm, recovered from the rooms) widened by the
    // provenance factor of 2 for inferred. No instrument, no credit.
    expect(row['tolerance']).toBe(50);
    expect(row['tolerance_unit']).toBe('mm');
    const basis = row['basis'] as Record<string, unknown>;
    expect(basis['defensible']).toBe(false);
    expect(basis['refusalReason']).toMatch(/entered by an operator as an estimate/);
  });

  it('gives a site measurement with no instrument an estimate treatment, and says why', async () => {
    const r = rig();
    await correct(r, {
      kind: 'dimension.set',
      target: { kind: 'opening.sill', openingId: r.doorway },
      value: 0.45, method: 'site-measure', instrument: 'unknown',
    });
    const basis = measurements(r)[0]!['basis'] as Record<string, unknown>;
    expect(basis['defensible']).toBe(false);
    expect(basis['refusalReason']).toMatch(/named no instrument/);
  });

  it('sets a room area, and does not retighten the world policy column', async () => {
    const r = rig();
    await correct(r, {
      kind: 'dimension.set',
      target: { kind: 'room.area', roomId: r.livingRoom },
      value: 12.5, method: 'site-measure', instrument: 'laser',
      standard: 'IPMS-3C',
    });

    const room = rowById(r, 'wv_room', r.livingRoom);
    expect(room['area_m2']).toBe(12.5);
    expect(room['area_standard']).toBe('IPMS-3C');
    // worldDocument.ts recovers the world's area policy as the MINIMUM of this
    // column and documents that every stored value is >= the policy. A single
    // 0.17% room would quietly retighten the tolerance quoted for every
    // surface in the property, so the column stays where it was.
    expect(room['area_tol_pct']).toBe(3);

    const row = r.deps.db.rows('wv_measurement')[0]!;
    expect(row['kind']).toBe('area');
    expect(row['unit']).toBe('m2');
    // Two 3 mm readings on the sides of a 12.5 m2 room: about 0.17%.
    expect(Number(row['tolerance'])).toBeCloseTo(0.17, 2);
    expect(row['tolerance_unit']).toBe('pct');
    expect((row['basis'] as Record<string, unknown>)['supersededValue']).toBe(12);
  });

  it('moves the ceiling plane, not the floor, for a ceiling height', async () => {
    const r = rig();
    await r.deps.db.update('wv_room', { floor_z: 0.15, ceiling_z: 2.55 }, { id: r.livingRoom });
    await correct(r, {
      kind: 'dimension.set',
      target: { kind: 'room.ceilingHeight', roomId: r.livingRoom },
      value: 2.38, method: 'site-measure', instrument: 'tape',
    });

    const room = rowById(r, 'wv_room', r.livingRoom);
    // An operator measuring floor to ceiling is measuring the ceiling.
    expect(Number(room['floor_z'])).toBe(0.15);
    expect(Number(room['ceiling_z'])).toBeCloseTo(2.53, 6);
    expect(room['provenance']).toBe('inferred');

    const row = r.deps.db.rows('wv_measurement')[0]!;
    expect(row['kind']).toBe('height');
    expect(row['tolerance']).toBe(10);
    expect((row['basis'] as Record<string, unknown>)['instrument']).toBe('tape');
    // The wall policy is the world's, not this measurement's, and is untouched.
    expect(Number(room['wall_tol_mm'])).toBe(25);
  });

  it('refuses a dimension that is not a positive number, and writes nothing', async () => {
    const r = rig();
    for (const value of [0, -1, 'wide', null]) {
      const out = await correct(r, {
        kind: 'dimension.set',
        target: { kind: 'opening.width', openingId: r.doorway },
        value, method: 'estimate', instrument: 'unknown',
      });
      expect(out.applied, String(value)).toBe(0);
    }
    expect(r.deps.db.rows('wv_measurement')).toHaveLength(0);
    expect(rowById(r, 'wv_opening', r.doorway)['width_m']).toBe(0.8);
  });

  it('refuses an instrument it has never heard of rather than treating it as unknown', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'dimension.set',
      target: { kind: 'opening.width', openingId: r.doorway },
      value: 0.9, method: 'site-measure', instrument: 'laserr',
    });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/not an instrument/);
    expect(r.deps.db.rows('wv_measurement')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The two known reconstruction failure modes
// ---------------------------------------------------------------------------

describe('mirrors and glazing', () => {
  it('flags a mirror and leaves the glazing claim alone', async () => {
    const r = rig();
    await r.deps.db.update('wv_surface', { is_glazed: true }, { id: r.wall });

    const out = await correct(r, { kind: 'surface.flags', surfaceId: r.wall, isReflective: true });
    expect(out.applied).toBe(1);

    const surface = rowById(r, 'wv_surface', r.wall);
    expect(surface['is_reflective']).toBe(true);
    // Reflective and glazed are independent claims about the same panel, so
    // correcting one must not silently reset the other.
    expect(surface['is_glazed']).toBe(true);
    // The panel's polygon was reconstructed before the operator looked at it
    // and is still reconstructed after; what changed is what we know it IS.
    expect(surface['provenance']).toBe('reconstructed');
    expect(surface['confidence']).toBe(0.9);
  });

  it('refuses a flag correction that states neither flag', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'surface.flags', surfaceId: r.wall });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/isReflective, isGlazed or both/);
  });
});

// ---------------------------------------------------------------------------
// Topology and navigation
// ---------------------------------------------------------------------------

describe('topology', () => {
  it('reconnects an opening between two rooms of this world', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'opening.connects', openingId: r.doorway, roomA: r.livingRoom, roomB: r.kitchen,
    });
    expect(out.applied).toBe(1);
    const opening = rowById(r, 'wv_opening', r.doorway);
    expect(opening['room_a']).toBe(r.livingRoom);
    expect(opening['room_b']).toBe(r.kitchen);
  });

  it('refuses a door from a room to itself', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'opening.connects', openingId: r.doorway, roomA: r.kitchen, roomB: r.kitchen,
    });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/itself/);
    expect(rowById(r, 'wv_opening', r.doorway)['room_b']).toBeNull();
  });

  it('writes neither side when one of them is not in this world', async () => {
    const r = rig();
    const elsewhere = r.deps.db.nextId();
    const out = await correct(r, {
      kind: 'opening.connects', openingId: r.doorway, roomA: r.kitchen, roomB: elsewhere,
    });
    expect(out.applied).toBe(0);
    // Half a reconnection is not a state this endpoint may produce.
    expect(rowById(r, 'wv_opening', r.doorway)['room_a']).toBe(r.livingRoom);
  });

  it('changes an opening kind only to one the schema has', async () => {
    const r = rig();
    expect((await correct(r, { kind: 'opening.kind', openingId: r.doorway, openingKind: 'window' })).applied).toBe(1);
    expect(rowById(r, 'wv_opening', r.doorway)['kind']).toBe('window');
    expect((await correct(r, { kind: 'opening.kind', openingId: r.doorway, openingKind: 'portcullis' })).applied).toBe(0);
    expect(rowById(r, 'wv_opening', r.doorway)['kind']).toBe('window');
  });

  it('leaves exactly one entrance when the entrance moves', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'entrance.set', navNodeId: r.gardenNode });
    expect(out.applied).toBe(1);

    const nodes = r.deps.db.rows('wv_nav_node');
    // Two entrances is not a richer world, it is an undefined one: the viewer
    // takes whichever it finds first, so the property opens in the hall for
    // one visitor and in the garden for the next.
    expect(nodes.filter((n) => n['is_entrance'] === true).map((n) => n['id'])).toEqual([r.gardenNode]);
  });

  it('does not clear the old entrance when the new one is not in this world', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'entrance.set', navNodeId: r.deps.db.nextId() });
    expect(out.applied).toBe(0);
    // A typo must not leave a world with no front door at all.
    expect(rowById(r, 'wv_nav_node', r.hallNode)['is_entrance']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coverage, privacy, sign-off, and the three that need a delete
// ---------------------------------------------------------------------------

describe('coverage and privacy', () => {
  it('records a volume nobody looked at', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'region.mark', provenance: 'generated',
      volume: { min: [0, 0, 0], max: [1, 2.4, 1] },
      reason: 'cupboard was locked', roomId: r.livingRoom,
    });
    expect(out.applied).toBe(1);

    const region = r.deps.db.rows('wv_region')[0]!;
    expect(region['provenance']).toBe('generated');
    expect(region['room_id']).toBe(r.livingRoom);
    // 'generated' is "nobody looked", and the viewer hatches it and refuses to
    // walk into it, so the confidence is declared low rather than computed.
    expect(region['confidence']).toBe(0.1);
    // The operator is named in the note, because wv_region has nowhere else.
    expect(String(region['reason'])).toContain('user-1');
  });

  it('will not let a coverage note claim a camera saw the volume', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'region.mark', provenance: 'observed',
      volume: { min: [0, 0, 0], max: [1, 1, 1] }, reason: 'looks fine',
    });
    expect(out.applied).toBe(0);
    expect(r.deps.db.rows('wv_region')).toHaveLength(0);
  });

  it('normalises a volume whose corners were given the wrong way round', async () => {
    const r = rig();
    await correct(r, {
      kind: 'region.mark', provenance: 'inferred',
      volume: { min: [2, 2.4, 2], max: [1, 0, 1] }, reason: 'behind the sofa',
    });
    const region = r.deps.db.rows('wv_region')[0]!;
    expect(region['volume']).toEqual({ min: [1, 0, 1], max: [2, 2.4, 2] });
  });

  it('records a redaction for the next build to apply, and does not claim it is done', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'redaction.add', cameraId: r.camera, redactionKind: 'face', bbox: [100, 120, 48, 64],
    });
    expect(out.applied).toBe(1);

    const redaction = r.deps.db.rows('wv_redaction')[0]!;
    expect(redaction['camera_id']).toBe(r.camera);
    expect(redaction['kind']).toBe('face');
    expect(redaction['detector']).toBe('operator');
    // Applying a redaction means re-rendering frame pixels on a GPU. An
    // endpoint that flipped this to true would be claiming a face had been
    // blurred while the pixels still show it.
    expect(redaction['applied']).toBe(false);
    expect(redaction['reviewed_by']).toBe('user-1');
  });

  it('refuses a redaction against a camera in another world', async () => {
    const r = rig();
    const out = await correct(r, {
      kind: 'redaction.add', cameraId: r.deps.db.nextId(), redactionKind: 'face', bbox: [1, 1, 10, 10],
    });
    expect(out.applied).toBe(0);
    expect(r.deps.db.rows('wv_redaction')).toHaveLength(0);
  });

  it('accepts a sign-off without re-rendering a world that did not change', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'world.approve', note: 'walked it with the vendor' });
    expect(out.applied).toBe(1);
    // Accepted, but it changed no fact about the building, so the cached
    // document is still a true rendering of the rows.
    expect(out.changed).toBe(0);
    expect(documentIsStale(r)).toBe(false);
  });

  it('marks an operator coverage note as the operator\'s, so it can be withdrawn later', async () => {
    // wv_region.source defaults to 'pipeline' -- a survey fact. A note this
    // endpoint writes is the other kind, and saying so at the moment it is
    // written is the only thing that makes `region.clear` decidable later.
    const r = rig();
    await correct(r, {
      kind: 'region.mark', provenance: 'inferred',
      volume: { min: [0, 0, 0], max: [1, 1, 1] }, reason: 'wardrobe in the way',
    });
    expect(r.deps.db.rows('wv_region')[0]!['source']).toBe('operator');
  });
});

// ---------------------------------------------------------------------------
// Deleting
//
// The most destructive thing an operator can do through this endpoint, and the
// only correction with no previous value to fall back on. Each one has to
// prove the row is in this world, take exactly what the schema says goes with
// it, and report what happened in a sentence a person can read.
// ---------------------------------------------------------------------------

describe('deleting a room', () => {
  it('takes its surfaces and its doorways, and leaves the sofa standing', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'room.delete', roomId: r.livingRoom });
    expect(out.applied).toBe(1);
    expect(out.changed).toBe(1);

    // Gone: the room, its four panels, and both openings that named it -- the
    // one that had it as room_a and the one that had it as room_b.
    expect(r.deps.db.rows('wv_room').map((x) => x['id'])).toEqual([r.kitchen]);
    expect(r.deps.db.rows('wv_surface').map((x) => x['id'])).toEqual([r.kitchenWall]);
    expect(r.deps.db.rows('wv_opening').map((x) => x['id'])).toEqual([r.kitchenWindow]);

    // Survived, detached. An operator deleting a phantom room a mirror
    // invented must not also lose the real sofa the reconstruction put in it.
    const sofa = rowById(r, 'wv_entity', r.sofa);
    expect(sofa['room_id']).toBeNull();
    expect(sofa['label']).toBe('Sofa');
    expect(rowById(r, 'wv_nav_node', r.hallNode)['room_id']).toBeNull();
    expect(rowById(r, 'wv_camera', r.camera)['room_id']).toBeNull();

    // And the neighbour is untouched, down to its own wall and window.
    expect(rowById(r, 'wv_room', r.kitchen)['name']).toBe('Kitchen');
    expect(rowById(r, 'wv_nav_node', r.gardenNode)['room_id']).toBe(r.kitchen);

    // The cached document described a world with that room in it, so it must
    // not be served again.
    expect(documentIsStale(r)).toBe(true);
  });

  it('reports the cascade to the operator who caused it', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'room.delete', roomId: r.livingRoom });

    // A consequence nobody was told about is a consequence discovered later,
    // in the viewer. Four surfaces and two doorways went; one entity, one nav
    // node and one camera did not.
    const said = out.cascades.join(' ');
    expect(said).toContain('Living room');
    expect(said).toContain('4 surfaces');
    expect(said).toContain('2 openings');
    expect(said).toContain('1 entity');
    expect(said).toContain('1 nav node');
    expect(said).toContain('1 camera');
    expect(said).toContain('no coverage notes');
    // No foreign key could carry the scene graph, because wv_relationship is
    // polymorphic, so the delete function removes those edges itself. Left
    // behind they would outlive the room in the rendered document that wv-ask
    // answers from.
    expect(said).toMatch(/1 scene-graph relationship referring to it went too/);
    expect(r.deps.db.rows('wv_relationship')).toHaveLength(0);

    const log = r.deps.logs.find((l) => l.event === 'wv_worlds_room_deleted');
    expect(log?.data['surfaces']).toBe(4);
    expect(log?.data['openings']).toBe(2);
    expect(log?.data['relationshipsRemoved']).toBe(1);
  });

  it('changes nothing when the room belongs to another world', async () => {
    const mine = rig();
    const theirs = seedTenant(mine.deps.db, { userId: 'user-2', role: 'owner' });
    const theirRoom = mine.deps.db.nextId();
    mine.deps.db.seed('wv_room', [{
      id: theirRoom, world_id: theirs.worldId, stable_key: 'r-living', name: 'Their living room',
      kind: 'living', polygon: [], floor_z: 0, ceiling_z: 2.4, area_m2: 9,
      provenance: 'reconstructed', confidence: 0.8,
    }]);
    mine.deps.db.seed('wv_surface', [{
      id: mine.deps.db.nextId(), world_id: theirs.worldId, room_id: theirRoom, kind: 'wall',
      plane: {}, polygon: [], area_m2: 5, provenance: 'reconstructed', confidence: 0.8,
    }]);

    // Acting on MY world, naming THEIR room. The row is proved to be in this
    // world before anything is deleted, and the function filters world_id
    // again on the way through -- two locks, because the consequence of one
    // failing is another tenant's room disappearing.
    const out = await correct(mine, { kind: 'room.delete', roomId: theirRoom });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/is not in this world/);

    expect(mine.deps.db.rows('wv_room').some((x) => x['id'] === theirRoom)).toBe(true);
    expect(mine.deps.db.rows('wv_surface')).toHaveLength(6);
    // Nothing changed, so nothing was invalidated.
    expect(documentIsStale(mine)).toBe(false);
  });

  it('does not re-render the world when the row had already gone', async () => {
    const r = rig();
    // The delete found nothing: somebody else removed the room between the
    // read and the write. The end state is the one that was asked for, so it
    // is not a refusal -- but THIS request changed nothing, and claiming
    // otherwise would invalidate a document that is already being re-rendered
    // by whoever did the deleting.
    r.deps.db.rpcs.set('wv_delete_world_row', () => 0);

    const out = await correct(r, { kind: 'room.delete', roomId: r.livingRoom });
    expect(out.applied).toBe(1);
    expect(out.changed).toBe(0);
    expect(documentIsStale(r)).toBe(false);
    expect(r.deps.logs.some((l) => l.event === 'wv_worlds_delete_lost_race')).toBe(true);
  });
});

describe('deleting an entity', () => {
  it('removes the row and leaves the room it stood in alone', async () => {
    const r = rig();
    const out = await correct(r, { kind: 'entity.delete', entityId: r.sofa });
    expect(out.applied).toBe(1);
    expect(out.changed).toBe(1);

    expect(r.deps.db.rows('wv_entity')).toHaveLength(0);
    // Nothing has a foreign key to wv_entity, so a deleted entity takes
    // nothing with it -- which is the whole difference between this and a room.
    expect(rowById(r, 'wv_room', r.livingRoom)['name']).toBe('Living room');
    expect(r.deps.db.rows('wv_surface')).toHaveLength(5);
    expect(out.cascades[0]).toContain('Sofa');
    expect(out.cascades[0]).toMatch(/1 scene-graph relationship naming it went too/);
    expect(r.deps.db.rows('wv_relationship')).toHaveLength(0);
    expect(documentIsStale(r)).toBe(true);
  });

  it('changes nothing when the entity belongs to another world', async () => {
    const mine = rig();
    const theirs = seedTenant(mine.deps.db, { userId: 'user-2', role: 'owner' });
    const theirSofa = mine.deps.db.nextId();
    mine.deps.db.seed('wv_entity', [{
      id: theirSofa, world_id: theirs.worldId, stable_key: 'e-sofa', label: 'Their sofa',
      category: 'furniture', room_id: null, centroid: [0, 0, 0],
      aabb: { min: [0, 0, 0], max: [1, 1, 1] }, observed_in: [],
      provenance: 'reconstructed', confidence: 0.7, attributes: {},
    }]);

    const out = await correct(mine, { kind: 'entity.delete', entityId: theirSofa });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/is not in this world/);
    expect(rowById(mine, 'wv_entity', theirSofa)['label']).toBe('Their sofa');
  });
});

describe('withdrawing a coverage note', () => {
  /** A survey gap the pipeline recorded: the default `source` for a region. */
  function pipelineRegion(r: Rig): string {
    const id = r.deps.db.nextId();
    r.deps.db.seed('wv_region', [{
      id, world_id: r.worldId, provenance: 'generated',
      volume: { min: [0, 0, 0], max: [1, 2.4, 1] }, room_id: r.livingRoom,
      reason: 'no camera looked behind the wardrobe', confidence: 0.1, source: 'pipeline',
    }]);
    return id;
  }

  it('refuses to clear a region the pipeline recorded, and says what to do instead', async () => {
    const r = rig();
    const id = pipelineRegion(r);

    const out = await correct(r, { kind: 'region.clear', regionId: id });
    expect(out.applied).toBe(0);
    // That row is the record that nobody looked there. Deleting it does not
    // make a camera have looked; it only makes the world stop admitting what
    // it does not know.
    expect(out.rejected[0]).toMatch(/recorded by the pipeline/);
    expect(out.rejected[0]).toMatch(/rescan/);
    expect(r.deps.db.rows('wv_region')).toHaveLength(1);
    expect(documentIsStale(r)).toBe(false);
  });

  it('clears a note the operator added', async () => {
    const r = rig();
    const survey = pipelineRegion(r);
    await correct(r, {
      kind: 'region.mark', provenance: 'inferred',
      volume: { min: [3, 0, 0], max: [4, 2.4, 1] }, reason: 'could not open the cupboard',
    });
    const mine = r.deps.db.rows('wv_region').find((x) => x['source'] === 'operator')!;

    const out = await correct(r, { kind: 'region.clear', regionId: String(mine['id']) });
    expect(out.applied).toBe(1);
    expect(out.changed).toBe(1);
    expect(out.cascades[0]).toMatch(/Withdrew/);

    // Theirs went; the pipeline's stayed.
    expect(r.deps.db.rows('wv_region').map((x) => x['id'])).toEqual([survey]);
    expect(documentIsStale(r)).toBe(true);
  });

  it('treats a region with no readable source as the pipeline\'s', async () => {
    // Fail closed. A region whose origin cannot be established must not be
    // deletable on the strength of nobody knowing where it came from.
    const r = rig();
    const id = r.deps.db.nextId();
    r.deps.db.seed('wv_region', [{
      id, world_id: r.worldId, provenance: 'generated',
      volume: { min: [0, 0, 0], max: [1, 1, 1] }, room_id: null, reason: 'unknown', confidence: 0.1,
    }]);

    const out = await correct(r, { kind: 'region.clear', regionId: id });
    expect(out.applied).toBe(0);
    expect(r.deps.db.rows('wv_region')).toHaveLength(1);
  });

  it('changes nothing when the region belongs to another world', async () => {
    const mine = rig();
    const theirs = seedTenant(mine.deps.db, { userId: 'user-2', role: 'owner' });
    const theirRegion = mine.deps.db.nextId();
    mine.deps.db.seed('wv_region', [{
      id: theirRegion, world_id: theirs.worldId, provenance: 'generated',
      volume: { min: [0, 0, 0], max: [1, 1, 1] }, room_id: null,
      reason: 'their gap', confidence: 0.1, source: 'operator',
    }]);

    const out = await correct(mine, { kind: 'region.clear', regionId: theirRegion });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/is not in this world/);
    expect(mine.deps.db.rows('wv_region')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The receipt — provenance.ts rule 4
//
// `correction:<record id>` and `operator:<who>`, on the row that changed.
// That pair is how `isHumanCorrected` answers "did a person touch this fact",
// and it is the difference between a corrected room name and a
// pipeline-written one, which otherwise look identical to everything
// downstream.
// ---------------------------------------------------------------------------

describe('the correction receipt', () => {
  it('lands on all four correctable tables', async () => {
    const r = rig();
    const res = await handleWorlds(post({
      action: 'approve_corrections', worldId: r.worldId,
      corrections: [
        { kind: 'room.rename', roomId: r.livingRoom, name: 'Sitting room' },
        { kind: 'entity.label', entityId: r.sofa, label: 'Chesterfield' },
        { kind: 'surface.flags', surfaceId: r.wall, isReflective: true },
        { kind: 'opening.kind', openingId: r.doorway, openingKind: 'door' },
      ],
    }, AUTH), r.deps);
    expect((res.body as { applied: number }).applied).toBe(4);

    for (const [table, id] of [
      ['wv_room', r.livingRoom], ['wv_entity', r.sofa],
      ['wv_surface', r.wall], ['wv_opening', r.doorway],
    ] as const) {
      const tokens = receipts(r, table, id);
      expect(tokens.filter((t) => t.startsWith('correction:')), table).toHaveLength(1);
      expect(tokens, table).toContain('operator:user-1');
    }
  });

  it('appends to what earlier hands left, and never replaces it', async () => {
    const r = rig();
    // Somebody else corrected this room last month. The column is the audit
    // trail of every hand that has been on the row; a correction that started
    // from an empty array would erase the record it exists to keep.
    await r.deps.db.update('wv_room', {
      correction_sources: ['correction:earlier', 'operator:user-9'],
    }, { id: r.livingRoom });

    await correct(r, { kind: 'room.rename', roomId: r.livingRoom, name: 'Sitting room' });

    const tokens = receipts(r, 'wv_room', r.livingRoom);
    expect(tokens.slice(0, 2)).toEqual(['correction:earlier', 'operator:user-9']);
    expect(tokens).toHaveLength(4);
    expect(tokens).toContain('operator:user-1');
  });

  it('does not duplicate a record that is submitted twice', async () => {
    const r = rig();
    const recordId = r.deps.db.nextId();
    // The editor resends a record it is not sure landed. The row must not come
    // out looking twice-corrected: a receipt is a set, not a counter.
    for (const name of ['Sitting room', 'Front room']) {
      await handleWorlds(post({
        action: 'approve_corrections', worldId: r.worldId,
        corrections: [{ id: recordId, change: { kind: 'room.rename', roomId: r.livingRoom, name } }],
      }, AUTH), r.deps);
    }
    expect(receipts(r, 'wv_room', r.livingRoom))
      .toEqual([`correction:${recordId}`, 'operator:user-1']);
  });

  it('records one operator once, however many facts they correct', async () => {
    const r = rig();
    await handleWorlds(post({
      action: 'approve_corrections', worldId: r.worldId,
      corrections: [
        { kind: 'room.rename', roomId: r.livingRoom, name: 'Sitting room' },
        { kind: 'room.kind', roomId: r.livingRoom, roomKind: 'dining' },
      ],
    }, AUTH), r.deps);

    const tokens = receipts(r, 'wv_room', r.livingRoom);
    // Two decisions, two correction ids -- but one person, named once.
    expect(tokens.filter((t) => t.startsWith('correction:'))).toHaveLength(2);
    expect(tokens.filter((t) => t === 'operator:user-1')).toHaveLength(1);
  });

  it('never pollutes the camera list', async () => {
    const r = rig();
    await correct(r, { kind: 'entity.move', entityId: r.sofa, centroid: [2, 0.4, 2] });

    const sofa = rowById(r, 'wv_entity', r.sofa);
    // `observed_in` is uuid[] and genuinely is the frames that saw the sofa. A
    // 'correction:...' token in there would not even be a uuid.
    expect(sofa['observed_in']).toEqual([r.camera]);
    // And on the other side: `cameraSourcesOf` reads `sources` as a camera
    // list after filtering exactly these two prefixes out, so anything that
    // survived that filter would be read downstream as a frame id.
    const strays = receipts(r, 'wv_entity', r.sofa)
      .filter((t) => !t.startsWith('correction:') && !t.startsWith('operator:'));
    expect(strays).toEqual([]);
  });

  it('puts a dimension receipt on the row as well as in the measurement basis', async () => {
    const r = rig();
    await correct(r, {
      kind: 'dimension.set',
      target: { kind: 'opening.width', openingId: r.doorway },
      value: 0.835, method: 'site-measure', instrument: 'laser',
    });

    const basis = r.deps.db.rows('wv_measurement')[0]!['basis'] as Record<string, unknown>;
    const tokens = receipts(r, 'wv_opening', r.doorway);
    // The basis is what a certificate is reissued from; the column is what
    // makes the row itself read as human-corrected in the world document.
    // They must name the same correction record, or one of them is lying.
    expect(tokens).toContain(`correction:${String(basis['correctionId'])}`);
    expect(tokens).toContain('operator:user-1');
  });

  it('leaves no receipt on a correction that wrote no row', async () => {
    const r = rig();
    await correct(r, { kind: 'world.approve', note: 'walked it with the vendor' });
    expect(receipts(r, 'wv_room', r.livingRoom)).toEqual([]);
    expect(receipts(r, 'wv_entity', r.sofa)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe('a correction cannot reach out of its world', () => {
  it('changes nothing when it names a row from another world', async () => {
    const mine = rig();
    // A second org's world, in the same database, with a room of its own.
    const theirs = seedTenant(mine.deps.db, { userId: 'user-2', role: 'owner' });
    const theirRoom = mine.deps.db.nextId();
    mine.deps.db.seed('wv_room', [{
      id: theirRoom, world_id: theirs.worldId, stable_key: 'r-living', name: 'Their living room',
      kind: 'living', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]], floor_z: 0, ceiling_z: 2.4,
      area_m2: 9, area_standard: 'RICS-COMP-GIA', area_tol_pct: 3, wall_tol_mm: 25,
      provenance: 'reconstructed', confidence: 0.8,
    }]);

    // Acting on MY world, naming THEIR room. Every read and write is scoped by
    // world_id as well as by id, so the row simply does not match.
    const out = await correct(mine, { kind: 'room.rename', roomId: theirRoom, name: 'Pwned' });
    expect(out.applied).toBe(0);
    expect(out.rejected[0]).toMatch(/is not in this world/);
    expect(rowById(mine, 'wv_room', theirRoom)['name']).toBe('Their living room');
    // Nothing was invalidated either: no row changed.
    expect(documentIsStale(mine)).toBe(false);
  });

  it('answers 404 and not 403 for a world in another org', async () => {
    const r = rig();
    // A different org entirely, seeded into the same database.
    const other = seedTenant(r.deps.db, { userId: 'user-2', role: 'owner' });

    for (const body of [
      { action: 'get_world', worldId: other.worldId },
      { action: 'publish', worldId: other.worldId },
      { action: 'request_build', worldId: other.worldId },
      {
        action: 'approve_corrections', worldId: other.worldId,
        corrections: [{ kind: 'room.rename', roomId: r.livingRoom, name: 'Pwned' }],
      },
      { action: 'register_capture', worldId: other.worldId, kind: 'video', storagePath: `${other.worldId}/x.mp4` },
    ]) {
      const res = await handleWorlds(post(body, AUTH), r.deps);
      // 403 would confirm the world exists to anyone willing to guess a uuid,
      // and that difference is an enumeration oracle over every customer's
      // portfolio. The role gate must never fire before this one.
      expect(res.status, String(body['action'])).toBe(404);
    }
    expect(r.deps.logs.some((l) => l.event === 'wv_worlds_cross_tenant_denied')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

describe('register_capture', () => {
  it('records a walkthrough the capture app has uploaded', async () => {
    const r = rig();
    const res = await handleWorlds(post({
      action: 'register_capture', worldId: r.worldId, kind: 'video',
      storagePath: `${r.worldId}/captures/walkthrough.mp4`,
      bytes: 1_800_000_000, duration_s: 284.5, frame_count: 8535,
      device: { model: 'iPhone 15 Pro', lidar: true },
      captured_at: '2026-09-19T09:30:00.000Z',
    }, AUTH), r.deps);
    expect(res.status).toBe(201);

    const capture = r.deps.db.rows('wv_capture')[0]!;
    expect(capture['world_id']).toBe(r.worldId);
    expect(capture['kind']).toBe('video');
    expect(capture['frame_count']).toBe(8535);
    expect(capture['captured_at']).toBe('2026-09-19T09:30:00.000Z');
    expect((res.body as { capture: { id: string } }).capture.id).toBe(capture['id']);
  });

  it('refuses a path that points into another world prefix', async () => {
    const r = rig();
    const other = seedTenant(r.deps.db, { userId: 'user-1', role: 'operator' });

    for (const storagePath of [
      `${other.worldId}/walkthrough.mp4`,     // another world, same database
      '../secrets/walkthrough.mp4',
      `/${r.worldId}/walkthrough.mp4`,
      `${r.worldId}`,                          // a folder, not an object
      `${r.worldId}\\walkthrough.mp4`,
    ]) {
      const res = await handleWorlds(post({
        action: 'register_capture', worldId: r.worldId, kind: 'video', storagePath,
      }, AUTH), r.deps);
      // The bucket policy keys on the first path segment being the world id.
      // That governs the UPLOAD; this governs the ROW, and without it a
      // capture row is a durable pointer from one tenant's database into
      // another tenant's video.
      expect(res.status, storagePath).toBe(400);
    }
    expect(r.deps.db.rows('wv_capture')).toHaveLength(0);
  });

  it('refuses a kind that is not one of the four', async () => {
    const r = rig();
    const res = await handleWorlds(post({
      action: 'register_capture', worldId: r.worldId, kind: 'hologram',
      storagePath: `${r.worldId}/x.bin`,
    }, AUTH), r.deps);
    expect(res.status).toBe(400);
    expect(r.deps.db.rows('wv_capture')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A phone on a doorstep, retrying
// ---------------------------------------------------------------------------

/**
 * The unique index `wv_capture_object (world_id, storage_path)`, which FakeDb
 * does not model -- its own header says it models PostgREST's shape and not
 * Postgres's constraints.
 *
 * The thrown message is the shape `makeDb` in _wv_shared/serve.ts produces:
 * the handler has no structured error to interrogate, only
 * `Error('postgrest 409: <the JSON body>')`, and 23505 inside it is the only
 * thing it can safely key on. If that assumption is wrong, this test is the
 * place it shows.
 */
function installCaptureUniqueIndex(deps: TestDeps, opts: { always?: boolean } = {}): void {
  const underlying = deps.db.insert.bind(deps.db);
  const wrapped: typeof deps.db.insert = async (table, values) => {
    const list = Array.isArray(values) ? values : [values];
    if (table === 'wv_capture') {
      for (const v of list) {
        const clash = opts.always || deps.db.rows('wv_capture').some(
          (row) => row['world_id'] === v['world_id'] && row['storage_path'] === v['storage_path'],
        );
        if (clash) {
          throw new Error('postgrest 409: {"code":"23505","details":"Key (world_id, '
            + 'storage_path) already exists.","message":"duplicate key value violates unique '
            + 'constraint \\"wv_capture_object\\""}');
        }
      }
    }
    return underlying(table, values);
  };
  (deps.db as { insert: typeof deps.db.insert }).insert = wrapped;
}

describe('a retried register_capture', () => {
  const body = (worldId: string) => ({
    action: 'register_capture', worldId, kind: 'video',
    storagePath: `${worldId}/captures/walkthrough.mp4`,
    bytes: 1_800_000_000, duration_s: 284.5,
  });

  it('returns the first capture rather than reporting a failure', async () => {
    const r = rig();
    installCaptureUniqueIndex(r.deps);

    const first = await handleWorlds(post(body(r.worldId), AUTH), r.deps);
    expect(first.status).toBe(201);
    const id = (first.body as { capture: { id: string } }).capture.id;

    // The phone never saw the 201 and sent it again. The upload DID succeed
    // and the row DOES exist, so a 500 here would be the server reporting
    // failure for work that is complete -- and a capture app that believes the
    // registration failed either retries forever or sends the operator back to
    // walk the property again.
    const retry = await handleWorlds(post(body(r.worldId), AUTH), r.deps);
    expect(retry.status).toBe(200);
    const again = retry.body as { capture: { id: string }; duplicate?: boolean };
    expect(again.capture.id).toBe(id);
    expect(again.duplicate).toBe(true);

    // One object, one row. Two would let the pipeline be handed the same
    // walkthrough twice and show the operator a capture they did not make.
    expect(r.deps.db.rows('wv_capture')).toHaveLength(1);
    expect(r.deps.logs.some((l) => l.event === 'wv_worlds_capture_already_registered')).toBe(true);
  });

  it('lets a genuine failure surface instead of inventing a success', async () => {
    const r = rig();
    const underlying = r.deps.db.insert.bind(r.deps.db);
    (r.deps.db as { insert: typeof r.deps.db.insert }).insert = async (table, values) => {
      if (table === 'wv_capture') throw new Error('postgrest 500: {"message":"boom"}');
      return underlying(table, values);
    };

    // Not a unique violation, so nothing here is entitled to conclude the work
    // was already done. It fails loudly.
    await expect(handleWorlds(post(body(r.worldId), AUTH), r.deps)).rejects.toThrow(/postgrest 500/);
    expect(r.deps.db.rows('wv_capture')).toHaveLength(0);
  });

  it('rethrows a unique violation it cannot explain', async () => {
    const r = rig();
    // The index fired, but no row of this world with this path can be found --
    // so the collision was with something this code does not understand, and
    // answering 200 with somebody else's id would be worse than failing.
    installCaptureUniqueIndex(r.deps, { always: true });

    await expect(handleWorlds(post(body(r.worldId), AUTH), r.deps)).rejects.toThrow(/23505/);
    expect(r.deps.db.rows('wv_capture')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Membership — acting on your own row
//
// The rule that used to be here was "nobody touches their own membership",
// and it was the wrong one. It meant the only way to stop being an owner was
// to ask somebody else to do it for you, which is how people keep roles they
// meant to give up. What actually keeps an account recoverable is the
// last-owner rule, and it binds the person themselves exactly as hard as it
// binds an admin acting on them.
//
// `canAssignRole` and `canRemoveMember` in console-ui/src/logic/roles.ts
// compute the same answers, so the console never offers a control this file
// will refuse.
// ---------------------------------------------------------------------------

interface OrgRig {
  readonly deps: TestDeps;
  readonly orgId: string;
  readonly me: string;
  readonly others: readonly string[];
}

/**
 * One org, the caller, and whoever else is in it.
 *
 * The caller's id is a real uuid because it travels back through the request
 * body as `userId`, and `uuid()` refuses anything else -- a self-directed
 * change with a readable id would 400 before any rule was reached.
 */
let userSeq = 0;

/** A v4-shaped uuid that does not collide with FakeDb's own sequence. */
function userUuid(): string {
  userSeq += 1;
  return `00000000-0000-4000-9000-${userSeq.toString(16).padStart(12, '0')}`;
}

function orgRig(
  callerRole: 'owner' | 'admin' | 'operator' | 'viewer',
  otherRoles: readonly ('owner' | 'admin' | 'operator' | 'viewer')[] = [],
): OrgRig {
  const me = userUuid();
  const deps = makeTestDeps({ users: { [TOKEN]: me } });
  const db = deps.db;

  const tenant = seedTenant(db, { userId: me, role: callerRole });
  const others = otherRoles.map((role) => {
    const id = userUuid();
    db.seed('wv_member', [{
      org_id: tenant.orgId, user_id: id, role,
      email: `${role}@example.com`, created_at: '2026-02-01T00:00:00.000Z',
    }]);
    return id;
  });
  return { deps, orgId: tenant.orgId, me, others };
}

function memberRow(rig: OrgRig, userId: string): Row | undefined {
  return rig.deps.db.rows('wv_member').find((m) => m['user_id'] === userId);
}

describe('changing your own role', () => {
  it('lets an owner step down while another owner remains', async () => {
    const o = orgRig('owner', ['owner']);
    const res = await handleWorlds(post({
      action: 'set_member_role', orgId: o.orgId, userId: o.me, role: 'admin',
    }, AUTH), o.deps);

    expect(res.status).toBe(200);
    expect(memberRow(o, o.me)?.['role']).toBe('admin');
    expect(o.deps.logs.find((l) => l.event === 'wv_worlds_member_role_changed')?.data['self'])
      .toBe(true);
  });

  it('refuses the last owner stepping down, and says what to do first', async () => {
    const o = orgRig('owner', ['admin']);
    const res = await handleWorlds(post({
      action: 'set_member_role', orgId: o.orgId, userId: o.me, role: 'admin',
    }, AUTH), o.deps);

    // Not because it is self-directed, but because an org with no owner has
    // nobody who can fix it.
    expect(res.status).toBe(409);
    expect(String((res.body as { error: string }).error))
      .toMatch(/last owner.*before you step down/);
    expect(memberRow(o, o.me)?.['role']).toBe('owner');
  });

  it('refuses anyone raising their own role', async () => {
    const o = orgRig('admin', ['owner']);
    const res = await handleWorlds(post({
      action: 'set_member_role', orgId: o.orgId, userId: o.me, role: 'owner',
    }, AUTH), o.deps);

    // An admin who can make themselves an owner is not an admin.
    expect(res.status).toBe(403);
    expect(String((res.body as { error: string }).error)).toMatch(/higher role/);
    expect(memberRow(o, o.me)?.['role']).toBe('admin');
  });

  it('still refuses an operator every role change, including their own', async () => {
    const o = orgRig('operator', ['owner']);
    const res = await handleWorlds(post({
      action: 'set_member_role', orgId: o.orgId, userId: o.me, role: 'viewer',
    }, AUTH), o.deps);

    // The capability gate applies whoever the target is. Membership is a write
    // to wv_member either way.
    expect(res.status).toBe(403);
    expect(String((res.body as { error: string }).error)).toMatch(/cannot change other people/);
    expect(memberRow(o, o.me)?.['role']).toBe('operator');
  });

  it('still refuses an admin promoting somebody else to owner', async () => {
    const o = orgRig('admin', ['owner', 'operator']);
    const res = await handleWorlds(post({
      action: 'set_member_role', orgId: o.orgId, userId: o.others[1], role: 'owner',
    }, AUTH), o.deps);
    expect(res.status).toBe(403);
    expect(String((res.body as { error: string }).error)).toMatch(/Only an owner/);
  });
});

describe('leaving an organisation', () => {
  it('lets a member remove themselves', async () => {
    const o = orgRig('admin', ['owner']);
    const res = await handleWorlds(post({
      action: 'remove_member', orgId: o.orgId, userId: o.me,
    }, AUTH), o.deps);

    expect(res.status).toBe(200);
    expect(memberRow(o, o.me)).toBeUndefined();
    expect(o.deps.logs.find((l) => l.event === 'wv_worlds_member_removed')?.data['self']).toBe(true);
  });

  it('refuses the last owner leaving', async () => {
    const o = orgRig('owner', ['admin']);
    const res = await handleWorlds(post({
      action: 'remove_member', orgId: o.orgId, userId: o.me,
    }, AUTH), o.deps);

    expect(res.status).toBe(409);
    expect(String((res.body as { error: string }).error)).toMatch(/last owner.*before you leave/);
    expect(memberRow(o, o.me)?.['role']).toBe('owner');
  });

  it('refuses a viewer who wants out, because membership is still a write', async () => {
    const o = orgRig('viewer', ['owner']);
    const res = await handleWorlds(post({
      action: 'remove_member', orgId: o.orgId, userId: o.me,
    }, AUTH), o.deps);

    // Deliberate, and it matches `canRemoveMember`: a viewer who wants out
    // asks an admin.
    expect(res.status).toBe(403);
    expect(memberRow(o, o.me)?.['role']).toBe('viewer');
  });

  it('still refuses an admin removing an owner', async () => {
    const o = orgRig('admin', ['owner', 'owner']);
    const res = await handleWorlds(post({
      action: 'remove_member', orgId: o.orgId, userId: o.others[0],
    }, AUTH), o.deps);

    expect(res.status).toBe(403);
    expect(String((res.body as { error: string }).error)).toMatch(/Only an owner can remove an owner/);
    expect(memberRow(o, o.others[0]!)).toBeDefined();
  });
});
