/**
 * One frame, measured. Three passes over half a megapixel and nothing else.
 *
 * The pass count is the design. Reading the buffer is the dominant cost at
 * this size, so the work is arranged as: Laplacian and intensity variance
 * (blur), clipping and tile luma (exposure), projections (motion). Glare
 * reuses the exposure pass's tile statistics where it can and only walks the
 * bright tiles again, because in a normally-lit room there are none.
 *
 * `costMs` is measured, not estimated, and the adaptive controller in
 * `pace.ts` uses it to decide whether the device can sustain the analysis rate
 * the guidance is written against.
 */

import type { FrameAnalysis, GrayImage } from './types.js';
import { contrastNormalisedSharpness } from './blur.js';
import { findGlare, measureExposure } from './exposure.js';
import { measureMotion, project, type Projections, type TileDisplacement } from './motion.js';
import { TILE_GRID } from './thresholds.js';

export interface AnalyseResult {
  readonly analysis: FrameAnalysis;
  /** Kept by the caller and handed back on the next frame. */
  readonly projections: Projections;
  /**
   * Per-tile displacements, for `reflective.ts`. Empty on the first frame.
   *
   * Carried out of here rather than recomputed because the projection match is
   * the expensive half of the per-frame budget, and the alternative is paying
   * for it twice on the phones that can least afford it.
   */
  readonly tiles: readonly TileDisplacement[];
}

/** Monotonic clock, injected so tests are not at the mercy of a real one. */
export type Clock = () => number;

export function analyseFrame(
  gray: GrayImage,
  previous: Projections | null,
  dtMs: number,
  tMs: number,
  clock: Clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
): AnalyseResult {
  const started = clock();

  const sharpness = contrastNormalisedSharpness(gray);
  const exposure = measureExposure(gray, TILE_GRID);
  // Only look for glare when the frame has enough clipping anywhere for a
  // single tile to possibly reach the reporting level. A tile is 1/16 of the
  // frame, so a tile at 45% clipped needs at least 2.8% of the whole frame.
  const glare = exposure.blownFraction >= 0.02 ? findGlare(gray, TILE_GRID) : [];
  const projections = project(gray, TILE_GRID);
  const { score: motion, tiles } = measureMotion(previous, projections, dtMs);

  return {
    analysis: { tMs, sharpness, exposure, glare, motion, costMs: clock() - started },
    projections,
    tiles,
  };
}
