/**
 * THE PUBLIC SURFACE.
 *
 * wv-view is the only function anonymous traffic reaches, and it now writes as
 * well as reads. Both halves of that are tested here against the real handler,
 * because the properties below are not the sort that survive being checked by
 * reading the code.
 *
 * What these tests are actually about:
 *
 *   READ   A published world is servable and everything else is indivisible
 *          from a world that never existed. Not "returns 404 too" -- the same
 *          bytes, so a slug cannot be probed for existence. And the document a
 *          share link opens has to be safe to hand to a stranger: signed URLs
 *          in place of storage paths, no capture provenance, and no asset that
 *          was addressed to somebody else's property.
 *
 *   WRITE  An event is a claim by an anonymous browser about a world it does
 *          not get to name. The session row names the world; the body's world
 *          id is not read at all; the room must belong to that world; the
 *          clock is clamped into a window the server vouches for; and the
 *          number of rows one session can ever write is capped, because
 *          wv_event is the table every analytics screen in the console sums.
 *
 * The clock matters in several of these, so they move it deliberately with
 * `advance` rather than hoping the fake's default lines up.
 */

import { describe, expect, it } from 'vitest';

import { findForbiddenKey, handleView } from '../../wv-view/handler.ts';
import type { HttpRequest } from '../http.ts';
import { FakeDb, advance, makeTestDeps, seedTenant, type TestDeps } from './fakes.ts';

const NOW = '2026-09-20T12:00:00.000Z';

/** A correction record id, as approve_corrections stamps onto a row. */
const CORRECTION_ID = 'c7f1e2a0-0000-4000-8000-000000000abc';

function post(path: string, body: Record<string, unknown>): HttpRequest {
  return { method: 'POST', path, query: {}, headers: {}, body };
}

function get(path: string, query: Record<string, string>): HttpRequest {
  return { method: 'GET', path, query, headers: {} };
}

/**
 * One published world with enough rows behind it to render a document, plus a
 * second tenant whose world is a draft -- which is the only honest way to test
 * that the two are indistinguishable from outside.
 */
function rig() {
  const deps = makeTestDeps({ now: NOW });
  const db: FakeDb = deps.db;

  const alpha = seedTenant(db, { status: 'published', slug: 'alpha-court-flat-2', label: 'Flat 2, Alpha Court' });
  const beta = seedTenant(db, { status: 'draft', slug: 'beta-house', label: 'Beta House' });

  // A second world for the SAME tenant, still a draft. A published world and
  // an unpublished one under one property is the normal state of a property
  // being re-captured, and the draft must be as invisible as a stranger's.
  const alphaDraftId = db.nextId('world');
  db.seed('wv_world', [{
    id: alphaDraftId, property_id: alpha.propertyId, version: 2,
    status: 'draft', published_at: null, slug: 'alpha-court-flat-2-v2',
    quality_score: null, supersedes_id: alpha.worldId, scale_source: 'aruco',
    scale_agreement: 0.9, scale_provenance: 'observed', scale_confidence: 0.9,
    created_at: '2026-09-15T00:00:00.000Z',
  }]);

  const roomId = db.nextId('room');
  const betaRoomId = db.nextId('room');
  const captureId = db.nextId('capture');
  const cameraId = db.nextId('camera');

  db.seed('wv_room', [
    {
      id: roomId, world_id: alpha.worldId, floor_id: null, stable_key: 'kitchen',
      name: 'Kitchen', kind: 'kitchen', polygon: [[0, 0], [3, 0], [3, 4], [0, 4]],
      floor_z: 0, ceiling_z: 2.4, area_m2: 12, area_standard: 'RICS-IPMS2',
      area_tol_pct: 3, wall_tol_mm: 25, provenance: 'reconstructed', confidence: 0.82,
    },
    {
      id: betaRoomId, world_id: beta.worldId, floor_id: null, stable_key: 'lounge',
      name: 'Lounge', kind: 'living', polygon: [[0, 0], [4, 0], [4, 5], [0, 5]],
      floor_z: 0, ceiling_z: 2.5, area_m2: 20, area_standard: 'RICS-IPMS2',
      area_tol_pct: 3, wall_tol_mm: 25, provenance: 'reconstructed', confidence: 0.8,
    },
  ]);

  db.seed('wv_camera', [{
    id: cameraId, world_id: alpha.worldId, capture_id: captureId, frame_index: 12,
    t_ms: 4000, px: 1.2, py: 1.6, pz: 0.4, qx: 0, qy: 0, qz: 0, qw: 1,
    intrinsics: { fx: 900, fy: 900, cx: 640, cy: 360 },
    pose_confidence: 0.77, sharpness: 0.6, room_id: roomId,
  }]);

  db.seed('wv_asset', [
    {
      id: db.nextId('asset'), world_id: alpha.worldId, role: 'splat', format: 'spz',
      storage_path: `${alpha.worldId}/splat.spz`, bytes: 4096, checksum: 'abc',
      lod: 0, chunk_key: null, splat_count: 120_000, meta: {},
    },
    // The raw walkthrough is somebody's home. It is a row in this world and it
    // is never a URL in anybody's browser.
    {
      id: db.nextId('asset'), world_id: alpha.worldId, role: 'source_video', format: 'mp4',
      storage_path: `${alpha.worldId}/raw-walkthrough.mp4`, bytes: 90_000_000, checksum: 'def',
      lod: null, chunk_key: null, splat_count: null, meta: {},
    },
    // A row filed under this world whose object lives under ANOTHER world's
    // prefix. The bucket policy is keyed on that prefix and this function
    // signs as the service role, so the policy would not stop the signature.
    {
      id: db.nextId('asset'), world_id: alpha.worldId, role: 'proxy_mesh', format: 'glb',
      storage_path: `${beta.worldId}/proxy.glb`, bytes: 2048, checksum: 'ghi',
      lod: 0, chunk_key: null, splat_count: null, meta: {},
    },
  ]);

  return { deps, db, alpha, beta, alphaDraftId, roomId, betaRoomId, captureId };
}

/** Start a tour the way a visitor does, and keep what wv-view minted. */
async function startTour(deps: TestDeps, slug: string): Promise<{ sessionId: string; viewerKey: string }> {
  const res = await handleView(post('/', { slug }), deps);
  expect(res.status).toBe(200);
  const session = (res.body as { session: { id: string; viewerKey: string } }).session;
  expect(session.id).toBeTruthy();
  return { sessionId: session.id, viewerKey: session.viewerKey };
}

function events(sessionId: string, viewerKey: string, list: Record<string, unknown>[]): HttpRequest {
  return post('/events', { sessionId, viewerKey, events: list });
}

// ---------------------------------------------------------------------------
// GET /world.json -- what a share link opens
// ---------------------------------------------------------------------------

describe('the world document a share link opens', () => {
  it('resolves a published world by slug and by id', async () => {
    const { deps, alpha } = rig();

    const bySlug = await handleView(get('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    const byId = await handleView(get('/world.json', { worldId: alpha.worldId }), deps);

    expect(bySlug.status).toBe(200);
    expect(byId.status).toBe(200);
    for (const res of [bySlug, byId]) {
      const doc = res.body as Record<string, unknown>;
      expect(doc['formatVersion']).toBe(1);
      expect(doc['id']).toBe(alpha.worldId);
      expect(doc['label']).toBe('Flat 2, Alpha Court');
      expect((doc['rooms'] as unknown[])).toHaveLength(1);
    }
  });

  it('names no operator to the public, and still says a person corrected it', async () => {
    // A correction leaves two receipts on the row: correction:<record id>,
    // which says a person changed this, and operator:<user id>, which says
    // which employee of the agency. The first is exactly what a buyer is
    // entitled to know -- it is the difference between a declared figure and a
    // measured one. The second is a staff identifier and is nobody's business
    // outside the agency, and it reaches this endpoint because ONE cached
    // document serves wv-ask, the agency's export and this anonymous route.
    const { deps, db, roomId, alpha } = rig();
    const operatorId = db.nextId('user');
    await db.update('wv_room', {
      name: 'Kitchen and diner',
      correction_sources: [`correction:${CORRECTION_ID}`, `operator:${operatorId}`],
    }, { id: roomId });

    const res = await handleView(get('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    expect(res.status).toBe(200);
    const doc = res.body as Record<string, unknown>;

    const raw = JSON.stringify(doc);
    expect(raw).not.toContain(operatorId);
    expect(raw).not.toContain('operator:');
    // The fact of the correction survives, or the endpoint would quietly
    // upgrade a human declaration into a reconstruction.
    expect(raw).toContain(`correction:${CORRECTION_ID}`);

    const room = (doc['rooms'] as Record<string, unknown>[])[0]!;
    const sources = (room['grounding'] as { sources?: string[] }).sources ?? [];
    expect(sources).toEqual([`correction:${CORRECTION_ID}`]);
    expect(findForbiddenKey(doc)).toBeNull();
    expect(deps.logs.some((l) => l.event === 'wv_view_document_operator_leak_blocked')).toBe(false);
    expect(alpha.worldId).toBeTruthy();
  });

  it('drops the sources key entirely when only the operator token was there', async () => {
    // Otherwise an empty array is left behind, which says "a person touched
    // this and we removed the evidence" to anyone reading the JSON.
    const { deps, db, roomId } = rig();
    const operatorId = db.nextId('user');
    await db.update('wv_room', { correction_sources: [`operator:${operatorId}`] }, { id: roomId });

    const res = await handleView(get('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    const room = ((res.body as Record<string, unknown>)['rooms'] as Record<string, unknown>[])[0]!;
    expect(Object.keys(room['grounding'] as object)).not.toContain('sources');
  });

  it('is the same 404 for a draft, another tenant and a world that never was', async () => {
    const { deps } = rig();

    const ownDraft = await handleView(get('/world.json', { slug: 'alpha-court-flat-2-v2' }), deps);
    const otherTenant = await handleView(get('/world.json', { slug: 'beta-house' }), deps);
    const missing = await handleView(get('/world.json', { slug: 'no-such-property' }), deps);

    expect([ownDraft.status, otherTenant.status, missing.status]).toEqual([404, 404, 404]);
    // Byte-identical, or the endpoint is an oracle for which slugs are taken.
    expect(JSON.stringify(ownDraft.body)).toBe(JSON.stringify(missing.body));
    expect(JSON.stringify(otherTenant.body)).toBe(JSON.stringify(missing.body));
  });

  it('signs its assets, strips capture ids and passes its own privacy check', async () => {
    const { deps, captureId } = rig();
    const res = await handleView(get('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    expect(res.status).toBe(200);
    const doc = res.body as Record<string, unknown>;

    const assets = doc['assets'] as { role: string; url: string }[];
    expect(assets.map((a) => a.role)).toEqual(['splat']);
    expect(assets[0]!.url).toMatch(/^https:\/\/storage\.test\/wv-assets\/.*token=signed/);

    const cameras = doc['cameras'] as Record<string, unknown>[];
    expect(cameras).toHaveLength(1);
    expect(cameras[0]!['captureId']).toBeUndefined();
    // Pose survives; provenance of the upload does not.
    expect(cameras[0]!['position']).toEqual([1.2, 1.6, 0.4]);

    const raw = JSON.stringify(doc);
    expect(raw).not.toContain(captureId);
    expect(raw).not.toContain('asset://');
    expect(findForbiddenKey(doc)).toBeNull();
  });

  it('will not sign an asset addressed to another world', async () => {
    const { deps, beta } = rig();
    const res = await handleView(get('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    const doc = res.body as Record<string, unknown>;

    // The proxy_mesh is a public role, so the ONLY thing that withheld it is
    // the prefix check.
    expect((doc['assets'] as { role: string }[]).some((a) => a.role === 'proxy_mesh')).toBe(false);
    expect(deps.storage.signed.map((s) => s.path)).not.toContain(`${beta.worldId}/proxy.glb`);
    expect(deps.logs.some((l) => l.event === 'wv_view_asset_out_of_world')).toBe(true);
  });

  it('reads the rendered document rather than reassembling it per visitor', async () => {
    const { deps, db } = rig();
    await handleView(get('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    const afterFirst = db.calls.filter((c) => c.op === 'select').length;

    await handleView(get('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    const secondVisitor = db.calls.filter((c) => c.op === 'select').length - afterFirst;

    // The world lookup and the cache-entry lookup. Not thirteen selects.
    expect(secondVisitor).toBeLessThanOrEqual(3);
  });

  it('is a read, so it refuses to be posted to', async () => {
    const { deps } = rig();
    const res = await handleView(post('/world.json', { slug: 'alpha-court-flat-2' }), deps);
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// POST /events -- the only thing that writes wv_event
// ---------------------------------------------------------------------------

describe('viewer events', () => {
  it('records a batch against the session that minted the key', async () => {
    const { deps, db, alpha, roomId } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');

    const res = await handleView(events(tour.sessionId, tour.viewerKey, [
      { kind: 'enter' },
      { kind: 'room', roomId, at: NOW },
      { kind: 'dwell', roomId, at: NOW, payload: { ms: 4200 } },
    ]), deps);

    expect(res.status).toBe(200);
    // Counts, never row contents: there is nothing here the caller did not send.
    expect(res.body).toEqual({ accepted: 3, roomsIgnored: 0, ended: false });

    const rows = db.rows('wv_event');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r['world_id'] === alpha.worldId)).toBe(true);
    expect(rows.every((r) => r['session_id'] === tour.sessionId)).toBe(true);
    expect(rows[2]!['payload']).toEqual({ ms: 4200 });
  });

  it('refuses a session id that is not paired with its viewer key', async () => {
    const { deps, db } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');

    const wrongKey = await handleView(
      events(tour.sessionId, 'random-not-the-key', [{ kind: 'enter' }]), deps);
    const noSuchSession = await handleView(
      events(db.nextId('session'), tour.viewerKey, [{ kind: 'enter' }]), deps);

    expect(wrongKey.status).toBe(404);
    expect(noSuchSession.status).toBe(404);
    // A session id alone is not a credential, and the pair must not be an
    // oracle for which ids are real.
    expect(JSON.stringify(wrongKey.body)).toBe(JSON.stringify(noSuchSession.body));
    expect(db.rows('wv_event')).toHaveLength(0);
  });

  it('ignores the world id in the body and drops a room from another world', async () => {
    const { deps, db, alpha, beta, betaRoomId } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');

    const res = await handleView(post('/events', {
      sessionId: tour.sessionId,
      viewerKey: tour.viewerKey,
      // Both of these name the other tenant's property. Neither gets a vote.
      worldId: beta.worldId,
      events: [{ kind: 'room', roomId: betaRoomId, worldId: beta.worldId }],
    }), deps);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 1, roomsIgnored: 1, ended: false });
    const row = db.rows('wv_event')[0]!;
    expect(row['world_id']).toBe(alpha.worldId);
    expect(row['room_id']).toBeNull();
    // Nothing landed on the other tenant's analytics.
    expect(db.rows('wv_event').filter((r) => r['world_id'] === beta.worldId)).toHaveLength(0);
  });

  it('clamps a client clock into the session it belongs to', async () => {
    const { deps, db } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');
    advance(deps, 60_000);   // the visitor has been walking for a minute

    const res = await handleView(events(tour.sessionId, tour.viewerKey, [
      { kind: 'room', at: '2035-01-01T00:00:00.000Z' },   // a decade adrift
      { kind: 'room', at: '2020-01-01T00:00:00.000Z' },   // before the tour
      { kind: 'room', at: '2026-09-20T12:00:30.000Z' },   // plausible
      { kind: 'room' },                                   // no claim at all
    ]), deps);

    expect(res.status).toBe(200);
    expect(db.rows('wv_event').map((r) => r['at'])).toEqual([
      '2026-09-20T12:01:00.000Z',   // clamped down to arrival
      '2026-09-20T12:00:00.000Z',   // clamped up to the session's start
      '2026-09-20T12:00:30.000Z',   // believed
      '2026-09-20T12:01:00.000Z',   // stamped on arrival
    ]);
  });

  it('refuses a kind the aggregation does not understand, and writes none of the batch', async () => {
    const { deps, db } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');

    const res = await handleView(events(tour.sessionId, tour.viewerKey, [
      { kind: 'enter' },
      { kind: 'ai_state', payload: { salience: 'nice try' } },
    ]), deps);

    expect(res.status).toBe(400);
    // The valid event in the same batch went with it: a partial write of a
    // batch the client will retry is how events get counted twice.
    expect(db.rows('wv_event')).toHaveLength(0);
  });

  it('refuses a session that exceeds the rate limit rather than dropping it', async () => {
    const { deps, db } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');
    const batch = Array.from({ length: 32 }, () => ({ kind: 'room' as const }));

    const first = await handleView(events(tour.sessionId, tour.viewerKey, batch), deps);
    expect(first.status).toBe(200);
    const second = await handleView(events(tour.sessionId, tour.viewerKey, batch), deps);

    // 64 events in one minute is not a tour, and the client is told so.
    expect(second.status).toBe(429);
    expect(db.rows('wv_event')).toHaveLength(32);

    // A minute later the window has moved and the same client is served.
    advance(deps, 61_000);
    const third = await handleView(events(tour.sessionId, tour.viewerKey, batch), deps);
    expect(third.status).toBe(200);
    expect(db.rows('wv_event')).toHaveLength(64);
  });

  it('caps the rows one session can ever write, whatever it claims about time', async () => {
    const { deps, db, alpha } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');
    // Backdated far enough to sit outside every rolling window, which is the
    // evasion the row cap exists to close.
    db.seed('wv_event', Array.from({ length: 500 }, () => ({
      world_id: alpha.worldId, session_id: tour.sessionId, kind: 'room',
      room_id: null, payload: {}, at: '2026-09-20T11:00:00.000Z',
    })));

    const res = await handleView(events(tour.sessionId, tour.viewerKey, [{ kind: 'room' }]), deps);
    expect(res.status).toBe(429);
    expect(db.rows('wv_event')).toHaveLength(500);
  });

  it('refuses a batch larger than one flush and a payload larger than a payload', async () => {
    const { deps, db } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');

    const tooMany = await handleView(events(tour.sessionId, tour.viewerKey,
      Array.from({ length: 33 }, () => ({ kind: 'room' as const }))), deps);
    const tooBig = await handleView(events(tour.sessionId, tour.viewerKey, [
      { kind: 'measure', payload: { note: 'x'.repeat(2000) } },
    ]), deps);

    expect(tooMany.status).toBe(413);
    expect(tooBig.status).toBe(413);
    expect(db.rows('wv_event')).toHaveLength(0);
  });

  it('lets an exit close the session, and nothing else touch it', async () => {
    const { deps, db, roomId } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');
    const session = () => db.rows('wv_session')[0]!;
    const before = { ...session() };

    await handleView(events(tour.sessionId, tour.viewerKey, [{ kind: 'room', roomId }]), deps);
    expect(session()['ended_at']).toBeUndefined();

    advance(deps, 30_000);
    const bye = await handleView(events(tour.sessionId, tour.viewerKey, [
      { kind: 'exit', roomId, at: '2026-09-20T12:00:20.000Z' },
    ]), deps);
    expect(bye.status).toBe(200);
    expect((bye.body as { ended: boolean }).ended).toBe(true);
    expect(session()['ended_at']).toBe('2026-09-20T12:00:20.000Z');
    // ended_at and nothing else: the key, the world and the device blob are
    // not the event endpoint's to rewrite.
    expect(session()['viewer_key']).toBe(before['viewer_key']);
    expect(session()['world_id']).toBe(before['world_id']);
    expect(session()['device']).toEqual(before['device']);

    // And the pair stops being a write capability once the tour is over.
    const after = await handleView(events(tour.sessionId, tour.viewerKey, [{ kind: 'room' }]), deps);
    expect(after.status).toBe(409);
  });

  it('stops collecting for a world the operator has taken down', async () => {
    const { deps, db, alpha } = rig();
    const tour = await startTour(deps, 'alpha-court-flat-2');
    await db.update('wv_world', { status: 'draft', published_at: null }, { id: alpha.worldId });

    const res = await handleView(events(tour.sessionId, tour.viewerKey, [{ kind: 'room' }]), deps);
    expect(res.status).toBe(404);
    expect(db.rows('wv_event')).toHaveLength(0);
  });
});
