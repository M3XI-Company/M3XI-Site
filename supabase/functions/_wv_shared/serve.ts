/**
 * The Deno edge boundary.
 *
 * Everything Deno-specific lives here and in each function's index.ts: the
 * Request adapter, PostgREST over the service role, Storage, and env access.
 * The handlers below this line are pure and are tested without any of it.
 */

import type { BaseDeps, Db, DbFilter, Row, SelectOptions, Storage, UpsertOptions } from './deps.ts';
import type { HttpRequest, HttpResponse } from './http.ts';
import { CORS } from './http.ts';

declare const Deno: { env: { get(key: string): string | undefined } };

const MAX_BODY_BYTES = 256 * 1024;

function envGet(name: string): string | undefined {
  try { return Deno.env.get(name); } catch { return undefined; }
}

function baseUrl(): string {
  return envGet('SUPABASE_URL') ?? '';
}

function serviceHeaders(): Record<string, string> {
  const key = envGet('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

/** PostgREST, with the explicit column lists the handlers pass down. */
export function makeDb(): Db {
  const encodeValue = (v: unknown): string => {
    if (v === null) return 'is.null';
    if (Array.isArray(v)) return `in.(${v.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(',')})`;
    return `eq.${encodeURIComponent(String(v))}`;
  };

  const query = (opts: SelectOptions): string => {
    const params: string[] = [];
    params.push(`select=${(opts.columns ?? ['*']).join(',')}`);
    for (const [k, v] of Object.entries(opts.eq ?? {})) params.push(`${k}=${encodeValue(v)}`);
    for (const [k, v] of Object.entries(opts.in ?? {})) {
      params.push(`${k}=in.(${v.map((x) => encodeURIComponent(x)).join(',')})`);
    }
    if (opts.order) params.push(`order=${opts.order.column}.${opts.order.ascending ? 'asc' : 'desc'}`);
    if (opts.limit !== undefined) params.push(`limit=${Math.max(1, Math.floor(opts.limit))}`);
    return params.join('&');
  };

  const asArray = async (res: Response): Promise<Row[]> => {
    if (!res.ok) throw new Error(`postgrest ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json().catch(() => []);
    return Array.isArray(body) ? body as Row[] : [body as Row];
  };

  return {
    async select(table, opts) {
      const res = await fetch(`${baseUrl()}/rest/v1/${table}?${query(opts)}`, {
        headers: serviceHeaders(),
      });
      return asArray(res);
    },
    async insert(table, values) {
      const res = await fetch(`${baseUrl()}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...serviceHeaders(), Prefer: 'return=representation' },
        body: JSON.stringify(values),
      });
      return asArray(res);
    },
    async upsert(table, values, opts?: UpsertOptions) {
      // `resolution=merge-duplicates` is PostgREST's ON CONFLICT DO UPDATE.
      // Without an explicit on_conflict it resolves against the primary key,
      // which is what the deterministic-id sections rely on; wv_room and
      // wv_entity name (world_id, stable_key) instead, because that is the
      // unique index the schema already carries and the key a rescan must
      // land on.
      const target = opts?.onConflict?.length
        ? `?on_conflict=${opts.onConflict.map(encodeURIComponent).join(',')}` : '';
      const res = await fetch(`${baseUrl()}/rest/v1/${table}${target}`, {
        method: 'POST',
        headers: {
          ...serviceHeaders(),
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(values),
      });
      return asArray(res);
    },
    async update(table, values, where: DbFilter) {
      const params = Object.entries(where)
        .map(([k, v]) => `${k}=eq.${encodeURIComponent(String(v))}`).join('&');
      const res = await fetch(`${baseUrl()}/rest/v1/${table}?${params}`, {
        method: 'PATCH',
        headers: { ...serviceHeaders(), Prefer: 'return=representation' },
        body: JSON.stringify(values),
      });
      return asArray(res);
    },
    async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const res = await fetch(`${baseUrl()}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: serviceHeaders(), body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`rpc ${name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json() as T;
    },
  };
}

export function makeStorage(): Storage {
  return {
    async signUrl(bucket, path, expiresInSeconds) {
      const res = await fetch(`${baseUrl()}/storage/v1/object/sign/${bucket}/${path}`, {
        method: 'POST', headers: serviceHeaders(),
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!res.ok) throw new Error(`sign ${res.status}`);
      const j = await res.json() as { signedURL?: string };
      if (!j.signedURL) throw new Error('sign: no url');
      return `${baseUrl()}/storage/v1${j.signedURL}`;
    },
    async signUploadUrl(bucket, path, expiresInSeconds) {
      // Supabase mints these with an expiry it controls; expiresInSeconds is
      // passed for parity with signUrl and for the fake to assert on. Keep the
      // caller's expiry short anyway: the URL is the credential.
      const res = await fetch(`${baseUrl()}/storage/v1/object/upload/sign/${bucket}/${path}`, {
        method: 'POST', headers: serviceHeaders(),
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!res.ok) throw new Error(`sign upload ${res.status}`);
      const j = await res.json() as { url?: string };
      if (!j.url) throw new Error('sign upload: no url');
      return `${baseUrl()}/storage/v1${j.url}`;
    },
    async download(bucket, path) {
      const res = await fetch(`${baseUrl()}/storage/v1/object/${bucket}/${path}`, {
        headers: serviceHeaders(),
      });
      if (!res.ok) throw new Error(`download ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async upload(bucket, path, bytes, contentType) {
      const res = await fetch(`${baseUrl()}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: { ...serviceHeaders(), 'Content-Type': contentType, 'x-upsert': 'true' },
        body: bytes as unknown as BodyInit,
      });
      if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

/**
 * Resolve the signed-in user by asking the auth server to verify the token.
 *
 * The anon key is itself a valid JWT, so a token that equals it is explicitly
 * rejected: treating it as a user would give every anonymous visitor operator
 * rights.
 */
export async function authUser(authorization: string | undefined): Promise<{ id: string } | null> {
  const anon = envGet('SUPABASE_ANON_KEY') ?? '';
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token === anon) return null;
  const res = await fetch(`${baseUrl()}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anon },
  });
  if (!res.ok) return null;
  const user = await res.json() as { id?: string };
  return user?.id ? { id: String(user.id) } : null;
}

export function makeBaseDeps(): BaseDeps {
  return {
    db: makeDb(),
    storage: makeStorage(),
    clock: { now: () => new Date() },
    env: { get: envGet },
    authUser,
    randomId: () => crypto.randomUUID(),
    log: (event, data) => {
      // Structured, one line, no personal data by construction: callers pass
      // ids, not names, emails or questions.
      console.log(JSON.stringify({ event, ...data }));
    },
  };
}

/** Adapt a Deno Request into the plain shape the handlers take. */
export async function toHttpRequest(req: Request, functionName: string): Promise<HttpRequest> {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  let body: unknown;
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      // Refused rather than parsed: a 10 MB body is not a question.
      body = undefined;
    } else {
      try { body = JSON.parse(raw); } catch { body = undefined; }
    }
  }

  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });

  const marker = `/${functionName}`;
  const at = url.pathname.indexOf(marker);
  const path = at >= 0 ? url.pathname.slice(at + marker.length) || '/' : url.pathname;

  return {
    method: req.method,
    path: path.startsWith('/') ? path : `/${path}`,
    query,
    headers,
    body,
    ip: headers['x-forwarded-for']?.split(',')[0]?.trim(),
  };
}

export function toResponse(res: HttpResponse): Response {
  if (res.body instanceof Uint8Array) {
    return new Response(res.body as unknown as BodyInit, {
      status: res.status,
      headers: { ...CORS, 'Content-Type': 'application/octet-stream', ...(res.headers ?? {}) },
    });
  }
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...(res.headers ?? {}) },
  });
}

/** One line per function: adapt, dispatch, adapt back, never leak a stack. */
export function serveHandler<D>(
  functionName: string,
  deps: D,
  handler: (req: HttpRequest, deps: D) => Promise<HttpResponse>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try {
      const http = await toHttpRequest(req, functionName);
      return toResponse(await handler(http, deps));
    } catch (err) {
      // The caller gets nothing useful; the logs get everything.
      console.log(JSON.stringify({ event: `${functionName}_unhandled`, error: String(err) }));
      return toResponse({ status: 500, body: { error: 'Something went wrong.' } });
    }
  };
}
