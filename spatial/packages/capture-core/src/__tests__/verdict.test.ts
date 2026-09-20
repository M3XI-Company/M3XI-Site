/**
 * The go / no-go, and its agreement with the thresholds the pipeline will use.
 *
 * Each case here trips exactly one pipeline constant and asserts the verdict
 * that constant implies, so a change to the pipeline's behaviour shows up as a
 * named failure rather than a shifted total. The mapping is not uniform and the
 * distinctions are the point:
 *
 *   a StageError      -> 'no_go'. There is no world at all and the visit is
 *                        wasted, so the operator must not leave.
 *   a failed check    -> 'fix'. The world builds and routes to an operator,
 *                        which costs console time, not another appointment.
 *   a stage warning   -> a note. It builds, it passes, somebody should know.
 *
 * And the last group is the one that is easiest to leave out: when the phone
 * could not keep up, the verdict cannot say 'go'. The blur rule is a comparison
 * against a rolling median, and a median over a third of the candidates is not
 * the statistic `mark_blur` will compute. The report still carries every figure
 * that WAS measured — that is what lets an operator judge for themselves — and
 * the shortfall appears as a finding with the fraction in it.
 */

import { describe, expect, it } from 'vitest';
import type { CoverageSnapshot, PlannedRoom, RoomCoverage } from '../types.js';
import { NOT_ASSESSABLE_ON_DEVICE, analysisConfidence, buildVerdict, verdictFigures } from '../verdict.js';
import { summariseDeclarations } from '../reflective.js';
import {
  ABSOLUTE_MIN_FRAMES, MAX_DURATION_S, MIN_DURATION_S, MIN_FRAMES, MIN_SHORT_EDGE,
  MIN_SOURCE_FPS, MIN_TRANSLATION_SHARE, QUALITY_BLUR_REJECTION_RATE,
  TARGET_DISPLACEMENT_FRAC, VERDICT_MIN_ANALYSED_FRACTION,
} from '../thresholds.js';

const ROOMS: PlannedRoom[] = [
  { id: 'hall', name: 'Hall', kind: 'hall', level: 0, isEntrance: true },
  { id: 'living', name: 'Living room', kind: 'living', level: 0, isEntrance: false },
  { id: 'kitchen', name: 'Kitchen', kind: 'kitchen', level: 0, isEntrance: false },
  { id: 'bed1', name: 'Bedroom 1', kind: 'bedroom', level: 1, isEntrance: false },
];

function room(id: string, over: Partial<RoomCoverage> = {}): RoomCoverage {
  return {
    roomId: id, state: 'done', seconds: 30, candidates: 300,
    rejectedBlur: 10, rejectedMotion: 0, rejected: 10,
    widths: 12, translationWidths: 9, predictedFrames: 40, yawCoverage: 0.9,
    yawBins: [], medianVolNorm: 2, glareSeconds: 0, gaps: [], ...over,
  };
}

function snapshot(over: Partial<CoverageSnapshot> = {}): CoverageSnapshot {
  const rooms = over.rooms ?? ROOMS.map((r) => room(r.id));
  return {
    totalSeconds: 120,
    totalCandidates: 1200,
    totalRejectedBlur: 60,
    totalRejectedMotion: 0,
    totalRejected: 60,
    totalWidths: 150,
    totalTranslationWidths: 110,
    predictedFrames: 400,
    blurRejectionRate: 0.05,
    motionRejectionRate: 0,
    entranceRevisited: true,
    doorwaysCrossed: 5,
    hasOrientation: true,
    ...over,
    rooms,
  };
}

function input(over: Partial<Parameters<typeof buildVerdict>[0]> = {}) {
  return {
    durationS: 120,
    width: 1920,
    height: 1080,
    fps: 30,
    coverage: snapshot(),
    rooms: ROOMS,
    analysis: analysisConfidence(900, 120, false),
    surfaces: summariseDeclarations([]),
    keptFrames: 300,
    ...over,
  };
}

describe('a clean capture', () => {
  it('says go, with no findings', () => {
    const r = buildVerdict(input());
    expect(r.verdict).toBe('go');
    expect(r.findings).toEqual([]);
    expect(r.headline).toContain('Nothing found');
  });

  it('still names every check it could not make', () => {
    // A verdict that silently covers four of twelve checks and presents itself
    // as a verdict is worse than none, because the operator stops looking.
    const r = buildVerdict(input());
    expect(r.notAssessed.length).toBe(NOT_ASSESSABLE_ON_DEVICE.length);
    expect(r.notAssessed.length).toBeGreaterThan(r.findings.length);
    expect(r.notAssessed.join(' ')).toContain('scale_agreement');
    expect(r.notAssessed.join(' ')).toContain('redaction_completeness');
    for (const line of r.notAssessed) expect(line).toContain(':');
  });
});

describe('ingest.py refusals are no_go', () => {
  it('refuses a capture shorter than MIN_DURATION_S', () => {
    const r = buildVerdict(input({ durationS: MIN_DURATION_S - 1 }));
    expect(r.verdict).toBe('no_go');
    const f = r.findings.find((x) => x.check === 'ingest.MIN_DURATION_S')!;
    expect(f.severity).toBe('blocking');
    expect(f.threshold).toBe(MIN_DURATION_S);
  });

  it('refuses a recording below MIN_SHORT_EDGE', () => {
    const r = buildVerdict(input({ width: 1280, height: 720 }));
    expect(r.verdict).toBe('no_go');
    const f = r.findings.find((x) => x.check === 'ingest.MIN_SHORT_EDGE')!;
    expect(f.measured).toBe(720);
    expect(f.threshold).toBe(MIN_SHORT_EDGE);
  });

  it('accepts a portrait recording whose short edge is the width', () => {
    // ingest.py takes min(width, height) after baking in rotation, so portrait
    // is fine and this must not be a resolution failure.
    const r = buildVerdict(input({ width: 1080, height: 1920 }));
    expect(r.findings.some((f) => f.check === 'ingest.MIN_SHORT_EDGE')).toBe(false);
  });
});

describe('ingest.py warnings are notes, not blockers', () => {
  it('notes an over-long capture without refusing it', () => {
    const r = buildVerdict(input({ durationS: MAX_DURATION_S + 60 }));
    const f = r.findings.find((x) => x.check === 'ingest.MAX_DURATION_S')!;
    expect(f.severity).toBe('note');
    expect(r.verdict).toBe('go');
  });

  it('notes a low source frame rate', () => {
    const r = buildVerdict(input({ fps: MIN_SOURCE_FPS - 4 }));
    expect(r.findings.find((x) => x.check === 'ingest.MIN_FPS')!.severity).toBe('note');
    expect(r.verdict).toBe('go');
  });
});

describe('the frame budget', () => {
  it('refuses a capture that will not survive frame selection', () => {
    const r = buildVerdict(input({ keptFrames: ABSOLUTE_MIN_FRAMES - 1 }));
    expect(r.verdict).toBe('no_go');
    const f = r.findings.find((x) => x.check === 'frames.ABSOLUTE_MIN_FRAMES')!;
    expect(f.severity).toBe('blocking');
    expect(r.predictedFrames).toBe(ABSOLUTE_MIN_FRAMES - 1);
  });

  it('sends a thin but viable capture for correction', () => {
    const r = buildVerdict(input({ keptFrames: MIN_FRAMES - 50 }));
    expect(r.verdict).toBe('fix');
    expect(r.findings.find((x) => x.check === 'frames.MIN_FRAMES')!.severity).toBe('review');
  });

  it('prefers the live tracker\'s count over the closed-form prediction', () => {
    // The tracker walked the real sequence; the prediction assumes travel was
    // evenly spread and is an upper bound. Where they differ the tracker wins.
    const withTracker = buildVerdict(input({ keptFrames: 210 }));
    const withoutTracker = buildVerdict(input({ keptFrames: null }));
    expect(withTracker.predictedFrames).toBe(210);
    expect(withoutTracker.predictedFrames).not.toBe(210);
  });

  it('falls back to the model when no tracker was run', () => {
    // 150 widths at the 0.30 target is 500 frames, capped by the candidates
    // that survived: 120 s * 7.5 * 0.95 = 855, so travel binds at 500 and the
    // MAX_FRAMES cap brings it to 400.
    const r = buildVerdict(input({ keptFrames: null }));
    expect(r.predictedFrames).toBe(Math.min(400, Math.floor(150 / TARGET_DISPLACEMENT_FRAC)));
    expect(r.verdict).toBe('go');
  });
});

describe('quality.py checks', () => {
  it('sends a blurry capture for correction at the quality threshold', () => {
    const r = buildVerdict(input({
      coverage: snapshot({ blurRejectionRate: QUALITY_BLUR_REJECTION_RATE + 0.05 }),
    }));
    expect(r.verdict).toBe('fix');
    const f = r.findings.find((x) => x.check === 'quality.blur_rejection_rate')!;
    expect(f.higherIsBetter).toBe(false);
    expect(f.threshold).toBe(QUALITY_BLUR_REJECTION_RATE);
  });

  it('only notes a blur rate between the frames.py warning and the quality gate', () => {
    const r = buildVerdict(input({ coverage: snapshot({ blurRejectionRate: 0.27 }) }));
    expect(r.verdict).toBe('go');
    expect(r.findings.find((x) => x.check === 'frames.blur_fraction_warning')!.severity)
      .toBe('note');
  });

  it('refuses to let the operator leave with a room never filmed', () => {
    // navigation_continuity is exactly 1.0 in quality.py, and nothing
    // downstream can add a room that has no frames in it. This is the one
    // failure that is certainly a second appointment.
    const rooms = ROOMS.map((r) => room(r.id, r.id === 'bed1' ? { state: 'not_started' } : {}));
    const r = buildVerdict(input({ coverage: snapshot({ rooms }) }));
    expect(r.verdict).toBe('no_go');
    const f = r.findings.find((x) => x.check === 'quality.navigation_continuity')!;
    expect(f.severity).toBe('blocking');
    expect(f.action).toContain('Bedroom 1');
  });

  it('names the worst room when completeness is short', () => {
    const rooms = [
      room('hall'), room('living'),
      room('kitchen', { state: 'thin', widths: 3, gaps: ['Walk further in here.'] }),
      room('bed1', { state: 'thin', widths: 1, gaps: ['Mostly turning on the spot here.'] }),
    ];
    const r = buildVerdict(input({ coverage: snapshot({ rooms }) }));
    expect(r.verdict).toBe('fix');
    const f = r.findings.find((x) => x.check === 'quality.room_completeness')!;
    expect(f.measured).toBeCloseTo(0.5, 6);
    expect(f.action).toContain('Bedroom 1');
  });

  it('does not double-report completeness when a room was never entered', () => {
    // An unfilmed room already fails continuity, and saying the same thing
    // twice in different words is how a findings list stops being read.
    const rooms = ROOMS.map((r) => room(r.id, r.id === 'bed1' ? { state: 'not_started' } : {}));
    const r = buildVerdict(input({ coverage: snapshot({ rooms }) }));
    expect(r.findings.filter((f) => f.check === 'quality.room_completeness')).toHaveLength(0);
  });
});

describe('the failure frames.py cannot see', () => {
  it('catches a property shot as a series of panoramas', () => {
    const r = buildVerdict(input({
      coverage: snapshot({
        totalWidths: 100,
        totalTranslationWidths: 20,
        rooms: ROOMS.map((x) => room(x.id, { widths: 25, translationWidths: 5 })),
      }),
    }));
    expect(r.verdict).toBe('fix');
    const f = r.findings.find((x) => x.check === 'capture.translation_share')!;
    expect(f.measured).toBeCloseTo(0.2, 6);
    expect(f.threshold).toBe(MIN_TRANSLATION_SHARE);
    expect(f.action).toContain('Living room');
  });

  it('says nothing about it when the device gave no orientation', () => {
    // Without a gyro, walking and turning cannot be separated. Reporting a
    // share of zero would be a measurement that was never made.
    const r = buildVerdict(input({
      coverage: snapshot({ totalTranslationWidths: null, hasOrientation: false }),
    }));
    expect(r.findings.some((f) => f.check === 'capture.translation_share')).toBe(false);
    expect(verdictFigures(input({
      coverage: snapshot({ totalTranslationWidths: null, hasOrientation: false }),
    }), r).join(' ')).toContain('not measured');
  });

  it('notes an unclosed loop', () => {
    const r = buildVerdict(input({ coverage: snapshot({ entranceRevisited: false }) }));
    expect(r.findings.find((x) => x.check === 'capture.loop_closure')!.severity).toBe('note');
    expect(r.verdict).toBe('go');
  });
});

describe('a verdict computed from a fraction of the frames', () => {
  it('cannot say go', () => {
    const r = buildVerdict(input({ analysis: analysisConfidence(300, 120, false) }));
    expect(r.verdict).toBe('fix');
    const f = r.findings.find((x) => x.check === 'capture.analysis_coverage')!;
    expect(f.threshold).toBe(VERDICT_MIN_ANALYSED_FRACTION);
    expect(f.measured).toBeCloseTo(300 / (120 * 7.5), 6);
  });

  it('puts the figure the operator can see in the wording', () => {
    const r = buildVerdict(input({ analysis: analysisConfidence(300, 120, false) }));
    const f = r.findings.find((x) => x.check === 'capture.analysis_coverage')!;
    expect(f.action).toContain('33%');
    expect(f.action).toContain('indicative');
  });

  it('caps the verdict when the pace controller gave up, whatever the count says', () => {
    const r = buildVerdict(input({ analysis: analysisConfidence(900, 120, true) }));
    expect(r.verdict).toBe('fix');
  });

  it('still reports every figure it did measure', () => {
    // The point of showing the shortfall is that the measurements remain
    // useful. Suppressing them would leave the operator with nothing at all.
    const i = input({ analysis: analysisConfidence(300, 120, false) });
    const r = buildVerdict(i);
    const figures = verdictFigures(i, r).join('\n');
    expect(figures).toContain('Travel:');
    expect(figures).toContain('Frames predicted to survive selection: 300');
    expect(figures).toContain('Frames rejected as blurred: 5%');
    expect(figures).toContain('33% of the 900');
    // And the headline is the ordinary review one, because a partial analysis
    // IS a review finding. There is deliberately no fourth "nothing found, but
    // only from a sample" headline: no input can reach that state, and a line
    // of reassurance nothing can produce would still read as one that can.
    expect(r.headline).toContain('send it to an operator');
  });

  it('says go at full coverage, with no confidence finding at all', () => {
    const r = buildVerdict(input({ analysis: analysisConfidence(900, 120, false) }));
    expect(r.findings.some((f) => f.check === 'capture.analysis_coverage')).toBe(false);
    expect(r.verdict).toBe('go');
  });
});

describe('analysisConfidence', () => {
  it('measures against the pipeline\'s candidate count, not the app\'s target', () => {
    // "What fraction of what the pipeline will look at did we look at" is the
    // only version of the question that means anything. An app that lowered its
    // own target and then met it has answered a different one.
    const c = analysisConfidence(450, 120, false);
    expect(c.expectedCandidates).toBe(900);
    expect(c.fraction).toBeCloseTo(0.5, 10);
  });

  it('does not report more than everything', () => {
    expect(analysisConfidence(5000, 120, false).fraction).toBe(1);
  });

  it('reports nothing rather than NaN on a zero-length capture', () => {
    expect(analysisConfidence(0, 0, false).fraction).toBe(0);
  });
});

describe('several failures at once', () => {
  it('lets the worst one decide, and keeps the rest', () => {
    const rooms = ROOMS.map((r) => room(r.id, r.id === 'bed1' ? { state: 'not_started' } : {}));
    const r = buildVerdict(input({
      durationS: 20,
      coverage: snapshot({ rooms, blurRejectionRate: 0.5, entranceRevisited: false }),
      keptFrames: 30,
      analysis: analysisConfidence(50, 20, true),
    }));
    expect(r.verdict).toBe('no_go');
    expect(r.findings.filter((f) => f.severity === 'blocking').length).toBeGreaterThanOrEqual(3);
    expect(r.findings.some((f) => f.severity === 'review')).toBe(true);
    expect(r.findings.some((f) => f.severity === 'note')).toBe(true);
    expect(r.headline).toContain('Do not leave yet');
  });
});
