/**
 * The real backend.
 *
 * Reads go straight to PostgREST as the signed-in member, which is possible
 * only because the RLS migration grants `select` on every `wv_*` table to
 * `authenticated` behind `wv_can_write_world`. Writes go to the `wv-worlds`
 * and `wv-export` edge functions, which re-derive membership server-side. The
 * console never holds a service-role key and never could: it runs in a browser.
 *
 * Where the API cannot answer a question the console asks, that is stated in a
 * comment here and reported rather than papered over. Three such places have
 * closed: `wv_member.email` is maintained by trigger, `get_world` returns the
 * timestamp of the last correction, and `wv-worlds` implements `resume_build`.
 * All three are read here directly now, with no fallback, because a fallback
 * would hide the day one of them regresses.
 */

import type {
  ApiClient, CaptureRow, Correction, ExportResult, ExportRow, LeadRow, MemberRow, Membership,
  Org, PropertyRow, Session, SessionRow, WorldDetail, WorldSummary,
} from '@m3xi/console-ui';
import {
  ApiError, assembleWorldDocument, rangeFor, type AiTurnRow, type BuildJobRow, type DataProblem,
  type EventRow, type JobRow, type MemberRole, type Page, type PortfolioQuery,
} from '@m3xi/console-ui';
import type { WorldDocument } from '@m3xi/world-core';
import { SupabaseClient, SupabaseError } from './supabase.js';

const ASSET_BUCKET = 'wv-assets';
const EXPORT_BUCKET = 'wv-exports';
const ASSET_URL_TTL_S = 60 * 60;

/**
 * The pipeline renders the world document and stores it as a `wv_asset` row
 * with this reserved chunk key, marking `meta.stale` whenever a row the
 * document is made of changes — including an operator correction written
 * straight to PostgREST, which is what the statement triggers in
 * `..._document_cache.sql` exist for.
 *
 * So: use the cache when it is fresh, and assemble from the rows when it is
 * missing or stale. The console must not show a rendering that predates a
 * correction the operator made ninety seconds ago.
 */
const DOCUMENT_CHUNK_KEY = 'world-document';

/** Enough for a busy month on one org; past this the page says it is truncated. */
const EVENT_LIMIT = 20_000;
const TURN_LIMIT = 20_000;

const WORLD_COLUMNS =
  'id,property_id,version,status,published_at,quality_score,slug,created_at,supersedes_id,scale_source,scale_agreement';

export class SupabaseApiClient implements ApiClient {
  readonly isFixture = false;
  private readonly db: SupabaseClient;
  private current: Membership | null = null;

  constructor(url: string, anonKey: string) {
    this.db = new SupabaseClient(url, anonKey);
  }

  get session(): Session | null {
    const s = this.db.session;
    if (!s) return null;
    return { userId: s.userId, email: s.email, accessToken: s.accessToken, expiresAt: s.expiresAt };
  }

  get membership(): Membership | null {
    return this.current;
  }

  async signIn(email: string, password: string): Promise<Session> {
    await this.db.signIn(email, password);
    return this.session!;
  }

  async signOut(): Promise<void> {
    this.current = null;
    await this.db.signOut();
  }

  async restore(): Promise<Session | null> {
    this.db.restore();
    return this.session;
  }

  async memberships(): Promise<readonly Membership[]> {
    const { rows } = await this.db.select<{
      role: MemberRole;
      org_id: string;
      wv_org: Org | Org[] | null;
    }>('wv_member', {
      select: 'role,org_id,wv_org(id,slug,name,ai_month_cap_gbp,build_month_cap,ai_turns_per_session,created_at)',
    });
    const out: Membership[] = [];
    for (const row of rows) {
      // PostgREST returns an embedded to-one as an object, but older versions
      // and some views return a single-element array. Accept both.
      const org = Array.isArray(row.wv_org) ? row.wv_org[0] : row.wv_org;
      if (org) out.push({ org, role: row.role });
    }
    return out.sort((a, b) => a.org.name.localeCompare(b.org.name));
  }

  async useOrg(orgId: string): Promise<Membership> {
    const all = await this.memberships();
    const found = all.find((m) => m.org.id === orgId) ?? all[0];
    if (!found) throw new ApiError(404, 'This account is not a member of any organisation yet.');
    this.current = found;
    return found;
  }

  private requireOrg(): Membership {
    if (!this.current) throw new ApiError(401, 'No organisation selected.');
    return this.current;
  }

  async listMembers(): Promise<readonly MemberRow[]> {
    const org = this.requireOrg();
    // `auth.users` is still not readable by `authenticated` and must stay that
    // way. The address is on the membership row instead, denormalised by the
    // triggers in ..._server_api.sql, and covered by the same table-level
    // `grant select ... to authenticated` and the same `wv_member_read` policy
    // as the role is — so this needs no endpoint and no new grant.
    const { rows } = await this.db.select<{
      user_id: string; email: string | null; role: MemberRole; created_at: string;
    }>('wv_member', {
      select: 'user_id,email,role,created_at',
      eq: { org_id: org.org.id },
      order: { column: 'created_at', ascending: true },
    });
    // Null stays null. It means the account behind this membership has no
    // address to copy, and the page shows the user id for that row rather than
    // a blank where a person should be.
    return rows.map((r) => ({
      user_id: r.user_id, email: r.email ?? null, role: r.role, created_at: r.created_at,
    }));
  }

  async listProperties(query: PortfolioQuery): Promise<Page<PropertyRow>> {
    const org = this.requireOrg();
    const { from, to } = rangeFor(query);

    // An inner embed is what turns "properties whose live version is published"
    // into one indexed query rather than a fetch-everything-and-filter.
    const embed = query.status === 'any' ? 'wv_world' : 'wv_world!inner';
    const select = `id,ref,label,postcode,address,created_at,archived_at,${embed}(${WORLD_COLUMNS})`;

    const eq: Record<string, string> = { org_id: org.org.id };
    if (query.status !== 'any') eq['wv_world.status'] = query.status;

    const search = query.search.trim();
    const or = search.length > 0
      // `*` is PostgREST's wildcard for ilike. Commas and parentheses would
      // break out of the filter grammar, so they are stripped rather than escaped.
      ? `(label.ilike.*${safeFilterValue(search)}*,ref.ilike.*${safeFilterValue(search)}*,postcode.ilike.*${safeFilterValue(search)}*)`
      : undefined;

    const result = await this.db.select<PropertyRow & { wv_world: WorldSummary[] }>('wv_property', {
      select,
      eq,
      ...(or ? { or } : {}),
      ...(query.includeArchived ? {} : { isNull: ['archived_at'] }),
      order: { column: query.sort, ascending: query.ascending },
      range: { from, to },
      count: true,
    });

    const rows: PropertyRow[] = result.rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      label: r.label,
      postcode: r.postcode,
      address: r.address ?? {},
      created_at: r.created_at,
      archived_at: r.archived_at,
      worlds: [...(r.wv_world ?? [])].sort((a, b) => b.version - a.version),
    }));

    return { rows, total: result.total ?? rows.length, page: query.page, pageSize: query.pageSize };
  }

  async getProperty(propertyId: string): Promise<PropertyRow> {
    const { rows } = await this.db.select<PropertyRow & { wv_world: WorldSummary[] }>('wv_property', {
      select: `id,ref,label,postcode,address,created_at,archived_at,wv_world(${WORLD_COLUMNS})`,
      eq: { id: propertyId },
      limit: 1,
    });
    const row = rows[0];
    if (!row) throw new ApiError(404, 'That property is not in this organisation.');
    return {
      ...row,
      address: row.address ?? {},
      worlds: [...(row.wv_world ?? [])].sort((a, b) => b.version - a.version),
    };
  }

  async createProperty(input: {
    label: string; ref?: string; postcode?: string; address?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const org = this.requireOrg();
    const res = await this.call<{ property?: { id?: string } }>('wv-worlds', {
      action: 'create_property',
      orgId: org.org.id,
      label: input.label,
      ref: input.ref,
      postcode: input.postcode,
      address: input.address ?? {},
    });
    const id = res.property?.id;
    if (!id) throw new ApiError(500, 'The property was not created.');
    return { id: String(id) };
  }

  async archiveProperties(ids: readonly string[]): Promise<void> {
    // `wv_property` grants update to `authenticated` behind the org policy, so
    // archiving is a direct write rather than an endpoint.
    const now = new Date().toISOString();
    for (const id of ids) {
      await this.db.patch('wv_property', { archived_at: now }, { id });
    }
  }

  async createWorld(propertyId: string): Promise<{ id: string; version: number }> {
    const res = await this.call<{ world?: { id?: string; version?: number } }>('wv-worlds', {
      action: 'create_world', propertyId,
    });
    if (!res.world?.id) throw new ApiError(500, 'The world version was not created.');
    return { id: String(res.world.id), version: Number(res.world.version ?? 1) };
  }

  async getWorld(worldId: string): Promise<WorldDetail> {
    const [detail, history, assets, rooms, captures] = await Promise.all([
      this.call<{
        world: WorldSummary; jobs: JobRow[]; quality: Record<string, unknown> | null;
        lastCorrectionAt: string | null;
      }>('wv-worlds', { action: 'get_world', worldId }),
      this.db.select<Record<string, unknown>>('wv_quality', {
        select: 'checks,score,verdict,created_at',
        eq: { world_id: worldId },
        order: { column: 'created_at', ascending: false },
        limit: 20,
      }),
      this.db.select<{ bytes: number | null }>('wv_asset', {
        select: 'id,bytes', eq: { world_id: worldId }, limit: 500,
      }),
      this.db.select<{ id: string }>('wv_room', { select: 'id', eq: { world_id: worldId }, limit: 200 }),
      this.db.select<CaptureRow>('wv_capture', {
        select: 'id,kind,bytes,duration_s,frame_count,captured_at,created_at,coverage',
        eq: { world_id: worldId },
        order: { column: 'created_at', ascending: false },
        limit: 20,
      }),
    ]);

    return {
      world: detail.world,
      jobs: detail.jobs ?? [],
      quality: detail.quality ?? null,
      qualityHistory: history.rows,
      assetCount: assets.rows.length,
      assetBytes: assets.rows.reduce((sum, a) => sum + Number(a.bytes ?? 0), 0),
      roomCount: rooms.rows.length,
      captures: captures.rows,
      // `get_world` derives this from `updated_at` on wv_room, wv_entity,
      // wv_opening and wv_surface, which a BEFORE UPDATE trigger sets and
      // which overrides anything a caller supplies. It is what makes the
      // publish gate's `stale` verdict reachable: a quality report written
      // before this timestamp describes a world that no longer exists. It is
      // taken as given — a `??` to "now" or to the world's created_at here
      // would either freeze the gate shut or hold it permanently open.
      lastCorrectionAt: detail.lastCorrectionAt ?? null,
    };
  }

  async getWorldDocument(worldId: string): Promise<{
    doc: WorldDocument | null; problems: readonly DataProblem[];
  }> {
    const cached = await this.readCachedDocument(worldId);
    if (cached) return cached;

    const eq = { world_id: worldId };
    const [
      world, floors, rooms, surfaces, openings, entities, relationships,
      navNodes, navEdges, regions, cameras, assets, quality,
    ] = await Promise.all([
      this.db.select<Record<string, unknown>>('wv_world', {
        select: `${WORLD_COLUMNS},scale_provenance,scale_confidence`, eq: { id: worldId }, limit: 1,
      }),
      this.db.select<Record<string, unknown>>('wv_floor', { select: '*', eq }),
      this.db.select<Record<string, unknown>>('wv_room', { select: '*', eq, limit: 500 }),
      this.db.select<Record<string, unknown>>('wv_surface', { select: '*', eq, limit: 5000 }),
      this.db.select<Record<string, unknown>>('wv_opening', { select: '*', eq, limit: 2000 }),
      this.db.select<Record<string, unknown>>('wv_entity', { select: '*', eq, limit: 5000 }),
      this.db.select<Record<string, unknown>>('wv_relationship', { select: '*', eq, limit: 20000 }),
      this.db.select<Record<string, unknown>>('wv_nav_node', { select: '*', eq, limit: 5000 }),
      this.db.select<Record<string, unknown>>('wv_nav_edge', { select: '*', eq, limit: 20000 }),
      this.db.select<Record<string, unknown>>('wv_region', { select: '*', eq, limit: 2000 }),
      this.db.select<Record<string, unknown>>('wv_camera', { select: '*', eq, limit: 20000 }),
      this.db.select<Record<string, unknown>>('wv_asset', { select: '*', eq, limit: 500 }),
      this.db.select<Record<string, unknown>>('wv_quality', {
        select: 'checks,score,verdict,created_at', eq,
        order: { column: 'created_at', ascending: false }, limit: 1,
      }),
    ]);

    const worldRow = world.rows[0];
    if (!worldRow) throw new ApiError(404, 'That world is not in this organisation.');

    const propertyId = String(worldRow['property_id'] ?? '');
    const property = await this.db.select<Record<string, unknown>>('wv_property', {
      select: 'id,label,postcode', eq: { id: propertyId }, limit: 1,
    });

    // Assets are private. Sign them up front so the assembler's resolver can
    // stay synchronous; anything storage refuses keeps its asset:// URL and the
    // viewer falls back to the proxy-only shell.
    const signed = new Map<string, string>();
    await Promise.all(assets.rows.map(async (a) => {
      const path = typeof a['storage_path'] === 'string' ? a['storage_path'] : null;
      if (!path) return;
      const url = await this.db.signStorageUrl(ASSET_BUCKET, path, ASSET_URL_TTL_S);
      if (url) signed.set(path, url);
    }));

    return assembleWorldDocument({
      world: worldRow,
      property: property.rows[0] ?? { id: propertyId, label: 'Property' },
      floors: floors.rows,
      rooms: rooms.rows,
      surfaces: surfaces.rows,
      openings: openings.rows,
      entities: entities.rows,
      relationships: relationships.rows,
      navNodes: navNodes.rows,
      navEdges: navEdges.rows,
      regions: regions.rows,
      cameras: cameras.rows,
      assets: assets.rows,
      quality: quality.rows[0] ?? null,
    }, {
      resolveAssetUrl: (path) => signed.get(path) ?? `asset://${path}`,
    });
  }

  /**
   * Fetch the rendered document if one exists and nothing has invalidated it.
   * Returns null — so the caller assembles from rows instead — when there is
   * no cache, when it is stale, or when anything about reading it fails.
   */
  private async readCachedDocument(worldId: string): Promise<{
    doc: WorldDocument | null; problems: readonly DataProblem[];
  } | null> {
    try {
      const { rows } = await this.db.select<{
        storage_path: string; meta: Record<string, unknown> | null;
      }>('wv_asset', {
        select: 'storage_path,meta',
        eq: { world_id: worldId, chunk_key: DOCUMENT_CHUNK_KEY },
        limit: 1,
      });
      const row = rows[0];
      if (!row?.storage_path) return null;
      if (row.meta?.['stale'] === true) return null;

      const url = await this.db.signStorageUrl(ASSET_BUCKET, row.storage_path, ASSET_URL_TTL_S);
      if (!url) return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      const doc = await res.json() as WorldDocument;
      if (doc?.formatVersion !== 1) return null;
      return { doc, problems: [] };
    } catch {
      // A cache that cannot be read is not an error; it is an absent cache.
      return null;
    }
  }

  async requestBuild(worldId: string): Promise<void> {
    await this.call('wv-worlds', { action: 'request_build', worldId });
  }

  async resumeBuild(worldId: string): Promise<void> {
    // `resume_build` requeues the failed rows under a compare-and-set on
    // `status = 'failed'`, which is why it is an action rather than a patch:
    // `wv_job` grants no UPDATE to `authenticated`.
    //
    // Every refusal it can return is a sentence an operator can act on — the
    // stage burned its three attempts, a worker still holds the lease, nothing
    // failed — so the error travels up unchanged. Translating them into one
    // "resume is unavailable" was the shim this replaces, and it told an
    // operator the deployment was at fault when the build was simply held.
    await this.call('wv-worlds', { action: 'resume_build', worldId });
  }

  async applyCorrections(worldId: string, corrections: readonly Correction[]): Promise<{
    applied: number; rejected: readonly string[];
  }> {
    const res = await this.call<{ applied?: number; rejected?: string[] }>('wv-worlds', {
      action: 'approve_corrections', worldId, corrections,
    });
    return { applied: Number(res.applied ?? 0), rejected: res.rejected ?? [] };
  }

  async publish(worldId: string, slug?: string): Promise<{ publishedAt: string; slug: string | null }> {
    const res = await this.call<{ publishedAt?: string; slug?: string | null }>('wv-worlds', {
      action: 'publish', worldId, ...(slug ? { slug } : {}),
    });
    return { publishedAt: String(res.publishedAt ?? new Date().toISOString()), slug: res.slug ?? slug ?? null };
  }

  async unpublish(worldId: string): Promise<void> {
    await this.call('wv-worlds', { action: 'unpublish', worldId });
  }

  async createExport(worldId: string): Promise<ExportResult> {
    return this.call<ExportResult>('wv-export', { worldId });
  }

  async listExports(): Promise<readonly ExportRow[]> {
    const { rows } = await this.db.select<ExportRow>('wv_export', {
      select: 'id,world_id,formats,bytes,checksum,created_at,downloaded_at',
      order: { column: 'created_at', ascending: false },
      limit: 200,
    });
    return rows;
  }

  async signExportUrl(exportId: string): Promise<string> {
    const { rows } = await this.db.select<{ storage_path: string }>('wv_export', {
      select: 'storage_path', eq: { id: exportId }, limit: 1,
    });
    const path = rows[0]?.storage_path;
    if (!path) throw new ApiError(404, 'That bundle is no longer listed.');
    const url = await this.db.signStorageUrl(EXPORT_BUCKET, path, 24 * 60 * 60);
    if (!url) throw new ApiError(403, 'Storage would not sign a link for that bundle. Build it again.');
    return url;
  }

  async listLeads(limit = 500): Promise<readonly LeadRow[]> {
    const { rows } = await this.db.select<LeadRow>('wv_lead', {
      select: 'id,world_id,session_id,name,email,phone,message,created_at',
      order: { column: 'created_at', ascending: false },
      limit,
    });
    return rows;
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const { rows } = await this.db.select<SessionRow>('wv_session', {
      select: 'id,world_id,device,referrer,ai_turns,ai_cost_usd,started_at,ended_at',
      eq: { id: sessionId }, limit: 1,
    });
    return rows[0] ?? null;
  }

  async listEvents(input: { worldId?: string; since?: string; limit?: number }): Promise<readonly EventRow[]> {
    const { rows } = await this.db.select<EventRow>('wv_event', {
      select: 'session_id,kind,room_id,payload,at',
      ...(input.worldId ? { eq: { world_id: input.worldId } } : {}),
      ...(input.since ? { gte: { at: input.since } } : {}),
      order: { column: 'at', ascending: true },
      limit: Math.min(input.limit ?? EVENT_LIMIT, EVENT_LIMIT),
    });
    return rows;
  }

  async roomNames(worldId: string): Promise<Readonly<Record<string, string>>> {
    const { rows } = await this.db.select<{ id: string; name: string | null; kind: string }>('wv_room', {
      select: 'id,name,kind', eq: { world_id: worldId }, limit: 500,
    });
    const out: Record<string, string> = {};
    for (const r of rows) out[r.id] = r.name ?? r.kind;
    return out;
  }

  async listAiTurns(since: string): Promise<readonly AiTurnRow[]> {
    const { rows } = await this.db.select<AiTurnRow>('wv_ai_turn', {
      select: 'cost_usd,at,world_id,tier',
      gte: { at: since },
      order: { column: 'at', ascending: false },
      limit: TURN_LIMIT,
    });
    return rows;
  }

  async listJobsForOrg(since: string): Promise<readonly BuildJobRow[]> {
    const { rows } = await this.db.select<BuildJobRow>('wv_job', {
      select: 'stage,queued_at,world_id,cost_usd,gpu_seconds',
      gte: { queued_at: since },
      order: { column: 'queued_at', ascending: false },
      limit: TURN_LIMIT,
    });
    return rows;
  }

  async worldPropertyMap(): Promise<Readonly<Record<string, string>>> {
    const { rows } = await this.db.select<{ id: string; property_id: string }>('wv_world', {
      select: 'id,property_id', limit: 5000,
    });
    const out: Record<string, string> = {};
    for (const r of rows) out[r.id] = r.property_id;
    return out;
  }

  private async call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.db.fn<T>(fn, body);
    } catch (err) {
      if (err instanceof SupabaseError) throw new ApiError(err.status, err.message);
      throw err;
    }
  }
}

/**
 * PostgREST's filter grammar is comma- and parenthesis-delimited, so a search
 * term containing either would change the meaning of the query rather than be
 * matched literally. They are removed, along with the wildcard itself.
 */
function safeFilterValue(value: string): string {
  return value.replace(/[(),*"\\]/g, ' ').trim().slice(0, 80);
}
