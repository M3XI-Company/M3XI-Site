/**
 * wv-jobs — the worker API.
 *
 * Workers are GPU boxes that may not be ours, so they authenticate with a
 * shared secret and NEVER with the anon key. The anon key is printed in every
 * page of the site; a pipeline that accepted it would let anyone lease and
 * fail every job in the queue, which is a denial of service on the one part of
 * the system that costs real money per run.
 *
 * Leases, not locks. `wv_claim_job` hands out a time-limited lease under
 * `for update skip locked`, so a worker that dies mid-reconstruction has its
 * job reclaimed when the lease expires rather than wedging the queue. The
 * heartbeat extends the lease; it does not renew a claim.
 *
 * This function is the ONLY thing a worker may talk to. A pod's entire secret
 * inventory is WV_WORKER_SECRET plus this URL: no service-role key, no storage
 * credential, no direct PostgREST. That matters because the pods are rented,
 * ephemeral and not ours, and a service-role key bypasses RLS across every
 * table in the project rather than just the wv_ ones. So everything a worker
 * needs to write goes through an action here, where the job's lease is checked
 * and the tenant key is read from the job row rather than taken on trust:
 *
 *   claim / heartbeat        the lease
 *   upload-urls              short-lived, single-path signed PUT URLs
 *   redactions               the privacy audit trail, batched
 *   ingest-world             the reconstructed world itself, in sections
 *   complete / fail          the job outcome, and with it the world's
 *
 * Note the rule that recurs in every action below: world_id is always read
 * from the claimed job row and NEVER from the request body. A worker that has
 * legitimately leased job X cannot be allowed to write assets, redactions or a
 * quality verdict into some other tenant's world by naming it.
 */

import type { BaseDeps } from '../_wv_shared/deps.ts';
import type { HttpRequest, HttpResponse } from '../_wv_shared/http.ts';
import { fail, int, json, secretEquals, str, uuid } from '../_wv_shared/http.ts';
import { deterministicId } from '../_wv_shared/ids.ts';
import {
  assetKey, commitWorld, ID_SECTION, ingestSection, INGEST_SECTIONS,
} from '../_wv_shared/worldIngest.ts';

export interface JobsDeps extends BaseDeps {}

/**
 * The pipeline's stage names, and nothing else.
 *
 * These are the thirteen modules in spatial/pipeline/worldengine/stages/, and
 * this list must match `STAGE_DEPS` in worldengine/runner.py exactly. An
 * earlier draft of this file carried a different vocabulary
 * ('reconstruct', 'blur_reject', 'segment', 'nav', 'measure', 'export',
 * 'floorplan'), which meant a worker asking for the stages it can actually run
 * had six of them silently filtered out and, if it asked for only those, got a
 * 400 with no usable diagnosis. Names that do not match are worse than names
 * that are missing.
 */
export const STAGES: ReadonlySet<string> = new Set([
  'ingest', 'frames', 'redact', 'pose', 'scale', 'splat', 'mesh',
  'layout', 'semantics', 'graph', 'regions', 'package', 'quality',
]);

const MIN_LEASE_S = 30;
const MAX_LEASE_S = 60 * 60 * 6;

/** Upload URLs are the credential, so they live only as long as one upload. */
const UPLOAD_URL_TTL_S = 15 * 60;
/** A packaged world is ~20 assets; 64 leaves room without allowing a flood. */
const MAX_UPLOAD_FILES = 64;
/** Redactions arrive in batches; 500 rows is ~60 KB, inside the body limit. */
const MAX_REDACTION_ROWS = 500;
const MAX_ASSET_ROWS = 256;

/**
 * Must match ASSET_BUCKET in wv-view/handler.ts and wv-export/handler.ts.
 * Those two sign READ urls for the objects this function signs WRITE urls for,
 * so a mismatch here produces a world whose assets upload successfully and then
 * 404 for every viewer — which looks like a storage outage rather than a typo.
 */
const ASSET_BUCKET = 'wv-assets';

const ASSET_ROLES = new Set([
  'splat', 'splat_chunk', 'proxy_mesh', 'visual_mesh', 'pointcloud',
  'floorplan', 'cover', 'depth_archive', 'source_media', 'export_bundle',
]);

const REDACTION_KINDS = new Set([
  'face', 'document', 'correspondence', 'screen', 'photo', 'medication',
  'plate', 'person_through_window',
]);

const VERDICTS = new Set(['pass', 'review', 'fail']);

/**
 * Object names a worker may ask for, relative to its world's prefix.
 *
 * Closed charset, no leading slash, no '..', no backslashes. The prefix is
 * prepended by this handler from the job's world id, so a worker cannot
 * traverse out of its own world no matter what it sends. Path traversal into
 * another tenant's assets would be the whole tenant-isolation guarantee gone
 * for the price of one '../'.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function safeName(v: unknown): string | null {
  const s = str(v, 180);
  if (!s || !SAFE_NAME.test(s)) return null;
  if (s.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return s;
}

function finiteNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function nonNegative(v: unknown): number | null {
  const n = finiteNum(v);
  return n !== null && n >= 0 ? n : null;
}

/** The job row a lease-checked action operates on, or an error response. */
async function leasedJob(
  body: Record<string, unknown>, deps: JobsDeps, columns: readonly string[],
): Promise<{ job: Record<string, unknown> } | { res: HttpResponse }> {
  const jobId = uuid(body['jobId']);
  const workerId = uuid(body['workerId']);
  if (!jobId || !workerId) return { res: fail(400, 'jobId and workerId required.') };
  const jobs = await deps.db.select('wv_job', {
    columns: ['id', 'worker_id', 'status', 'world_id', ...columns], eq: { id: jobId }, limit: 1,
  });
  const job = jobs[0];
  // Same check as heartbeat, for the same reason: possession of the shared
  // secret proves you are a worker, not that you are THIS job's worker.
  if (!job || job['worker_id'] !== workerId) return { res: fail(409, 'Not your job.') };
  if (job['status'] !== 'leased' && job['status'] !== 'running') {
    return { res: fail(409, 'Job is no longer running.') };
  }
  return { job };
}

export async function handleJobs(req: HttpRequest, deps: JobsDeps): Promise<HttpResponse> {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  const expected = deps.env.get('WV_WORKER_SECRET') ?? '';
  const presented = req.headers['x-wv-worker-secret'] ?? '';
  // An unset secret must fail closed. A deployment that forgot to configure
  // one is not a deployment with an open pipeline API.
  if (expected.length < 32 || !secretEquals(expected, presented)) {
    deps.log('wv_jobs_auth_failed', { ip: req.ip ?? 'unknown', path: req.path });
    return fail(401, 'Unauthorised.');
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const action = str(body['action'] ?? req.path.replace(/^\//, ''), 32);

  switch (action) {
    case 'claim': return claim(body, deps);
    case 'heartbeat': return heartbeat(body, deps);
    case 'upload-urls': return uploadUrls(body, deps);
    case 'redactions': return redactions(body, deps);
    case 'ingest-world': return ingestWorld(body, deps);
    case 'complete': return complete(body, deps);
    case 'fail': return failJob(body, deps);
    default: return fail(400, 'Unknown action.');
  }
}

async function claim(body: Record<string, unknown>, deps: JobsDeps): Promise<HttpResponse> {
  const workerId = uuid(body['workerId']);
  if (!workerId) return fail(400, 'workerId required.');

  const rawStages = Array.isArray(body['stages']) ? body['stages'] : [];
  const stages = rawStages
    .map((s) => str(s, 40))
    .filter((s): s is string => s !== null && STAGES.has(s));
  if (stages.length === 0) return fail(400, 'No recognised stages requested.');

  const leaseS = int(body['leaseSeconds'], MIN_LEASE_S, MAX_LEASE_S, 900);

  // The worker must exist. Registering on first claim would let anyone with
  // the secret mint identities and make the queue unauditable.
  const workers = await deps.db.select('wv_worker', {
    columns: ['id', 'capabilities'], eq: { id: workerId }, limit: 1,
  });
  if (!workers[0]) return fail(403, 'Unknown worker.');

  const capabilities = Array.isArray(workers[0]['capabilities'])
    ? (workers[0]['capabilities'] as string[]) : [];
  const permitted = capabilities.length === 0
    ? stages
    : stages.filter((s) => capabilities.includes(s));
  if (permitted.length === 0) return fail(403, 'Worker is not registered for those stages.');

  // Matches wv_reap_expired_jobs: a job that has burned three attempts is
  // failed rather than handed out again.
  const MAX_ATTEMPTS = 3;

  const rows = await deps.db.rpc<Record<string, unknown>[]>('wv_claim_job', {
    p_worker_id: workerId, p_lease_seconds: leaseS,
    p_stages: permitted, p_max_attempts: MAX_ATTEMPTS,
  });
  await deps.db.update('wv_worker', { last_seen: deps.clock.now().toISOString() }, { id: workerId });

  const job = Array.isArray(rows) ? rows[0] : undefined;
  if (!job) return json({ job: null });

  // The world's own identity travels with the lease.
  //
  // The pipeline has to stamp propertyId, version, label and slug into the
  // document it assembles, and until now it took them from the job's `params`
  // -- which the operator console queues empty. A build that guesses its own
  // property id produces a document that disagrees with the database about
  // whose property it is, and the ingest's own consistency check then rejects
  // every world. Reading them from the world row here means the worker cannot
  // get them wrong and cannot choose them either.
  const world = await worldContext(String(job['world_id']), deps);

  deps.log('wv_jobs_claimed', { workerId, jobId: job['id'], stage: job['stage'] });
  return json({
    job: {
      id: job['id'], worldId: job['world_id'], stage: job['stage'],
      attempt: job['attempt'], params: job['params'] ?? {},
      leaseUntil: job['lease_until'],
      world,
    },
  });
}

async function worldContext(
  worldId: string, deps: JobsDeps,
): Promise<Record<string, unknown> | null> {
  const worlds = await deps.db.select('wv_world', {
    columns: ['id', 'property_id', 'version', 'slug'], eq: { id: worldId }, limit: 1,
  });
  const world = worlds[0];
  if (!world) return null;
  const properties = await deps.db.select('wv_property', {
    columns: ['id', 'label'], eq: { id: String(world['property_id']) }, limit: 1,
  });
  return {
    id: worldId,
    propertyId: String(world['property_id']),
    version: Number(world['version'] ?? 1),
    slug: world['slug'] ?? null,
    label: String(properties[0]?.['label'] ?? 'Property'),
  };
}

async function heartbeat(body: Record<string, unknown>, deps: JobsDeps): Promise<HttpResponse> {
  const jobId = uuid(body['jobId']);
  const workerId = uuid(body['workerId']);
  if (!jobId || !workerId) return fail(400, 'jobId and workerId required.');
  const leaseS = int(body['leaseSeconds'], MIN_LEASE_S, MAX_LEASE_S, 900);

  const jobs = await deps.db.select('wv_job', {
    columns: ['id', 'worker_id', 'status'], eq: { id: jobId }, limit: 1,
  });
  const job = jobs[0];
  // Only the lease holder may extend it. Without this check a worker that lost
  // its lease could keep a reclaimed job alive underneath its replacement, and
  // two GPUs would reconstruct the same property into the same rows.
  if (!job || job['worker_id'] !== workerId) return fail(409, 'Not your job.');
  if (job['status'] !== 'leased' && job['status'] !== 'running') {
    return fail(409, 'Job is no longer running.');
  }

  // The mutation goes through wv_heartbeat_job rather than a bare update.
  // The select above is for the error message; it is not the authority. A
  // select-then-update here is a race: wv_reap_expired_jobs could requeue the
  // job between the two statements and the update would quietly resurrect it
  // under whichever pod claimed it next. The function does the ownership and
  // status checks inside one UPDATE ... WHERE, so the loser of that race gets
  // false and stops.
  const extended = await deps.db.rpc<boolean>('wv_heartbeat_job', {
    p_job_id: jobId, p_worker_id: workerId, p_lease_seconds: leaseS,
  });
  if (extended === false) {
    deps.log('wv_jobs_heartbeat_fenced', { jobId, workerId });
    return fail(409, 'Not your job.');
  }
  const until = new Date(deps.clock.now().getTime() + leaseS * 1000).toISOString();
  return json({ ok: true, leaseUntil: until });
}

/**
 * Hand out short-lived signed PUT URLs, one per object, under this job's world.
 *
 * The alternative — giving the pod a storage credential — is what this exists
 * to avoid. A signed upload URL can write exactly one path and expires in
 * fifteen minutes; a storage service key can read and overwrite every splat,
 * every raw walkthrough video and every export bundle belonging to every
 * customer, from a machine we rent by the minute and do not control.
 */
async function uploadUrls(body: Record<string, unknown>, deps: JobsDeps): Promise<HttpResponse> {
  const got = await leasedJob(body, deps, []);
  if ('res' in got) return got.res;
  const worldId = String(got.job['world_id']);

  const raw = Array.isArray(body['files']) ? body['files'] : [];
  if (raw.length === 0) return fail(400, 'files required.');
  if (raw.length > MAX_UPLOAD_FILES) return fail(400, 'Too many files in one request.');

  const files: { name: string; storagePath: string; uploadUrl: string }[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const name = safeName(item['name']);
    if (!name) return fail(400, 'Unacceptable object name.');
    if (seen.has(name)) return fail(400, 'Duplicate object name.');
    seen.add(name);
    // The prefix is ours, not the worker's. This is the isolation boundary.
    const storagePath = `${worldId}/${name}`;
    const uploadUrl = await deps.storage.signUploadUrl(ASSET_BUCKET, storagePath, UPLOAD_URL_TTL_S);
    files.push({ name, storagePath, uploadUrl });
  }

  deps.log('wv_jobs_upload_urls', {
    jobId: String(got.job['id']), worldId, count: files.length,
  });
  return json({ bucket: ASSET_BUCKET, expiresIn: UPLOAD_URL_TTL_S, files });
}

/**
 * Record redaction detections for operator review.
 *
 * Every detection is written whether or not it was applied, because the
 * question this table answers is "did you look for medication packaging in
 * this tour", and a table that only holds what was removed cannot answer it.
 * Batched, because a 300-frame walkthrough can produce a few thousand rows and
 * the request body limit is 256 KB.
 */
async function redactions(body: Record<string, unknown>, deps: JobsDeps): Promise<HttpResponse> {
  const got = await leasedJob(body, deps, []);
  if ('res' in got) return got.res;
  const worldId = String(got.job['world_id']);

  const raw = Array.isArray(body['rows']) ? body['rows'] : [];
  if (raw.length > MAX_REDACTION_ROWS) return fail(400, 'Too many rows in one request.');
  if (raw.length === 0) return json({ ok: true, inserted: 0 });

  const rows: Record<string, unknown>[] = [];
  for (const entry of raw) {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const kind = str(item['kind'], 40);
    if (!kind || !REDACTION_KINDS.has(kind)) return fail(400, 'Unknown redaction kind.');
    const bbox = Array.isArray(item['bbox']) ? item['bbox'].map(finiteNum) : null;
    if (!bbox || bbox.length !== 4 || bbox.some((n) => n === null)) {
      return fail(400, 'bbox must be four finite numbers.');
    }
    const detector = str(item['detector'], 80);
    if (!detector) return fail(400, 'detector required.');
    const score = finiteNum(item['score']);
    rows.push({
      world_id: worldId,
      kind,
      bbox,
      detector,
      score: score !== null ? Math.max(0, Math.min(1, score)) : null,
      applied: item['applied'] === true,
    });
  }

  await deps.db.insert('wv_redaction', rows);
  deps.log('wv_jobs_redactions', { worldId, count: rows.length });
  return json({ ok: true, inserted: rows.length });
}

/**
 * Take delivery of the reconstructed world, one section at a time.
 *
 * This is the action that closes the gap the whole system had: the pipeline
 * assembled a WorldDocument and uploaded it as a file, and nothing ever wrote
 * `wv_room`, `wv_camera`, `wv_entity` or any of the rest. So a published world
 * had no rooms, and every reader of it -- the viewer, the agent, the export --
 * described an empty property.
 *
 * The rules are the same as every other action here and are not negotiable:
 *
 *   - `world_id` comes from the claimed job row. The body may name a world; it
 *     is never read. A worker holding job X cannot write into tenant Y.
 *   - the lease is checked before anything is written, so a reclaimed pod that
 *     wakes up and keeps talking cannot fight the pod that replaced it.
 *   - nothing malformed reaches a table. The pipeline validates the document
 *     against the contract before it sends it, and this validates every row
 *     again on arrival, because the pipeline is not the only thing that could
 *     ever call this.
 *
 * Sections are independently retryable and may arrive in any order within a
 * section; the last one, `commit`, is what proves the rows say what the build
 * said and decides whether the world publishes.
 */
async function ingestWorld(body: Record<string, unknown>, deps: JobsDeps): Promise<HttpResponse> {
  const got = await leasedJob(body, deps, ['stage']);
  if ('res' in got) return got.res;
  const worldId = String(got.job['world_id']);
  const jobId = String(got.job['id']);

  const section = str(body['section'], 32);
  if (!section || !(INGEST_SECTIONS as readonly string[]).includes(section)) {
    return fail(400, 'Unknown ingest section.');
  }

  if (section === 'commit') {
    const outcome = await commitWorld(deps, worldId);
    if (!outcome.ok) {
      deps.log('wv_jobs_ingest_refused', {
        jobId, worldId, summary: outcome.summary ?? outcome.error,
        differences: outcome.differences?.length ?? 0,
      });
      return json({
        error: outcome.error,
        summary: outcome.summary,
        differences: outcome.differences ?? [],
      }, outcome.status);
    }
    deps.log('wv_jobs_ingest_committed', { jobId, worldId, verdict: outcome.verdict });
    return json({ ok: true, verdict: outcome.verdict, document: outcome.document });
  }

  const result = await ingestSection(deps, worldId, {
    section,
    rows: body['rows'],
    chunkIndex: body['chunkIndex'],
    chunkCount: body['chunkCount'],
    policy: body['policy'],
    scale: body['scale'],
    propertyId: body['propertyId'],
    version: body['version'],
    quality: body['quality'],
  });

  if (!result.ok) {
    deps.log('wv_jobs_ingest_rejected', {
      jobId, worldId, section, status: result.status, error: result.error,
    });
    return json({ error: result.error, detail: result.detail ?? null }, result.status);
  }

  deps.log('wv_jobs_ingest_section', {
    jobId, worldId, section, written: result.written,
    chunk: int(body['chunkIndex'], 0, 100_000, 0),
    chunks: int(body['chunkCount'], 1, 100_000, 1),
  });
  return json({ ok: true, section, written: result.written });
}

/**
 * Close the job, and with it whatever world-level state the run produced.
 *
 * The worker used to write wv_asset, wv_quality and wv_world itself with a
 * service-role key. It now sends them here instead, and every id that decides
 * WHOSE data is touched comes from the job row: `world_id` is read from the
 * claimed job and the body's opinion of it is never consulted.
 *
 * `assets` and `quality` are optional, because most jobs are a single stage and
 * only the terminal one has a world to publish. A job that sends neither still
 * closes cleanly, which is what keeps the existing single-stage callers working.
 */
async function complete(body: Record<string, unknown>, deps: JobsDeps): Promise<HttpResponse> {
  const jobId = uuid(body['jobId']);
  const workerId = uuid(body['workerId']);
  if (!jobId || !workerId) return fail(400, 'jobId and workerId required.');

  const jobs = await deps.db.select('wv_job', {
    columns: ['id', 'worker_id', 'status', 'world_id', 'stage'], eq: { id: jobId }, limit: 1,
  });
  const job = jobs[0];
  if (!job || job['worker_id'] !== workerId) return fail(409, 'Not your job.');
  if (job['status'] === 'succeeded') return json({ ok: true, alreadyDone: true });

  const worldId = String(job['world_id']);
  const now = deps.clock.now().toISOString();

  const result = typeof body['result'] === 'object' && body['result'] !== null
    ? body['result'] as Record<string, unknown> : {};
  const gpuSeconds = nonNegative(body['gpuSeconds']);
  const costUsd = nonNegative(body['costUsd']);

  // --- assets -------------------------------------------------------------
  const rawAssets = Array.isArray(body['assets']) ? body['assets'] : [];
  if (rawAssets.length > MAX_ASSET_ROWS) return fail(400, 'Too many assets in one request.');
  const assetRows: Record<string, unknown>[] = [];
  const seenAssets = new Set<string>();
  for (const entry of rawAssets) {
    const a = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const role = str(a['role'], 40);
    if (!role || !ASSET_ROLES.has(role)) return fail(400, 'Unknown asset role.');
    const format = str(a['format'], 16);
    if (!format) return fail(400, 'Asset format required.');
    // The worker names the object; this handler decides the prefix, exactly as
    // upload-urls did. A storage_path outside the world's own prefix would let
    // a completed job point a viewer at another tenant's file.
    const name = safeName(a['name']);
    if (!name) return fail(400, 'Unacceptable asset name.');
    const lod = a['lod'] === null || a['lod'] === undefined ? null : nonNegative(a['lod']);
    const chunkKey = str(a['chunkKey'], 120);
    const id = await deterministicId(
      worldId, ID_SECTION.asset, assetKey(role, chunkKey, lod, name));
    if (seenAssets.has(id)) return fail(400, 'Duplicate asset in one completion.');
    seenAssets.add(id);
    assetRows.push({
      // Keyed by role, chunk, LOD and the object name -- which is a content
      // checksum -- so a job that is completed twice, or a stage whose assets
      // the hand-off also registers, updates one row rather than leaving the
      // world with two of every splat.
      id,
      world_id: worldId,
      role,
      format,
      storage_path: `${worldId}/${name}`,
      bytes: nonNegative(a['bytes']),
      checksum: str(a['checksum'], 128),
      lod,
      chunk_key: chunkKey,
      splat_count: nonNegative(a['splatCount']),
      meta: typeof a['meta'] === 'object' && a['meta'] !== null ? a['meta'] : {},
    });
  }

  // --- quality and the publication decision -------------------------------
  const q = typeof body['quality'] === 'object' && body['quality'] !== null
    ? body['quality'] as Record<string, unknown> : null;
  let worldPatch: Record<string, unknown> | null = null;
  let verdict: string | null = null;

  if (q) {
    verdict = str(q['verdict'], 16);
    if (!verdict || !VERDICTS.has(verdict)) return fail(400, 'Unknown quality verdict.');
    const score = finiteNum(q['score']);
    if (score === null || score < 0 || score > 1) return fail(400, 'Quality score out of range.');
    const checks = Array.isArray(q['checks']) ? q['checks'] : [];

    // Server-side consistency check. The worker computes the gate, so this
    // cannot re-derive the verdict — but a 'pass' submitted alongside a check
    // that did not pass is incoherent on its face, and the safe reading of an
    // incoherent gate result is the conservative one.
    const anyFailed = checks.some((c) => (
      typeof c === 'object' && c !== null && (c as Record<string, unknown>)['pass'] === false
    ));
    if (verdict === 'pass' && anyFailed) {
      deps.log('wv_jobs_verdict_downgraded', { worldId, jobId });
      verdict = 'review';
    }

    await deps.db.insert('wv_quality', [{
      world_id: worldId, checks, score, verdict, created_at: now,
    }]);

    const status = verdict === 'pass' ? 'published' : verdict === 'review' ? 'review' : 'failed';
    worldPatch = {
      status,
      quality_score: score,
      // A world is published because it passed, not because a pipeline
      // finished. published_at is set here and only here.
      published_at: status === 'published' ? now : null,
    };
    const scale = typeof body['scale'] === 'object' && body['scale'] !== null
      ? body['scale'] as Record<string, unknown> : null;
    if (scale) {
      const source = str(scale['source'], 120);
      const agreement = finiteNum(scale['agreement']);
      if (source) worldPatch['scale_source'] = source;
      if (agreement !== null) worldPatch['scale_agreement'] = Math.max(0, Math.min(1, agreement));
    }
  }

  if (assetRows.length > 0) await deps.db.upsert('wv_asset', assetRows);
  if (worldPatch) await deps.db.update('wv_world', worldPatch, { id: worldId });

  await deps.db.update('wv_job', {
    status: 'succeeded',
    finished_at: now,
    result,
    gpu_seconds: gpuSeconds,
    cost_usd: costUsd,
    error: null,
  }, { id: jobId });

  deps.log('wv_jobs_completed', {
    jobId, stage: job['stage'], worldId, gpuSeconds, costUsd,
    assets: assetRows.length, verdict,
  });
  return json({ ok: true, verdict });
}

/** Retries are the scheduler's business; this only records the outcome. */
async function failJob(body: Record<string, unknown>, deps: JobsDeps): Promise<HttpResponse> {
  const jobId = uuid(body['jobId']);
  const workerId = uuid(body['workerId']);
  if (!jobId || !workerId) return fail(400, 'jobId and workerId required.');
  const message = str(body['error'], 2000) ?? 'unspecified worker failure';
  const retryable = body['retryable'] !== false;

  const jobs = await deps.db.select('wv_job', {
    columns: ['id', 'worker_id', 'attempt', 'world_id', 'stage'], eq: { id: jobId }, limit: 1,
  });
  const job = jobs[0];
  if (!job || job['worker_id'] !== workerId) return fail(409, 'Not your job.');

  const attempt = Number(job['attempt'] ?? 0);
  // Three attempts, then it stays failed and a human looks at it. An infinite
  // retry on a GPU stage is a way to spend a month's budget in an afternoon.
  const giveUp = !retryable || attempt >= 3;

  await deps.db.update('wv_job', {
    status: giveUp ? 'failed' : 'queued',
    error: message,
    worker_id: giveUp ? job['worker_id'] : null,
    lease_until: null,
    finished_at: giveUp ? deps.clock.now().toISOString() : null,
  }, { id: jobId });

  if (giveUp) {
    await deps.db.update('wv_world', { status: 'failed' }, { id: String(job['world_id']) });
  }
  deps.log('wv_jobs_failed', { jobId, stage: job['stage'], attempt, giveUp, message });
  return json({ ok: true, requeued: !giveUp });
}
