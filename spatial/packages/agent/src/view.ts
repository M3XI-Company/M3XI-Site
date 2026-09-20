/**
 * ViewerState — what the person is actually looking at.
 *
 * The agent is useless without this. "How far is that from the window" has no
 * answer in the abstract; it has an answer for someone standing in the middle
 * of the kitchen looking at a sofa. So the client sends its pose and selection
 * with every turn, the tools read it, and the reference resolver scores
 * candidates against it.
 *
 * It is deliberately small and plain: it arrives as JSON from a browser and
 * must be validated as hostile input before anything spatial touches it.
 */

import type { Quat, Vec3 } from '@m3xi/world-core';

export interface ViewerState {
  position: Vec3;
  orientation: Quat;
  /** Vertical field of view in radians, matching the contract's angle unit. */
  fovRad: number;
  /** The entity the user last clicked, if any. Strongest resolver signal. */
  selectedEntityId?: string | undefined;
  /** Room the viewer believes it is in. The engine re-derives it; this is a hint. */
  roomId?: string | undefined;
}

export const DEFAULT_FOV_RAD = (60 * Math.PI) / 180;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function vec3(v: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = v[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    // A viewer that sends a position a kilometre from the property is either
    // broken or probing. Clamp rather than reject: a clamped pose still yields
    // an honest "you are not in any room" answer.
    out[i] = Math.max(-10_000, Math.min(10_000, n));
  }
  return out;
}

/**
 * Coerce untrusted JSON into a usable pose. Never throws: a malformed pose
 * degrades to the property's entrance, which is a safe place to be wrong.
 */
export function sanitiseViewerState(raw: unknown, fallback?: Partial<ViewerState>): ViewerState {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const position = vec3(src['position'], fallback?.position ?? [0, 1.6, 0]);
  let orientation = fallback?.orientation ?? ([0, 0, 0, 1] as Quat);
  const q = src['orientation'];
  if (Array.isArray(q) && q.length === 4 && q.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const len = Math.hypot(q[0] as number, q[1] as number, q[2] as number, q[3] as number);
    orientation = len > 1e-9
      ? [(q[0] as number) / len, (q[1] as number) / len, (q[2] as number) / len, (q[3] as number) / len]
      : orientation;
  }
  const fovRaw = num(src['fovRad'], fallback?.fovRad ?? DEFAULT_FOV_RAD);
  const fovRad = Math.max(0.05, Math.min(Math.PI * 0.98, fovRaw));

  const sel = src['selectedEntityId'];
  const room = src['roomId'];
  return {
    position,
    orientation,
    fovRad,
    // Ids are opaque strings here; the tools look them up and simply find
    // nothing if the client invented one. Length-capped so a megabyte of
    // "id" never reaches a database query.
    selectedEntityId: typeof sel === 'string' && sel.length > 0 && sel.length <= 128
      ? sel : undefined,
    roomId: typeof room === 'string' && room.length > 0 && room.length <= 128
      ? room : undefined,
  };
}
