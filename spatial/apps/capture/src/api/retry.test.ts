/**
 * The retry rule.
 *
 * The interesting assertions are the NEGATIVE ones: a 409 must not be retried,
 * because retrying it is what creates the second racing upload; a 404 on an
 * upload URL must not be retried, because that URL will 404 forever and the
 * attempts are budget spent not resuming; and a 401 must be retried exactly
 * once after a refresh, because an app that refreshes in a loop sits on a
 * doorstep spinning while the operator waits for it.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RETRY, DEFAULT_RETRY, RETRY_AFTER_CAP_MS, TransportError, dispositionOf,
  retryAfterMs, retryDelayMs, runWithRetry,
} from './retry.js';

describe('dispositionOf', () => {
  it('retries what repeating might fix', () => {
    expect(dispositionOf(null)).toBe('retry');   // the connection never answered
    expect(dispositionOf(500)).toBe('retry');
    expect(dispositionOf(502)).toBe('retry');
    expect(dispositionOf(503)).toBe('retry');
    expect(dispositionOf(429)).toBe('retry');
    expect(dispositionOf(408)).toBe('retry');
  });

  it('treats 401 as a credential to refresh, not a failure to repeat', () => {
    expect(dispositionOf(401)).toBe('refresh_auth');
  });

  it('treats a dead upload URL as a restart, never as a retry', () => {
    expect(dispositionOf(404)).toBe('restart_upload');
    expect(dispositionOf(410)).toBe('restart_upload');
  });

  it('stops on 409 rather than racing itself for the object', () => {
    expect(dispositionOf(409)).toBe('conflict');
  });

  it('is fatal for a refusal that repeating cannot change', () => {
    expect(dispositionOf(400)).toBe('fatal');
    expect(dispositionOf(403)).toBe('fatal');
    expect(dispositionOf(413)).toBe('fatal');
    expect(dispositionOf(422)).toBe('fatal');
  });
});

describe('retryDelayMs', () => {
  const half = () => 0.5;

  it('doubles, and never returns a delay near zero', () => {
    // Equal jitter: half the backoff is a floor. With random()=0 the delay is
    // still half the window, which is the point -- a retry 3 ms after a
    // timeout on a congested link is another timeout.
    expect(retryDelayMs(0, DEFAULT_RETRY, () => 0)).toBe(500);
    expect(retryDelayMs(1, DEFAULT_RETRY, () => 0)).toBe(1000);
    expect(retryDelayMs(2, DEFAULT_RETRY, () => 0)).toBe(2000);
  });

  it('is deterministic given the random source', () => {
    expect(retryDelayMs(0, DEFAULT_RETRY, half)).toBe(750);
    expect(retryDelayMs(3, DEFAULT_RETRY, half)).toBe(6000);
  });

  it('caps the backoff', () => {
    expect(retryDelayMs(20, DEFAULT_RETRY, () => 1)).toBe(DEFAULT_RETRY.maxMs);
    expect(retryDelayMs(20, CHUNK_RETRY, () => 1)).toBe(CHUNK_RETRY.maxMs);
  });

  it('grows monotonically up to the cap', () => {
    let previous = 0;
    for (let a = 0; a < 5; a += 1) {
      const d = retryDelayMs(a, DEFAULT_RETRY, half);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
  });
});

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs('30', 0)).toBe(30_000);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-09-20T10:00:00Z');
    expect(retryAfterMs('Sun, 20 Sep 2026 10:00:45 GMT', now)).toBe(45_000);
  });

  it('never parks an operator for longer than two minutes', () => {
    expect(retryAfterMs('86400', 0)).toBe(RETRY_AFTER_CAP_MS);
  });

  it('is null for a missing or unparseable header', () => {
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('soon please', 0)).toBeNull();
  });
});

describe('runWithRetry', () => {
  const noSleep = async (): Promise<void> => undefined;

  it('returns the first success without waiting', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(runWithRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 up to the attempt cap and then throws', async () => {
    const fn = vi.fn(async () => { throw new TransportError(503, 'busy'); });
    await expect(runWithRetry(fn, { policy: CHUNK_RETRY, sleep: noSleep, random: () => 0 }))
      .rejects.toThrow(TransportError);
    expect(fn).toHaveBeenCalledTimes(CHUNK_RETRY.maxAttempts);
  });

  it('gives up immediately on a conflict', async () => {
    const fn = vi.fn(async () => { throw new TransportError(409, 'conflict'); });
    await expect(runWithRetry(fn, { sleep: noSleep })).rejects.toThrow(/conflict/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up immediately on a dead upload URL', async () => {
    const fn = vi.fn(async () => { throw new TransportError(404, 'gone'); });
    await expect(runWithRetry(fn, { sleep: noSleep })).rejects.toThrow(TransportError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refreshes once on a 401 and retries, without spending backoff on it', async () => {
    const refreshAuth = vi.fn(async () => undefined);
    const sleep = vi.fn(noSleep);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TransportError(401, 'expired');
      return 'ok';
    });
    await expect(runWithRetry(fn, { sleep, refreshAuth })).resolves.toBe('ok');
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not loop refreshing when a second 401 follows a fresh token', async () => {
    const refreshAuth = vi.fn(async () => undefined);
    const fn = vi.fn(async () => { throw new TransportError(401, 'still no'); });
    await expect(runWithRetry(fn, { sleep: noSleep, refreshAuth })).rejects.toThrow(TransportError);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('is fatal on 401 when there is no way to refresh', async () => {
    const fn = vi.fn(async () => { throw new TransportError(401, 'expired'); });
    await expect(runWithRetry(fn, { sleep: noSleep })).rejects.toThrow(TransportError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('obeys Retry-After in preference to its own backoff', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new TransportError(429, 'slow down', '', '7');
      return 'ok';
    };
    await runWithRetry(fn, {
      sleep: async (ms) => { waits.push(ms); },
      now: () => 0,
      random: () => 0,
    });
    expect(waits).toEqual([7000]);
  });

  it('rethrows anything that is not a TransportError untouched', async () => {
    const boom = new TypeError('a real bug');
    const fn = vi.fn(async () => { throw boom; });
    await expect(runWithRetry(fn, { sleep: noSleep })).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops between attempts when the operator cancels', async () => {
    const signal = { aborted: true };
    const fn = vi.fn(async () => 'ok');
    await expect(runWithRetry(fn, { sleep: noSleep, signal })).rejects.toThrow(/cancel/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports each wait so a screen can say how long', async () => {
    const seen: number[] = [];
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      if (calls < 3) throw new TransportError(500, 'oops');
      return 'ok';
    };
    await runWithRetry(fn, {
      sleep: noSleep, random: () => 0, policy: DEFAULT_RETRY,
      onRetry: (ctx) => { seen.push(ctx.delayMs); },
    });
    expect(seen).toEqual([500, 1000]);
  });
});
