/**
 * The analysis thread.
 *
 * Everything expensive happens here: `toGray` over a 1080p RGBA buffer,
 * `downscaleGray` to SCORE_LONG_EDGE, and `CaptureSession.onFrame`, which is
 * 50-90 ms of Laplacian variance, projection matching and tile statistics on a
 * mid-range phone. On the main thread that would block the `<video>` compositor
 * and MediaRecorder's own work, and the operator would see a preview that
 * stutters every time the app thinks — which reads as "the app is broken" and,
 * worse, makes people walk differently.
 *
 * The session lives here rather than on the page for the same reason: it holds
 * the rolling blur median, the overlap tracker and the coverage model, and
 * shipping those back and forth per frame would cost more than the analysis.
 * The page keeps no copy; it renders what comes back.
 *
 * WHAT THIS WORKER DOES NOT DO:
 *   - it does not downscale before scoring. The buffer arrives at the camera's
 *     own resolution and `session.onFrame` does the one downscale there is,
 *     to SCORE_LONG_EDGE. See `src/frames.ts` for why that is load-bearing.
 *   - it does not decide the rate. `PaceController` inside the session does,
 *     and the page honours `intervalMs`, which is sent back with every result.
 *   - it does not invent a result when something throws. A failure is posted
 *     as an error the screen shows.
 *
 * ONE HONEST GAP, MEASURED RATHER THAN IGNORED. `FrameAnalysis.costMs` — the
 * number `PaceController` adapts on — is timed INSIDE `analyseFrame`, so it
 * excludes the `toGray` pass this worker does first. On a 1080p frame that is
 * about two million pixels of integer arithmetic, and on a slow handset it is
 * not free. The pace controller therefore has a systematically optimistic view
 * of what a frame costs, and could hold a rate the device cannot really
 * sustain. Changing that belongs in capture-core, not here; what this worker
 * does instead is report `elapsedMs` for the WHOLE frame, conversion included,
 * so the page can compare it against the interval it was asked for and tell
 * the operator the truth even when the session has not noticed yet.
 */

/// <reference lib="webworker" />

import {
  ANALYSIS_HZ, CaptureSession, buildVerdict, toGray,
  type PlannedRoom, type RgbaImage,
} from '@m3xi/capture-core';
import type { FromWorker, ToWorker } from './protocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let session: CaptureSession | null = null;

function post(message: FromWorker): void {
  scope.postMessage(message);
}

function fail(message: string, fatal: boolean): void {
  post({ type: 'error', message, fatal });
}

scope.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'start': {
        // `kind` crosses the boundary as a string because RoomKind is a union
        // of string literals and structured clone does not carry types. The
        // page validated it against the enum before sending; re-validating
        // here would need world-core's list, and the cast is honest about
        // where the check lives.
        const rooms = msg.rooms.map((r): PlannedRoom => ({
          id: r.id,
          name: r.name,
          kind: r.kind as PlannedRoom['kind'],
          level: r.level,
          isEntrance: r.isEntrance,
        }));
        session = new CaptureSession(rooms, { analysisHz: msg.analysisHz || ANALYSIS_HZ });
        post({ type: 'ready' });
        return;
      }
      case 'room': {
        requireSession().enterRoom(msg.roomId, msg.tMs);
        return;
      }
      case 'orientation': {
        requireSession().onOrientation(msg.orientation);
        return;
      }
      case 'surface': {
        requireSession().declareSurface({
          kind: msg.kind, roomId: msg.roomId, tMs: msg.tMs, by: msg.by,
        });
        return;
      }
      case 'frame': {
        const s = requireSession();
        const startedAt = now();
        const rgba: RgbaImage = { data: msg.rgba, width: msg.width, height: msg.height };
        // toGray first, at the source resolution: `session.onFrame` does the
        // single downscale to SCORE_LONG_EDGE itself, and doing it here as
        // well would be scoring a twice-filtered image.
        const result = s.onFrame(toGray(rgba), msg.tMs);
        post({
          type: 'result',
          seq: msg.seq,
          result,
          intervalMs: s.intervalMs,
          elapsedMs: now() - startedAt,
        });
        return;
      }
      case 'verdict': {
        const s = requireSession();
        const input = s.verdictInput(msg.recording);
        post({ type: 'coverage', input, report: buildVerdict(input) });
        return;
      }
      default: {
        // A message this build does not know about. Not fatal: the analyser is
        // still running and the walk should not stop because a newer page sent
        // something older code cannot read.
        fail(`The analyser received a message it does not understand.`, false);
      }
    }
  } catch (err) {
    // A throw inside the session is not recoverable — its internal state is
    // now of unknown age — so this is fatal and the screen says the guidance
    // has stopped rather than freezing on the last cue, which would read as
    // "everything is fine".
    fail(err instanceof Error ? err.message : String(err), true);
  }
});

function requireSession(): CaptureSession {
  if (session === null) {
    throw new Error('The analyser was asked to work before the rooms were set.');
  }
  return session;
}

/**
 * A monotonic clock, falling back to Date.now.
 *
 * `performance` exists in workers everywhere this app runs, but the fallback
 * costs one line and the alternative — `elapsedMs` coming back as NaN and
 * silently poisoning the cost display — is not worth saving it.
 */
function now(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
