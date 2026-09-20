/**
 * The upload loop: create or resume, then chunk until the object is whole.
 *
 * Separate from `tus.ts` because the protocol and the policy are different
 * things and only one of them is Supabase's. `tus.ts` knows what a PATCH looks
 * like; this file knows what to do when one fails at 1.4 GB of 2.9 on a
 * doorstep, which is the part that decides whether the operator can leave.
 *
 * THE ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER.
 *
 *   1. Ask the persistence layer what it remembers. A record from a tab that
 *      was closed at 40% is worth more than anything else here.
 *   2. HEAD the remembered URL before sending a byte. The persisted offset is
 *      what this client BELIEVED; the server's is what is true, and the last
 *      PATCH before a crash may well have landed. Re-sending a chunk the
 *      server already has is a 409, not an overwrite, so skipping the HEAD
 *      does not save a round trip — it costs the whole resume.
 *   3. PATCH forward, persisting the offset after EVERY chunk. Persisting
 *      every ten chunks would be 60 MB of re-upload after a crash, which on a
 *      one-bar link is minutes. An IndexedDB write is under a millisecond.
 *   4. Never trust the loop's own counter over the server's answer. The offset
 *      after each PATCH is the server's, checked by `assertServerOffset`.
 *
 * WHAT IT DOES NOT DO: parallel chunks. Supabase documents that two clients on
 * one upload URL get 409, and TUS has no ordering for concurrent PATCHes on a
 * single upload. The speed-up would have to come from multiple upload URLs and
 * a server-side join, which Storage does not offer. A comment is cheaper than
 * a race that corrupts one capture in fifty.
 */

import {
  CHUNK_BYTES, createUpload, headOffset, patchChunk, planResume, remainingChunks,
  type UploadCredentials, type UploadPersistence, type UploadProgress, type UploadRecord,
  type UploadSource, type UploadTarget, type UploaderDeps,
} from './tus.js';
import { CHUNK_RETRY, DEFAULT_RETRY, TransportError, runWithRetry, type AttemptContext } from './retry.js';

export interface UploadOptions {
  readonly target: UploadTarget;
  readonly source: UploadSource;
  readonly credentials: UploadCredentials;
  readonly deps: UploaderDeps;
  readonly onProgress?: (p: UploadProgress) => void;
  /** Surfaced on screen so a stalled upload does not look like a hung app. */
  readonly onRetry?: (ctx: AttemptContext) => void;
  readonly refreshAuth?: () => Promise<void>;
  readonly signal?: { readonly aborted: boolean };
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Attempts the WHOLE loop will make at re-establishing an upload that died
   * for a reason a chunk retry could not fix — an expired URL, a 404. Two:
   * once with the remembered URL, once with a new one. A third would be a
   * third full restart of a multi-gigabyte upload, which is not a retry, it is
   * a different afternoon.
   */
  readonly maxRestarts?: number;
}

export interface UploadOutcome {
  readonly objectPath: string;
  readonly bytes: number;
  /** True when the object was already complete on the server before this run. */
  readonly alreadyComplete: boolean;
  readonly restarts: number;
}

/**
 * Upload, resuming whatever can be resumed.
 *
 * Returns when the server holds every byte. Throws a `TransportError` the
 * screen can print otherwise — never a partial success, because "uploaded"
 * with a hole in it is the one outcome that costs a second appointment
 * silently.
 */
export async function uploadRecording(options: UploadOptions): Promise<UploadOutcome> {
  const { target, source, credentials, deps } = options;
  const now = deps.now ?? Date.now;
  const maxRestarts = options.maxRestarts ?? 2;
  const retryShared = {
    random: options.random,
    sleep: options.sleep,
    onRetry: options.onRetry,
    refreshAuth: options.refreshAuth,
    signal: options.signal,
    now,
  } as const;

  let restarts = 0;
  for (;;) {
    const remembered = await deps.persistence.load(target.objectPath);
    const plan = planResume(remembered, {
      bytes: source.bytes, objectPath: target.objectPath, worldId: target.worldId,
    }, now());

    let record: UploadRecord;
    let offset: number;

    if (plan.kind === 'resume') {
      record = plan.record;
      try {
        offset = await runWithRetry(() => headOffset(record, credentials, deps),
          { ...retryShared, policy: DEFAULT_RETRY });
      } catch (err) {
        // A remembered URL that will not answer is not worth a second thought:
        // creating a new upload costs one round trip and re-sends bytes, while
        // arguing with a dead URL costs the whole capture.
        if (!(err instanceof TransportError)) throw err;
        if (err.disposition !== 'restart_upload' && err.disposition !== 'conflict') throw err;
        await deps.persistence.clear(target.objectPath);
        if (restarts >= maxRestarts) throw err;
        restarts += 1;
        continue;
      }
    } else {
      // 'expired' and 'mismatch' both mean the remembered record is not usable,
      // and both are worth forgetting before a new upload writes over the key.
      if (plan.kind !== 'fresh') await deps.persistence.clear(target.objectPath);
      record = await runWithRetry(() => createUpload(target, source, credentials, deps),
        { ...retryShared, policy: DEFAULT_RETRY });
      offset = 0;
    }

    if (offset === source.bytes) {
      // The whole object is already on the server: a previous run finished the
      // bytes and died before registering. Not an error, and not a reason to
      // send 3 GB again.
      await deps.persistence.clear(target.objectPath);
      options.onProgress?.({ offset, bytes: source.bytes, chunksLeft: 0 });
      return { objectPath: target.objectPath, bytes: source.bytes, alreadyComplete: true, restarts };
    }

    options.onProgress?.({
      offset, bytes: source.bytes, chunksLeft: remainingChunks(offset, source.bytes, CHUNK_BYTES),
    });

    let broken: TransportError | null = null;
    while (offset < source.bytes) {
      if (options.signal?.aborted) throw new TransportError(null, 'Upload cancelled.');
      const at = offset;
      try {
        offset = await runWithRetry(() => patchChunk(record, at, source, credentials, deps),
          { ...retryShared, policy: CHUNK_RETRY });
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        if (err.disposition === 'restart_upload') { broken = err; break; }
        throw err;
      }
      await deps.persistence.save({ ...record, offset });
      options.onProgress?.({
        offset, bytes: source.bytes, chunksLeft: remainingChunks(offset, source.bytes, CHUNK_BYTES),
      });
    }

    if (broken !== null) {
      await deps.persistence.clear(target.objectPath);
      if (restarts >= maxRestarts) throw broken;
      restarts += 1;
      continue;
    }

    await deps.persistence.clear(target.objectPath);
    return { objectPath: target.objectPath, bytes: source.bytes, alreadyComplete: false, restarts };
  }
}
