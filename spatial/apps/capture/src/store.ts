/**
 * What survives the phone being locked, the app being switched, or the tab
 * being killed.
 *
 * IndexedDB rather than the Cache API or the File System Access API. Cache
 * storage is keyed by Request and is the wrong shape for an append-only list
 * of video pieces; the File System Access API does not exist on iOS Safari at
 * all, which is most of the devices this runs on. IndexedDB is the only thing
 * available everywhere that takes a Blob and keeps it.
 *
 * THREE STORES, AND WHY THEY ARE SEPARATE.
 *
 *   `chunks`   one row per MediaRecorder timeslice, keyed [captureId, index].
 *              Written as they arrive, which is the whole point: the bytes are
 *              durable BEFORE anything goes wrong rather than at `stop()`.
 *
 *   `captures` one row per walk, holding what the registration will need —
 *              the world, the rooms, the mime type, when it started. Kept
 *              apart from the chunks so reading the manifest does not drag
 *              gigabytes of Blob handles into memory.
 *
 *   `uploads`  the resumable upload record, keyed by object path. Separate
 *              again because it has a different lifetime: it is cleared when
 *              the object is whole, while the chunks are kept until the
 *              capture is registered, so a failed registration can be retried
 *              without the recording having been thrown away.
 *
 * WHAT IS NOT DELETED AUTOMATICALLY. Nothing. A recording is removed when the
 * operator says so, on a screen that tells them it has been registered and
 * gives them the capture id. An app that tidies up after itself is an app that
 * one day tidies up a walkthrough somebody has not uploaded, and there is no
 * getting back into the property.
 */

import { buildLedger, sliceChunks, type ChunkLedger, type ChunkMeta } from './chunks.js';
import type { UploadPersistence, UploadRecord, UploadSource } from './api/tus.js';

const DB_NAME = 'm3xi-capture';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const CAPTURES = 'captures';
const UPLOADS = 'uploads';

export interface CaptureManifest {
  readonly captureId: string;
  readonly worldId: string;
  readonly propertyTitle: string;
  readonly worldVersion: number;
  readonly mimeType: string;
  readonly startedAt: number;
  /** Set when the recording stops. Null while it is still running. */
  readonly durationS: number | null;
  readonly recordedWidth: number;
  readonly recordedHeight: number;
  readonly recordedFps: number;
  readonly rooms: readonly { readonly id: string; readonly name: string; readonly kind: string; readonly level: number; readonly isEntrance: boolean }[];
  /** Set once wv-worlds has a row for it. */
  readonly registeredCaptureId: string | null;
}

interface ChunkRow {
  readonly captureId: string;
  readonly index: number;
  readonly blob: Blob;
  readonly bytes: number;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB refused the request.'));
  });
}

/**
 * Open the database.
 *
 * Failure is surfaced rather than swallowed. A capture app whose storage does
 * not work must say so BEFORE recording starts, because the alternative is an
 * operator walking a property for five minutes and then discovering there is
 * nothing to upload. Private browsing on iOS is the realistic cause.
 */
export function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(
        'This browser has no storage available, so a walkthrough could not be kept safe while '
        + 'you record it. Private browsing is the usual cause.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: ['captureId', 'index'] });
      }
      if (!db.objectStoreNames.contains(CAPTURES)) {
        db.createObjectStore(CAPTURES, { keyPath: 'captureId' });
      }
      if (!db.objectStoreNames.contains(UPLOADS)) {
        db.createObjectStore(UPLOADS, { keyPath: 'objectPath' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open local storage.'));
  });
}

export class CaptureStore {
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) { this.db = db; }

  static async open(): Promise<CaptureStore> {
    return new CaptureStore(await openStore());
  }

  private tx(store: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async putManifest(manifest: CaptureManifest): Promise<void> {
    await request(this.tx(CAPTURES, 'readwrite').put(manifest));
  }

  async manifest(captureId: string): Promise<CaptureManifest | null> {
    const row = await request<CaptureManifest | undefined>(this.tx(CAPTURES, 'readonly').get(captureId));
    return row ?? null;
  }

  /** Every walk this device still holds, newest first. */
  async manifests(): Promise<readonly CaptureManifest[]> {
    const rows = await request<CaptureManifest[]>(this.tx(CAPTURES, 'readonly').getAll());
    return rows.slice().sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Append one MediaRecorder piece.
   *
   * Awaited by the caller: a `dataavailable` handler that fires and forgets
   * would let the tab be killed between the event and the write, which is
   * exactly the gap this whole design exists to close.
   */
  async appendChunk(captureId: string, index: number, blob: Blob): Promise<void> {
    const row: ChunkRow = { captureId, index, blob, bytes: blob.size };
    await request(this.tx(CHUNKS, 'readwrite').put(row));
  }

  /** The sizes, in order. The Blobs stay on disk. */
  async ledger(captureId: string): Promise<ChunkLedger> {
    const range = IDBKeyRange.bound([captureId, -Infinity], [captureId, Infinity]);
    const rows = await request<ChunkRow[]>(this.tx(CHUNKS, 'readonly').getAll(range));
    const metas: ChunkMeta[] = rows.map((r) => ({ index: r.index, bytes: r.bytes }));
    return buildLedger(metas);
  }

  async readChunk(captureId: string, index: number): Promise<Blob> {
    const row = await request<ChunkRow | undefined>(
      this.tx(CHUNKS, 'readonly').get([captureId, index]));
    if (!row) throw new Error(`Piece ${index} of the recording is missing from local storage.`);
    return row.blob;
  }

  async deleteCapture(captureId: string): Promise<void> {
    const range = IDBKeyRange.bound([captureId, -Infinity], [captureId, Infinity]);
    await request(this.tx(CHUNKS, 'readwrite').delete(range));
    await request(this.tx(CAPTURES, 'readwrite').delete(captureId));
  }

  /** The `UploadPersistence` the resumable uploader wants. */
  uploads(): UploadPersistence {
    return {
      load: async (key: string): Promise<UploadRecord | null> => {
        const row = await request<UploadRecord | undefined>(this.tx(UPLOADS, 'readonly').get(key));
        return row ?? null;
      },
      save: async (record: UploadRecord): Promise<void> => {
        await request(this.tx(UPLOADS, 'readwrite').put(record));
      },
      clear: async (key: string): Promise<void> => {
        await request(this.tx(UPLOADS, 'readwrite').delete(key));
      },
    };
  }
}

/**
 * The recording, presented to the uploader as a range-readable source.
 *
 * `slice` assembles ONLY the requested range — 6 MB — out of whichever pieces
 * span it. The recording is never whole in memory and never whole on disk
 * twice. On a phone that has just spent five minutes filling its storage,
 * that is not an optimisation.
 */
export function uploadSourceFor(
  store: CaptureStore, captureId: string, ledger: ChunkLedger,
): UploadSource {
  return {
    bytes: ledger.totalBytes,
    async slice(start: number, end: number): Promise<Blob> {
      const parts: Blob[] = [];
      for (const piece of sliceChunks(ledger, start, end)) {
        const blob = await store.readChunk(captureId, piece.index);
        if (blob.size !== ledger.chunks[piece.index]?.bytes) {
          // The ledger and the stored Blob disagree, which means the byte
          // offsets computed from the ledger point somewhere else. Continuing
          // would upload an object of the right length and the wrong content.
          throw new Error(
            `Piece ${piece.index} of the recording is a different size than it was when the `
            + 'upload started. The recording cannot be uploaded safely.');
        }
        parts.push(piece.from === 0 && piece.to === blob.size ? blob : blob.slice(piece.from, piece.to));
      }
      return new Blob(parts);
    },
  };
}

/**
 * Space to record into, when the browser will say.
 *
 * `navigator.storage.estimate()` is advisory everywhere and absent on some
 * WebKit builds, so a null answer means "unknown" and the screen says that
 * rather than guessing. What it must never do is report a number it made up:
 * an operator told they have room and then stopped at minute four has lost the
 * appointment.
 */
export async function availableBytes(): Promise<number | null> {
  try {
    const nav = navigator as Navigator & { storage?: { estimate?: () => Promise<StorageEstimate> } };
    if (!nav.storage?.estimate) return null;
    const estimate = await nav.storage.estimate();
    if (typeof estimate.quota !== 'number') return null;
    const used = typeof estimate.usage === 'number' ? estimate.usage : 0;
    return Math.max(0, estimate.quota - used);
  } catch {
    return null;
  }
}

/**
 * Ask the browser not to evict this origin's storage under pressure.
 *
 * Best effort and reported as such. Chrome grants it silently for an installed
 * PWA; Safari does not implement it at all. The recording is still written as
 * it goes either way — persistence changes how likely eviction is, not whether
 * the bytes are on disk.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & { storage?: { persist?: () => Promise<boolean> } };
    if (!nav.storage?.persist) return false;
    return await nav.storage.persist();
  } catch {
    return false;
  }
}
