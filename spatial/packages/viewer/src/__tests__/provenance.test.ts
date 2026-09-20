import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type { Quat } from '@m3xi/world-core';
import {
  classifyEntity, classifyPoint, classifyRoom, classifyViewpoint, coverageSummary,
  DISPLAY_CLASS_OF, DISPLAY_STYLE,
} from '../provenance/classify.js';
import { poseQuat } from '../types.js';

const world = World.fromDocument(FLAT);

describe('the display vocabulary', () => {
  it('collapses four contract provenances onto three treatments', () => {
    expect(DISPLAY_CLASS_OF.observed).toBe('real');
    expect(DISPLAY_CLASS_OF.reconstructed).toBe('real');
    expect(DISPLAY_CLASS_OF.inferred).toBe('estimated');
    expect(DISPLAY_CLASS_OF.generated).toBe('unsurveyed');
  });

  it('hatches everything that is not real, and nothing that is', () => {
    expect(DISPLAY_STYLE.real.hatchPitch).toBe(0);
    expect(DISPLAY_STYLE.estimated.hatchPitch).toBeGreaterThan(0);
    expect(DISPLAY_STYLE.unsurveyed.hatchPitch).toBeGreaterThan(0);
    // Unsurveyed is the heavier mark and the only one with a boundary line.
    expect(DISPLAY_STYLE.unsurveyed.hatchAlpha).toBeGreaterThan(DISPLAY_STYLE.estimated.hatchAlpha);
    expect(DISPLAY_STYLE.unsurveyed.boundary).toBe(true);
    expect(DISPLAY_STYLE.estimated.boundary).toBe(false);
  });

  it('describes each class in plain English with no alarm language', () => {
    for (const style of Object.values(DISPLAY_STYLE)) {
      expect(style.description.length).toBeGreaterThan(20);
      expect(style.description.toLowerCase()).not.toMatch(/warning|error|danger|fault/);
    }
  });
});

describe('classifying a point', () => {
  it('reports an ordinary hall point as real and observed', () => {
    const p = classifyPoint(world, [5.3, 1.6, 3.2]);
    expect(p.display).toBe('real');
    expect(p.observed).toBe(true);
    expect(p.roomId).toBe('r_hall');
    expect(p.regions).toHaveLength(0);
    expect(p.headline).toContain('Hall');
  });

  it('reports a point in the generated bedroom corner as unsurveyed, with the reason', () => {
    const p = classifyPoint(world, [10.3, 1.2, 2.7]);
    expect(p.display).toBe('unsurveyed');
    expect(p.observed).toBe(false);
    expect(p.provenance).toBe('generated');
    expect(p.regions.map((r) => r.id)).toContain('rg_bed1_far_corner');
    expect(p.headline).toMatch(/occluded by the wardrobe/);
  });

  it('reports the inferred bathroom ceiling as estimated, not unsurveyed', () => {
    const p = classifyPoint(world, [3.5, 2.25, 5.1]);
    expect(p.display).toBe('estimated');
    expect(p.provenance).toBe('inferred');
    expect(p.regions[0]?.id).toBe('rg_bath_ceiling');
  });

  it('orders overlapping regions worst first', () => {
    const p = classifyPoint(world, [10.3, 1.2, 2.7]);
    if (p.regions.length > 1) {
      expect(p.regions[0]!.provenance).toBe('generated');
    }
    expect(p.regions.length).toBeGreaterThan(0);
  });
});

describe('classifying a viewpoint', () => {
  const look = (pos: [number, number, number], yaw: number): Quat =>
    poseQuat({ position: pos, yaw, pitch: 0 });

  it('a viewpoint seeing only fully surveyed space reports nothing', () => {
    // Deep in the kitchen's west leg, facing the outside wall: the only room
    // in view is the kitchen, which has no declared gaps.
    const pos: [number, number, number] = [1.45, 1.6, 3.4];
    const v = classifyViewpoint(world, { position: pos, orientation: look(pos, Math.PI / 2) });
    expect(v.display).toBe('real');
    expect(v.worstVisible).toBe('real');
    expect(v.showsUnsurveyed).toBe(false);
    expect(v.unsurveyedInView).toHaveLength(0);
  });

  it('reports a gap in a room you can only see into, not just the one you are in', () => {
    // Standing in the hall, bedroom 1's doorway is in shot, and bedroom 1 has
    // an unsurveyed corner. Being conservative here is the point: the visitor
    // is looking at that room even though their feet are somewhere honest.
    const pos: [number, number, number] = [5.3, 1.6, 3.2];
    const v = classifyViewpoint(world, { position: pos, orientation: look(pos, 0) });
    expect(v.display).toBe('real');
    expect(v.showsUnsurveyed).toBe(true);
    expect(v.unsurveyedInView.map((r) => r.id)).toContain('rg_bed1_far_corner');
  });

  it('standing on real floor but looking into a room with an unsurveyed corner reports it', () => {
    // Inside bedroom 1, which carries rg_bed1_far_corner.
    const pos: [number, number, number] = [7.5, 1.6, 1.8];
    const v = classifyViewpoint(world, { position: pos, orientation: look(pos, -Math.PI / 2) });
    expect(v.display).toBe('real');           // the visitor's own feet are fine
    expect(v.showsUnsurveyed).toBe(true);     // what they can see is not
    expect(v.worstVisible).toBe('unsurveyed');
    expect(v.unsurveyedInView.map((r) => r.id)).toContain('rg_bed1_far_corner');
  });

  it('carries the point classification through unchanged', () => {
    const pos: [number, number, number] = [10.3, 1.2, 2.7];
    const v = classifyViewpoint(world, { position: pos, orientation: look(pos, 0) });
    expect(v.display).toBe('unsurveyed');
    expect(v.observed).toBe(false);
  });
});

describe('classifying rooms and entities', () => {
  it('marks bedroom 1 as containing an unsurveyed area', () => {
    const r = classifyRoom(world, 'r_bed1');
    expect(r.display).toBe('unsurveyed');
    expect(r.regions.map((x) => x.id)).toEqual(['rg_bed1_far_corner']);
  });

  it('leaves a fully surveyed room alone', () => {
    const r = classifyRoom(world, 'r_kitchen');
    expect(r.display).toBe('real');
    expect(r.regions).toHaveLength(0);
  });

  it('marks an entity whose dimensions were inferred', () => {
    const chest = world.entity('e_chest_drawers')!;
    const c = classifyEntity(chest);
    expect(c.display).toBe('estimated');
    expect(c.note).toContain('depth estimated from the class prior');
  });

  it('reports how many frames established an observed entity', () => {
    const sofa = world.entity('e_sofa')!;
    const c = classifyEntity(sofa);
    expect(c.display).toBe('real');
    expect(c.note).toMatch(/Seen in \d+ frames/);
  });
});

describe('coverage summary', () => {
  const summary = coverageSummary(world);

  it('derives the observed fraction from the pipeline quality check, not a guess', () => {
    expect(summary.observedFraction).toBeCloseTo(1 - 0.041, 6);
  });

  it('lists every generated and inferred region separately', () => {
    expect([...summary.unsurveyedRegions.map((r) => r.id)].sort())
      .toEqual(['rg_bed1_far_corner', 'rg_hall_ceiling_void']);
    expect(summary.estimatedRegions.map((r) => r.id)).toEqual(['rg_bath_ceiling']);
  });

  it('names the rooms with gaps', () => {
    expect([...summary.roomsWithGaps].sort()).toEqual(['r_bath', 'r_bed1']);
  });

  it('states coverage as a sentence safe to show a customer', () => {
    expect(summary.headline).toContain('96% of this property was photographed');
    expect(summary.headline).toContain('2 areas were not');
  });

  it('passes the pipeline verdict through rather than softening it', () => {
    expect(summary.qualityVerdict).toBe('review');
  });

  it('never invents a percentage when the pipeline published none', () => {
    const stripped = World.fromDocument({
      ...FLAT,
      quality: { ...FLAT.quality, checks: [] },
    });
    const s = coverageSummary(stripped);
    expect(s.observedFraction).toBeUndefined();
    expect(s.headline).not.toMatch(/\d+%/);
    expect(s.headline).toContain('Parts of this property were not photographed');
  });
});
