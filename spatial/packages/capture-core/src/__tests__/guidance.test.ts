/**
 * The banner, the hysteresis, and the one thing it must never say.
 *
 * Two constraints fight in `guidance.ts` and the resolution is what makes the
 * app usable. Guidance has to be immediate, because a warning about a doorway
 * you have already walked through is a complaint. And it has to be quiet,
 * because five to ten minutes a property is the entire economic argument for
 * phone capture over a tripod — a system that stops someone every eight seconds
 * has rebuilt the tripod out of interruptions.
 *
 * So the tests here are mostly about restraint: one cue at a time, three frames
 * before it appears, eight and a held minimum before it goes, and the right one
 * chosen when several are true. Plus the assertion that matters more than any
 * of them: a bare "Good" is never shown when the analyser is behind.
 */

import { describe, expect, it } from 'vitest';
import type { BlurVerdict, FrameAnalysis } from '../types.js';
import type { MotionAssessment } from '../motion.js';
import type { OverlapState } from '../overlap.js';
import { GuidanceEngine, type GuidanceInput } from '../guidance.js';
import {
  BLOWN_FRACTION_ACT, CRUSHED_FRACTION_ACT, CUE_CLEAR_FRAMES, CUE_MIN_VISIBLE_MS,
  CUE_RAISE_FRAMES, TILE_DYNAMIC_RANGE_ACT,
} from '../thresholds.js';

const ANALYSIS: FrameAnalysis = {
  tMs: 0,
  sharpness: { vol: 1000, volNorm: 2 },
  exposure: {
    blownFraction: 0, crushedFraction: 0, meanLuma: 120,
    tileDynamicRange: 1, tileLuma: [],
  },
  glare: [],
  motion: { flowPx: 10, dxPx: 10, dyPx: 0, tileConsensus: 1, dtMs: 133, first: false },
  costMs: 20,
};

const OK_BLUR: BlurVerdict = { rejected: false, volNorm: 2, localMedian: 2, reason: '' };
const OK_MOTION: MotionAssessment = {
  band: 'good', candidateFlowPx: 96, candidateFracWidth: 0.1,
  candidateFracDiagonal: 0.087, rejectAtFracWidth: 0.1835, consensusOk: true,
};
const OK_OVERLAP: OverlapState = {
  kept: 10, keptThisFrame: false, pendingWidths: 0.1, band: 'tight',
  lastSeparationWidths: 0.31, lastOverlap: 0.69, totalWidths: 12, redundant: 2,
  gapOpen: false,
};

function frame(over: Partial<GuidanceInput> = {}, nowMs = 0): GuidanceInput {
  return {
    analysis: ANALYSIS,
    blur: OK_BLUR,
    motion: OK_MOTION,
    overlap: OK_OVERLAP,
    yawRateRadS: 0.2,
    maxYawRateRadS: 1.56,
    glazing: [],
    discontinuities: [],
    coverageHint: null,
    degraded: false,
    analysedFraction: 1,
    nowMs,
    ...over,
  };
}

/** Feed the same condition n times and return the last output. */
function hold(e: GuidanceEngine, over: Partial<GuidanceInput>, n: number, startMs = 0) {
  let out = e.step(frame(over, startMs));
  for (let i = 1; i < n; i += 1) out = e.step(frame(over, startMs + i * 100));
  return out;
}

describe('hysteresis', () => {
  it('waits for the cue to be true three times before showing it', () => {
    const e = new GuidanceEngine();
    const blurred: Partial<GuidanceInput> = {
      blur: { rejected: true, volNorm: 0.1, localMedian: 2, reason: 'x' },
    };
    expect(e.step(frame(blurred, 0)).primary.id).toBe('steady');
    expect(e.step(frame(blurred, 100)).primary.id).toBe('steady');
    expect(e.step(frame(blurred, 200)).primary.id).toBe('blur');
  });

  it('holds a cue on screen for at least CUE_MIN_VISIBLE_MS once shown', () => {
    // Shorter than this and a glancing operator misses it entirely, which is
    // worse than not showing it — they learn the banner is noise.
    const e = new GuidanceEngine();
    const blurred: Partial<GuidanceInput> = {
      blur: { rejected: true, volNorm: 0.1, localMedian: 2, reason: 'x' },
    };
    hold(e, blurred, CUE_RAISE_FRAMES, 0);
    let out = e.step(frame({}, 300));
    for (let i = 1; i <= CUE_CLEAR_FRAMES; i += 1) out = e.step(frame({}, 300 + i * 10));
    // Eight false frames have passed but only 80 ms of wall clock.
    expect(out.primary.id).toBe('blur');
    out = e.step(frame({}, 300 + CUE_MIN_VISIBLE_MS + 50));
    expect(out.primary.id).toBe('steady');
  });

  it('gives the motion-consensus cue longer, because a translation fit is strict', () => {
    // frames.py measures tracks against a HOMOGRAPHY; the phone measures tiles
    // against a TRANSLATION, which real perspective change through a doorway
    // breaks. So the same 0.55 is used but the cue needs persistence.
    const e = new GuidanceEngine();
    const shaky: Partial<GuidanceInput> = {
      motion: { ...OK_MOTION, band: 'incoherent', consensusOk: false },
    };
    const atRaise = hold(e, shaky, CUE_RAISE_FRAMES);
    expect(atRaise.primary.id).toBe('steady');
    const later = hold(e, shaky, 2, CUE_RAISE_FRAMES * 100);
    expect(later.primary.id).toBe('too_fast');
    expect(later.primary.headline).toBe('Hold steadier');
  });
});

describe('choosing one cue from several', () => {
  it('puts blur first, because its cost is out of proportion to how it looks', () => {
    const e = new GuidanceEngine();
    const out = hold(e, {
      blur: { rejected: true, volNorm: 0.1, localMedian: 2, reason: 'x' },
      motion: { ...OK_MOTION, band: 'rejected' },
      analysis: { ...ANALYSIS, exposure: { ...ANALYSIS.exposure, blownFraction: 0.5 } },
    }, CUE_RAISE_FRAMES);
    expect(out.primary.id).toBe('blur');
    // Everything true is still available for the post-capture summary.
    expect(out.active.map((c) => c.id)).toContain('too_fast');
    expect(out.active.map((c) => c.id)).toContain('blown');
  });

  it('shows exactly one primary cue however many are true', () => {
    const e = new GuidanceEngine();
    const out = hold(e, {
      blur: { rejected: true, volNorm: 0.1, localMedian: 2, reason: 'x' },
      motion: { ...OK_MOTION, band: 'rejected' },
      overlap: { ...OK_OVERLAP, gapOpen: true },
      coverageHint: 'Kitchen not started',
    }, CUE_RAISE_FRAMES);
    expect(out.primary).toBeDefined();
    expect(out.active.length).toBeGreaterThan(1);
  });
});

describe('turning and moving are different failures', () => {
  it('says turn slower, not slow down, when the rejection came from a pan', () => {
    // Telling someone standing still to "slow down" while they pan is how an
    // operator learns the banner is noise.
    const e = new GuidanceEngine();
    const out = hold(e, {
      motion: { ...OK_MOTION, band: 'rejected' },
      yawRateRadS: 2.5,
      maxYawRateRadS: 1.56,
    }, CUE_RAISE_FRAMES);
    expect(out.primary.id).toBe('turning_fast');
    expect(out.active.map((c) => c.id)).not.toContain('too_fast');
  });

  it('says slow down when the camera was not turning', () => {
    const e = new GuidanceEngine();
    const out = hold(e, {
      motion: { ...OK_MOTION, band: 'rejected' }, yawRateRadS: 0.1,
    }, CUE_RAISE_FRAMES);
    expect(out.primary.id).toBe('too_fast');
    expect(out.primary.headline).toBe('Slow down');
  });

  it('still says hold steadier for incoherent motion, whatever the yaw says', () => {
    // A shake is not a pace problem and not a turning problem, and both of the
    // other corrections are useless against it.
    const e = new GuidanceEngine();
    const out = hold(e, {
      motion: { ...OK_MOTION, band: 'incoherent', consensusOk: false }, yawRateRadS: 3,
    }, 6);
    expect(out.active.map((c) => c.id)).toContain('too_fast');
    expect(out.active.find((c) => c.id === 'too_fast')!.headline).toBe('Hold steadier');
  });

  it('says nothing about turning on a device with no orientation', () => {
    const e = new GuidanceEngine();
    const out = hold(e, { yawRateRadS: null }, 10);
    expect(out.active.map((c) => c.id)).not.toContain('turning_fast');
  });
});

describe('the overlap gap', () => {
  it('tells the operator to go back, not to slow down', () => {
    // Every candidate since the last kept frame was thrown away while the
    // camera kept going. Walking slower from here does not close the hole.
    const e = new GuidanceEngine();
    const out = hold(e, {
      overlap: { ...OK_OVERLAP, gapOpen: true, pendingWidths: 0.8 },
    }, CUE_RAISE_FRAMES);
    expect(out.primary.id).toBe('overlap_gap');
    expect(out.primary.headline).toBe('Go back');
    expect(out.primary.detail).toContain('0.8');
  });

  it('does not fire on a correctly paced walk', () => {
    const e = new GuidanceEngine();
    const out = hold(e, {}, 20);
    expect(out.active.map((c) => c.id)).not.toContain('overlap_gap');
  });
});

describe('light and glass', () => {
  it('acts on a blown-out window and only advises on a bright one', () => {
    const e1 = new GuidanceEngine();
    const act = hold(e1, {
      analysis: {
        ...ANALYSIS,
        exposure: { ...ANALYSIS.exposure, blownFraction: BLOWN_FRACTION_ACT + 0.05 },
      },
    }, CUE_RAISE_FRAMES);
    expect(act.active.find((c) => c.id === 'blown')!.level).toBe('act');

    const e2 = new GuidanceEngine();
    const advise = hold(e2, {
      analysis: { ...ANALYSIS, exposure: { ...ANALYSIS.exposure, blownFraction: 0.15 } },
    }, CUE_RAISE_FRAMES);
    expect(advise.active.find((c) => c.id === 'blown')!.level).toBe('advise');
  });

  it('names where the glazing is, in words', () => {
    const e = new GuidanceEngine();
    const out = hold(e, {
      glazing: [{
        tile: 3, where: 'top right', saturation: 0.95, partialGlazedScore: 0.475,
        pipelineThreshold: 0.45, confidence: 'certain', decidedBySaturationAlone: true,
      }],
    }, CUE_RAISE_FRAMES);
    const cue = out.active.find((c) => c.id === 'glare')!;
    expect(cue.detail).toContain('top right');
    expect(cue.level).toBe('act');
  });

  it('asks about a mirror rather than announcing one', () => {
    // The phone has none of the three signals reflective_score is built from.
    const e = new GuidanceEngine();
    const out = hold(e, {
      discontinuities: [{
        tile: 5, where: 'centre', disagreementWidths: 0.05,
        ambiguity: ['a doorway', 'something close', 'a mirror'],
      }],
    }, CUE_RAISE_FRAMES);
    const cue = out.active.find((c) => c.id === 'reflection')!;
    expect(cue.headline).toContain('?');
    expect(cue.detail).toContain('cannot tell which');
    expect(cue.level).toBe('advise');
  });

  it('advises on a dark room and on uneven light', () => {
    const e1 = new GuidanceEngine();
    expect(hold(e1, {
      analysis: {
        ...ANALYSIS,
        exposure: { ...ANALYSIS.exposure, crushedFraction: CRUSHED_FRACTION_ACT + 0.05 },
      },
    }, CUE_RAISE_FRAMES).active.map((c) => c.id)).toContain('too_dark');

    const e2 = new GuidanceEngine();
    expect(hold(e2, {
      analysis: {
        ...ANALYSIS,
        exposure: { ...ANALYSIS.exposure, tileDynamicRange: TILE_DYNAMIC_RANGE_ACT + 1 },
      },
    }, CUE_RAISE_FRAMES).active.map((c) => c.id)).toContain('uneven_light');
  });

  it('does not report uneven light when the frame is simply blown out', () => {
    // One message, one correction. The blown cue already says to turn away.
    const e = new GuidanceEngine();
    const out = hold(e, {
      analysis: {
        ...ANALYSIS,
        exposure: {
          ...ANALYSIS.exposure,
          blownFraction: BLOWN_FRACTION_ACT + 0.1,
          tileDynamicRange: TILE_DYNAMIC_RANGE_ACT + 2,
        },
      },
    }, CUE_RAISE_FRAMES);
    expect(out.active.map((c) => c.id)).not.toContain('uneven_light');
  });
});

describe('never a green banner computed from a third of the frames', () => {
  it('qualifies the steady cue with the fraction actually checked', () => {
    const e = new GuidanceEngine();
    const out = e.step(frame({ analysedFraction: 0.33 }));
    expect(out.primary.id).toBe('steady');
    expect(out.primary.detail).toContain('33%');
  });

  it('leaves the steady cue unqualified when every frame was checked', () => {
    const e = new GuidanceEngine();
    const out = e.step(frame({ analysedFraction: 1, coverageHint: 'Kitchen next' }));
    expect(out.primary.detail).toBe('Kitchen next');
  });

  it('shows the rate as a ratio a walking person can read', () => {
    const e = new GuidanceEngine();
    const out = hold(e, { degraded: true, analysedFraction: 0.33 }, CUE_RAISE_FRAMES);
    const cue = out.active.find((c) => c.id === 'degraded')!;
    expect(cue.headline).toBe('1 frame in 3');
    expect(cue.detail).toContain('33%');
    expect(out.degraded).toBe(true);
  });

  it('says it is not checking at all rather than dividing by zero', () => {
    const e = new GuidanceEngine();
    const out = hold(e, { degraded: true, analysedFraction: 0 }, CUE_RAISE_FRAMES);
    expect(out.active.find((c) => c.id === 'degraded')!.headline).toBe('Not checking frames');
  });
});

describe('coverage', () => {
  it('is last, because it is the only failure that can be fixed by walking back', () => {
    const e = new GuidanceEngine();
    const out = hold(e, {
      coverageHint: 'Kitchen not started',
      analysis: { ...ANALYSIS, exposure: { ...ANALYSIS.exposure, crushedFraction: 0.5 } },
    }, CUE_RAISE_FRAMES);
    expect(out.primary.id).toBe('too_dark');
    expect(out.active.map((c) => c.id)).toContain('coverage');
  });

  it('remembers the last cue for a screen that re-renders without a frame', () => {
    const e = new GuidanceEngine();
    expect(e.current).toBeNull();
    e.step(frame());
    expect(e.current?.id).toBe('steady');
  });
});
