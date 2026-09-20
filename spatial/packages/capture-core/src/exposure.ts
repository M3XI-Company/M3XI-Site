/**
 * Lighting: clipped highlights, crushed shadows, and the glazing the operator
 * can still do something about.
 *
 * Two different failures live here and they are not the same problem.
 *
 * The first is arithmetic. A clipped pixel has no gradient, so it contributes
 * nothing to the numerator of variance-of-Laplacian while still contributing
 * to the intensity variance in the denominator. Both push `vol_norm` down, and
 * `mark_blur` rejects at 0.55 of the local median without caring why. A frame
 * with a quarter of itself blown out is thrown away by the blur stage and the
 * operator would never guess it from the screen, because to the eye it looks
 * perfectly sharp. `blur.test.ts` measures this rather than asserting it.
 *
 * The second is geometry. A mirror is not a hard surface to a reconstruction:
 * it is a window onto a room that does not exist, and COLMAP will happily
 * triangulate the reflection into a phantom room behind the wall. Glazing
 * fails the other way — the exterior clips and depth becomes meaningless.
 * `pipeline/worldengine/reflective.py` handles both AFTER the fact, using
 * detection, depth-behind-plane and view dependence. On the phone, before the
 * fact, the only one of its four signals available is saturation; the useful
 * thing about saturation is that it is also the one the operator can fix in
 * two seconds by changing where they stand. `reflective.ts` builds the
 * judgement; this file only measures.
 *
 * CLIPPING IS COUNTED AT 248, NOT 255, and that is not a rounding convenience.
 * Phone ISPs apply a tone curve on the way to 8-bit output, so a genuinely
 * blown highlight does not arrive as 255 — it arrives spread across the 248-255
 * band, and a good part of it never reaches 255 at all. `reflective.py` picked
 * 248 for exactly this reason and the pipeline's glazing score is computed
 * against it. Counting at 255 here would make the phone's saturation figure a
 * fraction of the pipeline's on the same frame, so a window the pipeline calls
 * certain glazing would read as mild brightness on the screen of the person who
 * could still have walked two steps to the left.
 */

import type { ExposureScore, GlareRegion, GrayImage } from './types.js';
import { tileBounds } from './image.js';
import {
  GLAZED_SATURATION_WEIGHT, REGION_SATURATION_REPORT, SATURATION_LEVEL, SHADOW_LEVEL, TILE_GRID,
} from './thresholds.js';

/**
 * Clipping, crushing and per-tile mean luma, in one pass.
 *
 * Fused with nothing else because it is the only pass that needs the tile
 * layout as well as the whole frame, and splitting it out keeps the Laplacian
 * loop free of branches.
 */
export function measureExposure(img: GrayImage, grid = TILE_GRID): ExposureScore {
  const { data, width, height } = img;
  const cells = grid * grid;
  const tileSum = new Float64Array(cells);
  const tileCount = new Float64Array(cells);
  const tileBlown = new Float64Array(cells);
  let blown = 0;
  let crushed = 0;
  let sum = 0;

  const colTile = new Int32Array(width);
  for (let x = 0; x < width; x += 1) colTile[x] = Math.min(grid - 1, Math.floor((x * grid) / width));

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const tileBase = Math.min(grid - 1, Math.floor((y * grid) / height)) * grid;
    for (let x = 0; x < width; x += 1) {
      const v = data[row + x]!;
      sum += v;
      const t = tileBase + colTile[x]!;
      // Read-add-write rather than `+=`. Under noUncheckedIndexedAccess a typed
      // array element is `number | undefined`, and a non-null assertion cannot
      // sit on the left of a compound assignment, so `tileSum[t] += v` does not
      // type-check. `t` is bounded by construction — `tileBase` is at most
      // (grid-1)*grid and `colTile[x]` at most grid-1 — so the assertion is a
      // statement about the checker, not about the index.
      tileSum[t] = tileSum[t]! + v;
      tileCount[t] = tileCount[t]! + 1;
      if (v >= SATURATION_LEVEL) { blown += 1; tileBlown[t] = tileBlown[t]! + 1; }
      else if (v <= SHADOW_LEVEL) { crushed += 1; }
    }
  }

  const n = width * height;
  const tileLuma: number[] = [];
  for (let t = 0; t < cells; t += 1) {
    tileLuma.push(tileCount[t]! > 0 ? tileSum[t]! / tileCount[t]! : 0);
  }
  // Tiles that are entirely clipped are excluded from the dynamic-range
  // measure. A window fills a tile with 255 and would otherwise make every
  // frame containing one look like a two-stop lighting problem, when the
  // problem is specifically a window and is reported as one.
  const usable = tileLuma.filter((_, i) => (tileBlown[i]! / Math.max(1, tileCount[i]!)) < 0.5);
  const pool = usable.length >= 2 ? usable : tileLuma;
  const brightest = Math.max(...pool);
  // Floor the darkest at one level: a genuinely black tile would make the
  // ratio infinite, and "infinitely uneven" is not a useful thing to tell
  // anybody. One level is the smallest difference 8-bit data can express.
  const darkest = Math.max(1, Math.min(...pool));

  return {
    blownFraction: blown / n,
    crushedFraction: crushed / n,
    meanLuma: sum / n,
    tileDynamicRange: brightest / darkest,
    tileLuma,
  };
}

/**
 * Tiles bright enough that the pipeline would call them glazing.
 *
 * `reflective.py` computes `glazed_score` as
 *   0.50 * saturation + 0.40 * window_detection + 0.10 * depth_behind
 * and flags at 0.45. The phone has neither a detector nor depth, so only the
 * first term is available, and this reports exactly that term — a region at
 * 90% clipped reaches the flag on saturation alone.
 *
 * Reporting the pipeline's own partial score rather than a made-up "glare
 * score" is deliberate. It means the number on the phone and the number in the
 * quality report are the same number, and an operator who learns what 0.45
 * feels like has learnt something true.
 */
export function findGlare(img: GrayImage, grid = TILE_GRID): GlareRegion[] {
  const { data, width, height } = img;
  const out: GlareRegion[] = [];
  for (let t = 0; t < grid * grid; t += 1) {
    const b = tileBounds(width, height, t, grid);
    let clipped = 0;
    let count = 0;
    for (let y = b.y0; y < b.y1; y += 1) {
      const row = y * width;
      for (let x = b.x0; x < b.x1; x += 1) {
        if (data[row + x]! >= SATURATION_LEVEL) clipped += 1;
        count += 1;
      }
    }
    if (count === 0) continue;
    const saturation = clipped / count;
    const score = GLAZED_SATURATION_WEIGHT * saturation;
    // REGION_SATURATION_REPORT is half of the saturation at which the pipeline
    // would flag on this term alone. At that point saturation is carrying half
    // the evidence and a window detection — which the pipeline WILL have and
    // this device will not — would take it the rest of the way. That is the
    // moment to tell someone to change angle, not after it is already certain.
    if (saturation >= REGION_SATURATION_REPORT) {
      out.push({ tile: t, saturation, glazedScoreFromSaturationAlone: score });
    }
  }
  return out;
}

/**
 * Where a glare region sits, in words rather than tile indices.
 *
 * An operator holding a phone at arm's length cannot map "tile 3" onto
 * anything. "Top right" they can act on without looking away from where they
 * are walking.
 *
 * The band is decided on the tile's CENTRE, not its leading edge. Comparing the
 * index directly — `row < grid / 3` — is the obvious form and it is wrong for
 * every grid that is not a multiple of three: at TILE_GRID 4 it puts rows 0 and
 * 1 in the top third, row 2 in the middle and row 3 at the bottom, so a
 * reflection in the second row of four is reported as "top" when it is at eye
 * level. Using (index + 0.5) / grid asks where the tile's middle falls, which
 * is symmetric at every grid size and gives 4 rows the sensible
 * top / centre / centre / bottom.
 */
export function describeTile(tile: number, grid = TILE_GRID): string {
  const g = Math.max(1, Math.floor(grid));
  const col = tile % g;
  const row = Math.floor(tile / g);
  const band = (index: number, low: string, mid: string, high: string): string => {
    const centre = (index + 0.5) / g;
    if (centre < 1 / 3) return low;
    if (centre >= 2 / 3) return high;
    return mid;
  };
  const vertical = band(row, 'top', 'centre', 'bottom');
  const horizontal = band(col, 'left', 'centre', 'right');
  if (vertical === 'centre' && horizontal === 'centre') return 'centre';
  if (vertical === 'centre') return horizontal;
  if (horizontal === 'centre') return vertical;
  return `${vertical} ${horizontal}`;
}
