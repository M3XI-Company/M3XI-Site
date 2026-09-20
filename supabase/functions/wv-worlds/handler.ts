/**
 * wv-worlds — operator CRUD.
 *
 * Signed-in humans only, and every single action re-derives the caller's
 * membership from the database rather than trusting anything in the request.
 * There is exactly one authorisation helper, `requireWorldAccess`, and every
 * path that touches a world goes through it. A second way to reach a world
 * would eventually be a second way to reach someone else's.
 *
 * Access to a world is not the same question as permission to change it.
 * Reading is open to every member of the org; starting a build, registering a
 * capture, correcting the world, publishing it and taking it down are gated at
 * operator and above by `MAY_CHANGE_WORLD`, which is the server half of the
 * capability matrix in @m3xi/console-ui.
 *
 * The publish gate is the other load-bearing rule here: a world becomes
 * publicly viewable because it PASSED, not because the pipeline finished. The
 * check reads the latest wv_quality row and refuses anything that is not a
 * `pass`, including `review`, and including a world whose quality row is
 * missing entirely.
 */

import type { BaseDeps, Row } from '../_wv_shared/deps.ts';
import type { HttpRequest, HttpResponse } from '../_wv_shared/http.ts';
import { fail, json, slug as asSlug, str, uuid } from '../_wv_shared/http.ts';
import { markWorldDocumentStale, renderWorldDocument } from '../_wv_shared/worldDocument.ts';

export interface WorldsDeps extends BaseDeps {}

type Caller = { readonly id: string };

export async function handleWorlds(req: HttpRequest, deps: WorldsDeps): Promise<HttpResponse> {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  const caller = await deps.authUser(req.headers['authorization']);
  if (!caller) return fail(401, 'Sign in.');

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const action = str(body['action'] ?? req.path.replace(/^\//, ''), 40);

  switch (action) {
    case 'create_property': return createProperty(body, caller, deps);
    case 'list_properties': return listProperties(body, caller, deps);
    case 'create_world': return createWorld(body, caller, deps);
    case 'register_capture': return registerCapture(body, caller, deps);
    case 'request_build': return requestBuild(body, caller, deps);
    case 'resume_build': return resumeBuild(body, caller, deps);
    case 'get_world': return getWorld(body, caller, deps);
    case 'approve_corrections': return approveCorrections(body, caller, deps);
    case 'publish': return publish(body, caller, deps);
    case 'unpublish': return unpublish(body, caller, deps);
    case 'list_members': return listMembers(body, caller, deps);
    case 'invite_member': return inviteMember(body, caller, deps);
    case 'set_member_role': return setMemberRole(body, caller, deps);
    case 'remove_member': return removeMember(body, caller, deps);
    default: return fail(400, 'Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Roles
//
// These four are `wv_member_role` from the core migration, and the rules below
// are the server half of `roles.ts` in @m3xi/console-ui. The console computes
// the same answers so it never offers a control the server will refuse; this
// file is the one that decides. Two locks, one key -- and this is the lock.
// ---------------------------------------------------------------------------

const MEMBER_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];

const ROLE_RANK: Readonly<Record<MemberRole, number>> = {
  owner: 3, admin: 2, operator: 1, viewer: 0,
};

/** Roles that may add, promote, demote and remove people. */
const MAY_MANAGE_MEMBERS: ReadonlySet<string> = new Set<MemberRole>(['owner', 'admin']);

/**
 * Roles that may CHANGE a world: spend GPU money on a build, register a
 * capture against it, correct what it says about the building, and put a
 * property on or take it off the public internet.
 *
 * This set is exactly the operator capabilities in
 * spatial/packages/console-ui/src/logic/roles.ts -- `build.start`,
 * `build.resume`, `correction.apply`, `world.publish`, `world.unpublish` --
 * and the match is the point. The console computes the same answer so it never
 * offers a control the server will refuse; the server is the lock.
 *
 * It used to gate `resume_build` alone, which meant the lock was fitted to the
 * cheapest of the five doors. `viewer` is defined by ROLE_DESCRIPTIONS as
 * "Read-only. Sees the portfolio, analytics, leads and finished exports;
 * changes nothing", and yet a viewer could start a build (a committed GPU
 * bill), publish somebody's home to the open web, take it down again, and
 * rewrite what the rooms are called. The console never drew those buttons for
 * them -- and nothing at all requires a request to come from the console.
 */
const MAY_CHANGE_WORLD: ReadonlySet<string> = new Set<MemberRole>(['owner', 'admin', 'operator']);

function asMemberRole(v: unknown): MemberRole | null {
  const s = str(v, 16);
  return s !== null && (MEMBER_ROLES as readonly string[]).includes(s) ? s as MemberRole : null;
}

function rank(role: string): number {
  return ROLE_RANK[role as MemberRole] ?? -1;
}

/**
 * Deliberately conservative: one @, no whitespace, no angle brackets, a dot in
 * the domain. It is used to LOOK UP an existing account, never to send mail,
 * so the cost of rejecting an exotic-but-valid address is that an admin adds
 * that person by another route, while the cost of accepting a malformed one is
 * a lookup against a value somebody hand-crafted.
 */
const EMAIL = /^[^\s@<>"']{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function asEmail(v: unknown): string | null {
  const s = str(v, 254);
  if (!s) return null;
  const lowered = s.toLowerCase();
  return EMAIL.test(lowered) ? lowered : null;
}

// ---------------------------------------------------------------------------
// Authorisation — the only door
// ---------------------------------------------------------------------------

/**
 * Resolve a world the caller is allowed to write, or return the SAME 404 used
 * for a world that does not exist.
 *
 * Returning 403 for "exists but not yours" would confirm the existence of
 * another org's world to anyone willing to guess a uuid. It is a small leak
 * and it is the one that turns a scrape into a customer list.
 */
async function requireWorldAccess(
  worldId: unknown, caller: Caller, deps: WorldsDeps,
): Promise<{ ok: true; worldId: string; orgId: string; role: string } | { ok: false; res: HttpResponse }> {
  const id = uuid(worldId);
  if (!id) return { ok: false, res: fail(400, 'worldId required.') };

  const orgId = await deps.db.rpc<string | null>('wv_org_of_world', { p_world: id });
  if (!orgId) return { ok: false, res: fail(404, 'Not found.') };

  const role = await memberRoleIn(orgId, caller, deps);
  if (role === null) {
    deps.log('wv_worlds_cross_tenant_denied', { userId: caller.id, worldId: id, orgId });
    return { ok: false, res: fail(404, 'Not found.') };
  }
  return { ok: true, worldId: id, orgId, role };
}

/**
 * Membership is read from wv_member directly rather than through the
 * `wv_is_member` RPC, because that RPC resolves the caller from the JWT and
 * these functions run as the service role, where there is no caller to
 * resolve. The user id comes from verifying the caller's token in `authUser`.
 *
 * Returns the caller's ROLE rather than a boolean, because the member-facing
 * actions need to know it and a second query to find it out would be a second
 * place for the two answers to disagree.
 */
async function memberRoleIn(orgId: string, caller: Caller, deps: WorldsDeps): Promise<string | null> {
  const rows = await deps.db.select('wv_member', {
    columns: ['org_id', 'user_id', 'role'],
    eq: { org_id: orgId, user_id: caller.id },
    limit: 1,
  });
  const role = rows[0]?.['role'];
  return typeof role === 'string' ? role : (rows.length > 0 ? 'viewer' : null);
}

async function requireOrgAccess(
  orgId: unknown, caller: Caller, deps: WorldsDeps,
): Promise<{ ok: true; orgId: string; role: string } | { ok: false; res: HttpResponse }> {
  const id = uuid(orgId);
  if (!id) return { ok: false, res: fail(400, 'orgId required.') };
  const role = await memberRoleIn(id, caller, deps);
  if (role === null) {
    deps.log('wv_worlds_cross_tenant_denied', { userId: caller.id, orgId: id });
    return { ok: false, res: fail(404, 'Not found.') };
  }
  return { ok: true, orgId: id, role };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

async function createProperty(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireOrgAccess(body['orgId'], caller, deps);
  if (!access.ok) return access.res;

  const label = str(body['label'], 200);
  if (!label) return fail(400, 'A property needs a label.');

  const rows = await deps.db.insert('wv_property', {
    org_id: access.orgId,
    label,
    ref: str(body['ref'], 80),
    postcode: str(body['postcode'], 12),
    address: typeof body['address'] === 'object' && body['address'] !== null ? body['address'] : {},
  });
  const created = rows[0];
  if (!created) return fail(500, 'Could not create the property.');
  return json({ property: { id: created['id'], label: created['label'] } }, 201);
}

async function listProperties(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireOrgAccess(body['orgId'], caller, deps);
  if (!access.ok) return access.res;
  const rows = await deps.db.select('wv_property', {
    columns: ['id', 'ref', 'label', 'postcode', 'created_at'],
    eq: { org_id: access.orgId },
    order: { column: 'created_at', ascending: false },
    limit: 200,
  });
  return json({ properties: rows });
}

// ---------------------------------------------------------------------------
// World versions
// ---------------------------------------------------------------------------

async function createWorld(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const propertyId = uuid(body['propertyId']);
  if (!propertyId) return fail(400, 'propertyId required.');

  const props = await deps.db.select('wv_property', {
    columns: ['id', 'org_id'], eq: { id: propertyId }, limit: 1,
  });
  const property = props[0];
  if (!property) return fail(404, 'Not found.');
  const access = await requireOrgAccess(property['org_id'], caller, deps);
  if (!access.ok) return access.res;

  const existing = await deps.db.select('wv_world', {
    columns: ['id', 'version'],
    eq: { property_id: propertyId },
    order: { column: 'version', ascending: false },
    limit: 1,
  });
  const previous = existing[0];
  const version = previous ? Number(previous['version']) + 1 : 1;

  const rows = await deps.db.insert('wv_world', {
    property_id: propertyId,
    version,
    status: 'draft',
    // A rescan supersedes its predecessor, which is how entity ids survive.
    // The old version is never destroyed: someone acted on what it showed.
    supersedes_id: previous ? previous['id'] : null,
    slug: asSlug(body['slug']),
  });
  const created = rows[0];
  if (!created) return fail(500, 'Could not create the world version.');
  return json({ world: { id: created['id'], version } }, 201);
}

/**
 * Tables an operator may correct, and therefore the tables whose `updated_at`
 * answers "was this world changed after it was last assessed?".
 *
 * They are exactly the tables `..._rls.sql` grants UPDATE on to
 * `authenticated`, minus wv_redaction, which records a review decision rather
 * than a change to the world's geometry or contents.
 */
const CORRECTABLE_TABLES = ['wv_room', 'wv_entity', 'wv_opening', 'wv_surface'] as const;

/**
 * The most recent correction to this world, or null.
 *
 * This exists because the publish gate has a `stale` state -- a quality report
 * written BEFORE a correction describes a world that no longer exists -- and
 * until `updated_at` was added to the correctable tables there was no column
 * that could ever make it fire. The gate was structurally dead.
 *
 * One indexed `order by updated_at desc limit 1` per table, which is four
 * index-only lookups, rather than an aggregate the Db interface does not
 * expose. Corrections written straight to PostgREST count too: the timestamp
 * comes from a row trigger, not from this endpoint, so a console that patches
 * wv_room directly cannot forget to set it.
 */
async function lastCorrectionAt(worldId: string, deps: WorldsDeps): Promise<string | null> {
  const perTable = await Promise.all(CORRECTABLE_TABLES.map((table) => deps.db.select(table, {
    columns: ['updated_at'],
    eq: { world_id: worldId },
    order: { column: 'updated_at', ascending: false },
    limit: 1,
  })));

  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const rows of perTable) {
    const value = rows[0]?.['updated_at'];
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms <= latestMs) continue;
    latestMs = ms;
    latest = value;
  }
  return latest;
}

async function getWorld(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireWorldAccess(body['worldId'], caller, deps);
  if (!access.ok) return access.res;

  const [worlds, jobs, quality, correctedAt] = await Promise.all([
    deps.db.select('wv_world', {
      // scale_provenance and scale_confidence travel with scale_source and
      // scale_agreement, because "ARKit depth, 0.98 agreement" without the
      // provenance reads as a measured metre. No camera measures a metre.
      columns: ['id', 'property_id', 'version', 'status', 'published_at', 'quality_score', 'slug',
        'created_at', 'supersedes_id',
        'scale_source', 'scale_agreement', 'scale_provenance', 'scale_confidence'],
      eq: { id: access.worldId }, limit: 1,
    }),
    deps.db.select('wv_job', {
      // depends_on draws the real DAG edges; started_at and finished_at are
      // what turn a list of stages into per-stage durations. Without them the
      // console has to infer the chain from queue order and cannot time
      // anything at all.
      columns: ['id', 'stage', 'status', 'attempt', 'error', 'gpu_seconds', 'cost_usd',
        'queued_at', 'depends_on', 'started_at', 'finished_at'],
      eq: { world_id: access.worldId },
      order: { column: 'queued_at', ascending: true }, limit: 200,
    }),
    deps.db.select('wv_quality', {
      columns: ['checks', 'score', 'verdict', 'created_at'],
      eq: { world_id: access.worldId },
      order: { column: 'created_at', ascending: false }, limit: 1,
    }),
    lastCorrectionAt(access.worldId, deps),
  ]);
  if (!worlds[0]) return fail(404, 'Not found.');
  return json({
    world: worlds[0],
    jobs,
    quality: quality[0] ?? null,
    lastCorrectionAt: correctedAt,
  });
}

// ---------------------------------------------------------------------------
// Captures
//
// The capture app uploads the walkthrough itself -- a 2 GB video through an
// edge function is not a thing that works -- straight into the wv-captures
// bucket under a signed-in member's own credentials. Until this action existed
// the upload then had nowhere to go: `wv_capture` grants `authenticated`
// SELECT and nothing else, so the object sat in a bucket with no row naming
// it, and `ingest` had nothing to read. This is the row.
// ---------------------------------------------------------------------------

/** The four things a capture can be. `wv_capture.kind` is free text; this is not. */
const CAPTURE_KINDS: ReadonlySet<string> = new Set(['video', 'photos', 'lidar', 'pano']);

/** The wv-captures bucket's own file_size_limit, from the server-API migration. */
const MAX_CAPTURE_BYTES = 5368709120;

/**
 * Does this object path belong to this world?
 *
 * The storage policy on wv-captures is keyed on the FIRST PATH SEGMENT being a
 * world the caller may write -- `wv_can_write_world(safe_uuid(
 * (storage.foldername(name))[1]))` -- so the bucket enforces this for the
 * upload. Nothing enforced it for the ROW, and the row is what everything
 * downstream reads: a capture registered against world A while naming an
 * object under world B's prefix is a durable pointer from one tenant's
 * database into another tenant's video, and the first thing that signs a URL
 * from it hands that video over. The check belongs in both places because they
 * are two different assertions -- "may this upload happen" and "does this row
 * describe this world" -- and only one of them was being made.
 *
 * Backslashes, leading slashes and any `..` are refused outright rather than
 * normalised. A path that needs normalising before it can be trusted is a path
 * somebody is trying something with, and there is no legitimate caller that
 * produces one.
 */
function pathIsInsideWorld(path: string, worldId: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('..')) return false;
  const segments = path.split('/');
  // At least a prefix and an object name: a bare world id names a folder.
  if (segments.length < 2) return false;
  if (segments.some((s) => s.length === 0)) return false;
  return (segments[0] ?? '').toLowerCase() === worldId.toLowerCase();
}

/**
 * Did Postgres refuse this write because a unique index already held the row?
 *
 * `Db` speaks PostgREST over fetch and its errors arrive as
 * `Error('postgrest 409: {"code":"23505",...}')` -- there is no structured
 * error object to interrogate, so the SQLSTATE is read out of the message.
 * 23505 is `unique_violation` and nothing else, which is why the test is on
 * the code rather than on the prose around it: a constraint name or an English
 * message would change with the schema, and matching the word "duplicate"
 * loosely would eventually swallow an error that is not this one.
 *
 * Narrowness is the point. Every caller of this treats a true as "the work was
 * already done"; a false positive is a failure reported as a success.
 */
function isUniqueViolation(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b23505\b/.test(text);
}

/** A non-negative count, or null when it is absent or not a number. */
function count(v: unknown, max: number): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.floor(n);
}

async function registerCapture(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireWorldAccess(body['worldId'], caller, deps);
  if (!access.ok) return access.res;
  if (!MAY_CHANGE_WORLD.has(access.role)) {
    return fail(403, 'Your role cannot attach a capture to this world. Ask an operator, admin or owner.');
  }

  const kind = str(body['kind'], 16);
  if (!kind || !CAPTURE_KINDS.has(kind)) {
    return fail(400, 'A capture is a video, photos, lidar or a pano.');
  }

  const storagePath = str(body['storagePath'] ?? body['storage_path'], 400);
  if (!storagePath) return fail(400, 'storagePath required.');
  if (!pathIsInsideWorld(storagePath, access.worldId)) {
    deps.log('wv_worlds_capture_path_refused', {
      worldId: access.worldId, userId: caller.id,
    });
    return fail(400, 'A capture path must start with this world id, because that is the only '
      + 'prefix the storage policy let you upload to.');
  }

  const bytes = count(body['bytes'], MAX_CAPTURE_BYTES);
  // A day of walkthrough is not a walkthrough, and a frame count in the
  // millions is a typo. Both bounds exist to keep a nonsense number out of the
  // coverage arithmetic the ingest stage does with them.
  const durationS = body['duration_s'] ?? body['durationS'];
  const duration = durationS === undefined || durationS === null
    ? null
    : (() => { const n = Number(durationS); return Number.isFinite(n) && n >= 0 && n <= 86400 ? n : null; })();
  const frameCount = count(body['frame_count'] ?? body['frameCount'], 1_000_000);

  const capturedAtRaw = str(body['captured_at'] ?? body['capturedAt'], 40);
  const capturedAt = capturedAtRaw && Number.isFinite(Date.parse(capturedAtRaw))
    ? new Date(Date.parse(capturedAtRaw)).toISOString()
    : null;

  const device = typeof body['device'] === 'object' && body['device'] !== null && !Array.isArray(body['device'])
    ? body['device'] as Record<string, unknown>
    : {};

  let rows: Row[];
  try {
    rows = await deps.db.insert('wv_capture', {
      world_id: access.worldId,
      kind,
      storage_path: storagePath,
      bytes,
      duration_s: duration,
      frame_count: frameCount,
      device,
      captured_at: capturedAt,
    });
  } catch (err) {
    // A phone on a doorstep, on whatever connection the property has, retries
    // when the response never arrives. The unique index wv_capture_object
    // (world_id, storage_path) now stops the retry writing a second row -- two
    // rows for one uploaded object means the pipeline can be handed the same
    // walkthrough twice and the operator sees a capture they did not make.
    //
    // But the upload DID succeed and the row DOES exist, so a 500 here would
    // be the server reporting failure for work that is complete, and a capture
    // app that believes the registration failed either retries forever or
    // tells the operator to walk the property again.
    //
    // Two conditions, both required: the error has to be a unique violation,
    // and the row it collided with has to be findable. Anything else is
    // rethrown, because a constraint firing for a reason this code does not
    // understand is not something to answer 200 to.
    if (!isUniqueViolation(err)) throw err;
    const existing = await deps.db.select('wv_capture', {
      columns: ['id', 'kind', 'storage_path'],
      eq: { world_id: access.worldId, storage_path: storagePath },
      limit: 1,
    });
    const already = existing[0];
    if (!already) throw err;

    deps.log('wv_worlds_capture_already_registered', {
      worldId: access.worldId, userId: caller.id,
      captureId: String(already['id']),
      // A retry that names a different kind for the same object is not a
      // retry, and the stored row wins. Logged rather than refused: the object
      // is registered either way, and an operator chasing a mislabelled
      // capture needs to be able to find this line.
      kind, storedKind: already['kind'] ?? null,
    });
    // 200 rather than 201: nothing was created by this request, and the status
    // is where a client can see the difference without parsing anything.
    return json({
      capture: { id: already['id'], kind: already['kind'] ?? kind, storagePath },
      duplicate: true,
    });
  }

  const created = rows[0];
  if (!created) return fail(500, 'Could not record the capture.');

  // Deliberately NOT marked stale, and deliberately not a status change. The
  // world document renders no capture row -- what reaches it is the posed
  // cameras the `pose` stage writes -- so registering one changes nothing a
  // reader would see, and moving the world to `capturing` here would have a
  // second walkthrough on a finished property drag it back out of review.
  deps.log('wv_worlds_capture_registered', {
    worldId: access.worldId, userId: caller.id, kind, bytes, captureId: String(created['id']),
  });
  return json({ capture: { id: created['id'], kind, storagePath } }, 201);
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/**
 * The pipeline, as the dependency graph it actually is.
 *
 * This is `STAGE_DEPS` from spatial/pipeline/worldengine/runner.py, edge for
 * edge, and there are thirteen stages because there are thirteen modules in
 * worldengine/stages/.
 *
 * It replaces a retired vocabulary -- 'blur_reject', 'reconstruct', 'segment',
 * 'nav', 'measure', 'export', 'floorplan' -- that had drifted out of every
 * other file that uses it. None of those stages exists in the pipeline and
 * `wv-jobs` rejects all of them, so every job this endpoint queued was
 * unclaimable: a worker asking for the stages it can run never matched one,
 * `wv_claim_job` never handed anything out, and a build queued cleanly and
 * then sat at 0% forever. The test in
 * supabase/functions/_wv_shared/__tests__/serverApi.test.ts asserts that every
 * stage queued here is one wv-jobs will accept, so this cannot drift again
 * without a red test.
 *
 * The edges matter as much as the names. `wv_claim_job` will not lease a job
 * until every id in `depends_on` has SUCCEEDED, so these are the real
 * scheduling constraints, not decoration -- and they are what the console
 * draws its DAG from.
 */
export const BUILD_STAGE_DEPS: Readonly<Record<string, readonly string[]>> = {
  ingest: [],
  frames: ['ingest'],
  // redact before every stage that touches frame pixels. In the runner this
  // is structural rather than conventional, and it stays structural here.
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

/**
 * Insertion order. It is a topological order of BUILD_STAGE_DEPS, which is
 * what lets the loop below resolve each stage's parents to job ids that
 * already exist -- and it is also the order the console shows stages in,
 * because jobs come back ordered by queued_at.
 */
export const BUILD_PIPELINE: readonly string[] = [
  'ingest', 'frames', 'redact', 'pose', 'scale', 'splat', 'mesh',
  'layout', 'semantics', 'graph', 'regions', 'package', 'quality',
];

/**
 * `wv_claim_job`'s `p_max_attempts` and the ceiling `wv_reap_expired_jobs`
 * uses when it decides an abandoned job is permanently failed. A resume that
 * ignored this would hand a job back to the queue that the queue will not take.
 */
const MAX_JOB_ATTEMPTS = 3;

/** Statuses that mean a worker may still be writing to this world. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'leased', 'running']);

function attemptOf(job: Row): number {
  const n = Number(job['attempt'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * True when a worker still holds this job.
 *
 * A lease that has expired is NOT held: the pod is fenced (its heartbeat
 * returns false) and `wv_claim_job` may already hand the row to someone else.
 * A lease that has not expired is held by somebody who is, as far as anything
 * here can tell, still working -- and requeueing it underneath them is exactly
 * the double-run this check exists to prevent.
 */
function heldByWorker(job: Row, now: Date): boolean {
  const status = String(job['status'] ?? '');
  if (status !== 'leased' && status !== 'running') return false;
  const until = job['lease_until'];
  if (typeof until !== 'string') return true;   // held, with no stated expiry
  const ms = Date.parse(until);
  return !Number.isFinite(ms) || ms > now.getTime();
}

async function requestBuild(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireWorldAccess(body['worldId'], caller, deps);
  if (!access.ok) return access.res;
  if (!MAY_CHANGE_WORLD.has(access.role)) {
    return fail(403, 'Your role cannot start a build. Ask an operator, admin or owner.');
  }

  // Build spend is capped per org per month, checked here, before any job is
  // queued. A queued GPU job is a committed cost even if nobody looks at it.
  const allowed = await deps.db.rpc<{ allowed?: boolean; reason?: string }>('wv_spend_allowed', {
    p_world: access.worldId, p_kind: 'build',
  });
  if (allowed?.allowed !== true) {
    return fail(429, allowed?.reason === 'build_month_cap'
      ? 'This account has used its builds for the month.'
      : 'Builds are unavailable right now.');
  }

  const running = await deps.db.select('wv_job', {
    columns: ['id', 'status'], eq: { world_id: access.worldId },
  });
  if (running.some((j) => LIVE_STATUSES.has(String(j['status'])))) {
    return fail(409, 'A build is already running for this world.');
  }

  // Plan first, write second. A dangling dependency is not a slow build, it is
  // a WRONG one: `wv_claim_job` treats an id that matches no row as satisfied,
  // so a stage whose parent was never queued would be handed out immediately
  // and would run against artefacts that do not exist. Validating the whole
  // chain before the first insert means that failure can never leave half a
  // pipeline in the queue.
  const plan: { stage: string; parents: readonly string[] }[] = [];
  const planned = new Set<string>();
  for (const stage of BUILD_PIPELINE) {
    const parents = BUILD_STAGE_DEPS[stage] ?? [];
    if (parents.some((p) => !planned.has(p))) {
      deps.log('wv_worlds_stage_graph_invalid', { worldId: access.worldId, stage });
      return fail(500, 'The build pipeline is not in dependency order.');
    }
    planned.add(stage);
    plan.push({ stage, parents });
  }

  const created: Row[] = [];
  const jobIdByStage = new Map<string, string>();
  for (const { stage, parents } of plan) {
    const dependsOn = parents.map((p) => jobIdByStage.get(p)!);
    const rows = await deps.db.insert('wv_job', {
      world_id: access.worldId,
      stage,
      status: 'queued',
      depends_on: dependsOn,
      params: {},
    });
    const job = rows[0];
    if (!job) return fail(500, `Could not queue ${stage}.`);
    jobIdByStage.set(stage, String(job['id']));
    created.push({ id: job['id'], stage, dependsOn });
  }

  await deps.db.update('wv_world', { status: 'processing' }, { id: access.worldId });
  deps.log('wv_worlds_build_requested', { worldId: access.worldId, jobs: created.length });
  return json({ queued: created }, 202);
}

/**
 * Put the failed stage of a build back on the queue.
 *
 * Resume is not restart. The run directory a worker uses is keyed by world and
 * version, so every stage that already succeeded has a checkpoint the next pod
 * skips straight past; requeueing the one row that failed costs the remaining
 * stages, not the thirty-five GPU-minutes of splat training that already
 * worked. There is no path to this from a browser -- `wv_job` grants no UPDATE
 * to `authenticated` -- which is why it is an action here and not a PostgREST
 * patch.
 *
 * Two rules it must not break:
 *
 *   The three-attempt ceiling. `wv_claim_job` refuses `attempt >= 3` and
 *   `wv_reap_expired_jobs` fails a job that reaches it. Resetting `attempt` to
 *   buy another go would turn a capture that cannot be reconstructed into an
 *   unbounded GPU bill, so a stage that has burned its attempts is refused
 *   with the reason rather than requeued.
 *
 *   Never resurrect a job somebody holds. The requeue is a compare-and-set on
 *   `status = 'failed'`, so if a worker or the reaper moved the row between
 *   the read and the write, nothing matches and nothing is written.
 *
 * Spend is deliberately NOT re-checked. `wv_spend_allowed` counts `splat` jobs
 * QUEUED this month, and a resume inserts no new row; a build already paid for
 * should be allowed to finish rather than stranded half-done by a cap that
 * rolled over mid-run.
 */
async function resumeBuild(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireWorldAccess(body['worldId'], caller, deps);
  if (!access.ok) return access.res;
  if (!MAY_CHANGE_WORLD.has(access.role)) {
    return fail(403, 'Your role cannot resume a build. Ask an operator, admin or owner.');
  }

  const jobs = await deps.db.select('wv_job', {
    columns: ['id', 'stage', 'status', 'attempt', 'lease_until', 'worker_id', 'error', 'queued_at'],
    eq: { world_id: access.worldId },
    order: { column: 'queued_at', ascending: true },
    limit: 500,
  });
  if (jobs.length === 0) return fail(409, 'This world has no build to resume.');

  const now = deps.clock.now();
  const held = jobs.filter((j) => heldByWorker(j, now));
  if (held.length > 0) {
    deps.log('wv_worlds_resume_refused_held', {
      worldId: access.worldId, jobId: String(held[0]!['id']), stage: String(held[0]!['stage']),
    });
    return fail(409, 'A worker is still running this build. Wait for it to finish or fail.');
  }

  const failed = jobs.filter((j) => String(j['status']) === 'failed');
  if (failed.length === 0) {
    return fail(409, jobs.some((j) => LIVE_STATUSES.has(String(j['status'])))
      ? 'This build is still queued, so there is nothing to resume.'
      : 'Nothing in this build has failed, so there is nothing to resume.');
  }

  const resumable = failed.filter((j) => attemptOf(j) < MAX_JOB_ATTEMPTS);
  const exhausted = failed.filter((j) => attemptOf(j) >= MAX_JOB_ATTEMPTS)
    .map((j) => ({ stage: String(j['stage']), attempt: attemptOf(j) }));

  if (resumable.length === 0) {
    return fail(409,
      `${exhausted.map((e) => e.stage).join(', ')} has used all ${MAX_JOB_ATTEMPTS} attempts. `
      + 'The queue will not hand it out again; the capture itself needs looking at.');
  }

  const resumed: Row[] = [];
  for (const job of resumable) {
    const rows = await deps.db.update('wv_job', {
      status: 'queued',
      worker_id: null,
      lease_until: null,
      // Cleared so the next attempt times itself honestly. Keeping the failed
      // attempt's start would report a stage duration that spans a failure and
      // the hours a human took to notice it.
      started_at: null,
      finished_at: null,
      // `error` is deliberately kept. `wv_claim_job` clears it when the job is
      // next leased, so until a worker actually takes it the console can still
      // show what went wrong last time.
    }, { id: String(job['id']), status: 'failed' });
    if (rows.length === 0) {
      deps.log('wv_worlds_resume_lost_race', { worldId: access.worldId, jobId: String(job['id']) });
      continue;
    }
    resumed.push({ id: job['id'], stage: job['stage'], attempt: attemptOf(job) });
  }

  if (resumed.length === 0) {
    return fail(409, 'That stage was picked up by a worker while this request was in flight.');
  }

  // The world was moved to `failed` by wv-jobs when the stage gave up. It is
  // being worked on again, and a status that still says `failed` would have the
  // portfolio showing a dead build that is in fact running.
  await deps.db.update('wv_world', { status: 'processing' }, { id: access.worldId });

  deps.log('wv_worlds_build_resumed', {
    worldId: access.worldId, userId: caller.id,
    stages: resumed.map((r) => r['stage']), blocked: exhausted.length,
  });
  return json({ resumed, blocked: exhausted }, 202);
}

// ---------------------------------------------------------------------------
// Corrections
//
// An operator fixing what the pipeline got wrong. This used to be five text
// fields -- a room's name and kind, an entity's label, category and room --
// and everything else the correction editor can express arrived here and was
// refused. The vocabulary below is `CorrectionChange` in
// spatial/packages/review/src/model/corrections.ts, which is the typed union
// that editor emits.
//
// THE PREVIEW AND THE WORLD MUST AGREE. `applyToDocument` in the same package
// is a pure function over the document, and it is what an operator reviews
// before saving. This file writes the rows. Where the two could differ they
// deliberately do not: the arithmetic for a move, for a resize and for a
// corrected quantity is the same arithmetic, and every record that function
// skips is a correction this one refuses -- because a preview that is not the
// world you get is worse than no preview at all.
//
// THE PROVENANCE MODEL. `provenance.ts` next to it reasons this out at length
// and the server honours it rather than reinventing it:
//
//   A human correction is `inferred`. Never `observed` -- no camera saw it --
//   and never `reconstructed` -- no geometry derived it. `inferred` is the one
//   member of the contract's union that means "somebody's best estimate",
//   which is exactly what a person typing a number is, and the engine's
//   tolerance factor of 2 for inferred falls out of it with no special case
//   anywhere downstream.
//
//   Weakest wins, always. A correction FLOORS provenance and can never raise
//   it: typing over generated infill does not make it observed. The remedy for
//   "nobody scanned that corner" is a rescan, not a confident operator.
//
//   A SEMANTIC correction leaves provenance alone. Renaming a room does not
//   touch its polygon, and downgrading the polygon would corrupt every
//   measurement that reads it in exchange for a change that measured nothing.
//   What moves instead is the confidence, to the declared human ceiling.
//
// THE RECEIPTS. `provenance.ts` records who said so by writing
// `correction:<id>` and `operator:<who>` into `Grounding.sources`. The rows
// now have somewhere to keep that: `correction_sources text[]` on wv_room,
// wv_entity, wv_surface and wv_opening, appended to by `withReceipt` below and
// rendered into `Grounding.sources` by worldDocument.ts. It is a separate
// column from `wv_entity.observed_in` on purpose -- that one is `uuid[]` and
// genuinely is the list of frames that saw the thing, and a "correction:..."
// token in it would corrupt the one field that really is a camera list.
//
// A dimension writes its receipt TWICE, and both matter: into
// `wv_measurement.basis`, which is the row a measurement certificate is
// reissued from, and onto the corrected row itself, so that the world document
// reads as human-corrected without anyone having to open the measurement.
// Kinds whose target table has no such column -- entrance.set on wv_nav_node,
// region.mark on wv_region, redaction.add on wv_redaction -- leave their
// receipt in the audit log, which is where it was before the column existed.
//
// `statedBy` is always the CALLER as `authUser` verified them, never a value
// from the request: a caller who could name its own author could put somebody
// else's name on a correction, and answering "who said so" is the whole
// purpose of the receipt.
//
// WHY THIS IS AN ACTION AND NOT A POSTGREST PATCH. This function runs as
// service_role and bypasses RLS, so nothing below needs a new grant to
// `authenticated` -- and must not be given one. A correction written straight
// from a browser would skip every rule in this file: the provenance floor, the
// tolerance, the measurement row, the single entrance. Corrections stay on
// this audited path, and the tables stay ungranted.
// ---------------------------------------------------------------------------

/** Declared ceiling on the confidence a human assertion carries. provenance.ts, rule 5. */
const HUMAN_ASSERTION_CONFIDENCE = 0.9;

/** At most this many corrections per request. The loop is one round trip each. */
const MAX_CORRECTIONS = 500;

type Provenance = 'observed' | 'reconstructed' | 'inferred' | 'generated';

const PROVENANCE_RANK: Readonly<Record<string, number>> = {
  observed: 0, reconstructed: 1, inferred: 2, generated: 3,
};

/** PROVENANCE_TOLERANCE_FACTOR in spatial-engine/src/measure.ts, to the value. */
const PROVENANCE_TOLERANCE_FACTOR: Readonly<Record<Provenance, number>> = {
  observed: 1, reconstructed: 1, inferred: 2, generated: 4,
};

/**
 * A stored provenance, or `inferred` when the column holds something this
 * code does not recognise. Matching worldDocument.ts: a missing provenance
 * must not read as the strongest claim available.
 */
function asProvenance(v: unknown): Provenance {
  return v === 'observed' || v === 'reconstructed' || v === 'inferred' || v === 'generated'
    ? v : 'inferred';
}

/**
 * Worst wins, matching `weakestProvenance` in world-core/src/types.ts and the
 * copy in _wv_shared/worldDocument.ts.
 *
 * Reimplemented rather than imported for the reason that file gives: these
 * modules run in Deno straight from source and must not depend on a built
 * workspace package, or `npm run build` stands between a migration and a
 * working viewer.
 */
function weakestProvenance(a: Provenance, b: Provenance): Provenance {
  return (PROVENANCE_RANK[a] ?? 3) >= (PROVENANCE_RANK[b] ?? 3) ? a : b;
}

/**
 * INSTRUMENT_TOLERANCE_MM in review/src/model/corrections.ts: the half-width
 * in millimetres each declared instrument supports, at the pessimistic end of
 * the manufacturers' stated accuracies. `unknown` earns no credit and gets the
 * document policy instead. A name this function does not know returns
 * `undefined`, which is refused rather than quietly treated as unknown --
 * "laserr" must not silently become a 25 mm estimate wearing a laser's label.
 */
function instrumentToleranceMm(instrument: string): number | null | undefined {
  if (instrument === 'laser') return 3;
  if (instrument === 'tape') return 10;
  if (instrument === 'unknown') return null;
  return undefined;
}

/** `wv_room_kind`, from the core migration. */
const ROOM_KINDS: ReadonlySet<string> = new Set([
  'living', 'kitchen', 'bedroom', 'bathroom', 'wc', 'hall', 'landing', 'stairwell',
  'utility', 'storage', 'office', 'dining', 'conservatory', 'garage', 'balcony',
  'garden', 'exterior', 'unknown',
]);

/** `wv_opening_kind`, from the core migration. */
const OPENING_KINDS: ReadonlySet<string> = new Set([
  'door', 'doorway', 'window', 'rooflight', 'stair', 'hatch', 'arch',
]);

/** `Entity['category']` in world-core/src/types.ts. The column is free text; this is not. */
const ENTITY_CATEGORIES: ReadonlySet<string> = new Set([
  'furniture', 'appliance', 'fixture', 'fitting', 'structure', 'other',
]);

/** The detector vocabulary `wv_redaction.kind` documents. */
const REDACTION_KINDS: ReadonlySet<string> = new Set([
  'face', 'document', 'screen', 'photo', 'medication', 'plate',
  'person_through_window', 'correspondence',
]);

/**
 * Hostile-input ceilings, not physics.
 *
 * A property is not five kilometres across and a door is not half a kilometre
 * wide. These bounds exist because a value of 1e12 is a typo or an attack, and
 * either way it propagates: it poisons the bounding box, the containment test
 * and every tolerance derived from it. Generous enough that a warehouse, a
 * barn conversion and a stately home all fit.
 */
const MAX_COORDINATE_M = 5000;
const MAX_LENGTH_M = 500;
const MAX_AREA_M2 = 100000;

type Vec3 = [number, number, number];
interface Box { readonly min: Vec3; readonly max: Vec3 }

function finiteNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A positive magnitude within bounds. Zero is not a dimension. */
function positive(v: unknown, max: number): number | null {
  const n = finiteNum(v);
  return n !== null && n > 0 && n <= max ? n : null;
}

function vec3Of(v: unknown, max: number): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out: number[] = [];
  for (const c of v) {
    const n = finiteNum(c);
    if (n === null || Math.abs(n) > max) return null;
    out.push(n);
  }
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
}

/**
 * An axis-aligned box, normalised.
 *
 * "min" and "max" are the caller's word for it. A swapped pair is a box with
 * negative volume that every containment test silently fails, so the corners
 * are sorted rather than trusted -- the same thing `normaliseAabb` does in
 * apply.ts, for the same reason.
 */
function boxOf(v: unknown, max: number): Box | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const a = vec3Of(o['min'], max);
  const b = vec3Of(o['max'], max);
  if (!a || !b) return null;
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/**
 * The oriented box, translated. Rotation and half-extents are untouched: a
 * move is a translation, and re-deriving an orientation from a drag would
 * invent a rotation nobody asked for.
 *
 * Returns null when the row has no usable obb, which is normal -- `wv_entity.
 * obb` is nullable and plenty of entities only ever had an aabb.
 */
function shiftObb(v: unknown, d: Vec3): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = { ...(v as Record<string, unknown>) };
  const centre = vec3Of(o['centre'], MAX_COORDINATE_M);
  if (!centre) return null;
  o['centre'] = [centre[0] + d[0], centre[1] + d[1], centre[2] + d[2]];
  return o;
}

/** The oriented box, re-centred and re-sized. Same shape, same rotation. */
function resizeObb(v: unknown, centre: Vec3, half: Vec3): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = { ...(v as Record<string, unknown>) };
  if (!vec3Of(o['centre'], MAX_COORDINATE_M)) return null;
  o['centre'] = centre;
  o['half'] = half;
  return o;
}

// ---------------------------------------------------------------------------
// One correction, as this endpoint sees it
// ---------------------------------------------------------------------------

/** The receipt half of a `CorrectionRecord`: who, when, and which record. */
interface CorrectionRecord {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly note?: string;
}

/** The world's declared measurement policy, recovered from its rooms. */
interface MeasurementPolicy {
  readonly areaStandard: string;
  readonly areaTolerancePct: number;
  readonly wallToleranceMm: number;
}

interface CorrectionContext {
  readonly worldId: string;
  readonly deps: WorldsDeps;
  readonly record: CorrectionRecord;
  /** Recovered at most once per request, and only when a dimension needs it. */
  readonly policy: () => Promise<MeasurementPolicy>;
}

/**
 * `changed` distinguishes "accepted" from "wrote a row". A sign-off is a real
 * correction that changes no fact about the building, and marking the cached
 * document stale for one would re-render a world that is byte for byte what it
 * already was.
 *
 * `detail` is one sentence the operator gets back. Almost nothing needs it --
 * renaming a room is its own description -- but a DELETE takes rows with it
 * that the operator never named, and a person who removed a phantom room is
 * owed the sentence that says four surfaces and two doorways went with it and
 * the sofa did not. A consequence nobody was told about is a consequence
 * discovered later, in the viewer.
 */
type Outcome =
  | { readonly ok: true; readonly changed: boolean; readonly detail?: string }
  | { readonly ok: false; readonly reason: string };

const APPLIED: Outcome = { ok: true, changed: true };
const NOTED: Outcome = { ok: true, changed: false };

/** Applied, and worth a sentence back. */
function changedWith(detail: string): Outcome {
  return { ok: true, changed: true, detail };
}

/** Accepted, wrote nothing, and worth a sentence back. */
function notedWith(detail: string): Outcome {
  return { ok: true, changed: false, detail };
}

function refuse(reason: string): Outcome {
  return { ok: false, reason };
}

/**
 * One row of THIS world, or null.
 *
 * Every read and every write below is scoped by `world_id` as well as by `id`.
 * A correction naming another org's room matches nothing and changes nothing
 * -- not because a branch caught it, but because the row it names is not in
 * the world the caller was granted. The tenant check is in the query, where it
 * cannot be forgotten, rather than in a condition that can.
 */
async function rowInWorld(
  ctx: CorrectionContext, table: string, id: string, columns: readonly string[],
): Promise<Row | null> {
  const rows = await ctx.deps.db.select(table, {
    columns, eq: { id, world_id: ctx.worldId }, limit: 1,
  });
  return rows[0] ?? null;
}

/**
 * What a correction does to a row's provenance and confidence. Rules 1, 2, 3
 * and 5 of provenance.ts, applied to a row instead of to a `Grounding`.
 *
 * `floor` is null for a semantic correction, which leaves provenance exactly
 * where it was, and 'inferred' for anything that changes geometry or states a
 * dimension. `confirmsExisting` is true when the operator has typed the value
 * that was already there -- a confirmation carries no new information, so it
 * must not pull a 0.95 pipeline confidence down to the human ceiling.
 */
function correctedGrounding(
  row: Row, floor: Provenance | null, confirmsExisting: boolean,
): { provenance: Provenance; confidence: number } {
  const current = asProvenance(row['provenance']);
  const existing = finiteNum(row['confidence']);
  return {
    provenance: floor === null ? current : weakestProvenance(current, floor),
    confidence: confirmsExisting && existing !== null
      ? Math.max(0, Math.min(1, existing))
      : HUMAN_ASSERTION_CONFIDENCE,
  };
}

// ---------------------------------------------------------------------------
// The receipt — provenance.ts, rule 4
// ---------------------------------------------------------------------------

/**
 * The two reserved token namespaces from
 * spatial/packages/review/src/model/provenance.ts. They are spelled out here
 * rather than imported for the reason `weakestProvenance` is: these modules
 * run in Deno straight from source and must not depend on a built workspace
 * package. `correctionSource()` and `operatorSource()` over there produce
 * exactly these strings, and `isHumanCorrected()` and `cameraSourcesOf()` read
 * them back by prefix -- so a drift here is a fact that silently stops looking
 * human-corrected in the viewer.
 */
const CORRECTION_SOURCE_PREFIX = 'correction:';
const OPERATOR_SOURCE_PREFIX = 'operator:';

/**
 * A row's `correction_sources`, with this correction's receipt appended.
 *
 * Rule 4: every correction leaves `correction:<record id>` and
 * `operator:<who>` behind, and that pair is how `isHumanCorrected` answers
 * "did a person touch this fact", how a measurement certificate prints
 * "declared by an operator" rather than "measured by the system", and how a
 * rescan can tell which facts were hand-held. worldDocument.ts renders the
 * column straight into `Grounding.sources`.
 *
 * APPEND, NEVER REPLACE. The column is the audit trail of every hand that has
 * been on the row, so the second operator to correct a room does not erase the
 * first. Tokens are deduplicated because a receipt is a set, not a counter: an
 * operator who corrects two fields of the same room in one batch has still
 * only been one operator, and a client that resubmits the same correction
 * record must not make the row look twice-corrected.
 *
 * It is NOT a camera list. `cameraSourcesOf` filters both prefixes out before
 * anything reads `sources` as frames, and `wv_entity.observed_in` -- which is
 * `uuid[]` and really is a camera list -- is never touched from here.
 *
 * The caller must have selected `correction_sources`; a column that was not
 * projected reads as undefined, and starting from an empty array would
 * silently drop every earlier receipt. Hence the explicit array check: a value
 * this code does not recognise is replaced rather than appended to, because
 * the alternative is writing a malformed array back into the column.
 */
function withReceipt(row: Row, ctx: CorrectionContext): string[] {
  const existing = Array.isArray(row['correction_sources'])
    ? (row['correction_sources'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const out = [...existing];
  const mine = `${CORRECTION_SOURCE_PREFIX}${ctx.record.id}`;
  const who = `${OPERATOR_SOURCE_PREFIX}${ctx.record.by}`;
  if (!out.includes(mine)) out.push(mine);
  if (!out.includes(who)) out.push(who);
  return out;
}

/**
 * Read columns every correctable row is fetched with.
 *
 * `correction_sources` is here rather than at each call site because a
 * correction that forgets to select it appends its receipt to an empty array
 * and destroys every receipt before it -- a silent loss of exactly the record
 * this column exists to keep.
 */
const CORRECTABLE_COLUMNS = ['id', 'provenance', 'confidence', 'correction_sources'] as const;

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

type Normalised =
  | { readonly ok: true; readonly recordId: string; readonly note: string | null; readonly change: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Three shapes are accepted, and they are the same thing:
 *
 *   { id, at, by, change: { kind, ... } }  a CorrectionRecord, as the editor
 *                                          holds it in its list;
 *   { kind, ... }                          a bare CorrectionChange;
 *   { target, id, field, value }           the five-field shape the console's
 *                                          fallback room table still sends,
 *                                          mapped onto the union so there is
 *                                          one implementation and not two.
 *
 * `at` and `by` are read from none of them. The time comes from the server
 * clock and the author from the verified token, because a receipt a caller can
 * write is not a receipt.
 */
function normaliseCorrection(raw: unknown, newId: () => string): Normalised {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed' };
  }
  const c = raw as Record<string, unknown>;
  const note = str(c['note'], 500);

  const inner = c['change'];
  if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
    const change = inner as Record<string, unknown>;
    if (!str(change['kind'], 40)) return { ok: false, reason: 'a correction record needs a change kind' };
    return { ok: true, recordId: uuid(c['id']) ?? newId(), note, change };
  }

  if (str(c['kind'], 40)) {
    return { ok: true, recordId: uuid(c['correctionId']) ?? newId(), note, change: c };
  }

  const legacy = fromLegacyCorrection(c);
  if (!legacy.ok) return legacy;
  return { ok: true, recordId: newId(), note, change: legacy.change };
}

/**
 * The five text fields this endpoint used to accept, translated.
 *
 * Kept working rather than removed: spatial/apps/console's room table sends
 * exactly this shape today, and breaking the fallback editor to tidy up a wire
 * format would take away the only correction UI that ships. Everything outside
 * those five pairs is refused here exactly as it was before -- a hand-typed
 * `area_m2` is a bare number with no standard, no tolerance and no instrument,
 * which is precisely what `dimension.set` exists to stop being possible.
 */
function fromLegacyCorrection(
  c: Record<string, unknown>,
): { ok: true; change: Record<string, unknown> } | { ok: false; reason: string } {
  const target = str(c['target'], 16);
  const id = uuid(c['id']);
  const field = str(c['field'], 40);
  if (!id || !field) return { ok: false, reason: 'missing id or field' };
  const value = c['value'];
  if (typeof value !== 'string' || value.length > 120) {
    return { ok: false, reason: `${field} must be a short string` };
  }
  if (target === 'room' && field === 'name') {
    return { ok: true, change: { kind: 'room.rename', roomId: id, name: value } };
  }
  if (target === 'room' && field === 'kind') {
    return { ok: true, change: { kind: 'room.kind', roomId: id, roomKind: value } };
  }
  if (target === 'entity' && field === 'label') {
    return { ok: true, change: { kind: 'entity.label', entityId: id, label: value } };
  }
  if (target === 'entity' && field === 'category') {
    return { ok: true, change: { kind: 'entity.category', entityId: id, category: value } };
  }
  if (target === 'entity' && field === 'room_id') {
    return { ok: true, change: { kind: 'entity.room', entityId: id, roomId: value } };
  }
  return { ok: false, reason: `${target ?? '?'}.${field} is not correctable` };
}

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

/**
 * Apply one correction, or say why not.
 *
 * Nothing falls through. An unrecognised kind is refused by name, because a
 * correction the server silently ignored is the worst outcome available here:
 * the operator watched it disappear from the list, believes the world says one
 * thing, and it says another.
 */
async function applyChange(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const kind = str(change['kind'], 40);
  switch (kind) {
    // -- semantics ---------------------------------------------------------
    case 'room.rename': {
      const name = str(change['name'], 120);
      if (!name) return refuse('room.rename needs a name of 1 to 120 characters');
      return correctSemantic(ctx, 'wv_room', change['roomId'], ['name'],
        { name }, (row) => row['name'] === name);
    }
    case 'room.kind': {
      const roomKind = str(change['roomKind'], 24);
      if (!roomKind || !ROOM_KINDS.has(roomKind)) {
        return refuse(`'${roomKind ?? ''}' is not a room kind this schema has`);
      }
      return correctSemantic(ctx, 'wv_room', change['roomId'], ['kind'],
        { kind: roomKind }, (row) => row['kind'] === roomKind);
    }
    case 'entity.label': {
      const label = str(change['label'], 120);
      if (!label) return refuse('entity.label needs a label of 1 to 120 characters');
      return correctSemantic(ctx, 'wv_entity', change['entityId'], ['label'],
        { label }, (row) => row['label'] === label);
    }
    case 'entity.category': {
      const category = str(change['category'], 24);
      if (!category || !ENTITY_CATEGORIES.has(category)) {
        return refuse(`'${category ?? ''}' is not an entity category this contract has`);
      }
      return correctSemantic(ctx, 'wv_entity', change['entityId'], ['category'],
        { category }, (row) => row['category'] === category);
    }
    case 'entity.room': {
      const raw = change['roomId'];
      const roomId = raw === null ? null : uuid(raw);
      if (raw !== null && !roomId) return refuse('entity.room needs a room uuid, or null to detach it');
      if (roomId !== null && !(await rowInWorld(ctx, 'wv_room', roomId, ['id']))) {
        // The same rule apply.ts applies: an entity may be detached from every
        // room, but it may not be moved into a room that is not there.
        return refuse(`no room ${roomId} in this world to move it into`);
      }
      return correctSemantic(ctx, 'wv_entity', change['entityId'], ['room_id'],
        { room_id: roomId }, (row) => (row['room_id'] ?? null) === roomId);
    }

    // -- geometry ----------------------------------------------------------
    case 'entity.move': {
      const centroid = vec3Of(change['centroid'], MAX_COORDINATE_M);
      if (!centroid) return refuse('entity.move needs three finite metres inside the property');
      return moveEntity(ctx, change['entityId'], centroid);
    }
    case 'entity.resize': {
      const size = vec3Of(change['size'], MAX_LENGTH_M);
      if (!size || size.some((v) => v <= 0)) return refuse('entity.resize needs three positive metres');
      return resizeEntity(ctx, change['entityId'], size);
    }

    // -- measurement -------------------------------------------------------
    case 'dimension.set':
      return setDimension(change, ctx);

    // -- the two known reconstruction failure modes ------------------------
    case 'surface.flags':
      return correctSurfaceFlags(change, ctx);

    // -- topology ----------------------------------------------------------
    case 'opening.kind': {
      const openingKind = str(change['openingKind'], 24);
      if (!openingKind || !OPENING_KINDS.has(openingKind)) {
        return refuse(`'${openingKind ?? ''}' is not an opening kind this schema has`);
      }
      return correctSemantic(ctx, 'wv_opening', change['openingId'], ['kind'],
        { kind: openingKind }, (row) => row['kind'] === openingKind);
    }
    case 'opening.connects':
      return connectOpening(change, ctx);
    case 'entrance.set':
      return setEntrance(change, ctx);

    // -- survey coverage ---------------------------------------------------
    case 'region.mark':
      return markRegion(change, ctx);

    // -- privacy -----------------------------------------------------------
    case 'redaction.add':
      return addRedaction(change, ctx);

    // -- sign-off ----------------------------------------------------------
    case 'world.approve':
      // Changes no fact about the building, so it changes no row and marks
      // nothing stale. It is accepted because the list IS the audit trail and
      // the editor will not offer save without one, and it is recorded in the
      // log below like every other correction.
      ctx.deps.log('wv_worlds_correction_signoff', {
        worldId: ctx.worldId, by: ctx.record.by, correctionId: ctx.record.id,
        note: ctx.record.note ?? null,
      });
      return NOTED;

    // -- withdrawal --------------------------------------------------------
    case 'room.delete':
      return deleteRoom(change, ctx);
    case 'entity.delete':
      return deleteEntity(change, ctx);
    case 'region.clear':
      return clearRegion(change, ctx);

    default:
      return refuse(`'${kind ?? ''}' is not a correction this endpoint knows`);
  }
}

/**
 * A semantic correction: write the field, leave the geometry's provenance
 * exactly where it is, move the confidence to the human ceiling.
 */
async function correctSemantic(
  ctx: CorrectionContext,
  table: string,
  idValue: unknown,
  readColumns: readonly string[],
  values: Row,
  confirms: (row: Row) => boolean,
): Promise<Outcome> {
  const id = uuid(idValue);
  if (!id) return refuse(`a ${table} correction needs a uuid`);
  const row = await rowInWorld(ctx, table, id, [...CORRECTABLE_COLUMNS, ...readColumns]);
  if (!row) return refuse(`${table}:${id} is not in this world`);

  const g = correctedGrounding(row, null, confirms(row));
  await ctx.deps.db.update(table, {
    ...values, confidence: g.confidence, correction_sources: withReceipt(row, ctx),
  }, { id, world_id: ctx.worldId });
  return APPLIED;
}

/**
 * Move an entity. Centroid, aabb and obb travel together.
 *
 * A box that lags its centroid is a bug you find months later in a fit test,
 * so the translation is applied to all three or the correction is refused.
 * Geometry a human placed is `inferred` (rule 3): no camera saw a sofa there
 * and no reconstruction put it there.
 */
async function moveEntity(
  ctx: CorrectionContext, idValue: unknown, to: Vec3,
): Promise<Outcome> {
  const id = uuid(idValue);
  if (!id) return refuse('entity.move needs an entity uuid');
  const row = await rowInWorld(ctx, 'wv_entity', id,
    [...CORRECTABLE_COLUMNS, 'centroid', 'aabb', 'obb']);
  if (!row) return refuse(`entity:${id} is not in this world`);

  const from = vec3Of(row['centroid'], MAX_COORDINATE_M);
  const box = boxOf(row['aabb'], MAX_COORDINATE_M);
  if (!from || !box) return refuse(`entity:${id} has no usable geometry to move`);

  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const moved = Math.hypot(d[0], d[1], d[2]) > 1e-6;
  const obb = shiftObb(row['obb'], d);
  const g = correctedGrounding(row, 'inferred', !moved);

  await ctx.deps.db.update('wv_entity', {
    centroid: to,
    aabb: {
      min: [box.min[0] + d[0], box.min[1] + d[1], box.min[2] + d[2]],
      max: [box.max[0] + d[0], box.max[1] + d[1], box.max[2] + d[2]],
    },
    ...(obb ? { obb } : {}),
    provenance: g.provenance,
    confidence: g.confidence,
    // The receipt goes on the row, never into `observed_in`: that column is
    // `uuid[]` and really is the list of frames that saw this entity.
    correction_sources: withReceipt(row, ctx),
  }, { id, world_id: ctx.worldId });
  return APPLIED;
}

/**
 * Resize an entity about its BASE, not about its centre.
 *
 * Furniture stands on a floor. Scaling a wardrobe about its centroid buries
 * half of it in the slab and floats the other half, and then the collision
 * test and the fit test both disagree with the room. Keeping `aabb.min[1]`
 * fixed is the only reading of "make it 2.1 m tall" that means what an
 * operator means. This is `resizeEntity` in apply.ts, arithmetic for
 * arithmetic, so the preview and the row cannot disagree.
 */
async function resizeEntity(
  ctx: CorrectionContext, idValue: unknown, size: Vec3,
): Promise<Outcome> {
  const id = uuid(idValue);
  if (!id) return refuse('entity.resize needs an entity uuid');
  const row = await rowInWorld(ctx, 'wv_entity', id,
    [...CORRECTABLE_COLUMNS, 'centroid', 'aabb', 'obb']);
  if (!row) return refuse(`entity:${id} is not in this world`);

  const from = vec3Of(row['centroid'], MAX_COORDINATE_M);
  const box = boxOf(row['aabb'], MAX_COORDINATE_M);
  if (!from || !box) return refuse(`entity:${id} has no usable geometry to resize`);

  const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const baseY = box.min[1];
  const centroid: Vec3 = [from[0], baseY + half[1], from[2]];
  const aabb: Box = {
    min: [from[0] - half[0], baseY, from[2] - half[2]],
    max: [from[0] + half[0], baseY + size[1], from[2] + half[2]],
  };
  const currentHalf: Vec3 = [
    (box.max[0] - box.min[0]) / 2, (box.max[1] - box.min[1]) / 2, (box.max[2] - box.min[2]) / 2,
  ];
  const unchanged = currentHalf.every((v, i) => Math.abs(v - (half[i] ?? 0)) < 1e-6);
  const obb = resizeObb(row['obb'], centroid, half);
  const g = correctedGrounding(row, 'inferred', unchanged);

  await ctx.deps.db.update('wv_entity', {
    centroid, aabb, ...(obb ? { obb } : {}),
    provenance: g.provenance, confidence: g.confidence,
    correction_sources: withReceipt(row, ctx),
  }, { id, world_id: ctx.worldId });
  return APPLIED;
}

/**
 * Mirrors and glazing: the two named reconstruction failure modes.
 *
 * This is the correction that repairs the worst class of error this pipeline
 * makes. A mirror invents a phantom room behind it -- the reconstruction sees
 * depth where there is a wall, and the viewer gets a second living room nobody
 * can walk into. Glazing does the opposite: it blows out, the depth is
 * garbage, and the wall it is in acquires a hole. An operator standing in the
 * flat knows which panel is which in a second, and flagging it is what lets
 * every later stage stop trusting its own reflections.
 *
 * Reflective and glazed are independent claims about the same surface, so a
 * correction that names one leaves the other exactly as it was rather than
 * resetting it to false -- which is also why `correctionKey` in corrections.ts
 * keys them separately.
 *
 * Classed semantic, so provenance does not move: the panel's polygon was
 * reconstructed before the operator looked at it and is still reconstructed
 * after. What changed is what we know the panel IS.
 */
async function correctSurfaceFlags(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const reflective = change['isReflective'];
  const glazed = change['isGlazed'];
  const hasReflective = typeof reflective === 'boolean';
  const hasGlazed = typeof glazed === 'boolean';
  if (!hasReflective && !hasGlazed) {
    return refuse('surface.flags must state isReflective, isGlazed or both, as booleans');
  }

  const id = uuid(change['surfaceId']);
  if (!id) return refuse('surface.flags needs a surface uuid');
  const row = await rowInWorld(ctx, 'wv_surface', id,
    [...CORRECTABLE_COLUMNS, 'is_reflective', 'is_glazed']);
  if (!row) return refuse(`surface:${id} is not in this world`);

  const wasReflective = row['is_reflective'] === true;
  const wasGlazed = row['is_glazed'] === true;
  const nextReflective = hasReflective ? reflective : wasReflective;
  const nextGlazed = hasGlazed ? glazed : wasGlazed;
  const g = correctedGrounding(row, null,
    nextReflective === wasReflective && nextGlazed === wasGlazed);

  await ctx.deps.db.update('wv_surface', {
    is_reflective: nextReflective, is_glazed: nextGlazed, confidence: g.confidence,
    correction_sources: withReceipt(row, ctx),
  }, { id, world_id: ctx.worldId });
  ctx.deps.log('wv_worlds_surface_flagged', {
    worldId: ctx.worldId, surfaceId: id, by: ctx.record.by,
    isReflective: nextReflective, isGlazed: nextGlazed,
  });
  return APPLIED;
}

/**
 * Reconnect an opening.
 *
 * Both sides are checked against THIS world before either is written, so a
 * half-applied reconnection is not a state this endpoint can produce. An
 * opening may connect nothing -- an external door has one side, and the
 * document treats a missing side as exterior -- but it may not connect a room
 * to itself, which is a door from the kitchen to the kitchen.
 */
async function connectOpening(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const id = uuid(change['openingId']);
  if (!id) return refuse('opening.connects needs an opening uuid');

  const sides: (string | null)[] = [];
  for (const key of ['roomA', 'roomB'] as const) {
    const raw = change[key];
    if (raw === null || raw === undefined) { sides.push(null); continue; }
    const roomId = uuid(raw);
    if (!roomId) return refuse(`opening.connects ${key} must be a room uuid or null`);
    if (!(await rowInWorld(ctx, 'wv_room', roomId, ['id']))) {
      return refuse(`no room ${roomId} in this world for this opening to connect`);
    }
    sides.push(roomId);
  }
  const roomA = sides[0] ?? null;
  const roomB = sides[1] ?? null;
  if (roomA !== null && roomA === roomB) {
    return refuse('an opening cannot connect a room to itself');
  }

  const row = await rowInWorld(ctx, 'wv_opening', id,
    [...CORRECTABLE_COLUMNS, 'room_a', 'room_b']);
  if (!row) return refuse(`opening:${id} is not in this world`);
  const g = correctedGrounding(row, null,
    (row['room_a'] ?? null) === roomA && (row['room_b'] ?? null) === roomB);

  await ctx.deps.db.update('wv_opening', {
    room_a: roomA, room_b: roomB, confidence: g.confidence,
    correction_sources: withReceipt(row, ctx),
  }, { id, world_id: ctx.worldId });
  return APPLIED;
}

/**
 * Name the door a visitor arrives at.
 *
 * Exactly one per world. Two entrances is not a richer world, it is an
 * undefined one: the viewer takes whichever node it happens to find first, so
 * the same property opens in the hall for one visitor and in the garden for
 * the next. Setting an entrance therefore clears every other one, and it
 * clears them only after the named node has been proved to be in this world --
 * otherwise a typo would leave a world with no entrance at all.
 */
async function setEntrance(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const id = uuid(change['navNodeId']);
  if (!id) return refuse('entrance.set needs a navigation node uuid');
  const node = await rowInWorld(ctx, 'wv_nav_node', id, ['id', 'is_entrance']);
  if (!node) return refuse(`nav node:${id} is not in this world`);

  await ctx.deps.db.update('wv_nav_node', { is_entrance: false }, { world_id: ctx.worldId });
  await ctx.deps.db.update('wv_nav_node', { is_entrance: true }, { id, world_id: ctx.worldId });
  ctx.deps.log('wv_worlds_entrance_set', {
    worldId: ctx.worldId, navNodeId: id, by: ctx.record.by,
  });
  return APPLIED;
}

/**
 * Record a volume nobody is sure about.
 *
 * 'inferred' means "we are not certain what is here"; 'generated' means
 * "nobody looked". Neither may be 'observed' or 'reconstructed' -- an operator
 * marking a gap is asserting the ABSENCE of evidence, and the enum member for
 * that is not the one that means a camera saw it.
 *
 * The confidences are the ones apply.ts writes, and they are declared rather
 * than computed because there is nothing to compute them from: a human
 * marking a gap is an assertion about coverage, not a measurement of it, and a
 * number that looked derived would invite somebody to treat it as derived.
 */
async function markRegion(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const mark = str(change['provenance'], 16);
  if (mark !== 'inferred' && mark !== 'generated') {
    return refuse("region.mark is either 'inferred' (uncertain) or 'generated' (nobody looked)");
  }
  const volume = boxOf(change['volume'], MAX_COORDINATE_M);
  if (!volume) return refuse('region.mark needs a finite {min, max} volume in metres');
  const reason = str(change['reason'], 300);
  if (!reason) return refuse('a coverage note must say why');

  let roomId: string | null = null;
  if (change['roomId'] !== undefined && change['roomId'] !== null) {
    roomId = uuid(change['roomId']);
    if (!roomId) return refuse('region.mark roomId must be a uuid');
    if (!(await rowInWorld(ctx, 'wv_room', roomId, ['id']))) {
      return refuse(`no room ${roomId} in this world for this coverage note`);
    }
  }

  const rows = await ctx.deps.db.insert('wv_region', {
    world_id: ctx.worldId,
    provenance: mark,
    volume,
    room_id: roomId,
    // Who recorded it, which is the only thing that makes `region.clear`
    // decidable: an operator may withdraw a note they added, and may not
    // withdraw the pipeline's record that a camera never looked there. Without
    // this column both are a uuid and a volume, and the server would have to
    // refuse every clear or allow every clear. The default is 'pipeline', so
    // every region the delivery path writes is correctly a survey fact and
    // only the ones written here are withdrawable.
    source: 'operator',
    // The operator is named in the note itself, because wv_region has nowhere
    // else to put them and a coverage note whose author is lost is a coverage
    // note nobody can question.
    reason: `${reason} (recorded by ${ctx.record.by})`,
    confidence: mark === 'generated' ? 0.1 : 0.5,
  });
  if (!rows[0]) return refuse('the coverage note could not be recorded');
  return APPLIED;
}

// ---------------------------------------------------------------------------
// Deleting — the one correction nobody can argue with afterwards
//
// Every other kind here changes what a row SAYS, and the previous value
// survives in the measurement basis, in the receipt, or in the row's own
// history. A delete ends the row. So each of the three proves the row is in
// THIS world before it removes anything, and each one reports what went with
// it: an operator who deletes a room is entitled to know, in the same breath,
// that four surfaces and two doorways went too and that the sofa did not.
//
// The cascade is the database's, not this handler's, and that is deliberate --
// a handler that deleted the children itself would be a second opinion about
// referential integrity, and the two would eventually disagree:
//
//   wv_surface.room_id        ON DELETE CASCADE    the room's walls, floor and
//                                                  ceiling go with it
//   wv_opening.room_a/room_b  ON DELETE CASCADE    a doorway into a room that
//                                                  is gone is not a doorway
//   wv_entity.room_id         ON DELETE SET NULL   the sofa survives, detached
//   wv_nav_node.room_id       ON DELETE SET NULL
//   wv_camera.room_id         ON DELETE SET NULL   the photograph was still taken
//   wv_region.room_id         ON DELETE SET NULL
//
// THE SCENE GRAPH is the one thing no foreign key could carry, because
// wv_relationship is polymorphic: subject_type/subject_id addresses a room, an
// entity, a surface or an opening. So `wv_delete_world_row` removes the edges
// naming the deleted row itself, inside the same statement, and the reports
// below count them as removed rather than as survivors.
//
// Waiting for the next build's `graph` stage to rewrite them was the
// alternative and was rejected: buildWorldDocument renders every relationship
// row it finds, and that document is what wv-ask answers from. A buyer asking
// what is next to the kitchen could be told about a room an operator deleted
// that morning precisely because it never existed -- a mirror's reflection the
// reconstruction believed in.
//
// The preview differs from the database in one place, knowingly. `applyToDocument`
// in review/src/model/apply.ts deletes a room's surfaces and LEAVES its
// openings, so that validate.ts can show the operator the doors their deletion
// breaks rather than tidying the consequence away. The database cascades those
// openings. So the preview is the more alarming of the two and the world is
// the tidier: the rows an operator was warned about are removed, never the
// other way round. Changing either side means changing a foreign key, which is
// a migration, not a handler.
// ---------------------------------------------------------------------------

/**
 * Remove one row of world content, through the only function allowed to.
 *
 * `wv_delete_world_row` is SECURITY DEFINER, granted to service_role and
 * nothing else, and resolves the table through a CASE over an allowlist rather
 * than interpolating the name; every branch filters on world_id as well as id,
 * so a future caller that forgot `requireWorldAccess` still could not reach
 * another tenant's row. The parameter type here is that same allowlist, which
 * makes a fourth table a compile error rather than an `invalid_parameter_value`
 * from Postgres at run time.
 *
 * Returns the number of rows removed: 0 means somebody else got there first.
 */
async function deleteWorldRow(
  ctx: CorrectionContext, table: 'wv_room' | 'wv_entity' | 'wv_region', id: string,
): Promise<number> {
  const removed = await ctx.deps.db.rpc<number>('wv_delete_world_row', {
    p_world: ctx.worldId, p_table: table, p_id: id,
  });
  const n = Number(removed ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The ids of rows pointing at something, for the report.
 *
 * These counts describe the deletion; they do not perform it. The limit is
 * generous rather than exact for that reason -- a room with two thousand
 * surfaces has a reconstruction problem, not a reporting one.
 */
async function idsWhere(
  ctx: CorrectionContext, table: string, eq: Record<string, string>,
): Promise<string[]> {
  const rows = await ctx.deps.db.select(table, {
    columns: ['id'], eq: { world_id: ctx.worldId, ...eq }, limit: 2000,
  });
  return rows.map((r) => String(r['id']));
}

/** "4 surfaces", "1 surface", "no surfaces". These sentences are read by people. */
function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${n === 0 ? 'no' : n} ${n === 1 ? singular : many}`;
}

/**
 * Delete a room, and say what went with it.
 *
 * The commonest real use is a phantom room a mirror invented: the
 * reconstruction saw depth through the glass, built a second living room
 * nobody can walk into, and an operator standing in the flat knows in a second
 * that it is not there. Deleting it must not also delete the real sofa the
 * reconstruction put inside it -- hence SET NULL on wv_entity.room_id, and
 * hence the report below, which counts the survivors as well as the casualties.
 */
async function deleteRoom(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const id = uuid(change['roomId']);
  if (!id) return refuse('room.delete needs a room uuid');
  const room = await rowInWorld(ctx, 'wv_room', id, ['id', 'name']);
  if (!room) return refuse(`room:${id} is not in this world`);

  // Read the consequences BEFORE the delete. Afterwards the surfaces and the
  // openings are gone and nothing can say what they were, and a report
  // assembled from what is left would count the survivors twice and the
  // casualties never.
  const [surfaces, openingsA, openingsB, entities, navNodes, cameras, regions, relA, relB] =
    await Promise.all([
      idsWhere(ctx, 'wv_surface', { room_id: id }),
      idsWhere(ctx, 'wv_opening', { room_a: id }),
      idsWhere(ctx, 'wv_opening', { room_b: id }),
      idsWhere(ctx, 'wv_entity', { room_id: id }),
      idsWhere(ctx, 'wv_nav_node', { room_id: id }),
      idsWhere(ctx, 'wv_camera', { room_id: id }),
      idsWhere(ctx, 'wv_region', { room_id: id }),
      idsWhere(ctx, 'wv_relationship', { subject_id: id }),
      idsWhere(ctx, 'wv_relationship', { object_id: id }),
    ]);
  // A doorway between two rooms names this one on either side, and it is one
  // doorway either way.
  const openings = new Set([...openingsA, ...openingsB]).size;
  // Counted BEFORE the delete, because afterwards nothing can say what they
  // were. wv_delete_world_row removes them with the row.
  const edges = new Set([...relA, ...relB]).size;

  const name = str(room['name'], 120) ?? id;
  const removed = await deleteWorldRow(ctx, 'wv_room', id);
  if (removed < 1) {
    // Someone else deleted it between the read and the write. The end state is
    // the one that was asked for, so this is not a refusal -- but it changed
    // no row in THIS request, and saying otherwise would re-render a document
    // that is already being re-rendered by whoever did the deleting.
    ctx.deps.log('wv_worlds_delete_lost_race', {
      worldId: ctx.worldId, table: 'wv_room', rowId: id, by: ctx.record.by,
    });
    return notedWith(`Room ${id} was already gone; this correction changed nothing.`);
  }

  ctx.deps.log('wv_worlds_room_deleted', {
    worldId: ctx.worldId, roomId: id, by: ctx.record.by, correctionId: ctx.record.id,
    surfaces: surfaces.length, openings,
    entitiesDetached: entities.length, navNodesDetached: navNodes.length,
    camerasDetached: cameras.length, regionsDetached: regions.length,
    relationshipsRemoved: edges,
  });

  return changedWith(
    `Deleted room "${name}": ${plural(surfaces.length, 'surface')} and `
    + `${plural(openings, 'opening')} went with it. Detached and still here: `
    + `${plural(entities.length, 'entity', 'entities')}, ${plural(navNodes.length, 'nav node')}, `
    + `${plural(cameras.length, 'camera')}, ${plural(regions.length, 'coverage note')}.`
    + (edges > 0
      ? ` ${plural(edges, 'scene-graph relationship')} referring to it went too.`
      : ''),
  );
}

/**
 * Delete an entity.
 *
 * Nothing in the schema has a foreign key to wv_entity, so an entity takes
 * nothing with it -- which is the whole difference between this and a room,
 * and worth saying rather than leaving the operator to infer it from silence.
 * The scene graph is the one exception, and it is removed by
 * wv_delete_world_row rather than by a foreign key.
 */
async function deleteEntity(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const id = uuid(change['entityId']);
  if (!id) return refuse('entity.delete needs an entity uuid');
  const entity = await rowInWorld(ctx, 'wv_entity', id, ['id', 'label']);
  if (!entity) return refuse(`entity:${id} is not in this world`);

  const [relA, relB] = await Promise.all([
    idsWhere(ctx, 'wv_relationship', { subject_id: id }),
    idsWhere(ctx, 'wv_relationship', { object_id: id }),
  ]);
  const edges = new Set([...relA, ...relB]).size;

  const label = str(entity['label'], 120) ?? id;
  const removed = await deleteWorldRow(ctx, 'wv_entity', id);
  if (removed < 1) {
    ctx.deps.log('wv_worlds_delete_lost_race', {
      worldId: ctx.worldId, table: 'wv_entity', rowId: id, by: ctx.record.by,
    });
    return notedWith(`Entity ${id} was already gone; this correction changed nothing.`);
  }

  ctx.deps.log('wv_worlds_entity_deleted', {
    worldId: ctx.worldId, entityId: id, by: ctx.record.by, correctionId: ctx.record.id,
    relationshipsRemoved: edges,
  });

  return changedWith(
    `Deleted "${label}". No room, surface or opening referred to it, so nothing went with it.`
    + (edges > 0
      ? ` ${plural(edges, 'scene-graph relationship')} naming it went too.`
      : ''),
  );
}

/**
 * Withdraw a coverage note an operator added.
 *
 * A 'pipeline' region is the record that a camera never looked behind the
 * wardrobe. It is refused by name, because the remedy for a survey gap is a
 * rescan and not an operator's confidence -- and because that record is
 * precisely the kind this product exists to preserve. `applyToDocument` refuses
 * the same case in the same words, so the preview and the world agree; it
 * tells an operator region from a pipeline one by an `rg_` id prefix it
 * synthesised itself, while the server reads `wv_region.source`, which is the
 * durable answer.
 *
 * An unreadable or unrecognised `source` is treated as 'pipeline'. That is
 * fail-closed on purpose: a region whose origin cannot be established must not
 * be deletable on the strength of not knowing.
 */
async function clearRegion(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const id = uuid(change['regionId']);
  if (!id) return refuse('region.clear needs a region uuid');
  const region = await rowInWorld(ctx, 'wv_region', id, ['id', 'source', 'provenance']);
  if (!region) return refuse(`region:${id} is not in this world`);

  const source = str(region['source'], 16);
  if (source !== 'operator') {
    return refuse(
      `region:${id} was recorded by the pipeline, not by an operator, so it cannot be cleared. `
      + 'It is the record that no camera looked there, and the remedy for that is a rescan.',
    );
  }

  const removed = await deleteWorldRow(ctx, 'wv_region', id);
  if (removed < 1) {
    ctx.deps.log('wv_worlds_delete_lost_race', {
      worldId: ctx.worldId, table: 'wv_region', rowId: id, by: ctx.record.by,
    });
    return notedWith(`Coverage note ${id} was already gone; this correction changed nothing.`);
  }

  ctx.deps.log('wv_worlds_region_cleared', {
    worldId: ctx.worldId, regionId: id, by: ctx.record.by, correctionId: ctx.record.id,
    provenance: region['provenance'] ?? null,
  });
  return changedWith(`Withdrew the operator coverage note ${id}. The volume is no longer flagged.`);
}

/**
 * Redact something the detectors missed.
 *
 * The row starts `applied: false` and that is not an oversight: applying a
 * redaction means re-rendering frame pixels, which is the `redact` stage's
 * job on a GPU, not something an HTTP handler can do. What this writes is the
 * INSTRUCTION -- reviewed by a named person at a known time -- and the next
 * build honours it. An endpoint that flipped `applied` to true would be
 * claiming a face had been blurred when the pixels still show it.
 *
 * The camera is required and must be in this world: a bounding box is in image
 * pixels, so a redaction with no frame redacts nothing at all.
 *
 * `redaction.add` is the one kind here that `CorrectionChange` does not have a
 * member for, because the review editor does not yet emit it. Its shape is
 * `{ kind: 'redaction.add', cameraId, redactionKind, bbox: [x, y, w, h] }`,
 * named to match the union's conventions so that adding it there later is a
 * type, not a translation.
 */
async function addRedaction(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const kind = str(change['redactionKind'], 40);
  if (!kind || !REDACTION_KINDS.has(kind)) {
    return refuse(`'${kind ?? ''}' is not something this system knows how to redact`);
  }
  const cameraId = uuid(change['cameraId']);
  if (!cameraId) return refuse('redaction.add needs the camera uuid whose frame it is in');
  if (!(await rowInWorld(ctx, 'wv_camera', cameraId, ['id']))) {
    return refuse(`camera:${cameraId} is not in this world`);
  }

  const bbox = change['bbox'];
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return refuse('redaction.add needs a bbox of [x, y, w, h] in image pixels');
  }
  const box: number[] = [];
  for (const v of bbox) {
    const n = finiteNum(v);
    // Pixels, so negative coordinates and a 100 000-pixel box are both nonsense.
    if (n === null || n < 0 || n > 100000) return refuse('a bbox is four non-negative pixel values');
    box.push(n);
  }
  if ((box[2] ?? 0) <= 0 || (box[3] ?? 0) <= 0) {
    return refuse('a redaction box with no width or height covers nothing');
  }

  const rows = await ctx.deps.db.insert('wv_redaction', {
    world_id: ctx.worldId,
    camera_id: cameraId,
    kind,
    bbox: box,
    // The detector IS the operator here, and saying so keeps the audit honest:
    // a model's 0.82 and a person's certainty must not be mistaken for each
    // other in the review queue.
    detector: 'operator',
    score: null,
    applied: false,
    reviewed_by: ctx.record.by,
    reviewed_at: ctx.record.at,
  });
  if (!rows[0]) return refuse('the redaction could not be recorded');
  ctx.deps.log('wv_worlds_redaction_added', {
    worldId: ctx.worldId, cameraId, kind, by: ctx.record.by,
  });
  return APPLIED;
}

// ---------------------------------------------------------------------------
// Dimensions — the rule that a bare number never leaves this system
// ---------------------------------------------------------------------------

/**
 * The world's measurement policy, recovered from its rooms.
 *
 * This is the same recovery `buildWorldDocument` does, and it is done the same
 * way for the same reason: the schema denormalises the policy onto every room
 * as `max(policy, geometric)`, so the policy floor is the MINIMUM across
 * rooms. Taking the first room's value instead would inflate every other
 * room's tolerance to match the narrowest one.
 *
 * The fallbacks -- 3% and 25 mm -- are that file's fallbacks too. A world with
 * no stored tolerances is a world nothing has measured yet, and a correction
 * to it still has to produce a tolerance from somewhere honest.
 */
async function recoverMeasurementPolicy(
  worldId: string, deps: WorldsDeps,
): Promise<MeasurementPolicy> {
  const rooms = await deps.db.select('wv_room', {
    columns: ['area_standard', 'area_tol_pct', 'wall_tol_mm'],
    eq: { world_id: worldId },
    limit: 500,
  });
  const areas: number[] = [];
  const walls: number[] = [];
  let standard: string | null = null;
  for (const r of rooms) {
    const a = finiteNum(r['area_tol_pct']);
    if (a !== null && a > 0) areas.push(a);
    const w = finiteNum(r['wall_tol_mm']);
    if (w !== null && w > 0) walls.push(w);
    if (!standard && typeof r['area_standard'] === 'string' && r['area_standard']) {
      standard = r['area_standard'];
    }
  }
  return {
    areaStandard: standard ?? 'CLEAR-INTERNAL',
    areaTolerancePct: areas.length > 0 ? Math.min(...areas) : 3,
    wallToleranceMm: walls.length > 0 ? Math.min(...walls) : 25,
  };
}

/**
 * The half-width a corrected number carries. `correctedQuantity` in
 * provenance.ts, branch for branch.
 *
 * A declared site measurement is the one place a human correction makes a
 * number BETTER than the reconstruction, and it is gated on naming an
 * instrument the certificate then prints. An estimate gets the document policy
 * widened by the provenance factor -- the same arithmetic the engine applies
 * to any inferred length -- because someone reading a floorplan has not
 * measured anything.
 */
function correctedTolerance(
  unit: 'm' | 'm2', value: number, instrumentMm: number | null,
  policyTolerance: number, provenance: Provenance,
): { tolerance: number; toleranceUnit: 'mm' | 'pct' } {
  if (instrumentMm !== null && unit === 'm') {
    return { tolerance: instrumentMm, toleranceUnit: 'mm' };
  }
  if (instrumentMm !== null) {
    // An area measured on site is two length readings multiplied, so the
    // relative half-widths add: 3 mm on each of two ~4 m sides is about 0.15%
    // on the product. Derived from the value rather than declared, so it
    // tracks the room's actual size.
    const side = Math.sqrt(Math.max(value, 1e-6));
    return {
      tolerance: Math.max(0.1, (2 * (instrumentMm / 1000) / side) * 100),
      toleranceUnit: 'pct',
    };
  }
  return {
    tolerance: policyTolerance * (PROVENANCE_TOLERANCE_FACTOR[provenance] ?? 2),
    toleranceUnit: unit === 'm2' ? 'pct' : 'mm',
  };
}

/**
 * The `basis` a corrected dimension carries into wv_measurement.
 *
 * `wv_measurement.basis` is documented as "the geometry that produced it, so a
 * measurement certificate can be reissued and defended", and for a human
 * number the honest answer to "what produced it" is a person, a method and an
 * instrument. So the basis carries all three, plus the value it superseded, so
 * that the reconstruction's answer and the operator's answer both survive and
 * a dispute can be read rather than reconstructed.
 *
 * `defensible` is true for a declared site measurement with a named instrument
 * and false for everything else, and the viewer's formatter reads exactly that
 * field -- so an estimate renders as indicative everywhere with no cooperation
 * needed from the display layer.
 */
function correctionBasis(
  ctx: CorrectionContext,
  method: string,
  instrument: string,
  defensible: boolean,
  superseded: { value: number | null; standard: string | null; tolerance: number | null; toleranceUnit: string | null } | null,
): Row {
  const basis: Row = {
    corrected: true,
    correctionId: ctx.record.id,
    statedBy: ctx.record.by,
    statedAt: ctx.record.at,
    method,
    instrument,
    defensible,
  };
  if (superseded && superseded.value !== null) {
    basis['supersededValue'] = superseded.value;
    basis['supersededStandard'] = superseded.standard;
    basis['supersededTolerance'] = superseded.tolerance;
    basis['supersededToleranceUnit'] = superseded.toleranceUnit;
  }
  if (!defensible) {
    basis['refusalReason'] = method === 'site-measure'
      ? 'an operator declared this a site measurement but named no instrument, so its accuracy is undeclared'
      : 'this figure was entered by an operator as an estimate, not measured';
  }
  if (ctx.record.note) basis['note'] = ctx.record.note;
  return basis;
}

/**
 * Set a dimension a human measured or estimated.
 *
 * THE RULE THIS IMPLEMENTS: a number alone never enters the system. Every
 * corrected dimension writes two things -- the value on the row, so the world
 * reads correctly, and a wv_measurement row carrying the standard, the
 * tolerance, its unit, the confidence and the basis, so the number can be
 * defended. Writing only the first is what makes a published dimension a
 * liability; there is no path here that does it.
 *
 * One asymmetry worth stating. wv_room stores its own `area_tol_pct` and
 * wv_opening stores no tolerance at all, so for an opening the measurement row
 * is the ONLY carrier of the half-width. That is not a gap being papered over
 * -- it is why the measurement row is mandatory rather than an extra.
 */
async function setDimension(
  change: Record<string, unknown>, ctx: CorrectionContext,
): Promise<Outcome> {
  const target = typeof change['target'] === 'object' && change['target'] !== null
    && !Array.isArray(change['target'])
    ? change['target'] as Record<string, unknown>
    : null;
  const targetKind = target ? str(target['kind'], 40) : null;
  if (!target || !targetKind) return refuse('dimension.set needs a target');

  const method = str(change['method'], 16);
  if (method !== 'estimate' && method !== 'site-measure') {
    return refuse("dimension.set needs a method of 'estimate' or 'site-measure'");
  }
  const instrument = str(change['instrument'], 16) ?? 'unknown';
  const declaredMm = instrumentToleranceMm(instrument);
  if (declaredMm === undefined) {
    return refuse(`'${instrument}' is not an instrument this system knows`);
  }
  // A site measurement with no instrument named is still just somebody's word
  // for it, so it gets the estimate's treatment and says why in the basis.
  const instrumentMm = method === 'site-measure' ? declaredMm : null;
  const defensible = instrumentMm !== null;
  const isArea = targetKind === 'room.area';

  const value = positive(change['value'], isArea ? MAX_AREA_M2 : MAX_LENGTH_M);
  if (value === null) {
    // apply.ts skips a non-positive dimension, so this refuses the same ones:
    // a preview an operator approved must be the world they get.
    return refuse(`dimension.set ${targetKind} needs a positive number of ${isArea ? 'square metres' : 'metres'}`);
  }
  const policy = await ctx.policy();

  if (isArea) {
    const id = uuid(target['roomId']);
    if (!id) return refuse('dimension.set room.area needs a room uuid');
    const row = await rowInWorld(ctx, 'wv_room', id,
      [...CORRECTABLE_COLUMNS, 'area_m2', 'area_standard', 'area_tol_pct']);
    if (!row) return refuse(`room:${id} is not in this world`);

    const previous = finiteNum(row['area_m2']);
    const g = correctedGrounding(row, 'inferred',
      previous !== null && Math.abs(previous - value) < 1e-6);
    const standard = str(change['standard'], 40)
      ?? (typeof row['area_standard'] === 'string' ? row['area_standard'] : null)
      ?? policy.areaStandard;
    const tol = correctedTolerance('m2', value, instrumentMm, policy.areaTolerancePct, g.provenance);

    // The STORED tolerance never tightens below what the pipeline put there,
    // even when the operator's laser genuinely supports a narrower one. That
    // is a deliberate trade and it is not about this room: worldDocument.ts
    // recovers the world's area policy as the minimum of these columns, on the
    // documented invariant that every stored value is >= the policy, and a
    // single 0.15% room would quietly retighten the tolerance quoted for every
    // SURFACE in the property. The defensible half-width is not lost -- it is
    // in the measurement row below, which is what a certificate is issued
    // from, while the column keeps meaning what the rest of the system reads
    // it as meaning.
    const storedTol = Math.max(tol.tolerance, finiteNum(row['area_tol_pct']) ?? 0);

    await ctx.deps.db.update('wv_room', {
      area_m2: value,
      area_standard: standard,
      area_tol_pct: storedTol,
      provenance: g.provenance,
      confidence: g.confidence,
      // A dimension records its receipt twice, and both are load-bearing:
      // wv_measurement.basis is what a certificate is reissued from, and this
      // column is what makes the ROW itself read as human-corrected in the
      // document. Before it existed, a corrected area looked exactly like a
      // pipeline-measured one to anything that did not open the measurement.
      correction_sources: withReceipt(row, ctx),
    }, { id, world_id: ctx.worldId });

    await writeMeasurement(ctx, {
      kind: 'area',
      a: { type: 'room', id, field: 'area' },
      value,
      unit: 'm2',
      standard,
      tolerance: tol.tolerance,
      tolerance_unit: tol.toleranceUnit,
      confidence: g.confidence,
      basis: correctionBasis(ctx, method, instrument, defensible, {
        value: previous,
        standard: typeof row['area_standard'] === 'string' ? row['area_standard'] : null,
        tolerance: finiteNum(row['area_tol_pct']),
        toleranceUnit: 'pct',
      }),
    });
    return APPLIED;
  }

  if (targetKind === 'room.ceilingHeight') {
    const id = uuid(target['roomId']);
    if (!id) return refuse('dimension.set room.ceilingHeight needs a room uuid');
    const row = await rowInWorld(ctx, 'wv_room', id,
      [...CORRECTABLE_COLUMNS, 'floor_z', 'ceiling_z']);
    if (!row) return refuse(`room:${id} is not in this world`);

    // The height is a difference, not a column: the room stores two planes.
    // The floor stays where the reconstruction put it and the ceiling moves,
    // because an operator measuring floor to ceiling is measuring the ceiling.
    const floorZ = finiteNum(row['floor_z']) ?? 0;
    const previousCeiling = finiteNum(row['ceiling_z']);
    const previousHeight = previousCeiling === null ? null : previousCeiling - floorZ;
    const g = correctedGrounding(row, 'inferred',
      previousHeight !== null && Math.abs(previousHeight - value) < 1e-6);
    const tol = correctedTolerance('m', value, instrumentMm, policy.wallToleranceMm, g.provenance);
    // CLEAR-INTERNAL, face to face: RICS GIA and IPMS are AREA standards and
    // labelling a floor-to-ceiling height with one is a category error.
    const standard = str(change['standard'], 40) ?? 'CLEAR-INTERNAL';

    await ctx.deps.db.update('wv_room', {
      ceiling_z: floorZ + value,
      // wall_tol_mm is deliberately untouched: it is this world's wall policy,
      // recovered as a minimum across rooms, not this measurement's tolerance.
      provenance: g.provenance,
      confidence: g.confidence,
      correction_sources: withReceipt(row, ctx),
    }, { id, world_id: ctx.worldId });

    await writeMeasurement(ctx, {
      kind: 'height',
      a: { type: 'room', id, field: 'ceilingHeight' },
      value,
      unit: 'm',
      standard,
      tolerance: tol.tolerance,
      tolerance_unit: tol.toleranceUnit,
      confidence: g.confidence,
      basis: correctionBasis(ctx, method, instrument, defensible, {
        value: previousHeight, standard: 'CLEAR-INTERNAL',
        tolerance: policy.wallToleranceMm, toleranceUnit: 'mm',
      }),
    });
    return APPLIED;
  }

  const column = targetKind === 'opening.width' ? 'width_m'
    : targetKind === 'opening.height' ? 'height_m'
      : targetKind === 'opening.sill' ? 'sill_m' : null;
  if (!column) return refuse(`'${targetKind}' is not a dimension this endpoint can set`);

  const id = uuid(target['openingId']);
  if (!id) return refuse(`dimension.set ${targetKind} needs an opening uuid`);
  const row = await rowInWorld(ctx, 'wv_opening', id, [...CORRECTABLE_COLUMNS, column]);
  if (!row) return refuse(`opening:${id} is not in this world`);

  const previous = finiteNum(row[column]);
  const g = correctedGrounding(row, 'inferred',
    previous !== null && Math.abs(previous - value) < 1e-6);
  const tol = correctedTolerance('m', value, instrumentMm, policy.wallToleranceMm, g.provenance);
  const standard = str(change['standard'], 40) ?? 'CLEAR-INTERNAL';

  await ctx.deps.db.update('wv_opening', {
    [column]: value, provenance: g.provenance, confidence: g.confidence,
    correction_sources: withReceipt(row, ctx),
  }, { id, world_id: ctx.worldId });

  await writeMeasurement(ctx, {
    // A width is a distance across the reveal; a height and a sill are both
    // heights above the floor. `wv_measurement.kind` has no 'width', and
    // inventing one here would make the column mean two different things.
    kind: targetKind === 'opening.width' ? 'distance' : 'height',
    a: { type: 'opening', id, field: targetKind.slice('opening.'.length) },
    value,
    unit: 'm',
    standard,
    tolerance: tol.tolerance,
    tolerance_unit: tol.toleranceUnit,
    confidence: g.confidence,
    basis: correctionBasis(ctx, method, instrument, defensible, {
      value: previous, standard: 'CLEAR-INTERNAL',
      tolerance: policy.wallToleranceMm, toleranceUnit: 'mm',
    }),
  });
  return APPLIED;
}

/** One measurement row, scoped to the world. */
async function writeMeasurement(ctx: CorrectionContext, values: Row): Promise<void> {
  await ctx.deps.db.insert('wv_measurement', { world_id: ctx.worldId, ...values });
}

/**
 * Apply a list of corrections to one world, in order, each one validated on
 * its own and each one reported on its own.
 *
 * The list is not a transaction and does not pretend to be: `Db` speaks
 * PostgREST, which has no multi-statement transaction, so fifteen corrections
 * are fifteen writes. That is why every correction is independently valid --
 * a batch that stops half way leaves a world where each applied correction is
 * individually true, rather than a world that is half way through a change.
 * The response says exactly which ones did not land and why, so the editor can
 * put them back in front of the operator instead of losing them.
 */
async function approveCorrections(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireWorldAccess(body['worldId'], caller, deps);
  if (!access.ok) return access.res;

  if (!MAY_CHANGE_WORLD.has(access.role)) {
    return fail(403, 'Your role cannot change what this world says about the property. '
      + 'Ask an operator, admin or owner.');
  }

  const corrections = Array.isArray(body['corrections']) ? body['corrections'] : [];
  if (corrections.length === 0) return fail(400, 'No corrections supplied.');
  if (corrections.length > MAX_CORRECTIONS) return fail(400, 'Too many corrections in one request.');

  // Recovered at most once per request, and only if a dimension correction
  // asks for it. It is one select over the world's rooms; doing it per
  // correction would make a batch of forty dimensions forty scans of the same
  // table for an answer that cannot change while the loop runs.
  let policy: MeasurementPolicy | null = null;
  const policyOnce = async (): Promise<MeasurementPolicy> => {
    if (!policy) policy = await recoverMeasurementPolicy(access.worldId, deps);
    return policy;
  };

  // One timestamp for the whole request. Corrections approved together were
  // decided together, and a receipt that drifts by milliseconds across a batch
  // invites somebody to read an order into it that does not exist.
  const at = deps.clock.now().toISOString();

  let applied = 0;
  let changed = 0;
  const rejected: string[] = [];
  // One sentence per correction that removed something, naming what went with
  // it. Only the deletes produce these: renaming a room describes itself, but
  // "I deleted a room" does not say that four surfaces and two doorways went
  // too, and that is exactly what the operator needs to read back.
  const cascades: string[] = [];
  for (const raw of corrections) {
    const normalised = normaliseCorrection(raw, deps.randomId);
    if (!normalised.ok) { rejected.push(normalised.reason); continue; }

    const outcome = await applyChange(normalised.change, {
      worldId: access.worldId,
      deps,
      record: {
        id: normalised.recordId,
        at,
        // The caller as `authUser` verified them, never a value from the body.
        by: caller.id,
        ...(normalised.note ? { note: normalised.note } : {}),
      },
      policy: policyOnce,
    });
    if (!outcome.ok) { rejected.push(outcome.reason); continue; }
    applied += 1;
    if (outcome.changed) changed += 1;
    if (outcome.detail) cascades.push(outcome.detail);
  }

  // Once, after the loop, and only if a row actually changed. The cached
  // document is a rendering of these rows, so a correction has invalidated it;
  // marking it stale is one indexed update of one row, and the re-render is
  // paid for lazily by whoever reads the world next. An operator correcting
  // fifteen rooms marks it stale once and re-renders once. A sign-off, which
  // changes no row, marks nothing.
  //
  // A DELETE counts here like any other change, and it is the one where
  // getting this wrong would be most visible: a document cached before the
  // deletion still contains the room, its walls and its doorways, so a viewer
  // reading the stale copy would walk into a room the database no longer has.
  // Deletes return `changed: true` for exactly that reason -- and a delete
  // that removed nothing, because someone else got there first, returns
  // `changed: false`, because this request did not invalidate anything.
  if (changed > 0) {
    await markWorldDocumentStale(deps, access.worldId, 'operator correction');
  }

  deps.log('wv_worlds_corrections', {
    worldId: access.worldId, userId: caller.id, applied, changed, rejected: rejected.length,
  });
  return json({ applied, changed, rejected, cascades });
}

// ---------------------------------------------------------------------------
// Publication — the gate
// ---------------------------------------------------------------------------

async function publish(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireWorldAccess(body['worldId'], caller, deps);
  if (!access.ok) return access.res;
  // Refused before the quality gate is even read: publication is the moment a
  // stranger's home becomes a public URL, and who may take that step is a
  // property of the person, not of the world's score.
  if (!MAY_CHANGE_WORLD.has(access.role)) {
    return fail(403, 'Your role cannot publish a property to the public web. Ask an operator, admin or owner.');
  }

  const quality = await deps.db.select('wv_quality', {
    columns: ['verdict', 'score', 'checks', 'created_at'],
    eq: { world_id: access.worldId },
    order: { column: 'created_at', ascending: false },
    limit: 1,
  });
  const latest = quality[0];

  // No quality row at all is a refusal, not a default-allow. A world that was
  // never assessed is indistinguishable from one that failed.
  if (!latest) {
    return fail(409, 'This world has not been through the quality gate yet.');
  }
  if (latest['verdict'] !== 'pass') {
    const failed = Array.isArray((latest['checks'] as { name?: string }[] | undefined))
      ? (latest['checks'] as { name?: string; pass?: boolean }[])
        .filter((c) => c.pass === false).map((c) => c.name).filter(Boolean)
      : [];
    return fail(409, failed.length > 0
      ? `Quality verdict is "${latest['verdict']}". Failing checks: ${failed.join(', ')}.`
      : `Quality verdict is "${latest['verdict']}", so this world cannot be published.`);
  }

  const desiredSlug = asSlug(body['slug']);
  if (desiredSlug) {
    const clash = await deps.db.select('wv_world', {
      columns: ['id'], eq: { slug: desiredSlug }, limit: 1,
    });
    if (clash[0] && clash[0]['id'] !== access.worldId) {
      return fail(409, 'That link is already in use.');
    }
  }

  const now = deps.clock.now().toISOString();
  await deps.db.update('wv_world', {
    status: 'published',
    published_at: now,
    quality_score: latest['score'] ?? null,
    ...(desiredSlug ? { slug: desiredSlug } : {}),
  }, { id: access.worldId });

  // Render AFTER the world row is updated, never before: publication state,
  // the slug and published_at all appear in the document, and the update above
  // fires the trigger that marks whatever was cached stale. Rendering here
  // means the object exists the moment the link does, so the first visitor
  // does not pay for thirteen selects.
  try {
    await renderWorldDocument(deps, access.worldId);
  } catch (err) {
    // The world IS published; only its cache is missing. The trigger has
    // already marked the entry stale, so the next reader re-renders from the
    // rows. Failing the publish because storage blinked would be the wrong
    // trade: the authority for the document is the database, not the file.
    deps.log('wv_worlds_document_render_failed', { worldId: access.worldId, error: String(err) });
  }

  deps.log('wv_worlds_published', { worldId: access.worldId, userId: caller.id, score: latest['score'] });
  return json({ published: true, worldId: access.worldId, publishedAt: now, slug: desiredSlug ?? null });
}

async function unpublish(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireWorldAccess(body['worldId'], caller, deps);
  if (!access.ok) return access.res;
  // Gated at the same level as publish rather than lower. Taking a live
  // listing offline is not a safe default: it is somebody's property
  // disappearing from the market mid-viewing, and it wants the same hand.
  if (!MAY_CHANGE_WORLD.has(access.role)) {
    return fail(403, 'Your role cannot take a published property offline. Ask an operator, admin or owner.');
  }
  await deps.db.update('wv_world', { status: 'review', published_at: null }, { id: access.worldId });
  // Publication state is IN the document, so a cached copy from while it was
  // live still says `publishedAt: ...`. Anything reading the cache after an
  // unpublish must re-render or it will describe a world that is no longer
  // public.
  await markWorldDocumentStale(deps, access.worldId, 'world unpublished');
  deps.log('wv_worlds_unpublished', { worldId: access.worldId, userId: caller.id });
  return json({ published: false });
}

// ---------------------------------------------------------------------------
// Membership
//
// `wv_member` is select-only to `authenticated`, so every write here has to be
// an action. The rules are the boring ones that keep an account recoverable
// and are enforced in this file, not in the console: an org must keep an
// owner, nobody may promote themselves, and nobody may act on somebody more
// senior. Each one is a separate check with its own sentence, because "no"
// without a reason is how an admin concludes the product is broken.
//
// What is NOT a rule here, and used to be: a blanket ban on touching your own
// membership. A person may lower their own role and may leave the
// organisation. Refusing that never protected anything -- the last-owner check
// is what stops an org being emptied of everybody who could fix it, and it
// binds the person themselves exactly as hard as it binds an admin acting on
// them. `canAssignRole` and `canRemoveMember` in
// spatial/packages/console-ui/src/logic/roles.ts compute the same answers,
// check for check and sentence for sentence, so the console never offers a
// control this file will refuse. Two locks, one key -- and this is the lock.
// ---------------------------------------------------------------------------

async function listMembers(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireOrgAccess(body['orgId'], caller, deps);
  if (!access.ok) return access.res;

  // Every member may see who else is in their org -- that is exactly what the
  // `wv_member_read` policy already allows over PostgREST. `email` is the
  // denormalised display field added by the server-API migration; it is
  // readable here for the same reason the role is, and `auth.users` stays shut.
  const rows = await deps.db.select('wv_member', {
    columns: ['user_id', 'email', 'role', 'created_at'],
    eq: { org_id: access.orgId },
    order: { column: 'created_at', ascending: true },
    limit: 500,
  });
  return json({ members: rows, callerRole: access.role, callerUserId: caller.id });
}

/** The members of an org, and how many owners it has. One query, two answers. */
async function membersOf(orgId: string, deps: WorldsDeps): Promise<Row[]> {
  return deps.db.select('wv_member', {
    columns: ['user_id', 'role', 'email', 'created_at'],
    eq: { org_id: orgId },
    limit: 500,
  });
}

function ownerCount(members: readonly Row[]): number {
  return members.filter((m) => String(m['role']) === 'owner').length;
}

async function inviteMember(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireOrgAccess(body['orgId'], caller, deps);
  if (!access.ok) return access.res;
  if (!MAY_MANAGE_MEMBERS.has(access.role)) {
    return fail(403, 'Your role cannot add people to this organisation.');
  }

  const email = asEmail(body['email']);
  if (!email) return fail(400, 'A valid email address is required.');
  const role = asMemberRole(body['role'] ?? 'operator');
  if (!role) return fail(400, 'Unknown role.');
  if (role === 'owner' && access.role !== 'owner') {
    return fail(403, 'Only an owner can make someone else an owner.');
  }

  // The lookup is a security-definer function granted to service_role alone.
  // It is the ONLY thing in this system that reads auth.users, it returns an
  // id and nothing else, and it is not reachable by a signed-in browser -- so
  // adding a member does not become a way to ask the platform who has an
  // account.
  const userId = uuid(await deps.db.rpc<string | null>('wv_user_id_by_email', { p_email: email }));
  if (!userId) {
    deps.log('wv_worlds_invite_unknown_email', { orgId: access.orgId, userId: caller.id });
    return fail(404, 'No M3XI account uses that address yet. Ask them to sign up, then add them.');
  }

  const existing = await deps.db.select('wv_member', {
    columns: ['user_id', 'role'], eq: { org_id: access.orgId, user_id: userId }, limit: 1,
  });
  if (existing[0]) return fail(409, 'They are already in this organisation.');

  await deps.db.insert('wv_member', {
    org_id: access.orgId, user_id: userId, role, email,
  });
  deps.log('wv_worlds_member_invited', {
    orgId: access.orgId, actor: caller.id, member: userId, role,
  });
  return json({ member: { user_id: userId, email, role } }, 201);
}

async function setMemberRole(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireOrgAccess(body['orgId'], caller, deps);
  if (!access.ok) return access.res;
  if (!MAY_MANAGE_MEMBERS.has(access.role)) {
    return fail(403, 'Your role cannot change other people’s roles.');
  }

  const targetId = uuid(body['userId']);
  if (!targetId) return fail(400, 'userId required.');
  const next = asMemberRole(body['role']);
  if (!next) return fail(400, 'Unknown role.');

  const members = await membersOf(access.orgId, deps);
  const target = members.find((m) => String(m['user_id']) === targetId);
  if (!target) return fail(404, 'Not found.');

  const isSelf = targetId === caller.id;
  const current = String(target['role']);
  if (current === next) {
    return fail(409, isSelf ? 'That is already your role.' : 'That is already their role.');
  }

  // SELF-ESCALATION, and only self-escalation. An admin who can make
  // themselves an owner is not an admin, so a raise is refused.
  //
  // A LOWERING is allowed, and this used to be refused along with it. The
  // blanket ban was the wrong rule: it meant the only way to stop being an
  // owner was to ask somebody else to do it for you, which is worse for
  // security, not better -- people keep the role they meant to give up. What
  // actually keeps an account recoverable is the last-owner check further
  // down, which applies to everybody including the person stepping down.
  // Ranks are a total order, so after the equality check above "not lower" is
  // exactly "higher".
  if (isSelf && rank(next) > rank(current)) {
    return fail(403, 'You cannot give yourself a higher role. Ask another owner or admin.');
  }
  if (rank(current) > rank(access.role)) {
    return fail(403, `Only an owner can change an ${current}’s role.`);
  }
  if (next === 'owner' && access.role !== 'owner') {
    return fail(403, 'Only an owner can make someone else an owner.');
  }
  if (current === 'owner' && ownerCount(members) <= 1) {
    // The one rule that binds the person themselves as hard as it binds
    // anybody else: an org with no owner has nobody who can fix it.
    return fail(409, isSelf
      ? 'You are the last owner. Make someone else an owner before you step down.'
      : 'This is the last owner. Make someone else an owner first.');
  }

  await deps.db.update('wv_member', { role: next }, {
    org_id: access.orgId, user_id: targetId,
  });
  deps.log('wv_worlds_member_role_changed', {
    orgId: access.orgId, actor: caller.id, member: targetId, from: current, to: next, self: isSelf,
  });
  return json({ member: { user_id: targetId, role: next } });
}

async function removeMember(
  body: Record<string, unknown>, caller: Caller, deps: WorldsDeps,
): Promise<HttpResponse> {
  const access = await requireOrgAccess(body['orgId'], caller, deps);
  if (!access.ok) return access.res;
  if (!MAY_MANAGE_MEMBERS.has(access.role)) {
    return fail(403, 'Your role cannot remove members.');
  }

  const targetId = uuid(body['userId']);
  if (!targetId) return fail(400, 'userId required.');

  const members = await membersOf(access.orgId, deps);
  const target = members.find((m) => String(m['user_id']) === targetId);
  if (!target) return fail(404, 'Not found.');

  // Leaving is stepping down carried to its end, and it is allowed for the
  // same reason: the last-owner rule below is what keeps an org recoverable,
  // not a ban on touching your own row. The console offers this as "Leave"
  // rather than "Remove" when the target is the caller -- same action, same
  // rules, different word, because nobody removes themselves.
  //
  // The capability check above still applies to a self-removal, and
  // deliberately: `canRemoveMember` in console-ui/src/logic/roles.ts requires
  // the same one. Membership is a write to wv_member whichever row it touches,
  // and a viewer who wants out asks an admin.
  const isSelf = targetId === caller.id;
  const role = String(target['role']);
  if (rank(role) > rank(access.role)) {
    return fail(403, `Only an owner can remove an ${role}.`);
  }
  if (role === 'owner' && ownerCount(members) <= 1) {
    return fail(409, isSelf
      ? 'You are the last owner. Make someone else an owner before you leave.'
      : 'This is the last owner. Make someone else an owner first.');
  }

  // The row is deleted rather than flagged, and that is a deliberate choice.
  // Every membership predicate in ..._rls.sql -- `wv_is_member`, and through
  // it `wv_can_write_world` and every policy on every wv_ table -- asks only
  // whether a row exists. A soft delete would mean each of those has to also
  // test a flag, and the one that forgets still grants access to somebody who
  // was removed. Deleting fails closed; flagging fails open.
  //
  // `Db` has no delete, because nothing else in this system ever needed one,
  // so the single statement lives in a security-definer function granted to
  // service_role alone. The rules above stay here, in the code that can be
  // tested; the function does one DELETE and decides nothing.
  const removedRows = await deps.db.rpc<number>('wv_remove_member', {
    p_org: access.orgId, p_user: targetId,
  });
  if (Number(removedRows ?? 0) < 1) {
    // Someone else removed them between the read and the write. The end state
    // is the one that was asked for, so this is not an error.
    deps.log('wv_worlds_member_already_removed', { orgId: access.orgId, member: targetId });
  }
  deps.log('wv_worlds_member_removed', {
    orgId: access.orgId, actor: caller.id, member: targetId, role, self: isSelf,
  });
  return json({ removed: true, userId: targetId });
}
