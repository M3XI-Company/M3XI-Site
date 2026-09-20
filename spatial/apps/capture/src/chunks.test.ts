/**
 * Reading a byte range out of a recording that is never assembled.
 *
 * The failure being guarded is specific and silent: a range that reads one
 * byte too few across a chunk boundary produces an object of exactly the right
 * length made of the wrong bytes. It uploads cleanly, registers cleanly, and
 * is discovered by a human watching the video. So the tests below reconstruct
 * ranges byte-for-byte and compare them against the whole, rather than
 * checking that the arithmetic looks plausible.
 */

import { describe, expect, it } from 'vitest';
import { buildLedger, estimateBytes, recordedBytes, sliceChunks, type ChunkMeta } from './chunks.js';

const pieces: readonly ChunkMeta[] = [
  { index: 0, bytes: 100 },
  { index: 1, bytes: 50 },
  { index: 2, bytes: 200 },
];

describe('buildLedger', () => {
  it('sums the pieces and puts them in order', () => {
    const ledger = buildLedger([pieces[2]!, pieces[0]!, pieces[1]!]);
    expect(ledger.totalBytes).toBe(350);
    expect(ledger.chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('refuses a recording with a hole in it rather than renumbering', () => {
    expect(() => buildLedger([{ index: 0, bytes: 10 }, { index: 2, bytes: 10 }]))
      .toThrow(/missing piece 1/);
  });

  it('refuses an impossible size', () => {
    expect(() => buildLedger([{ index: 0, bytes: Number.NaN }])).toThrow(/impossible/);
  });

  it('accepts an empty recording, which is a state and not a bug', () => {
    expect(buildLedger([])).toEqual({ chunks: [], totalBytes: 0 });
  });
});

describe('sliceChunks', () => {
  const ledger = buildLedger(pieces);

  it('reads a range inside one piece', () => {
    expect(sliceChunks(ledger, 10, 20)).toEqual([{ index: 0, from: 10, to: 20 }]);
  });

  it('reads a range spanning three pieces, with no gap and no overlap', () => {
    expect(sliceChunks(ledger, 90, 200)).toEqual([
      { index: 0, from: 90, to: 100 },
      { index: 1, from: 0, to: 50 },
      { index: 2, from: 0, to: 50 },
    ]);
  });

  it('reads exactly on a boundary without emitting an empty read', () => {
    expect(sliceChunks(ledger, 100, 150)).toEqual([{ index: 1, from: 0, to: 50 }]);
    expect(sliceChunks(ledger, 0, 100)).toEqual([{ index: 0, from: 0, to: 100 }]);
  });

  it('tiles the whole recording exactly once when walked in 6 MB-style steps', () => {
    // The property that matters: whatever step size the uploader uses, the
    // concatenation of the slices is the recording, once, in order.
    for (const step of [1, 7, 50, 100, 137, 350, 1000]) {
      const seen: number[] = [];
      for (let offset = 0; offset < ledger.totalBytes; offset += step) {
        const end = Math.min(ledger.totalBytes, offset + step);
        for (const s of sliceChunks(ledger, offset, end)) {
          const base = ledger.chunks.slice(0, s.index).reduce((sum, c) => sum + c.bytes, 0);
          for (let b = s.from; b < s.to; b += 1) seen.push(base + b);
        }
      }
      expect(seen).toEqual(Array.from({ length: ledger.totalBytes }, (_, i) => i));
    }
  });

  it('skips a zero-length piece rather than making a pointless read', () => {
    const withEmpty = buildLedger([
      { index: 0, bytes: 10 }, { index: 1, bytes: 0 }, { index: 2, bytes: 10 },
    ]);
    expect(sliceChunks(withEmpty, 0, 20)).toEqual([
      { index: 0, from: 0, to: 10 },
      { index: 2, from: 0, to: 10 },
    ]);
  });

  it('returns nothing for an empty range', () => {
    expect(sliceChunks(ledger, 40, 40)).toEqual([]);
  });

  it('refuses a range past the end of the recording', () => {
    expect(() => sliceChunks(ledger, 300, 400)).toThrow(/351|350/);
  });

  it('refuses a range that runs backwards', () => {
    expect(() => sliceChunks(ledger, 40, 10)).toThrow(RangeError);
  });
});

describe('recordedBytes', () => {
  it('totals what is on disk so far', () => {
    expect(recordedBytes(pieces)).toBe(350);
    expect(recordedBytes([])).toBe(0);
  });
});

describe('estimateBytes', () => {
  it('converts a bitrate and a duration into bytes', () => {
    // 5 minutes at 12 Mbps is about 450 MB, which is the order the storage
    // warning before recording is written against.
    expect(estimateBytes(300, 12_000_000)).toBe(450_000_000);
  });

  it('never returns a negative estimate', () => {
    expect(estimateBytes(-10, 12_000_000)).toBe(0);
  });
});
