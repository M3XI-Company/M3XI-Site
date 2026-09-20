/**
 * The object path and the registration.
 *
 * Two assertions carry the file. The path has to satisfy the bucket policy AND
 * `pathIsInsideWorld` in wv-worlds, both of which key on the first segment
 * being the world id; getting it wrong is discovered after a gigabyte and a
 * half. And `duplicate: true` has to be read as success, because the server
 * was deliberately written to answer a retry that way and a client that called
 * it a failure would send somebody back into the property for nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  captureObjectName, captureObjectPath, extensionForMime, registerCapture,
  type CaptureRegistrar, type DeviceDescriptor,
} from './captures.js';
import { TransportError } from './retry.js';

/**
 * A `wv-worlds` that answers with whatever the test says, and remembers what
 * it was asked. Hand-written rather than a mock, because `fn` is generic and a
 * generic method is exactly the shape a mock helper cannot express without a
 * cast that then hides a real type error.
 */
function registrar(answer: unknown): {
  readonly client: CaptureRegistrar;
  readonly calls: readonly (readonly [string, Record<string, unknown>])[];
} {
  const calls: (readonly [string, Record<string, unknown>])[] = [];
  const client: CaptureRegistrar = {
    async fn<T>(name: string, body: Record<string, unknown>): Promise<T> {
      calls.push([name, body]);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
  return { client, calls };
}

const WORLD = '3f2a1b44-5c6d-4e7f-8a9b-0c1d2e3f4a5b';

describe('captureObjectPath', () => {
  it('puts the world id first, because that is what the bucket policy reads', () => {
    expect(captureObjectPath(WORLD, 'walkthrough-20260920T101500Z.webm'))
      .toBe(`${WORLD}/walkthrough-20260920T101500Z.webm`);
  });

  it('lowercases the world id so the path matches what the server compares', () => {
    expect(captureObjectPath(WORLD.toUpperCase(), 'a.webm')).toBe(`${WORLD}/a.webm`);
  });

  it('refuses anything that is not a world id in the first segment', () => {
    expect(() => captureObjectPath('not-a-uuid', 'a.webm')).toThrow(RangeError);
    expect(() => captureObjectPath('', 'a.webm')).toThrow(RangeError);
  });

  it('refuses a name that could climb out of the prefix', () => {
    expect(() => captureObjectPath(WORLD, '../other/a.webm')).toThrow(RangeError);
    expect(() => captureObjectPath(WORLD, 'sub/a.webm')).toThrow(RangeError);
    expect(() => captureObjectPath(WORLD, 'a\\b.webm')).toThrow(RangeError);
  });

  it('refuses a name with characters that would need escaping later', () => {
    expect(() => captureObjectPath(WORLD, 'walk through.webm')).toThrow(RangeError);
    expect(() => captureObjectPath(WORLD, 'walk?.webm')).toThrow(RangeError);
  });
});

describe('captureObjectName', () => {
  it('is a sortable stamp with no punctuation a tool will mishandle', () => {
    const name = captureObjectName(new Date('2026-09-20T10:15:00.000Z'));
    expect(name).toBe('walkthrough-20260920T101500Z.webm');
    expect(name).not.toContain(':');
  });

  it('carries the container it was actually recorded in', () => {
    expect(captureObjectName(new Date('2026-09-20T10:15:00.000Z'), 'mp4'))
      .toMatch(/\.mp4$/);
  });

  it('refuses an extension that is not one', () => {
    expect(() => captureObjectName(new Date(), 'not an extension')).toThrow(RangeError);
  });
});

describe('extensionForMime', () => {
  it('reads the container out of what MediaRecorder reported', () => {
    expect(extensionForMime('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(extensionForMime('video/mp4')).toBe('mp4');
    expect(extensionForMime('video/quicktime')).toBe('mov');
  });

  it('refuses to guess for anything else', () => {
    // ingest can sniff a container; it cannot un-see a wrong suffix.
    expect(extensionForMime('application/octet-stream')).toBe('bin');
    expect(extensionForMime('')).toBe('bin');
  });
});

describe('registerCapture', () => {
  const device: DeviceDescriptor = {
    userAgent: 'test', platform: null, recordedWidth: 1920, recordedHeight: 1080,
    recordedFps: 30, mimeType: 'video/webm', hadOrientation: true, analysisHz: 10,
    analysedFraction: 0.98,
  };
  const args = {
    worldId: WORLD,
    storagePath: `${WORLD}/walkthrough-20260920T101500Z.webm`,
    bytes: 1_800_000_000,
    durationS: 312.4,
    frameCount: 268,
    device,
    capturedAt: new Date('2026-09-20T10:15:00.000Z'),
  };

  it('calls wv-worlds with the action and the snake_case the handler reads', async () => {
    const { client, calls } = registrar({ capture: { id: 'cap-1' } });
    const out = await registerCapture(client, args);
    expect(out).toEqual({ captureId: 'cap-1', duplicate: false });
    const [name, body] = calls[0]!;
    expect(name).toBe('wv-worlds');
    expect(body['action']).toBe('register_capture');
    expect(body['kind']).toBe('video');
    expect(body['duration_s']).toBe(312.4);
    expect(body['frame_count']).toBe(268);
    expect(body['captured_at']).toBe('2026-09-20T10:15:00.000Z');
    expect(body['storagePath']).toBe(args.storagePath);
  });

  it('treats duplicate:true as success, because the server meant it that way', async () => {
    const { client } = registrar({ capture: { id: 'cap-first' }, duplicate: true });
    expect(await registerCapture(client, args)).toEqual({ captureId: 'cap-first', duplicate: true });
  });

  it('refuses to send a path outside the world prefix', async () => {
    const { client, calls } = registrar({ capture: { id: 'x' } });
    await expect(registerCapture(client, {
      ...args, storagePath: 'somewhere-else/walkthrough.webm',
    })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('does not invent a capture id when the answer had none', async () => {
    // Reporting success here would lose a walkthrough behind a green tick.
    const { client } = registrar({ duplicate: false });
    await expect(registerCapture(client, args)).rejects.toThrow(TransportError);
    await expect(registerCapture(client, args)).rejects.toThrow(/did not return a capture id/i);
  });

  it('lets a transport failure through rather than swallowing it', async () => {
    const boom = new TransportError(503, 'busy');
    const { client } = registrar(boom);
    await expect(registerCapture(client, args)).rejects.toBe(boom);
  });
});
