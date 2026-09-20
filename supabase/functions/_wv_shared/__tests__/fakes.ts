/**
 * In-memory doubles for everything a wv-* handler asks of the outside world.
 *
 * The handlers are written as pure `(req, deps) => res` functions precisely so
 * they can be driven in Node with no Deno, no network and no database. This
 * file is the other half of that bargain.
 *
 * WHAT IS AND IS NOT MODELLED
 *
 * `FakeDb` is a faithful model of the SHAPE of PostgREST -- explicit column
 * projection, eq/in filters, order, limit, upsert-on-conflict -- because the
 * handlers depend on that shape and getting it wrong in the double would hide
 * real bugs. Column projection in particular is deliberate: a handler that
 * reads a column it did not select gets `undefined` here, exactly as it would
 * in production, rather than quietly working because the double returned whole
 * rows.
 *
 * It is NOT a model of Postgres. There is no MVCC, no SKIP LOCKED, no
 * concurrency and no constraint enforcement beyond the unique keys the
 * upserts name. The one place that matters is `wv_claim_job`, whose real
 * implementation lives in
 * supabase/migrations/20260919171000_world_viewer_queue.sql; the version here
 * mirrors its predicate and its state transition line for line, and says so,
 * but two workers racing for one row is a property of the database and is
 * tested against the database, not here.
 */

import type { Db, DbFilter, Row, SelectOptions, Storage, UpsertOptions } from '../deps.ts';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Column defaults, so an insert produces the row the schema would produce. */
const DEFAULTS: Readonly<Record<string, () => Row>> = {
  wv_job: () => ({
    status: 'queued', attempt: 0, depends_on: [], params: {}, result: {},
    worker_id: null, lease_until: null, started_at: null, finished_at: null,
    error: null, gpu_seconds: null, cost_usd: null,
  }),
  wv_world: () => ({ status: 'draft', published_at: null, slug: null, supersedes_id: null }),
  wv_member: () => ({ role: 'operator' }),
  wv_asset: () => ({ meta: {} }),
  wv_room: () => ({ kind: 'unknown' }),
  wv_surface: () => ({ is_reflective: false, is_glazed: false }),
  wv_nav_node: () => ({ is_entrance: false, is_viewpoint: false }),
  wv_redaction: () => ({ applied: false }),
  wv_session: () => ({ ai_turns: 0, ai_cost_usd: 0, device: {} }),
};

/** Tables whose primary key is a uuid the database generates. */
const GENERATES_ID = new Set([
  'wv_org', 'wv_property', 'wv_world', 'wv_capture', 'wv_camera', 'wv_asset',
  'wv_floor', 'wv_room', 'wv_surface', 'wv_opening', 'wv_entity', 'wv_nav_node',
  'wv_region', 'wv_measurement', 'wv_redaction', 'wv_worker', 'wv_job',
  'wv_quality', 'wv_session', 'wv_lead', 'wv_export',
]);

export type RpcImpl = (args: Record<string, unknown>, db: FakeDb) => unknown;

export class FakeDb implements Db {
  readonly tables = new Map<string, Row[]>();
  readonly rpcs = new Map<string, RpcImpl>();
  /** Every call, in order. Tests assert on what was asked for, not only on what came back. */
  readonly calls: { op: string; table: string; detail?: unknown }[] = [];

  private seq = 0;
  private clock: () => Date;

  constructor(clock: () => Date = () => new Date('2026-09-20T12:00:00.000Z')) {
    this.clock = clock;
    installDefaultRpcs(this);
  }

  /** Seed rows directly, bypassing defaults and logging. */
  seed(table: string, rows: readonly Row[]): this {
    const target = this.rows(table);
    for (const r of rows) target.push({ ...r });
    return this;
  }

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) { rows = []; this.tables.set(table, rows); }
    return rows;
  }

  /**
   * A real v4-shaped uuid, because `uuid()` in http.ts rejects anything else
   * and these ids travel through request bodies. Hex only: an id carrying a
   * readable tag looks friendlier in a failure message and is silently
   * rejected by every handler that validates its input.
   */
  nextId(_prefix = 'row'): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${this.seq.toString(16).padStart(12, '0')}`;
  }

  now(): Date { return this.clock(); }

  // -- Db ------------------------------------------------------------------

  async select(table: string, opts: SelectOptions): Promise<Row[]> {
    this.calls.push({ op: 'select', table, detail: opts });
    let out = this.rows(table).filter((r) => matches(r, opts.eq));
    for (const [column, values] of Object.entries(opts.in ?? {})) {
      out = out.filter((r) => values.includes(String(r[column])));
    }
    if (opts.order) {
      const { column, ascending } = opts.order;
      out = [...out].sort((a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1));
    }
    if (opts.limit !== undefined) out = out.slice(0, Math.max(0, Math.floor(opts.limit)));
    return out.map((r) => project(r, opts.columns));
  }

  async insert(table: string, values: Row | Row[]): Promise<Row[]> {
    const list = Array.isArray(values) ? values : [values];
    this.calls.push({ op: 'insert', table, detail: list.length });
    const written: Row[] = [];
    for (const v of list) {
      const row: Row = {
        ...(DEFAULTS[table]?.() ?? {}),
        ...(GENERATES_ID.has(table) && v['id'] === undefined ? { id: this.nextId(table) } : {}),
        created_at: this.now().toISOString(),
        ...(table === 'wv_job' ? { queued_at: this.now().toISOString() } : {}),
        ...v,
      };
      this.rows(table).push(row);
      written.push({ ...row });
    }
    return written;
  }

  async upsert(table: string, values: Row | Row[], opts?: UpsertOptions): Promise<Row[]> {
    const list = Array.isArray(values) ? values : [values];
    this.calls.push({ op: 'upsert', table, detail: opts?.onConflict ?? ['id'] });
    const keys = opts?.onConflict?.length ? opts.onConflict : ['id'];
    const written: Row[] = [];
    for (const v of list) {
      const existing = this.rows(table).find((r) => keys.every((k) => r[k] === v[k]));
      if (existing) {
        Object.assign(existing, v);
        written.push({ ...existing });
      } else {
        const [row] = await this.insert(table, v);
        written.push(row!);
      }
    }
    return written;
  }

  async update(table: string, values: Row, where: DbFilter): Promise<Row[]> {
    this.calls.push({ op: 'update', table, detail: where });
    const hit = this.rows(table).filter((r) => matches(r, where));
    for (const r of hit) Object.assign(r, values);
    return hit.map((r) => ({ ...r }));
  }

  async rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ op: 'rpc', table: name, detail: args });
    const impl = this.rpcs.get(name);
    // A missing RPC is an explicit failure. Returning undefined would let a
    // handler that calls a function nobody has written appear to work.
    if (!impl) throw new Error(`fake db: no implementation for rpc '${name}'`);
    return impl(args, this) as T;
  }
}

function project(row: Row, columns?: readonly string[]): Row {
  if (!columns || columns.length === 0) return { ...row };
  const out: Row = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

function matches(row: Row, filter?: DbFilter): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([column, expected]) => {
    const actual = row[column];
    // makeDb encodes an array filter as PostgREST `in.(...)`.
    if (Array.isArray(expected)) return expected.map(String).includes(String(actual));
    if (expected === null) return actual === null || actual === undefined;
    return String(actual) === String(expected);
  });
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return String(a) < String(b) ? -1 : 1;
}

// ---------------------------------------------------------------------------
// The RPCs the handlers call
// ---------------------------------------------------------------------------

function installDefaultRpcs(db: FakeDb): void {
  // supabase/migrations/20260919170500_world_viewer_rls.sql
  db.rpcs.set('wv_org_of_world', (args) => {
    const world = db.rows('wv_world').find((w) => w['id'] === args['p_world']);
    if (!world) return null;
    const property = db.rows('wv_property').find((p) => p['id'] === world['property_id']);
    return property ? property['org_id'] : null;
  });

  // supabase/migrations/20260920100000_world_viewer_server_api.sql, section 4.
  // Counts `splat`, the stage the GPU hour is committed on.
  db.rpcs.set('wv_spend_allowed', (args) => {
    const orgId = db.rows('wv_world')
      .filter((w) => w['id'] === args['p_world'])
      .map((w) => db.rows('wv_property').find((p) => p['id'] === w['property_id'])?.['org_id'])[0];
    const org = db.rows('wv_org').find((o) => o['id'] === orgId);
    if (!org) return { allowed: false, reason: 'no_org' };
    if (args['p_kind'] === 'build') {
      const worlds = new Set(db.rows('wv_world')
        .filter((w) => db.rows('wv_property')
          .some((p) => p['id'] === w['property_id'] && p['org_id'] === orgId))
        .map((w) => w['id']));
      const used = db.rows('wv_job')
        .filter((j) => j['stage'] === 'splat' && worlds.has(j['world_id'])).length;
      const cap = Number(org['build_month_cap'] ?? 50);
      if (used >= cap) return { allowed: false, reason: 'build_month_cap', used };
    }
    return { allowed: true };
  });

  // supabase/migrations/20260919171000_world_viewer_queue.sql.
  // Mirrors the predicate and the state transition; models no concurrency.
  db.rpcs.set('wv_claim_job', (args, self) => {
    const stages = Array.isArray(args['p_stages']) ? args['p_stages'] as string[] : null;
    const maxAttempts = Number(args['p_max_attempts'] ?? 3);
    const leaseS = Number(args['p_lease_seconds'] ?? 900);
    const now = self.now();

    const candidates = self.rows('wv_job')
      .filter((j) => (stages === null || stages.includes(String(j['stage']))))
      .filter((j) => Number(j['attempt'] ?? 0) < maxAttempts)
      .filter((j) => {
        const status = String(j['status']);
        if (status === 'queued') return true;
        if (status !== 'leased' && status !== 'running') return false;
        const until = j['lease_until'];
        return typeof until === 'string' && Date.parse(until) < now.getTime();
      })
      // Every dependency must have SUCCEEDED. Note what the real function does
      // with an id that matches no row: nothing -- `not exists` is satisfied,
      // so a dangling dependency reads as met. That is why requestBuild
      // validates the whole plan before its first insert, and why this double
      // reproduces the behaviour rather than the intention.
      .filter((j) => {
        const deps = Array.isArray(j['depends_on']) ? j['depends_on'] as string[] : [];
        return deps.every((id) => {
          const parent = self.rows('wv_job').find((p) => p['id'] === id);
          return parent === undefined || parent['status'] === 'succeeded';
        });
      })
      .sort((a, b) => compare(a['queued_at'], b['queued_at']));

    const job = candidates[0];
    if (!job) return [];
    job['status'] = 'leased';
    job['worker_id'] = args['p_worker_id'];
    job['lease_until'] = new Date(now.getTime() + leaseS * 1000).toISOString();
    job['attempt'] = Number(job['attempt'] ?? 0) + 1;
    job['started_at'] = job['started_at'] ?? now.toISOString();
    job['error'] = null;
    return [{ ...job }];
  });

  db.rpcs.set('wv_heartbeat_job', (args, self) => {
    const job = self.rows('wv_job').find((j) => j['id'] === args['p_job_id']);
    if (!job || job['worker_id'] !== args['p_worker_id']) return false;
    const status = String(job['status']);
    if (status !== 'leased' && status !== 'running') return false;
    job['status'] = status === 'leased' ? 'running' : status;
    job['lease_until'] = new Date(
      self.now().getTime() + Number(args['p_lease_seconds'] ?? 900) * 1000).toISOString();
    return true;
  });

  // supabase/migrations/20260920100000_world_viewer_server_api.sql, section 2.
  db.rpcs.set('wv_user_id_by_email', (args, self) => {
    const email = String(args['p_email'] ?? '').trim().toLowerCase();
    const user = self.rows('auth_users').find((u) => String(u['email']).toLowerCase() === email);
    return user ? user['id'] : null;
  });

  db.rpcs.set('wv_remove_member', (args, self) => {
    const rows = self.rows('wv_member');
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!['org_id'] === args['p_org'] && rows[i]!['user_id'] === args['p_user']) {
        rows.splice(i, 1);
      }
    }
    return before - rows.length;
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class FakeStorage implements Storage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly signed: { bucket: string; path: string; seconds: number; kind: 'read' | 'write' }[] = [];
  /** Paths that fail, so a test can prove one bad asset does not take a tour down. */
  readonly unreadable = new Set<string>();
  /** Set to make every write fail, for the "storage blinked" paths. */
  failUploads = false;

  private key(bucket: string, path: string): string { return `${bucket}/${path}`; }

  async signUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
    if (this.unreadable.has(this.key(bucket, path))) throw new Error('sign failed');
    this.signed.push({ bucket, path, seconds: expiresInSeconds, kind: 'read' });
    return `https://storage.test/${bucket}/${path}?token=signed&exp=${expiresInSeconds}`;
  }

  async signUploadUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
    this.signed.push({ bucket, path, seconds: expiresInSeconds, kind: 'write' });
    return `https://storage.test/${bucket}/${path}?token=upload&exp=${expiresInSeconds}`;
  }

  async download(bucket: string, path: string): Promise<Uint8Array> {
    const key = this.key(bucket, path);
    if (this.unreadable.has(key)) throw new Error(`download ${key} failed`);
    const object = this.objects.get(key);
    if (!object) throw new Error(`no object ${key}`);
    return object.bytes;
  }

  async upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (this.failUploads) throw new Error('storage unavailable');
    this.objects.set(this.key(bucket, path), { bytes, contentType });
  }

  put(bucket: string, path: string, text: string): void {
    this.objects.set(this.key(bucket, path), {
      bytes: new TextEncoder().encode(text), contentType: 'application/json',
    });
  }
}

// ---------------------------------------------------------------------------
// The rest of BaseDeps
// ---------------------------------------------------------------------------

export interface TestDeps {
  db: FakeDb;
  storage: FakeStorage;
  clock: { now(): Date };
  env: { get(name: string): string | undefined };
  authUser: (authorization: string | undefined) => Promise<{ id: string } | null>;
  randomId: () => string;
  log: (event: string, data: Record<string, unknown>) => void;
  logs: { event: string; data: Record<string, unknown> }[];
}

export interface TestDepsOptions {
  /** Token -> user id. A request whose Authorization is not here is anonymous. */
  readonly users?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: string;
}

export function makeTestDeps(opts: TestDepsOptions = {}): TestDeps {
  let time = new Date(opts.now ?? '2026-09-20T12:00:00.000Z');
  const clock = { now: () => time };
  const db = new FakeDb(() => time);
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  let ids = 0;

  return {
    db,
    storage: new FakeStorage(),
    clock,
    env: { get: (name: string) => opts.env?.[name] },
    authUser: async (authorization: string | undefined) => {
      const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      const id = token ? opts.users?.[token] : undefined;
      return id ? { id } : null;
    },
    randomId: () => { ids += 1; return `random-${ids}`; },
    log: (event, data) => { logs.push({ event, data }); },
    logs,
    // Exposed for tests that need to move time; kept off the interface so a
    // handler cannot reach it.
    ...({ advance: (ms: number) => { time = new Date(time.getTime() + ms); } } as object),
  } as TestDeps;
}

/** Move a TestDeps clock forward. */
export function advance(deps: TestDeps, ms: number): void {
  (deps as unknown as { advance: (ms: number) => void }).advance(ms);
}

/** A signed-in caller's Authorization header for `makeTestDeps({users})`. */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// A world, with the rows every handler expects to find behind it
// ---------------------------------------------------------------------------

export interface Tenant {
  readonly orgId: string;
  readonly propertyId: string;
  readonly worldId: string;
  readonly userId: string;
}

export interface TenantOptions {
  readonly role?: 'owner' | 'admin' | 'operator' | 'viewer';
  readonly userId?: string;
  readonly status?: string;
  readonly slug?: string;
  readonly buildMonthCap?: number;
  readonly label?: string;
}

/** Seed one org, one member, one property and one world. */
export function seedTenant(db: FakeDb, opts: TenantOptions = {}): Tenant {
  const orgId = db.nextId('org');
  const propertyId = db.nextId('prop');
  const worldId = db.nextId('world');
  const userId = opts.userId ?? db.nextId('user');

  db.seed('wv_org', [{
    id: orgId, slug: `org-${orgId.slice(-4)}`, name: 'Test Agency',
    build_month_cap: opts.buildMonthCap ?? 50, ai_month_cap_gbp: 25, ai_turns_per_session: 25,
  }]);
  db.seed('wv_member', [{
    org_id: orgId, user_id: userId, role: opts.role ?? 'owner',
    email: 'member@example.com', created_at: '2026-01-01T00:00:00.000Z',
  }]);
  db.seed('wv_property', [{
    id: propertyId, org_id: orgId, label: opts.label ?? 'Flat 2, 14 Example Road',
    ref: 'REF-1', postcode: 'SW1A 1AA', address: {}, archived_at: null,
  }]);
  db.seed('wv_world', [{
    id: worldId, property_id: propertyId, version: 1,
    status: opts.status ?? 'draft', published_at: null, slug: opts.slug ?? null,
    quality_score: null, supersedes_id: null, scale_source: null, scale_agreement: null,
    scale_provenance: null, scale_confidence: null, created_at: '2026-09-01T00:00:00.000Z',
  }]);

  return { orgId, propertyId, worldId, userId };
}
