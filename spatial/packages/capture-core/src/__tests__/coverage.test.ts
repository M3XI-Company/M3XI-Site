/**
 * Coverage, and the shape of what a browser is allowed to claim.
 *
 * The first test in this file is a negative one, and it is the important one:
 * nothing in the coverage model carries a position. `DeviceMotionEvent` gives
 * linear acceleration, double-integrating it is metres out inside three
 * seconds, and there is no visual-inertial odometry in a browser. So there is
 * no self-filling floorplan here and there must never be one — the model is a
 * yaw dial, a travel total in the selector's own unit, and a set of rooms the
 * operator taps. A `position` field would be an invitation to draw a plan, and
 * a plan drawn from double-integrated accelerometer data is a picture of a
 * building that does not exist.
 *
 * The rest is the arithmetic: travel in image widths, the candidate count
 * converted onto the pipeline's timeline rather than the app's, the rotation
 * subtraction that separates walking from spinning, and a reservoir whose
 * median describes the room rather than the last thirty seconds in it.
 */

import { describe, expect, it } from 'vitest';
import type { PlannedRoom } from '../types.js';
import { CoverageModel, roomCompleteness } from '../coverage.js';
import {
  CANDIDATE_FPS, FALLBACK_HFOV_RAD, MIN_TRANSLATION_SHARE, QUALITY_BLUR_REJECTION_RATE,
  ROOM_YAW_COVERAGE_TARGET, YAW_BINS, roomDisplacementTarget,
} from '../thresholds.js';
import { lcg } from './synthetic.js';

const ROOMS: PlannedRoom[] = [
  { id: 'hall', name: 'Hall', kind: 'hall', level: 0, isEntrance: true },
  { id: 'living', name: 'Living room', kind: 'living', level: 0, isEntrance: false },
  { id: 'kitchen', name: 'Kitchen', kind: 'kitchen', level: 0, isEntrance: false },
  { id: 'bed1', name: 'Bedroom 1', kind: 'bedroom', level: 1, isEntrance: false },
  { id: 'bed2', name: 'Bedroom 2', kind: 'bedroom', level: 1, isEntrance: false },
  { id: 'bath', name: 'Bathroom', kind: 'bathroom', level: 1, isEntrance: false },
];

const DT = 100;
const TARGET = roomDisplacementTarget(ROOMS.length);

/**
 * Walk a room: `frames` observations, each contributing `widths` of travel, with
 * the yaw swept right round so the angular coverage target is reachable.
 */
function walk(
  m: CoverageModel, roomId: string, frames: number,
  opts: { widths?: number; rejectEvery?: number; orientation?: boolean; sweep?: boolean;
    yawOnly?: boolean; glare?: boolean } = {},
): void {
  const widths = opts.widths ?? TARGET / Math.max(1, frames);
  m.enterRoom(roomId, 0);
  for (let i = 0; i < frames; i += 1) {
    const accepted = opts.rejectEvery ? (i % opts.rejectEvery !== 0) : true;
    const yaw = opts.sweep === false ? 0 : (i / frames) * Math.PI * 2;
    // yawOnly: the whole of the measured flow is accounted for by rotation, so
    // the translation share falls to zero. That is a panorama from the middle
    // of the room, which is the failure frames.py cannot see.
    const yawDelta = opts.orientation === false
      ? null
      : (opts.yawOnly ? widths * FALLBACK_HFOV_RAD : 0.01);
    m.observe({
      tMs: i * DT, dtMs: DT, rejectedBlur: !accepted, rejectedMotion: false,
      widths, volNorm: 1.5,
      yaw: opts.orientation === false ? null : yaw,
      yawDelta, hFov: FALLBACK_HFOV_RAD, glare: opts.glare ?? false,
    });
  }
}

describe('what the model refuses to know', () => {
  it('has no position field anywhere in a snapshot', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'hall', 50);
    const snap = m.snapshot();
    const keys = [...Object.keys(snap), ...Object.keys(snap.rooms[0]!)].map((k) => k.toLowerCase());
    for (const forbidden of ['position', 'x', 'y', 'z', 'pose', 'polygon', 'footprint', 'plan']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('reports null rather than zero for everything orientation would have given', () => {
    // A device with no DeviceOrientationEvent. Zero would read as "the operator
    // never turned", which is a measurement; null is the absence of one.
    const m = new CoverageModel(ROOMS);
    walk(m, 'hall', 50, { orientation: false });
    const snap = m.snapshot();
    expect(snap.hasOrientation).toBe(false);
    expect(snap.totalTranslationWidths).toBeNull();
    expect(snap.rooms[0]!.yawCoverage).toBeNull();
    expect(snap.rooms[0]!.translationWidths).toBeNull();
  });
});

describe('room state', () => {
  it('starts every planned room as not started', () => {
    const snap = new CoverageModel(ROOMS).snapshot();
    expect(snap.rooms).toHaveLength(ROOMS.length);
    for (const r of snap.rooms) {
      expect(r.state).toBe('not_started');
      expect(r.gaps).toEqual(['Not started.']);
    }
    expect(roomCompleteness(snap)).toBe(0);
  });

  it('marks a room done once it has the travel, the angles and the sharpness', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 120);
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.widths).toBeCloseTo(TARGET, 6);
    expect(room.yawCoverage).toBeGreaterThanOrEqual(ROOM_YAW_COVERAGE_TARGET);
    expect(room.gaps).toEqual([]);
    expect(room.state).toBe('done');
  });

  it('asks for more walking when the travel is short, in sweeps of the view', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 60, { widths: (TARGET / 2) / 60 });
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.state).toBe('thin');
    expect(room.gaps.join(' ')).toContain('Walk further');
  });

  it('notices a room shot from the doorway', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 120, { sweep: false });
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.yawCoverage).toBeLessThan(ROOM_YAW_COVERAGE_TARGET);
    expect(room.gaps.join(' ')).toContain('never faced');
  });

  it('notices a panorama from the middle of the room', () => {
    // The one thing this app knows that frames.py does not: `select_by_overlap`
    // measures flow and cannot tell a walk from a spin, so a property shot as a
    // series of panoramas passes frame selection and falls apart in pose.
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 120, { yawOnly: true });
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.translationWidths).toBeCloseTo(0, 6);
    expect(room.gaps.join(' ')).toContain('turning on the spot');
  });

  it('notices a room where most frames were thrown away', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 120, { rejectEvery: 2 });
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.rejected / room.candidates).toBeGreaterThan(QUALITY_BLUR_REJECTION_RATE);
    expect(room.gaps.join(' ')).toContain('too blurred');
  });

  it('notices a window or mirror in shot for most of a room', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 120, { glare: true });
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.glareSeconds).toBeCloseTo(12, 6);
    expect(room.gaps.join(' ')).toContain('bright window or mirror');
  });
});

describe('blur and motion are counted apart', () => {
  const observe = (m: CoverageModel, n: number, blur: boolean, motion: boolean) => {
    for (let i = 0; i < n; i += 1) {
      m.observe({
        tMs: i * DT, dtMs: DT, rejectedBlur: blur, rejectedMotion: motion,
        widths: 0.05, volNorm: 1.5, yaw: null, yawDelta: null,
        hFov: FALLBACK_HFOV_RAD, glare: false,
      });
    }
  };

  it('reports the rate quality.py will see, which counts blur only', () => {
    // frames.py computes blur_rejection_fraction as n_blur / len(scores) and
    // quality.py's blur_rejection_rate check is that number. An app that folded
    // motion rejections into the same total would report a figure the pipeline
    // will not reproduce.
    const m = new CoverageModel(ROOMS);
    m.enterRoom('living', 0);
    observe(m, 10, true, false);
    observe(m, 30, false, true);
    observe(m, 60, false, false);
    const snap = m.snapshot();
    expect(snap.totalCandidates).toBe(100);
    expect(snap.blurRejectionRate).toBeCloseTo(0.1, 10);
    expect(snap.motionRejectionRate).toBeCloseTo(0.3, 10);
    // And the frame budget is reduced by BOTH, because both rules throw the
    // frame away before `select_by_overlap` ever sees it.
    expect(snap.totalRejected).toBe(40);
  });

  it('does not double-count a frame both rules rejected', () => {
    const m = new CoverageModel(ROOMS);
    m.enterRoom('living', 0);
    observe(m, 20, true, true);
    const snap = m.snapshot();
    expect(snap.totalRejectedBlur).toBe(20);
    expect(snap.totalRejectedMotion).toBe(20);
    expect(snap.totalRejected).toBe(20);
  });

  it('gives the two failures different advice, because they have different fixes', () => {
    const blurry = new CoverageModel(ROOMS);
    blurry.enterRoom('living', 0);
    observe(blurry, 60, true, false);
    observe(blurry, 40, false, false);
    const blurryGaps = blurry.snapshot().rooms.find((r) => r.roomId === 'living')!.gaps.join(' ');
    expect(blurryGaps).toContain('too blurred');
    expect(blurryGaps).not.toContain('moving too fast');

    const hurried = new CoverageModel(ROOMS);
    hurried.enterRoom('living', 0);
    observe(hurried, 60, false, true);
    observe(hurried, 40, false, false);
    const hurriedGaps = hurried.snapshot().rooms.find((r) => r.roomId === 'living')!.gaps.join(' ');
    expect(hurriedGaps).toContain('moving too fast');
    expect(hurriedGaps).not.toContain('too blurred');
  });

  it('keeps a motion-rejected frame out of the sharpness median', () => {
    // It is not a comment on sharpness either way, and a median that includes
    // it describes the mistakes rather than the material.
    const m = new CoverageModel(ROOMS, lcg(2));
    m.enterRoom('living', 0);
    for (let i = 0; i < 100; i += 1) {
      m.observe({
        tMs: i, dtMs: DT, rejectedBlur: false, rejectedMotion: i % 2 === 0,
        widths: 0.01, volNorm: i % 2 === 0 ? 0.001 : 2,
        yaw: null, yawDelta: null, hFov: FALLBACK_HFOV_RAD, glare: false,
      });
    }
    expect(m.snapshot().rooms.find((r) => r.roomId === 'living')!.medianVolNorm).toBe(2);
  });
});

describe('the frame budget', () => {
  it('counts candidates on the pipeline\'s timeline, not the app\'s', () => {
    // The pipeline decodes at CANDIDATE_FPS regardless of how fast this app
    // managed to run. Using the app's own frame count would make a slow phone
    // predict a smaller capture, which is the device reporting on itself.
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 120, { widths: 0.5 });
    const snap = m.snapshot();
    // 120 analysed frames at 100 ms is 12 seconds, so 90 PIPELINE candidates,
    // all accepted; travel is 60 widths, which at the 0.30 target would buy 200
    // frames — so the candidate count is the binding bound and the answer is
    // about 90, not the 120 the app itself looked at.
    expect(snap.totalCandidates).toBe(120);
    expect(snap.totalSeconds).toBeCloseTo(12, 6);
    // Within one frame: twelve hundred additions of 0.1 s land at 11.9999999,
    // and a floor of that is 89. Chasing the last frame with an epsilon would
    // hide the arithmetic rather than fix it.
    expect(Math.abs(snap.predictedFrames - 12 * CANDIDATE_FPS)).toBeLessThanOrEqual(1);
  });

  it('scales the candidate count by the fraction that survived', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 120, { widths: 0.5, rejectEvery: 2 });
    const snap = m.snapshot();
    expect(snap.blurRejectionRate).toBeCloseTo(0.5, 6);
    expect(Math.abs(snap.predictedFrames - 12 * CANDIDATE_FPS * 0.5)).toBeLessThanOrEqual(1);
  });
});

describe('doorways and loop closure', () => {
  it('counts a room change as a doorway crossing', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'hall', 5);
    walk(m, 'living', 5);
    walk(m, 'kitchen', 5);
    expect(m.snapshot().doorwaysCrossed).toBe(2);
  });

  it('does not count re-declaring the same room', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'hall', 5);
    walk(m, 'hall', 5);
    expect(m.snapshot().doorwaysCrossed).toBe(0);
  });

  it('records the loop only when the walk really went round', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'hall', 5);
    walk(m, 'living', 5);
    walk(m, 'hall', 5);
    // Stepping into one room and back out is not a loop.
    expect(m.snapshot().entranceRevisited).toBe(false);

    walk(m, 'kitchen', 5);
    walk(m, 'bed1', 5);
    walk(m, 'hall', 5);
    expect(m.snapshot().entranceRevisited).toBe(true);
  });

  it('ignores observations before a room has been declared', () => {
    // The app should not be recording before the operator says where they are,
    // and silently attributing those frames to a room would be worse than
    // dropping them.
    const m = new CoverageModel(ROOMS);
    m.observe({
      tMs: 0, dtMs: DT, rejectedBlur: false, rejectedMotion: false, widths: 5, volNorm: 1,
      yaw: 0, yawDelta: 0, hFov: FALLBACK_HFOV_RAD, glare: false,
    });
    expect(m.snapshot().totalCandidates).toBe(0);
  });
});

describe('nextAttention', () => {
  it('names an unstarted room before a thin one', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'hall', 20, { widths: 0.01 });
    expect(m.nextAttention()).toEqual({ roomId: 'living', reason: 'not started' });
  });

  it('names the thinnest room once everything has been entered', () => {
    const m = new CoverageModel(ROOMS);
    for (const r of ROOMS) {
      // Everything covered properly except the bathroom, which got ten frames
      // from the doorway — the room that will contribute the fewest frames.
      if (r.id === 'bath') walk(m, r.id, 10, { widths: 0.001 });
      else walk(m, r.id, 120);
    }
    const next = m.nextAttention();
    expect(next?.roomId).toBe('bath');
    expect(next?.reason.length).toBeGreaterThan(0);
  });

  it('returns null when there is nothing left to say', () => {
    const m = new CoverageModel(ROOMS);
    for (const r of ROOMS) walk(m, r.id, 120);
    expect(m.nextAttention()).toBeNull();
    expect(roomCompleteness(m.snapshot())).toBe(1);
  });
});

describe('the sharpness reservoir', () => {
  it('keeps a median that describes the room and not its last thirty seconds', () => {
    // The naive "overwrite a random slot once full" gives every frame after the
    // cap a fresh chance of eviction per subsequent frame, grinding the early
    // ones away. In a walkthrough the end of a room is systematically the part
    // shot in a hurry, so the bias has a direction. Algorithm R does not.
    const m = new CoverageModel(ROOMS, lcg(7));
    m.enterRoom('living', 0);
    // 2000 sharp frames, then 500 dim ones: the true median is sharp.
    for (let i = 0; i < 2000; i += 1) {
      m.observe({ tMs: i, dtMs: DT, rejectedBlur: false, rejectedMotion: false, widths: 0.01, volNorm: 2,
        yaw: null, yawDelta: null, hFov: FALLBACK_HFOV_RAD, glare: false });
    }
    for (let i = 0; i < 500; i += 1) {
      m.observe({ tMs: i, dtMs: DT, rejectedBlur: false, rejectedMotion: false, widths: 0.01, volNorm: 0.2,
        yaw: null, yawDelta: null, hFov: FALLBACK_HFOV_RAD, glare: false });
    }
    expect(m.snapshot().rooms.find((r) => r.roomId === 'living')!.medianVolNorm).toBe(2);
  });

  it('is deterministic for a given generator, so the median is reproducible', () => {
    const run = (): number => {
      const m = new CoverageModel(ROOMS, lcg(99));
      m.enterRoom('living', 0);
      for (let i = 0; i < 1500; i += 1) {
        m.observe({ tMs: i, dtMs: DT, rejectedBlur: false, rejectedMotion: false, widths: 0.01, volNorm: i / 1000,
          yaw: null, yawDelta: null, hFov: FALLBACK_HFOV_RAD, glare: false });
      }
      return m.snapshot().rooms.find((r) => r.roomId === 'living')!.medianVolNorm;
    };
    expect(run()).toBe(run());
  });

  it('does not sample rejected frames, which describe the mistakes', () => {
    const m = new CoverageModel(ROOMS, lcg(3));
    m.enterRoom('living', 0);
    for (let i = 0; i < 100; i += 1) {
      m.observe({ tMs: i, dtMs: DT, rejectedBlur: i % 2 !== 0, rejectedMotion: false, widths: 0.01,
        volNorm: i % 2 === 0 ? 2 : 0.001,
        yaw: null, yawDelta: null, hFov: FALLBACK_HFOV_RAD, glare: false });
    }
    expect(m.snapshot().rooms.find((r) => r.roomId === 'living')!.medianVolNorm).toBe(2);
  });
});

describe('the yaw dial', () => {
  it('lights every bin the lens covered, not only the one it pointed at', () => {
    // A 65-degree lens sees four and a bit 15-degree bins at once. Lighting one
    // would make a properly swept room look like a series of dots.
    const m = new CoverageModel(ROOMS);
    m.enterRoom('living', 0);
    m.observe({ tMs: 0, dtMs: DT, rejectedBlur: false, rejectedMotion: false, widths: 0.1, volNorm: 1,
      yaw: 0, yawDelta: 0, hFov: FALLBACK_HFOV_RAD, glare: false });
    const bins = m.snapshot().rooms.find((r) => r.roomId === 'living')!.yawBins;
    const lit = bins.filter(Boolean).length;
    expect(lit).toBeGreaterThanOrEqual(4);
    expect(lit).toBeLessThan(YAW_BINS / 2);
  });

  it('cannot reach the coverage target from a single standpoint', () => {
    const m = new CoverageModel(ROOMS);
    m.enterRoom('living', 0);
    for (let i = 0; i < 200; i += 1) {
      m.observe({ tMs: i, dtMs: DT, rejectedBlur: false, rejectedMotion: false, widths: 0.1, volNorm: 1,
        yaw: 0.2, yawDelta: 0, hFov: FALLBACK_HFOV_RAD, glare: false });
    }
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.yawCoverage).toBeLessThan(ROOM_YAW_COVERAGE_TARGET);
  });
});

describe('roomDisplacementTarget', () => {
  it('shares the frame budget between the rooms there are', () => {
    // MIN_FRAMES / rooms, converted to travel at the selector's target spacing.
    expect(roomDisplacementTarget(6)).toBeCloseTo(10, 6);
    expect(roomDisplacementTarget(3)).toBeCloseTo(20, 6);
  });

  it('floors at the travel a room needs for angles and parallax together', () => {
    // Without the floor a twelve-room house would be asked for five widths a
    // room, every room would come out `inferred` rather than `reconstructed`,
    // and quality.py's room_completeness would fail at 0.80.
    expect(roomDisplacementTarget(12)).toBeGreaterThan(200 / 12 * 0.3);
    expect(roomDisplacementTarget(40)).toBe(roomDisplacementTarget(12));
  });
});

describe('the translation share', () => {
  it('subtracts what the gyro accounts for from the measured flow', () => {
    const m = new CoverageModel(ROOMS);
    walk(m, 'living', 100, { widths: 0.1 });
    const snap = m.snapshot();
    // 0.01 rad per frame through a 1.134 rad lens is 0.0088 widths of rotation
    // against 0.1 widths measured, so about 91% of it was walking.
    expect(snap.totalTranslationWidths! / snap.totalWidths).toBeGreaterThan(MIN_TRANSLATION_SHARE);
  });

  it('never lets rotation account for more travel than was measured', () => {
    // A wild gyro reading on a stationary phone would otherwise produce a
    // negative translation share, which is not a thing.
    const m = new CoverageModel(ROOMS);
    m.enterRoom('living', 0);
    m.observe({ tMs: 0, dtMs: DT, rejectedBlur: false, rejectedMotion: false, widths: 0.01, volNorm: 1,
      yaw: 0, yawDelta: 3, hFov: FALLBACK_HFOV_RAD, glare: false });
    const room = m.snapshot().rooms.find((r) => r.roomId === 'living')!;
    expect(room.translationWidths).toBe(0);
  });
});
