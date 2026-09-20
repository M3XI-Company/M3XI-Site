/**
 * Overlap: the currency a reconstruction is actually bought with.
 *
 * `select_by_overlap` in stages/frames.py walks the candidates accumulating
 * flow and keeps one every TARGET_DISPLACEMENT_FRAC of image width. Nothing
 * else in the pipeline decides how many frames a room contributes. So an app
 * that can measure accumulated displacement can predict the frame budget
 * exactly, with no pose estimation, no depth and no map — which is the one
 * useful thing a browser can do here and the reason this package exists.
 *
 * TWO MISTAKES ARE EASY TO MAKE HERE AND BOTH ARE SILENT.
 *
 * The first is comparing a SINGLE candidate's flow to the overlap band.
 * MIN/TARGET/MAX_DISPLACEMENT_FRAC bound the displacement ACCUMULATED between
 * two kept frames, not the flow of one candidate. At TARGET_FPS 2.5 and
 * CANDIDATE_FPS 7.5 there are three candidates between keepers, so a correctly
 * paced walk produces about 0.10 of the width per candidate — numerically equal
 * to MIN_DISPLACEMENT_FRAC and meaning something entirely different. An app
 * that confuses them tells a perfectly paced operator they are standing still.
 *
 * The second is rescaling before accumulating. `toCandidateInterval` exists
 * because MAX_FLOW_FRACTION bounds one candidate interval and a live app does
 * not sample on that interval. It must NOT be applied to samples that are then
 * summed: an accumulated path length is a property of the path, not of the
 * sampling rate, and rescaling each 100 ms sample to 133 ms before summing
 * inflates the total by ANALYSIS_HZ / CANDIDATE_FPS — a third. A third too much
 * accumulated travel is a room reported as covered when a quarter of it was
 * never walked, and that error points the wrong way: it produces false
 * confidence, at the property, in the one number the operator is trusting.
 *
 * This module therefore accumulates RAW measured displacement and never touches
 * `toCandidateInterval`. The instantaneous motion check in `motion.ts` does the
 * opposite, and the two are deliberately kept in different files.
 */

import {
  MAX_FRAMES, MIN_FRAMES, OVERLAP_FRACTURE_ABOVE, OVERLAP_REDUNDANT_BELOW, OVERLAP_TARGET,
} from './thresholds.js';
import { clamp } from './image.js';

/**
 * Where a displacement sits against the band.
 *
 * The same four names serve two questions — "how far apart did those two kept
 * frames end up" and "how far have we travelled since the last one" — because
 * it is the same quantity measured at two moments, and giving it two vocabularies
 * would invite exactly the confusion the header warns about.
 */
export type OverlapBand = 'redundant' | 'tight' | 'good' | 'fracture';

export function overlapBandOf(fracWidth: number): OverlapBand {
  if (!(fracWidth >= 0)) return 'redundant';
  if (fracWidth < OVERLAP_REDUNDANT_BELOW) return 'redundant';
  if (fracWidth < OVERLAP_TARGET) return 'tight';
  if (fracWidth < OVERLAP_FRACTURE_ABOVE) return 'good';
  return 'fracture';
}

/**
 * Overlap between two views from their separation.
 *
 * frames.py: "~0.30 of the width corresponds to roughly 70% overlap for a
 * forward-facing translating camera, which is the middle of the band LightGlue
 * likes". That is the linear relation overlap = 1 - separation/width, and it is
 * the relation the selector's own target is quoted against, so it is the one
 * used here rather than a more careful projective model that would no longer
 * agree with the number the pipeline was tuned on.
 *
 * It holds for lateral and rotational motion and UNDERSTATES overlap for motion
 * straight down a corridor, where the view scales rather than translates.
 * Understating is the safe direction: it asks for a slower walk than strictly
 * necessary rather than blessing one that will not match.
 */
export function overlapFromSeparation(fracWidth: number): number {
  return clamp(1 - fracWidth, 0, 1);
}

/** One analysed frame, as the overlap tracker wants it. */
export interface OverlapSample {
  /**
   * Displacement measured over `dtMs`, in pixels at the analysis resolution.
   * RAW. Not passed through `toCandidateInterval` — see the header.
   */
  readonly flowPx: number;
  readonly dtMs: number;
  /** Width of the analysed image in pixels, the denominator of every fraction. */
  readonly widthPx: number;
  /** True when the frame survived both the blur rule and the motion rule. */
  readonly accepted: boolean;
}

export interface OverlapState {
  /** Frames `select_by_overlap` would have kept so far at the nominal target. */
  readonly kept: number;
  /** True when THIS sample was one of them. */
  readonly keptThisFrame: boolean;
  /** Travel since the last keeper, in image widths. */
  readonly pendingWidths: number;
  /** Band of `pendingWidths`: how the NEXT keeper is shaping up. */
  readonly band: OverlapBand;
  /** Separation at the last keeper, in image widths. 0 before the first. */
  readonly lastSeparationWidths: number;
  /** Estimated overlap between the last two kept frames, 0-1. */
  readonly lastOverlap: number;
  /** Total travel over the whole capture so far, in image widths. */
  readonly totalWidths: number;
  /** Candidates skipped because they were too close to the previous keeper. */
  readonly redundant: number;
  /**
   * True once the pending accumulation has passed the fracture bound without a
   * keeper. The only way this happens is a run of candidates every one of which
   * was rejected, so it is a hole in the chain rather than a pace problem, and
   * walking faster cannot fix it — only walking back can.
   */
  readonly gapOpen: boolean;
}

/**
 * A live model of `select_by_overlap`'s forward walk.
 *
 * The walk is reproduced exactly, in the pipeline's own order: accumulate first
 * (so a rejected candidate's travel still counts toward the next keeper's
 * spacing, which is what makes the spacing a property of the camera path rather
 * than of the surviving frames), then skip rejected candidates, then the
 * redundancy floor, then the target.
 *
 * What is NOT reproduced is the back-off. `select_by_overlap` re-walks the whole
 * sequence at half the target spacing when the first pass yields fewer than
 * MIN_FRAMES, which it can only do because it has the whole sequence. Live, the
 * capture is not over. Reproducing the back-off frame by frame would mean the
 * keeper count jumping backwards when the operator walks further, which is worse
 * than useless on a screen someone is glancing at while moving. So the tracker
 * walks at the nominal target and `predictSelectedFrames` applies the back-off
 * to the accumulated total, which is where the question is actually asked.
 */
export class OverlapTracker {
  private keptCount = 0;
  private pending = 0;
  private total = 0;
  private redundantCount = 0;
  private lastSeparation = 0;
  private gap = false;

  observe(s: OverlapSample): OverlapState {
    const width = s.widthPx > 0 ? s.widthPx : 0;
    const frac = width > 0 && Number.isFinite(s.flowPx) ? Math.max(0, s.flowPx) / width : 0;

    // Accumulate before anything else, exactly as the Python does.
    this.total += frac;
    this.pending += frac;

    let keptThisFrame = false;
    if (s.accepted) {
      if (this.keptCount === 0) {
        // The first survivor is kept unconditionally: there is nothing to space
        // it against. `walk()` does the same, and it matters live because it is
        // what makes the entrance dwell produce a keeper rather than a wait.
        keptThisFrame = true;
        this.lastSeparation = 0;
        this.pending = 0;
      } else if (this.pending < OVERLAP_REDUNDANT_BELOW) {
        // Too close to the last keeper to carry new information. Skipped, and
        // the accumulation deliberately NOT reset: the travel is still real.
        this.redundantCount += 1;
      } else if (this.pending >= OVERLAP_TARGET) {
        keptThisFrame = true;
        this.lastSeparation = this.pending;
        this.pending = 0;
      }
      // Between the floor and the target the candidate is simply passed over
      // and the accumulation keeps growing. No counter for it, because the
      // pipeline has none either: it is the normal state of two thirds of the
      // candidates in a correctly paced walk.
    }
    if (keptThisFrame) {
      this.keptCount += 1;
      this.gap = false;
    } else if (this.pending >= OVERLAP_FRACTURE_ABOVE && this.keptCount > 0) {
      this.gap = true;
    }

    return {
      kept: this.keptCount,
      keptThisFrame,
      pendingWidths: this.pending,
      band: overlapBandOf(this.pending),
      lastSeparationWidths: this.lastSeparation,
      lastOverlap: overlapFromSeparation(this.lastSeparation),
      totalWidths: this.total,
      redundant: this.redundantCount,
      gapOpen: this.gap,
    };
  }

  /** Travel so far, in image widths. The unit everything downstream counts in. */
  get totalWidths(): number { return this.total; }
  get kept(): number { return this.keptCount; }
}

/**
 * Frames `select_by_overlap` will keep, given total travel and how many
 * candidates survived rejection.
 *
 * Two bounds apply at once and the second is the one operators do not expect:
 * travel buys frames, but no amount of travel buys more frames than there were
 * unrejected candidates to choose from. That is what makes a shaky capture
 * unrecoverable rather than merely slow — walking the property twice as far
 * does not replace frames that were thrown away, because the new frames are
 * being thrown away at the same rate.
 *
 * The back-off is modelled the way the Python does it: halve the target spacing
 * while the result is under MIN_FRAMES, stopping at MIN_DISPLACEMENT_FRAC,
 * because below that consecutive frames carry no new information and the
 * pipeline explicitly refuses to pad the set.
 *
 * This is a closed form over the TOTAL, where `walk()` is a sequential pass, so
 * the two agree exactly only when travel is evenly distributed. They diverge
 * when it is not: a capture that stood still for a minute and then sprinted has
 * the same total and fewer real keepers. The closed form is therefore an UPPER
 * bound on the frame count, which is the wrong direction for comfort and the
 * right one for honesty — the live `OverlapTracker.kept` is the exact figure
 * and is what the verdict prefers when it has one.
 */
export function predictSelectedFrames(totalWidths: number, acceptedCandidates: number): number {
  const cap = Math.max(0, Math.floor(acceptedCandidates));
  const travel = Math.max(0, Number.isFinite(totalWidths) ? totalWidths : 0);
  let target = OVERLAP_TARGET;
  let kept = Math.min(Math.floor(travel / target), cap);
  while (kept < MIN_FRAMES && target > OVERLAP_REDUNDANT_BELOW * 1.001) {
    target = Math.max(OVERLAP_REDUNDANT_BELOW, target * 0.5);
    kept = Math.min(Math.floor(travel / target), cap);
  }
  return Math.min(kept, MAX_FRAMES);
}
