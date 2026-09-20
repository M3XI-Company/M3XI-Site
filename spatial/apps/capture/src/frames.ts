/**
 * How often to hand the worker a frame, and at what size.
 *
 * Two decisions live here and they pull in opposite directions, which is why
 * they are written down together rather than scattered through the camera
 * loop.
 *
 * THE SIZE IS NOT NEGOTIABLE. `capture-core`'s SCORE_LONG_EDGE is 960 px and
 * its own header says why: variance of the Laplacian is resolution-dependent,
 * so scoring at 640 px silently changes what BLUR_ABS_FLOOR means and the app
 * starts measuring a quantity the pipeline will not reproduce. The session
 * downscales to 960 itself, in `onFrame`. What this app must therefore never
 * do is downscale FIRST — a frame grabbed at 640 and then "downscaled" to 960
 * is a 640 px measurement wearing a 960 px label, and `downscaleGray` cannot
 * tell the difference because upscaling is a no-op for it. So
 * `captureResolution` returns the source dimensions, every time, under every
 * load, and the test says so in as many words.
 *
 * THE RATE IS THE ONLY THING THAT GIVES. `PaceController` inside the session
 * already decides the target interval and exposes it as `session.intervalMs`.
 * This file's job is to HONOUR it against a callback that does not arrive on
 * demand, and to refuse to queue work the worker has not finished.
 *
 * WHY A LEAD TOLERANCE, AND WHY IT IS MEASURED RATHER THAN CONSTANT.
 * `requestVideoFrameCallback` fires once per decoded VIDEO frame — 33.3 ms at
 * 30 fps, 16.7 at 60. A naive `now - last >= interval` test then always
 * dispatches on the first callback AFTER the deadline, so a 100 ms target
 * sampled at 33.3 ms becomes 133.3 ms: a third slow, systematically, in one
 * direction. Over a five-minute walk that is a fifth of the candidates never
 * analysed, and the shortfall would show up as a lower `analysedFraction`
 * that the operator is asked to believe is the device being slow, when it is
 * the app's own rounding.
 *
 * So a callback that lands within half a callback-period BEFORE the deadline
 * is taken, which makes the error symmetric around the target instead of
 * one-sided. Half a period rather than a whole one because a whole period
 * would let two dispatches land inside one interval, and `dtMs` is a divisor
 * in the motion measurement.
 *
 * The period is measured from the callbacks themselves rather than read from
 * the track settings, because `MediaStreamTrack.getSettings().frameRate` is
 * what the camera was ASKED for and phones routinely deliver something else in
 * low light — where the pipeline's blur problems live.
 */

/** Frames handed to the worker but not yet answered. */
export const MAX_IN_FLIGHT = 1;

/** Ceiling on the measured callback period, so one stalled frame is not a rule. */
const MAX_PERIOD_MS = 200;

/**
 * Weight of a new sample in the period estimate.
 *
 * 0.2 is roughly a five-frame memory: fast enough to follow a camera that
 * drops from 30 to 15 fps when the light goes, slow enough that a single
 * garbage-collection pause does not move the tolerance.
 */
const PERIOD_ALPHA = 0.2;

export interface CaptureResolution {
  readonly width: number;
  readonly height: number;
}

/**
 * The resolution to grab a frame at.
 *
 * Takes the load situation as an argument and ignores it. That is not a stub:
 * the argument exists so that the one place in this app where somebody would
 * reach for a smaller frame to buy speed has a function to call, and the
 * function refuses in writing. The test pins it.
 */
export function captureResolution(
  source: CaptureResolution, _load: { readonly degraded: boolean; readonly medianCostMs: number },
): CaptureResolution {
  return { width: source.width, height: source.height };
}

export type SkipReason = 'too_soon' | 'worker_busy';

export type PaceDecision =
  | { readonly kind: 'analyse' }
  | { readonly kind: 'skip'; readonly because: SkipReason };

/**
 * The pacer. One per capture; fed by whichever loop is driving.
 *
 * Deliberately holds no reference to a video element, a worker or a clock:
 * every method takes the time it is being called at, so the whole of this runs
 * under vitest in Node against a number that goes up when the test says so.
 */
export class FramePacer {
  private lastDispatchMs: number | null = null;
  private lastCallbackMs: number | null = null;
  private periodMs: number | null = null;
  private outstanding = 0;
  private skippedBusy = 0;
  private skippedEarly = 0;
  private dispatchedCount = 0;

  /** Frames sent to the worker and not yet answered. */
  get inFlight(): number { return this.outstanding; }
  /** Measured interval between callbacks, or null before two have arrived. */
  get callbackPeriodMs(): number | null { return this.periodMs; }
  /** Frames not analysed because the worker was still busy. */
  get droppedForBusy(): number { return this.skippedBusy; }
  /** Frames not analysed because the target interval had not elapsed. */
  get droppedForPace(): number { return this.skippedEarly; }
  get dispatchedFrames(): number { return this.dispatchedCount; }

  /**
   * How much earlier than the deadline a frame may be taken.
   *
   * Before two callbacks have been seen there is no measured period, and the
   * tolerance is zero: guessing a cadence and then compensating for the guess
   * would bias the first seconds of every capture, which is exactly where the
   * blur judge's rolling median is still filling up.
   */
  get leadMs(): number {
    return this.periodMs === null ? 0 : this.periodMs / 2;
  }

  /**
   * Record that a frame callback arrived, whether or not it is used.
   *
   * Called for every callback — including the skipped ones — because the
   * cadence being measured is the camera's, not the analyser's.
   */
  observeCallback(nowMs: number): void {
    if (this.lastCallbackMs !== null) {
      const delta = nowMs - this.lastCallbackMs;
      // A negative or absurd delta is a tab that was backgrounded, not a
      // camera that ran at 2 fps. Folding it in would widen the tolerance for
      // minutes afterwards.
      if (delta > 0 && delta <= MAX_PERIOD_MS) {
        this.periodMs = this.periodMs === null
          ? delta
          : this.periodMs + PERIOD_ALPHA * (delta - this.periodMs);
      }
    }
    this.lastCallbackMs = nowMs;
  }

  /** Should this callback's frame be analysed? */
  decide(nowMs: number, intervalMs: number): PaceDecision {
    if (this.outstanding >= MAX_IN_FLIGHT) {
      this.skippedBusy += 1;
      return { kind: 'skip', because: 'worker_busy' };
    }
    if (this.lastDispatchMs === null) return { kind: 'analyse' };
    if (nowMs - this.lastDispatchMs >= intervalMs - this.leadMs) return { kind: 'analyse' };
    this.skippedEarly += 1;
    return { kind: 'skip', because: 'too_soon' };
  }

  markDispatched(nowMs: number): void {
    this.lastDispatchMs = nowMs;
    this.outstanding += 1;
    this.dispatchedCount += 1;
  }

  /** The worker answered. Called on failure as well, or the loop stops dead. */
  completed(): void {
    this.outstanding = Math.max(0, this.outstanding - 1);
  }

  /**
   * Delay for the timer fallback, where there is no callback to wait for.
   *
   * `requestVideoFrameCallback` is absent on Firefox and on older WebKit, and
   * the fallback is a timer. Here the lead tolerance would be wrong — nothing
   * is quantising the wake-up to a video frame, so firing early just runs the
   * analyser faster than the session asked. The floor is zero rather than
   * negative because `setTimeout(-4)` is `setTimeout(0)` and reading a clamp
   * out of the platform is worse than writing it.
   */
  nextDelayMs(nowMs: number, intervalMs: number): number {
    if (this.lastDispatchMs === null) return 0;
    return Math.max(0, intervalMs - (nowMs - this.lastDispatchMs));
  }

  /**
   * What fraction of the callbacks offered actually became analysis.
   *
   * Shown to nobody on its own: it is one of the two numbers behind the
   * honesty banner, the other being the session's `analysedFraction`. This one
   * says how much the APP dropped; that one says how much of the pipeline's
   * work the app matched. They are different questions and a low value here
   * with a high value there is the normal, healthy case — a 30 fps camera
   * feeding a 10 Hz analyser drops two callbacks in three by design.
   */
  utilisation(): number {
    const offered = this.dispatchedCount + this.skippedBusy + this.skippedEarly;
    return offered === 0 ? 1 : this.dispatchedCount / offered;
  }
}
