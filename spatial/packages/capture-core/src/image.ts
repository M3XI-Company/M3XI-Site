/**
 * Pixel plumbing: RGBA to luma, box downscale, tiles.
 *
 * All of it is plain typed-array arithmetic with no canvas, both because this
 * has to run under vitest in Node and because the analysis worker gets a
 * transferred buffer, not a bitmap. Every loop here runs ten times a second on
 * a phone, so they are written flat: no closures in the inner loop, no
 * intermediate arrays, one pass wherever one pass will do.
 */

import type { GrayImage, RgbaImage } from './types.js';
import { SCORE_LONG_EDGE, TILE_GRID } from './thresholds.js';

/**
 * Rec.709 luma, in fixed point.
 *
 * Rec.709 rather than a plain channel mean for the reason bilagrid.py gives
 * for its guide channel: the ISP and the eye both weight green, and a plain
 * mean lets a saturated red wall dominate. The 16-bit fixed-point weights let
 * the whole conversion stay in integer arithmetic, which on a phone is
 * measurably faster than the float version and gives identical results after
 * the shift.
 */
const WR = 13933; // 0.2126 * 65536
const WG = 46871; // 0.7152 * 65536
const WB = 4732;  // 0.0722 * 65536

export function toGray(src: RgbaImage): GrayImage {
  const { data, width, height } = src;
  const n = width * height;
  const out = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    out[i] = (WR * data[p]! + WG * data[p + 1]! + WB * data[p + 2]!) >> 16;
  }
  return { data: out, width, height };
}

/**
 * Box-filter downscale to a target long edge.
 *
 * A box filter rather than nearest-neighbour because nearest-neighbour
 * ALIASES, and aliasing manufactures high-frequency detail that variance of
 * the Laplacian reads as sharpness. A blurred frame downsampled by point
 * sampling can score higher than a sharp one downsampled properly, which would
 * invert the one measurement this whole app exists to make. It matches
 * cv2.INTER_AREA, which is what frames.py `_resize_long_edge` uses.
 */
export function downscaleGray(src: GrayImage, longEdge = SCORE_LONG_EDGE): GrayImage {
  const { data, width, height } = src;
  const scale = longEdge / Math.max(width, height);
  if (scale >= 1) return src;
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(dw * dh);
  const xRatio = width / dw;
  const yRatio = height / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx += 1) { sum += data[row + xx]!; count += 1; }
      }
      out[y * dw + x] = count > 0 ? (sum / count) : 0;
    }
  }
  return { data: out, width: dw, height: dh };
}

/** Bounds of tile `index` in a TILE_GRID x TILE_GRID split, row-major. */
export function tileBounds(
  width: number, height: number, index: number, grid = TILE_GRID,
): { x0: number; y0: number; x1: number; y1: number } {
  const col = index % grid;
  const row = Math.floor(index / grid);
  return {
    x0: Math.floor((col * width) / grid),
    y0: Math.floor((row * height) / grid),
    x1: Math.floor(((col + 1) * width) / grid),
    y1: Math.floor(((row + 1) * height) / grid),
  };
}

/** Median of a numeric array. Copies, so the caller's order survives. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const a = Array.from(values).sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 === 1 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** Clamp into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
