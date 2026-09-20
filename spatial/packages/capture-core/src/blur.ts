/**
 * Blur, which is the whole reason this app exists.
 *
 * Five to ten motion-blurred frames in a set of three hundred measurably
 * degrade a splat, because a blurred view is still photometrically consistent
 * with a WRONG geometry: the optimiser grows floaters to explain it and bundle
 * adjustment drags its neighbours' poses toward the smear. The pipeline throws
 * those frames away in `stages/frames.py`. The operator finds out half an hour
 * later, from a quality report, having left the property.
 *
 * So this file is a faithful port of the pipeline's own maths, not an
 * approximation of it. `laplacianVariance` and `contrastNormalisedSharpness`
 * compute exactly what the Python computes; `RollingMedianWindow` and
 * `BlurJudge` apply exactly the rule `mark_blur` applies, with the single
 * unavoidable difference that the window is trailing rather than centred
 * (thresholds.ts `blurWindowFrames` explains what that costs).
 */

import type { BlurVerdict, GrayImage, SharpnessScore } from './types.js';
import { BLUR_ABS_FLOOR, BLUR_REL_FACTOR } from './thresholds.js';

/**
 * Variance of the four-neighbour Laplacian, over the interior of the image.
 *
 * The kernel and the border handling match frames.py `laplacian_variance`
 * exactly — interior only, no padding — because a padded border contributes a
 * ring of artificial edges whose energy depends on the image size, and the
 * absolute floor is calibrated against the unpadded value.
 */
export function laplacianVariance(img: GrayImage): number {
  const { data, width: w, height: h } = img;
  if (h < 3 || w < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    const row = y * w;
    const up = row - w;
    const down = row + w;
    for (let x = 1; x < w - 1; x += 1) {
      const lap = -4 * data[row + x]!
        + data[up + x]! + data[down + x]! + data[row + x - 1]! + data[row + x + 1]!;
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Population variance of the whole image. The denominator below. */
export function intensityVariance(img: GrayImage): number {
  const { data } = img;
  const n = data.length;
  if (n === 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = data[i]!;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Raw and contrast-normalised sharpness, as frames.py
 * `contrast_normalised_sharpness` defines them.
 *
 * The normalisation is the part that matters and it is worth restating: the
 * Laplacian is linear, so scaling image contrast by k scales the numerator by
 * k squared and the denominator by k squared as well. The ratio is therefore
 * contrast-invariant, which is the difference between a threshold that works
 * in a dark hallway and a bright bay window and one that fails in both. A
 * SHARP photograph of a plain magnolia wall is the case this saves — raw VoL
 * calls it blurred, the ratio does not.
 */
export function contrastNormalisedSharpness(img: GrayImage): SharpnessScore {
  const vol = laplacianVariance(img);
  const varr = intensityVariance(img);
  return { vol, volNorm: vol / (varr + 1e-6) };
}

/**
 * A trailing rolling median over a fixed number of samples.
 *
 * Insertion-sorted into a small sorted array rather than sorting on every
 * query: the window is about forty samples and this runs ten times a second
 * for ten minutes, so an O(n) insert beats an O(n log n) sort by enough to
 * matter on a mid-range phone, and the median is then a single index.
 */
export class RollingMedianWindow {
  private readonly size: number;
  private readonly ring: number[] = [];
  private readonly sorted: number[] = [];
  private head = 0;

  constructor(size: number) {
    this.size = Math.max(1, Math.floor(size));
  }

  get count(): number { return this.ring.length; }

  push(value: number): void {
    if (this.ring.length === this.size) {
      const evicted = this.ring[this.head]!;
      this.ring[this.head] = value;
      this.head = (this.head + 1) % this.size;
      this.removeSorted(evicted);
    } else {
      this.ring.push(value);
    }
    this.insertSorted(value);
  }

  median(): number {
    const n = this.sorted.length;
    if (n === 0) return 0;
    const mid = n >> 1;
    return n % 2 === 1 ? this.sorted[mid]! : (this.sorted[mid - 1]! + this.sorted[mid]!) / 2;
  }

  private insertSorted(value: number): void {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid]! < value) lo = mid + 1; else hi = mid;
    }
    this.sorted.splice(lo, 0, value);
  }

  private removeSorted(value: number): void {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid]! < value) lo = mid + 1; else hi = mid;
    }
    if (this.sorted[lo] === value) this.sorted.splice(lo, 1);
  }
}

/**
 * The live blur decision, applying frames.py `mark_blur`'s rule.
 *
 * Two clauses, in the pipeline's order: the absolute floor first, then the
 * relative test against the local median. Relative and not purely absolute
 * because an absolute VoL threshold does not transfer between a sunlit bay
 * window and an unlit hallway in the same flat — that is the pipeline's
 * reasoning and it is exactly as true live.
 *
 * The window is not considered warm until it holds enough samples to have a
 * meaningful median. Until then only the absolute floor applies, which is the
 * conservative choice: the app would rather miss a marginal frame in the first
 * three seconds than tell someone their sharp opening shot is blurred.
 */
export class BlurJudge {
  private readonly window: RollingMedianWindow;
  private readonly warmAt: number;

  constructor(windowFrames: number) {
    this.window = new RollingMedianWindow(windowFrames);
    // Half the window. A median over fewer than this is dominated by whatever
    // the first few frames happened to be.
    this.warmAt = Math.max(3, Math.floor(windowFrames / 2));
  }

  get warm(): boolean { return this.window.count >= this.warmAt; }
  get localMedian(): number { return this.window.median(); }

  /**
   * Judge a frame, then fold it into the window.
   *
   * Folded in AFTER judging, including when rejected, because frames.py takes
   * the median over ALL candidates and not only the survivors. A median over
   * survivors only would drift upward during a shaky stretch and stop
   * rejecting anything, which is precisely the stretch that needs rejecting.
   */
  judge(volNorm: number): BlurVerdict {
    const med = this.window.median();
    let rejected = false;
    let reason = '';
    if (volNorm < BLUR_ABS_FLOOR) {
      rejected = true;
      reason = `sharpness ${volNorm.toFixed(5)} is below the absolute floor ${BLUR_ABS_FLOOR}`;
    } else if (this.warm && volNorm < BLUR_REL_FACTOR * med) {
      rejected = true;
      reason = `sharpness ${volNorm.toFixed(5)} is below ${BLUR_REL_FACTOR} of the `
        + `recent median ${med.toFixed(5)}`;
    }
    this.window.push(volNorm);
    return { rejected, volNorm, localMedian: med, reason };
  }
}
