/**
 * The per-frame path: pixels in, judgements out, and the controller that keeps
 * the whole thing honest about what it is managing to do.
 *
 * The decision under test at the end of this file is the one the brief is
 * emphatic about. On a mid-range phone, 50 to 90 ms per analysed frame is
 * normal, and at some point that is too slow. There are two ways to buy the
 * time back and only one of them is allowed:
 *
 *   LOWER THE RESOLUTION — forbidden. Variance of the Laplacian is
 *   resolution-dependent, so scoring at 640 px instead of 960 px silently
 *   changes what BLUR_ABS_FLOOR means and the app starts measuring a quantity
 *   the pipeline has never heard of. Nothing on screen would look different.
 *
 *   LOWER THE RATE — allowed, down to CANDIDATE_FPS, below which the app is no
 *   longer seeing every frame the pipeline will see. At that point the guidance
 *   stops being a faithful preview and the app says so, in as many words.
 *
 * The downscale tests are the first half of that argument: `downscaleGray` must
 * box-filter, because point sampling manufactures high-frequency detail that
 * variance of the Laplacian reads as sharpness — a blurred frame downsampled by
 * nearest-neighbour can outscore a sharp one downsampled properly, inverting
 * the one measurement this package exists to make.
 */

import { describe, expect, it } from 'vitest';
import { clamp, downscaleGray, median, tileBounds, toGray } from '../image.js';
import { analyseFrame } from '../frame.js';
import { PaceController } from '../pace.js';
import { contrastNormalisedSharpness } from '../blur.js';
import {
  ANALYSIS_BUDGET_MS, ANALYSIS_HZ, ANALYSIS_HZ_FLOOR, CANDIDATE_FPS, SATURATION_LEVEL,
  SCORE_LONG_EDGE, TILE_GRID,
} from '../thresholds.js';
import { blockPattern, blurPattern, flat, paintRect, render, shifted } from './synthetic.js';

const W = 160;
const H = 90;

describe('luma', () => {
  it('uses Rec.709 weights rather than a channel mean', () => {
    // A plain mean lets a saturated red wall dominate; the ISP and the eye both
    // weight green, and bilagrid.py picks its guide channel the same way.
    const px = (r: number, g: number, b: number) => {
      const data = new Uint8ClampedArray([r, g, b, 255]);
      return toGray({ data, width: 1, height: 1 }).data[0];
    };
    // 0.2126, 0.7152 and 0.0722 of 255, in 16-bit fixed point: 54, 182, 18.
    expect(px(255, 0, 0)).toBe(54);
    expect(px(0, 255, 0)).toBe(182);
    expect(px(0, 0, 255)).toBe(18);
    // And they sum to white exactly, which is what says the weights are a
    // partition rather than three roughly-right numbers.
    expect(px(255, 255, 255)).toBe(255);
    expect(px(0, 0, 0)).toBe(0);
  });
});

describe('downscaleGray', () => {
  it('box-filters rather than point-samples', () => {
    // A 2x2 of 0, 100, 200, 255 averages to 139, not to whichever corner a
    // nearest-neighbour happened to land on.
    const data = new Uint8ClampedArray([0, 100, 200, 255]);
    const out = downscaleGray({ data, width: 2, height: 2 }, 1);
    expect(out.width).toBe(1);
    expect(out.data[0]).toBe(139);
  });

  it('does not let a blurred frame outscore a sharp one after downscaling', () => {
    // THE reason the filter matters. Aliasing manufactures high-frequency
    // detail that VoL reads as sharpness.
    const scene = blockPattern(640, 360, 3, 11);
    const sharp = downscaleGray(render(scene, { contrast: 1 }), 160);
    const smeared = downscaleGray(render(blurPattern(scene, 3), { contrast: 1 }), 160);
    expect(contrastNormalisedSharpness(smeared).volNorm)
      .toBeLessThan(contrastNormalisedSharpness(sharp).volNorm);
  });

  it('leaves an image that is already small enough alone', () => {
    const img = flat(W, H, 100);
    expect(downscaleGray(img, 1000)).toBe(img);
  });

  it('preserves the aspect ratio and hits the requested long edge', () => {
    const out = downscaleGray(flat(1920, 1080, 50), SCORE_LONG_EDGE);
    expect(out.width).toBe(SCORE_LONG_EDGE);
    expect(out.height).toBe(540);
  });
});

describe('tileBounds', () => {
  it('covers the image exactly, with no gap and no overlap', () => {
    const covered = new Set<number>();
    for (let t = 0; t < TILE_GRID * TILE_GRID; t += 1) {
      const b = tileBounds(W, H, t, TILE_GRID);
      for (let y = b.y0; y < b.y1; y += 1) {
        for (let x = b.x0; x < b.x1; x += 1) {
          const key = y * W + x;
          expect(covered.has(key)).toBe(false);
          covered.add(key);
        }
      }
    }
    expect(covered.size).toBe(W * H);
  });
});

describe('median and clamp', () => {
  it('does not disturb the caller\'s array', () => {
    const a = [5, 1, 3];
    expect(median(a)).toBe(3);
    expect(a).toEqual([5, 1, 3]);
  });

  it('averages the middle pair and answers zero for nothing', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('clamps at both ends', () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe('analyseFrame', () => {
  const scene = render(blockPattern(W, H, 4, 5), { contrast: 1 });

  it('produces every measurement from one frame and carries the projections forward', () => {
    let t = 0;
    const clock = () => (t += 7);
    const first = analyseFrame(scene, null, 100, 0, clock);
    expect(first.analysis.motion.first).toBe(true);
    expect(first.analysis.sharpness.volNorm).toBeGreaterThan(0);
    expect(first.analysis.exposure.tileLuma).toHaveLength(TILE_GRID * TILE_GRID);
    expect(first.analysis.costMs).toBeGreaterThan(0);

    const second = analyseFrame(shifted(scene, 6, 0), first.projections, 100, 100, clock);
    expect(second.analysis.motion.first).toBe(false);
    expect(second.analysis.motion.dxPx).toBe(6);
    expect(second.analysis.tMs).toBe(100);
  });

  it('skips the glare pass on a frame with no clipping anywhere', () => {
    // A tile is 1/16 of the frame, so a tile at the reporting level needs about
    // 2.8% of the whole frame. In a normally lit room there is nothing to find
    // and walking the bright tiles again would be pure cost.
    const out = analyseFrame(scene, null, 100, 0, () => 0);
    expect(out.analysis.exposure.blownFraction).toBe(0);
    expect(out.analysis.glare).toEqual([]);
  });

  it('runs the glare pass once there is enough clipping for a tile to qualify', () => {
    const withWindow = paintRect(scene, 0, 0, W / TILE_GRID, H / TILE_GRID, SATURATION_LEVEL + 2);
    const out = analyseFrame(withWindow, null, 100, 0, () => 0);
    expect(out.analysis.glare.length).toBeGreaterThan(0);
  });
});

describe('PaceController', () => {
  const feed = (p: PaceController, costMs: number, n: number, startMs = 0, stepMs = 100) => {
    for (let i = 0; i < n; i += 1) p.observe(costMs, startMs + i * stepMs);
  };

  it('starts at the derived analysis rate', () => {
    const p = new PaceController();
    expect(p.state().hz).toBe(ANALYSIS_HZ);
    expect(p.intervalMs()).toBeCloseTo(1000 / ANALYSIS_HZ, 10);
    expect(p.state().degraded).toBe(false);
  });

  it('will not change the rate on fewer than ten measurements', () => {
    // A single garbage-collection pause is not a reason to halve the rate.
    const p = new PaceController();
    feed(p, 200, 9, 10_000);
    expect(p.state().hz).toBe(ANALYSIS_HZ);
  });

  it('lowers the rate when the median cost is over budget', () => {
    const p = new PaceController();
    feed(p, ANALYSIS_BUDGET_MS + 20, 12, 10_000);
    expect(p.state().hz).toBeLessThan(ANALYSIS_HZ);
  });

  it('never lowers the rate below the candidate rate', () => {
    // Below CANDIDATE_FPS the app is no longer seeing every frame the pipeline
    // will see, so the answer is to say so rather than to keep slowing down.
    const p = new PaceController();
    for (let round = 0; round < 10; round += 1) {
      feed(p, 500, 12, 10_000 + round * 5_000);
    }
    expect(p.state().hz).toBe(ANALYSIS_HZ_FLOOR);
    expect(ANALYSIS_HZ_FLOOR).toBe(CANDIDATE_FPS);
  });

  it('never raises the rate above the one the guidance is written against', () => {
    const p = new PaceController();
    for (let round = 0; round < 10; round += 1) feed(p, 1, 12, 10_000 + round * 5_000);
    expect(p.state().hz).toBe(ANALYSIS_HZ);
  });

  it('rate-limits changes, because a jittering period corrupts the motion dt', () => {
    // dt is a divisor in toCandidateInterval, so an analyser whose period
    // oscillates makes every motion measurement noisier than the motion.
    const p = new PaceController();
    feed(p, 200, 12, 10_000);
    const after = p.state().hz;
    feed(p, 200, 12, 10_100);
    expect(p.state().hz).toBe(after);
  });

  it('recovers when the device catches up', () => {
    const p = new PaceController();
    feed(p, 200, 12, 10_000);
    const slowed = p.state().hz;
    feed(p, 5, 12, 20_000);
    expect(p.state().hz).toBeGreaterThan(slowed);
  });

  it('reports degraded exactly when it is below the candidate rate', () => {
    const p = new PaceController();
    for (let round = 0; round < 10; round += 1) {
      feed(p, 500, 12, 10_000 + round * 5_000);
    }
    expect(p.state().hz).toBe(ANALYSIS_HZ_FLOOR);
    // At the floor it is still keeping up with every pipeline candidate, so it
    // is not degraded; it is degraded only below that, which the controller
    // will not do — `cannotKeepUp` is how a device that cannot hold even the
    // floor is reported.
    expect(p.state().degraded).toBe(false);
    expect(p.cannotKeepUp()).toBe(true);
  });

  it('does not claim it cannot keep up before it has measured anything', () => {
    expect(new PaceController().cannotKeepUp()).toBe(false);
  });

  it('holds a comfortable device at the full rate and says it is keeping up', () => {
    const p = new PaceController();
    feed(p, 20, 15, 10_000);
    expect(p.state().hz).toBe(ANALYSIS_HZ);
    expect(p.state().medianCostMs).toBe(20);
    expect(p.cannotKeepUp()).toBe(false);
  });
});
