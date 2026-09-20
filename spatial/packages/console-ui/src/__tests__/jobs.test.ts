/**
 * The build DAG, including the case the whole screen exists for: one stage
 * fails in the middle, and everything that waits on it is not "pending", it is
 * permanently blocked until somebody acts.
 *
 * The edges under test are the real ones. `BUILD_STAGE_DEPS` in
 * supabase/functions/wv-worlds/handler.ts is copied here deliberately rather
 * than imported: these tests are the console's statement of what it believes
 * the pipeline looks like, and if the server's graph changes underneath it the
 * disagreement should surface as a failing expectation, not be papered over by
 * a shared constant.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS, STAGE_CATALOGUE, buildView, planResume, planRestart, stageMeta, type JobRow,
} from '../logic/jobs.js';

/** `BUILD_STAGE_DEPS`, edge for edge. */
const STAGE_DEPS: Readonly<Record<string, readonly string[]>> = {
  ingest: [],
  frames: ['ingest'],
  redact: ['frames'],
  pose: ['redact'],
  scale: ['pose'],
  splat: ['scale'],
  mesh: ['splat'],
  layout: ['mesh'],
  semantics: ['splat', 'layout'],
  graph: ['layout', 'semantics'],
  regions: ['mesh', 'graph'],
  package: ['splat', 'mesh', 'layout', 'regions'],
  quality: ['package', 'graph', 'scale', 'redact', 'frames'],
};

/** `BUILD_PIPELINE`: the insertion order, which is a topological order. */
const PIPELINE = [
  'ingest', 'frames', 'redact', 'pose', 'scale', 'splat', 'mesh',
  'layout', 'semantics', 'graph', 'regions', 'package', 'quality',
];

const jobId = (stage: string): string => `j_${stage}`;

/** The whole pipeline, succeeded, with per-stage overrides by stage name. */
function pipeline(overrides: Readonly<Record<string, Partial<JobRow>>> = {}): JobRow[] {
  return PIPELINE.map((stage, i) => ({
    id: jobId(stage),
    stage,
    status: 'succeeded',
    attempt: 1,
    queued_at: new Date(Date.UTC(2026, 8, 1, 9, i)).toISOString(),
    depends_on: (STAGE_DEPS[stage] ?? []).map(jobId),
    ...(overrides[stage] ?? {}),
  } as JobRow));
}

/** A short straight chain, for the cases where thirteen stages are noise. */
function chain(states: readonly (string | [string, Partial<JobRow>])[]): JobRow[] {
  return states.map((entry, i) => {
    const [status, extra] = Array.isArray(entry) ? entry : [entry, {}];
    return {
      id: `j${i}`,
      stage: PIPELINE[i] ?? `stage_${i}`,
      status,
      attempt: status === 'queued' ? 0 : 1,
      queued_at: new Date(Date.UTC(2026, 8, 1, 9, i)).toISOString(),
      depends_on: i > 0 ? [`j${i - 1}`] : [],
      ...extra,
    } as JobRow;
  });
}

describe('stage catalogue', () => {
  it('names exactly the thirteen stages the pipeline has', () => {
    expect(Object.keys(STAGE_CATALOGUE).sort()).toEqual([...PIPELINE].sort());
  });

  it('describes every one of them in a sentence, not a word', () => {
    for (const stage of PIPELINE) {
      expect(stageMeta(stage).label, stage).not.toBe('');
      expect(stageMeta(stage).description.length, stage).toBeGreaterThan(20);
    }
  });

  it('humanises a stage it has never heard of rather than dropping it', () => {
    expect(stageMeta('new_magic_stage').label).toBe('New magic stage');
  });

  it('still shows a retired stage name under its own name', () => {
    // Rows queued before the vocabulary was unified are still in the database.
    // They are not stages any worker can claim, but they did run, and an
    // operator looking at an old build must see something legible.
    expect(stageMeta('reconstruct').label).toBe('Reconstruct');
    expect(stageMeta('blur_reject').label).toBe('Blur reject');
  });
});

describe('a clean run', () => {
  it('reports nothing started for an empty job list', () => {
    const v = buildView([]);
    expect(v.state).toBe('not_started');
    expect(v.total).toBe(0);
    expect(v.progress).toBe(0);
    expect(v.edgesMissing).toBe(false);
  });

  it('counts progress from completed stages only', () => {
    const v = buildView(chain(['succeeded', 'succeeded', 'running', 'queued', 'queued']));
    expect(v.state).toBe('running');
    expect(v.completed).toBe(2);
    expect(v.total).toBe(5);
    expect(v.progress).toBeCloseTo(0.4, 10);
    expect(v.activeStage).toBe('redact');
  });

  it('is succeeded only when every stage is', () => {
    expect(buildView(pipeline()).state).toBe('succeeded');
    expect(buildView(pipeline({ quality: { status: 'queued' } })).state).toBe('queued');
  });

  it('sums GPU seconds and cost across the stages that reported them', () => {
    const rows = chain([
      ['succeeded', { gpu_seconds: 12.5, cost_usd: 0.031 }],
      ['succeeded', { gpu_seconds: 480, cost_usd: 1.2 }],
      ['running', { gpu_seconds: null, cost_usd: null }],
    ]);
    const v = buildView(rows);
    expect(v.gpuSeconds).toBeCloseTo(492.5, 10);
    expect(v.costUsd).toBeCloseTo(1.231, 10);
  });

  it('reads numeric strings, which is how PostgREST returns numerics', () => {
    const v = buildView(chain([['succeeded', { gpu_seconds: '61.25', cost_usd: '0.40000' }]]));
    expect(v.gpuSeconds).toBeCloseTo(61.25, 10);
    expect(v.costUsd).toBeCloseTo(0.4, 10);
  });
});

describe('per-stage durations', () => {
  it('times a stage from started_at to finished_at', () => {
    const v = buildView(chain([['succeeded', {
      started_at: '2026-09-01T09:00:00.000Z', finished_at: '2026-09-01T09:34:30.000Z',
    }]]));
    expect(v.stages[0]?.elapsedS).toBe(2070);
  });

  it('has no duration for a stage that has started and not finished', () => {
    const v = buildView(chain([['running', { started_at: '2026-09-01T09:00:00.000Z', finished_at: null }]]));
    expect(v.stages[0]?.elapsedS).toBeNull();
  });

  it('has no duration when the columns are absent, rather than inventing zero', () => {
    const v = buildView(chain(['succeeded']));
    expect(v.stages[0]?.startedAt).toBeNull();
    expect(v.stages[0]?.elapsedS).toBeNull();
  });

  it('refuses a negative duration, which can only mean the clocks disagree', () => {
    const v = buildView(chain([['succeeded', {
      started_at: '2026-09-01T09:10:00.000Z', finished_at: '2026-09-01T09:00:00.000Z',
    }]]));
    expect(v.stages[0]?.elapsedS).toBeNull();
  });

  it('times the whole build from the first start to the last finish', () => {
    const v = buildView(pipeline({
      ingest: { started_at: '2026-09-01T09:00:10.000Z', finished_at: '2026-09-01T09:00:41.000Z' },
      quality: { started_at: '2026-09-01T10:00:00.000Z', finished_at: '2026-09-01T10:00:18.000Z' },
    }));
    expect(v.startedAt).toBe('2026-09-01T09:00:10.000Z');
    expect(v.finishedAt).toBe('2026-09-01T10:00:18.000Z');
    expect(v.elapsedS).toBe(3608);
  });

  it('does not report a finish while a stage can still write to the world', () => {
    // A build timed while it is still running produces a number that grows as
    // stages report, which reads as though the build got slower.
    const v = buildView(pipeline({
      ingest: { started_at: '2026-09-01T09:00:10.000Z', finished_at: '2026-09-01T09:00:41.000Z' },
      splat: { status: 'running', started_at: '2026-09-01T09:20:00.000Z', finished_at: null },
      mesh: { status: 'queued' }, layout: { status: 'queued' }, semantics: { status: 'queued' },
      graph: { status: 'queued' }, regions: { status: 'queued' }, package: { status: 'queued' },
      quality: { status: 'queued' },
    }));
    expect(v.startedAt).toBe('2026-09-01T09:00:10.000Z');
    expect(v.finishedAt).toBeNull();
    expect(v.elapsedS).toBeNull();
  });

  it('keeps queued_at separate from started_at: waiting is not working', () => {
    const v = buildView(pipeline({
      ingest: { started_at: '2026-09-01T09:40:00.000Z', finished_at: '2026-09-01T09:41:00.000Z' },
    }));
    expect(v.queuedAt).toBe('2026-09-01T09:00:00.000Z');
    expect(v.startedAt).toBe('2026-09-01T09:40:00.000Z');
  });
});

describe('dependency edges', () => {
  it('takes the edges from depends_on and never from queue order', () => {
    const rows: JobRow[] = [
      { id: 'a', stage: 'ingest', status: 'succeeded', queued_at: '2026-09-01T09:00:00Z', depends_on: [] },
      { id: 'b', stage: 'pose', status: 'failed', error: 'no', queued_at: '2026-09-01T09:01:00Z', depends_on: ['a'] },
      { id: 'c', stage: 'mesh', status: 'queued', queued_at: '2026-09-01T09:02:00Z', depends_on: ['b'] },
      // Queued AFTER the failure and depending only on the first stage, so
      // `wv_claim_job` will still hand it out. Inferring the chain from queue
      // order would condemn it.
      { id: 'd', stage: 'redact', status: 'queued', queued_at: '2026-09-01T09:03:00Z', depends_on: ['a'] },
    ];
    const v = buildView(rows);
    expect(v.stages.find((s) => s.id === 'c')?.state).toBe('blocked');
    expect(v.stages.find((s) => s.id === 'c')?.blockedBy).toBe('b');
    expect(v.stages.find((s) => s.id === 'd')?.state).toBe('queued');
    expect(v.stages.find((s) => s.id === 'd')?.blockedBy).toBeNull();
  });

  it('carries the dependency ids through to the view', () => {
    const v = buildView(pipeline());
    const semantics = v.stages.find((s) => s.stage === 'semantics');
    expect(semantics?.dependsOn).toEqual([jobId('splat'), jobId('layout')]);
    expect(v.stages.find((s) => s.stage === 'ingest')?.dependsOn).toEqual([]);
  });

  it('orders by queued_at even when the API returns rows shuffled', () => {
    const rows = chain(['succeeded', 'succeeded', 'running']);
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(buildView(shuffled).stages.map((s) => s.stage)).toEqual(['ingest', 'frames', 'redact']);
  });

  it('does not treat a still-running predecessor as a blocker', () => {
    const v = buildView(chain(['succeeded', 'running', 'queued']));
    expect(v.stages[2]?.state).toBe('queued');
    expect(v.stages[2]?.blockedBy).toBeNull();
  });

  it('blocks after a cancellation too', () => {
    const v = buildView(chain(['succeeded', 'cancelled', 'queued']));
    expect(v.stages[2]?.state).toBe('blocked');
  });

  it('says the edges are missing rather than guessing them', () => {
    // Every row without depends_on means the projection is gone. The view
    // refuses to mark anything blocked, because the only basis for doing so
    // would be the queue order it has just been told not to trust.
    const rows: JobRow[] = [
      { id: 'a', stage: 'ingest', status: 'succeeded', queued_at: '2026-09-01T09:00:00Z' },
      { id: 'b', stage: 'frames', status: 'failed', error: 'no', queued_at: '2026-09-01T09:01:00Z' },
      { id: 'c', stage: 'redact', status: 'queued', queued_at: '2026-09-01T09:02:00Z' },
    ];
    const v = buildView(rows);
    expect(v.edgesMissing).toBe(true);
    expect(v.stages[2]?.state).toBe('queued');
    expect(v.state).toBe('failed');
  });

  it('does not cry missing edges for a graph that genuinely has none', () => {
    const v = buildView(pipeline());
    expect(v.edgesMissing).toBe(false);
  });
});

describe('partial failure across the real graph', () => {
  const rows = pipeline({
    splat: { status: 'failed', attempt: 1, error: 'CUDA out of memory: tried to allocate 18.00 GiB' },
    mesh: { status: 'queued', attempt: 0 },
    layout: { status: 'queued', attempt: 0 },
    semantics: { status: 'queued', attempt: 0 },
    graph: { status: 'queued', attempt: 0 },
    regions: { status: 'queued', attempt: 0 },
    package: { status: 'queued', attempt: 0 },
    quality: { status: 'queued', attempt: 0 },
  });

  it('marks everything downstream of the failure blocked, not queued', () => {
    const v = buildView(rows);
    expect(v.state).toBe('failed');
    const byStage = new Map(v.stages.map((s) => [s.stage, s.state]));
    expect(byStage.get('scale')).toBe('succeeded');
    expect(byStage.get('splat')).toBe('failed');
    for (const stage of ['mesh', 'layout', 'semantics', 'graph', 'regions', 'package', 'quality']) {
      expect(byStage.get(stage), stage).toBe('blocked');
    }
  });

  it('blocks a stage that reaches the failure through several edges', () => {
    // quality does not depend on splat directly. It depends on package, which
    // depends on splat, and on graph, which reaches splat through layout.
    const v = buildView(rows);
    const quality = v.stages.find((s) => s.stage === 'quality');
    expect(quality?.state).toBe('blocked');
    expect(quality?.blockedBy).toBe(jobId('splat'));
  });

  it('keeps progress honest: five of thirteen, not "nearly there"', () => {
    const v = buildView(rows);
    expect(v.completed).toBe(5);
    expect(v.progress).toBeCloseTo(5 / 13, 10);
  });

  it('surfaces the worker’s actual error string, unparaphrased', () => {
    const v = buildView(rows);
    expect(v.failure?.stage).toBe('splat');
    expect(v.failure?.error).toBe('CUDA out of memory: tried to allocate 18.00 GiB');
    expect(v.failure?.label).toBe('Reconstruct');
  });

  it('invents an error rather than showing a blank when the worker recorded none', () => {
    const v = buildView(chain(['succeeded', ['failed', { attempt: 2, error: null }]]));
    expect(v.failure?.error).toMatch(/without recording an error/i);
  });

  it('names what is kept and what would be re-run, from the edges', () => {
    const v = buildView(rows);
    expect(v.failure?.preserved).toEqual(['ingest', 'frames', 'redact', 'pose', 'scale']);
    expect(v.failure?.resumes).toEqual([
      'splat', 'mesh', 'layout', 'semantics', 'graph', 'regions', 'package', 'quality',
    ]);
  });
});

describe('resume rather than restart', () => {
  const rows = pipeline({
    ingest: { gpu_seconds: 14 },
    frames: { gpu_seconds: 22 },
    redact: { gpu_seconds: 140 },
    pose: { gpu_seconds: 310 },
    scale: { gpu_seconds: 46 },
    splat: { status: 'failed', attempt: 1, error: 'boom', gpu_seconds: 900 },
    mesh: { status: 'queued', attempt: 0 },
    layout: { status: 'queued', attempt: 0 },
    semantics: { status: 'queued', attempt: 0 },
    graph: { status: 'queued', attempt: 0 },
    regions: { status: 'queued', attempt: 0 },
    package: { status: 'queued', attempt: 0 },
    quality: { status: 'queued', attempt: 0 },
  });

  it('preserves the stages that succeeded and restarts at the failure', () => {
    const plan = planResume(buildView(rows))!;
    expect(plan.resumesFrom).toBe('splat');
    expect(plan.preservedStages).toEqual(['ingest', 'frames', 'redact', 'pose', 'scale']);
    expect(plan.rerunStages[0]).toBe('splat');
    expect(plan.rerunStages).toHaveLength(8);
    // The failed stage's own GPU seconds are NOT preserved: it did not finish.
    expect(plan.preservedGpuSeconds).toBe(532);
  });

  it('states the comparison a restart has to lose', () => {
    const restart = planRestart(buildView(rows));
    expect(restart.stages).toBe(13);
    expect(restart.discardedGpuSeconds).toBe(532);
  });

  it('counts the waiting stages in the sentence the dialog shows', () => {
    const plan = planResume(buildView(rows))!;
    expect(plan.summary).toContain('5 of 13 stages');
    expect(plan.summary).toContain('7 stages that wait on it');
  });

  it('says so plainly when the failure is the last stage left', () => {
    const plan = planResume(buildView(pipeline({
      quality: { status: 'failed', attempt: 1, error: 'gate crashed' },
    })))!;
    expect(plan.rerunStages).toEqual(['quality']);
    expect(plan.summary).toMatch(/last stage left/i);
  });

  it('has no plan when nothing failed', () => {
    expect(planResume(buildView(chain(['succeeded', 'running'])))).toBeNull();
  });

  it('allows a resume while attempts remain', () => {
    const v = buildView(chain(['succeeded', ['failed', { attempt: 1, error: 'x' }]]));
    expect(v.failure?.canResume).toBe(true);
    expect(v.failure?.attemptsRemaining).toBe(MAX_ATTEMPTS - 1);
    expect(v.failure?.resumeBlockedReason).toBeNull();
  });

  it('refuses a resume once the attempt ceiling is reached, with the reason', () => {
    const v = buildView(chain(['succeeded', ['failed', { attempt: MAX_ATTEMPTS, error: 'x' }]]));
    expect(v.failure?.canResume).toBe(false);
    expect(v.failure?.attemptsRemaining).toBe(0);
    expect(v.failure?.resumeBlockedReason).toMatch(/all 3 attempts/i);
  });
});
