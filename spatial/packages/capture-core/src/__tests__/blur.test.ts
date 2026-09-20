/**
 * The one property this package must get right.
 *
 * A SHARP FRAME IN A DIM ROOM MUST NOT READ AS BLURRED. Raw variance of the
 * Laplacian is the standard sharpness metric and it is useless here, because it
 * scales with scene contrast: the same wall, the same focus, the lights off,
 * scores two orders of magnitude lower. An app built on raw VoL tells an
 * operator filming an unlit hallway to slow down over and over, teaches them
 * that the guidance is noise, and then says nothing when they are actually
 * moving too fast. frames.py `contrast_normalised_sharpness` divides by the
 * intensity variance for exactly this reason, and this test is here to prove
 * the TypeScript port did the same thing and kept doing it.
 *
 * Both halves are asserted, because either alone is passable by a wrong
 * implementation. A metric that always returns 1 is perfectly contrast-
 * invariant. A metric that is raw VoL is perfectly sensitive to blur. Only the
 * pair pins down the behaviour that matters:
 *
 *   1. On the SAME sharp content, a large contrast change barely moves the
 *      normalised score, while raw VoL falls by a factor of eighty or more.
 *   2. On genuinely blurred content the normalised score still falls decisively,
 *      past the 0.55x of the local median at which `mark_blur` rejects.
 *   3. And blur is still caught in the dim room, not only the bright one —
 *      which is the case a normalisation could plausibly have broken.
 */

import { describe, expect, it } from 'vitest';
import {
  BlurJudge, RollingMedianWindow, contrastNormalisedSharpness, intensityVariance,
  laplacianVariance,
} from '../blur.js';
import { downscaleGray } from '../image.js';
import { BLUR_ABS_FLOOR, BLUR_REL_FACTOR, SCORE_LONG_EDGE, blurWindowFrames } from '../thresholds.js';
import { blockPattern, blurPattern, flat, render } from './synthetic.js';

// 320x180 is 16:9 and large enough that the variances are stable; the property
// is scale-free and a 960px fixture would only make the suite slower.
const W = 320;
const H = 180;

const SCENE = blockPattern(W, H, 4, 20260920);
const SMEARED = blurPattern(SCENE, 2);

const BRIGHT = render(SCENE, { contrast: 1 });
/**
 * A tenth of the contrast. Chosen so raw VoL falls by 1/0.1^2 = 100x, comfortably
 * past the "factor of eighty or more" a dim scene costs in practice, while the
 * swing is still about 11 levels — large enough that 8-bit quantisation is a few
 * percent of the signal rather than the signal.
 */
const DIM = render(SCENE, { contrast: 0.1 });
const BRIGHT_BLURRED = render(SMEARED, { contrast: 1 });
const DIM_BLURRED = render(SMEARED, { contrast: 0.1 });

describe('contrast normalisation', () => {
  it('holds the sharpness score steady across a tenfold contrast change', () => {
    const bright = contrastNormalisedSharpness(BRIGHT);
    const dim = contrastNormalisedSharpness(DIM);

    // Raw VoL collapses — measured at 99.96x on this fixture. The assertion is
    // deliberately on the ratio rather than on either value: it is the collapse
    // that breaks an app, not the magnitude.
    expect(bright.vol / dim.vol).toBeGreaterThan(80);

    // The normalised score does not: 2.5010 bright against 2.4980 dim, a drift
    // of 0.12%. The tolerance is set at 10% rather than 1% because it has to
    // absorb 8-bit quantisation at an 11-level swing on any future fixture, and
    // a test that fails on a rounding change teaches people to widen tolerances.
    // Two orders of magnitude of headroom is what makes this assertion mean
    // "contrast-invariant" rather than "close enough today".
    const drift = Math.abs(dim.volNorm - bright.volNorm) / bright.volNorm;
    expect(drift).toBeLessThan(0.1);
  });

  it('is the ratio of two quantities that both scale as contrast squared', () => {
    // The mechanism, asserted directly, so a future edit that replaces the
    // denominator with a standard deviation fails here with a clear reason
    // rather than three tests away with a tolerance breach.
    const volRatio = laplacianVariance(BRIGHT) / laplacianVariance(DIM);
    const varRatio = intensityVariance(BRIGHT) / intensityVariance(DIM);
    expect(volRatio / varRatio).toBeGreaterThan(0.9);
    expect(volRatio / varRatio).toBeLessThan(1.1);
  });

  it('still falls decisively on genuinely blurred content', () => {
    const sharp = contrastNormalisedSharpness(BRIGHT).volNorm;
    const blurred = contrastNormalisedSharpness(BRIGHT_BLURRED).volNorm;
    // Past the rule `mark_blur` applies, not merely lower.
    expect(blurred).toBeLessThan(BLUR_REL_FACTOR * sharp);
  });

  it('catches blur in the dim room too, which is where a normalisation could hide it', () => {
    const sharpDim = contrastNormalisedSharpness(DIM).volNorm;
    const blurredDim = contrastNormalisedSharpness(DIM_BLURRED).volNorm;
    expect(blurredDim).toBeLessThan(BLUR_REL_FACTOR * sharpDim);
  });

  it('does not call a sharp photograph of a plain wall blurred', () => {
    // The other half of the same failure: a featureless magnolia wall has very
    // little Laplacian energy AND very little intensity variance. Raw VoL calls
    // it blurred. The ratio must not, so long as there is any texture at all.
    const wall = render(blockPattern(W, H, 4, 7), { contrast: 0.04, mid: 190, amplitude: 110 });
    const score = contrastNormalisedSharpness(wall);
    expect(score.vol).toBeLessThan(contrastNormalisedSharpness(BRIGHT).vol / 100);
    expect(score.volNorm).toBeGreaterThan(BLUR_ABS_FLOOR);
  });

  it('gives a genuinely featureless frame a score of zero rather than a division blow-up', () => {
    // 1e-6 in the denominator is what keeps this finite. A NaN here would
    // propagate into the rolling median and silently disable blur rejection for
    // the rest of the capture.
    const score = contrastNormalisedSharpness(flat(W, H, 200));
    expect(Number.isFinite(score.volNorm)).toBe(true);
    expect(score.volNorm).toBe(0);
  });
});

describe('resolution dependence, and why the rate comes down instead', () => {
  it('moves the raw score materially when the image is scored at a lower resolution', () => {
    // The justification for `SCORE_LONG_EDGE` being load-bearing rather than a
    // performance knob. Halving the long edge changes the measured VoL of the
    // SAME scene, so BLUR_ABS_FLOOR — an absolute number — only means anything
    // at one resolution. An adaptive controller that dropped resolution under
    // load would silently redefine the floor; `pace.ts` drops the rate instead.
    const full = contrastNormalisedSharpness(BRIGHT).vol;
    const half = contrastNormalisedSharpness(downscaleGray(BRIGHT, Math.round(W / 2))).vol;
    // Measured at 143% on this fixture: 10,073 at 320 px against 24,450 at
    // 160 px, for the same scene at the same focus. An absolute floor written
    // for one of those numbers means nothing at the other.
    expect(Math.abs(full - half) / full).toBeGreaterThan(0.25);
  });

  it('defaults the downscale to the resolution the pipeline scores at', () => {
    const big = render(blockPattern(1920, 1080, 8, 3), { contrast: 1 });
    const scored = downscaleGray(big);
    expect(Math.max(scored.width, scored.height)).toBe(SCORE_LONG_EDGE);
  });
});

describe('RollingMedianWindow', () => {
  it('reports the median of the last N pushes and forgets older ones', () => {
    const w = new RollingMedianWindow(5);
    for (const v of [1, 2, 3, 4, 5]) w.push(v);
    expect(w.median()).toBe(3);
    for (const v of [100, 100, 100]) w.push(v);
    // 4, 5, 100, 100, 100
    expect(w.median()).toBe(100);
    expect(w.count).toBe(5);
  });

  it('averages the middle pair on an even window', () => {
    const w = new RollingMedianWindow(4);
    for (const v of [10, 20, 30, 40]) w.push(v);
    expect(w.median()).toBe(25);
  });

  it('survives repeated values, which a naive sorted-remove gets wrong', () => {
    const w = new RollingMedianWindow(3);
    w.push(5); w.push(5); w.push(5); w.push(9);
    expect(w.median()).toBe(5);
    w.push(9); w.push(9);
    expect(w.median()).toBe(9);
  });
});

describe('BlurJudge', () => {
  const windowFrames = blurWindowFrames(10);

  it('rejects a smeared frame once the window has warmed on sharp ones', () => {
    const judge = new BlurJudge(windowFrames);
    const sharp = contrastNormalisedSharpness(BRIGHT).volNorm;
    for (let i = 0; i < windowFrames; i += 1) judge.judge(sharp);
    expect(judge.warm).toBe(true);
    const v = judge.judge(contrastNormalisedSharpness(BRIGHT_BLURRED).volNorm);
    expect(v.rejected).toBe(true);
    expect(v.reason).toContain('recent median');
  });

  it('DOES NOT reject a sharp frame when the lights go off', () => {
    // The end-to-end form of the property: the judge is warmed on a brightly
    // lit room and then handed the same wall at a tenth of the contrast. A raw
    // VoL implementation rejects here, every frame, for the rest of the room.
    const judge = new BlurJudge(windowFrames);
    const sharp = contrastNormalisedSharpness(BRIGHT).volNorm;
    for (let i = 0; i < windowFrames; i += 1) judge.judge(sharp);
    const v = judge.judge(contrastNormalisedSharpness(DIM).volNorm);
    expect(v.rejected).toBe(false);
  });

  it('applies only the absolute floor before the window is warm', () => {
    const judge = new BlurJudge(40);
    expect(judge.warm).toBe(false);
    // Well below any plausible local median, but above the floor: not rejected,
    // because there is no median yet to be below.
    expect(judge.judge(0.5).rejected).toBe(false);
    expect(judge.judge(BLUR_ABS_FLOOR / 2).rejected).toBe(true);
  });

  it('folds rejected frames into the median, as mark_blur does', () => {
    // frames.py takes the rolling median over ALL candidates, not the
    // survivors. A median over survivors drifts upward during a shaky stretch
    // and stops rejecting anything, which is the stretch that needs rejecting.
    const judge = new BlurJudge(11);
    for (let i = 0; i < 11; i += 1) judge.judge(1.0);
    const before = judge.localMedian;
    for (let i = 0; i < 11; i += 1) judge.judge(0.01);
    expect(judge.localMedian).toBeLessThan(before);
  });

  it('rejects below the absolute floor whatever the neighbours look like', () => {
    const judge = new BlurJudge(11);
    for (let i = 0; i < 11; i += 1) judge.judge(BLUR_ABS_FLOOR * 1.2);
    const v = judge.judge(BLUR_ABS_FLOOR * 0.9);
    expect(v.rejected).toBe(true);
    expect(v.reason).toContain('absolute floor');
  });
});
