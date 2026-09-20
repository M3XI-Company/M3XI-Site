/**
 * Mirrors and glazing: what the phone reports, and what it refuses to.
 *
 * The assertions that matter most here are negative ones. There is no mirror
 * score in this package, and there must not be one, because the phone has none
 * of the three signals `reflective_score` is built from — detection, depth
 * behind the wall plane, and multi-view view dependence add up to 0.90 of it
 * and all three need either a model, a depth sensor or the trained splat. A
 * plausible-looking mirror number computed from whatever happens to be
 * available would sit on the same screen as the glazing figure, which IS real,
 * and be trusted for the same reason.
 *
 * So: glazing is reported as the pipeline's own partial score and named as
 * partial; depth discontinuities are reported with their ambiguity attached;
 * and the operator gets asked. Each of those is tested for the thing it must
 * NOT do as well as the thing it does.
 */

import { describe, expect, it } from 'vitest';
import type { GlareRegion } from '../types.js';
import type { TileDisplacement } from '../motion.js';
import {
  DiscontinuityWatch, MIRROR_EVIDENCE_UNAVAILABLE_WEIGHT, MIRROR_SIGNALS_UNAVAILABLE,
  discontinuityFindings, glazingFindings, mirrorCapabilityStatement, summariseDeclarations,
} from '../reflective.js';
import {
  GLAZED_SATURATION_WEIGHT, GLAZED_THRESHOLD, REFLECTIVE_THRESHOLD,
  REGION_SATURATION_CERTAIN, REGION_SATURATION_REPORT, TILE_AGREEMENT_FRAC,
} from '../thresholds.js';

const WIDTH = 960;

function glare(tile: number, saturation: number): GlareRegion {
  return {
    tile, saturation,
    glazedScoreFromSaturationAlone: GLAZED_SATURATION_WEIGHT * saturation,
  };
}

function tile(dx: number, dy = 0, confidence = 0.8): TileDisplacement {
  return { dx, dy, confidence };
}

describe('what this device cannot measure about mirrors', () => {
  it('accounts for nine tenths of the pipeline\'s mirror evidence as unavailable', () => {
    expect(MIRROR_EVIDENCE_UNAVAILABLE_WEIGHT).toBeCloseTo(0.9, 10);
    expect(MIRROR_SIGNALS_UNAVAILABLE).toHaveLength(3);
    for (const s of MIRROR_SIGNALS_UNAVAILABLE) {
      expect(s.because.length).toBeGreaterThan(20);
      expect(s.weight).toBeGreaterThan(0);
    }
  });

  it('exports no mirror score of any kind', async () => {
    // The negative assertion, made structurally rather than by inspection. If
    // somebody later adds a `mirrorScore` or a `reflectiveScore` to this
    // module, this test is where they find out it is a policy and not an
    // oversight.
    const mod = await import('../reflective.js');
    const names = Object.keys(mod).map((n) => n.toLowerCase());
    expect(names.some((n) => n.includes('mirrorscore'))).toBe(false);
    expect(names.some((n) => n.includes('reflectivescore'))).toBe(false);
  });

  it('says so in a sentence that carries the threshold it cannot reach', () => {
    const s = mirrorCapabilityStatement();
    expect(s).toContain(REFLECTIVE_THRESHOLD.toFixed(2));
    expect(s).toContain(MIRROR_EVIDENCE_UNAVAILABLE_WEIGHT.toFixed(2));
    expect(s).toContain('cannot');
  });
});

describe('glazing, which the phone CAN compute', () => {
  it('reports the pipeline\'s saturation term and quotes the pipeline\'s threshold', () => {
    const [f] = glazingFindings([glare(0, 0.8)]);
    expect(f).toBeDefined();
    expect(f!.partialGlazedScore).toBeCloseTo(0.5 * 0.8, 10);
    expect(f!.pipelineThreshold).toBe(GLAZED_THRESHOLD);
  });

  it('calls it certain only when saturation alone carries the pipeline over', () => {
    const below = glazingFindings([glare(0, REGION_SATURATION_CERTAIN - 0.02)])[0];
    const at = glazingFindings([glare(0, REGION_SATURATION_CERTAIN)])[0];
    expect(below!.decidedBySaturationAlone).toBe(false);
    expect(below!.confidence).not.toBe('certain');
    expect(at!.decidedBySaturationAlone).toBe(true);
    expect(at!.confidence).toBe('certain');
    expect(at!.partialGlazedScore).toBeGreaterThanOrEqual(GLAZED_THRESHOLD);
  });

  it('ignores a tile below the reporting point', () => {
    expect(glazingFindings([glare(0, REGION_SATURATION_REPORT - 0.01)])).toHaveLength(0);
    expect(glazingFindings([glare(0, REGION_SATURATION_REPORT)])).toHaveLength(1);
  });

  it('puts the worst one first, because the operator acts on one thing', () => {
    const out = glazingFindings([glare(0, 0.5), glare(5, 0.95), glare(9, 0.7)]);
    expect(out.map((f) => f.tile)).toEqual([5, 9, 0]);
    expect(out[0]!.where).toBe('centre');
  });
});

describe('depth discontinuities', () => {
  const coherent = (odd: number): TileDisplacement[] => {
    const tiles = Array.from({ length: 16 }, () => tile(6));
    tiles[5] = tile(odd);
    return tiles;
  };

  it('finds a tile moving differently from a coherent frame', () => {
    const tolPx = TILE_AGREEMENT_FRAC * WIDTH;
    const out = discontinuityFindings(coherent(6 + tolPx * 2), WIDTH, true);
    expect(out).toHaveLength(1);
    expect(out[0]!.tile).toBe(5);
    expect(out[0]!.disagreementWidths).toBeGreaterThan(TILE_AGREEMENT_FRAC);
  });

  it('never claims a mirror, and lists what else it could be', () => {
    const out = discontinuityFindings(coherent(6 + TILE_AGREEMENT_FRAC * WIDTH * 2), WIDTH, true);
    const f = out[0]!;
    expect(f.ambiguity.length).toBeGreaterThanOrEqual(3);
    expect(f.ambiguity.join(' ')).toContain('doorway');
    expect(f.ambiguity.join(' ')).toContain('mirror');
    // And there is no field that could be rendered as a detection.
    expect(Object.keys(f)).not.toContain('isMirror');
    expect(Object.keys(f)).not.toContain('score');
  });

  it('reports nothing while the frame as a whole is incoherent', () => {
    // During a shake every tile disagrees with every other and singling one out
    // is noise. The frame-level consensus is the gate.
    const out = discontinuityFindings(coherent(400), WIDTH, false);
    expect(out).toHaveLength(0);
  });

  it('ignores tiles that had nothing to match on', () => {
    const tiles = Array.from({ length: 16 }, () => tile(6));
    tiles[5] = tile(500, 0, 0.01);
    expect(discontinuityFindings(tiles, WIDTH, true)).toHaveLength(0);
  });

  it('declines to judge when too few tiles have an opinion', () => {
    const tiles: TileDisplacement[] = [tile(6), tile(6), tile(400), tile(0, 0, 0.01)];
    expect(discontinuityFindings(tiles, WIDTH, true)).toHaveLength(0);
  });

  it('reports nothing on a frame that is simply translating as one piece', () => {
    expect(discontinuityFindings(Array.from({ length: 16 }, () => tile(12)), WIDTH, true))
      .toHaveLength(0);
  });
});

describe('DiscontinuityWatch', () => {
  const finding = (t: number) => ({
    tile: t, where: 'centre', disagreementWidths: 0.1, ambiguity: ['a', 'b', 'c'],
  });

  it('holds a tile back until it has persisted', () => {
    const w = new DiscontinuityWatch(3);
    expect(w.step([finding(5)])).toHaveLength(0);
    expect(w.step([finding(5)])).toHaveLength(0);
    expect(w.step([finding(5)])).toHaveLength(1);
  });

  it('forgets a tile that stops disagreeing, so a passing hand does not qualify', () => {
    const w = new DiscontinuityWatch(3);
    w.step([finding(5)]);
    w.step([finding(5)]);
    w.step([]);
    expect(w.step([finding(5)])).toHaveLength(0);
  });

  it('tracks tiles independently', () => {
    const w = new DiscontinuityWatch(2);
    w.step([finding(1)]);
    const out = w.step([finding(1), finding(2)]);
    expect(out.map((f) => f.tile)).toEqual([1]);
  });
});

describe('operator declarations', () => {
  const at = (kind: 'mirror' | 'glazing' | 'television' | 'polished_floor', roomId: string) =>
    ({ kind, roomId, tMs: 1000, by: 'op-1' } as const);

  it('records who said it and when, and calls it a declaration', () => {
    const led = summariseDeclarations([at('mirror', 'bed1')]);
    expect(led.declarations[0]!.by).toBe('op-1');
    expect(led.declarations[0]!.tMs).toBe(1000);
    // Nothing in the shape invites a caller to treat it as a measurement.
    expect(Object.keys(led.declarations[0]!)).not.toContain('detected');
    expect(Object.keys(led.declarations[0]!)).not.toContain('confidence');
  });

  it('counts a television as a mirror, because a dark screen is one', () => {
    const led = summariseDeclarations([at('television', 'living')]);
    expect(led.roomsWithMirrors).toEqual(['living']);
  });

  it('separates glazing from mirrors and does not double-count a room', () => {
    const led = summariseDeclarations([
      at('mirror', 'bath'), at('mirror', 'bath'), at('glazing', 'living'),
    ]);
    expect(led.roomsWithMirrors).toEqual(['bath']);
    expect(led.roomsWithGlazing).toEqual(['living']);
  });

  it('is empty rather than absent when nothing was declared', () => {
    const led = summariseDeclarations([]);
    expect(led.roomsWithMirrors).toEqual([]);
    expect(led.roomsWithGlazing).toEqual([]);
  });
});
