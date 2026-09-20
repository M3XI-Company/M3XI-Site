/**
 * The upload loop, driven against a fake storage service.
 *
 * The scenario that matters is the one nobody can stage on a real phone: a tab
 * closed at 40% of 2 GB, reopened on a different network, resuming from the
 * server's idea of the offset rather than the client's. Everything here exists
 * to pin that, plus the two ways it is usually got wrong — trusting the
 * persisted offset, and restarting the whole upload when the URL expires
 * instead of only the transfer.
 */

import { describe, expect, it, vi } from 'vitest';
import { uploadRecording } from './upload.js';
import { CHUNK_BYTES, type UploadPersistence, type UploadRecord, type UploadSource } from './tus.js';
import { TransportError } from './retry.js';

const WORLD = '11111111-1111-4111-8111-111111111111';
const PATH = `${WORLD}/walkthrough-20260920T101500Z.webm`;
const ENDPOINT = 'https://project.supabase.co/storage/v1/upload/resumable';
const UPLOAD_URL = `${ENDPOINT}/abc123`;

function target(): { endpoint: string; bucket: string; objectPath: string; contentType: string; worldId: string } {
  return {
    endpoint: ENDPOINT, bucket: 'wv-captures', objectPath: PATH,
    contentType: 'video/webm', worldId: WORLD,
  };
}

function source(bytes: number): UploadSource {
  return {
    bytes,
    // The real source reads from IndexedDB; a length is all the loop needs.
    slice: async (start, end) => new Uint8Array(end - start),
  };
}

interface MemoryStore extends UploadPersistence { record: UploadRecord | null }

function memory(initial: UploadRecord | null = null): MemoryStore {
  const store: MemoryStore = {
    record: initial,
    load: async (key: string) => (store.record?.objectPath === key ? store.record : null),
    save: async (record: UploadRecord) => { store.record = record; },
    clear: async () => { store.record = null; },
  };
  return store;
}

interface Call { readonly method: string; readonly url: string; readonly offset: string | null }

/**
 * A storage service that keeps an offset, honours PATCH and answers HEAD.
 *
 * `faults` is a list of one-shot failures keyed by the call index, so a test
 * can say "the fourth PATCH drops the connection" without a mock framework
 * that hides which call it was.
 */
function server(options: {
  readonly total: number;
  readonly startOffset?: number;
  readonly faults?: Record<number, { status: number | null }>;
  readonly onCall?: (c: Call) => void;
} = { total: 0 }) {
  let offset = options.startOffset ?? 0;
  const calls: Call[] = [];
  let n = 0;
  const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
    const method = String(init.method ?? 'GET');
    const headers = new Headers(init.headers as HeadersInit);
    const call: Call = { method, url, offset: headers.get('upload-offset') };
    calls.push(call);
    options.onCall?.(call);
    const fault = options.faults?.[n];
    n += 1;
    if (fault) {
      if (fault.status === null) throw new Error('network');
      return new Response('nope', { status: fault.status });
    }
    if (method === 'POST') {
      return new Response(null, { status: 201, headers: { Location: UPLOAD_URL } });
    }
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Upload-Offset': String(offset) } });
    }
    if (method === 'PATCH') {
      const at = Number(headers.get('upload-offset'));
      if (at !== offset) return new Response('conflict', { status: 409 });
      offset = Math.min(options.total, offset + CHUNK_BYTES);
      return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } });
    }
    return new Response('?', { status: 405 });
  };
  return { fetch: fetchLike, calls, get offset() { return offset; } };
}

const creds = { accessToken: async () => 'token', anonKey: 'anon' };
const quiet = { sleep: async (): Promise<void> => undefined, random: () => 0 };

describe('uploadRecording', () => {
  it('creates an upload and sends every byte in 6 MB chunks', async () => {
    const total = 15 * 1024 * 1024;
    const s = server({ total });
    const persistence = memory();
    const progress: number[] = [];

    const out = await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1000 },
      onProgress: (p) => progress.push(p.offset),
      ...quiet,
    });

    expect(out.alreadyComplete).toBe(false);
    expect(out.restarts).toBe(0);
    expect(s.offset).toBe(total);
    expect(s.calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // Progress is reported from the server's offsets, ending exactly at total.
    expect(progress[progress.length - 1]).toBe(total);
  });

  it('forgets the record once the object is whole', async () => {
    const total = 3 * 1024 * 1024;
    const s = server({ total });
    const persistence = memory();
    await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1000 },
      ...quiet,
    });
    expect(persistence.record).toBeNull();
  });

  it('resumes from the SERVER offset, not the persisted one', async () => {
    const total = 18 * 1024 * 1024;
    // The tab died after the third PATCH landed but before its reply was
    // written down: the record says 12 MB, the server holds 18... no -- holds
    // more than the client wrote down. Re-sending from 12 would be a 409.
    const persisted: UploadRecord = {
      uploadUrl: UPLOAD_URL, objectPath: PATH, bucket: 'wv-captures',
      bytes: total, offset: 6 * 1024 * 1024, createdAt: 1000, worldId: WORLD,
    };
    const s = server({ total, startOffset: 12 * 1024 * 1024 });
    const persistence = memory(persisted);

    await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 2000 },
      ...quiet,
    });

    // One HEAD, no POST (the remembered URL was reused), and exactly one PATCH
    // -- from 12 MB, which is where the SERVER was, not 6 MB where the record
    // was.
    expect(s.calls.filter((c) => c.method === 'HEAD')).toHaveLength(1);
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const patches = s.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.offset).toBe(String(12 * 1024 * 1024));
  });

  it('treats an object the server already holds in full as done, not as work', async () => {
    const total = 12 * 1024 * 1024;
    const persisted: UploadRecord = {
      uploadUrl: UPLOAD_URL, objectPath: PATH, bucket: 'wv-captures',
      bytes: total, offset: 6 * 1024 * 1024, createdAt: 1000, worldId: WORLD,
    };
    const s = server({ total, startOffset: total });
    const persistence = memory(persisted);

    const out = await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 2000 },
      ...quiet,
    });

    expect(out.alreadyComplete).toBe(true);
    expect(s.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(persistence.record).toBeNull();
  });

  it('persists the offset after every chunk, so a crash costs one chunk', async () => {
    const total = 18 * 1024 * 1024;
    const saved: number[] = [];
    const persistence = memory();
    const save = persistence.save.bind(persistence);
    persistence.save = async (record) => { saved.push(record.offset); await save(record); };
    const s = server({ total });

    await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1000 },
      ...quiet,
    });

    // The create writes 0, then one write per chunk.
    expect(saved).toEqual([0, 6 * 1024 * 1024, 12 * 1024 * 1024, 18 * 1024 * 1024]);
  });

  it('retries a dropped connection mid-chunk and carries on from the same offset', async () => {
    const total = 12 * 1024 * 1024;
    // Calls: 0 POST, 1 PATCH (fails), 2 PATCH, 3 PATCH.
    const s = server({ total, faults: { 1: { status: null } } });
    const persistence = memory();
    const retries: number[] = [];

    await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1000 },
      onRetry: (ctx) => retries.push(ctx.attempt),
      ...quiet,
    });

    expect(retries).toEqual([0]);
    expect(s.offset).toBe(total);
  });

  it('creates a new upload when the remembered URL has been collected', async () => {
    const total = 6 * 1024 * 1024;
    const persisted: UploadRecord = {
      uploadUrl: UPLOAD_URL, objectPath: PATH, bucket: 'wv-captures',
      bytes: total, offset: 0, createdAt: 1000, worldId: WORLD,
    };
    // Call 0 is the HEAD, and it 404s: the URL is gone.
    const s = server({ total, faults: { 0: { status: 404 } } });
    const persistence = memory(persisted);

    const out = await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 2000 },
      ...quiet,
    });

    expect(out.restarts).toBe(1);
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(s.offset).toBe(total);
  });

  it('does not restart for ever', async () => {
    const total = 6 * 1024 * 1024;
    // Every PATCH 404s: the upload keeps dying the moment it is created.
    const s = server({ total, faults: { 1: { status: 404 }, 3: { status: 404 }, 5: { status: 404 } } });
    const persistence = memory();

    await expect(uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1000 },
      maxRestarts: 2,
      ...quiet,
    })).rejects.toThrow(TransportError);

    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(3);
  });

  it('ignores a remembered record for a different recording', async () => {
    const total = 12 * 1024 * 1024;
    const stale: UploadRecord = {
      uploadUrl: UPLOAD_URL, objectPath: PATH, bucket: 'wv-captures',
      bytes: 999, offset: 500, createdAt: 1000, worldId: WORLD,
    };
    const s = server({ total });
    const persistence = memory(stale);

    await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1200 },
      ...quiet,
    });

    // A POST, not a HEAD: the remembered upload was for a different file and
    // resuming it would have appended this walk to that one's object.
    expect(s.calls.filter((c) => c.method === 'HEAD')).toHaveLength(0);
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('stops when the operator cancels rather than finishing in the background', async () => {
    const total = 18 * 1024 * 1024;
    const signal = { aborted: false };
    const s = server({
      total,
      onCall: (c) => { if (c.method === 'PATCH') signal.aborted = true; },
    });
    const persistence = memory();

    await expect(uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1000 },
      signal,
      ...quiet,
    })).rejects.toThrow(/cancel/i);
    expect(s.offset).toBeLessThan(total);
  });

  it('refreshes the token once when a chunk comes back 401', async () => {
    const total = 6 * 1024 * 1024;
    const s = server({ total, faults: { 1: { status: 401 } } });
    const persistence = memory();
    const refreshAuth = vi.fn(async () => undefined);

    await uploadRecording({
      target: target(), source: source(total), credentials: creds,
      deps: { fetch: s.fetch, persistence, now: () => 1000 },
      refreshAuth,
      ...quiet,
    });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(s.offset).toBe(total);
  });
});
