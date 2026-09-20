import { describe, expect, it } from 'vitest';

import { handleView, findForbiddenKey } from '../../../../../supabase/functions/wv-view/handler.ts';
import { handleAsk, type AskDeps, type AgentTurnResult } from '../../../../../supabase/functions/wv-ask/handler.ts';
import { handleJobs } from '../../../../../supabase/functions/wv-jobs/handler.ts';
import { handleWorlds } from '../../../../../supabase/functions/wv-worlds/handler.ts';
import { handleExport, type ExportDeps } from '../../../../../supabase/functions/wv-export/handler.ts';
import { buildZip, crc32 } from '../../../../../supabase/functions/_wv_shared/zip.ts';
import { buildBundleEntries, renderFloorplanSvg } from '../../../../../supabase/functions/wv-export/bundle.ts';
import { secretEquals } from '../../../../../supabase/functions/_wv_shared/http.ts';

import {
  FakeDb, ORG_A, ORG_B, PROP_A, PROP_B, USER_A, USER_B, WORLD_A, WORLD_B,
  makeDeps, req, twoTenantDb,
} from './edgeHarness.js';
import { FLAT } from './harness.js';

// ---------------------------------------------------------------------------
// wv-view
// ---------------------------------------------------------------------------

describe('wv-view', () => {
  it('serves a published world by slug', async () => {
    const { deps, db } = makeDeps({ db: twoTenantDb() });
    const res = await handleView(req({ body: { slug: 'flat-2-alpha-court' } }), deps);
    expect(res.status).toBe(200);
    const m = res.body as Record<string, any>;
    expect(m['world'].id).toBe(WORLD_A);
    expect(m['world'].label).toBe('Flat 2, Alpha Court');
    expect(m['rooms']).toHaveLength(1);
    expect(m['session'].id).toBeTruthy();
    expect(db.rows('wv_session')).toHaveLength(1);
  });

  it('refuses an unpublished world with the same 404 as a missing one', async () => {
    const { deps } = makeDeps({ db: twoTenantDb() });
    const draft = await handleView(req({ body: { slug: 'beta-house' } }), deps);
    const missing = await handleView(req({ body: { slug: 'no-such-property' } }), deps);
    expect(draft.status).toBe(404);
    expect(missing.status).toBe(404);
    // Byte-identical, so a slug cannot be probed for existence.
    expect(JSON.stringify(draft.body)).toBe(JSON.stringify(missing.body));
  });

  it('never returns an edit key, an org id or a storage path', async () => {
    const { deps } = makeDeps({ db: twoTenantDb() });
    const res = await handleView(req({ body: { worldId: WORLD_A } }), deps);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('SECRET-EDIT-KEY');
    expect(raw).not.toContain(ORG_A);
    // A signed URL necessarily contains the object path; what must never
    // appear is a DURABLE pointer, i.e. a bare storage_path field that
    // outlives the signature.
    expect(raw).not.toMatch(/"storage_path"/);
    const assets = (res.body as Record<string, any>)['assets'] as any[];
    for (const a of assets) expect(a.url).toMatch(/token=signed/);
    expect(findForbiddenKey(res.body)).toBeNull();
  });

  it('signs asset URLs and withholds roles the public should not have', async () => {
    const { deps, storage } = makeDeps({ db: twoTenantDb() });
    const res = await handleView(req({ body: { worldId: WORLD_A } }), deps);
    const assets = (res.body as Record<string, any>)['assets'] as any[];
    expect(assets).toHaveLength(1);
    expect(assets[0].role).toBe('splat');
    expect(assets[0].url).toMatch(/^https:\/\/storage\.test\/.*token=signed/);
    expect(assets[0].storage_path).toBeUndefined();
    // The raw walkthrough video is somebody's home and is never offered.
    expect(storage.signed.map((s) => s.path)).not.toContain('alpha/world-a/raw-walkthrough.mp4');
  });

  it('survives a storage outage without taking the tour down', async () => {
    const { deps, storage } = makeDeps({ db: twoTenantDb() });
    storage.failSigning = true;
    const res = await handleView(req({ body: { worldId: WORLD_A } }), deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, any>)['assets']).toHaveLength(0);
    expect((res.body as Record<string, any>)['rooms']).toHaveLength(1);
  });

  it('treats its input as hostile', async () => {
    const { deps } = makeDeps({ db: twoTenantDb() });
    const nasties: unknown[] = [
      { slug: '../../etc/passwd' },
      { slug: "flat-2-alpha-court' or '1'='1" },
      { worldId: 'not-a-uuid' },
      { worldId: { $ne: null } },
      { slug: 'x'.repeat(5000) },
      null,
      'a string body',
      [],
    ];
    for (const body of nasties) {
      const res = await handleView(req({ body }), deps);
      expect([400, 404], JSON.stringify(body)).toContain(res.status);
    }
  });

  it('caps and shapes the device blob instead of storing what it is given', async () => {
    const { deps, db } = makeDeps({ db: twoTenantDb() });
    await handleView(req({
      body: {
        worldId: WORLD_A,
        device: { platform: 'x'.repeat(5000), evil: { nested: true }, dpr: 2, fn: 'drop table' },
      },
    }), deps);
    const device = db.rows('wv_session')[0]!['device'] as Record<string, unknown>;
    expect(String(device['platform']).length).toBe(200);
    expect(device['evil']).toBeUndefined();
    expect(device['dpr']).toBe(2);
  });

  it('the forbidden-key sweep actually catches a leak', () => {
    expect(findForbiddenKey({ a: { b: [{ edit_key: 'x' }] } })).toBe('edit_key');
    expect(findForbiddenKey({ a: { b: [{ fine: 'x' }] } })).toBeNull();
    // The session's own handle is deliberately returned and must not trip it.
    expect(findForbiddenKey({ session: { viewerKey: 'abc' } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wv-ask
// ---------------------------------------------------------------------------

const SESSION_A = '99999999-9999-4999-8999-999999999991';
const SESSION_B = '99999999-9999-4999-8999-999999999992';

function askRig(over: { turns?: number; spend?: unknown } = {}) {
  const db = twoTenantDb();
  db.seed('wv_session', [
    { id: SESSION_A, world_id: WORLD_A, viewer_key: 'key-a', ai_turns: over.turns ?? 0, ai_cost_usd: 0, ended_at: null },
    { id: SESSION_B, world_id: WORLD_B, viewer_key: 'key-b', ai_turns: 0, ai_cost_usd: 0, ended_at: null },
  ]);
  if (over.spend !== undefined) db.setRpc('wv_spend_allowed', () => over.spend);

  const seen: { worldId: string; question: string }[] = [];
  const base = makeDeps({ db });
  const deps: AskDeps = {
    ...base.deps,
    agent: {
      async run(input): Promise<AgentTurnResult> {
        seen.push({ worldId: input.worldId, question: input.question });
        return {
          answer: { text: `answered for ${input.worldId}`, refused: false, grounded: true },
          commands: [{ kind: 'focusRoom', id: 'c1', intent: 'answer', roomId: 'r', isolate: false }],
          record: {
            tier: 'small', model: 'claude-haiku-4.5', tools: ['measure_area'],
            grounded: true, refused: false, inTokens: 3200, outTokens: 140,
            cachedTokens: 3000, costUsd: 0.0021, latencyMs: 410,
          },
          salience: { turn: 1, mentions: [] },
        };
      },
    },
  };
  return { db, deps, seen, logs: base.logs };
}

describe('wv-ask', () => {
  it('answers and records the turn', async () => {
    const { deps, db } = askRig();
    const res = await handleAsk(req({
      body: { sessionId: SESSION_A, viewerKey: 'key-a', question: 'How big is the living room?' },
    }), deps);
    expect(res.status).toBe(200);
    expect((res.body as any).answer).toContain(WORLD_A);

    const turns = db.rows('wv_ai_turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!['tier']).toBe('small');
    expect(turns[0]!['model']).toBe('claude-haiku-4.5');
    expect(turns[0]!['in_tokens']).toBe(3200);
    expect(turns[0]!['cached_tokens']).toBe(3000);
    expect(turns[0]!['cost_usd']).toBeCloseTo(0.0021, 9);
    expect(turns[0]!['latency_ms']).toBe(410);
    expect(turns[0]!['grounded']).toBe(true);
    expect(turns[0]!['refused']).toBe(false);

    const session = db.rows('wv_session').find((s) => s['id'] === SESSION_A)!;
    expect(session['ai_turns']).toBe(1);
    expect(Number(session['ai_cost_usd'])).toBeCloseTo(0.0021, 9);
  });

  it('enforces the turn cap BEFORE doing any work', async () => {
    // Org A allows 5 turns per session; this session has used them.
    const { deps, seen, db } = askRig({ turns: 5 });
    const res = await handleAsk(req({
      body: { sessionId: SESSION_A, viewerKey: 'key-a', question: 'one more' },
    }), deps);
    expect(res.status).toBe(429);
    expect((res.body as any).capped).toBe('turns');
    expect(seen).toHaveLength(0);
    expect(db.rows('wv_ai_turn')).toHaveLength(0);
    // The spend RPC is not even consulted: the cheaper check comes first.
    expect(db.calls.some((c) => c.op === 'rpc' && c.table === 'wv_spend_allowed')).toBe(false);
  });

  it('enforces the org spend cap BEFORE doing any work', async () => {
    const { deps, seen, db } = askRig({
      spend: { allowed: false, reason: 'ai_month_cap', spent_usd: 40 },
    });
    const res = await handleAsk(req({
      body: { sessionId: SESSION_A, viewerKey: 'key-a', question: 'How big is it?' },
    }), deps);
    expect(res.status).toBe(429);
    expect((res.body as any).capped).toBe('ai_month_cap');
    expect(seen).toHaveLength(0);
    expect(db.rows('wv_ai_turn')).toHaveLength(0);
  });

  it('refuses rather than spending when the spend check itself fails', async () => {
    const db = twoTenantDb();
    db.seed('wv_session', [{ id: SESSION_A, world_id: WORLD_A, viewer_key: 'key-a', ai_turns: 0, ai_cost_usd: 0, ended_at: null }]);
    db.setRpc('wv_spend_allowed', () => { throw new Error('database unavailable'); });
    const base = makeDeps({ db });
    const seen: unknown[] = [];
    const deps: AskDeps = {
      ...base.deps,
      agent: { async run(i) { seen.push(i); throw new Error('should not run'); } },
    };
    const res = await handleAsk(req({
      body: { sessionId: SESSION_A, viewerKey: 'key-a', question: 'hello' },
    }), deps);
    expect(res.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it('takes the world from the session, never from the request body', async () => {
    const { deps, seen } = askRig();
    await handleAsk(req({
      body: {
        sessionId: SESSION_A, viewerKey: 'key-a', question: 'what is here',
        // A caller who knows org B's world id tries to aim the AI at it.
        worldId: WORLD_B, world_id: WORLD_B, propertyId: PROP_B,
      },
    }), deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.worldId).toBe(WORLD_A);
  });

  it('rejects a guessed session id without the matching viewer key', async () => {
    const { deps, seen } = askRig();
    const res = await handleAsk(req({
      body: { sessionId: SESSION_A, viewerKey: 'wrong-key', question: 'hello' },
    }), deps);
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('refuses a session whose world is no longer published', async () => {
    const { deps, seen } = askRig();
    // Session B belongs to org B's draft world.
    const res = await handleAsk(req({
      body: { sessionId: SESSION_B, viewerKey: 'key-b', question: 'hello' },
    }), deps);
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('still writes an accounting row when the agent throws', async () => {
    const db = twoTenantDb();
    db.seed('wv_session', [{ id: SESSION_A, world_id: WORLD_A, viewer_key: 'key-a', ai_turns: 0, ai_cost_usd: 0, ended_at: null }]);
    const base = makeDeps({ db });
    const deps: AskDeps = {
      ...base.deps,
      agent: { async run() { throw new Error('engine exploded'); } },
    };
    const res = await handleAsk(req({
      body: { sessionId: SESSION_A, viewerKey: 'key-a', question: 'hello' },
    }), deps);
    expect(res.status).toBe(500);
    const turns = db.rows('wv_ai_turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!['grounded']).toBe(false);
    expect(turns[0]!['refused']).toBe(true);
    expect(turns[0]!['cost_usd']).toBe(0);
  });

  it('rejects an oversized question before it reaches a tokeniser', async () => {
    const { deps, seen } = askRig();
    const res = await handleAsk(req({
      body: { sessionId: SESSION_A, viewerKey: 'key-a', question: 'x'.repeat(5000) },
    }), deps);
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// wv-jobs
// ---------------------------------------------------------------------------

const WORKER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECRET = 'a'.repeat(48);

function jobsRig(env: Record<string, string> = { WV_WORKER_SECRET: SECRET }) {
  const db = twoTenantDb();
  // Stage names are the pipeline's own (worldengine/stages/), which is what
  // the handler now accepts. 'splat' is the reconstruction stage.
  db.seed('wv_worker', [{ id: WORKER, name: 'gpu-01', capabilities: ['splat', 'mesh'] }]);
  db.seed('wv_job', [
    { id: JOB_1, world_id: WORLD_A, stage: 'splat', status: 'queued', attempt: 0, depends_on: [] },
  ]);
  db.setRpc('wv_claim_job', (args) => {
    const stages = args['p_stages'] as string[];
    const job = db.rows('wv_job').find((j) => stages.includes(String(j['stage'])) && j['status'] === 'queued');
    if (!job) return [];
    job['status'] = 'leased';
    job['worker_id'] = args['p_worker_id'];
    job['attempt'] = Number(job['attempt']) + 1;
    job['lease_until'] = '2026-09-19T12:15:00.000Z';
    return [{ ...job }];
  });
  // Mirrors the migration: one conditional UPDATE, false if it matched nothing.
  db.setRpc('wv_heartbeat_job', (args) => {
    const job = db.rows('wv_job').find((j) => String(j['id']) === String(args['p_job_id'])
      && String(j['worker_id']) === String(args['p_worker_id'])
      && (j['status'] === 'leased' || j['status'] === 'running'));
    if (!job) return false;
    job['status'] = 'running';
    job['lease_until'] = '2026-09-19T12:30:00.000Z';
    return true;
  });
  const base = makeDeps({ db, env });
  return { db, deps: base.deps, logs: base.logs };
}

describe('wv-jobs', () => {
  it('claims a job with the shared secret', async () => {
    const { deps, db } = jobsRig();
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'claim', workerId: WORKER, stages: ['splat'], leaseSeconds: 900 },
    }), deps);
    expect(res.status).toBe(200);
    expect((res.body as any).job.stage).toBe('splat');
    expect(db.rows('wv_job')[0]!['status']).toBe('leased');
  });

  it('refuses without the secret, and never accepts an anon key', async () => {
    const { deps } = jobsRig();
    const attempts: Record<string, string>[] = [
      {},
      { 'x-wv-worker-secret': '' },
      { 'x-wv-worker-secret': 'wrong' },
      // The anon key is printed in every page of the site. It must buy nothing.
      { authorization: 'Bearer some.anon.key' },
    ];
    for (const headers of attempts) {
      const res = await handleJobs(req({
        headers, body: { action: 'claim', workerId: WORKER, stages: ['splat'] },
      }), deps);
      expect(res.status).toBe(401);
    }
  });

  it('fails closed when no secret is configured', async () => {
    const { deps } = jobsRig({});
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': '' },
      body: { action: 'claim', workerId: WORKER, stages: ['splat'] },
    }), deps);
    expect(res.status).toBe(401);
  });

  it('refuses a stage the worker is not registered for', async () => {
    const { deps } = jobsRig();
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'claim', workerId: WORKER, stages: ['redact'] },
    }), deps);
    expect(res.status).toBe(403);
  });

  it('only lets the lease holder heartbeat or complete', async () => {
    const { deps, db } = jobsRig();
    await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'claim', workerId: WORKER, stages: ['splat'] },
    }), deps);

    const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const stolen = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'heartbeat', jobId: JOB_1, workerId: other },
    }), deps);
    expect(stolen.status).toBe(409);

    const ok = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'complete', jobId: JOB_1, workerId: WORKER, gpuSeconds: 812, costUsd: 0.74 },
    }), deps);
    expect(ok.status).toBe(200);
    const job = db.rows('wv_job')[0]!;
    expect(job['status']).toBe('succeeded');
    expect(job['gpu_seconds']).toBe(812);
    expect(job['cost_usd']).toBe(0.74);
  });

  it('requeues a retryable failure and gives up after three attempts', async () => {
    const { deps, db } = jobsRig();
    await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'claim', workerId: WORKER, stages: ['splat'] },
    }), deps);

    const first = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'fail', jobId: JOB_1, workerId: WORKER, error: 'CUDA OOM' },
    }), deps);
    expect((first.body as any).requeued).toBe(true);
    expect(db.rows('wv_job')[0]!['status']).toBe('queued');

    db.rows('wv_job')[0]!['attempt'] = 3;
    db.rows('wv_job')[0]!['worker_id'] = WORKER;
    const last = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'fail', jobId: JOB_1, workerId: WORKER, error: 'CUDA OOM again' },
    }), deps);
    expect((last.body as any).requeued).toBe(false);
    expect(db.rows('wv_job')[0]!['status']).toBe('failed');
    expect(db.rows('wv_world').find((w) => w['id'] === WORLD_A)!['status']).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // The pod holds no credential but WV_WORKER_SECRET, so everything it needs to
  // write goes through an action here. These are the tests that keep it that
  // way.
  // -------------------------------------------------------------------------

  async function claimed(deps: any) {
    return handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'claim', workerId: WORKER, stages: ['splat'] },
    }), deps);
  }

  it('extends a lease through the queue function, not a bare update', async () => {
    const { deps, db } = jobsRig();
    await claimed(deps);
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'heartbeat', jobId: JOB_1, workerId: WORKER, leaseSeconds: 900 },
    }), deps);
    expect(res.status).toBe(200);
    expect(db.rows('wv_job')[0]!['status']).toBe('running');
    // The mutation must be the rpc, so the ownership check happens inside one
    // statement rather than across a select-then-update race.
    expect(db.calls.some((c) => c.op === 'rpc' && c.table === 'wv_heartbeat_job')).toBe(true);
  });

  it('stops a worker whose job was reclaimed between its select and its update', async () => {
    const { deps, db } = jobsRig();
    await claimed(deps);
    // The row still names this worker, but the queue function refuses: this is
    // the reaper having requeued it a moment ago.
    db.setRpc('wv_heartbeat_job', () => false);
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'heartbeat', jobId: JOB_1, workerId: WORKER },
    }), deps);
    expect(res.status).toBe(409);
  });

  it('accepts every stage the pipeline actually has', async () => {
    // The handler's stage list must match worldengine/runner.py's STAGE_DEPS.
    // A name that does not match means a worker can never claim that stage.
    const pipelineStages = [
      'ingest', 'frames', 'redact', 'pose', 'scale', 'splat', 'mesh',
      'layout', 'semantics', 'graph', 'regions', 'package', 'quality',
    ];
    for (const stage of pipelineStages) {
      const db = twoTenantDb();
      db.seed('wv_worker', [{ id: WORKER, name: 'gpu-01', capabilities: [] }]);
      db.seed('wv_job', [{
        id: JOB_1, world_id: WORLD_A, stage, status: 'queued', attempt: 0, depends_on: [],
      }]);
      db.setRpc('wv_claim_job', (args) => {
        const stages = args['p_stages'] as string[];
        const job = db.rows('wv_job').find((j) => stages.includes(String(j['stage'])));
        if (!job) return [];
        job['status'] = 'leased';
        job['worker_id'] = args['p_worker_id'];
        return [{ ...job }];
      });
      const { deps } = makeDeps({ db, env: { WV_WORKER_SECRET: SECRET } });
      const res = await handleJobs(req({
        headers: { 'x-wv-worker-secret': SECRET },
        body: { action: 'claim', workerId: WORKER, stages: [stage] },
      }), deps);
      expect(res.status, `stage ${stage}`).toBe(200);
      expect((res.body as any).job.stage).toBe(stage);
    }
  });

  it('issues signed upload urls scoped to the job\'s own world', async () => {
    const { deps, db } = jobsRig();
    const storage = (deps as any).storage;
    await claimed(deps);

    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: {
        action: 'upload-urls', jobId: JOB_1, workerId: WORKER,
        files: [{ name: 'ab/abcdef.spz' }, { name: 'world.json' }],
      },
    }), deps);

    expect(res.status).toBe(200);
    const body = res.body as any;
    // The same bucket wv-view and wv-export sign read urls against.
    expect(body.bucket).toBe('wv-assets');
    expect(body.files).toHaveLength(2);
    // The prefix is the handler's, from the job row. A worker cannot choose it.
    for (const f of body.files) {
      expect(String(f.storagePath).startsWith(`${WORLD_A}/`)).toBe(true);
      expect(String(f.uploadUrl)).toContain('token=upload');
    }
    // Short-lived: the URL is the credential.
    expect(storage.signedUploads[0].ttl).toBeLessThanOrEqual(15 * 60);
    expect(db.rows('wv_job')[0]!['status']).toBe('leased');
  });

  it('refuses upload urls to a worker that does not hold the lease', async () => {
    const { deps } = jobsRig();
    await claimed(deps);
    const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: { action: 'upload-urls', jobId: JOB_1, workerId: other, files: [{ name: 'x.spz' }] },
    }), deps);
    expect(res.status).toBe(409);
  });

  it('refuses path traversal in an object name', async () => {
    const { deps } = jobsRig();
    await claimed(deps);
    const storage = (deps as any).storage;
    const nasty = ['../secrets.spz', `../${WORLD_B}/splat.spz`, '/etc/passwd',
      'a/../../b.spz', '', 'x\\y.spz', './x.spz'];
    for (const name of nasty) {
      const res = await handleJobs(req({
        headers: { 'x-wv-worker-secret': SECRET },
        body: { action: 'upload-urls', jobId: JOB_1, workerId: WORKER, files: [{ name }] },
      }), deps);
      expect(res.status, `name ${JSON.stringify(name)}`).toBe(400);
    }
    expect(storage.signedUploads).toHaveLength(0);
  });

  it('records redactions against the job\'s world, not the body\'s', async () => {
    const { deps, db } = jobsRig();
    await claimed(deps);
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: {
        action: 'redactions', jobId: JOB_1, workerId: WORKER,
        // A hostile worker naming another tenant's world must be ignored.
        worldId: WORLD_B, world_id: WORLD_B,
        rows: [
          { kind: 'medication', bbox: [1, 2, 3, 4], detector: 'owlv2', score: 0.31, applied: true },
          { kind: 'face', bbox: [5, 6, 7, 8], detector: 'yunet', score: 0.88, applied: false },
        ],
      },
    }), deps);
    expect(res.status).toBe(200);
    const rows = db.rows('wv_redaction');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r['world_id'] === WORLD_A)).toBe(true);
    // Applied or not, every detection is an audit row.
    expect(rows.map((r) => r['applied']).sort()).toEqual([false, true]);
  });

  it('rejects malformed redaction rows rather than storing them', async () => {
    const { deps, db } = jobsRig();
    await claimed(deps);
    const bad = [
      { kind: 'not_a_kind', bbox: [1, 2, 3, 4], detector: 'x' },
      { kind: 'face', bbox: [1, 2, 3], detector: 'x' },
      { kind: 'face', bbox: [1, 2, 3, Number.NaN], detector: 'x' },
      { kind: 'face', bbox: [1, 2, 3, 4] },
    ];
    for (const row of bad) {
      const res = await handleJobs(req({
        headers: { 'x-wv-worker-secret': SECRET },
        body: { action: 'redactions', jobId: JOB_1, workerId: WORKER, rows: [row] },
      }), deps);
      expect(res.status, JSON.stringify(row)).toBe(400);
    }
    expect(db.rows('wv_redaction')).toHaveLength(0);
  });

  it('writes assets, quality and the publication decision on complete', async () => {
    const { deps, db } = jobsRig();
    await claimed(deps);
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: {
        action: 'complete', jobId: JOB_1, workerId: WORKER,
        gpuSeconds: 2040, costUsd: 0.74,
        assets: [{ role: 'splat', format: 'spz', name: 'ab/abcd.spz',
          bytes: 24_000_000, checksum: 'ab'.repeat(32), splatCount: 800_000 }],
        quality: { verdict: 'pass', score: 0.93,
          checks: [{ name: 'scale_agreement', value: 0.95, threshold: 0.9, pass: true }] },
        scale: { source: 'mapanything+moge2:agreed', agreement: 0.95 },
      },
    }), deps);
    expect(res.status).toBe(200);

    const asset = db.rows('wv_asset').find((a) => a['storage_path'] === `${WORLD_A}/ab/abcd.spz`);
    expect(asset).toBeDefined();
    expect(asset!['world_id']).toBe(WORLD_A);
    const world = db.rows('wv_world').find((w) => w['id'] === WORLD_A)!;
    expect(world['status']).toBe('published');
    expect(world['quality_score']).toBe(0.93);
    expect(world['scale_agreement']).toBe(0.95);
    expect(db.rows('wv_quality').some((q) => q['verdict'] === 'pass' && q['world_id'] === WORLD_A))
      .toBe(true);
    const job = db.rows('wv_job')[0]!;
    expect(job['gpu_seconds']).toBe(2040);
    expect(job['cost_usd']).toBe(0.74);
  });

  it('will not publish a world whose own checks did not pass', async () => {
    // The worker computes the gate, so the handler cannot re-derive it. But a
    // 'pass' alongside a failing check is incoherent, and the safe reading of
    // an incoherent gate result is the conservative one.
    const { deps, db } = jobsRig();
    await claimed(deps);
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: {
        action: 'complete', jobId: JOB_1, workerId: WORKER,
        quality: { verdict: 'pass', score: 0.99,
          checks: [{ name: 'redaction_completeness', pass: false }] },
      },
    }), deps);
    expect((res.body as any).verdict).toBe('review');
    const world = db.rows('wv_world').find((w) => w['id'] === WORLD_A)!;
    expect(world['status']).toBe('review');
    expect(world['published_at']).toBeNull();
  });

  it('refuses an asset path outside the world prefix', async () => {
    const { deps, db } = jobsRig();
    await claimed(deps);
    const res = await handleJobs(req({
      headers: { 'x-wv-worker-secret': SECRET },
      body: {
        action: 'complete', jobId: JOB_1, workerId: WORKER,
        assets: [{ role: 'splat', format: 'spz', name: `../${WORLD_B}/splat.spz` }],
      },
    }), deps);
    expect(res.status).toBe(400);
    expect(db.rows('wv_asset').some((a) => String(a['storage_path']).includes(WORLD_B))).toBe(false);
    // And the job is not closed by a rejected request.
    expect(db.rows('wv_job')[0]!['status']).toBe('leased');
  });

  it('requires the shared secret on every action, not just claim', async () => {
    const { deps } = jobsRig();
    await claimed(deps);
    for (const action of ['heartbeat', 'upload-urls', 'redactions', 'complete', 'fail']) {
      const res = await handleJobs(req({
        headers: { 'x-wv-worker-secret': 'wrong' },
        body: { action, jobId: JOB_1, workerId: WORKER, files: [{ name: 'a.spz' }], rows: [] },
      }), deps);
      expect(res.status, action).toBe(401);
    }
  });

  it('compares secrets without leaking their length through timing', () => {
    expect(secretEquals(SECRET, SECRET)).toBe(true);
    expect(secretEquals(SECRET, `${SECRET}x`)).toBe(false);
    expect(secretEquals(SECRET, 'a')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wv-worlds
// ---------------------------------------------------------------------------

function worldsRig(user: { id: string } | null) {
  const db = twoTenantDb();
  db.setRpc('wv_spend_allowed', () => ({ allowed: true }));
  const base = makeDeps({ db, user });
  return { db, deps: base.deps, logs: base.logs };
}

const AUTH = { authorization: 'Bearer operator-token' };

describe('wv-worlds', () => {
  it('requires a signed-in caller', async () => {
    const { deps } = worldsRig(null);
    const res = await handleWorlds(req({ body: { action: 'get_world', worldId: WORLD_A } }), deps);
    expect(res.status).toBe(401);
  });

  it('creates a property and a world version for the caller own org', async () => {
    const { deps, db } = worldsRig({ id: USER_A });
    const prop = await handleWorlds(req({
      headers: AUTH, body: { action: 'create_property', orgId: ORG_A, label: 'New listing' },
    }), deps);
    expect(prop.status).toBe(201);
    const propertyId = (prop.body as any).property.id;

    const world = await handleWorlds(req({
      headers: AUTH, body: { action: 'create_world', propertyId },
    }), deps);
    expect(world.status).toBe(201);
    expect((world.body as any).world.version).toBe(1);
    expect(db.rows('wv_world').some((w) => w['property_id'] === propertyId)).toBe(true);
  });

  it('increments the version and records what it supersedes', async () => {
    const { deps } = worldsRig({ id: USER_A });
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'create_world', propertyId: PROP_A },
    }), deps);
    expect((res.body as any).world.version).toBe(2);
  });

  it('queues the whole pipeline with dependencies in order', async () => {
    const { deps, db } = worldsRig({ id: USER_A });
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'request_build', worldId: WORLD_A },
    }), deps);
    expect(res.status).toBe(202);
    const jobs = db.rows('wv_job');
    expect(jobs.length).toBeGreaterThan(10);
    expect(jobs[0]!['stage']).toBe('ingest');
    expect(jobs[0]!['depends_on']).toEqual([]);
    expect((jobs[1]!['depends_on'] as string[])[0]).toBe(jobs[0]!['id']);
    expect(db.rows('wv_world').find((w) => w['id'] === WORLD_A)!['status']).toBe('processing');
  });

  it('refuses a build when the org has used its monthly allowance', async () => {
    const { deps, db } = worldsRig({ id: USER_A });
    db.setRpc('wv_spend_allowed', () => ({ allowed: false, reason: 'build_month_cap' }));
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'request_build', worldId: WORLD_A },
    }), deps);
    expect(res.status).toBe(429);
    expect(db.rows('wv_job')).toHaveLength(0);
  });

  it('publishes a world whose latest quality verdict is a pass', async () => {
    const { deps, db } = worldsRig({ id: USER_A });
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'publish', worldId: WORLD_A, slug: 'flat-2-alpha-court' },
    }), deps);
    expect(res.status).toBe(200);
    const world = db.rows('wv_world').find((w) => w['id'] === WORLD_A)!;
    expect(world['status']).toBe('published');
    expect(world['published_at']).toBeTruthy();
  });

  it('BLOCKS publication when the verdict is review, and says which check failed', async () => {
    const { deps, db } = worldsRig({ id: USER_B });
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'publish', worldId: WORLD_B },
    }), deps);
    expect(res.status).toBe(409);
    expect((res.body as any).error).toMatch(/review/);
    expect((res.body as any).error).toMatch(/ceiling_observed_fraction/);
    expect(db.rows('wv_world').find((w) => w['id'] === WORLD_B)!['status']).toBe('draft');
  });

  it('blocks publication when there is no quality row at all', async () => {
    const { deps, db } = worldsRig({ id: USER_A });
    db.tables.set('wv_quality', []);
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'publish', worldId: WORLD_A },
    }), deps);
    expect(res.status).toBe(409);
    expect((res.body as any).error).toMatch(/quality gate/);
  });

  it('applies only allowlisted corrections', async () => {
    const { deps, db } = worldsRig({ id: USER_A });
    const roomId = '77777777-7777-4777-8777-777777777771';
    const res = await handleWorlds(req({
      headers: AUTH,
      body: {
        action: 'approve_corrections', worldId: WORLD_A,
        corrections: [
          { target: 'room', id: roomId, field: 'name', value: 'Sitting room' },
          // A hand-edited polygon would become a "reconstructed" measurement
          // that no camera supports. Refused.
          { target: 'room', id: roomId, field: 'polygon', value: '[[0,0]]' },
          { target: 'room', id: roomId, field: 'area_m2', value: '99' },
        ],
      },
    }), deps);
    expect((res.body as any).applied).toBe(1);
    expect((res.body as any).rejected).toHaveLength(2);
    const room = db.rows('wv_room').find((r) => r['id'] === roomId)!;
    expect(room['name']).toBe('Sitting room');
    expect(room['area_m2']).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — the crossings, attempted for real
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('org B cannot read org A world through wv-worlds', async () => {
    const { deps, logs } = worldsRig({ id: USER_B });
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'get_world', worldId: WORLD_A },
    }), deps);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Alpha');
    expect(logs.some((l) => l.event === 'wv_worlds_cross_tenant_denied')).toBe(true);
  });

  it('org B cannot publish, build, correct or export org A world', async () => {
    const { deps, db } = worldsRig({ id: USER_B });
    const actions = [
      { action: 'publish', worldId: WORLD_A },
      { action: 'request_build', worldId: WORLD_A },
      { action: 'unpublish', worldId: WORLD_A },
      {
        action: 'approve_corrections', worldId: WORLD_A,
        corrections: [{ target: 'room', id: '77777777-7777-4777-8777-777777777771', field: 'name', value: 'Pwned' }],
      },
    ];
    for (const body of actions) {
      const res = await handleWorlds(req({ headers: AUTH, body }), deps);
      expect(res.status, body.action).toBe(404);
    }
    // Nothing changed.
    const world = db.rows('wv_world').find((w) => w['id'] === WORLD_A)!;
    expect(world['status']).toBe('published');
    expect(db.rows('wv_room').find((r) => r['world_id'] === WORLD_A)!['name']).toBe('Living room');
    expect(db.rows('wv_job')).toHaveLength(0);
  });

  it('org B cannot create a property inside org A', async () => {
    const { deps, db } = worldsRig({ id: USER_B });
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'create_property', orgId: ORG_A, label: 'Trojan' },
    }), deps);
    expect(res.status).toBe(404);
    expect(db.rows('wv_property').some((p) => p['label'] === 'Trojan')).toBe(false);
  });

  it('org B cannot create a world version under org A property', async () => {
    const { deps, db } = worldsRig({ id: USER_B });
    const before = db.rows('wv_world').length;
    const res = await handleWorlds(req({
      headers: AUTH, body: { action: 'create_world', propertyId: PROP_A },
    }), deps);
    expect(res.status).toBe(404);
    expect(db.rows('wv_world')).toHaveLength(before);
  });

  it('a correction carrying another org room id changes nothing', async () => {
    // Org B, acting on its OWN world, names a room belonging to org A.
    const { deps, db } = worldsRig({ id: USER_B });
    const res = await handleWorlds(req({
      headers: AUTH,
      body: {
        action: 'approve_corrections', worldId: WORLD_B,
        corrections: [{
          target: 'room', id: '77777777-7777-4777-8777-777777777771',
          field: 'name', value: 'Pwned',
        }],
      },
    }), deps);
    expect((res.body as any).applied).toBe(0);
    expect(db.rows('wv_room').find((r) => r['world_id'] === WORLD_A)!['name']).toBe('Living room');
  });

  it('the AI cannot be aimed at another org property', async () => {
    const { deps, seen } = askRig();
    // Every plausible way of smuggling a world id into the request.
    const attempts = [
      { worldId: WORLD_B }, { world_id: WORLD_B }, { propertyId: PROP_B },
      { orgId: ORG_B }, { view: { worldId: WORLD_B } },
    ];
    for (const extra of attempts) {
      await handleAsk(req({
        body: { sessionId: SESSION_A, viewerKey: 'key-a', question: 'describe this', ...extra },
      }), deps);
    }
    expect(seen).toHaveLength(attempts.length);
    for (const s of seen) expect(s.worldId).toBe(WORLD_A);
  });

  it('org B cannot export org A world', async () => {
    const db = twoTenantDb();
    const base = makeDeps({ db, user: { id: USER_B } });
    const deps: ExportDeps = {
      ...base.deps,
      buildWorldDocument: async () => { throw new Error('must not be called'); },
    };
    const res = await handleExport(req({ headers: AUTH, body: { worldId: WORLD_A } }), deps);
    expect(res.status).toBe(404);
    expect(base.logs.some((l) => l.event === 'wv_export_cross_tenant_denied')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wv-export and the bundle
// ---------------------------------------------------------------------------

describe('zip writer', () => {
  it('computes the standard CRC-32', () => {
    // The canonical check value for "123456789".
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF4_3926);
  });

  it('writes an archive with the right signatures and entry count', () => {
    const zip = buildZip([
      { path: 'a.txt', bytes: new TextEncoder().encode('hello') },
      { path: 'dir/b.json', bytes: new TextEncoder().encode('{"x":1}') },
    ], new Date('2026-09-19T12:00:00.000Z'));
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x0403_4B50);              // local header
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x0605_4B50); // end of central dir
    expect(dv.getUint16(zip.length - 22 + 8, true)).toBe(2);       // entries on this disk
    expect(dv.getUint16(zip.length - 22 + 10, true)).toBe(2);      // entries total
    // Stored, not deflated, so the payload appears verbatim.
    expect(new TextDecoder().decode(zip)).toContain('hello');
  });

  it('refuses paths that could escape the extraction directory', () => {
    for (const path of ['../escape.txt', 'a/../../b.txt', './x', '']) {
      expect(() => buildZip([{ path, bytes: new Uint8Array(1) }]), path).toThrow();
    }
    // A leading slash is stripped, which is what every zip tool does, rather
    // than rejected -- the danger is traversal, not an absolute-looking name.
    expect(() => buildZip([{ path: '/abs.txt', bytes: new Uint8Array(1) }])).not.toThrow();
    expect(() => buildZip([
      { path: 'a.txt', bytes: new Uint8Array(1) },
      { path: 'a.txt', bytes: new Uint8Array(1) },
    ])).toThrow(/duplicate/);
  });
});

describe('permanence bundle', () => {
  const generatedAt = new Date('2026-09-19T12:00:00.000Z');

  async function bundle() {
    return buildBundleEntries({
      world: {
        id: FLAT.id, version: FLAT.version, label: FLAT.label,
        publishedAt: FLAT.publishedAt ?? null,
        document: JSON.parse(JSON.stringify(FLAT)) as Record<string, unknown>,
      },
      assets: [{
        path: 'proxy_mesh.glb', role: 'proxy_mesh', format: 'glb',
        bytes: new TextEncoder().encode('glTF-ish bytes'),
      }],
      omittedAssets: [{ role: 'splat', bytes: 18_220_100, reason: 'exceeded the inline export budget' }],
      generatedAt,
      exporterVersion: '1.0.0',
    });
  }

  it('contains everything a customer needs to be independent of us', async () => {
    const entries = await bundle();
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toContain('world.json');
    expect(paths).toContain('viewer.html');
    expect(paths).toContain('floorplan.svg');
    expect(paths).toContain('README.txt');
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('CHECKSUMS.sha256');
    expect(paths).toContain('assets/proxy_mesh.glb');
  });

  it('the viewer calls nothing on the network', async () => {
    const entries = await bundle();
    const html = new TextDecoder().decode(entries.find((e) => e.path === 'viewer.html')!.bytes);
    // No remote origins, no fetch, no XHR, no service worker, no beacon.
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|navigator\.sendBeacon|importScripts/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/@import|<link[^>]+stylesheet/);
  });

  it('the viewer works from file:// because the data is embedded, not fetched', async () => {
    const entries = await bundle();
    const html = new TextDecoder().decode(entries.find((e) => e.path === 'viewer.html')!.bytes);
    expect(html).toContain('<script type="application/json" id="world">');
    expect(html).toContain('Kitchen/diner');
    // Every room and every entity travels with the page.
    for (const r of FLAT.rooms) expect(html).toContain(r.name ?? r.kind);
    expect(html).toContain('e_sofa'.replace('e_', '') === 'sofa' ? 'sofa' : 'sofa');
  });

  it('the viewer shows provenance and the unobserved regions', async () => {
    const entries = await bundle();
    const html = new TextDecoder().decode(entries.find((e) => e.path === 'viewer.html')!.bytes);
    expect(html).toContain('Not observed');
    expect(html).toContain('corner occluded by the wardrobe');
    expect(html).toContain('generated');
  });

  it('world.json is the complete document, in an open format', async () => {
    const entries = await bundle();
    const doc = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === 'world.json')!.bytes));
    expect(doc.formatVersion).toBe(1);
    expect(doc.rooms).toHaveLength(FLAT.rooms.length);
    expect(doc.entities).toHaveLength(FLAT.entities.length);
    expect(doc.regions).toHaveLength(FLAT.regions.length);
    expect(doc.measurementPolicy.areaStandard).toBe('RICS-COMP-GIA');
    // Tolerances survive the round trip; a number without one is a liability.
    expect(doc.rooms[0].area.tolerance).toBeGreaterThan(0);
  });

  it('the floorplan is true to scale with a scale bar', async () => {
    const svg = renderFloorplanSvg(JSON.parse(JSON.stringify(FLAT)));
    expect(svg).toContain('<svg');
    expect(svg).toContain('1 m');
    expect(svg).toContain('Kitchen/diner');
    // 100 units per metre: the flat is 10.5 m wide plus padding.
    const m = /width="(\d+)"/.exec(svg);
    expect(Number(m![1])).toBeGreaterThan(1000);
  });

  it('every file is checksummed, and the checksums verify', async () => {
    const entries = await bundle();
    const manifest = JSON.parse(new TextDecoder().decode(
      entries.find((e) => e.path === 'manifest.json')!.bytes,
    ));
    const sums = new TextDecoder().decode(
      entries.find((e) => e.path === 'CHECKSUMS.sha256')!.bytes,
    );
    expect(manifest.files.length).toBe(entries.length - 2);
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sums).toContain(`${f.sha256}  ${f.path}`);
    }
    expect(manifest.omittedAssets).toHaveLength(1);
  });

  it('the README states what is missing rather than hiding it', async () => {
    const entries = await bundle();
    const readme = new TextDecoder().decode(entries.find((e) => e.path === 'README.txt')!.bytes);
    expect(readme).toContain('ASSETS NOT INCLUDED');
    expect(readme).toContain('17.4 MB');
    expect(readme).toContain('sha256sum -c CHECKSUMS.sha256');
    expect(readme).toMatch(/does not call\s+our servers/);
  });

  it('packages into a zip that a stock unzip can read', async () => {
    const entries = await bundle();
    const zip = buildZip(entries, generatedAt);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x0403_4B50);
    expect(dv.getUint16(zip.length - 22 + 10, true)).toBe(entries.length);
  });
});

describe('wv-export handler', () => {
  function exportRig(user: { id: string } | null) {
    const db = twoTenantDb();
    const base = makeDeps({ db, user });
    base.storage.put('wv-assets', 'alpha/world-a/splat.spz', new TextEncoder().encode('splat bytes'));
    const deps: ExportDeps = {
      ...base.deps,
      buildWorldDocument: async () => JSON.parse(JSON.stringify(FLAT)) as Record<string, unknown>,
    };
    return { db, deps, storage: base.storage, logs: base.logs };
  }

  it('builds a bundle, stores it and records it', async () => {
    const { deps, db, storage } = exportRig({ id: USER_A });
    const res = await handleExport(req({ headers: AUTH, body: { worldId: WORLD_A } }), deps);
    expect(res.status).toBe(200);
    const out = res.body as any;
    expect(out.queued).toBe(false);
    expect(out.bytes).toBeGreaterThan(1000);
    expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(out.files.map((f: any) => f.path)).toContain('viewer.html');
    expect(db.rows('wv_export')).toHaveLength(1);
    expect([...storage.objects.keys()].some((k) => k.startsWith('wv-exports/'))).toBe(true);
  });

  it('delivers a bundle and queues nothing when an asset is too large to inline', async () => {
    // This used to assert the opposite: a 202 and a wv_job with stage
    // 'export'. That job was unclaimable -- `export` is not one of the
    // thirteen pipeline stages, so wv-jobs refused it and no worker ever ran
    // it -- while the customer was told their bundle was "being packaged in
    // the background". The oversize path now returns the bundle immediately,
    // with the assets that did not fit carried as signed links, and the test
    // guards the thing that actually matters: no job is queued at all.
    const { deps, db } = exportRig({ id: USER_A });
    db.rows('wv_asset')[0]!['bytes'] = 900 * 1024 * 1024;
    const res = await handleExport(req({ headers: AUTH, body: { worldId: WORLD_A } }), deps);
    expect(res.status).toBe(200);
    expect((res.body as any).queued).toBe(false);
    expect(db.rows('wv_job')).toHaveLength(0);

    const omitted = (res.body as any).omittedAssets;
    expect(omitted).toHaveLength(1);
    expect(omitted[0].role).toBe('splat');
    // A link the customer can actually use, with its expiry stated beside it.
    expect(omitted[0].url).toContain('splat.spz');
    expect(omitted[0].expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records an unreadable asset as omitted rather than failing silently', async () => {
    const { deps, storage } = exportRig({ id: USER_A });
    storage.objects.clear();
    const res = await handleExport(req({ headers: AUTH, body: { worldId: WORLD_A } }), deps);
    expect(res.status).toBe(200);
    expect((res.body as any).omittedAssets).toHaveLength(1);
    expect((res.body as any).omittedAssets[0].reason).toMatch(/storage/);
  });
});
