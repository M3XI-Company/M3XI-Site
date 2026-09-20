/**
 * Motion: how far the view moved, and whether it moved as one piece.
 *
 * frames.py measures this with Shi-Tomasi corners, pyramidal Lucas-Kanade and
 * a RANSAC homography. None of that fits in a 33 ms budget on a mid-range
 * phone in JavaScript, so this file measures the same two quantities a
 * different way and is explicit about the difference:
 *
 *   displacement   1-D projection matching. Summing an image along each axis
 *                  collapses it to two signals of a few hundred samples, and
 *                  the shift that aligns two such signals is the global
 *                  translation. It costs one pass over the image plus a
 *                  1-D search, rather than a feature detector and a tracker.
 *                  For a camera that is walking or panning — which is every
 *                  frame of a property walkthrough — it recovers the same
 *                  displacement LK does, and that displacement is what both
 *                  MAX_FLOW_FRACTION and the overlap band are written against.
 *
 *   coherence      per-tile displacement, then the fraction of tiles agreeing
 *                  with the frame median. frames.py asks what fraction of
 *                  tracks fit one HOMOGRAPHY; this asks what fraction of tiles
 *                  fit one TRANSLATION, which is strictly harder to satisfy.
 *                  Real perspective change — walking through a doorway — breaks
 *                  a translation fit that a homography would absorb, so the cue
 *                  built on it requires persistence before it fires.
 *
 * What this cannot do, and a native app could: rolling-shutter row timing.
 * frames.py catches jelly through the homography residual; a translation
 * consensus sees jelly as a smooth vertical gradient of horizontal shift,
 * which it partly catches through tile disagreement and partly does not.
 */

import type { GrayImage, MotionScore, Orientation } from './types.js';
import { clamp, median, tileBounds } from './image.js';
import {
  CANDIDATE_TARGET_FRAC, MIN_TILE_CONSENSUS, MOTION_ADVISORY_FACTOR, OVERLAP_FRACTURE_ABOVE,
  TILE_AGREEMENT_FRAC, TILE_GRID, maxFlowFracOfWidth, toCandidateInterval,
} from './thresholds.js';

/** Axis projections of every tile, and of the whole frame, in one pass. */
export interface Projections {
  readonly grid: number;
  readonly width: number;
  readonly height: number;
  /** Per tile, column sums over that tile's rows. */
  readonly tileX: readonly Float64Array[];
  /** Per tile, row sums over that tile's columns. */
  readonly tileY: readonly Float64Array[];
  readonly frameX: Float64Array;
  readonly frameY: Float64Array;
}

/**
 * Accumulate every projection the matcher needs in a single pass.
 *
 * One pass and not seventeen: the image is half a megapixel and the memory
 * bandwidth of reading it is the dominant cost, so reading it once and
 * scattering into small accumulators is far cheaper than reading it per tile.
 */
export function project(img: GrayImage, grid = TILE_GRID): Projections {
  const { data, width, height } = img;
  const cells = grid * grid;
  const tileX: Float64Array[] = [];
  const tileY: Float64Array[] = [];
  const x0 = new Int32Array(grid);
  const y0 = new Int32Array(grid);
  for (let c = 0; c < grid; c += 1) x0[c] = tileBounds(width, height, c, grid).x0;
  for (let r = 0; r < grid; r += 1) y0[r] = tileBounds(width, height, r * grid, grid).y0;
  for (let t = 0; t < cells; t += 1) {
    const b = tileBounds(width, height, t, grid);
    tileX.push(new Float64Array(Math.max(1, b.x1 - b.x0)));
    tileY.push(new Float64Array(Math.max(1, b.y1 - b.y0)));
  }
  const frameX = new Float64Array(width);
  const frameY = new Float64Array(height);

  // Column and row to tile index, precomputed: the inner loop runs half a
  // million times per frame, ten times a second, and a division in it is the
  // difference between comfortably inside the budget and outside it.
  const colTile = new Int32Array(width);
  const colOffset = new Int32Array(width);
  for (let x = 0; x < width; x += 1) {
    const c = Math.min(grid - 1, Math.floor((x * grid) / width));
    colTile[x] = c;
    colOffset[x] = x - x0[c]!;
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const tr = Math.min(grid - 1, Math.floor((y * grid) / height));
    const tileBase = tr * grid;
    const yOff = y - y0[tr]!;
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      const v = data[row + x]!;
      rowSum += v;
      // Read-add-write rather than `+=`. Under noUncheckedIndexedAccess a typed
      // array element is `number | undefined`, and a non-null assertion cannot
      // sit on the left of a compound assignment, so `frameX[x] += v` does not
      // type-check. The arithmetic is unchanged.
      frameX[x] = frameX[x]! + v;
      const t = tileBase + colTile[x]!;
      // The tile row and the column offset are named once rather than asserted
      // twice each. This loop runs half a million times per frame, ten times a
      // second, so a form that indexes `tileX[t]` once and reads better is the
      // right one on both counts.
      const tx = tileX[t]!;
      const ty = tileY[t]!;
      const ox = colOffset[x]!;
      tx[ox] = tx[ox]! + v;
      ty[yOff] = ty[yOff]! + v;
    }
    frameY[y] = rowSum;
  }
  return { grid, width, height, tileX, tileY, frameX, frameY };
}

export interface Shift1d {
  readonly shift: number;
  /** 0-1. How much better the best alignment is than a typical one. */
  readonly confidence: number;
}

/**
 * Shift that best aligns two 1-D signals, by mean-removed sum of absolute
 * differences.
 *
 * Mean-removed because auto-exposure changes the DC level between frames and
 * an un-centred SAD would then prefer whichever shift happened to line up the
 * brightest region. Absolute differences rather than squared because a single
 * blown window dominates a squared cost and drags the estimate toward it.
 *
 * Confidence is the best cost relative to the median cost across all shifts: a
 * genuine alignment is far better than a typical misalignment, while a
 * featureless white wall produces a flat cost curve and a confidence near
 * zero. That is the signal that says "I do not know", which is different from
 * "it did not move" and must not be confused with it.
 */
export function bestShift1d(a: Float64Array, b: Float64Array, maxShift: number): Shift1d {
  const n = Math.min(a.length, b.length);
  if (n < 8) return { shift: 0, confidence: 0 };
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) { meanA += a[i]!; meanB += b[i]!; }
  meanA /= n;
  meanB /= n;

  const limit = Math.max(1, Math.min(Math.floor(maxShift), Math.floor(n / 2) - 1));
  const minOverlap = Math.max(8, Math.floor(n / 2));
  let best = Infinity;
  let bestShift = 0;
  const costs: number[] = [];
  for (let s = -limit; s <= limit; s += 1) {
    const lo = Math.max(0, -s);
    const hi = Math.min(n, n - s);
    const count = hi - lo;
    if (count < minOverlap) continue;
    let cost = 0;
    for (let i = lo; i < hi; i += 1) {
      const d = (a[i]! - meanA) - (b[i + s]! - meanB);
      cost += d < 0 ? -d : d;
    }
    cost /= count;
    costs.push(cost);
    if (cost < best) { best = cost; bestShift = s; }
  }
  if (costs.length === 0) return { shift: 0, confidence: 0 };
  const typical = median(costs);
  const confidence = typical > 0 ? clamp(1 - best / typical, 0, 1) : 0;
  return { shift: bestShift, confidence };
}

export interface TileDisplacement {
  readonly dx: number;
  readonly dy: number;
  readonly confidence: number;
}

/**
 * Global displacement first, then each tile refined in a small window around
 * it.
 *
 * Two stages rather than one wide per-tile search for two reasons. A tile is a
 * quarter of the frame wide, so a displacement approaching the rejection
 * threshold leaves too little overlap inside one tile to match reliably. And
 * the wide search only has to be run once instead of sixteen times, which is
 * most of the saving.
 */
export function matchProjections(
  prev: Projections, cur: Projections,
): { dx: number; dy: number; confidence: number; tiles: TileDisplacement[] } {
  const w = cur.width;
  // Search wide enough to see a displacement well past the point at which the
  // pose graph fractures (OVERLAP_FRACTURE_ABOVE of the width); beyond that the
  // exact number does not matter, only that it is far too big.
  const globalMaxX = Math.max(4, Math.round(OVERLAP_FRACTURE_ABOVE * w * 0.8));
  const globalMaxY = Math.max(4, Math.round(OVERLAP_FRACTURE_ABOVE * w * 0.8));
  const gx = bestShift1d(prev.frameX, cur.frameX, globalMaxX);
  const gy = bestShift1d(prev.frameY, cur.frameY, globalMaxY);

  // Refinement window: TILE_AGREEMENT_FRAC is the tolerance a tile is judged
  // by, so searching twice that around the global estimate is enough to place
  // a tile on either side of the agreement boundary and no more.
  const refine = Math.max(2, Math.round(TILE_AGREEMENT_FRAC * w * 2));
  const tiles: TileDisplacement[] = [];
  for (let t = 0; t < prev.tileX.length; t += 1) {
    const tx = bestShiftAround(prev.tileX[t]!, cur.tileX[t]!, gx.shift, refine);
    const ty = bestShiftAround(prev.tileY[t]!, cur.tileY[t]!, gy.shift, refine);
    tiles.push({
      dx: tx.shift, dy: ty.shift,
      confidence: Math.min(tx.confidence, ty.confidence),
    });
  }
  return { dx: gx.shift, dy: gy.shift, confidence: Math.min(gx.confidence, gy.confidence), tiles };
}

function bestShiftAround(a: Float64Array, b: Float64Array, centre: number, radius: number): Shift1d {
  const n = Math.min(a.length, b.length);
  if (n < 8) return { shift: centre, confidence: 0 };
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) { meanA += a[i]!; meanB += b[i]!; }
  meanA /= n;
  meanB /= n;
  const minOverlap = Math.max(6, Math.floor(n / 3));
  let best = Infinity;
  let bestShift = centre;
  const costs: number[] = [];
  for (let s = centre - radius; s <= centre + radius; s += 1) {
    const lo = Math.max(0, -s);
    const hi = Math.min(n, n - s);
    const count = hi - lo;
    if (count < minOverlap) continue;
    let cost = 0;
    for (let i = lo; i < hi; i += 1) {
      const d = (a[i]! - meanA) - (b[i + s]! - meanB);
      cost += d < 0 ? -d : d;
    }
    cost /= count;
    costs.push(cost);
    if (cost < best) { best = cost; bestShift = s; }
  }
  if (costs.length === 0) return { shift: centre, confidence: 0 };
  const typical = median(costs);
  return { shift: bestShift, confidence: typical > 0 ? clamp(1 - best / typical, 0, 1) : 0 };
}

/**
 * Fraction of tiles whose displacement agrees with the frame median.
 *
 * Tiles whose own match was not confident are EXCLUDED rather than counted as
 * disagreeing. A blank wall filling one corner has no information about
 * motion, and calling that incoherence would fire the cue at someone standing
 * correctly in front of a plain wall — which is most of a hallway.
 * frames.py takes the same position: `lk_flow` returns a neutral inlier ratio
 * rather than zero when it cannot find features.
 */
export function tileConsensus(tiles: readonly TileDisplacement[], widthPx: number): number {
  const usable = tiles.filter((t) => t.confidence > 0.15);
  if (usable.length < 3) return 1;
  const mx = median(usable.map((t) => t.dx));
  const my = median(usable.map((t) => t.dy));
  const tol = Math.max(2, TILE_AGREEMENT_FRAC * widthPx);
  const agree = usable.filter((t) => Math.hypot(t.dx - mx, t.dy - my) <= tol).length;
  return agree / usable.length;
}

export interface MotionMeasurement {
  readonly score: MotionScore;
  /**
   * The per-tile displacements the score was reduced from.
   *
   * Returned alongside rather than recomputed by anyone who wants them,
   * because `matchProjections` is the expensive half of the frame budget and
   * `reflective.ts` needs exactly this array to find a tile moving differently
   * from the rest. A second call would double the cost of the most expensive
   * thing the app does per frame, on the device least able to afford it.
   */
  readonly tiles: readonly TileDisplacement[];
}

/** Full motion measurement between two already-downscaled grey frames. */
export function measureMotion(
  prev: Projections | null, cur: Projections, dtMs: number,
): MotionMeasurement {
  if (!prev || prev.width !== cur.width || prev.height !== cur.height) {
    return {
      score: { flowPx: 0, dxPx: 0, dyPx: 0, tileConsensus: 1, dtMs, first: true },
      tiles: [],
    };
  }
  const m = matchProjections(prev, cur);
  const usable = m.tiles.filter((t) => t.confidence > 0.15);
  // The median of the per-tile displacements, to match `lk_flow`'s median over
  // tracks. Falling back to the global estimate when too few tiles matched, so
  // a frame of mostly blank wall still reports the motion it does know about.
  const flowPx = usable.length >= 3
    ? median(usable.map((t) => Math.hypot(t.dx, t.dy)))
    : Math.hypot(m.dx, m.dy);
  return {
    score: {
      flowPx,
      dxPx: m.dx,
      dyPx: m.dy,
      tileConsensus: tileConsensus(m.tiles, cur.width),
      dtMs,
      first: false,
    },
    tiles: m.tiles,
  };
}

/** `measureMotion`, for a caller that wants only the score. */
export function estimateMotion(
  prev: Projections | null, cur: Projections, dtMs: number,
): MotionScore {
  return measureMotion(prev, cur, dtMs).score;
}

// ---------------------------------------------------------------------------
// Interpreting a measurement against the pipeline's limits
// ---------------------------------------------------------------------------

/**
 * How ONE candidate's motion reads against the pipeline's per-frame limits.
 *
 * There is deliberately no `redundant` member. Redundancy is a property of the
 * displacement ACCUMULATED between two kept frames and belongs to
 * `overlap.ts`; an earlier version of this file compared a per-candidate flow
 * against MIN_DISPLACEMENT_FRAC and so called a correctly paced walk redundant,
 * because at CANDIDATE_FPS a correct pace produces about 0.10 of the width per
 * candidate and MIN_DISPLACEMENT_FRAC is 0.10 of the width between KEEPERS.
 * The two numbers are equal and unrelated. Keeping the vocabularies apart is
 * the fix; `MotionBand` is only ever about this frame.
 */
export type MotionBand = 'still' | 'good' | 'brisk' | 'fast' | 'rejected' | 'incoherent';

export interface MotionAssessment {
  readonly band: MotionBand;
  /** Displacement the pipeline would measure between consecutive candidates. */
  readonly candidateFlowPx: number;
  /** That displacement as a fraction of the image width. */
  readonly candidateFracWidth: number;
  /**
   * The same displacement as a fraction of the image DIAGONAL, which is the
   * denominator `mark_motion` actually uses. Carried so the comparison the
   * pipeline makes can be read straight off the report instead of reconstructed
   * from an aspect ratio.
   */
  readonly candidateFracDiagonal: number;
  /** The fraction of width at which `mark_motion` would reject this frame. */
  readonly rejectAtFracWidth: number;
  readonly consensusOk: boolean;
}

/**
 * Judge one frame's motion against `mark_motion`.
 *
 * Two things are going on and they fail differently, which is why the caller
 * gets a band rather than a boolean:
 *
 *   MOVING too fast     the median displacement exceeds MAX_FLOW_FRACTION of
 *                       the DIAGONAL, so the exposure is smeared at phone
 *                       shutter speeds. The fix is to walk slower.
 *
 *   TURNING too fast    the same rejection, reached by rotation rather than
 *                       translation. The fix is different — slow the wrist, not
 *                       the feet — and a cue that says "slow down" to someone
 *                       already standing still teaches them to ignore cues.
 *                       `yawRate` and `maxYawRateRadS` separate the two, and
 *                       `guidance.ts` picks the wording from that.
 *
 *   INCOHERENT          the tiles disagree about which way the image went. A
 *                       shake, a wrist flick, or rolling-shutter jelly. Walking
 *                       slower does not help; holding the phone still does.
 *
 * The denominator is the source of the one easy mistake. MAX_FLOW_FRACTION is
 * a fraction of the diagonal — `mark_motion` compares against
 * `max_flow_frac * diagonal_px` — while every displacement in the selector is a
 * fraction of the width. `maxFlowFracOfWidth` converts, so both figures come
 * out of here and neither has to be re-derived by a caller.
 */
/**
 * Where 'good' becomes 'brisk', as a fraction of image width.
 *
 * Halfway between the pace the selector was tuned for (CANDIDATE_TARGET_FRAC,
 * the per-candidate displacement a walk at TARGET_FPS produces) and the pace at
 * which the app starts advising (the rejection limit times
 * MOTION_ADVISORY_FACTOR). In other words: half the headroom used up.
 *
 * Derived from the advisory rather than fixed at some multiple of the target
 * because the headroom depends on the aspect ratio, and a fixed multiple does
 * not survive it. A first attempt used CANDIDATE_TARGET_FRAC * 1.5 = 0.15 and
 * the band was unreachable on a 16:9 frame, where the advisory sits at
 * 0.1835 * 0.75 = 0.1376 — below it. The whole band existed and never fired.
 * Anchoring to the advisory makes that arithmetically impossible: the midpoint
 * of two values is always strictly between them.
 */
function briskAbove(rejectAtFracWidth: number): number {
  const advisory = rejectAtFracWidth * MOTION_ADVISORY_FACTOR;
  return (CANDIDATE_TARGET_FRAC + advisory) / 2;
}

export function assessMotion(
  motion: MotionScore, width: number, height: number,
): MotionAssessment {
  // Rescaled to the candidate interval, because MAX_FLOW_FRACTION bounds ONE
  // candidate interval and this app does not sample on that interval. This is
  // the one place the rescale belongs; see overlap.ts for where it does not.
  const candidateFlowPx = toCandidateInterval(motion.flowPx, motion.dtMs);
  const fracWidth = width > 0 ? candidateFlowPx / width : 0;
  const diagonal = Math.hypot(width, height);
  const fracDiagonal = diagonal > 0 ? candidateFlowPx / diagonal : 0;
  const consensusOk = motion.tileConsensus >= MIN_TILE_CONSENSUS;
  const rejectAt = maxFlowFracOfWidth(width, height);

  let band: MotionBand;
  if (motion.first) {
    // No predecessor, so no measurement. `mark_motion` skips index 0 for the
    // same reason. Reporting 'still' would be a claim; 'good' is the neutral
    // state that neither warns nor congratulates.
    band = 'good';
  } else if (!consensusOk) {
    band = 'incoherent';
  } else if (fracWidth >= rejectAt) {
    band = 'rejected';
  } else if (fracWidth >= rejectAt * MOTION_ADVISORY_FACTOR) {
    band = 'fast';
  } else if (fracWidth < CANDIDATE_TARGET_FRAC * 0.2) {
    // A fifth of the per-candidate target. Standing at the entrance dwelling on
    // purpose lands here, and so does a phone set down, so nothing is warned
    // about on it — the coverage model is what notices a capture that is not
    // going anywhere.
    band = 'still';
  } else if (fracWidth > briskAbove(rejectAt)) {
    band = 'brisk';
  } else {
    band = 'good';
  }

  return {
    band,
    candidateFlowPx,
    candidateFracWidth: fracWidth,
    candidateFracDiagonal: fracDiagonal,
    rejectAtFracWidth: rejectAt,
    consensusOk,
  };
}

/**
 * Would `mark_motion` reject this frame?
 *
 * Stated as its own predicate because it is what the accept/reject flag fed to
 * `OverlapTracker` and `CoverageModel` must be built from, and because reading
 * it off a band name invites a caller to decide that 'fast' is close enough.
 * It is not: 'fast' is the advisory margin, and counting advisory frames as
 * rejected would make the app's predicted frame budget lower than the
 * pipeline's, which is a different lie from the usual one but still a lie.
 */
export function motionWouldReject(a: MotionAssessment): boolean {
  return a.band === 'rejected' || a.band === 'incoherent';
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/** Shortest signed difference between two angles, in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Yaw rate in radians per second between two orientation samples. */
export function yawRate(prev: Orientation, cur: Orientation): number {
  const dt = (cur.tMs - prev.tMs) / 1000;
  if (!(dt > 0)) return 0;
  return angleDelta(cur.yaw, prev.yaw) / dt;
}

/**
 * Online estimate of the camera's horizontal field of view.
 *
 * When the gyro reports a yaw change and the image reports a horizontal shift,
 * their ratio IS the field of view: a rotation of psi radians moves the image
 * by psi / hFov of its width. Estimating it this way rather than assuming a
 * lens means the yaw cue is anchored to the same pixel threshold as everything
 * else, on whatever handset the operator is holding, including one in a
 * wide-angle mode.
 *
 * Samples are only taken when the rotation is large enough to dominate any
 * translation component and the frame matched coherently. The median of the
 * last fifty such samples is used rather than the mean, because walking while
 * turning contributes a systematic error in one direction and the median
 * shrugs it off.
 */
export class FovEstimator {
  private readonly samples: number[] = [];
  private readonly capacity = 50;
  /** A rotation smaller than this is not usable: roughly 1.1 degrees. */
  private readonly minYaw = 0.02;
  private readonly minShiftFrac = 0.005;

  /** @param dxFracWidth horizontal image shift, as a fraction of the width. */
  add(dyawRad: number, dxFracWidth: number, consensus: number): void {
    const yawMag = Math.abs(dyawRad);
    const shiftMag = Math.abs(dxFracWidth);
    if (yawMag < this.minYaw || shiftMag < this.minShiftFrac) return;
    if (consensus < MIN_TILE_CONSENSUS) return;
    const hFov = yawMag / shiftMag;
    // Reject physically impossible lenses rather than letting one bad sample
    // in: 30 to 140 degrees spans every phone camera from a 2x tele to an
    // ultrawide, and anything outside it is a bad match, not a lens.
    if (hFov < 0.52 || hFov > 2.45) return;
    this.samples.push(hFov);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** Null until there are enough samples to be worth trusting. */
  estimate(): number | null {
    if (this.samples.length < 8) return null;
    return median(this.samples);
  }
}
