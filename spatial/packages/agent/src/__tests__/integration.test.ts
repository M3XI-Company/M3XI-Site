import { describe, expect, it } from 'vitest';

import type { WorldDocument } from '@m3xi/world-core';
import { World } from '@m3xi/spatial-engine';

import { buildWorldDocument } from '../../../../../supabase/functions/_wv_shared/worldDocument.ts';
import { handleAsk, type AskDeps } from '../../../../../supabase/functions/wv-ask/handler.ts';
import { makeAgentRunner, type AgentModule } from '../../../../../supabase/functions/wv-ask/runner.ts';

import { Agent } from '../agent.js';
import { FakeDb, makeDeps, req } from './edgeHarness.js';
import { FLAT } from './harness.js';
import { FakeModelClient } from '../model.js';
import { SalienceModel } from '../resolver.js';
import { DEFAULT_ROUTING } from '../pricing.js';
import { sanitiseViewerState } from '../view.js';

/**
 * The seam nobody tests until it breaks in production: the world lives in
 * Postgres as thirteen tables, the agent reasons over a WorldDocument, and
 * something has to turn one into the other. If that conversion loses a
 * tolerance, a provenance or a polygon winding, every downstream guarantee
 * quietly stops holding while every unit test still passes.
 *
 * So this suite takes the fixture, shreds it into rows the way the pipeline
 * would, reassembles it through the real conversion, and asserts the agent
 * gives the same answers it gives against the fixture directly.
 */
function shredFlatIntoDb(): FakeDb {
  const db = new FakeDb();
  const worldId = FLAT.id;

  db.seed('wv_world', [{
    id: worldId, property_id: FLAT.propertyId, version: FLAT.version, status: 'published',
    published_at: FLAT.publishedAt, created_at: FLAT.createdAt, slug: FLAT.slug,
    scale_source: FLAT.scale.source, scale_agreement: String(FLAT.scale.agreement),
    // How scale was grounded, not merely how well the estimators agreed. This
    // capture used a depth sensor, so its metre really is `reconstructed`;
    // a monocular capture's would be `inferred`, and every area measured with
    // it inherits the weaker claim. Losing this column is how a world ends up
    // publishing an estimate with a measurement's authority.
    scale_provenance: FLAT.scale.grounding.provenance,
    scale_confidence: String(FLAT.scale.grounding.confidence),
    quality_score: String(FLAT.quality.score),
  }]);
  db.seed('wv_property', [{ id: FLAT.propertyId, org_id: 'org', label: FLAT.label }]);
  db.seed('wv_floor', FLAT.floors.map((f) => ({
    id: f.id, world_id: worldId, level: f.level, name: f.name,
    // Numerics come back from PostgREST as strings; the conversion must cope.
    elevation_m: String(f.elevation),
    provenance: f.grounding.provenance, confidence: String(f.grounding.confidence),
  })));
  db.seed('wv_room', FLAT.rooms.map((r) => ({
    id: r.id, world_id: worldId, floor_id: r.floorId, stable_key: r.stableKey,
    name: r.name, kind: r.kind, polygon: r.polygon.map((p) => [p[0], p[1]]),
    floor_z: String(r.floorZ), ceiling_z: String(r.ceilingZ),
    area_m2: String(r.area.value), area_standard: r.area.standard,
    area_tol_pct: String(r.area.tolerance), wall_tol_mm: String(FLAT.measurementPolicy.wallToleranceMm),
    provenance: r.grounding.provenance, confidence: String(r.grounding.confidence),
  })));
  db.seed('wv_surface', FLAT.surfaces.map((s) => ({
    id: s.id, world_id: worldId, room_id: s.roomId, kind: s.kind,
    plane: s.plane, polygon: s.polygon.map((p) => [p[0], p[1], p[2]]),
    is_reflective: s.isReflective, is_glazed: s.isGlazed,
    provenance: s.grounding.provenance, confidence: String(s.grounding.confidence),
  })));
  db.seed('wv_opening', FLAT.openings.map((o) => ({
    id: o.id, world_id: worldId, kind: o.kind, surface_id: o.surfaceId,
    room_a: o.roomA, room_b: o.roomB,
    centre: [o.centre[0], o.centre[1], o.centre[2]],
    normal: o.normal ? [o.normal[0], o.normal[1], o.normal[2]] : null,
    width_m: o.width ? String(o.width.value) : null,
    height_m: o.height ? String(o.height.value) : null,
    sill_m: o.sill ? String(o.sill.value) : null,
    provenance: o.grounding.provenance, confidence: String(o.grounding.confidence),
  })));
  db.seed('wv_entity', FLAT.entities.map((e) => ({
    id: e.id, world_id: worldId, stable_key: e.stableKey, label: e.label,
    category: e.category, room_id: e.roomId,
    centroid: [e.centroid[0], e.centroid[1], e.centroid[2]],
    aabb: { min: [...e.aabb.min], max: [...e.aabb.max] },
    obb: e.obb ? { centre: [...e.obb.centre], half: [...e.obb.half], quat: [...e.obb.quat] } : null,
    observed_in: [...e.observedIn],
    provenance: e.grounding.provenance, confidence: String(e.grounding.confidence),
    attributes: e.attributes ?? {},
  })));
  db.seed('wv_relationship', []);
  db.seed('wv_nav_node', FLAT.nav.nodes.map((n) => ({
    id: n.id, world_id: worldId, room_id: n.roomId,
    position: [n.position[0], n.position[1], n.position[2]],
    clearance_m: String(n.clearance), is_entrance: n.isEntrance, is_viewpoint: n.isViewpoint,
  })));
  db.seed('wv_nav_edge', FLAT.nav.edges.map((e) => ({
    id: `${e.a}:${e.b}`, world_id: worldId, a: e.a, b: e.b,
    cost: String(e.cost), width_m: e.width ? String(e.width) : null,
    kind: e.kind, opening_id: e.openingId ?? null,
  })));
  db.seed('wv_region', FLAT.regions.map((r) => ({
    id: r.id, world_id: worldId, provenance: r.provenance,
    volume: { min: [...r.volume.min], max: [...r.volume.max] },
    room_id: r.roomId, reason: r.reason, confidence: String(r.confidence ?? ''),
  })));
  db.seed('wv_camera', FLAT.cameras.map((c) => ({
    id: c.id, world_id: worldId, capture_id: c.captureId, frame_index: c.frameIndex,
    t_ms: c.tMs, px: String(c.position[0]), py: String(c.position[1]), pz: String(c.position[2]),
    qx: String(c.orientation[0]), qy: String(c.orientation[1]),
    qz: String(c.orientation[2]), qw: String(c.orientation[3]),
    intrinsics: c.intrinsics, pose_confidence: String(c.poseConfidence ?? ''),
    sharpness: String(c.sharpness ?? ''), room_id: c.roomId,
  })));
  db.seed('wv_asset', FLAT.assets.map((a) => ({
    id: a.id, world_id: worldId, role: a.role, format: a.format,
    storage_path: a.url.replace('asset://', ''), bytes: a.bytes ?? null,
    checksum: a.checksum ?? null, lod: a.lod ?? null, chunk_key: a.chunkKey ?? null,
    splat_count: a.splatCount ?? null,
  })));
  db.seed('wv_quality', [{
    id: 'q', world_id: worldId, checks: FLAT.quality.checks,
    score: String(FLAT.quality.score), verdict: FLAT.quality.verdict,
    created_at: FLAT.quality.createdAt,
  }]);
  return db;
}

describe('database to world document', () => {
  it('round-trips the fixture through rows without losing anything that matters', async () => {
    const db = shredFlatIntoDb();
    const doc = await buildWorldDocument(db, FLAT.id) as unknown as WorldDocument;

    expect(doc.rooms).toHaveLength(FLAT.rooms.length);
    expect(doc.entities).toHaveLength(FLAT.entities.length);
    expect(doc.openings).toHaveLength(FLAT.openings.length);
    expect(doc.regions).toHaveLength(FLAT.regions.length);
    expect(doc.nav.nodes).toHaveLength(FLAT.nav.nodes.length);
    expect(doc.nav.edges).toHaveLength(FLAT.nav.edges.length);
    expect(doc.cameras).toHaveLength(FLAT.cameras.length);

    // The three things that must never be lost: the standard, the tolerance
    // and the provenance.
    expect(doc.measurementPolicy.areaStandard).toBe('RICS-COMP-GIA');
    expect(doc.measurementPolicy.wallToleranceMm).toBe(20);
    const bed1 = doc.rooms.find((r) => r.id === 'r_bed1')!;
    expect(bed1.area.standard).toBe('RICS-COMP-GIA');
    expect(bed1.area.tolerance).toBeGreaterThan(0);
    expect(bed1.grounding.provenance).toBe('reconstructed');

    const generated = doc.regions.find((r) => r.id === 'rg_bed1_far_corner')!;
    expect(generated.provenance).toBe('generated');
    expect(generated.volume.min[0]).toBeCloseTo(9.95, 6);

    const drawers = doc.entities.find((e) => e.id === 'e_chest_drawers')!;
    expect(drawers.grounding.provenance).toBe('inferred');
    expect(drawers.observedIn).toEqual(['cam_bed1_02']);
  });

  it('never defaults a missing confidence to certainty', async () => {
    const db = shredFlatIntoDb();
    for (const row of db.rows('wv_room')) delete row['confidence'];
    const doc = await buildWorldDocument(db, FLAT.id) as unknown as WorldDocument;
    for (const r of doc.rooms) expect(r.grounding.confidence).toBe(0.5);
  });

  it('the reassembled world measures the same as the fixture', async () => {
    const db = shredFlatIntoDb();
    const doc = await buildWorldDocument(db, FLAT.id) as unknown as WorldDocument;
    const fromRows = World.fromDocument(doc);
    const fromFixture = World.fromDocument(FLAT);

    for (const room of FLAT.rooms) {
      const a = fromRows.measureArea(room.id);
      const b = fromFixture.measureArea(room.id);
      expect(a.value, room.id).toBeCloseTo(b.value, 9);
      expect(a.tolerance, room.id).toBeCloseTo(b.tolerance, 9);
      expect(a.grounding.provenance, room.id).toBe(b.grounding.provenance);
    }
    const dRows = fromRows.measureDistance({ entityId: 'e_sofa' }, { entityId: 'e_tv' });
    const dFix = fromFixture.measureDistance({ entityId: 'e_sofa' }, { entityId: 'e_tv' });
    expect(dRows.value).toBeCloseTo(dFix.value, 9);
  });
});

describe('end to end: rows through the runner to an answer', () => {
  /** The runner expects the agent package's public shape; this is it. */
  const agentModule: AgentModule = {
    Agent: Agent as unknown as AgentModule['Agent'],
    World: World as unknown as AgentModule['World'],
    SalienceModel: SalienceModel as unknown as AgentModule['SalienceModel'],
    sanitiseViewerState: sanitiseViewerState as AgentModule['sanitiseViewerState'],
    DEFAULT_ROUTING: DEFAULT_ROUTING as unknown as Record<string, unknown>,
  };

  const SESSION = '99999999-9999-4999-8999-999999999991';

  function rig() {
    const db = shredFlatIntoDb();
    db.seed('wv_org', [{ id: 'org', ai_turns_per_session: 10 }]);
    db.seed('wv_member', []);
    db.seed('wv_session', [{
      id: SESSION, world_id: FLAT.id, viewer_key: 'key', ai_turns: 0, ai_cost_usd: 0, ended_at: null,
    }]);
    db.setRpc('wv_org_of_world', () => 'org');
    db.setRpc('wv_spend_allowed', () => ({ allowed: true }));

    const base = makeDeps({ db });
    const deps: AskDeps = {
      ...base.deps,
      agent: makeAgentRunner({
        db, agentModule, modelClient: new FakeModelClient(),
      }),
    };
    return { db, deps, logs: base.logs };
  }

  it('answers a measurement question from the database, with no model call', async () => {
    const { deps, db } = rig();
    const res = await handleAsk(req({
      body: {
        sessionId: SESSION, viewerKey: 'key',
        question: 'How big is the kitchen?',
        view: { position: [2.2, 1.6, 2.6], orientation: [0, 1, 0, 0], fovRad: 1.05 },
      },
    }), deps);

    expect(res.status).toBe(200);
    const out = res.body as Record<string, unknown>;
    expect(out['tier']).toBe('deterministic');
    expect(String(out['answer'])).toMatch(/20\.2 m²/);
    expect(String(out['answer'])).toMatch(/RICS gross internal area/);
    expect(out['refused']).toBe(false);

    const turn = db.rows('wv_ai_turn')[0]!;
    expect(turn['tier']).toBe('deterministic');
    expect(turn['model']).toBeNull();
    expect(turn['cost_usd']).toBe(0);
    expect(turn['grounded']).toBe(true);
  });

  it('refuses the generated region end to end', async () => {
    const { deps, db } = rig();
    const res = await handleAsk(req({
      body: {
        sessionId: SESSION, viewerKey: 'key',
        question: 'How big is bedroom 1?',
        view: { position: [5.3, 1.6, 3.2], orientation: [0, 0, 0, 1], fovRad: 1.05 },
      },
    }), deps);
    expect(res.status).toBe(200);
    expect(String((res.body as Record<string, unknown>)['answer']))
      .toMatch(/won't quote|no camera|not observe/i);
    expect(db.rows('wv_ai_turn')[0]!['grounded']).toBe(true);
  });

  it('carries conversation state across turns through the session', async () => {
    const { deps, db } = rig();
    const view = { position: [2.2, 1.6, 2.6], orientation: [0, 1, 0, 0], fovRad: 1.05 };

    const first = await handleAsk(req({
      body: { sessionId: SESSION, viewerKey: 'key', question: 'Where is the bookshelf?', view },
    }), deps);
    expect(first.status).toBe(200);
    // The salience snapshot is persisted so the next turn can resolve "that".
    const state = db.rows('wv_event').find((e) => e['kind'] === 'ai_state');
    expect(state).toBeTruthy();
    const salience = (state!['payload'] as { salience: { mentions: unknown[] } }).salience;
    expect(salience.mentions.length).toBeGreaterThan(0);

    const second = await handleAsk(req({
      body: { sessionId: SESSION, viewerKey: 'key', question: 'How far is that from the desk?', view },
    }), deps);
    expect(second.status).toBe(200);
    expect(String((second.body as Record<string, unknown>)['answer'])).toMatch(/bookshelf/i);
  });

  it('returns viewer commands the other half of the contract can apply', async () => {
    const { deps } = rig();
    const res = await handleAsk(req({
      body: {
        sessionId: SESSION, viewerKey: 'key', question: 'Show me bedroom 2',
        view: { position: [2.2, 1.6, 2.6], orientation: [0, 1, 0, 0], fovRad: 1.05 },
      },
    }), deps);
    const commands = (res.body as Record<string, unknown>)['commands'] as { kind: string }[];
    expect(commands.map((c) => c.kind)).toContain('moveCamera');
    // Plain JSON all the way through: it crossed a handler boundary already.
    expect(JSON.parse(JSON.stringify(commands))).toEqual(commands);
  });

  it('survives a hostile viewer pose without crashing or inventing a room', async () => {
    const { deps } = rig();
    for (const view of [
      null, 'not an object', { position: 'nope' }, { position: [1e18, NaN, 'x'] },
      { position: [1, 1, 1], orientation: [0, 0, 0, 0] },
      { selectedEntityId: 'x'.repeat(10_000) },
    ]) {
      const res = await handleAsk(req({
        body: { sessionId: SESSION, viewerKey: 'key', question: 'What is in here?', view },
      }), deps);
      expect(res.status, JSON.stringify(view)).toBe(200);
    }
  });
});
