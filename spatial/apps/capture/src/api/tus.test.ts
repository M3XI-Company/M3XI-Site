/**
 * The TUS arithmetic, which is the part that silently corrupts a 3 GB object
 * when it is wrong.
 *
 * Everything here runs in Node with no DOM, which is why the arithmetic was
 * separated from the fetching in the first place. The cases chosen are the
 * ones where an off-by-one produces a file of the RIGHT LENGTH and the wrong
 * contents — those are the failures that survive every downstream check until
 * a person watches the video.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES, UPLOAD_URL_TTL_MS, assertServerOffset, base64Utf8, chunkRange,
  encodeUploadMetadata, parseUploadOffset, planResume, recordKey, remainingChunks,
  resolveUploadUrl, type UploadRecord,
} from './tus.js';
import { TransportError } from './retry.js';

const MB = 1024 * 1024;

describe('chunkRange', () => {
  it('sends exactly the Supabase chunk size while there is more than that left', () => {
    const r = chunkRange(0, 20 * MB);
    expect(r).toEqual({ start: 0, end: 6 * MB, length: 6 * MB, final: false });
    expect(r!.length).toBe(CHUNK_BYTES);
  });

  it('sends the remainder as the final chunk', () => {
    const total = 20 * MB;
    const r = chunkRange(18 * MB, total);
    expect(r).toEqual({ start: 18 * MB, end: total, length: 2 * MB, final: true });
  });

  it('marks a full-sized last chunk final when the file is an exact multiple', () => {
    // The case a "length < chunkBytes means final" implementation gets wrong,
    // and then sends one more PATCH of nothing.
    const total = 12 * MB;
    const r = chunkRange(6 * MB, total);
    expect(r).toEqual({ start: 6 * MB, end: total, length: 6 * MB, final: true });
  });

  it('sends a file smaller than one chunk as a single final chunk', () => {
    expect(chunkRange(0, 1234)).toEqual({ start: 0, end: 1234, length: 1234, final: true });
  });

  it('returns null when the server already has everything', () => {
    expect(chunkRange(9 * MB, 9 * MB)).toBeNull();
  });

  it('refuses an offset past the end rather than sending a negative length', () => {
    expect(() => chunkRange(10, 9)).toThrow(RangeError);
  });

  it('refuses non-finite sizes', () => {
    expect(() => chunkRange(Number.NaN, 10)).toThrow(RangeError);
    expect(() => chunkRange(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('walks a whole file in chunks that tile it exactly once', () => {
    const total = 20 * MB + 7;
    let offset = 0;
    let seen = 0;
    let chunks = 0;
    for (;;) {
      const r = chunkRange(offset, total);
      if (r === null) break;
      expect(r.start).toBe(offset);
      seen += r.length;
      chunks += 1;
      offset = r.end;
      if (r.final) { expect(offset).toBe(total); }
    }
    expect(seen).toBe(total);
    expect(chunks).toBe(4);
  });
});

describe('remainingChunks', () => {
  it('counts the partial tail as a chunk', () => {
    expect(remainingChunks(0, 20 * MB)).toBe(4);
    expect(remainingChunks(0, 12 * MB)).toBe(2);
    expect(remainingChunks(6 * MB, 12 * MB)).toBe(1);
    expect(remainingChunks(12 * MB, 12 * MB)).toBe(0);
  });

  it('never reports a negative count for an over-run offset', () => {
    expect(remainingChunks(13 * MB, 12 * MB)).toBe(0);
  });
});

describe('assertServerOffset', () => {
  it('accepts an offset that matches', () => {
    expect(assertServerOffset(6 * MB, 0, 12 * MB)).toBe(6 * MB);
  });

  it('accepts an offset AHEAD of the client: a PATCH landed and its reply did not', () => {
    expect(assertServerOffset(12 * MB, 6 * MB, 20 * MB)).toBe(12 * MB);
  });

  it('refuses an offset that went backwards', () => {
    expect(() => assertServerOffset(1 * MB, 6 * MB, 12 * MB)).toThrow(TransportError);
    expect(() => assertServerOffset(1 * MB, 6 * MB, 12 * MB)).toThrow(/backwards/i);
  });

  it('refuses an offset past the end of the file', () => {
    expect(() => assertServerOffset(13 * MB, 0, 12 * MB)).toThrow(/does not belong/i);
  });

  it('refuses a non-integer offset rather than rounding it', () => {
    expect(() => assertServerOffset(1.5, 0, 10)).toThrow(TransportError);
  });
});

describe('parseUploadOffset', () => {
  it('reads a plain integer', () => {
    expect(parseUploadOffset('6291456')).toBe(6291456);
    expect(parseUploadOffset('  42 ')).toBe(42);
    expect(parseUploadOffset('0')).toBe(0);
  });

  it('returns null rather than NaN for anything else', () => {
    expect(parseUploadOffset(null)).toBeNull();
    expect(parseUploadOffset('')).toBeNull();
    expect(parseUploadOffset('6.5')).toBeNull();
    expect(parseUploadOffset('-1')).toBeNull();
    expect(parseUploadOffset('12abc')).toBeNull();
  });
});

describe('encodeUploadMetadata', () => {
  it('writes key SPACE base64(value), comma separated', () => {
    const encoded = encodeUploadMetadata({ bucketName: 'wv-captures', objectName: 'a/b.webm' });
    expect(encoded).toBe(`bucketName ${btoa('wv-captures')},objectName ${btoa('a/b.webm')}`);
  });

  it('writes a bare key for an empty value, as TUS requires', () => {
    expect(encodeUploadMetadata({ flag: '' })).toBe('flag');
  });

  it('survives a value btoa alone would throw on', () => {
    // A room called "Salón" in a property label is not exotic. btoa('Salón')
    // throws InvalidCharacterError; this must not.
    const encoded = encodeUploadMetadata({ label: 'Salón' });
    const b64 = encoded.split(' ')[1]!;
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
      .toBe('Salón');
  });

  it('refuses a key that would break the header grammar', () => {
    expect(() => encodeUploadMetadata({ 'has space': 'x' })).toThrow(RangeError);
    expect(() => encodeUploadMetadata({ 'has,comma': 'x' })).toThrow(RangeError);
  });
});

describe('base64Utf8', () => {
  it('round-trips a long non-ASCII string without hitting the argument limit', () => {
    const long = 'é'.repeat(50_000);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(base64Utf8(long)), (c) => c.charCodeAt(0)));
    expect(decoded).toBe(long);
  });
});

describe('resolveUploadUrl', () => {
  const endpoint = 'https://project.supabase.co/storage/v1/upload/resumable';

  it('passes an absolute Location through', () => {
    expect(resolveUploadUrl(`${endpoint}/abc123`, endpoint)).toBe(`${endpoint}/abc123`);
  });

  it('resolves a relative Location against the ENDPOINT, not the page', () => {
    expect(resolveUploadUrl('/storage/v1/upload/resumable/abc', endpoint))
      .toBe('https://project.supabase.co/storage/v1/upload/resumable/abc');
  });

  it('throws a legible error when the browser could not read the header', () => {
    expect(() => resolveUploadUrl(null, endpoint)).toThrow(/CORS/);
    expect(() => resolveUploadUrl('   ', endpoint)).toThrow(TransportError);
  });
});

describe('planResume', () => {
  const base: UploadRecord = {
    uploadUrl: 'https://project.supabase.co/storage/v1/upload/resumable/abc',
    objectPath: '11111111-1111-4111-8111-111111111111/walkthrough-20260920T101500Z.webm',
    bucket: 'wv-captures',
    bytes: 2_000_000_000,
    offset: 800_000_000,
    createdAt: 1_000_000,
    worldId: '11111111-1111-4111-8111-111111111111',
  };
  const expected = { bytes: base.bytes, objectPath: base.objectPath, worldId: base.worldId };

  it('resumes a fresh record', () => {
    expect(planResume(base, expected, base.createdAt + 60_000).kind).toBe('resume');
  });

  it('is fresh when nothing was remembered', () => {
    expect(planResume(null, expected, 0).kind).toBe('fresh');
  });

  it('expires a record before the 24 hour boundary, not at it', () => {
    const justInside = base.createdAt + UPLOAD_URL_TTL_MS - 20 * 60 * 1000;
    expect(planResume(base, expected, justInside).kind).toBe('resume');
    const insideTheMargin = base.createdAt + UPLOAD_URL_TTL_MS - 10 * 60 * 1000;
    expect(planResume(base, expected, insideTheMargin).kind).toBe('expired');
  });

  it('refuses to append this walk to a previous one of a different size', () => {
    const plan = planResume(base, { ...expected, bytes: expected.bytes + 1 }, base.createdAt + 1000);
    expect(plan.kind).toBe('mismatch');
  });

  it('refuses a record belonging to another world', () => {
    const plan = planResume(base, { ...expected, worldId: '22222222-2222-4222-8222-222222222222' },
      base.createdAt + 1000);
    expect(plan.kind).toBe('mismatch');
  });
});

describe('recordKey', () => {
  it('keys on the object path, so one object has one upload', () => {
    expect(recordKey({ objectPath: 'world/a.webm' })).toBe('world/a.webm');
  });
});
