/**
 * wv-view — the public viewer surface.
 *
 * This is the only endpoint anonymous traffic touches, so it is written as if
 * every request were hostile, because some of them are.
 *
 *   POST /             the manifest, and the session everything else meters on
 *   GET  /world.json   the published WorldDocument a shared link opens
 *   POST /events       what the visitor did, bound to their own session
 *
 * Three properties it must hold, in order of how badly they fail:
 *
 * 1. NOTHING LEAKS ACROSS TENANTS. It serves published worlds and nothing
 *    else. A draft, a failed build, another org's property and a world that
 *    does not exist all return the same 404 with the same body, because a
 *    distinguishable error is an oracle for enumerating every customer's
 *    portfolio by slug. Every route resolves its world through the same single
 *    published-only query, so there is one place for that to be true.
 *
 * 2. NOTHING INTERNAL LEAVES. RLS denies anon everything, so this function
 *    runs as the service role and column filtering is the ONLY control left.
 *    The allowlists below are that control. Storage paths, org ids, worker
 *    ids, costs, lead details and capture provenance never appear in a
 *    manifest; assets leave as short-lived signed URLs, never as paths. The
 *    world document is a rendering of the same rows and gets the same
 *    treatment on its way out: public roles only, signed URLs in place of
 *    `asset://` paths, no capture ids, and the same forbidden-key sweep.
 *
 * 3. IT CANNOT BE USED AS A WRITE PRIMITIVE. It creates exactly two kinds of
 *    row and neither can be aimed. A session has a server-generated id, an
 *    opaque viewer key and no caller-controlled foreign keys. An event binds
 *    to a session the caller must hold that key for; its world is read off the
 *    session row and a world id in the body is ignored entirely; its room id
 *    is checked against that world; its timestamp is clamped into the
 *    session's own lifetime; and both the size of a batch and the number of
 *    rows a session may ever write are capped, so wv_event cannot be used as
 *    free storage or as a way to poison somebody else's charts.
 */

import type { BaseDeps, Row } from '../_wv_shared/deps.ts';
import type { HttpRequest, HttpResponse } from '../_wv_shared/http.ts';
import { NOT_FOUND, fail, int, json, secretEquals, slug as asSlug, str, uuid } from '../_wv_shared/http.ts';
import { readWorldDocument } from '../_wv_shared/worldDocument.ts';

/**
 * Columns that may leave the building, per table.
 *
 * Written as explicit allowlists rather than denylists: a new column added to
 * wv_room next year is private by default, which is the only direction this
 * mistake is survivable in.
 */
const PUBLIC_COLUMNS = {
  world: ['id', 'version', 'slug', 'status', 'published_at', 'quality_score', 'scale_source', 'scale_agreement'],
  property: ['id', 'label', 'postcode'],
  floor: ['id', 'level', 'name', 'elevation_m', 'provenance', 'confidence'],
  room: ['id', 'floor_id', 'stable_key', 'name', 'kind', 'polygon', 'floor_z', 'ceiling_z',
    'area_m2', 'area_standard', 'area_tol_pct', 'wall_tol_mm', 'provenance', 'confidence'],
  surface: ['id', 'room_id', 'kind', 'plane', 'polygon', 'area_m2', 'is_reflective', 'is_glazed',
    'provenance', 'confidence'],
  opening: ['id', 'kind', 'surface_id', 'room_a', 'room_b', 'centre', 'normal', 'width_m',
    'height_m', 'sill_m', 'provenance', 'confidence'],
  entity: ['id', 'stable_key', 'label', 'category', 'room_id', 'centroid', 'aabb', 'obb',
    'provenance', 'confidence', 'attributes'],
  relationship: ['subject_type', 'subject_id', 'predicate', 'object_type', 'object_id', 'value',
    'provenance', 'confidence'],
  navNode: ['id', 'room_id', 'position', 'clearance_m', 'is_entrance', 'is_viewpoint'],
  navEdge: ['a', 'b', 'cost', 'width_m', 'kind', 'opening_id'],
  region: ['id', 'provenance', 'volume', 'room_id', 'reason', 'confidence'],
  // Pose and intrinsics, yes; capture_id and storage paths, no. A viewer needs
  // to know where a photograph was taken from, not which upload it came from.
  camera: ['id', 'frame_index', 'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'intrinsics', 'room_id'],
  asset: ['id', 'role', 'format', 'storage_path', 'bytes', 'checksum', 'lod', 'chunk_key', 'splat_count'],
  quality: ['checks', 'score', 'verdict', 'created_at'],
} as const;

/** Long enough to load a large splat, short enough that a leaked link dies. */
const ASSET_URL_TTL_S = 60 * 60;

/** Roles a member of the public may download. Source media is not one. */
const PUBLIC_ASSET_ROLES = new Set([
  'splat', 'splat_chunk', 'proxy_mesh', 'visual_mesh', 'floorplan', 'cover',
]);

const ASSET_BUCKET = 'wv-assets';

/**
 * The reserved `Grounding.sources` namespace naming WHICH operator made a
 * correction. Declared here rather than imported from
 * @m3xi/review's provenance.ts, for the same reason worldDocument.ts
 * reimplements weakestProvenance: _wv_shared deliberately depends on no
 * workspace package, so that these functions run in Deno from source and a
 * migration never waits on `npm run build`. The two must agree, and the tests
 * for this file import the real constant to prove they do.
 */
const OPERATOR_SOURCE_PREFIX = 'operator:';

export interface ViewDeps extends BaseDeps {}

export async function handleView(req: HttpRequest, deps: ViewDeps): Promise<HttpResponse> {
  if (req.method === 'OPTIONS') return json({ ok: true });

  // One trailing slash is the difference between a working share link and a
  // 404 for a customer who cannot be asked to care, so it is normalised away.
  const route = (req.path || '/').replace(/\/+$/, '') || '/';
  if (route === '/world.json') return handleWorldDocument(req, deps);
  if (route === '/events') return handleEvents(req, deps);
  return handleManifest(req, deps);
}

// ---------------------------------------------------------------------------
// Resolving a world: published only, in one query, for every route
// ---------------------------------------------------------------------------

/** What the caller asked for, coerced. Both may be null; both may be given. */
function wantedWorld(req: HttpRequest): { slug: string | null; id: string | null } {
  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  return {
    slug: asSlug(body['slug'] ?? req.query['slug']),
    id: uuid(body['worldId'] ?? req.query['worldId']),
  };
}

/**
 * Published only, resolved in ONE query so there is no window in which a world
 * is found and then separately checked. Returns undefined for missing, draft,
 * failed, archived and another tenant's alike -- the caller turns all five into
 * the same 404.
 */
async function publishedWorld(
  deps: ViewDeps, want: { slug: string | null; id: string | null }, columns: readonly string[],
): Promise<Row | undefined> {
  const rows = await deps.db.select('wv_world', {
    columns,
    eq: want.id
      ? { id: want.id, status: 'published' }
      : { slug: want.slug!, status: 'published' },
    limit: 1,
  });
  return rows[0];
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

async function handleManifest(req: HttpRequest, deps: ViewDeps): Promise<HttpResponse> {
  if (req.method !== 'POST' && req.method !== 'GET') return fail(405, 'POST or GET.');

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const want = wantedWorld(req);
  if (!want.slug && !want.id) return fail(400, 'Which property?');

  const world = await publishedWorld(deps, want, [...PUBLIC_COLUMNS.world, 'property_id']);
  // Same 404 for missing, draft, failed, archived and another tenant's.
  if (!world) return NOT_FOUND();

  const worldId = String(world['id']);
  const propertyId = String(world['property_id']);

  const properties = await deps.db.select('wv_property', {
    columns: [...PUBLIC_COLUMNS.property],
    eq: { id: propertyId },
    limit: 1,
  });
  const property = properties[0];
  if (!property) return NOT_FOUND();

  const [
    floors, rooms, surfaces, openings, entities, relationships,
    navNodes, navEdges, regions, cameras, assets, quality,
  ] = await Promise.all([
    deps.db.select('wv_floor', { columns: PUBLIC_COLUMNS.floor, eq: { world_id: worldId } }),
    deps.db.select('wv_room', { columns: PUBLIC_COLUMNS.room, eq: { world_id: worldId } }),
    deps.db.select('wv_surface', { columns: PUBLIC_COLUMNS.surface, eq: { world_id: worldId } }),
    deps.db.select('wv_opening', { columns: PUBLIC_COLUMNS.opening, eq: { world_id: worldId } }),
    deps.db.select('wv_entity', { columns: PUBLIC_COLUMNS.entity, eq: { world_id: worldId } }),
    deps.db.select('wv_relationship', { columns: PUBLIC_COLUMNS.relationship, eq: { world_id: worldId } }),
    deps.db.select('wv_nav_node', { columns: PUBLIC_COLUMNS.navNode, eq: { world_id: worldId } }),
    deps.db.select('wv_nav_edge', { columns: PUBLIC_COLUMNS.navEdge, eq: { world_id: worldId } }),
    deps.db.select('wv_region', { columns: PUBLIC_COLUMNS.region, eq: { world_id: worldId } }),
    deps.db.select('wv_camera', { columns: PUBLIC_COLUMNS.camera, eq: { world_id: worldId } }),
    deps.db.select('wv_asset', { columns: PUBLIC_COLUMNS.asset, eq: { world_id: worldId } }),
    deps.db.select('wv_quality', {
      columns: PUBLIC_COLUMNS.quality, eq: { world_id: worldId },
      order: { column: 'created_at', ascending: false }, limit: 1,
    }),
  ]);

  const signedAssets = await signAssets(assets, deps);

  // The session is created before the manifest is returned, so a viewer that
  // starts asking questions already has a row to meter against. Nothing about
  // it is caller-controlled except an opaque device blob.
  const viewerKey = deps.randomId();
  const startedAt = deps.clock.now().toISOString();
  const inserted = await deps.db.insert('wv_session', {
    world_id: worldId,
    viewer_key: viewerKey,
    device: sanitiseDevice(body['device']),
    referrer: str(req.headers['referer'] ?? body['referrer'], 500) ?? null,
    // The column defaults to now(); it is written explicitly because every
    // event this session posts is clamped into [started_at, now], and a clamp
    // whose lower bound is whatever the database happened to default to is a
    // clamp nobody can reason about from this file.
    started_at: startedAt,
  });
  const sessionId = inserted[0] ? String(inserted[0]['id']) : null;

  const manifest = {
    world: {
      id: worldId,
      version: int(world['version'], 0, 10_000, 1),
      slug: world['slug'] ?? null,
      label: property['label'] ?? 'Property',
      postcode: property['postcode'] ?? null,
      publishedAt: world['published_at'] ?? null,
      units: { length: 'm', angle: 'rad' },
      upAxis: 'Y',
      handedness: 'right',
      scale: { source: world['scale_source'] ?? null, agreement: world['scale_agreement'] ?? null },
      qualityScore: world['quality_score'] ?? null,
    },
    floors, rooms, surfaces, openings, entities, relationships,
    nav: { nodes: navNodes, edges: navEdges },
    regions,
    cameras,
    assets: signedAssets,
    quality: quality[0] ?? null,
    session: { id: sessionId, viewerKey },
  };

  // A last, cheap belt-and-braces pass. The allowlists above are the real
  // control; this catches the case where somebody adds a field to the manifest
  // by hand and forgets what it is made of.
  const leak = findForbiddenKey(manifest);
  if (leak) {
    deps.log('wv_view_leak_blocked', { worldId, key: leak });
    return fail(500, 'Manifest failed its own privacy check.');
  }

  return json(manifest);
}

/**
 * Turn storage paths into signed URLs and then drop the paths.
 *
 * A storage path is not a secret in the cryptographic sense, but it is a
 * durable pointer at somebody's home that outlives the session, and it names
 * the bucket layout to anyone probing for a misconfiguration.
 */
async function signAssets(assets: Record<string, unknown>[], deps: ViewDeps): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const a of assets) {
    const role = String(a['role'] ?? '');
    if (!PUBLIC_ASSET_ROLES.has(role)) continue;
    const path = typeof a['storage_path'] === 'string' ? a['storage_path'] : null;
    if (!path) continue;
    let url: string;
    try {
      url = await deps.storage.signUrl(ASSET_BUCKET, path, ASSET_URL_TTL_S);
    } catch {
      // One unsignable asset must not take the whole tour down.
      deps.log('wv_view_sign_failed', { assetId: a['id'] });
      continue;
    }
    out.push({
      id: a['id'], role, format: a['format'], url,
      bytes: a['bytes'] ?? null, checksum: a['checksum'] ?? null,
      lod: a['lod'] ?? null, chunkKey: a['chunk_key'] ?? null,
      splatCount: a['splat_count'] ?? null,
      expiresInSeconds: ASSET_URL_TTL_S,
    });
  }
  return out;
}

/** A device blob is telemetry, not an instruction. Shape it and cap it. */
function sanitiseDevice(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return {};
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['platform', 'gpu', 'ua', 'dpr', 'width', 'height']) {
    const val = src[key];
    if (typeof val === 'string') out[key] = val.slice(0, 200);
    else if (typeof val === 'number' && Number.isFinite(val)) out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /world.json — what a share link actually opens
// ---------------------------------------------------------------------------

/**
 * The console builds share links as `?slug=...`, and @m3xi/viewer loads a
 * `WorldDocument` from a URL. This is the URL. Without it every link an agency
 * sends a buyer opens the demo flat.
 *
 * The document is READ, not reassembled: `readWorldDocument` serves the
 * rendering written at publish time and only rebuilds it when a correction has
 * invalidated it. A public viewer must not cost thirteen selects per visitor.
 *
 * What it costs to make public is two substitutions and a sweep, below.
 */
async function handleWorldDocument(req: HttpRequest, deps: ViewDeps): Promise<HttpResponse> {
  // A document read changes nothing, so it is a GET and only a GET. A POST
  // here would be a write-shaped request that does not write, which is the
  // sort of thing that later grows a body that does.
  if (req.method !== 'GET') return fail(405, 'GET only.');

  const want = wantedWorld(req);
  if (!want.slug && !want.id) return fail(400, 'Which property?');

  const world = await publishedWorld(deps, want, ['id']);
  // Byte-identical to a missing world, a draft and another tenant's.
  if (!world) return NOT_FOUND();
  const worldId = String(world['id']);

  const { document } = await readWorldDocument(deps, worldId);
  // The cache is a file, and a file can be from before a format change. The
  // viewer refuses a version it does not know, so a mismatch is caught here
  // where it can be logged rather than in somebody's browser.
  if (document['formatVersion'] !== 1) {
    deps.log('wv_view_document_format', { worldId, formatVersion: document['formatVersion'] });
    return fail(500, 'This tour was built for a different version of the viewer.');
  }

  const publicDoc: Record<string, unknown> = stripOperatorReceipts(document) as Record<string, unknown>;
  publicDoc['assets'] = await signDocumentAssets(document['assets'], worldId, deps);
  publicDoc['cameras'] = stripCaptureIds(document['cameras']);

  // The same belt-and-braces pass the manifest gets. The document is built
  // from a column list in another file, so this is the check that notices when
  // that list grows something the public must not have.
  const leak = findForbiddenKey(publicDoc);
  if (leak) {
    deps.log('wv_view_document_leak_blocked', { worldId, key: leak });
    return fail(500, 'Document failed its own privacy check.');
  }
  // And the value-shaped version of the same question. FORBIDDEN_KEYS catches
  // a staff identifier that arrives as a KEY -- created_by, reviewed_by -- and
  // would not have caught this one, because it arrives as a string inside an
  // array. See stripOperatorReceipts.
  const receipt = findOperatorReceipt(publicDoc);
  if (receipt) {
    deps.log('wv_view_document_operator_leak_blocked', { worldId });
    return fail(500, 'Document failed its own privacy check.');
  }

  return json(publicDoc);
}

/**
 * Remove `operator:<user id>` from every grounding, everywhere in the document.
 *
 * An operator correction leaves two receipts in `Grounding.sources`:
 * `correction:<record id>`, which says a person changed this fact, and
 * `operator:<user id>`, which says WHICH person. Both are written deliberately
 * and both are correct in the database -- a measurement certificate has to be
 * able to name who declared a figure, and a rescan has to be able to tell
 * which facts were hand-held.
 *
 * But one cached document serves three audiences: wv-ask, the agency's own
 * export, and this endpoint, which is anonymous. The staff identifier is the
 * half that must not cross the last boundary. It is an internal auth id for a
 * named employee of the agency, it appears beside the room they corrected, and
 * a buyer scrolling a tour has no business receiving it -- the same judgement
 * FORBIDDEN_KEYS already makes about `created_by` and `reviewed_by`.
 *
 * The `correction:` token STAYS. That a figure was corrected by a person
 * rather than derived by the pipeline is exactly what a viewer is entitled to
 * know, and removing it would quietly upgrade a human declaration into a
 * measurement -- the one collapse this contract exists to forbid.
 *
 * Done by rewriting rather than by refusing: the alternative is a 500, and a
 * tour that 500s because somebody corrected a room name is a broken tour.
 */
function stripOperatorReceipts(value: unknown, depth = 0): unknown {
  if (depth > 12 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => stripOperatorReceipts(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'sources' && Array.isArray(v)) {
      const kept = v.filter((s) => typeof s !== 'string' || !s.startsWith(OPERATOR_SOURCE_PREFIX));
      // A grounding whose only source was the operator loses the key entirely,
      // so an uncorrected fact and a corrected-but-anonymised one look the
      // same to a reader rather than carrying a suggestive empty array.
      if (kept.length > 0) out[k] = kept;
      continue;
    }
    out[k] = stripOperatorReceipts(v, depth + 1);
  }
  return out;
}

/** The first surviving `operator:` token anywhere in a payload, or null. */
function findOperatorReceipt(value: unknown, depth = 0): string | null {
  if (depth > 12 || typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.startsWith(OPERATOR_SOURCE_PREFIX)) return v;
      const hit = findOperatorReceipt(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.startsWith(OPERATOR_SOURCE_PREFIX)) return v;
    const hit = findOperatorReceipt(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Replace every `asset://` path with a short-lived signed URL, exactly as the
 * manifest does, and drop anything the public may not have.
 *
 * The document deliberately carries `asset://<world id>/<storage path>` rather
 * than a URL, because an exported bundle must not rot in a year. That is the
 * right choice for the file and the wrong thing to hand a browser, so the
 * substitution happens here, per request, at the boundary.
 */
async function signDocumentAssets(
  assets: unknown, worldId: string, deps: ViewDeps,
): Promise<unknown[]> {
  if (!Array.isArray(assets)) return [];
  const out: unknown[] = [];
  for (const raw of assets) {
    if (typeof raw !== 'object' || raw === null) continue;
    const a = raw as Record<string, unknown>;
    const role = String(a['role'] ?? '');
    // Source media -- the walkthrough video, the raw frames -- is somebody's
    // home and is never offered, whatever a document happens to list.
    if (!PUBLIC_ASSET_ROLES.has(role)) continue;

    const path = documentAssetPath(a['url'], worldId);
    if (!path) {
      deps.log('wv_view_asset_out_of_world', { worldId, assetId: a['id'], role });
      continue;
    }
    let url: string;
    try {
      url = await deps.storage.signUrl(ASSET_BUCKET, path, ASSET_URL_TTL_S);
    } catch {
      // One unsignable asset must not take the whole tour down.
      deps.log('wv_view_sign_failed', { assetId: a['id'] });
      continue;
    }
    out.push({ ...a, url, expiresInSeconds: ASSET_URL_TTL_S });
  }
  return out;
}

/**
 * The storage object a document asset points at, or null if it points anywhere
 * else.
 *
 * Both halves of `asset://<world id>/<storage path>` are checked: the address
 * must name THIS world, and the storage path must sit under this world's
 * prefix, because that prefix is what the bucket policies on wv-assets are
 * keyed on and this function signs as the SERVICE ROLE, which those policies
 * do not apply to. The document is a cached rendering, so the row it was built
 * from is not in front of us; this is the check that makes a path in it safe
 * to sign. An asset addressed to another world is refused rather than signed:
 * there is no legitimate reason for one to exist, and the failure mode if one
 * does is handing a stranger a splat of a different house.
 *
 * `..` is refused as well as a wrong prefix. Supabase resolves an object name
 * literally rather than normalising it, so a traversal segment does not
 * currently escape the prefix, and it is not worth depending on that staying
 * true when the cost of not depending on it is one line.
 */
function documentAssetPath(url: unknown, worldId: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('asset://')) return null;
  const rest = url.slice('asset://'.length);
  const cut = rest.indexOf('/');
  if (cut <= 0) return null;
  if (rest.slice(0, cut) !== worldId) return null;
  const path = rest.slice(cut + 1);
  if (!path.startsWith(`${worldId}/`) || path.split('/').includes('..')) return null;
  return path;
}

/**
 * A camera pose is public; which upload it came from is not.
 *
 * `captureId` is in FORBIDDEN_KEYS, so leaving it in would fail the sweep and
 * 500 the tour rather than leak -- but a tour that 500s is still a broken
 * tour, so it is removed here on purpose rather than caught by accident.
 */
function stripCaptureIds(cameras: unknown): unknown[] {
  if (!Array.isArray(cameras)) return [];
  return cameras.map((c) => {
    if (typeof c !== 'object' || c === null) return c;
    const copy = { ...(c as Record<string, unknown>) };
    delete copy['captureId'];
    return copy;
  });
}

// ---------------------------------------------------------------------------
// POST /events — the only thing that writes wv_event
// ---------------------------------------------------------------------------

/**
 * The seven kinds the console's aggregation understands.
 *
 * The contract is documented at the top of
 * spatial/packages/console-ui/src/logic/analytics.ts and this set is the
 * enforcement of it. A kind outside it is refused rather than stored: an
 * unknown kind is counted as a session by the aggregation and contributes to
 * nothing else, so accepting one would quietly skew every rate on the page.
 *
 * `ai_state`, which wv-ask writes to this table, is deliberately NOT here. It
 * is a server-written row and the public has no business minting one.
 */
const EVENT_KINDS: ReadonlySet<string> = new Set([
  'enter', 'room', 'dwell', 'measure', 'ask', 'lead', 'exit',
]);

/**
 * The limits, and why each one is where it is.
 *
 * A batch of 32 covers a visitor who walks the whole flat between two flushes.
 * The client contract is to flush on a timer and on pagehide, so more than that
 * in one request means a loop, not a tour. It also bounds the room-id check
 * below to a single `in` filter over at most 32 ids.
 *
 * 1 KB per payload is room for a dozen small diagnostic fields. The only value
 * the aggregation ever reads is `payload.ms`; everything else is for a human
 * reading one row. An oversized payload is refused rather than truncated,
 * because storing a cut-down version of what a client said and calling it the
 * event is worse than not storing it.
 *
 * 500 rows per session is the durable backstop, and it is the one a hostile
 * client cannot evade: it counts ROWS, not timestamps. A thirty-minute tour of
 * a ten-room flat produces a couple of hundred events, so a real visitor never
 * reaches it.
 *
 * 60 rows per rolling minute is the runaway catcher. It is measured over the
 * clamped `at`, which a client can push to the bottom of its allowed window --
 * so it is not the defence, the 500-row cap is; this one exists to stop a
 * looping viewer filling the table in the ninety seconds before somebody
 * notices.
 *
 * Checking either costs one select of at most 501 single-column rows per
 * request. That is the price of a limit that survives an isolate being
 * recycled, which an in-memory counter in a serverless runtime does not.
 */
const MAX_EVENTS_PER_REQUEST = 32;
const MAX_EVENT_PAYLOAD_BYTES = 1024;
const MAX_PAYLOAD_KEYS = 12;
const MAX_PAYLOAD_STRING = 200;
const SESSION_EVENT_CAP = 500;
const RATE_WINDOW_MS = 60_000;
const RATE_WINDOW_CAP = 60;

const encoder = new TextEncoder();

interface PendingEvent {
  readonly kind: string;
  readonly roomId: string | null;
  readonly payload: Record<string, unknown>;
  /**
   * When the client says it happened, in milliseconds since the epoch, or NaN
   * when it said nothing a clock could read. It is kept as the claim it is
   * until the session's window is known and it can be clamped.
   */
  readonly claimedAt: number;
}

async function handleEvents(req: HttpRequest, deps: ViewDeps): Promise<HttpResponse> {
  if (req.method !== 'POST') return fail(405, 'POST only.');

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const sessionId = uuid(body['sessionId']);
  const viewerKey = str(body['viewerKey'], 128);
  if (!sessionId || !viewerKey) return fail(400, 'Start a tour first.');

  const raw = body['events'];
  if (!Array.isArray(raw) || raw.length === 0) return fail(400, 'No events.');
  if (raw.length > MAX_EVENTS_PER_REQUEST) {
    return fail(413, `At most ${MAX_EVENTS_PER_REQUEST} events per request.`);
  }

  // Everything that can be decided from the request alone is decided before a
  // single row is read, so a malformed flood costs no database at all.
  const pending: PendingEvent[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return fail(400, 'Malformed event.');
    const e = item as Record<string, unknown>;
    const kind = str(e['kind'], 32);
    if (!kind || !EVENT_KINDS.has(kind)) return fail(400, 'Unknown event kind.');
    const payload = sanitisePayload(e['payload']);
    if (payload === null) return fail(413, 'That event payload is too large.');
    pending.push({
      kind,
      // An id that is not a uuid is not a room; it is dropped here and the
      // survivors are checked against the session's world below.
      roomId: uuid(e['roomId'] ?? e['room_id']),
      payload,
      claimedAt: Date.parse(String(e['at'] ?? '')),
    });
  }

  // The session is the capability, exactly as in wv-ask: it names the world,
  // and the request body does not get a vote. `worldId` in the body is not
  // read anywhere in this function -- if it were, anyone holding one session
  // could write events into any published world's analytics.
  const sessions = await deps.db.select('wv_session', {
    columns: ['id', 'world_id', 'viewer_key', 'started_at', 'ended_at'],
    eq: { id: sessionId },
    limit: 1,
  });
  const session = sessions[0];
  // A session id alone is not a credential. The key is compared in constant
  // time, and a wrong key is indistinguishable from a session that does not
  // exist -- otherwise the pair is an oracle for which session ids are real.
  if (!session || !secretEquals(String(session['viewer_key'] ?? ''), viewerKey)) {
    return NOT_FOUND();
  }
  if (session['ended_at'] !== null && session['ended_at'] !== undefined) {
    // A tour that has ended stops being a write capability. Without this the
    // pair (id, key) is good forever, and "forever" is how a leaked key
    // becomes an unbounded write.
    return fail(409, 'This tour has ended. Reload to start again.');
  }
  const worldId = String(session['world_id']);

  // A world can be unpublished while somebody is walking it. Analytics for a
  // world the operator has taken down are not collected: this function touches
  // published worlds only, on every route, and that includes its writes.
  const worlds = await deps.db.select('wv_world', {
    columns: ['id'], eq: { id: worldId, status: 'published' }, limit: 1,
  });
  if (!worlds[0]) return NOT_FOUND();

  const nowMs = deps.clock.now().getTime();
  const startedMs = Date.parse(String(session['started_at'] ?? ''));
  if (!Number.isFinite(startedMs)) {
    // The column is NOT NULL with a default, so this cannot happen in
    // production -- and if it somehow does, the client gets no window at all
    // rather than an unbounded one.
    deps.log('wv_view_session_no_start', { sessionId, worldId });
  }
  const earliest = Number.isFinite(startedMs) ? startedMs : nowMs;

  // --- The limits, before anything is written -----------------------------
  const prior = await deps.db.select('wv_event', {
    columns: ['at'],
    eq: { session_id: sessionId },
    order: { column: 'at', ascending: false },
    limit: SESSION_EVENT_CAP + 1,
  });
  if (prior.length + pending.length > SESSION_EVENT_CAP) {
    deps.log('wv_view_events_session_cap', { sessionId, worldId, prior: prior.length });
    return fail(429, 'This tour has recorded all the events it can.');
  }
  const windowStart = nowMs - RATE_WINDOW_MS;
  const recent = prior.filter((r) => {
    const t = Date.parse(String(r['at'] ?? ''));
    return Number.isFinite(t) && t >= windowStart;
  }).length;
  if (recent + pending.length > RATE_WINDOW_CAP) {
    // Refused, not silently dropped: a viewer that is sending too fast has a
    // bug, and a 429 is how its author finds out.
    deps.log('wv_view_events_rate_limited', { sessionId, worldId, recent, incoming: pending.length });
    return fail(429, 'Too many events. Slow down.');
  }

  // --- Rooms must belong to this session's world --------------------------
  const claimedRooms = [...new Set(pending.map((p) => p.roomId).filter((id): id is string => id !== null))];
  let ownRooms: ReadonlySet<string> = new Set();
  if (claimedRooms.length > 0) {
    const rows = await deps.db.select('wv_room', {
      columns: ['id'], eq: { world_id: worldId }, in: { id: claimedRooms },
    });
    ownRooms = new Set(rows.map((r) => String(r['id'])));
  }

  // --- Clamp the clock ----------------------------------------------------
  // A client clock is not a fact. An event dated 2035 sorts after everything
  // for ever and stretches one session's duration across a decade, which
  // poisons the mean, the median and every daily bar on the page. So a
  // timestamp is a claim, admissible only inside the window the server can
  // vouch for: between the moment this session started and the moment its
  // event arrived.
  let roomsIgnored = 0;
  let latestExit: number | null = null;
  const rows: Row[] = [];
  for (const p of pending) {
    const at = Number.isFinite(p.claimedAt)
      ? Math.min(Math.max(p.claimedAt, earliest), nowMs)
      // A client that offers no time at all is stamped on arrival, which is
      // the one timestamp here that is not a claim.
      : nowMs;
    const roomId = p.roomId !== null && ownRooms.has(p.roomId) ? p.roomId : null;
    if (p.roomId !== null && roomId === null) roomsIgnored += 1;
    if (p.kind === 'exit') latestExit = Math.max(latestExit ?? at, at);
    rows.push({
      world_id: worldId,
      session_id: sessionId,
      kind: p.kind,
      room_id: roomId,
      payload: p.payload,
      at: new Date(at).toISOString(),
    });
  }

  await deps.db.insert('wv_event', rows);

  // An `exit` may close the session, and that is the ONLY column of the
  // session row anything on this route writes. The time is the clamped exit --
  // when the visitor says they left, inside a window the server vouches for --
  // rather than when the batch happened to be flushed.
  let ended = false;
  if (latestExit !== null) {
    await deps.db.update('wv_session',
      { ended_at: new Date(latestExit).toISOString() },
      { id: sessionId });
    ended = true;
  }

  // Counts, never row contents. There is nothing here a caller did not send.
  return json({ accepted: rows.length, roomsIgnored, ended });
}

/**
 * An event payload is telemetry from a stranger. It is reduced to a shallow
 * object of scalars: the aggregation reads `ms` and a human reads the rest, so
 * nesting buys nothing and a nested blob in a public write endpoint is a
 * convenient place to park something for whoever reads the table later.
 *
 * Returns null when the payload the client sent is over the size cap, which
 * the caller turns into a refusal. Measured BEFORE the reduction, so the
 * answer is about what they sent rather than about what survived it.
 */
function sanitisePayload(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  let encoded: number;
  try {
    encoded = encoder.encode(JSON.stringify(v)).length;
  } catch {
    return null;
  }
  if (encoded > MAX_EVENT_PAYLOAD_BYTES) return null;

  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(src)) {
    if (Object.keys(out).length >= MAX_PAYLOAD_KEYS) break;
    if (key.length > 40) continue;
    if (typeof val === 'string') out[key] = val.slice(0, MAX_PAYLOAD_STRING);
    else if (typeof val === 'number' && Number.isFinite(val)) out[key] = val;
    else if (typeof val === 'boolean') out[key] = val;
  }
  return out;
}

/**
 * Keys that must never appear anywhere in a public payload, at any depth.
 * `edit_key` is the canonical example the brief calls out; the rest are the
 * same mistake wearing different names.
 */
const FORBIDDEN_KEYS = [
  'edit_key', 'editkey', 'org_id', 'orgid', 'storage_path', 'storagepath',
  'service_role', 'worker_id', 'workerid', 'cost_usd', 'costusd', 'email',
  'phone', 'viewer_key_hash', 'capture_id', 'captureid', 'created_by',
  'reviewed_by', 'depends_on', 'params', 'ai_cost_usd',
];

export function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 12 || typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findForbiddenKey(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // `viewerKey` is the session's own opaque handle, generated here and
    // returned deliberately; it is not a world secret.
    if (k === 'viewerKey') continue;
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) return k;
    const hit = findForbiddenKey(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}
