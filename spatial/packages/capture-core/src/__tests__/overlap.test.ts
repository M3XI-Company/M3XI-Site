/**
 * The overlap band, and the two arithmetic traps around it.
 *
 * `select_by_overlap` decides how many frames a capture contributes, so if this
 * model is wrong the app's frame budget is wrong and every downstream
 * prediction inherits the error. The centrepiece here is `walkLikePython`: a
 * direct transcription of the Python loop, run against the same inputs as
 * `OverlapTracker`, asserting the two agree frame for frame. A test that
 * asserted the tracker against my own idea of what the selector does would only
 * prove I had one idea twice.
 *
 * The second trap is sampling rate. An accumulated path length does not depend
 * on how often it was sampled, so the tracker's totals must be identical at
 * 7.5 Hz and at 10 Hz for the same walk — and they are only identical if the
 * caller feeds RAW displacement. Feeding `toCandidateInterval`'s output inflates
 * the total by exactly the rate ratio, which is a room reported as covered when
 * a quarter of it was never walked. That is asserted explicitly, with the wrong
 * arithmetic spelled out beside the right one, because the wrong version is the
 * one a reasonable person writes.
 */

import { describe, expect, it } from 'vitest';
import {
  OverlapTracker, overlapBandOf, overlapFromSeparation, predictSelectedFrames,
} from '../overlap.js';
import {
  ABSOLUTE_MIN_FRAMES, CANDIDATE_FPS, MAX_DISPLACEMENT_FRAC, MAX_FRAMES,
  MIN_DISPLACEMENT_FRAC, MIN_FRAMES, TARGET_DISPLACEMENT_FRAC, toCandidateInterval,
} from '../thresholds.js';
import { lcg } from './synthetic.js';

const WIDTH = 960;

/**
 * `select_by_overlap`'s inner `walk()`, transcribed.
 *
 * Only the forward pass at the nominal target: the back-off re-walks the whole
 * sequence and is modelled by `predictSelectedFrames`, not by the tracker.
 * Working in fractions of width rather than pixels because that is what the
 * tracker reports; the Python works in pixels and divides at the boundary, and
 * the two are the same arithmetic.
 */
function walkLikePython(
  flows: readonly number[], rejected: readonly boolean[],
): { kept: number[]; redundant: number } {
  const kept: number[] = [];
  let redundant = 0;
  let accum = 0;
  for (let i = 0; i < flows.length; i += 1) {
    accum += Math.max(0, flows[i]!);
    if (rejected[i]) continue;
    if (kept.length === 0) { kept.push(i); accum = 0; continue; }
    if (accum < MIN_DISPLACEMENT_FRAC) { redundant += 1; continue; }
    if (accum >= TARGET_DISPLACEMENT_FRAC) { kept.push(i); accum = 0; }
  }
  return { kept, redundant };
}

function runTracker(
  flowsFrac: readonly number[], rejected: readonly boolean[],
): { kept: number[]; redundant: number; total: number } {
  const t = new OverlapTracker();
  const kept: number[] = [];
  let redundant = 0;
  for (let i = 0; i < flowsFrac.length; i += 1) {
    const s = t.observe({
      flowPx: flowsFrac[i]! * WIDTH, dtMs: 1000 / CANDIDATE_FPS,
      widthPx: WIDTH, accepted: !rejected[i],
    });
    if (s.keptThisFrame) kept.push(i);
    redundant = s.redundant;
  }
  return { kept, redundant, total: t.totalWidths };
}

describe('the band', () => {
  it('names each region of the pipeline\'s own numbers', () => {
    expect(overlapBandOf(0.05)).toBe('redundant');
    expect(overlapBandOf(MIN_DISPLACEMENT_FRAC)).toBe('tight');
    expect(overlapBandOf(0.2)).toBe('tight');
    expect(overlapBandOf(TARGET_DISPLACEMENT_FRAC)).toBe('good');
    expect(overlapBandOf(0.45)).toBe('good');
    expect(overlapBandOf(MAX_DISPLACEMENT_FRAC)).toBe('fracture');
    expect(overlapBandOf(0.9)).toBe('fracture');
  });

  it('puts the selector\'s target at roughly the 70% overlap frames.py quotes', () => {
    // frames.py: "~0.30 of the width corresponds to roughly 70% overlap ...
    // which is the middle of the band LightGlue likes".
    expect(overlapFromSeparation(TARGET_DISPLACEMENT_FRAC)).toBeCloseTo(0.7, 10);
    expect(overlapFromSeparation(MAX_DISPLACEMENT_FRAC)).toBeCloseTo(0.45, 10);
    expect(overlapFromSeparation(2)).toBe(0);
  });
});

describe('OverlapTracker against a transcription of select_by_overlap', () => {
  it('keeps exactly the same frames on a steady walk', () => {
    const flows = Array.from({ length: 300 }, () => 0.10);
    const rejected = flows.map(() => false);
    const py = walkLikePython(flows, rejected);
    const ts = runTracker(flows, rejected);
    expect(ts.kept).toEqual(py.kept);
    expect(ts.redundant).toBe(py.redundant);
  });

  it('keeps exactly the same frames on a ragged one with rejections', () => {
    const rnd = lcg(4242);
    const flows: number[] = [];
    const rejected: boolean[] = [];
    for (let i = 0; i < 600; i += 1) {
      // A walk that stops, ambles and hurries, with a burst of blur in the
      // middle: the shape of a real property walkthrough rather than a ramp.
      const phase = Math.floor(i / 120) % 3;
      const base = phase === 0 ? 0.02 : phase === 1 ? 0.10 : 0.22;
      flows.push(base * (0.6 + rnd() * 0.8));
      rejected.push(i >= 250 && i < 275 ? true : rnd() < 0.12);
    }
    const py = walkLikePython(flows, rejected);
    const ts = runTracker(flows, rejected);
    expect(ts.kept).toEqual(py.kept);
    expect(ts.redundant).toBe(py.redundant);
    expect(ts.kept.length).toBeGreaterThan(20);
  });

  it('keeps the first survivor unconditionally, as walk() does', () => {
    const t = new OverlapTracker();
    // Three rejected frames, then one good one with almost no travel behind it.
    for (let i = 0; i < 3; i += 1) {
      t.observe({ flowPx: 1, dtMs: 133, widthPx: WIDTH, accepted: false });
    }
    const s = t.observe({ flowPx: 1, dtMs: 133, widthPx: WIDTH, accepted: true });
    expect(s.keptThisFrame).toBe(true);
    expect(s.kept).toBe(1);
  });

  it('counts a rejected frame\'s travel toward the next keeper\'s spacing', () => {
    // The pipeline accumulates before it skips, so spacing is measured along
    // the camera path and not along the surviving frames. Without this, a
    // rejected stretch would make the next keeper arrive far too late.
    const flows = [0.05, 0.15, 0.15, 0.05];
    const rejectedMiddle = [false, true, true, false];
    const ts = runTracker(flows, rejectedMiddle);
    // 0.15 + 0.15 + 0.05 = 0.35 >= target by the fourth frame, so it is kept.
    expect(ts.kept).toEqual([0, 3]);
  });

  it('does not reset the accumulation when it skips a redundant candidate', () => {
    const flows = Array.from({ length: 10 }, () => 0.04);
    const ts = runTracker(flows, flows.map(() => false));
    // Frame 0 is kept and resets the accumulation. Frames 1 and 2 sit under the
    // 0.10 redundancy floor and are counted redundant; frames 3 to 7 are past
    // the floor but short of the target, so they are simply passed over and the
    // sum keeps growing; frame 8 reaches 0.32 and is kept. Frame 9 then starts
    // the cycle again and is redundant, which is the third.
    expect(ts.kept[0]).toBe(0);
    expect(ts.kept[1]).toBe(8);
    expect(ts.redundant).toBe(3);
  });
});

describe('the rescaling trap', () => {
  const walkFor = (hz: number, seconds: number, metresPerSecondInWidths: number): number => {
    const t = new OverlapTracker();
    const frames = Math.round(hz * seconds);
    const perFrame = metresPerSecondInWidths / hz;
    for (let i = 0; i < frames; i += 1) {
      t.observe({ flowPx: perFrame * WIDTH, dtMs: 1000 / hz, widthPx: WIDTH, accepted: true });
    }
    return t.totalWidths;
  };

  it('accumulates the same total travel whatever rate the app samples at', () => {
    // The same 60-second walk at 0.75 image widths per second, analysed at the
    // pipeline's own candidate rate and at the app's faster one.
    const atCandidateRate = walkFor(CANDIDATE_FPS, 60, 0.75);
    const atAnalysisRate = walkFor(10, 60, 0.75);
    expect(atAnalysisRate).toBeCloseTo(atCandidateRate, 6);
    expect(atCandidateRate).toBeCloseTo(45, 6);
  });

  it('shows what rescaling before accumulating would have cost', () => {
    // The wrong arithmetic, written out: apply toCandidateInterval to each
    // 10 Hz sample and then sum. It inflates by exactly 10 / 7.5.
    const hz = 10;
    const seconds = 60;
    const perFrameWidths = 0.75 / hz;
    let wrong = 0;
    for (let i = 0; i < hz * seconds; i += 1) {
      wrong += toCandidateInterval(perFrameWidths * WIDTH, 1000 / hz) / WIDTH;
    }
    const right = walkFor(hz, seconds, 0.75);
    expect(wrong / right).toBeCloseTo(hz / CANDIDATE_FPS, 6);
    // Which in operator terms is this: a room needing 10 widths of travel would
    // be reported complete after 7.5 of them.
    expect(right / wrong).toBeCloseTo(0.75, 6);
  });
});

describe('the fracture bound, which the pipeline declares and never enforces', () => {
  it('opens a gap when every candidate across a stretch is rejected', () => {
    const t = new OverlapTracker();
    t.observe({ flowPx: 0.1 * WIDTH, dtMs: 133, widthPx: WIDTH, accepted: true });
    let last = t.observe({ flowPx: 0, dtMs: 133, widthPx: WIDTH, accepted: false });
    expect(last.gapOpen).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      last = t.observe({ flowPx: 0.1 * WIDTH, dtMs: 133, widthPx: WIDTH, accepted: false });
    }
    expect(last.pendingWidths).toBeGreaterThan(MAX_DISPLACEMENT_FRAC);
    expect(last.gapOpen).toBe(true);
    expect(last.band).toBe('fracture');
  });

  it('closes the gap as soon as a frame is kept again', () => {
    const t = new OverlapTracker();
    t.observe({ flowPx: 0.1 * WIDTH, dtMs: 133, widthPx: WIDTH, accepted: true });
    for (let i = 0; i < 10; i += 1) {
      t.observe({ flowPx: 0.1 * WIDTH, dtMs: 133, widthPx: WIDTH, accepted: false });
    }
    const s = t.observe({ flowPx: 0.01 * WIDTH, dtMs: 133, widthPx: WIDTH, accepted: true });
    expect(s.keptThisFrame).toBe(true);
    expect(s.gapOpen).toBe(false);
    // And the separation it records is the real one, over a metre of wall with
    // nothing usable in between. That is what the verdict needs to see.
    expect(s.lastSeparationWidths).toBeGreaterThan(MAX_DISPLACEMENT_FRAC);
  });

  it('never opens a gap before the first keeper', () => {
    // Before anything has been kept there is no chain to break: this is the
    // operator walking from the car to the front door with the camera running.
    const t = new OverlapTracker();
    let s = t.observe({ flowPx: 0, dtMs: 133, widthPx: WIDTH, accepted: false });
    for (let i = 0; i < 20; i += 1) {
      s = t.observe({ flowPx: 0.2 * WIDTH, dtMs: 133, widthPx: WIDTH, accepted: false });
    }
    expect(s.gapOpen).toBe(false);
  });
});

describe('predictSelectedFrames', () => {
  it('buys one frame per target displacement when candidates are plentiful', () => {
    // 300 widths of travel at 0.30 a frame is 1000 frames, capped at MAX_FRAMES.
    expect(predictSelectedFrames(300, 10000)).toBe(MAX_FRAMES);
    // 90 widths is 300 frames, which is over MIN_FRAMES so no back-off runs.
    expect(predictSelectedFrames(90, 10000)).toBe(300);
  });

  it('backs the spacing off toward the redundancy floor when short of MIN_FRAMES', () => {
    // 30 widths at the target is 100 frames, under MIN_FRAMES. The Python
    // halves: 0.15 gives 200, which reaches MIN_FRAMES and stops there.
    expect(predictSelectedFrames(30, 10000)).toBe(200);
  });

  it('stops backing off at the redundancy floor rather than padding the set', () => {
    // 5 widths cannot reach MIN_FRAMES at any spacing the pipeline allows.
    // 0.30 -> 0.15 -> 0.075 clamps to 0.10, giving 50. It does not invent more.
    const n = predictSelectedFrames(5, 10000);
    expect(n).toBe(50);
    expect(n).toBeLessThan(ABSOLUTE_MIN_FRAMES);
  });

  it('is bounded by the candidates that survived, not only by travel', () => {
    // Walking twice as far does not replace frames that were thrown away,
    // because the new ones are thrown away at the same rate.
    expect(predictSelectedFrames(300, 40)).toBe(40);
  });

  it('treats nonsense input as no travel rather than propagating a NaN', () => {
    expect(predictSelectedFrames(Number.NaN, 1000)).toBe(0);
    expect(predictSelectedFrames(-5, 1000)).toBe(0);
    expect(predictSelectedFrames(10, -3)).toBe(0);
  });

  it('agrees with the live tracker on an evenly paced walk', () => {
    // The closed form is an upper bound in general and exact when travel is
    // even, so an even walk is where the two must meet. They meet to within one
    // frame and not exactly: summing 0.10 nine hundred times in binary floating
    // point gives 89.99999999999859, so floor(total / 0.30) lands on 299 where
    // the tracker's own comparison-by-comparison walk keeps 300. One frame in
    // three hundred is not worth chasing with an epsilon — an epsilon would only
    // move the disagreement somewhere less visible — so the tolerance is stated.
    const flows = Array.from({ length: 900 }, () => 0.10);
    const ts = runTracker(flows, flows.map(() => false));
    expect(Math.abs(predictSelectedFrames(ts.total, 900) - ts.kept.length)).toBeLessThanOrEqual(1);
    expect(ts.kept.length).toBe(300);
    expect(ts.kept.length).toBeGreaterThanOrEqual(MIN_FRAMES);
  });
});
