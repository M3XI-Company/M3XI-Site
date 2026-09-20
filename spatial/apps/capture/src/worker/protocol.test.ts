/**
 * The worker boundary.
 *
 * Structured clone cannot corrupt a message in transit, so what is being
 * tested is not the platform: it is that a page which receives something it
 * does not understand says so instead of rendering a cue built out of
 * undefined. A blank headline on the live screen is indistinguishable from
 * "nothing is wrong".
 */

import { describe, expect, it } from 'vitest';
import { decodeFromWorker, isStaleResult } from './protocol.js';

describe('decodeFromWorker', () => {
  it('reads a ready message', () => {
    expect(decodeFromWorker({ type: 'ready' })).toEqual({ type: 'ready' });
  });

  it('reads a result and keeps the interval the session asked for', () => {
    const result = { cue: { id: 'steady' } };
    expect(decodeFromWorker({ type: 'result', seq: 7, result, intervalMs: 133.33, elapsedMs: 64 }))
      .toEqual({ type: 'result', seq: 7, result, intervalMs: 133.33, elapsedMs: 64 });
  });

  it('defaults only the elapsed time, never the result or the interval', () => {
    const decoded = decodeFromWorker({ type: 'result', seq: 0, result: {}, intervalMs: 100 });
    expect(decoded).toMatchObject({ elapsedMs: 0 });
    expect(decodeFromWorker({ type: 'result', seq: 0, intervalMs: 100 })).toBeNull();
    expect(decodeFromWorker({ type: 'result', seq: 0, result: {} })).toBeNull();
    expect(decodeFromWorker({ type: 'result', result: {}, intervalMs: 100 })).toBeNull();
  });

  it('refuses a result whose payload is null rather than treating it as a frame', () => {
    expect(decodeFromWorker({ type: 'result', seq: 1, result: null, intervalMs: 100 })).toBeNull();
  });

  it('reads a coverage message only when both halves are there', () => {
    expect(decodeFromWorker({ type: 'coverage', input: {}, report: {} }))
      .toEqual({ type: 'coverage', input: {}, report: {} });
    expect(decodeFromWorker({ type: 'coverage', input: {} })).toBeNull();
  });

  it('gives an error message words even when the worker sent none', () => {
    expect(decodeFromWorker({ type: 'error', fatal: true }))
      .toEqual({ type: 'error', message: 'The analyser failed without saying why.', fatal: true });
  });

  it('treats a missing fatal flag as non-fatal rather than as a stop', () => {
    expect(decodeFromWorker({ type: 'error', message: 'odd' }))
      .toEqual({ type: 'error', message: 'odd', fatal: false });
  });

  it('returns null for anything it does not recognise', () => {
    expect(decodeFromWorker(null)).toBeNull();
    expect(decodeFromWorker('result')).toBeNull();
    expect(decodeFromWorker({})).toBeNull();
    expect(decodeFromWorker({ type: 'from-the-future' })).toBeNull();
  });
});

describe('isStaleResult', () => {
  it('rejects a reply older than one already applied', () => {
    expect(isStaleResult(4, 5)).toBe(true);
    expect(isStaleResult(5, 5)).toBe(true);
    expect(isStaleResult(6, 5)).toBe(false);
  });
});
