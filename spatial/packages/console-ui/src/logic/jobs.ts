/**
 * The build, as an operator needs to see it.
 *
 * `wv-worlds` queues thirteen jobs — the thirteen modules in
 * spatial/pipeline/worldengine/stages/, named identically in
 * `BUILD_STAGE_DEPS` (wv-worlds/handler.ts), in `STAGES` (wv-jobs/handler.ts)
 * and in `STAGE_DEPS` (worldengine/runner.py). There is one vocabulary and
 * this file holds the console's copy of it. An earlier draft carried a second,
 * retired set of names — `blur_reject`, `reconstruct`, `segment`, `nav`,
 * `measure`, `floorplan` — which no worker has ever been able to claim; rows
 * that still carry one fall through to the humanising fallback below and are
 * shown under their own name, because a stage the console cannot name is still
 * a stage that ran.
 *
 * The pipeline is a DAG, not a chain. `semantics` waits for `splat` AND
 * `layout`; `quality` waits for five separate stages. `wv_claim_job` will not
 * hand out a job until every id in its `depends_on` has SUCCEEDED, which has a
 * consequence the console must show honestly — when a stage fails, the stages
 * that transitively depend on it are not "queued", they are **blocked**, and
 * they will sit there forever. A progress bar that keeps them looking pending
 * is a lie that costs an operator an hour.
 *
 * Two things this module gets from the API rather than guessing:
 *
 *  1. `depends_on`. `get_world` projects it, so the edges drawn here are the
 *     same edges the queue schedules on. Nothing is inferred from queue order:
 *     queue order is a topological order, so inference happens to agree with
 *     the edges for today's pipeline, and would quietly stop agreeing the
 *     first time two stages could run in parallel. Marking a stage doomed when
 *     it is in fact claimable is the same class of lie as the progress bar.
 *
 *  2. `started_at` and `finished_at`. `get_world` projects both, so each stage
 *     reports what it actually cost in wall-clock time next to what it cost in
 *     GPU seconds. The two are different numbers and an operator chasing a
 *     slow build needs the first one.
 */

export type JobStatus = 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The console adds one state the database does not have. */
export type StageState = JobStatus | 'blocked';

/** A `wv_job` row as `wv-worlds` `get_world` projects it. */
export interface JobRow {
  readonly id: string;
  readonly stage: string;
  readonly status: string;
  readonly attempt?: number | null;
  readonly error?: string | null;
  readonly gpu_seconds?: number | string | null;
  readonly cost_usd?: number | string | null;
  readonly queued_at?: string | null;
  /**
   * Job ids this stage waits for. `uuid[] not null default '{}'` in the
   * database, so an empty array is a real answer — `ingest` waits for nothing.
   * Optional here only because a caller may hand this module rows from
   * somewhere other than `get_world`; see `BuildView.edgesMissing`.
   */
  readonly depends_on?: readonly string[] | null;
  /** Set by `wv_claim_job` on the first lease; see `StageView.elapsedS`. */
  readonly started_at?: string | null;
  readonly finished_at?: string | null;
}

export interface StageView {
  readonly id: string;
  readonly stage: string;
  readonly label: string;
  readonly description: string;
  readonly index: number;
  readonly state: StageState;
  readonly attempt: number;
  readonly error: string | null;
  readonly gpuSeconds: number | null;
  readonly costUsd: number | null;
  readonly queuedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /**
   * Wall-clock seconds from the moment this stage first started to the moment
   * it finished, or null while either timestamp is missing.
   *
   * "First started" is meant literally. `wv_claim_job` sets
   * `started_at = coalesce(started_at, now())`, so a stage the reaper requeued
   * keeps the start of the attempt that died, and this figure then spans the
   * abandoned attempt and the wait for a new pod as well as the work. That is
   * why `attempt` is carried beside it: forty minutes of `splat` on attempt 1
   * and forty minutes of `splat` on attempt 3 are not the same number.
   * `resume_build` clears both columns, so after a resume this is the work
   * alone.
   */
  readonly elapsedS: number | null;
  /** Ids of the stages this one waits for, straight from `depends_on`. */
  readonly dependsOn: readonly string[];
  /** Id of the failed or cancelled stage this one can never get past. */
  readonly blockedBy: string | null;
}

export type BuildState =
  | 'not_started'
  | 'queued'
  | 'running'
  | 'failed'
  | 'succeeded'
  | 'cancelled';

export interface FailureView {
  readonly stage: string;
  readonly label: string;
  readonly error: string;
  readonly attempt: number;
  readonly attemptsRemaining: number;
  /** Stages that already succeeded and will NOT be recomputed on resume. */
  readonly preserved: readonly string[];
  /** The failed stage and everything that waits on it, in display order. */
  readonly resumes: readonly string[];
  /** False once the attempt ceiling is reached; the queue will not retry. */
  readonly canResume: boolean;
  readonly resumeBlockedReason: string | null;
}

export interface BuildView {
  readonly stages: readonly StageView[];
  readonly state: BuildState;
  readonly completed: number;
  readonly total: number;
  /** 0..1. Counts only stages that actually finished. */
  readonly progress: number;
  readonly gpuSeconds: number;
  readonly costUsd: number;
  readonly failure: FailureView | null;
  /** The stage currently holding a lease, when there is one. */
  readonly activeStage: string | null;
  /** When the build was asked for: the earliest `queued_at`. */
  readonly queuedAt: string | null;
  /** When work actually began: the earliest `started_at`, null until it does. */
  readonly startedAt: string | null;
  /** The latest `finished_at`, and only once nothing is still in flight. */
  readonly finishedAt: string | null;
  /** Wall-clock seconds from `startedAt` to `finishedAt`, when both are known. */
  readonly elapsedS: number | null;
  /**
   * True when not one row carried `depends_on`, so the DAG is unknown.
   *
   * This is a refusal, not a fallback. Reconstructing the chain from queue
   * order would draw a graph that looks authoritative and is a guess, and the
   * guess decides which stages are shown as permanently blocked. The screen
   * says the edges are missing instead.
   */
  readonly edgesMissing: boolean;
}

/**
 * `wv_claim_job`'s default `p_max_attempts`, and the ceiling `wv_reap_expired_jobs`
 * uses when it decides an abandoned job is permanently failed.
 */
export const MAX_ATTEMPTS = 3;

interface StageMeta { readonly label: string; readonly description: string }

/**
 * The thirteen stages, in `BUILD_PIPELINE` order. One line each, describing
 * what the stage does to the world rather than which library it uses — an
 * operator reading this screen is deciding whether to wait or to intervene.
 */
export const STAGE_CATALOGUE: Readonly<Record<string, StageMeta>> = {
  ingest: { label: 'Ingest', description: 'Probe the upload, normalise it, and refuse a capture that cannot produce a world.' },
  frames: { label: 'Select frames', description: 'Decode the capture, score every frame for blur and motion, and keep the ones worth reconstructing from.' },
  redact: { label: 'Redact', description: 'Find and destroy faces, documents and screens in the frames, before any other stage sees a pixel.' },
  pose: { label: 'Solve poses', description: 'Work out where each camera was, and the dense point cloud with it. Everything downstream depends on this.' },
  scale: { label: 'Fix metric scale', description: 'Agree on metres using two independent estimators, and record how far apart they were.' },
  splat: { label: 'Reconstruct', description: 'Train the Gaussian splat representation of the property.' },
  mesh: { label: 'Proxy mesh', description: 'Fuse the splat into the surface geometry the viewer walks against and occludes with.' },
  layout: { label: 'Segment rooms', description: 'Cut the property into rooms, floors and openings, as true-to-scale polygons.' },
  semantics: { label: 'Identify contents', description: 'Label rooms and objects, one label per object across every frame.' },
  graph: { label: 'Scene graph', description: 'Compute what is inside, next to, above and connected to what, and the walkable graph, from geometry alone.' },
  regions: { label: 'Mark unobserved space', description: 'Record every volume no camera actually saw, so the viewer can mark it rather than imply it.' },
  package: { label: 'Package', description: 'Encode and chunk the assets a viewer downloads, room by room.' },
  quality: { label: 'Quality gate', description: 'Score the world against every threshold and return pass, review or fail.' },
};

export function stageMeta(stage: string): StageMeta {
  const known = STAGE_CATALOGUE[stage];
  if (known) return known;
  // A name this console has never heard of is shown, not hidden. Old rows
  // carry retired stage names, and a future stage will arrive here before this
  // catalogue is updated; either way the operator sees that something ran.
  const label = stage.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { label, description: 'A pipeline stage this console does not have a description for.' };
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Seconds between two ISO timestamps, or null when either is unusable. */
function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // A negative span means the clocks disagree, and a negative duration on a
  // screen is worse than no duration at all.
  return b < a ? null : (b - a) / 1000;
}

const TERMINAL_OK = 'succeeded';

/** Statuses that mean a worker may still be writing to this world. */
const LIVE: ReadonlySet<string> = new Set(['queued', 'leased', 'running']);

/**
 * Build the view.
 *
 * Rows are displayed in `queued_at` order, which is the topological order
 * `requestBuild` inserts in, so the list reads top to bottom. The *edges*,
 * though, come only from `depends_on`.
 */
export function buildView(rows: readonly JobRow[]): BuildView {
  if (rows.length === 0) {
    return {
      stages: [], state: 'not_started', completed: 0, total: 0, progress: 0,
      gpuSeconds: 0, costUsd: 0, failure: null, activeStage: null,
      queuedAt: null, startedAt: null, finishedAt: null, elapsedS: null,
      edgesMissing: false,
    };
  }

  const ordered = [...rows].sort(byQueueOrder);
  const edgesMissing = ordered.length > 1
    && ordered.every((r) => r.depends_on === undefined || r.depends_on === null);

  const statusById = new Map<string, string>();
  const dependsById = new Map<string, readonly string[]>();
  for (const r of ordered) {
    statusById.set(r.id, String(r.status));
    dependsById.set(r.id, r.depends_on ?? []);
  }

  const stages: StageView[] = ordered.map((row, index) => {
    const meta = stageMeta(row.stage);
    const dependsOn = [...(row.depends_on ?? [])];
    const status = String(row.status) as JobStatus;
    const blockedBy = status === 'queued' ? firstUnsatisfied(dependsOn, statusById, dependsById) : null;

    return {
      id: row.id,
      stage: row.stage,
      label: meta.label,
      description: meta.description,
      index,
      state: blockedBy ? 'blocked' : status,
      attempt: Math.max(0, Math.trunc(Number(row.attempt ?? 0)) || 0),
      error: typeof row.error === 'string' && row.error.length > 0 ? row.error : null,
      gpuSeconds: num(row.gpu_seconds),
      costUsd: num(row.cost_usd),
      queuedAt: row.queued_at ?? null,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
      elapsedS: secondsBetween(row.started_at, row.finished_at),
      dependsOn,
      blockedBy,
    };
  });

  const completed = stages.filter((s) => s.state === TERMINAL_OK).length;
  const gpuSeconds = stages.reduce((sum, s) => sum + (s.gpuSeconds ?? 0), 0);
  const costUsd = stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const active = stages.find((s) => s.state === 'running' || s.state === 'leased') ?? null;

  const failedStage = stages.find((s) => s.state === 'failed') ?? null;
  const cancelled = stages.some((s) => s.state === 'cancelled');

  let state: BuildState;
  if (failedStage) state = 'failed';
  else if (cancelled && completed < stages.length) state = 'cancelled';
  else if (completed === stages.length) state = 'succeeded';
  else if (active) state = 'running';
  else state = 'queued';

  const queuedAt = earliest(stages.map((s) => s.queuedAt));
  const startedAt = earliest(stages.map((s) => s.startedAt));
  // A build is only finished when nothing can still write to it. Reporting the
  // latest finish while a stage is queued would time a build that is still
  // running, and the number would shrink as later stages reported.
  const inFlight = ordered.some((r) => LIVE.has(String(r.status)));
  const finishedAt = inFlight ? null : latest(stages.map((s) => s.finishedAt));

  return {
    stages,
    state,
    completed,
    total: stages.length,
    progress: stages.length === 0 ? 0 : completed / stages.length,
    gpuSeconds,
    costUsd,
    failure: failedStage ? describeFailure(failedStage, stages) : null,
    activeStage: active ? active.stage : null,
    queuedAt,
    startedAt,
    finishedAt,
    elapsedS: secondsBetween(startedAt, finishedAt),
    edgesMissing,
  };
}

function byQueueOrder(a: JobRow, b: JobRow): number {
  const ta = a.queued_at ? Date.parse(a.queued_at) : NaN;
  const tb = b.queued_at ? Date.parse(b.queued_at) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return 0; // stable: keep the order the API returned
}

function earliest(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = v;
  }
  return best;
}

function latest(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = v;
  }
  return best;
}

/**
 * The first dependency, at any depth, that has *failed or been cancelled*. A
 * dependency that is merely still running means this stage is waiting its
 * turn, which is not the same as blocked.
 *
 * The walk follows `depends_on` and nothing else, so a stage in a parallel
 * branch that happens to sit after the failure in the list is not condemned
 * with it.
 */
function firstUnsatisfied(
  dependsOn: readonly string[],
  statusById: ReadonlyMap<string, string>,
  dependsById: ReadonlyMap<string, readonly string[]>,
): string | null {
  const seen = new Set<string>();
  const queue = [...dependsOn];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const status = statusById.get(id);
    if (status === 'failed' || status === 'cancelled') return id;
    // Walk the chain: a stage two steps after a failure is blocked as surely
    // as the one immediately after it.
    queue.push(...(dependsById.get(id) ?? []));
  }
  return null;
}

/**
 * Every stage that transitively waits on `rootId`, plus `rootId` itself, in
 * display order. These are exactly the stages `wv_claim_job` will refuse to
 * hand out until the root succeeds.
 */
function withDependents(rootId: string, stages: readonly StageView[]): StageView[] {
  const doomed = new Set<string>([rootId]);
  // One pass per stage is enough because `stages` is in topological order, but
  // the loop repeats until nothing changes so the result does not depend on
  // that ordering holding. Thirteen stages; the cost is nothing.
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of stages) {
      if (doomed.has(s.id)) continue;
      if (s.dependsOn.some((id) => doomed.has(id))) {
        doomed.add(s.id);
        grew = true;
      }
    }
  }
  return stages.filter((s) => doomed.has(s.id));
}

function describeFailure(failed: StageView, stages: readonly StageView[]): FailureView {
  // Every stage that succeeded is kept, wherever it sits in the list: a
  // parallel branch that finished before the failure is finished work, and
  // resume does not recompute it.
  const preserved = stages.filter((s) => s.state === TERMINAL_OK).map((s) => s.stage);
  const resumes = withDependents(failed.id, stages).map((s) => s.stage);
  const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - failed.attempt);
  const canResume = attemptsRemaining > 0;

  return {
    stage: failed.stage,
    label: failed.label,
    // The actual error, not a paraphrase of it. An operator forwarding this to
    // support needs the string the worker wrote.
    error: failed.error ?? 'The worker failed without recording an error.',
    attempt: failed.attempt,
    attemptsRemaining,
    preserved,
    resumes,
    canResume,
    resumeBlockedReason: canResume
      ? null
      : `This stage has used all ${MAX_ATTEMPTS} attempts. The queue will not hand it out again; the capture needs looking at.`,
  };
}

/**
 * What a resume would actually do, phrased for the confirmation dialog.
 *
 * Resume is not restart: the stages that already succeeded keep their outputs
 * and their GPU cost, and only the failed stage and what waits on it is
 * recomputed. Saying so in numbers is what stops an operator reaching for
 * "start a new build" and paying for the whole chain twice.
 */
export interface ResumePlan {
  readonly resumesFrom: string;
  readonly preservedStages: readonly string[];
  readonly preservedGpuSeconds: number;
  readonly rerunStages: readonly string[];
  readonly summary: string;
}

export function planResume(view: BuildView): ResumePlan | null {
  if (!view.failure) return null;
  const failed = view.stages.find((s) => s.stage === view.failure!.stage);
  if (!failed) return null;

  const preserved = view.stages.filter((s) => s.state === TERMINAL_OK);
  const rerun = withDependents(failed.id, view.stages);
  const preservedGpu = preserved.reduce((sum, s) => sum + (s.gpuSeconds ?? 0), 0);
  const waiting = rerun.length - 1;

  return {
    resumesFrom: view.failure.stage,
    preservedStages: preserved.map((s) => s.stage),
    preservedGpuSeconds: preservedGpu,
    rerunStages: rerun.map((s) => s.stage),
    summary: `${preserved.length} of ${view.stages.length} stages already succeeded and are kept. `
      + `The build restarts at “${view.failure.label}”`
      + (waiting === 0
        ? ', which is the last stage left.'
        : ` and runs it and the ${waiting} ${waiting === 1 ? 'stage' : 'stages'} that wait on it.`),
  };
}

/** What a full restart costs, for the comparison the dialog has to make. */
export function planRestart(view: BuildView): { stages: number; discardedGpuSeconds: number } {
  return {
    stages: view.stages.length,
    discardedGpuSeconds: view.stages
      .filter((s) => s.state === TERMINAL_OK)
      .reduce((sum, s) => sum + (s.gpuSeconds ?? 0), 0),
  };
}
