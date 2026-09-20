/**
 * wv-export — build the permanence bundle.
 *
 * Operator-authenticated, tenant-scoped, and deliberately honest about its own
 * limits: an edge function has a wall-clock and memory budget, and a splat of
 * a five-bedroom house does not fit in it. So the handler inlines assets up to
 * a stated budget, and the customer is told exactly what they got.
 *
 * THIS FUNCTION ALWAYS RETURNS A BUNDLE. It used to answer an oversize
 * property with 202 and an `export` job, and tell the customer their bundle
 * was "being packaged in the background". Nothing packaged it. `wv-jobs` hands
 * out thirteen stages and `export` is not one of them, so the row sat
 * unclaimable forever and the customer waited for a file that was never going
 * to arrive. That is the worst class of bug this product can have: it lies to
 * the person the permanence promise is made to.
 *
 * Adding `export` to the claim allowlist was considered and rejected. The
 * Python worker maps a job's stage onto a subgraph of the build DAG, so a
 * stage with no modules behind it would be claimed, fail, be retried twice and
 * stop -- the same silence with more moving parts. Writing a Python exporter
 * instead would put a second implementation of the bundle format in the
 * repository, which is exactly what supabase/functions/deno.json refuses for
 * the agent, and for the same reason: two copies of a format drift, and this
 * one is the artefact the permanence promise rests on.
 *
 * So the oversize path is solved where the problem actually is. The durable,
 * human-meaningful part of a world -- the document, the floorplan, the viewer,
 * the checksums -- is small and always travels inside the zip. An asset too
 * large to pass through this function is listed with a signed link to storage,
 * its checksum, and the moment the link dies, and assets/DOWNLOAD.md explains
 * all of it in plain English. A customer with a 3 GB splat gets their property
 * immediately and their splat with one click, instead of a promise and a wait.
 */

import type { BaseDeps, Row } from '../_wv_shared/deps.ts';
import type { HttpRequest, HttpResponse } from '../_wv_shared/http.ts';
import { fail, json, uuid } from '../_wv_shared/http.ts';
import { buildZip, sha256Hex } from '../_wv_shared/zip.ts';
import { buildBundleEntries, type BundleAsset, type OmittedAsset } from './bundle.ts';

export const EXPORTER_VERSION = '1.1.0';

/**
 * How many bytes of asset this function will pull into memory. An edge
 * function has roughly a few hundred megabytes and a couple of minutes;
 * 180 MB of assets plus the archive plus headroom fits. Anything beyond it is
 * linked rather than inlined.
 */
const INLINE_ASSET_BUDGET_BYTES = 180 * 1024 * 1024;

/**
 * How long a link to an omitted asset lasts. The same 24 hours as the link to
 * the bundle itself, deliberately: a customer who downloads one and not the
 * other has half an export, and two different expiries would be two different
 * things to explain. It is short because a scan of a home is personal data and
 * a URL that never expires is a permanent way in for anyone who ever saw it.
 */
const OMITTED_ASSET_URL_TTL_SECONDS = 24 * 60 * 60;

const ASSET_BUCKET = 'wv-assets';
const EXPORT_BUCKET = 'wv-exports';

/** Assets a customer's permanent copy should contain. */
const BUNDLE_ASSET_ROLES = new Set([
  'splat', 'splat_chunk', 'proxy_mesh', 'visual_mesh', 'pointcloud', 'floorplan', 'cover',
]);

/**
 * The order assets are offered the inline budget, most useful first.
 *
 * This matters because the budget is a first-come limit: whatever is still
 * outside it when the budget runs out is the thing that ends up behind a link
 * with a 24-hour life, and that should be the least urgent file rather than
 * whichever row PostgREST happened to return first.
 *
 *   cover, floorplan   kilobytes each, and the first two things a human opens.
 *                      They are never the reason a budget runs out, and a
 *                      bundle that lost its cover image to a point cloud would
 *                      be an absurd trade.
 *   proxy_mesh         small, and the geometry a measuring tool or a game
 *                      engine actually wants.
 *   visual_mesh        a glTF any browser can open. Bigger than the proxy,
 *                      still ordinary.
 *   splat              the photoreal scan, and the thing the customer paid
 *                      for. Large, so it comes after the small files that
 *                      would otherwise be starved by it, but before anything
 *                      archival.
 *   splat_chunk        the same data cut up for streaming. Useful only with
 *                      code that understands the chunking, so the whole-file
 *                      splat goes in first.
 *   pointcloud         the archival PLY: the largest file in a scan and the
 *                      least urgent. Nothing a customer does this year needs
 *                      it, and it is the obvious candidate for a link.
 *
 * Within one role, smallest first, so that when the budget does run out it is
 * the single largest member that misses the zip rather than three small ones.
 * The final tiebreak is the storage path, so two exports of an unchanged world
 * produce the same bundle rather than one that reshuffles itself.
 */
const BUNDLE_ROLE_ORDER: readonly string[] = [
  'cover', 'floorplan', 'proxy_mesh', 'visual_mesh', 'splat', 'splat_chunk', 'pointcloud',
];

export interface ExportDeps extends BaseDeps {
  /** Rebuilds the world document from its rows. Injected: the shape is the contract. */
  readonly buildWorldDocument: (worldId: string) => Promise<Record<string, unknown>>;
}

export async function handleExport(req: HttpRequest, deps: ExportDeps): Promise<HttpResponse> {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  const caller = await deps.authUser(req.headers['authorization']);
  if (!caller) return fail(401, 'Sign in.');

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const worldId = uuid(body['worldId']);
  if (!worldId) return fail(400, 'worldId required.');

  // Same door as wv-worlds, same 404 for "not yours".
  const orgId = await deps.db.rpc<string | null>('wv_org_of_world', { p_world: worldId });
  if (!orgId) return fail(404, 'Not found.');
  const member = await deps.db.select('wv_member', {
    columns: ['org_id'], eq: { org_id: orgId, user_id: caller.id }, limit: 1,
  });
  if (member.length === 0) {
    deps.log('wv_export_cross_tenant_denied', { userId: caller.id, worldId, orgId });
    return fail(404, 'Not found.');
  }

  const worlds = await deps.db.select('wv_world', {
    columns: ['id', 'property_id', 'version', 'status', 'published_at'],
    eq: { id: worldId }, limit: 1,
  });
  const world = worlds[0];
  if (!world) return fail(404, 'Not found.');

  const properties = await deps.db.select('wv_property', {
    columns: ['id', 'label'], eq: { id: String(world['property_id']) }, limit: 1,
  });
  const label = String(properties[0]?.['label'] ?? 'Property');

  // `checksum` is selected because it travels with an omitted asset: a file
  // fetched from a link rather than out of the zip still has to be verifiable
  // to the same standard as everything in CHECKSUMS.sha256.
  const assetRows = await deps.db.select('wv_asset', {
    columns: ['id', 'role', 'format', 'storage_path', 'bytes', 'checksum', 'chunk_key', 'lod'],
    eq: { world_id: worldId },
  });
  const wanted = inlineOrder(assetRows.filter((a) => BUNDLE_ASSET_ROLES.has(String(a['role'] ?? ''))));

  const document = await deps.buildWorldDocument(worldId);

  // Fixed before the loop so that every link in the bundle expires at the same
  // moment the bundle says it does. Reading the clock per asset would put a
  // handful of milliseconds between the expiry printed in DOWNLOAD.md and the
  // one the storage layer actually enforces.
  const generatedAt = deps.clock.now();
  const expiresAt = new Date(
    generatedAt.getTime() + OMITTED_ASSET_URL_TTL_SECONDS * 1000,
  ).toISOString();

  /**
   * Record an asset as not-in-the-zip, with a link to fetch it directly.
   *
   * Signing is attempted even for an asset whose download just failed: a
   * failed read tells us this function could not get the bytes, not that the
   * object is gone, and a signed URL is issued by the storage API over a
   * different path from the one that failed. If signing fails too, the record
   * carries no link and DOWNLOAD.md says so rather than printing a URL that
   * was never valid.
   */
  const omit = async (
    a: Row, role: string, bytes: number, reason: string, path: string | null,
  ): Promise<OmittedAsset> => {
    let url: string | null = null;
    if (path) {
      try {
        url = await deps.storage.signUrl(ASSET_BUCKET, path, OMITTED_ASSET_URL_TTL_SECONDS);
      } catch (err) {
        deps.log('wv_export_sign_failed', { worldId, assetId: a['id'], path, error: String(err) });
      }
    }
    return {
      role,
      bytes,
      reason,
      format: typeof a['format'] === 'string' ? a['format'] : null,
      checksum: typeof a['checksum'] === 'string' ? a['checksum'] : null,
      url,
      expiresAt: url ? expiresAt : null,
    };
  };

  const assets: BundleAsset[] = [];
  const omitted: OmittedAsset[] = [];
  let used = 0;
  for (const a of wanted) {
    const path = typeof a['storage_path'] === 'string' ? a['storage_path'] : null;
    const role = String(a['role'] ?? 'unknown');
    // A size that does not parse is treated as unknown rather than as zero or
    // as infinity: the file is downloaded and measured below, because refusing
    // it on a number nobody can read would be a guess, and reporting NaN at a
    // customer would be worse than either.
    const recorded = Number(a['bytes'] ?? 0);
    const declaredBytes = Number.isFinite(recorded) && recorded > 0 ? recorded : 0;

    if (!path) {
      // A row with no object behind it. There is nothing to inline and nothing
      // to link to; saying so is all this function can honestly do.
      omitted.push(await omit(a, role, declaredBytes, 'no stored file', null));
      continue;
    }

    // The budget is checked against the DECLARED size first, before any
    // download. Pulling a 3 GB splat into memory in order to discover that it
    // does not fit is the exact failure the budget exists to prevent, and the
    // function would be killed rather than return this bundle.
    if (used + declaredBytes > INLINE_ASSET_BUDGET_BYTES) {
      omitted.push(await omit(a, role, declaredBytes, 'too large to package inline', path));
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = await deps.storage.download(ASSET_BUCKET, path);
    } catch (err) {
      deps.log('wv_export_asset_failed', { worldId, assetId: a['id'], error: String(err) });
      // One unreadable asset must not cost the customer the other twelve
      // files, so this is recorded and the loop continues.
      omitted.push(await omit(a, role, declaredBytes, 'could not be read from storage', path));
      continue;
    }

    // `bytes` on the row is a number somebody recorded, not one measured just
    // now, and a row that understates its object must not be allowed to blow
    // the budget the declared check just cleared.
    if (used + bytes.length > INLINE_ASSET_BUDGET_BYTES) {
      omitted.push(await omit(a, role, bytes.length, 'too large to package inline', path));
      continue;
    }

    used += bytes.length;
    assets.push({
      path: bundleFileName(a, role),
      bytes,
      role,
      format: String(a['format'] ?? 'bin'),
    });
  }

  const entries = await buildBundleEntries({
    world: {
      id: worldId,
      version: Number(world['version'] ?? 1),
      label,
      publishedAt: world['published_at'] ? String(world['published_at']) : null,
      document,
    },
    assets,
    omittedAssets: omitted,
    generatedAt,
    exporterVersion: EXPORTER_VERSION,
  });

  let zip: Uint8Array;
  try {
    zip = buildZip(entries, generatedAt);
  } catch (err) {
    deps.log('wv_export_zip_failed', { worldId, error: String(err) });
    return fail(500, 'Could not package this world.');
  }
  const checksum = await sha256Hex(zip);

  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  const storagePath = `${worldId}/m3xi-${slugify(label)}-v${world['version']}-${stamp}.zip`;
  await deps.storage.upload(EXPORT_BUCKET, storagePath, zip, 'application/zip');

  await deps.db.insert('wv_export', {
    world_id: worldId,
    storage_path: storagePath,
    formats: uniqueFormats(entries, assets),
    bytes: zip.length,
    checksum,
    created_by: caller.id,
  });

  // A one-day link. The bundle itself is permanent; this pointer is not, and
  // the customer is expected to download it and keep it.
  const url = await deps.storage.signUrl(EXPORT_BUCKET, storagePath, OMITTED_ASSET_URL_TTL_SECONDS);

  deps.log('wv_export_built', {
    worldId,
    bytes: zip.length,
    files: entries.length,
    inlinedBytes: used,
    omitted: omitted.length,
    // How many of the omitted files the customer can actually fetch. A gap
    // between these two is the one thing here that needs a human.
    omittedLinked: omitted.filter((a) => a.url !== null).length,
  });
  return json({
    // Always false, and kept rather than dropped because the console branches
    // on it. Nothing queues any more: see the header.
    queued: false,
    url,
    bytes: zip.length,
    checksum,
    files: entries.map((e) => ({ path: e.path, bytes: e.bytes.length })),
    omittedAssets: omitted,
    expiresInSeconds: OMITTED_ASSET_URL_TTL_SECONDS,
  });
}

/**
 * Assets in the order they are offered the inline budget. See
 * BUNDLE_ROLE_ORDER for why this order and not another.
 *
 * A role the list does not name sorts last rather than first: it is either new
 * or unexpected, and an unknown file must not displace the cover image.
 */
function inlineOrder(rows: readonly Row[]): Row[] {
  const rank = (r: Row): number => {
    const i = BUNDLE_ROLE_ORDER.indexOf(String(r['role'] ?? ''));
    return i === -1 ? BUNDLE_ROLE_ORDER.length : i;
  };
  const size = (r: Row): number => {
    const n = Number(r['bytes'] ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return [...rows].sort((a, b) => (
    rank(a) - rank(b)
    || size(a) - size(b)
    || String(a['storage_path'] ?? '').localeCompare(String(b['storage_path'] ?? ''))
  ));
}

function bundleFileName(a: Row, role: string): string {
  const format = String(a['format'] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const chunk = typeof a['chunk_key'] === 'string' && a['chunk_key'].length > 0
    ? `-${a['chunk_key'].replace(/[^a-z0-9_-]/gi, '')}` : '';
  const lod = a['lod'] === null || a['lod'] === undefined ? '' : `-lod${Number(a['lod'])}`;
  return `${role}${chunk}${lod}.${format}`;
}

function uniqueFormats(entries: readonly { path: string }[], assets: readonly BundleAsset[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    const ext = e.path.split('.').pop();
    if (ext) set.add(ext.toLowerCase());
  }
  for (const a of assets) set.add(a.format.toLowerCase());
  return [...set].sort();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'property';
}
