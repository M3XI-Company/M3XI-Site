/**
 * A tiny HTTP shape that is not the Web `Request`.
 *
 * Every wv-* function is written as a pure `(req, deps) => res` handler over
 * these plain objects, and `index.ts` adapts Deno's Request to them. That is
 * not ceremony: it means the handlers -- including the tenant-isolation checks
 * that must never regress -- run under vitest in Node with injected fakes, at
 * millisecond speed, with no Deno, no network and no database.
 *
 * The rule is that nothing below this file may import a Deno global.
 */

export interface HttpRequest {
  readonly method: string;
  /** Path after the function name, e.g. "/claim". Always starts with "/". */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body, or undefined. Never a string. */
  readonly body?: unknown;
  /** Best-effort client address, for rate limiting. */
  readonly ip?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export const CORS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wv-worker-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, body, headers };
}

/**
 * Errors the public gets. Deliberately vague: an anonymous caller must not be
 * able to tell "this world does not exist" from "this world exists but is not
 * published" from "this world belongs to someone else", because that
 * difference is an enumeration oracle over every customer's portfolio.
 */
export function fail(status: number, message: string): HttpResponse {
  return { status, body: { error: message }, headers: {} };
}

export const NOT_FOUND = (): HttpResponse => fail(404, 'Not found.');

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

/**
 * `wv-view` is the one endpoint anonymous traffic touches, so every value that
 * crosses it is treated as an attack until coerced. These helpers never throw:
 * a handler that throws on bad input is a denial-of-service surface.
 */
export function str(v: unknown, max = 256): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0 || s.length > max) return null;
  return s;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(v: unknown): string | null {
  const s = str(v, 36);
  return s && UUID.test(s) ? s.toLowerCase() : null;
}

/** Slugs are user-visible and appear in URLs, so the charset is closed. */
export function slug(v: unknown): string | null {
  const s = str(v, 120);
  return s && /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(s) ? s : null;
}

export function int(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Constant-time string comparison for shared secrets.
 *
 * A `===` on a worker secret leaks its length and its matching prefix through
 * timing. The comparison is cheap and the secret is long-lived, so there is no
 * excuse for the faster version.
 */
export function secretEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
