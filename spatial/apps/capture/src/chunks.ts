/**
 * The recording, as a list of pieces, and how to read a byte range out of it.
 *
 * WHY THE RECORDING IS A LIST AND NOT A FILE. MediaRecorder with a timeslice
 * emits a Blob every few seconds, and each one is written to IndexedDB as it
 * arrives. That is the whole reason a locked phone or a switched app does not
 * lose the walkthrough: the bytes are already durable before anything goes
 * wrong. The alternative — accumulating in memory and calling `stop()` at the
 * end — loses a 2 GB recording to one background kill, which on iOS is not an
 * edge case, it is Tuesday.
 *
 * WHY THE PIECES ARE NEVER GLUED TOGETHER. The obvious next step is
 * `new Blob(chunks)` to get something to upload. It is the wrong step: a 3 GB
 * recording would then exist twice on a phone that has just spent five minutes
 * filling its storage, and on iOS a Blob assembled from IndexedDB reads is not
 * guaranteed to stay backed by disk. So the uploader asks for a byte RANGE and
 * this file works out which pieces that range spans. Nothing is ever whole.
 *
 * The arithmetic below is the part that must be right. A range that reads one
 * byte too few from a chunk boundary produces an object of exactly the correct
 * length made of subtly wrong bytes, which uploads cleanly, registers cleanly,
 * and fails in the decoder thirty-five GPU-minutes later.
 */

export interface ChunkMeta {
  /** 0-based, in the order MediaRecorder produced them. */
  readonly index: number;
  readonly bytes: number;
}

export interface ChunkLedger {
  readonly chunks: readonly ChunkMeta[];
  readonly totalBytes: number;
}

/**
 * Build the ledger, checking the sequence is intact.
 *
 * A gap in the indices means a chunk write failed and the recording has a hole
 * in it. That is not something to patch over by renumbering: the resulting
 * video would be missing seconds of a room with nothing to say so, and the
 * capture would pass every check this app makes. It throws.
 */
export function buildLedger(chunks: readonly ChunkMeta[]): ChunkLedger {
  const sorted = chunks.slice().sort((a, b) => a.index - b.index);
  let total = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const c = sorted[i]!;
    if (c.index !== i) {
      throw new Error(
        `The recording is missing piece ${i}. It cannot be uploaded, because the video would be `
        + 'short by that much with nothing to show for it.');
    }
    if (!Number.isFinite(c.bytes) || c.bytes < 0) {
      throw new Error(`Piece ${i} of the recording has an impossible size.`);
    }
    total += c.bytes;
  }
  return { chunks: sorted, totalBytes: total };
}

export interface ChunkSlice {
  readonly index: number;
  /** Offset within that chunk. */
  readonly from: number;
  /** Exclusive, within that chunk. */
  readonly to: number;
}

/**
 * Which pieces, and which part of each, make up `[start, end)`.
 *
 * Zero-length chunks are skipped rather than emitted: MediaRecorder does
 * occasionally produce one when a timeslice elapses with nothing decoded, and
 * a zero-length read is a wasted IndexedDB round trip on a phone that is
 * already busy.
 *
 * Returns an empty list for an empty range, which is legal — `chunkRange`
 * returns null rather than an empty range, so this only happens if a caller
 * asks for one, and answering "nothing" is correct.
 */
export function sliceChunks(ledger: ChunkLedger, start: number, end: number): readonly ChunkSlice[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new RangeError('A byte range must be finite.');
  }
  if (start < 0 || end < start) throw new RangeError('A byte range must not run backwards.');
  if (end > ledger.totalBytes) {
    throw new RangeError(
      `Asked for byte ${end} of a ${ledger.totalBytes} byte recording.`);
  }
  const out: ChunkSlice[] = [];
  let cursor = 0;
  for (const chunk of ledger.chunks) {
    const chunkStart = cursor;
    const chunkEnd = cursor + chunk.bytes;
    cursor = chunkEnd;
    if (chunkEnd <= start) continue;
    if (chunkStart >= end) break;
    const from = Math.max(0, start - chunkStart);
    const to = Math.min(chunk.bytes, end - chunkStart);
    if (to > from) out.push({ index: chunk.index, from, to });
  }
  return out;
}

/**
 * Bytes recorded so far, for the screen.
 *
 * Kept separate from `totalBytes` because during recording the ledger grows
 * and the uploader has not been given anything yet, and conflating "how much
 * have I recorded" with "how much am I uploading" is how a progress bar ends
 * up at 140%.
 */
export function recordedBytes(chunks: readonly ChunkMeta[]): number {
  let total = 0;
  for (const c of chunks) total += Math.max(0, c.bytes);
  return total;
}

/**
 * A rough duration from a byte count, for the warning before recording starts.
 *
 * Explicitly an ESTIMATE and labelled as one wherever it is shown. The real
 * duration comes from the `<video>` element's own clock, which is the number
 * sent to `register_capture`. This exists only to answer "will this fit",
 * where being 20% out does not matter and having no answer does: a phone with
 * 900 MB free cannot record a five-minute 4K walk, and the operator needs to
 * know that before they start rather than at minute four.
 */
export function estimateBytes(durationS: number, bitsPerSecond: number): number {
  return Math.max(0, Math.round((durationS * bitsPerSecond) / 8));
}
