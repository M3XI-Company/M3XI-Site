/**
 * What to do when a request fails, on a property with one bar of signal.
 *
 * This is a separate file from the code that does the requesting because the
 * decision is the part that must be right and the part that is impossible to
 * exercise for real: reproducing a lift journey, a 3 GB upload and a 502 from
 * a CDN edge inside a test is not something anyone is going to do. The rule is
 * therefore written as a pure function over a status code, and the network code
 * has no opinions of its own.
 *
 * THE RULE IS NOT "RETRY ON FAILURE". Five distinct things can go wrong during
 * an upload and four of them want different handling, so `dispositionOf`
 * returns which of the five it is rather than a boolean:
 *
 *   retry          the request might work if repeated. Network errors, 5xx,
 *                  429. Back off and go again.
 *   refresh_auth   401. The access token aged out mid-upload — a 3 GB upload
 *                  outlives an hour-long token often enough that this is the
 *                  normal case, not the exceptional one. Refresh once, then
 *                  retry; a second 401 after a fresh token is fatal, because
 *                  retrying it forever is how an app sits on a doorstep
 *                  spinning while the operator waits.
 *   restart_upload 404/410 on an upload URL. Supabase's resumable upload URLs
 *                  are valid for up to 24 hours and then they are gone. The
 *                  bytes are not resumable any more, so the correct action is
 *                  to create a new upload — NOT to retry a URL that will 404
 *                  forever.
 *   conflict       409. Supabase documents this precisely: two clients on one
 *                  upload URL, or two upload URLs racing for one object path.
 *                  Retrying is what CAUSES the second case, so this stops and
 *                  asks, rather than fighting itself for the object.
 *   fatal          400, 403, 413, 422 and anything else. A malformed request or
 *                  a refusal by policy does not become correct on the third
 *                  attempt, and the operator needs to be told now, while they
 *                  are still at the property.
 *
 * WHY EQUAL JITTER AND NOT FULL JITTER. Full jitter (`random() * cap`) can
 * return a delay of nearly zero, and a retry issued 3 ms after a connection
 * timed out on a congested mobile link is another timeout — it spends the
 * attempt budget without ever giving the link time to recover. Equal jitter
 * keeps half the backoff as a floor and randomises the other half, which still
 * spreads a fleet of phones that all lost signal in the same lift while
 * guaranteeing the link gets the pause it needs. The cost is slightly less
 * spread than full jitter; with a handful of operators rather than a datacentre
 * of clients, that cost is not real and the floor is.
 */

/** What the caller should do about a failed request. */
export type Disposition = 'retry' | 'refresh_auth' | 'restart_upload' | 'conflict' | 'fatal';

export interface RetryPolicy {
  /** Delay before the first retry, in ms, before jitter. */
  readonly baseMs: number;
  /** Ceiling on the backoff, in ms. */
  readonly maxMs: number;
  /**
   * Attempts in total, including the first. 1 means "no retries".
   *
   * Six is the default and it is chosen against the wait an operator will
   * tolerate rather than against a probability: 1 + 2 + 4 + 8 + 16 seconds of
   * backoff is about half a minute of trying, which is long enough to survive
   * a lift and short enough that someone standing in a hall does not conclude
   * the app has hung.
   */
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 1000, maxMs: 16_000, maxAttempts: 6 };

/**
 * A chunk PATCH gets its own, shorter policy.
 *
 * A 5-minute 4K walkthrough is 1.7-3.8 GB, which is 280-640 chunks at the 6 MB
 * Supabase requires. A policy that spends thirty seconds failing on each of
 * them turns a bad link into a five-hour upload with no visible end, so a chunk
 * gives up sooner and the upload loop — which knows the offset and can simply
 * carry on where it stopped — decides whether to keep going. Giving up on a
 * chunk is cheap here in a way that giving up on a whole upload is not.
 */
export const CHUNK_RETRY: RetryPolicy = { baseMs: 800, maxMs: 8000, maxAttempts: 4 };

export function dispositionOf(status: number | null): Disposition {
  // A null status is a fetch that never got an answer: DNS, TLS, a dropped
  // connection, a navigation away. Those are the ones retrying was invented
  // for.
  if (status === null) return 'retry';
  if (status === 401) return 'refresh_auth';
  if (status === 404 || status === 410) return 'restart_upload';
  if (status === 409) return 'conflict';
  if (status === 408 || status === 425 || status === 429) return 'retry';
  if (status >= 500 && status <= 599) return 'retry';
  // 2xx should not reach here, but if it does it is not an error to retry.
  if (status >= 200 && status < 300) return 'fatal';
  return 'fatal';
}

/**
 * How long to wait before attempt number `attempt` (0 is the first retry).
 *
 * `random` is injected so the test can assert the exact number rather than a
 * range, which is the difference between a test that pins the rule and a test
 * that re-implements it.
 */
export function retryDelayMs(
  attempt: number, policy: RetryPolicy = DEFAULT_RETRY, random: () => number = Math.random,
): number {
  if (attempt < 0) return 0;
  const uncapped = policy.baseMs * Math.pow(2, attempt);
  const capped = Math.min(policy.maxMs, uncapped);
  const half = capped / 2;
  return Math.round(half + random() * half);
}

/**
 * Honour `Retry-After` when the server sent one, otherwise back off.
 *
 * A server that has said how long to wait knows something the client does not,
 * and ignoring it is how a rate limit becomes a ban. Both forms are accepted:
 * delta-seconds and an HTTP-date. The value is clamped to two minutes because
 * a header saying "come back in an hour" is not something to obey while
 * somebody is standing in a stranger's hall — at that point the upload should
 * be parked and resumed later, which is a decision for the screen, not for a
 * sleep.
 */
export const RETRY_AFTER_CAP_MS = 120_000;

export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(RETRY_AFTER_CAP_MS, Number(trimmed) * 1000);
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - nowMs));
}

/**
 * An error that carries the status, so the disposition survives the throw.
 *
 * Without this, a caller has a string and has to match on its prose to decide
 * whether to retry, and prose changes.
 */
export class TransportError extends Error {
  readonly status: number | null;
  readonly disposition: Disposition;
  /** The server's own body, truncated. Shown to the operator when it is short. */
  readonly detail: string;
  /**
   * The `Retry-After` header verbatim, when there was one.
   *
   * Carried as the raw header rather than as a parsed number so the decision
   * of whether to obey it, and the clamp on how long, stays in one place
   * (`retryAfterMs`) instead of being made at every throw site.
   */
  readonly retryAfter: string | null;

  constructor(status: number | null, message: string, detail = '', retryAfter: string | null = null) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
    this.disposition = dispositionOf(status);
    this.detail = detail.slice(0, 300);
    this.retryAfter = retryAfter;
  }
}

export interface AttemptContext {
  /** 0 for the first try. */
  readonly attempt: number;
  readonly error: TransportError;
  readonly delayMs: number;
}

export interface RunOptions {
  readonly policy?: RetryPolicy;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so a screen can say "retrying in 4 s". */
  readonly onRetry?: (ctx: AttemptContext) => void;
  /**
   * Refresh the credential. Called at most ONCE per `run`, on the first 401.
   * Absent, a 401 is fatal — which is correct: an app with no way to refresh
   * cannot fix a 401 by asking again.
   */
  readonly refreshAuth?: () => Promise<void>;
  /** Aborts the whole run between attempts. */
  readonly signal?: { readonly aborted: boolean };
}

/**
 * Run one request with the rule above applied.
 *
 * `fn` must throw a `TransportError`; anything else is rethrown untouched,
 * because an exception this code does not understand is not something to paper
 * over with four more attempts.
 */
export async function runWithRetry<T>(
  fn: (attempt: number) => Promise<T>, options: RunOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  let refreshed = false;

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw new TransportError(null, 'Cancelled.');
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof TransportError)) throw err;
      const last = attempt >= policy.maxAttempts - 1;

      if (err.disposition === 'refresh_auth' && options.refreshAuth && !refreshed) {
        // Not a backoff: a fresh token is not something waiting improves, and
        // the operator is standing still while this happens.
        refreshed = true;
        await options.refreshAuth();
        continue;
      }
      if (err.disposition !== 'retry' || last) throw err;

      const after = retryAfterMs(err.retryAfter, now());
      const delayMs = after ?? retryDelayMs(attempt, policy, random);
      options.onRetry?.({ attempt, error: err, delayMs });
      await sleep(delayMs);
    }
  }
}
