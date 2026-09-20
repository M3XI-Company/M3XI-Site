/**
 * The messages the page and the analysis worker exchange.
 *
 * A separate file from both sides of the boundary, because a worker boundary
 * is a place where two pieces of code agree about a shape and neither of them
 * can see the other's types at runtime. Writing the shape down once, and
 * validating it on arrival, is what turns "the worker went quiet" into a line
 * on the screen.
 *
 * WHAT CROSSES, AND WHY IT IS RGBA AND NOT AN ImageBitmap.
 * The page grabs an `ImageBitmap` from the video and then draws it to an
 * `OffscreenCanvas` to get pixels. That draw could happen on either side. It
 * happens on the PAGE side, and the worker receives an RGBA buffer, for one
 * reason: an `ImageBitmap` is transferable but a `Uint8ClampedArray` is
 * transferable too, and the worker doing the draw would mean the worker owns a
 * canvas, a 2D context and the decode — 4-10 ms of GPU-adjacent work that
 * belongs on the thread that already has the video. The analysis itself is
 * 50-90 ms of pure arithmetic, and that is what the worker exists for.
 *
 * Buffers are TRANSFERRED, never copied. A 1080p RGBA frame is 8.3 MB; copying
 * one ten times a second is 83 MB/s of allocation and the garbage collector
 * pauses show up as exactly the analysis-cost spikes the pace controller
 * interprets as a slow device. So `frame.rgba.buffer` goes in the transfer
 * list and the page's reference to it is dead immediately afterwards, which is
 * why the page allocates a fresh buffer per frame rather than reusing one.
 *
 * NOTHING HERE FABRICATES. `decodeFromWorker` returns null for a message it
 * does not recognise and the page logs and shows that, rather than treating an
 * unparsed message as a frame with default values.
 */

import type { FrameResult, Orientation } from '@m3xi/capture-core';

/**
 * Only types are imported from `@m3xi/capture-core` in this file.
 *
 * With `verbatimModuleSyntax` a `import type` is erased entirely, which keeps
 * this module — and the tests that import it — free of any runtime dependency
 * on the package's built `dist/`. The worker itself imports the real thing;
 * the protocol does not need to.
 */

export interface PlannedRoomMessage {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly level: number;
  readonly isEntrance: boolean;
}

export interface StartMessage {
  readonly type: 'start';
  readonly rooms: readonly PlannedRoomMessage[];
  readonly analysisHz: number;
}

export interface FrameMessage {
  readonly type: 'frame';
  /** Monotonic id, so a reply can be matched to the frame that caused it. */
  readonly seq: number;
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Milliseconds since the capture started, not since the epoch. */
  readonly tMs: number;
}

export interface RoomMessage {
  readonly type: 'room';
  readonly roomId: string;
  readonly tMs: number;
}

export interface OrientationMessage {
  readonly type: 'orientation';
  readonly orientation: Orientation;
}

export interface SurfaceMessage {
  readonly type: 'surface';
  readonly kind: 'mirror' | 'glazing' | 'television' | 'polished_floor';
  readonly roomId: string;
  readonly tMs: number;
  readonly by: string;
}

export interface VerdictRequestMessage {
  readonly type: 'verdict';
  readonly recording: { readonly width: number; readonly height: number; readonly fps: number };
}

export type ToWorker =
  | StartMessage | FrameMessage | RoomMessage | OrientationMessage
  | SurfaceMessage | VerdictRequestMessage;

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface ResultMessage {
  readonly type: 'result';
  readonly seq: number;
  readonly result: FrameResult;
  /** The interval the session wants for the NEXT frame. */
  readonly intervalMs: number;
  /** Wall-clock milliseconds the worker spent on this frame, end to end. */
  readonly elapsedMs: number;
}

export interface CoverageMessage {
  readonly type: 'coverage';
  /** Serialised `VerdictInput`. The screen prints the figures from it. */
  readonly input: unknown;
  readonly report: unknown;
}

export interface WorkerErrorMessage {
  readonly type: 'error';
  readonly message: string;
  /** True when the analyser cannot continue at all. */
  readonly fatal: boolean;
}

export type FromWorker = ReadyMessage | ResultMessage | CoverageMessage | WorkerErrorMessage;

/**
 * Validate a message arriving from the worker.
 *
 * Structured clone cannot deliver a wrong shape by accident, so this is not
 * defensive programming against the platform — it is defence against the
 * worker having failed in a way that posts something else, and against a
 * future message type reaching an older page. Returning null and letting the
 * caller say "the analyser sent something this version does not understand" is
 * strictly better than destructuring undefined and showing a blank cue.
 */
export function decodeFromWorker(data: unknown): FromWorker | null {
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (type === 'ready') return { type: 'ready' };
  if (type === 'result') {
    const m = data as Partial<ResultMessage>;
    if (typeof m.seq !== 'number' || typeof m.intervalMs !== 'number') return null;
    if (typeof m.result !== 'object' || m.result === null) return null;
    return {
      type: 'result',
      seq: m.seq,
      result: m.result,
      intervalMs: m.intervalMs,
      elapsedMs: typeof m.elapsedMs === 'number' ? m.elapsedMs : 0,
    };
  }
  if (type === 'coverage') {
    const m = data as Partial<CoverageMessage>;
    if (m.input === undefined || m.report === undefined) return null;
    return { type: 'coverage', input: m.input, report: m.report };
  }
  if (type === 'error') {
    const m = data as Partial<WorkerErrorMessage>;
    return {
      type: 'error',
      message: typeof m.message === 'string' ? m.message : 'The analyser failed without saying why.',
      fatal: m.fatal === true,
    };
  }
  return null;
}

/**
 * Out-of-order and stale replies.
 *
 * With MAX_IN_FLIGHT at 1 this cannot currently happen, and the check is here
 * anyway: the day somebody raises the in-flight limit to two to chase a frame
 * rate, a stale result applied after a newer one would rewind the cue on
 * screen — the operator would be told to slow down for a moment that has
 * already passed. A monotonic sequence number costs nothing and makes that
 * change safe instead of subtly wrong.
 */
export function isStaleResult(seq: number, lastAppliedSeq: number): boolean {
  return seq <= lastAppliedSeq;
}
