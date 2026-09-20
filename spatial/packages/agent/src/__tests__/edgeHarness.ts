/**
 * An in-memory stand-in for everything the edge functions touch.
 *
 * This is what lets the handlers -- including every tenant-isolation check --
 * run under vitest in milliseconds with no Deno, no Supabase and no network.
 * The fake database is not a stub: it applies the same eq/in/order/limit
 * semantics the real PostgREST layer does, and it FAILS LOUDLY on a select
 * that does not name its columns, because column filtering is the only thing
 * standing between the public endpoint and an operator's data.
 */

import type {
  BaseDeps, Db, DbFilter, Row, SelectOptions, Storage, UpsertOptions,
} from '../../../../../supabase/functions/_wv_shared/deps.ts';
import type { HttpRequest } from '../../../../../supabase/functions/_wv_shared/http.ts';

export interface FakeDbOptions {
  /** Tables whose selects must always pass an explicit column list. */
  readonly strictColumns?: readonly string[];
}

export class FakeDb implements Db {
  readonly tables = new Map<string, Row[]>();
  readonly rpcs = new Map<string, (args: Record<string, unknown>) => unknown>();
  readonly calls: { op: string; table: string; detail?: unknown }[] = [];
  private seq = 0;
  private readonly strict: Set<string>;

  constructor(opts: FakeDbOptions = {}) {
    this.strict = new Set(opts.strictColumns ?? []);
  }

  seed(table: string, rows: Row[]): this {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows.map((r) => ({ ...r }))]);
    return this;
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  setRpc(name: string, fn: (args: Record<string, unknown>) => unknown): this {
    this.rpcs.set(name, fn);
    return this;
  }

  async select(table: string, opts: SelectOptions): Promise<Row[]> {
    this.calls.push({ op: 'select', table, detail: opts });
    if (this.strict.has(table) && (!opts.columns || opts.columns.length === 0)) {
      throw new Error(`select on '${table}' must name its columns`);
    }
    let rows = [...(this.tables.get(table) ?? [])];
    for (const [k, v] of Object.entries(opts.eq ?? {})) {
      rows = rows.filter((r) => (v === null ? r[k] === null || r[k] === undefined : String(r[k]) === String(v)));
    }
    for (const [k, vals] of Object.entries(opts.in ?? {})) {
      const set = new Set(vals.map(String));
      rows = rows.filter((r) => set.has(String(r[k])));
    }
    if (opts.order) {
      const { column, ascending } = opts.order;
      rows.sort((a, b) => {
        const x = String(a[column] ?? '');
        const y = String(b[column] ?? '');
        return ascending ? x.localeCompare(y) : y.localeCompare(x);
      });
    }
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    // Project exactly the requested columns, as PostgREST does. Returning
    // everything would let a handler leak a column it never asked for and the
    // test would not notice.
    if (opts.columns && opts.columns.length > 0) {
      return rows.map((r) => {
        const out: Row = {};
        for (const c of opts.columns!) if (c in r) out[c] = r[c];
        return out;
      });
    }
    return rows;
  }

  async insert(table: string, values: Row | Row[]): Promise<Row[]> {
    this.calls.push({ op: 'insert', table, detail: values });
    const list = Array.isArray(values) ? values : [values];
    const created = list.map((v) => ({
      // UUID-shaped, because the handlers validate ids with a UUID regex and a
      // fake that hands back "wv_property_1" would test a path real rows never
      // take.
      id: v['id'] ?? fakeUuid(++this.seq),
      created_at: new Date(1_700_000_000_000 + this.seq).toISOString(),
      ...v,
    }));
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...created]);
    return created.map((r) => ({ ...r }));
  }

  /**
   * Insert, or update the row already on the conflict target.
   *
   * Mirrors PostgREST's `resolution=merge-duplicates`, including the part that
   * matters most for the pipeline hand-off: only the columns PRESENT in the
   * payload are written, so a section that omits `name` leaves an operator's
   * rename standing rather than reverting it to the build's value.
   *
   * Like Postgres, it refuses a batch that names the same conflict target
   * twice -- "ON CONFLICT DO UPDATE command cannot affect row a second time"
   * is a real error a real ingest can hit, and a fake that quietly tolerated
   * it would hide the bug until production.
   */
  async upsert(table: string, values: Row | Row[], opts?: UpsertOptions): Promise<Row[]> {
    this.calls.push({ op: 'upsert', table, detail: { values, opts } });
    const list = Array.isArray(values) ? values : [values];
    const target = opts?.onConflict && opts.onConflict.length > 0 ? opts.onConflict : ['id'];
    const rows = this.tables.get(table) ?? [];
    this.tables.set(table, rows);

    const keyOf = (r: Row): string => target.map((c) => String(r[c])).join('\u0000');
    const inBatch = new Set<string>();
    const out: Row[] = [];
    for (const v of list) {
      const key = keyOf(v);
      if (inBatch.has(key)) {
        throw new Error(
          `upsert on '${table}' names the conflict target ${key.replace(/\u0000/g, ',')} twice`,
        );
      }
      inBatch.add(key);
      const existing = rows.find((r) => keyOf(r) === key);
      if (existing) {
        Object.assign(existing, v);
        out.push({ ...existing });
        continue;
      }
      const created: Row = {
        id: v['id'] ?? fakeUuid(++this.seq),
        created_at: new Date(1_700_000_000_000 + this.seq).toISOString(),
        ...v,
      };
      rows.push(created);
      out.push({ ...created });
    }
    return out;
  }

  async update(table: string, values: Row, where: DbFilter): Promise<Row[]> {
    this.calls.push({ op: 'update', table, detail: { values, where } });
    const rows = this.tables.get(table) ?? [];
    const hit: Row[] = [];
    for (const r of rows) {
      let match = true;
      for (const [k, v] of Object.entries(where)) {
        if (String(r[k]) !== String(v)) { match = false; break; }
      }
      if (!match) continue;
      Object.assign(r, values);
      hit.push({ ...r });
    }
    return hit;
  }

  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ op: 'rpc', table: name, detail: args });
    const fn = this.rpcs.get(name);
    if (!fn) throw new Error(`no fake rpc '${name}'`);
    return fn(args) as T;
  }
}

/** Deterministic, valid v4-shaped uuid for a sequence number. */
export function fakeUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `f0000000-0000-4000-8000-${hex}`;
}

export class FakeStorage implements Storage {
  readonly objects = new Map<string, Uint8Array>();
  readonly signed: { bucket: string; path: string; ttl: number }[] = [];
  readonly signedUploads: { bucket: string; path: string; ttl: number }[] = [];
  failSigning = false;

  put(bucket: string, path: string, bytes: Uint8Array): this {
    this.objects.set(`${bucket}/${path}`, bytes);
    return this;
  }

  async signUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
    if (this.failSigning) throw new Error('signing unavailable');
    this.signed.push({ bucket, path, ttl: expiresInSeconds });
    return `https://storage.test/${bucket}/${path}?token=signed&exp=${expiresInSeconds}`;
  }

  async signUploadUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
    if (this.failSigning) throw new Error('signing unavailable');
    this.signedUploads.push({ bucket, path, ttl: expiresInSeconds });
    return `https://storage.test/upload/${bucket}/${path}?token=upload&exp=${expiresInSeconds}`;
  }

  async download(bucket: string, path: string): Promise<Uint8Array> {
    const b = this.objects.get(`${bucket}/${path}`);
    if (!b) throw new Error(`no object ${bucket}/${path}`);
    return b;
  }

  async upload(bucket: string, path: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(`${bucket}/${path}`, bytes);
  }
}

export interface Rig {
  db: FakeDb;
  storage: FakeStorage;
  logs: { event: string; data: Record<string, unknown> }[];
  deps: BaseDeps;
}

export function makeDeps(opts: {
  db?: FakeDb;
  storage?: FakeStorage;
  env?: Record<string, string>;
  user?: { id: string } | null;
  now?: Date;
} = {}): Rig {
  const db = opts.db ?? new FakeDb();
  const storage = opts.storage ?? new FakeStorage();
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  let n = 0;
  const deps: BaseDeps = {
    db,
    storage,
    clock: { now: () => opts.now ?? new Date('2026-09-19T12:00:00.000Z') },
    env: { get: (k) => (opts.env ?? {})[k] },
    authUser: async (authorization) => {
      // The fake mirrors the real one's contract: a bearer token resolves to a
      // user, anything else resolves to nobody.
      if (!authorization || !/^Bearer\s+\S/.test(authorization)) return null;
      return opts.user ?? null;
    },
    randomId: () => `id_${++n}`,
    log: (event, data) => { logs.push({ event, data }); },
  };
  return { db, storage, logs, deps };
}

export function req(over: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'POST',
    path: '/',
    query: {},
    headers: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A two-tenant fixture, which is the only way to test isolation honestly
// ---------------------------------------------------------------------------

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const PROP_A = '33333333-3333-4333-8333-333333333333';
export const PROP_B = '44444444-4444-4444-8444-444444444444';
export const WORLD_A = '55555555-5555-4555-8555-555555555555';
export const WORLD_B = '66666666-6666-4666-8666-666666666666';

/**
 * Two orgs, two properties, two worlds. Org A's world is published; org B's is
 * a draft. Every isolation test crosses this boundary deliberately.
 */
export function twoTenantDb(): FakeDb {
  const db = new FakeDb({ strictColumns: ['wv_world', 'wv_room', 'wv_entity', 'wv_asset', 'wv_property'] });

  db.seed('wv_org', [
    { id: ORG_A, slug: 'alpha', name: 'Alpha Lettings', ai_month_cap_gbp: 25, build_month_cap: 50, ai_turns_per_session: 5 },
    { id: ORG_B, slug: 'beta', name: 'Beta Estates', ai_month_cap_gbp: 25, build_month_cap: 50, ai_turns_per_session: 25 },
  ]);
  db.seed('wv_member', [
    { org_id: ORG_A, user_id: USER_A, role: 'owner' },
    { org_id: ORG_B, user_id: USER_B, role: 'owner' },
  ]);
  db.seed('wv_property', [
    { id: PROP_A, org_id: ORG_A, label: 'Flat 2, Alpha Court', postcode: 'N1 1AA', ref: 'A-001' },
    { id: PROP_B, org_id: ORG_B, label: 'Beta House', postcode: 'SW1 2BB', ref: 'B-001' },
  ]);
  db.seed('wv_world', [
    {
      id: WORLD_A, property_id: PROP_A, version: 1, status: 'published',
      published_at: '2026-09-01T10:00:00.000Z', quality_score: 0.94, slug: 'flat-2-alpha-court',
      scale_source: 'ARKit depth', scale_agreement: 0.98, created_at: '2026-08-30T09:00:00.000Z',
      // Deliberately present and deliberately never returned: the manifest's
      // own privacy check exists to catch exactly this column escaping.
      edit_key: 'SECRET-EDIT-KEY-A',
    },
    {
      id: WORLD_B, property_id: PROP_B, version: 1, status: 'draft',
      published_at: null, quality_score: null, slug: 'beta-house',
      scale_source: null, scale_agreement: null, created_at: '2026-09-02T09:00:00.000Z',
      edit_key: 'SECRET-EDIT-KEY-B',
    },
  ]);
  db.seed('wv_room', [
    {
      id: '77777777-7777-4777-8777-777777777771', world_id: WORLD_A, stable_key: 'living',
      name: 'Living room', kind: 'living', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
      floor_z: 0, ceiling_z: 2.4, area_m2: 12, area_standard: 'RICS-COMP-GIA',
      area_tol_pct: 2.5, wall_tol_mm: 20, provenance: 'reconstructed', confidence: 0.93,
    },
    {
      id: '77777777-7777-4777-8777-777777777772', world_id: WORLD_B, stable_key: 'kitchen',
      name: 'Beta kitchen', kind: 'kitchen', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]],
      floor_z: 0, ceiling_z: 2.4, area_m2: 9, area_standard: 'RICS-COMP-GIA',
      area_tol_pct: 2.5, wall_tol_mm: 20, provenance: 'reconstructed', confidence: 0.9,
    },
  ]);
  db.seed('wv_asset', [
    {
      id: '88888888-8888-4888-8888-888888888881', world_id: WORLD_A, role: 'splat',
      format: 'spz', storage_path: 'alpha/world-a/splat.spz', bytes: 1024, chunk_key: null, lod: 0,
    },
    {
      id: '88888888-8888-4888-8888-888888888882', world_id: WORLD_A, role: 'source_media',
      format: 'mp4', storage_path: 'alpha/world-a/raw-walkthrough.mp4', bytes: 90_000_000,
    },
  ]);
  db.seed('wv_quality', [
    {
      id: 'q1', world_id: WORLD_A, score: 0.94, verdict: 'pass',
      checks: [{ name: 'scale_agreement', pass: true }], created_at: '2026-08-31T09:00:00.000Z',
    },
    {
      id: 'q2', world_id: WORLD_B, score: 0.71, verdict: 'review',
      checks: [{ name: 'ceiling_observed_fraction', pass: false }, { name: 'pose_coverage', pass: true }],
      created_at: '2026-09-03T09:00:00.000Z',
    },
  ]);

  const orgOf: Record<string, string> = { [WORLD_A]: ORG_A, [WORLD_B]: ORG_B };
  db.setRpc('wv_org_of_world', (args) => orgOf[String(args['p_world'])] ?? null);
  db.setRpc('wv_spend_allowed', () => ({ allowed: true }));
  return db;
}
