/**
 * Synthetic frames with sharpness and contrast controlled INDEPENDENTLY.
 *
 * This file is the reason the blur property can be tested at all. The claim
 * under test — "a sharp frame in a dim room must not read as blurred" — is
 * about two variables, and any fixture that changes both at once (a photograph
 * of a dark hallway, say) cannot distinguish a metric that is contrast-invariant
 * from one that happens to score that particular hallway acceptably.
 *
 * So a scene is generated once as a dimensionless pattern in [-1, 1] and then
 * rendered at a chosen contrast: `value = mid + contrast * amplitude * pattern`.
 * Sharpness is changed by blurring the PATTERN, contrast by changing the
 * multiplier, and the two are orthogonal by construction.
 *
 * The pattern is blocks rather than per-pixel noise for a specific reason.
 * Per-pixel noise is already at the Nyquist limit, so a box blur annihilates it
 * completely and the blurred case becomes trivially easy — the test would pass
 * against a metric that only works on noise. Blocks of a few pixels have
 * structure at a scale a real room has (edges of skirting, door frames, tile
 * grout) and a small blur degrades them the way a real motion blur degrades a
 * real frame: substantially, but not to nothing.
 *
 * Everything here is seeded. A flaky blur test is worse than no blur test,
 * because the first time it fails on CI somebody will re-run it.
 */

import type { GrayImage } from '../types.js';

/**
 * A pattern in [-1, 1], one value per pixel, independent of contrast.
 *
 * Kept as Float64Array rather than baked into 8-bit so blurring happens before
 * quantisation. Blurring after quantisation would mix the rounding error into
 * the sharpness comparison, which is exactly the confound this file exists to
 * remove.
 */
export interface Pattern {
  readonly data: Float64Array;
  readonly width: number;
  readonly height: number;
}

/** Deterministic LCG. Numerical Recipes constants; adequate for fixtures. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Blocky pseudo-random pattern.
 *
 * @param block edge of one constant square, in pixels. 4 is about the scale of
 *              grout lines and skirting edges at the 960 px scoring width.
 */
export function blockPattern(width: number, height: number, block: number, seed: number): Pattern {
  const rnd = lcg(seed);
  const bw = Math.ceil(width / block);
  const bh = Math.ceil(height / block);
  const cells = new Float64Array(bw * bh);
  for (let i = 0; i < cells.length; i += 1) cells[i] = rnd() * 2 - 1;
  const data = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const by = Math.floor(y / block);
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = cells[by * bw + Math.floor(x / block)]!;
    }
  }
  return { data, width, height };
}

/**
 * Separable box blur over a pattern, with edge clamping.
 *
 * A box blur rather than a Gaussian because a phone's motion blur over one
 * exposure IS very nearly a box: the sensor integrates uniformly while the
 * camera moves. Radius 2 (a 5-wide kernel) at the scoring width corresponds to
 * roughly the smear of a brisk pan at 1/60 s, which is the case the pipeline
 * rejects.
 */
export function blurPattern(p: Pattern, radius: number): Pattern {
  const { width: w, height: h } = p;
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  const n = radius * 2 + 1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        sum += p.data[row + xx]!;
      }
      tmp[row + x] = sum / n;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        sum += tmp[yy * w + x]!;
      }
      out[y * w + x] = sum / n;
    }
  }
  return { data: out, width: w, height: h };
}

export interface RenderOpts {
  /** Multiplier on the pattern. 1 is the reference, 0.1 is a very dim room. */
  readonly contrast: number;
  /** Mid grey the pattern swings around, 0-255. */
  readonly mid?: number;
  /** Swing at contrast 1, in levels. 110 around 128 keeps [18, 238]. */
  readonly amplitude?: number;
}

/**
 * Render a pattern to 8-bit grey.
 *
 * Rounds rather than truncates, and clamps, so the fixture behaves like a real
 * sensor readout. At contrast 0.1 the swing is about 11 levels, so quantisation
 * costs roughly 0.5 of 11 — under 5% — which is why the contrast-invariance
 * assertion has a tolerance and not an exact equality.
 */
export function render(p: Pattern, opts: RenderOpts): GrayImage {
  const mid = opts.mid ?? 128;
  const amplitude = opts.amplitude ?? 110;
  const k = opts.contrast * amplitude;
  const data = new Uint8ClampedArray(p.width * p.height);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.round(mid + k * p.data[i]!);
  }
  return { data, width: p.width, height: p.height };
}

/** A uniform grey frame. Useful as a featureless-wall control. */
export function flat(width: number, height: number, level: number): GrayImage {
  const data = new Uint8ClampedArray(width * height);
  data.fill(level);
  return { data, width, height };
}

/**
 * Copy an image shifted by (dx, dy), wrapping.
 *
 * Wrapping rather than clamping because the projection matcher compares column
 * and row SUMS, and a clamped edge would duplicate one column's worth of
 * intensity into the sum and bias the match. Wrapping keeps every column's
 * contribution present exactly once, which is what a real translation between
 * two frames of a continuous scene approximates.
 */
export function shifted(img: GrayImage, dx: number, dy: number): GrayImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = ((y - dy) % h + h) % h;
    for (let x = 0; x < w; x += 1) {
      const sx = ((x - dx) % w + w) % w;
      out[y * w + x] = data[sy * w + sx]!;
    }
  }
  return { data: out, width: w, height: h };
}

/** Paint a rectangle of `level` into a copy of `img`. */
export function paintRect(
  img: GrayImage, x0: number, y0: number, x1: number, y1: number, level: number,
): GrayImage {
  const out = new Uint8ClampedArray(img.data);
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x += 1) {
      out[y * img.width + x] = level;
    }
  }
  return { data: out, width: img.width, height: img.height };
}
