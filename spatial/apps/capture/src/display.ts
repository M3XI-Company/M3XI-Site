/**
 * From what the analyser measured to what the screen says.
 *
 * All of it pure, because this is where an honest app becomes a dishonest one
 * by accident. The three decisions that matter:
 *
 * THE HEADLINE IS NOT REWRITTEN. `Cue.headline` is two or three words chosen
 * to be read WHILE WALKING and `Cue.detail` is one sentence meant to be read
 * when the operator stops. The screen must respect that split: the headline is
 * the biggest thing on the display and the detail is ordinary body text
 * underneath, not a second shout. So this file passes both through verbatim
 * and never concatenates them, and `LiveView` keeps them as separate fields so
 * a renderer cannot accidentally merge them.
 *
 * A GREEN LIGHT FROM A THIRD OF THE FRAMES IS A LIE. `analysedFraction` is the
 * share of the pipeline's candidates this phone actually judged. A cue of
 * level 'ok' computed from 30% of them is not the same statement as one
 * computed from all of them — the blur rule is a comparison against a rolling
 * median, and a median over a sample is a different statistic. So the
 * confidence strip is computed independently of the cue, it is never softened
 * by a good cue, and when the fraction is below the verdict's own threshold
 * the strip says so in the same words the verdict will use later. The operator
 * should never be surprised at the end by a confidence problem the live screen
 * knew about.
 *
 * THE DIAL IS ABSENT, NOT ZERO. Plenty of devices give no DeviceOrientation at
 * all: iOS requires a user gesture to grant it and refuses outright over
 * plain HTTP, and many Android browsers report nothing useful indoors. When
 * there is no orientation, `yaw` is null and the renderer omits the dial
 * entirely. A dial stuck at north is worse than no dial: it is a measurement
 * that is not being made, drawn as though it were.
 */

import type {
  Cue, CueLevel, CoverageSnapshot, FrameResult, Orientation, PlannedRoom, RoomState,
} from '@m3xi/capture-core';

/**
 * Types only from `@m3xi/capture-core`, so this module and its test have no
 * runtime dependency on the package's built `dist/`. See worker/protocol.ts.
 */

/** How loud the screen should be. Maps one-to-one onto the cue levels. */
export type Tone = 'act' | 'advise' | 'ok';

export interface ConfidenceView {
  /** 0-1, the share of the pipeline's candidates judged so far. */
  readonly fraction: number;
  /** "Checking every frame", "Checking 2 frames in 3". Never a bare percent. */
  readonly label: string;
  /** One sentence for when they stop. */
  readonly detail: string;
  readonly tone: Tone;
  /** True when a verdict computed now would be capped at 'fix' for this alone. */
  readonly belowVerdictFloor: boolean;
}

export interface YawView {
  /** Radians, right-handed, +Y up, as capture-core reports it. */
  readonly yaw: number;
  /** True when the yaw is referenced to magnetic north rather than an arbitrary zero. */
  readonly absolute: boolean;
  /** Bins of the yaw circle already observed in this room, for the dial. */
  readonly bins: readonly boolean[];
  /** 0-1 of the circle seen in this room, or null before any is. */
  readonly coverage: number | null;
}

export interface RoomChip {
  readonly roomId: string;
  readonly name: string;
  readonly state: RoomState;
  readonly current: boolean;
  /**
   * What is still missing here, in the operator's words. Empty when nothing
   * is. Comes straight from `RoomCoverage.gaps`; nothing is invented.
   */
  readonly gaps: readonly string[];
  /** Seconds of accepted recording attributed to this room. */
  readonly seconds: number;
  /** For the accessible name, so a screen reader does not read a bare word. */
  readonly label: string;
}

export interface LiveView {
  readonly headline: string;
  readonly detail: string;
  readonly level: CueLevel;
  readonly tone: Tone;
  readonly confidence: ConfidenceView;
  readonly yaw: YawView | null;
  /** Everything currently true, headline only, for the secondary list. */
  readonly alsoActive: readonly { readonly id: string; readonly headline: string; readonly level: CueLevel }[];
  /** Glazing the analyser saw this frame, in words. Empty when none. */
  readonly glazingWhere: readonly string[];
  /** True when the session says the analyser is not keeping up. */
  readonly degraded: boolean;
}

/**
 * The share of the pipeline's candidates below which the verdict is capped.
 *
 * Passed in rather than imported so this module stays free of any runtime
 * import from capture-core: `main.ts` hands it `VERDICT_MIN_ANALYSED_FRACTION`,
 * which keeps the threshold single-sourced in `thresholds.ts` where it belongs
 * while leaving this file testable against a plain number.
 */
export interface DisplayThresholds {
  readonly minAnalysedFraction: number;
}

/**
 * "1 frame in 3", not "33%".
 *
 * The same reasoning `guidance.ts` gives for its degraded headline: a ratio is
 * four short words that a walking person turns into an intuition without
 * stopping, and a percentage takes a beat longer. The percentage is still
 * available in `detail` for anyone who stands still and reads it.
 */
export function describeFraction(fraction: number): string {
  if (!(fraction > 0)) return 'Checking no frames';
  if (fraction >= 0.995) return 'Checking every frame';
  const n = Math.round(1 / Math.min(1, fraction));
  if (n <= 1) return 'Checking almost every frame';
  if (n === 2) return 'Checking 1 frame in 2';
  return `Checking 1 frame in ${n}`;
}

export function confidenceView(
  analysedFraction: number, degraded: boolean, thresholds: DisplayThresholds,
): ConfidenceView {
  const fraction = Math.max(0, Math.min(1, analysedFraction));
  const belowFloor = fraction < thresholds.minAnalysedFraction;
  // The tone is computed from the measurement alone. It is NOT softened when
  // the current cue happens to be 'steady': the two answer different
  // questions, and letting a good cue quiet the confidence strip is exactly
  // the green-light-from-a-third-of-the-frames failure.
  const tone: Tone = degraded || belowFloor ? 'act' : fraction < 0.95 ? 'advise' : 'ok';
  const percent = Math.round(fraction * 100);
  // Two lines at most. This sits at the top of a screen somebody is walking
  // past, above a cue that has to be the biggest thing on it: a five-line
  // paragraph here would push the cue down and get read by nobody. The full
  // explanation of what a partial analysis means is on the go/no-go screen,
  // where there is time to read it, as `capture.analysis_coverage`.
  const detail = degraded
    ? `Judging ${percent}% of the frames the pipeline will, and falling behind. Walk slower.`
    : belowFloor
      ? `Judging ${percent}% of the frames the pipeline will — too few for a clear pass alone.`
      : `Judging ${percent}% of the frames the pipeline will.`;
  return { fraction, label: describeFraction(fraction), detail, tone, belowVerdictFloor: belowFloor };
}

/**
 * The yaw dial, or nothing.
 *
 * `orientation` null means the device never gave one. `bins` empty means it
 * gave one but no room has been entered yet. Those are different states and
 * neither of them is "north".
 */
export function yawView(
  orientation: Orientation | null, room: { readonly yawBins: readonly boolean[]; readonly yawCoverage: number | null } | null,
): YawView | null {
  if (orientation === null) return null;
  return {
    yaw: orientation.yaw,
    absolute: orientation.absolute,
    bins: room?.yawBins ?? [],
    coverage: room?.yawCoverage ?? null,
  };
}

const STATE_WORDS: Readonly<Record<RoomState, string>> = {
  not_started: 'not started',
  thin: 'thin coverage',
  done: 'covered',
};

/**
 * The room chips: where they are, and what is left.
 *
 * There is no floorplan here and there will not be one. A browser has no
 * position: `DeviceMotionEvent` gives linear acceleration and integrating it
 * twice is metres out inside three seconds, which capture-core's own header
 * says and its `RoomCoverage` enforces by having no position field to misuse.
 * A drawn plan that drifted would be worse than a list, because an operator
 * would believe it. So the model of where they are is the room they last
 * tapped, and the chips are how they tap it.
 *
 * Order follows the planned route, not the coverage state: the route was
 * computed to be walked in order, and re-sorting it by what is outstanding
 * would send somebody back up the stairs for one room.
 */
export function roomChips(
  rooms: readonly PlannedRoom[], snapshot: CoverageSnapshot | null, currentRoomId: string | null,
): readonly RoomChip[] {
  const byId = new Map((snapshot?.rooms ?? []).map((r) => [r.roomId, r]));
  return rooms.map((room): RoomChip => {
    const cov = byId.get(room.id);
    const state: RoomState = cov?.state ?? 'not_started';
    const seconds = cov?.seconds ?? 0;
    const current = room.id === currentRoomId;
    return {
      roomId: room.id,
      name: room.name,
      state,
      current,
      gaps: cov?.gaps ?? [],
      seconds,
      label: current
        ? `${room.name}, you are here, ${STATE_WORDS[state]}`
        : `${room.name}, ${STATE_WORDS[state]}`,
    };
  });
}

/** Cue level to tone. One-to-one today; named so a renderer never invents one. */
export function toneOf(level: CueLevel): Tone {
  return level;
}

export function liveView(
  result: FrameResult, orientation: Orientation | null,
  room: { readonly yawBins: readonly boolean[]; readonly yawCoverage: number | null } | null,
  thresholds: DisplayThresholds,
): LiveView {
  const cue: Cue = result.cue;
  return {
    headline: cue.headline,
    detail: cue.detail,
    level: cue.level,
    tone: toneOf(cue.level),
    confidence: confidenceView(result.analysedFraction, result.degraded, thresholds),
    yaw: yawView(orientation, room),
    alsoActive: result.active
      .filter((c) => c.id !== cue.id)
      .map((c) => ({ id: c.id, headline: c.headline, level: c.level })),
    glazingWhere: result.glazing.map((g) => g.where),
    degraded: result.degraded,
  };
}

/**
 * A finding's measured value and its threshold, in the same units, on one line.
 *
 * `VerdictFinding` carries two bare numbers and no unit, because the library
 * that produces them is comparing against pipeline constants that are already
 * in whatever unit the pipeline uses. The screen has to choose a rendering,
 * and choosing it from the CHECK NAME would mean a list of names here that
 * silently goes stale the next time capture-core adds a finding. So it is
 * chosen from the threshold, which is a property of the number itself:
 *
 *   threshold > 1      a count of something — frames, seconds, pixels, fps.
 *                      Printed as it stands.
 *   threshold <= 1     a fraction. Printed as a percentage, because every one
 *                      of these mirrors a pipeline constant an operator will
 *                      see again in the console as a percentage.
 *   threshold === 1 and both values whole
 *                      a yes/no dressed as a number — `capture.loop_closure`
 *                      is measured 0 against threshold 1. "0% against 100%" is
 *                      technically true and reads as though somebody scored
 *                      zero on something; "not done" is what it means.
 *
 * Kept in this file rather than in the verdict screen so it can be tested
 * without a DOM, which is the same reason everything else here is here.
 */
export function figureFor(finding: {
  readonly measured: number; readonly threshold: number; readonly higherIsBetter: boolean;
}): string {
  const { measured, threshold, higherIsBetter } = finding;
  if (threshold === 1 && Number.isInteger(measured) && Number.isInteger(threshold)) {
    return measured >= 1 ? 'Done' : 'Not done, and the pipeline needs it done';
  }
  const asRate = threshold <= 1;
  const fmt = (n: number): string => (asRate
    ? `${Math.round(n * 100)}%`
    : Number.isInteger(n) ? String(n) : n.toFixed(1));
  const direction = higherIsBetter ? 'at least' : 'at most';
  return `Measured ${fmt(measured)} — the pipeline wants ${direction} ${fmt(threshold)}`;
}

/**
 * Is the whole-frame cost outrunning the interval the session asked for?
 *
 * The session's own `degraded` flag is computed from `FrameAnalysis.costMs`,
 * which does not include the RGBA-to-grey conversion the worker does first
 * (see worker/analysis.worker.ts). This is the second, independent check: the
 * measured wall-clock time for a whole frame against the interval that was
 * requested. When it fires and `degraded` has not, the operator is being told
 * something true that the session cannot see.
 *
 * The ratio is 0.9 rather than 1.0 because a loop that exactly fills its
 * interval has no room for the compositor, the recorder or a repaint, and the
 * first thing to suffer is the preview the operator is walking by.
 */
export function overrunning(elapsedMsMedian: number, intervalMs: number): boolean {
  if (!(intervalMs > 0)) return false;
  return elapsedMsMedian > intervalMs * 0.9;
}
