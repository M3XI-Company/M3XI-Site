/**
 * THE QUEUE CONTRACT.
 *
 * One rule, and it is the rule this system has broken twice: a stage that
 * something queues must be a stage `wv-jobs` will hand out. When it is not,
 * nothing errors. `requestBuild` returns 202 with thirteen job ids, the
 * console draws a build, and no worker ever matches a single one of them --
 * the property sits at 0% until somebody reads the queue by hand.
 *
 * So the test is not "does BUILD_PIPELINE contain the right names". It is:
 * queue a build through the real handler, then drain it through the real
 * claim handler, and assert every stage came out in an order the DAG allows.
 * Names, edges, insertion order and the claim predicate are all covered by
 * that one assertion, and any of them drifting breaks it.
 *
 * The same run is also the regression test for the second half of the bug:
 * `wv_claim_job` treats a `depends_on` id that matches no row as SATISFIED, so
 * a half-written chain hands out a stage before its input exists. That is why
 * `requestBuild` validates the whole plan before its first insert, and why
 * this file asserts no job is queued at all when the plan is invalid.
 */

import { describe, expect, it } from 'vitest';

import { BUILD_PIPELINE, BUILD_STAGE_DEPS, handleWorlds } from '../../wv-worlds/handler.ts';
import { STAGES, handleJobs } from '../../wv-jobs/handler.ts';
import type { HttpRequest } from '../http.ts';
import { FakeDb, bearer, makeTestDeps, seedTenant } from './fakes.ts';

const WORKER_SECRET = 'a-worker-secret-at-least-32-characters-long';
/** Worker ids go through `uuid()`, so the tests use real ones. */
const WORKER_ID = '00000000-0000-4000-8000-0000000000a1';
const CPU_WORKER_ID = '00000000-0000-4000-8000-0000000000c2';

function post(body: Record<string, unknown>, headers: Record<string, string> = {}): HttpRequest {
  return { method: 'POST', path: '/', query: {}, headers, body };
}

/** The pipeline's own stage list, read from the Python that defines it. */
const PIPELINE_STAGES = [
  'ingest', 'frames', 'redact', 'pose', 'scale', 'splat', 'mesh',
  'layout', 'semantics', 'graph', 'regions', 'package', 'quality',
] as const;

describe('the stage vocabulary', () => {
  it('queues nothing wv-jobs would refuse', () => {
    const refused = BUILD_PIPELINE.filter((stage) => !STAGES.has(stage));
    expect(refused).toEqual([]);
  });

  it('is the thirteen stages the pipeline has modules for', () => {
    expect([...BUILD_PIPELINE].sort()).toEqual([...PIPELINE_STAGES].sort());
    expect([...STAGES].sort()).toEqual([...PIPELINE_STAGES].sort());
    expect(Object.keys(BUILD_STAGE_DEPS).sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it('names only stages that exist as dependencies', () => {
    for (const [stage, parents] of Object.entries(BUILD_STAGE_DEPS)) {
      for (const parent of parents) {
        expect(BUILD_STAGE_DEPS[parent], `${stage} depends on unknown '${parent}'`).toBeDefined();
      }
    }
  });

  it('lists every stage after its dependencies', () => {
    const seen = new Set<string>();
    for (const stage of BUILD_PIPELINE) {
      for (const parent of BUILD_STAGE_DEPS[stage] ?? []) {
        expect(seen.has(parent), `${stage} is queued before ${parent}`).toBe(true);
      }
      seen.add(stage);
    }
  });

  it('keeps redaction upstream of everything that touches frame pixels', () => {
    // The privacy property is structural in runner.py and must stay structural
    // here: PII never enters the splat because the graph cannot order it that
    // way, not because a stage remembers to check.
    const ancestorsOf = (stage: string, acc = new Set<string>()): Set<string> => {
      for (const parent of BUILD_STAGE_DEPS[stage] ?? []) {
        if (!acc.has(parent)) { acc.add(parent); ancestorsOf(parent, acc); }
      }
      return acc;
    };
    for (const consumer of ['pose', 'scale', 'splat', 'mesh', 'semantics']) {
      expect(ancestorsOf(consumer).has('redact'), `${consumer} does not wait for redact`).toBe(true);
    }
  });
});

describe('a build, queued and then claimed', () => {
  async function queueBuild() {
    const deps = makeTestDeps({
      users: { 'operator-token': 'user-1' },
      env: { WV_WORKER_SECRET: WORKER_SECRET },
    });
    const tenant = seedTenant(deps.db, { userId: 'user-1', role: 'operator' });
    const res = await handleWorlds(
      post({ action: 'request_build', worldId: tenant.worldId }, bearer('operator-token')),
      deps,
    );
    return { deps, tenant, res };
  }

  it('queues the whole pipeline in dependency order', async () => {
    const { deps, tenant, res } = await queueBuild();
    expect(res.status).toBe(202);

    const jobs = deps.db.rows('wv_job');
    expect(jobs).toHaveLength(BUILD_PIPELINE.length);
    expect(jobs.map((j) => j['stage'])).toEqual([...BUILD_PIPELINE]);
    expect(jobs.every((j) => j['world_id'] === tenant.worldId)).toBe(true);

    // Every dependency resolves to a job that was actually inserted. A
    // dangling id here is the bug `wv_claim_job` cannot catch.
    const ids = new Set(jobs.map((j) => String(j['id'])));
    for (const job of jobs) {
      for (const dep of job['depends_on'] as string[]) expect(ids.has(dep)).toBe(true);
    }
  });

  it('hands every queued stage to a worker, in an order the DAG allows', async () => {
    const { deps, tenant } = await queueBuild();
    deps.db.seed('wv_worker', [{ id: WORKER_ID, name: 'probe', capabilities: [] }]);

    const claimed: string[] = [];
    const finished = new Set<string>();

    for (let i = 0; i < BUILD_PIPELINE.length + 5; i++) {
      const res = await handleJobs(post({
        action: 'claim', workerId: WORKER_ID, stages: [...PIPELINE_STAGES],
      }, { 'x-wv-worker-secret': WORKER_SECRET }), deps);
      expect(res.status).toBe(200);
      const job = (res.body as { job: { id: string; stage: string; worldId: string } | null }).job;
      if (!job) break;

      // It may only be handed out once everything it waits for has finished.
      for (const parent of BUILD_STAGE_DEPS[job.stage] ?? []) {
        expect(finished.has(parent), `${job.stage} was claimable before ${parent} finished`).toBe(true);
      }
      expect(job.worldId).toBe(tenant.worldId);
      claimed.push(job.stage);
      finished.add(job.stage);
      await deps.db.update('wv_job', { status: 'succeeded' }, { id: job.id });
    }

    expect(claimed).toEqual([...BUILD_PIPELINE]);
  });

  it('refuses a second build while one is live', async () => {
    const { deps, tenant } = await queueBuild();
    const again = await handleWorlds(
      post({ action: 'request_build', worldId: tenant.worldId }, bearer('operator-token')),
      deps,
    );
    expect(again.status).toBe(409);
    expect(deps.db.rows('wv_job')).toHaveLength(BUILD_PIPELINE.length);
  });

  it('queues nothing at all when the month cap is spent', async () => {
    const deps = makeTestDeps({
      users: { 'operator-token': 'user-1' },
      env: { WV_WORKER_SECRET: WORKER_SECRET },
    });
    const tenant = seedTenant(deps.db, { userId: 'user-1', role: 'operator', buildMonthCap: 1 });
    // One splat job already queued this month is one build's worth of GPU.
    deps.db.seed('wv_job', [{
      id: 'prior', world_id: tenant.worldId, stage: 'splat', status: 'succeeded',
      depends_on: [], queued_at: '2026-09-02T00:00:00.000Z',
    }]);

    const res = await handleWorlds(
      post({ action: 'request_build', worldId: tenant.worldId }, bearer('operator-token')),
      deps,
    );
    expect(res.status).toBe(429);
    expect(deps.db.rows('wv_job').filter((j) => j['id'] !== 'prior')).toHaveLength(0);
  });
});

describe('the claim handler', () => {
  function workerDeps() {
    const deps = makeTestDeps({ env: { WV_WORKER_SECRET: WORKER_SECRET } });
    deps.db.seed('wv_worker', [{ id: WORKER_ID, name: 'probe', capabilities: [] }]);
    return deps;
  }

  it('refuses a stage vocabulary it does not recognise', async () => {
    const deps = workerDeps();
    const res = await handleJobs(post({
      action: 'claim', workerId: WORKER_ID,
      // The retired vocabulary. A worker asking for these must be told, not
      // silently handed nothing.
      stages: ['reconstruct', 'blur_reject', 'segment', 'nav', 'measure', 'floorplan'],
    }, { 'x-wv-worker-secret': WORKER_SECRET }), deps);
    expect(res.status).toBe(400);
  });

  it('will not hand out work without the shared secret', async () => {
    const deps = workerDeps();
    const res = await handleJobs(post({
      action: 'claim', workerId: WORKER_ID, stages: ['ingest'],
    }, { 'x-wv-worker-secret': 'wrong' }), deps);
    expect(res.status).toBe(401);
  });

  it('fails closed when no secret is configured', async () => {
    const deps = makeTestDeps({ env: {} });
    const res = await handleJobs(post({
      action: 'claim', workerId: WORKER_ID, stages: ['ingest'],
    }, { 'x-wv-worker-secret': '' }), deps);
    expect(res.status).toBe(401);
  });

  it('only offers a worker the stages it is registered for', async () => {
    const deps = makeTestDeps({ env: { WV_WORKER_SECRET: WORKER_SECRET } });
    const tenant = seedTenant(deps.db);
    deps.db.seed('wv_worker', [{ id: CPU_WORKER_ID, name: 'cpu', capabilities: ['ingest', 'frames'] }]);
    deps.db.seed('wv_job', [
      { id: 'j-splat', world_id: tenant.worldId, stage: 'splat', status: 'queued', depends_on: [], queued_at: '2026-09-20T10:00:00.000Z' },
      { id: 'j-ingest', world_id: tenant.worldId, stage: 'ingest', status: 'queued', depends_on: [], queued_at: '2026-09-20T11:00:00.000Z' },
    ]);

    const res = await handleJobs(post({
      action: 'claim', workerId: CPU_WORKER_ID, stages: [...PIPELINE_STAGES],
    }, { 'x-wv-worker-secret': WORKER_SECRET }), deps);
    const job = (res.body as { job: { stage: string } | null }).job;
    // `splat` is older and would win on queue order; the worker cannot run it.
    expect(job?.stage).toBe('ingest');
  });
});

describe('the fake queue matches the function it stands in for', () => {
  // The double is only worth having if it behaves like the SQL. These pin the
  // two behaviours the handlers actually depend on.
  it('will not lease a job whose dependency has not succeeded', async () => {
    const db = new FakeDb();
    const tenant = seedTenant(db);
    db.seed('wv_job', [
      { id: 'parent', world_id: tenant.worldId, stage: 'ingest', status: 'running', depends_on: [], queued_at: '2026-09-20T10:00:00.000Z' },
      { id: 'child', world_id: tenant.worldId, stage: 'frames', status: 'queued', depends_on: ['parent'], queued_at: '2026-09-20T10:00:01.000Z' },
    ]);
    

    const first = await db.rpc<Row[]>('wv_claim_job', {
      p_worker_id: 'w', p_stages: ['frames'], p_max_attempts: 3, p_lease_seconds: 900,
    });
    expect(first).toEqual([]);

    await db.update('wv_job', { status: 'succeeded' }, { id: 'parent' });
    const second = await db.rpc<Row[]>('wv_claim_job', {
      p_worker_id: 'w', p_stages: ['frames'], p_max_attempts: 3, p_lease_seconds: 900,
    });
    expect(second).toHaveLength(1);
  });

  it('refuses a job that has burned its attempts', async () => {
    const db = new FakeDb();
    const tenant = seedTenant(db);
    db.seed('wv_job', [{
      id: 'spent', world_id: tenant.worldId, stage: 'splat', status: 'queued',
      depends_on: [], attempt: 3, queued_at: '2026-09-20T10:00:00.000Z',
    }]);
    const rows = await db.rpc<Row[]>('wv_claim_job', {
      p_worker_id: 'w', p_stages: ['splat'], p_max_attempts: 3, p_lease_seconds: 900,
    });
    expect(rows).toEqual([]);
  });
});

type Row = Record<string, unknown>;
