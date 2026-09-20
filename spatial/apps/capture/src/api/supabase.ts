/**
 * A Supabase client for the capture app.
 *
 * THIS IS A DELIBERATE COPY of `spatial/apps/console/src/api/supabase.ts`, not
 * an import of it, and the copy is the right call for three reasons that are
 * worth writing down because "don't repeat yourself" says otherwise.
 *
 *   The apps are separate builds with separate entries in the root
 *   vite.config.js, and the console's entry is guarded on `spatialInstalled`
 *   (it reaches three.js through the correction editor) while the capture
 *   page is built unconditionally. Importing across that boundary would put a
 *   file from the guarded app into the unguarded one, and the first time
 *   someone added a console-ui import to the console's client, the capture
 *   page would start needing three.js to build. That failure would arrive
 *   months later, in somebody else's pull request, as a broken deploy.
 *
 *   The two clients need different things. The console needs `count=exact`
 *   paging, PATCH, magic links and signed URLs. The capture app needs sign-in,
 *   refresh, two narrow selects and one edge function, and it must work on a
 *   phone in a hallway. What is left out of this copy is most of it.
 *
 *   The storage key is different ON PURPOSE. An operator can be signed into
 *   the console and the capture app as different people on the same device —
 *   the office account and the person doing the walk — and one shared key
 *   would silently sign one of them out mid-capture.
 *
 * What is NOT copied and must not drift is the behaviour: refresh BEFORE
 * expiry rather than after a 401, and a wrong password and an unknown address
 * reading the same.
 */

import { TransportError, dispositionOf } from './retry.js';

export interface StoredSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly userId: string;
  readonly email: string;
}

/** Not the console's key. See the header. */
const STORAGE_KEY = 'm3xi.capture.session';

/**
 * Refresh this long before expiry.
 *
 * Five minutes rather than the console's one, because a PATCH here carries
 * 6 MB over a mobile link and can be in flight for well over a minute. A token
 * that was valid when the request started and expired before the body finished
 * is a 401 at the worst possible moment, and the margin is what buys the
 * request time to land.
 */
const REFRESH_MARGIN_MS = 300_000;

export class SupabaseClient {
  readonly url: string;
  readonly anonKey: string;
  private stored: StoredSession | null = null;
  private refreshing: Promise<StoredSession> | null = null;

  constructor(url: string, anonKey: string) {
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
  }

  get session(): StoredSession | null { return this.stored; }

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
    } catch {
      // Private browsing. The session works for this tab and does not survive
      // a reload, which is worth saying nothing about: the capture does
      // survive, because the recording is in IndexedDB under its own key.
    }
  }

  async signIn(email: string, password: string): Promise<StoredSession> {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).catch((err: unknown) => {
      throw new TransportError(null, 'No connection. Sign in when you have signal.', String(err));
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new TransportError(res.status, describeAuthError(res.status, body));
    return this.acceptToken(body);
  }

  async signOut(): Promise<void> {
    const token = this.stored?.accessToken;
    this.persist(null);
    if (!token) return;
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
    if (!accessToken || !refreshToken) {
      throw new TransportError(500, 'The sign-in response was incomplete.');
    }
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

  /**
   * Force a refresh, whatever the clock says.
   *
   * The upload loop calls this when it gets a 401 mid-chunk. It is separate
   * from `token()` because that one refreshes on a prediction and this one
   * refreshes on evidence, and the evidence wins.
   */
  async refreshNow(): Promise<void> { await this.refresh(); }

  private async refresh(): Promise<StoredSession> {
    const current = this.stored;
    if (!current) throw new TransportError(401, 'Signed out.');
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const res = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      }).catch((err: unknown) => {
        // A refresh that could not reach the server is NOT a signed-out state.
        // Clearing the session here would sign an operator out because they
        // walked into a basement, and the recording would still be on the
        // phone with no account to attach it to.
        throw new TransportError(null, 'No connection, so the session could not be renewed.', String(err));
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        this.persist(null);
        throw new TransportError(401, 'Your session has expired. Sign in again.');
      }
      return this.acceptToken(body);
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async token(): Promise<string> {
    const current = this.stored;
    if (!current) throw new TransportError(401, 'Sign in.');
    if (current.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      return (await this.refresh()).accessToken;
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

  /**
   * PostgREST select, as the signed-in member, under RLS.
   *
   * Narrower than the console's: no counts, no ranges, no `or`. The capture
   * app reads two lists — properties and their worlds — and a phone on a
   * hallway connection should not be paying for an exact count of anything.
   */
  async select<T>(table: string, query: {
    readonly select: string;
    readonly eq?: Readonly<Record<string, string | number | boolean>>;
    readonly in?: Readonly<Record<string, readonly string[]>>;
    readonly isNull?: readonly string[];
    readonly order?: { readonly column: string; readonly ascending: boolean };
    readonly limit?: number;
  }): Promise<readonly T[]> {
    const params = new URLSearchParams();
    params.set('select', query.select);
    for (const [k, v] of Object.entries(query.eq ?? {})) params.append(k, `eq.${v}`);
    for (const [k, v] of Object.entries(query.in ?? {})) {
      params.append(k, `in.(${v.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(',')})`);
    }
    for (const column of query.isNull ?? []) params.append(column, 'is.null');
    if (query.order) {
      params.set('order', `${query.order.column}.${query.order.ascending ? 'asc' : 'desc'}`);
    }
    if (query.limit !== undefined) params.set('limit', String(query.limit));

    const res = await fetch(`${this.url}/rest/v1/${table}?${params.toString()}`, {
      headers: await this.authHeaders(),
    }).catch((err: unknown) => {
      throw new TransportError(null, `No connection, so ${table} could not be read.`, String(err));
    });
    if (!res.ok) {
      throw new TransportError(res.status, `Could not read ${table}.`, (await res.text()).slice(0, 200));
    }
    return (await res.json()) as T[];
  }

  /** POST to a wv-* edge function. */
  async fn<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.url}/functions/v1/${name}`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(body),
    }).catch((err: unknown) => {
      throw new TransportError(null, `No connection, so ${name} could not be called.`, String(err));
    });
    const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const message = typeof parsed['error'] === 'string' ? parsed['error'] : `${name} failed (${res.status}).`;
      throw new TransportError(res.status, message);
    }
    return parsed as T;
  }
}

/**
 * The upload loop speaks `UploadCredentials`, not `SupabaseClient`.
 *
 * Keeping the two apart is what lets `uploadRecording` be tested against a
 * fake with no auth server anywhere near it, and it is also the honest shape:
 * the uploader needs a bearer token on demand and nothing else about a
 * session.
 */
export function credentialsFor(client: SupabaseClient): {
  accessToken(): Promise<string>; readonly anonKey: string;
} {
  return {
    accessToken: () => client.token(),
    anonKey: client.anonKey,
  };
}

function describeAuthError(status: number, body: Record<string, unknown>): string {
  const code = String(body['error_code'] ?? body['error'] ?? '');
  if (status === 400 || status === 401) {
    if (code.includes('email_not_confirmed')) return 'That address has not been confirmed yet. Check your inbox.';
    // Deliberately identical for a wrong password and an unknown address.
    return 'That email address and password do not match an account.';
  }
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (dispositionOf(status) === 'retry') return 'The sign-in service is not answering. Try again in a moment.';
  return 'Could not sign in right now.';
}
