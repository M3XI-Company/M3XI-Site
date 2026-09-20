/**
 * Motion: the rescaling, the denominator, and the band that used to be wrong.
 *
 * Three things here are worth more than the rest put together.
 *
 * THE RESCALING. `MAX_FLOW_FRACTION` bounds the displacement between two
 * consecutive PIPELINE candidates, at CANDIDATE_FPS. A live app does not sample
 * on that interval, so a measurement taken over any other interval has to be
 * converted before the comparison or the threshold means something else. At
 * 10 Hz the error is 33% in the permissive direction, which is the direction
 * that lets a capture fail.
 *
 * THE DENOMINATOR. `mark_motion` compares against `max_flow_frac * diagonal_px`.
 * Everything else in the selector is a fraction of the WIDTH. Mixing them up is
 * a 15% error on a 16:9 frame, again in a direction nobody notices until a
 * capture comes back rejected.
 *
 * THE BAND. An earlier version of `assessMotion` compared a single candidate's
 * flow against `MIN_DISPLACEMENT_FRAC` and reported 'redundant' below it. A
 * correctly paced walk produces about 0.10 of the width per candidate and
 * MIN_DISPLACEMENT_FRAC is 0.10 — of the width BETWEEN KEPT FRAMES. So the app
 * told an operator walking at exactly the right speed that they were being
 * redundant. There is a test for that case by name.
 */

import { describe, expect, it } from 'vitest';
import type { MotionScore, Orientation } from '../types.js';
import {
  FovEstimator, angleDelta, assessMotion, bestShift1d, estimateMotion, matchProjections,
  motionWouldReject, project, tileConsensus, yawRate,
} from '../motion.js';
import {
  CANDIDATE_FPS, CANDIDATE_TARGET_FRAC, FALLBACK_HFOV_RAD, MAX_FLOW_FRACTION,
  MIN_TILE_CONSENSUS, MOTION_ADVISORY_FACTOR, TARGET_DISPLACEMENT_FRAC, TARGET_FPS,
  maxFlowFracOfWidth, maxYawRateRadS, toCandidateInterval,
} from '../thresholds.js';
import { blockPattern, flat, render, shifted } from './synthetic.js';

const W = 256;
const H = 144;
const CANDIDATE_MS = 1000 / CANDIDATE_FPS;

function score(flowPx: number, dtMs = CANDIDATE_MS, consensus = 1): MotionScore {
  return { flowPx, dxPx: flowPx, dyPx: 0, tileConsensus: consensus, dtMs, first: false };
}

describe('rescaling a live measurement onto the candidate interval', () => {
  it('scales linearly with the interval ratio', () => {
    // 10 px over 100 ms is 13.33 px over the 133.3 ms the pipeline will use.
    expect(toCandidateInterval(10, 100)).toBeCloseTo(10 * (CANDIDATE_MS / 100), 10);
    expect(toCandidateInterval(10, CANDIDATE_MS)).toBeCloseTo(10, 10);
    // Sampling SLOWER than the pipeline scales the other way.
    expect(toCandidateInterval(10, 200)).toBeCloseTo(6.6667, 4);
  });

  it('returns zero rather than infinity on a zero or negative interval', () => {
    // A dropped frame or a clock that went backwards. dtMs is a divisor, and an
    // Infinity here would put the motion band permanently in 'rejected'.
    expect(toCandidateInterval(10, 0)).toBe(0);
    expect(toCandidateInterval(10, -5)).toBe(0);
  });

  it('is what stops a 10 Hz app letting a 33% overspeed through', () => {
    const width = 1920;
    const height = 1080;
    const rejectAt = maxFlowFracOfWidth(width, height) * width;
    // A displacement measured over 100 ms that sits just under the limit if you
    // forget to rescale, and over it once you do.
    const raw = rejectAt * 0.8;
    expect(raw).toBeLessThan(rejectAt);
    expect(toCandidateInterval(raw, 100)).toBeGreaterThan(rejectAt);
    expect(assessMotion(score(raw, 100), width, height).band).toBe('rejected');
  });
});

describe('the denominator mark_motion actually uses', () => {
  it('converts MAX_FLOW_FRACTION from the diagonal to the width', () => {
    // 0.16 * sqrt(1 + (9/16)^2) = 0.1835 for 16:9.
    expect(maxFlowFracOfWidth(1920, 1080)).toBeCloseTo(0.16 * Math.hypot(16, 9) / 16, 10);
    expect(maxFlowFracOfWidth(1920, 1080)).toBeCloseTo(0.18353, 4);
    // Square frames make the two nearly the same; portrait makes it much wider.
    expect(maxFlowFracOfWidth(1000, 1000)).toBeCloseTo(0.16 * Math.SQRT2, 10);
    expect(maxFlowFracOfWidth(1080, 1920)).toBeGreaterThan(maxFlowFracOfWidth(1920, 1080));
  });

  it('falls back to the bare fraction on a degenerate frame size', () => {
    expect(maxFlowFracOfWidth(0, 0)).toBe(MAX_FLOW_FRACTION);
  });

  it('rejects at exactly the diagonal fraction the pipeline rejects at', () => {
    const width = 1920;
    const height = 1080;
    const diagonal = Math.hypot(width, height);
    const justOver = MAX_FLOW_FRACTION * diagonal * 1.01;
    const justUnder = MAX_FLOW_FRACTION * diagonal * 0.99;
    expect(assessMotion(score(justOver), width, height).band).toBe('rejected');
    expect(assessMotion(score(justUnder), width, height).band).not.toBe('rejected');
    // And the report carries the diagonal fraction, so the pipeline's own
    // comparison can be read off without re-deriving an aspect ratio.
    const a = assessMotion(score(justOver), width, height);
    expect(a.candidateFracDiagonal).toBeCloseTo(MAX_FLOW_FRACTION * 1.01, 6);
  });
});

describe('the band', () => {
  const width = 1920;
  const height = 1080;
  const fracToPx = (f: number): number => f * width;

  it('calls a correctly paced walk good, not redundant', () => {
    // THE REGRESSION. CANDIDATE_TARGET_FRAC is what a walk at TARGET_FPS
    // produces per candidate: the selector's 0.30 spread over CANDIDATE_FPS /
    // TARGET_FPS = 3 candidates. It is 0.10, numerically identical to
    // MIN_DISPLACEMENT_FRAC and completely unrelated to it.
    expect(CANDIDATE_TARGET_FRAC).toBeCloseTo(TARGET_DISPLACEMENT_FRAC * (TARGET_FPS / CANDIDATE_FPS), 12);
    expect(CANDIDATE_TARGET_FRAC).toBeCloseTo(0.1, 12);
    const a = assessMotion(score(fracToPx(CANDIDATE_TARGET_FRAC)), width, height);
    expect(a.band).toBe('good');
  });

  it('has no redundant member at all, because redundancy is not a per-frame idea', () => {
    const bands = new Set<string>();
    for (let f = 0; f <= 0.4; f += 0.005) {
      bands.add(assessMotion(score(fracToPx(f)), width, height).band);
    }
    expect(bands.has('redundant')).toBe(false);
    expect(bands).toContain('still');
    expect(bands).toContain('good');
    expect(bands).toContain('brisk');
    expect(bands).toContain('fast');
    expect(bands).toContain('rejected');
  });

  it('warns at the advisory margin before the pipeline would reject', () => {
    const rejectAt = maxFlowFracOfWidth(width, height);
    const advisory = rejectAt * MOTION_ADVISORY_FACTOR;
    expect(assessMotion(score(fracToPx(advisory * 1.01)), width, height).band).toBe('fast');
    expect(assessMotion(score(fracToPx(advisory * 0.99)), width, height).band).not.toBe('fast');
  });

  it('calls incoherent motion incoherent however slow it is', () => {
    // A shake at walking pace is not a pace problem, and telling someone to
    // slow down would be advice they cannot act on.
    const a = assessMotion(
      score(fracToPx(CANDIDATE_TARGET_FRAC), CANDIDATE_MS, MIN_TILE_CONSENSUS - 0.01),
      width, height,
    );
    expect(a.band).toBe('incoherent');
    expect(a.consensusOk).toBe(false);
    expect(motionWouldReject(a)).toBe(true);
  });

  it('does not judge the first frame, which has no predecessor', () => {
    const first: MotionScore = {
      flowPx: 0, dxPx: 0, dyPx: 0, tileConsensus: 1, dtMs: CANDIDATE_MS, first: true,
    };
    // `mark_motion` skips index 0 for the same reason. 'still' would be a claim
    // about a measurement that was never made.
    expect(assessMotion(first, width, height).band).toBe('good');
  });

  it('counts only true rejections toward the frame budget', () => {
    // 'fast' is the advisory margin. Counting it as rejected would make the
    // app's predicted frame budget lower than the pipeline's, which is a
    // different lie from the usual one but still a lie.
    const fast = assessMotion(
      score(fracToPx(maxFlowFracOfWidth(width, height) * 0.8)), width, height,
    );
    expect(fast.band).toBe('fast');
    expect(motionWouldReject(fast)).toBe(false);
  });
});

describe('projection matching', () => {
  const scene = render(blockPattern(W, H, 5, 99), { contrast: 1 });

  it('recovers a known horizontal shift', () => {
    const a = project(scene);
    const b = project(shifted(scene, 7, 0));
    const m = matchProjections(a, b);
    expect(m.dx).toBe(7);
    expect(m.dy).toBe(0);
    expect(m.confidence).toBeGreaterThan(0.3);
  });

  it('recovers a known diagonal shift', () => {
    const m = matchProjections(project(scene), project(shifted(scene, -5, 4)));
    expect(m.dx).toBe(-5);
    expect(m.dy).toBe(4);
  });

  it('reports low confidence on a featureless wall rather than a confident zero', () => {
    // "I do not know" and "it did not move" are different answers and must not
    // be confused: `lk_flow` returns a neutral inlier ratio in the same case.
    const blank = project(flat(W, H, 180));
    const m = matchProjections(blank, blank);
    expect(m.confidence).toBe(0);
  });

  it('is unmoved by a change in overall brightness between frames', () => {
    // Auto-exposure ramps between rooms. An un-centred sum-of-differences would
    // chase the DC level and report a shift that never happened.
    const brighter = render(blockPattern(W, H, 5, 99), { contrast: 1, mid: 168 });
    const m = matchProjections(project(scene), project(shifted(brighter, 6, 0)));
    expect(m.dx).toBe(6);
  });

  it('measures flow between two frames and nothing on the first', () => {
    const cur = project(shifted(scene, 9, 0));
    const first = estimateMotion(null, cur, 100);
    expect(first.first).toBe(true);
    expect(first.flowPx).toBe(0);
    const m = estimateMotion(project(scene), cur, 100);
    expect(m.first).toBe(false);
    expect(m.flowPx).toBeCloseTo(9, 0);
    expect(m.tileConsensus).toBeGreaterThanOrEqual(MIN_TILE_CONSENSUS);
  });
});

describe('bestShift1d', () => {
  it('finds the alignment of two offset signals', () => {
    const n = 64;
    const a = new Float64Array(n);
    for (let i = 0; i < n; i += 1) a[i] = Math.sin(i / 3) * 100 + 500;
    const b = new Float64Array(n);
    for (let i = 0; i < n; i += 1) b[i] = a[(i - 4 + n) % n]!;
    expect(bestShift1d(a, b, 10).shift).toBe(4);
  });

  it('declines to guess on a signal too short to match', () => {
    expect(bestShift1d(new Float64Array(4), new Float64Array(4), 2)).toEqual({ shift: 0, confidence: 0 });
  });
});

describe('tileConsensus', () => {
  it('ignores tiles that had nothing to match on', () => {
    const tiles = [
      { dx: 5, dy: 0, confidence: 0.9 },
      { dx: 5, dy: 0, confidence: 0.9 },
      { dx: 5, dy: 0, confidence: 0.9 },
      { dx: 400, dy: 400, confidence: 0.01 },
    ];
    expect(tileConsensus(tiles, 960)).toBe(1);
  });

  it('reports the fraction agreeing with the frame median', () => {
    const tiles = [
      { dx: 5, dy: 0, confidence: 0.9 },
      { dx: 5, dy: 0, confidence: 0.9 },
      { dx: 5, dy: 0, confidence: 0.9 },
      { dx: 90, dy: 0, confidence: 0.9 },
    ];
    expect(tileConsensus(tiles, 960)).toBe(0.75);
  });

  it('returns full agreement when too few tiles have an opinion', () => {
    // Most of a hallway. Silence is not disagreement.
    expect(tileConsensus([{ dx: 3, dy: 0, confidence: 0.9 }], 960)).toBe(1);
  });
});

describe('orientation', () => {
  it('takes the short way round the circle', () => {
    expect(angleDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(0.2, 10);
    expect(angleDelta(Math.PI * 2 - 0.1, 0.1)).toBeCloseTo(-0.2, 10);
  });

  it('reports yaw rate in radians per second', () => {
    const a: Orientation = { yaw: 0, pitch: 0, roll: 0, absolute: true, tMs: 0 };
    const b: Orientation = { yaw: 0.5, pitch: 0, roll: 0, absolute: true, tMs: 500 };
    expect(yawRate(a, b)).toBeCloseTo(1, 10);
    expect(yawRate(a, { ...b, tMs: 0 })).toBe(0);
  });

  it('puts the yaw limit at about a four-second full turn for a phone lens', () => {
    // thresholds.ts derives 1.56 rad/s for a 16:9 frame from a 65-degree lens.
    const rate = maxYawRateRadS(FALLBACK_HFOV_RAD, 1920, 1080);
    expect(rate).toBeCloseTo(1.562, 3);
    expect((Math.PI * 2) / rate).toBeGreaterThan(4);
  });

  it('estimates the field of view from gyro against pixels', () => {
    const est = new FovEstimator();
    expect(est.estimate()).toBeNull();
    // A 1.0 rad lens: a yaw of psi shifts the image by psi / 1.0 of its width.
    for (let i = 0; i < 12; i += 1) est.add(0.1, 0.1, 1);
    expect(est.estimate()).toBeCloseTo(1.0, 6);
  });

  it('refuses samples that describe no physically possible lens', () => {
    const est = new FovEstimator();
    // 0.1 rad of yaw against 0.02 of a width is a 5 rad field of view.
    for (let i = 0; i < 20; i += 1) est.add(0.1, 0.02, 1);
    expect(est.estimate()).toBeNull();
  });

  it('refuses samples taken while the frame did not match coherently', () => {
    const est = new FovEstimator();
    for (let i = 0; i < 20; i += 1) est.add(0.1, 0.1, MIN_TILE_CONSENSUS - 0.01);
    expect(est.estimate()).toBeNull();
  });
});
