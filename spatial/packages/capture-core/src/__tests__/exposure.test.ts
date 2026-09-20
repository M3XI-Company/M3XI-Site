/**
 * Exposure, and the 248 that is not a rounding convenience.
 *
 * `reflective.py` counts a pixel as clipped at SATURATION_LEVEL 248, not 255,
 * because phone ISPs apply a tone curve on the way to 8-bit and a genuinely
 * blown highlight lands spread across the 248-255 band with plenty of it never
 * reaching 255. If this package counted at 255 the phone's saturation figure
 * would be a fraction of the pipeline's on the same frame, and a window the
 * pipeline will call certain glazing would read as mild brightness on the
 * screen of the only person who could still have moved two steps to the left.
 *
 * The second thing tested here is `describeTile`, which sounds cosmetic and is
 * not. It is the whole content of the cue: "top right" is actionable without
 * looking down, "tile 3" is not. The obvious implementation — compare the row
 * index to grid/3 — is wrong for every grid that is not a multiple of three,
 * and at TILE_GRID 4 it reports a reflection at eye level as being at the top
 * of the frame.
 */

import { describe, expect, it } from 'vitest';
import { describeTile, findGlare, measureExposure } from '../exposure.js';
import {
  GLAZED_SATURATION_WEIGHT, REGION_SATURATION_CERTAIN, REGION_SATURATION_REPORT,
  SATURATION_LEVEL, SHADOW_LEVEL, TILE_DYNAMIC_RANGE_ACT, TILE_GRID,
} from '../thresholds.js';
import { flat, paintRect } from './synthetic.js';

const W = 160;
const H = 160;

describe('clipping is counted at 248, not 255', () => {
  it('counts the whole 248-255 band a phone ISP actually produces', () => {
    expect(SATURATION_LEVEL).toBe(248);
    for (const level of [248, 250, 252, 255]) {
      expect(measureExposure(flat(W, H, level)).blownFraction).toBe(1);
    }
  });

  it('does not count the level below it', () => {
    expect(measureExposure(flat(W, H, 247)).blownFraction).toBe(0);
  });

  it('would have under-reported a real window by counting at 255 instead', () => {
    // A window occupying a quarter of the frame, rendered the way an ISP
    // renders one: most of it rolled off into the 248-254 band with only a
    // little at hard 255.
    let img = flat(W, H, 120);
    img = paintRect(img, 0, 0, W / 2, H / 2, 251);
    img = paintRect(img, 0, 0, W / 8, H / 8, 255);
    const measured = measureExposure(img).blownFraction;
    expect(measured).toBeCloseTo(0.25, 6);

    const at255 = Array.from(img.data).filter((v) => v >= 255).length / (W * H);
    expect(at255).toBeCloseTo(0.015625, 6);
    // Sixteen times smaller. That is the size of the error, on one frame.
    expect(measured / at255).toBeCloseTo(16, 6);
  });

  it('counts crushed shadow separately and does not double-count', () => {
    let img = flat(W, H, 120);
    img = paintRect(img, 0, 0, W, H / 4, 255);
    img = paintRect(img, 0, H / 2, W, (H * 3) / 4, SHADOW_LEVEL);
    const e = measureExposure(img);
    expect(e.blownFraction).toBeCloseTo(0.25, 6);
    expect(e.crushedFraction).toBeCloseTo(0.25, 6);
  });
});

describe('tile statistics', () => {
  it('reports mean luma and a flat dynamic range on an even frame', () => {
    const e = measureExposure(flat(W, H, 100));
    expect(e.meanLuma).toBe(100);
    expect(e.tileDynamicRange).toBe(1);
    expect(e.tileLuma).toHaveLength(TILE_GRID * TILE_GRID);
  });

  it('sees two stops across a frame lit from one side', () => {
    let img = flat(W, H, 40);
    img = paintRect(img, 0, 0, W / 2, H, 200);
    // 200 / 40 is five times, well past the two stops at which one exposure
    // cannot serve the frame.
    expect(measureExposure(img).tileDynamicRange).toBeGreaterThan(TILE_DYNAMIC_RANGE_ACT);
  });

  it('excludes a fully blown tile from the dynamic-range measure', () => {
    // A window fills a tile with clipped pixels. Counting it would make every
    // frame containing a window look like a lighting problem, when the problem
    // is specifically a window and is reported as one by findGlare.
    let img = flat(W, H, 100);
    const t = W / TILE_GRID;
    img = paintRect(img, 0, 0, t, t, 255);
    expect(measureExposure(img).tileDynamicRange).toBeCloseTo(1, 6);
  });

  it('does not divide by a black tile', () => {
    let img = flat(W, H, 120);
    img = paintRect(img, 0, 0, W / TILE_GRID, H / TILE_GRID, 0);
    const e = measureExposure(img);
    expect(Number.isFinite(e.tileDynamicRange)).toBe(true);
  });
});

describe('findGlare', () => {
  it('reports the pipeline\'s own partial glazed score and not an invented one', () => {
    let img = flat(W, H, 100);
    const t = W / TILE_GRID;
    img = paintRect(img, 0, 0, t, t, 250);
    const glare = findGlare(img);
    expect(glare).toHaveLength(1);
    expect(glare[0]!.tile).toBe(0);
    expect(glare[0]!.saturation).toBe(1);
    expect(glare[0]!.glazedScoreFromSaturationAlone).toBe(GLAZED_SATURATION_WEIGHT);
  });

  it('reports a tile at the halfway point and not one below it', () => {
    const t = W / TILE_GRID;
    const withSaturation = (frac: number) => {
      const rows = Math.round(t * frac);
      return findGlare(paintRect(flat(W, H, 100), 0, 0, t, rows, 250));
    };
    expect(withSaturation(REGION_SATURATION_REPORT + 0.05)).toHaveLength(1);
    expect(withSaturation(REGION_SATURATION_REPORT - 0.05)).toHaveLength(0);
  });

  it('leaves a bright but unclipped room alone', () => {
    expect(findGlare(flat(W, H, 240))).toHaveLength(0);
  });

  it('puts the certain point where saturation alone carries the pipeline over', () => {
    // 0.50 * 0.90 = 0.45 = GLAZED_THRESHOLD, exactly.
    expect(GLAZED_SATURATION_WEIGHT * REGION_SATURATION_CERTAIN).toBeCloseTo(0.45, 10);
  });
});

describe('describeTile', () => {
  it('bands a four-by-four grid symmetrically', () => {
    // The bug this replaced put rows 0 AND 1 in the top third, leaving one row
    // each for centre and bottom. A reflection in the second row of four was
    // reported as "top", which is a different place in the room.
    expect(describeTile(0, 4)).toBe('top left');
    expect(describeTile(3, 4)).toBe('top right');
    expect(describeTile(5, 4)).toBe('centre');
    expect(describeTile(6, 4)).toBe('centre');
    expect(describeTile(9, 4)).toBe('centre');
    expect(describeTile(12, 4)).toBe('bottom left');
    expect(describeTile(15, 4)).toBe('bottom right');
  });

  it('is symmetric: the first and last tiles mirror each other at any grid size', () => {
    for (const grid of [2, 3, 4, 5, 6, 8]) {
      const first = describeTile(0, grid);
      const last = describeTile(grid * grid - 1, grid);
      expect(first).toBe('top left');
      expect(last).toBe('bottom right');
    }
  });

  it('names an edge without the redundant centre word', () => {
    expect(describeTile(1, 4)).toBe('top');
    expect(describeTile(4, 4)).toBe('left');
    expect(describeTile(7, 4)).toBe('right');
    expect(describeTile(13, 4)).toBe('bottom');
  });
});
