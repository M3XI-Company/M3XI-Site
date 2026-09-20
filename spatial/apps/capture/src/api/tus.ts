/**
 * TUS 1.0.0, by hand, against Supabase Storage.
 *
 * WHY BY HAND. `tus-js-client` is the obvious answer and it is not available:
 * this workspace's only runtime dependencies are three.js and Spark, and the
 * capture app deliberately imports neither so that it builds on a server with
 * no `spatial/node_modules` at all (see the root vite.config.js comment on
 * `worldCapture`). The protocol that matters here is three verbs and four
 * headers, which is a smaller thing to own than a dependency.
 *
 * WHY RESUMABLE AT ALL. A 5-minute 4K walkthrough is 1.7-3.8 GB — the figure
 * the wv-captures bucket's 5 GiB limit was sized against — and it is uploaded
 * from a stranger's hallway, on whatever signal the property has, from a phone
 * whose owner will lock it and put it in a pocket. A single PUT that restarts
 * from zero on the first dropped connection never finishes. So the offset is
 * persisted and the upload URL with it, and a closed tab resumes rather than
 * re-sending three gigabytes.
 *
 * THE 6 MB CHUNK, AND WHAT WAS ACTUALLY CONFIRMED.
 * Supabase's resumable-upload implementation requires every chunk except the
 * final one to be exactly 6 MiB. I checked this rather than trusting it:
 *
 *   - Supabase's own live documentation (guides/storage/uploads/resumable-
 *     uploads, read 20 Sep 2026) sets `chunkSize: 6 * 1024 * 1024` in every
 *     one of its four client examples and annotates it
 *     "it must be set to 6MB (for now) do not change it". The same page states
 *     the two other facts this file depends on: an upload URL is valid for up
 *     to 24 hours, and two clients on one upload URL get 409.
 *   - I could NOT read the figure off a live response. `OPTIONS
 *     https://<ref>.supabase.co/storage/v1/upload/resumable` and the same
 *     path on the direct `<ref>.storage.supabase.co` host both return a bare
 *     gateway 200 with `Allow: GET, HEAD, POST, OPTIONS` and no `Tus-*`
 *     headers at all, and an unauthenticated POST is refused by the gateway
 *     ("Invalid Compact JWS") before the TUS server sees it. So the
 *     capability headers are not observable without a member's credentials,
 *     which this build does not have. That is the honest limit of the check.
 *
 * Because the figure is a server constraint that cannot be probed from here,
 * `CHUNK_BYTES` is exported and the uploader reads it once, so the day it
 * changes there is one line to change and `chunkRange`'s tests say exactly
 * what the arithmetic must then do.
 *
 * WHAT THIS FILE WILL NOT DO. It will not silently accept an `Upload-Offset`
 * that moved backwards or past the end of the file. That reading means the
 * client and the server disagree about what has been stored, and continuing
 * from the client's own idea of the offset writes a corrupt 3 GB object that
 * looks complete. `assertServerOffset` throws instead, and the screen says so.
 */

import { TransportError } from './retry.js';

/** TUS version this client speaks. The only one Supabase implements. */
export const TUS_VERSION = '1.0.0';

/**
 * Bytes per PATCH, for every chunk except the last. See the header for what
 * was and was not confirmed about this number.
 */
export const CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * How long Supabase keeps an upload URL. Documented as "up to 24 hours".
 *
 * Used to decide whether a persisted upload is worth a HEAD or is already
 * dead. A margin is subtracted rather than trusting the boundary: an upload
 * resumed at 23 h 59 m would spend its first PATCH discovering the URL expired
 * mid-flight, which is a worse experience than being told to start again.
 */
export const UPLOAD_URL_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_URL_MARGIN_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// The arithmetic. Pure, and where the bugs would be.
// ---------------------------------------------------------------------------

export interface ChunkRange {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly length: number;
  /** True when this chunk completes the object. */
  readonly final: boolean;
}

/**
 * The next chunk to send from `offset`.
 *
 * Returns null when there is nothing left, which is a real state and not an
 * error: a resumed upload whose HEAD reports the full length has already been
 * stored and needs registering, not re-sending.
 *
 * Note what `final` is NOT: it is not "length < chunkBytes". A file whose size
 * is an exact multiple of 6 MiB ends on a full-sized chunk, and a client that
 * infers finality from a short chunk would send one more empty PATCH and
 * confuse itself about whether the object is complete.
 */
export function chunkRange(offset: number, total: number, chunkBytes = CHUNK_BYTES): ChunkRange | null {
  if (!Number.isFinite(offset) || !Number.isFinite(total)) {
    throw new RangeError('chunkRange needs finite numbers.');
  }
  if (offset < 0 || total < 0 || chunkBytes <= 0) {
    throw new RangeError('chunkRange needs non-negative sizes.');
  }
  if (offset > total) {
    throw new RangeError(`Offset ${offset} is past the end of a ${total} byte upload.`);
  }
  if (offset === total) return null;
  const length = Math.min(chunkBytes, total - offset);
  const end = offset + length;
  return { start: offset, end, length, final: end === total };
}

/** Chunks still to send. For "3 of 412" on the screen, and for nothing else. */
export function remainingChunks(offset: number, total: number, chunkBytes = CHUNK_BYTES): number {
  if (chunkBytes <= 0) throw new RangeError('chunkBytes must be positive.');
  const left = Math.max(0, total - offset);
  return Math.ceil(left / chunkBytes);
}

/**
 * Check what the server says its offset is against what this client believes.
 *
 * Three readings, and only one of them is safe to continue from:
 *
 *   equal or ahead of `sent`, within the file   fine. Ahead happens when a
 *                          PATCH succeeded and its response was lost: the
 *                          bytes are stored, the acknowledgement was not.
 *   behind `previous`      the server has forgotten bytes it once had. Nothing
 *                          the client can do makes the object correct.
 *   past `total`           the server holds more bytes than the file has. The
 *                          upload URL is not this file's.
 *
 * Throwing on the last two is the point of the function. The alternative —
 * carrying on from the client's own counter — produces an object of the right
 * length made of the wrong bytes, which passes every check until a human
 * watches the walkthrough.
 */
export function assertServerOffset(
  reported: number, previous: number, total: number,
): number {
  if (!Number.isInteger(reported) || reported < 0) {
    throw new TransportError(null,
      'The server reported an upload position that is not a number. The upload cannot be trusted '
      + 'to continue; start it again.');
  }
  if (reported > total) {
    throw new TransportError(null,
      `The server is holding ${reported} bytes for a ${total} byte recording. That upload does not `
      + 'belong to this file. Start it again.');
  }
  if (reported < previous) {
    throw new TransportError(null,
      `The server has gone backwards, from ${previous} bytes to ${reported}. Continuing would `
      + 'store a file made of the wrong bytes. Start it again.');
  }
  return reported;
}

/**
 * `Upload-Metadata` as TUS defines it: `key base64(value)`, comma separated.
 *
 * `btoa` alone is wrong for anything outside Latin-1 and a property label can
 * easily contain one — an address with an accent, a room called "Salón". btoa
 * on such a string throws `InvalidCharacterError` mid-upload. So the value is
 * UTF-8 encoded first and the bytes are what get base64'd, which is what the
 * spec means by "the value MUST be Base64 encoded" and what the server decodes
 * on the other side.
 */
export function encodeUploadMetadata(fields: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[\x21-\x7e]+$/.test(key) || key.includes(',') || key.includes(' ')) {
      throw new RangeError(`Upload-Metadata key ${JSON.stringify(key)} is not a legal TUS key.`);
    }
    // A key with an empty value is legal TUS and is spelled as the bare key.
    parts.push(value.length === 0 ? key : `${key} ${base64Utf8(value)}`);
  }
  return parts.join(',');
}

export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  // In 8 KiB slices: String.fromCharCode spread over a few hundred thousand
  // elements overflows the argument limit on some engines, and the failure
  // mode is a RangeError halfway through an upload rather than at the top.
  const STEP = 8192;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + STEP)));
  }
  return btoa(binary);
}

/** `Upload-Offset` as a number, or null when the header is missing or junk. */
export function parseUploadOffset(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Turn the `Location` of a created upload into an absolute URL.
 *
 * TUS allows Location to be relative and Supabase has returned both forms over
 * its lifetime. Resolving against the creation endpoint rather than against
 * the page is deliberate: the page is m3xi.com and the endpoint is the storage
 * host, so resolving against the page would produce a URL on the wrong origin
 * that 404s on the first PATCH.
 *
 * Throws rather than returning null when there is no Location, because a
 * created upload with no URL is not a state to carry on from — and on a
 * browser it usually means the CORS `Access-Control-Expose-Headers` did not
 * include `Location`, which is worth saying out loud rather than surfacing as
 * a mysterious failure 6 MB later.
 */
export function resolveUploadUrl(location: string | null, endpoint: string): string {
  if (location === null || location.trim().length === 0) {
    throw new TransportError(null,
      'The storage service created the upload but the browser could not read its address. This is '
      + 'usually a CORS configuration that does not expose the Location header.');
  }
  return new URL(location.trim(), endpoint).toString();
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/** What is persisted so a closed tab resumes rather than restarting 3 GB. */
export interface UploadRecord {
  readonly uploadUrl: string;
  readonly objectPath: string;
  readonly bucket: string;
  readonly bytes: number;
  /** Bytes the server had acknowledged when this record was last written. */
  readonly offset: number;
  /** When the upload URL was created, in epoch ms. */
  readonly createdAt: number;
  readonly worldId: string;
}

export type ResumePlan =
  | { readonly kind: 'resume'; readonly record: UploadRecord }
  | { readonly kind: 'expired'; readonly record: UploadRecord }
  | { readonly kind: 'mismatch'; readonly record: UploadRecord; readonly why: string }
  | { readonly kind: 'fresh' };

/**
 * Decide what a persisted record is worth, before touching the network.
 *
 * `mismatch` exists because the record is keyed on the object path and the
 * path is derived from the world and the capture: a record whose byte count
 * does not match the recording in hand is a record from a different walk that
 * happened to be left behind, and resuming it would append this property's
 * footage to the previous one's object.
 */
export function planResume(
  record: UploadRecord | null, expected: { bytes: number; objectPath: string; worldId: string },
  nowMs: number,
): ResumePlan {
  if (record === null) return { kind: 'fresh' };
  if (record.objectPath !== expected.objectPath || record.worldId !== expected.worldId) {
    return { kind: 'mismatch', record, why: 'it belongs to a different capture' };
  }
  if (record.bytes !== expected.bytes) {
    return { kind: 'mismatch', record, why: 'the recording is a different size than the one it started' };
  }
  if (nowMs - record.createdAt >= UPLOAD_URL_TTL_MS - UPLOAD_URL_MARGIN_MS) {
    return { kind: 'expired', record };
  }
  return { kind: 'resume', record };
}

// ---------------------------------------------------------------------------
// The uploader
// ---------------------------------------------------------------------------

/**
 * The bytes to send, as an interface rather than a Blob.
 *
 * The recording lives in IndexedDB as a list of MediaRecorder chunks, and
 * gluing them into one 3 GB Blob to satisfy a type would double the storage
 * the phone needs at the exact moment it has least. So the uploader asks for a
 * byte range and the store decides how to produce it — and a test can hand it
 * an array.
 */
export interface UploadSource {
  readonly bytes: number;
  slice(start: number, end: number): Promise<Uint8Array | Blob>;
}

export interface UploadTarget {
  /** `${SUPABASE_URL}/storage/v1/upload/resumable`. */
  readonly endpoint: string;
  readonly bucket: string;
  /** `${worldId}/<name>`. The bucket policy is keyed on that first segment. */
  readonly objectPath: string;
  readonly contentType: string;
  readonly worldId: string;
}

export interface UploadCredentials {
  /** Fresh on every call: a 3 GB upload outlives an access token. */
  accessToken(): Promise<string>;
  readonly anonKey: string;
}

export interface UploadPersistence {
  load(key: string): Promise<UploadRecord | null>;
  save(record: UploadRecord): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface UploadProgress {
  readonly offset: number;
  readonly bytes: number;
  readonly chunksLeft: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface UploaderDeps {
  readonly fetch: FetchLike;
  readonly persistence: UploadPersistence;
  readonly now?: () => number;
}

/** Key a persisted record by its object path: one upload per object, ever. */
export function recordKey(target: Pick<UploadTarget, 'objectPath'>): string {
  return target.objectPath;
}

async function failureOf(res: Response, what: string): Promise<TransportError> {
  let detail = '';
  try { detail = (await res.text()).slice(0, 300); } catch { detail = ''; }
  return new TransportError(res.status, `${what} failed (${res.status}).`, detail,
    res.headers.get('retry-after'));
}

/**
 * Create the upload and return its URL.
 *
 * `Upload-Length` is sent rather than `Upload-Defer-Length` because the
 * recording is finished before the upload starts and the server can then
 * reject an over-size object immediately instead of at 5 GiB.
 */
export async function createUpload(
  target: UploadTarget, source: UploadSource, creds: UploadCredentials, deps: UploaderDeps,
): Promise<UploadRecord> {
  const token = await creds.accessToken();
  const res = await deps.fetch(target.endpoint, {
    method: 'POST',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(source.bytes),
      'Upload-Metadata': encodeUploadMetadata({
        bucketName: target.bucket,
        objectName: target.objectPath,
        contentType: target.contentType,
        // One hour. The capture is read by the pipeline, not by browsers, so
        // this only affects the signed URLs the console hands to a reviewer.
        cacheControl: '3600',
      }),
      apikey: creds.anonKey,
      Authorization: `Bearer ${token}`,
    },
  }).catch((err: unknown) => {
    throw new TransportError(null, 'Could not reach storage to start the upload.', String(err));
  });
  if (!res.ok) throw await failureOf(res, 'Starting the upload');

  const record: UploadRecord = {
    uploadUrl: resolveUploadUrl(res.headers.get('location'), target.endpoint),
    objectPath: target.objectPath,
    bucket: target.bucket,
    bytes: source.bytes,
    offset: 0,
    createdAt: (deps.now ?? Date.now)(),
    worldId: target.worldId,
  };
  await deps.persistence.save(record);
  return record;
}

/**
 * Ask the server where it got to. The only trustworthy source of the offset.
 *
 * A persisted offset is what this client believed when it last wrote it down,
 * and the last PATCH before a crash may have landed. Starting from the
 * persisted number would then re-send bytes the server already has, and TUS
 * answers that with 409, not with a silent overwrite — so the HEAD is not an
 * optimisation, it is what makes the resume work at all.
 */
export async function headOffset(
  record: UploadRecord, creds: UploadCredentials, deps: UploaderDeps,
): Promise<number> {
  const token = await creds.accessToken();
  const res = await deps.fetch(record.uploadUrl, {
    method: 'HEAD',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      apikey: creds.anonKey,
      Authorization: `Bearer ${token}`,
    },
  }).catch((err: unknown) => {
    throw new TransportError(null, 'Could not reach storage to check the upload.', String(err));
  });
  if (!res.ok) throw await failureOf(res, 'Checking the upload');
  const offset = parseUploadOffset(res.headers.get('upload-offset'));
  if (offset === null) {
    throw new TransportError(null,
      'Storage did not say how much of the recording it already has. This is usually a CORS '
      + 'configuration that does not expose the Upload-Offset header.');
  }
  return assertServerOffset(offset, 0, record.bytes);
}

/** Send one chunk and return the server's new offset. */
export async function patchChunk(
  record: UploadRecord, offset: number, source: UploadSource,
  creds: UploadCredentials, deps: UploaderDeps,
): Promise<number> {
  const range = chunkRange(offset, record.bytes);
  if (range === null) return offset;
  const body = await source.slice(range.start, range.end);
  const token = await creds.accessToken();
  const res = await deps.fetch(record.uploadUrl, {
    method: 'PATCH',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': String(range.start),
      'Content-Type': 'application/offset+octet-stream',
      apikey: creds.anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: body as BodyInit,
  }).catch((err: unknown) => {
    throw new TransportError(null, 'The connection dropped while sending the recording.', String(err));
  });
  if (!res.ok) throw await failureOf(res, 'Sending the recording');
  const reported = parseUploadOffset(res.headers.get('upload-offset'));
  if (reported === null) {
    throw new TransportError(null,
      'Storage accepted the data but did not say how much it now has, so there is no safe place '
      + 'to continue from. This is usually a CORS configuration that does not expose the '
      + 'Upload-Offset header.');
  }
  return assertServerOffset(reported, range.start, record.bytes);
}
