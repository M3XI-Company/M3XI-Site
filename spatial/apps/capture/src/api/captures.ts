/**
 * Naming the object and registering the row.
 *
 * Two small things stand between a 3 GB upload and a capture the pipeline can
 * read, and both of them have a server-side rule that is stricter than it
 * looks.
 *
 * THE PATH. `wv-captures` grants INSERT and UPDATE through a policy keyed on
 * `wv_can_write_world(safe_uuid((storage.foldername(name))[1]))` — the FIRST
 * path segment must be a world id the member may write. `register_capture`
 * then repeats the check on the row with `pathIsInsideWorld`, which refuses a
 * leading slash, a backslash and any `..` outright rather than normalising
 * them. So the path is built here, once, from the world id, and never from
 * anything an operator typed. `captureObjectPath` re-applies the server's own
 * rule before the upload starts, because finding out at the end of a
 * gigabyte-and-a-half that the prefix was wrong is the most expensive possible
 * moment to find out.
 *
 * THE DUPLICATE. `register_capture` is idempotent: the unique index
 * `wv_capture_object (world_id, storage_path)` means a retry after a timeout
 * returns the FIRST capture's id with `duplicate: true` and a 200 instead of
 * making a second row. A phone on a doorstep retries — that is the whole
 * reason the server was written that way — and a client that treated the
 * second answer as a failure would either loop forever or send the operator
 * back into the property to walk it again. So `duplicate: true` is success
 * here, plainly, and the screen says "already registered" rather than hiding
 * it: an operator who sees the same capture id twice has learnt something true
 * about what happened.
 */

import { TransportError } from './retry.js';

/** A uuid, lowercased, in the shape Postgres will accept. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Characters an object name may contain.
 *
 * Narrower than storage allows, on purpose: letters, digits, dot, dash and
 * underscore. Everything a capture name needs to carry is a timestamp and a
 * kind, and a name that never needs escaping never gets escaped wrong in a
 * signed URL, a log line or a shell command in the pipeline.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * Build `${worldId}/<name>`, applying the server's rule before the upload.
 *
 * This mirrors `pathIsInsideWorld` in supabase/functions/wv-worlds/handler.ts.
 * The duplication is intentional and is the same two-locks-one-key argument
 * the server file makes about roles: the server is the lock, and the client
 * checks so it never starts work the lock will refuse.
 */
export function captureObjectPath(worldId: string, name: string): string {
  if (!UUID.test(worldId)) {
    throw new RangeError('A capture must be filed under a world id, and that is not one.');
  }
  if (!SAFE_NAME.test(name)) {
    throw new RangeError(
      'A capture file name may only contain letters, digits, dots, dashes and underscores.');
  }
  // `..` cannot survive SAFE_NAME plus the absence of a slash, but the check is
  // written anyway because the cost is a comparison and the failure it guards
  // is a path traversal into another tenant's prefix.
  if (name.includes('..')) throw new RangeError('A capture file name may not contain "..".');
  return `${worldId.toLowerCase()}/${name}`;
}

/**
 * The object name for a walkthrough.
 *
 * ISO-8601 with the punctuation removed, because a colon is legal in a storage
 * key and miserable in every tool that later handles it. The name is unique
 * per second per world, which is enough: a second walkthrough of the same
 * property within one second is not a thing that happens, and if it did, the
 * unique index on (world_id, storage_path) would turn it into the idempotent
 * path above rather than into a silent overwrite.
 */
export function captureObjectName(capturedAt: Date, extension = 'webm'): string {
  const stamp = capturedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  if (!/^[a-z0-9]{1,8}$/i.test(extension)) throw new RangeError('Unusable file extension.');
  return `walkthrough-${stamp}.${extension}`;
}

/**
 * The MIME type MediaRecorder actually produced, reduced to a file extension.
 *
 * `video/webm;codecs=vp9` and `video/mp4` are the two a phone will realistically
 * give, and the extension has to match what was recorded or the pipeline's
 * decoder is handed a lie. Anything unrecognised becomes `bin` rather than a
 * guess: ingest can sniff a container, and it cannot un-see a wrong suffix.
 */
export function extensionForMime(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'video/webm') return 'webm';
  if (base === 'video/mp4') return 'mp4';
  if (base === 'video/quicktime') return 'mov';
  return 'bin';
}

/** What the device was, as far as a browser can honestly say. */
export interface DeviceDescriptor {
  readonly userAgent: string;
  readonly platform: string | null;
  readonly recordedWidth: number;
  readonly recordedHeight: number;
  readonly recordedFps: number;
  readonly mimeType: string;
  /** True when the device gave DeviceOrientation samples. */
  readonly hadOrientation: boolean;
  /** Analysis rate actually sustained, frames per second. */
  readonly analysisHz: number;
  /** Fraction of the pipeline's candidates this phone judged, 0-1. */
  readonly analysedFraction: number;
}

export interface RegisterCaptureArgs {
  readonly worldId: string;
  readonly storagePath: string;
  readonly bytes: number;
  readonly durationS: number;
  readonly frameCount: number;
  readonly device: DeviceDescriptor;
  readonly capturedAt: Date;
}

export interface RegisteredCapture {
  readonly captureId: string;
  /** True when this exact object was already registered. Still a success. */
  readonly duplicate: boolean;
}

/** The narrow slice of the client this needs, so a test can supply one. */
export interface CaptureRegistrar {
  fn<T>(name: string, body: Record<string, unknown>): Promise<T>;
}

interface RegisterResponse {
  readonly capture?: { readonly id?: unknown; readonly kind?: unknown; readonly storagePath?: unknown };
  readonly duplicate?: unknown;
}

export async function registerCapture(
  client: CaptureRegistrar, args: RegisterCaptureArgs,
): Promise<RegisteredCapture> {
  // Checked here rather than trusted, because this is the last moment before
  // a row is written that points at an object, and the server returns the same
  // 400 for a bad prefix as for several other things.
  if (!args.storagePath.startsWith(`${args.worldId.toLowerCase()}/`)) {
    throw new RangeError('A capture path must start with the world id it is being filed under.');
  }
  const body: Record<string, unknown> = {
    action: 'register_capture',
    worldId: args.worldId,
    kind: 'video',
    storagePath: args.storagePath,
    bytes: args.bytes,
    duration_s: args.durationS,
    frame_count: args.frameCount,
    device: args.device,
    captured_at: args.capturedAt.toISOString(),
  };
  const res = await client.fn<RegisterResponse>('wv-worlds', body);
  const id = res.capture?.id;
  if (typeof id !== 'string' || id.length === 0) {
    // No fabricated id. A registration whose answer had no capture in it is a
    // registration this app cannot prove happened, and telling the operator it
    // succeeded would lose the walkthrough with a green tick on the screen.
    throw new TransportError(null,
      'Storage accepted the recording but the server did not return a capture id, so there is no '
      + 'proof it was filed. Do not delete the recording; show this screen to the office.');
  }
  return { captureId: id, duplicate: res.duplicate === true };
}
