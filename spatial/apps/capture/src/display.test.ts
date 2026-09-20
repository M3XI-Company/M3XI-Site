/**
 * The mapping from what was measured to what is on screen.
 *
 * The fixtures below are partial `FrameResult`s, cast at the boundary. That is
 * deliberate rather than lazy: `liveView` reads five of its fields, a full
 * fixture would need a `FrameAnalysis`, a `MotionAssessment` and an
 * `OverlapState` whose values nothing here looks at, and a reader would then
 * have to work out which of the forty numbers mattered. The cast is confined
 * to one helper and the helper names exactly what the function consumes.
 */

import { describe, expect, it } from 'vitest';
import type { Cue, CueLevel, CoverageSnapshot, FrameResult, Orientation, PlannedRoom } from '@m3xi/capture-core';
import {
  confidenceView, describeFraction, figureFor, liveView, overrunning, roomChips, toneOf, yawView,
} from './display.js';

const THRESHOLDS = { minAnalysedFraction: 0.6 };

function cue(id: string, level: CueLevel, headline: string, detail: string): Cue {
  return { id: id as Cue['id'], level, headline, detail, since: 0 };
}

function frame(parts: {
  cue: Cue; active?: readonly Cue[]; analysedFraction: number; degraded: boolean;
  glazing?: readonly { where: string }[];
}): FrameResult {
  return {
    cue: parts.cue,
    active: parts.active ?? [parts.cue],
    analysedFraction: parts.analysedFraction,
    degraded: parts.degraded,
    glazing: parts.glazing ?? [],
  } as unknown as FrameResult;
}

describe('describeFraction', () => {
  it('says "every frame" when nothing was missed', () => {
    expect(describeFraction(1)).toBe('Checking every frame');
  });

  it('gives a ratio a walking person can read, not a percentage', () => {
    expect(describeFraction(0.5)).toBe('Checking 1 frame in 2');
    expect(describeFraction(0.33)).toBe('Checking 1 frame in 3');
    expect(describeFraction(0.2)).toBe('Checking 1 frame in 5');
  });

  it('does not claim to be checking frames when it is checking none', () => {
    expect(describeFraction(0)).toBe('Checking no frames');
  });
});

describe('confidenceView', () => {
  it('is quiet when the phone is keeping up', () => {
    const v = confidenceView(1, false, THRESHOLDS);
    expect(v.tone).toBe('ok');
    expect(v.belowVerdictFloor).toBe(false);
    expect(v.label).toBe('Checking every frame');
  });

  it('shouts when the session says the analyser is degraded', () => {
    const v = confidenceView(0.8, true, THRESHOLDS);
    expect(v.tone).toBe('act');
    expect(v.detail).toMatch(/falling behind/);
  });

  it('shouts when the fraction is below the threshold the verdict will use', () => {
    const v = confidenceView(0.4, false, THRESHOLDS);
    expect(v.tone).toBe('act');
    expect(v.belowVerdictFloor).toBe(true);
    expect(v.detail).toMatch(/40%/);
  });

  it('is advisory in the band between comfortable and failing', () => {
    expect(confidenceView(0.8, false, THRESHOLDS).tone).toBe('advise');
  });

  it('clamps a fraction that arrives outside 0-1 instead of printing 120%', () => {
    expect(confidenceView(1.4, false, THRESHOLDS).fraction).toBe(1);
    expect(confidenceView(-0.2, false, THRESHOLDS).fraction).toBe(0);
  });
});

describe('liveView', () => {
  const steady = cue('steady', 'ok', 'Holding steady', 'Nothing needs correcting at the moment.');
  const blur = cue('blur', 'act', 'Too blurred', 'Slow down and let the camera settle before moving on.');

  it('passes the headline and the detail through without merging them', () => {
    const v = liveView(frame({ cue: blur, analysedFraction: 1, degraded: false }), null, null, THRESHOLDS);
    expect(v.headline).toBe('Too blurred');
    expect(v.detail).toBe('Slow down and let the camera settle before moving on.');
    expect(v.headline).not.toContain(v.detail);
  });

  it('does not let a good cue quiet the confidence strip', () => {
    // The failure this guards: a green banner computed from a third of the
    // frames. The cue is 'ok' and the confidence must still be loud.
    const v = liveView(
      frame({ cue: steady, analysedFraction: 0.33, degraded: true }), null, null, THRESHOLDS);
    expect(v.tone).toBe('ok');
    expect(v.confidence.tone).toBe('act');
    expect(v.degraded).toBe(true);
  });

  it('lists the other active cues without repeating the primary one', () => {
    const v = liveView(frame({
      cue: blur, active: [blur, steady], analysedFraction: 1, degraded: false,
    }), null, null, THRESHOLDS);
    expect(v.alsoActive.map((c) => c.id)).toEqual(['steady']);
  });

  it("carries the glazing findings in the analyser's own words", () => {
    const v = liveView(frame({
      cue: steady, analysedFraction: 1, degraded: false,
      glazing: [{ where: 'top right' }, { where: 'centre' }],
    }), null, null, THRESHOLDS);
    expect(v.glazingWhere).toEqual(['top right', 'centre']);
  });
});

describe('yawView', () => {
  const orientation: Orientation = { yaw: 1.2, pitch: 0, roll: 0, absolute: true, tMs: 0 };

  it('is null when the device gives no orientation, so no dial is drawn', () => {
    expect(yawView(null, { yawBins: [true, false], yawCoverage: 0.5 })).toBeNull();
  });

  it('is present but empty before a room has been entered', () => {
    const v = yawView(orientation, null);
    expect(v).not.toBeNull();
    expect(v!.bins).toEqual([]);
    expect(v!.coverage).toBeNull();
  });

  it('reports radians and whether they are referenced to north', () => {
    const v = yawView(orientation, { yawBins: [true, true, false], yawCoverage: 2 / 3 })!;
    expect(v.yaw).toBe(1.2);
    expect(v.absolute).toBe(true);
    expect(v.coverage).toBeCloseTo(2 / 3, 10);
  });
});

describe('roomChips', () => {
  const rooms: readonly PlannedRoom[] = [
    { id: 'hall', name: 'Hall', kind: 'hall', level: 0, isEntrance: true },
    { id: 'kitchen', name: 'Kitchen', kind: 'kitchen', level: 0, isEntrance: false },
    { id: 'bed1', name: 'Bedroom 1', kind: 'bedroom', level: 1, isEntrance: false },
  ];

  const snapshot = {
    rooms: [
      { roomId: 'hall', state: 'done', seconds: 40, gaps: [] },
      { roomId: 'kitchen', state: 'thin', seconds: 12, gaps: ['walk further along the walls'] },
    ],
  } as unknown as CoverageSnapshot;

  it('keeps the planned order rather than sorting by what is outstanding', () => {
    expect(roomChips(rooms, snapshot, 'kitchen').map((c) => c.roomId))
      .toEqual(['hall', 'kitchen', 'bed1']);
  });

  it('marks the room the operator tapped, because nothing else knows where they are', () => {
    const chips = roomChips(rooms, snapshot, 'kitchen');
    expect(chips.filter((c) => c.current).map((c) => c.roomId)).toEqual(['kitchen']);
    expect(chips[1]!.label).toBe('Kitchen, you are here, thin coverage');
  });

  it('shows a room with no measurements as not started rather than as covered', () => {
    const chips = roomChips(rooms, snapshot, 'hall');
    expect(chips[2]).toMatchObject({ roomId: 'bed1', state: 'not_started', seconds: 0 });
    expect(chips[2]!.label).toBe('Bedroom 1, not started');
  });

  it("repeats the analyser's own gap wording and invents none", () => {
    expect(roomChips(rooms, snapshot, null)[1]!.gaps).toEqual(['walk further along the walls']);
    expect(roomChips(rooms, snapshot, null)[2]!.gaps).toEqual([]);
  });

  it('works before any coverage exists at all', () => {
    const chips = roomChips(rooms, null, null);
    expect(chips.every((c) => c.state === 'not_started')).toBe(true);
  });
});

describe('toneOf', () => {
  it('maps a cue level to a tone without inventing a fourth', () => {
    expect(toneOf('act')).toBe('act');
    expect(toneOf('advise')).toBe('advise');
    expect(toneOf('ok')).toBe('ok');
  });
});

describe('figureFor', () => {
  it('prints a count as a count', () => {
    // frames.ABSOLUTE_MIN_FRAMES: 45 frames against a floor of 60.
    expect(figureFor({ measured: 45, threshold: 60, higherIsBetter: true }))
      .toBe('Measured 45 \u2014 the pipeline wants at least 60');
  });

  it('prints a fraction as a percentage, matching what the console shows', () => {
    // quality.blur_rejection_rate: lower is better.
    expect(figureFor({ measured: 0.35, threshold: 0.3, higherIsBetter: false }))
      .toBe('Measured 35% \u2014 the pipeline wants at most 30%');
    // quality.navigation_continuity is held at exactly 1.0 and is still a rate.
    expect(figureFor({ measured: 0.75, threshold: 1, higherIsBetter: true }))
      .toBe('Measured 75% \u2014 the pipeline wants at least 100%');
  });

  it('prints a yes/no as a yes/no rather than as nought per cent', () => {
    // capture.loop_closure is 0 against 1. "Measured 0% against 100%" reads as
    // though somebody scored zero on something.
    expect(figureFor({ measured: 0, threshold: 1, higherIsBetter: true }))
      .toBe('Not done, and the pipeline needs it done');
    expect(figureFor({ measured: 1, threshold: 1, higherIsBetter: true })).toBe('Done');
  });

  it('keeps one decimal for a measured count that is not whole', () => {
    // ingest.MIN_DURATION_S: 38.4 seconds against 45.
    expect(figureFor({ measured: 38.4, threshold: 45, higherIsBetter: true }))
      .toBe('Measured 38.4 \u2014 the pipeline wants at least 45');
  });
});

describe('overrunning', () => {
  it('fires before the loop has completely filled its interval', () => {
    // 90 ms of work in a 100 ms budget leaves nothing for the compositor, the
    // recorder or a repaint, and the preview is what suffers first.
    expect(overrunning(91, 100)).toBe(true);
    expect(overrunning(80, 100)).toBe(false);
  });

  it('says nothing when there is no interval to compare against', () => {
    expect(overrunning(500, 0)).toBe(false);
  });
});
