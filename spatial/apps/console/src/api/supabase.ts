/**
 * A Supabase client small enough to read.
 *
 * There is no SDK here on purpose. The console needs four things — sign in,
 * refresh, PostgREST with an exact row count, and a POST to an edge function —
 * and each of them is a fetch. Pulling in a client library to do that would
 * add a dependency to a workspace that currently has none outside the renderer.
 *
 * Two things this gets right that hand-rolled clients usually do not:
 *   - the access token is refreshed BEFORE a request when it is close to
 *     expiry, rather than after a 401, so a long session does not blink;
 *   - `count=exact` is requested only where the total is actually displayed,
 *     because an exact count is a full scan and the portfolio is the one place
 *     worth paying for it.
 */

export interface StoredSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly userId: string;
  readonly email: string;
}

const STORAGE_KEY = 'm3xi.console.session';
/** Refresh this long before expiry rather than waiting for a 401. */
const REFRESH_MARGIN_MS = 60_000;

export class SupabaseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SelectQuery {
  readonly select: string;
  readonly eq?: Readonly<Record<string, string | number | boolean>>;
  readonly in?: Readonly<Record<string, readonly string[]>>;
  readonly gte?: Readonly<Record<string, string | number>>;
  readonly or?: string;
  readonly order?: { readonly column: string; readonly ascending: boolean };
  readonly limit?: number;
  readonly range?: { readonly from: number; readonly to: number };
  readonly count?: boolean;
  readonly isNull?: readonly string[];
}

export interface SelectResult<T> {
  readonly rows: readonly T[];
  /** Null unless `count` was requested. */
  readonly total: number | null;
}

export class SupabaseClient {
  readonly url: string;
  readonly anonKey: string;
  private stored: StoredSession | null = null;
  private refreshing: Promise<StoredSession> | null = null;

  constructor(url: string, anonKey: string) {
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
  }

  get session(): StoredSession | null {
    return this.stored;
  }

  restore(): StoredSession | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredSession;
      if (typeof parsed?.refreshToken !== 'string') return null;
      this.stored = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  private persist(session: StoredSession | null): void {
    this.stored = session;
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* private mode: the session simply does not survive a reload */ }
  }

  async signIn(email: string, password: string): Promise<StoredSession> {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Auth errors are shown verbatim where they are safe to show; a wrong
      // password and an unknown address deliberately read the same.
      throw new SupabaseError(res.status, describeAuthError(res.status, body));
    }
    return this.acceptToken(body);
  }

  async sendMagicLink(email: string): Promise<void> {
    const res = await fetch(`${this.url}/auth/v1/otp`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, create_user: false }),
    });
    if (!res.ok) {
      throw new SupabaseError(res.status, 'Could not send the sign-in link. Try again in a moment.');
    }
  }

  async signOut(): Promise<void> {
    const token = this.stored?.accessToken;
    this.persist(null);
    if (!token) return;
    // Best effort: the local session is already gone either way.
    await fetch(`${this.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: this.anonKey, Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }

  private acceptToken(body: Record<string, unknown>): StoredSession {
    const accessToken = String(body['access_token'] ?? '');
    const refreshToken = String(body['refresh_token'] ?? '');
    const expiresIn = Number(body['expires_in'] ?? 3600);
    const user = (body['user'] ?? {}) as Record<string, unknown>;
    if (!accessToken || !refreshToken) throw new SupabaseError(500, 'The sign-in response was incomplete.');
    const session: StoredSession = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + Math.max(30, expiresIn) * 1000,
      userId: String(user['id'] ?? ''),
      email: String(user['email'] ?? ''),
    };
    this.persist(session);
    return session;
  }

  private async refresh(): Promise<StoredSession> {
    const current = this.stored;
    if (!current) throw new SupabaseError(401, 'Signed out.');
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const res = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.persist(null);
        throw new SupabaseError(401, 'Your session has expired. Sign in again.');
      }
      return this.acceptToken(body);
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async token(): Promise<string> {
    const current = this.stored;
    if (!current) throw new SupabaseError(401, 'Sign in.');
    if (current.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      const next = await this.refresh();
      return next.accessToken;
    }
    return current.accessToken;
  }

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${await this.token()}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  /** PostgREST select, as the signed-in member, under RLS. */
  async select<T>(table: string, query: SelectQuery): Promise<SelectResult<T>> {
    const params = new URLSearchParams();
    params.set('select', query.select);
    for (const [k, v] of Object.entries(query.eq ?? {})) params.append(k, `eq.${v}`);
    for (const [k, v] of Object.entries(query.gte ?? {})) params.append(k, `gte.${v}`);
    for (const [k, v] of Object.entries(query.in ?? {})) {
      params.append(k, `in.(${v.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(',')})`);
    }
    for (const column of query.isNull ?? []) params.append(column, 'is.null');
    if (query.or) params.append('or', query.or);
    if (query.order) params.set('order', `${query.order.column}.${query.order.ascending ? 'asc' : 'desc'}`);
    if (query.limit !== undefined) params.set('limit', String(query.limit));

    const headers = await this.authHeaders();
    if (query.range) headers['Range'] = `${query.range.from}-${query.range.to}`;
    if (query.count) headers['Prefer'] = 'count=exact';

    const res = await fetch(`${this.url}/rest/v1/${table}?${params.toString()}`, { headers });
    if (!res.ok) {
      throw new SupabaseError(res.status, `Could not read ${table}: ${(await res.text()).slice(0, 200)}`);
    }
    const rows = (await res.json()) as T[];
    const contentRange = res.headers.get('content-range');
    const total = contentRange ? Number(contentRange.split('/')[1]) : null;
    return { rows, total: Number.isFinite(total) ? total : null };
  }

  async insert<T>(table: string, values: Record<string, unknown> | Record<string, unknown>[]): Promise<T[]> {
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: await this.authHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify(values),
    });
    if (!res.ok) throw new SupabaseError(res.status, `Could not write ${table}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T[];
  }

  async patch<T>(table: string, values: Record<string, unknown>, where: Record<string, string>): Promise<T[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(where)) params.append(k, `eq.${v}`);
    const res = await fetch(`${this.url}/rest/v1/${table}?${params.toString()}`, {
      method: 'PATCH',
      headers: await this.authHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify(values),
    });
    if (!res.ok) throw new SupabaseError(res.status, `Could not update ${table}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T[];
  }

  /** POST to a wv-* edge function. */
  async fn<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.url}/functions/v1/${name}`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = typeof parsed?.error === 'string' ? parsed.error : `${name} failed (${res.status}).`;
      throw new SupabaseError(res.status, message);
    }
    return parsed as T;
  }

  /** A short-lived read URL for a private asset, or null if storage refuses. */
  async signStorageUrl(bucket: string, path: string, seconds: number): Promise<string | null> {
    try {
      const res = await fetch(`${this.url}/storage/v1/object/sign/${bucket}/${path}`, {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify({ expiresIn: seconds }),
      });
      if (!res.ok) return null;
      const body = await res.json() as { signedURL?: string };
      return body.signedURL ? `${this.url}/storage/v1${body.signedURL}` : null;
    } catch {
      return null;
    }
  }
}

function describeAuthError(status: number, body: Record<string, unknown>): string {
  const code = String(body['error_code'] ?? body['error'] ?? '');
  if (status === 400 || status === 401) {
    if (code.includes('email_not_confirmed')) return 'That address has not been confirmed yet. Check your inbox.';
    return 'That email address and password do not match an account.';
  }
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  return 'Could not sign in right now.';
}
