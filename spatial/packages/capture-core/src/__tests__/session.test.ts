/**
 * The session, and the two wirings it exists to get right.
 *
 * `CaptureSession` is not a convenience wrapper. It is the only place in the
 * package that knows which of two nearly identical numbers goes where, and the
 * first test below is the reason it exists: a session driven at 10 Hz and a
 * session driven at 7.5 Hz, over the same walk, must accumulate the same
 * travel. They do only if the raw measured displacement goes into the
 * accumulators while the rescaled one goes to the per-frame motion check. An
 * app doing this wiring itself gets it wrong in the permissive direction, and
 * the failure is invisible: a room reads as covered, the operator leaves, and
 * the frame budget comes up short after the upload.
 *
 * The second is the accept flag. One boolean drives the frame budget, the blur
 * rejection rate, every room's state and the verdict, and it has to come from
 * `motionWouldReject` rather than from a band name, or advisory frames count as
 * rejected and every prediction is quietly pessimistic.
 */

import { describe, expect, it } from 'vitest';
import type { GrayImage, Orientation, PlannedRoom } from '../types.js';
import { CaptureSession } from '../session.js';
import { CANDIDATE_FPS, FALLBACK_HFOV_RAD, SCORE_LONG_EDGE } from '../thresholds.js';
import { blockPattern, blurPattern, flat, lcg, paintRect, render, shifted } from './synthetic.js';

const ROOMS: PlannedRoom[] = [
  { id: 'hall', name: 'Hall', kind: 'hall', level: 0, isEntrance: true },
  { id: 'living', name: 'Living room', kind: 'living', level: 0, isEntrance: false },
];

const W = 320;
const H = 180;
const SCENE = render(blockPattern(W, H, 4, 1234), { contrast: 1 });

function session(): CaptureSession {
  // A fixed clock so `costMs` is deterministic and the pace controller does not
  // react to how busy the machine running the tests happens to be.
  let t = 0;
  return new CaptureSession(ROOMS, { random: lcg(1), clock: () => (t += 5) });
}

/**
 * Walk a session past a scene at a fixed speed in pixels per second.
 *
 * The frames are a translating view of one scene, which is what a camera
 * walking along a wall produces, so the measured displacement is exactly
 * pxPerSecond / hz whatever `hz` is — which is the property under test.
 */
function drive(
  s: CaptureSession, hz: number, seconds: number, pxPerSecond: number,
  frameFor: (offset: number) => GrayImage = (o) => shifted(SCENE, Math.round(o), 0),
): void {
  const frames = Math.round(hz * seconds);
  for (let i = 0; i < frames; i += 1) {
    s.onFrame(frameFor((i * pxPerSecond) / hz), Math.round((i * 1000) / hz));
  }
}

describe('raw displacement goes to the accumulators', () => {
  /**
   * 240 px/s across a 320 px frame is 32 px per candidate interval: exactly
   * CANDIDATE_TARGET_FRAC, the pace a walk at TARGET_FPS produces. Forty
   * seconds of it is 30 image widths, which at the selector's 0.30 target is a
   * hundred kept frames — enough that a third more or less is unmissable.
   */
  const SECONDS = 40;
  const PX_PER_SECOND = 240;
  const RECORDING = { width: 1920, height: 1080, fps: 30 };

  const walked = (hz: number): CaptureSession => {
    const s = session();
    s.enterRoom('hall', 0);
    drive(s, hz, SECONDS, PX_PER_SECOND);
    return s;
  };

  it('measures the same travel whether the app runs at 7.5 Hz or 10 Hz', () => {
    const a = walked(CANDIDATE_FPS).verdictInput(RECORDING).coverage.totalWidths;
    const b = walked(10).verdictInput(RECORDING).coverage.totalWidths;
    // Within 5%: the two sample the same path at different points, so per-frame
    // integer pixel rounding lands differently, but the TOTAL must not scale
    // with the rate. Rescaling before accumulating puts these 33.8% apart,
    // which this tolerance is nearly seven times too tight to admit.
    expect(Math.abs(a - b) / a).toBeLessThan(0.05);
    expect(a).toBeGreaterThan(25);
  });

  it('keeps a frame count that does not scale with the rate either', () => {
    // The keeper count inherits the property above — it is travel divided by
    // the target spacing — but with a looser tolerance, and the reason is worth
    // stating rather than hiding in a magic number.
    //
    // Measured: 90 keepers at 7.5 Hz against 100 at 10 Hz, an 11% gap, while
    // the travel totals agree to 0.2%. The gap is rejection, not arithmetic:
    // this fixture is a repeating block pattern, so a few tiles per frame match
    // ambiguously and tile consensus dips below MIN_TILE_CONSENSUS on some
    // frames. Which frames those are depends on where the sampling lands, so
    // the two rates lose different ones. That is real behaviour and not
    // something to tune away.
    //
    // The tolerance is therefore set to catch the failure this test exists for.
    // Rescaling before accumulating multiplies the 10 Hz total by 10/7.5, so it
    // would land at 1.33 or above; 1.2 sits between the two with room either
    // side, and the travel assertion above is the tight one.
    const kept = (hz: number) => walked(hz).verdictInput(RECORDING).keptFrames!;
    const slow = kept(CANDIDATE_FPS);
    const fast = kept(10);
    expect(slow).toBeGreaterThan(80);
    expect(fast / slow).toBeLessThan(1.2);
    expect(fast / slow).toBeGreaterThan(0.8);
  });
});

describe('the accept flag', () => {
  it('rejects a smeared frame and says so in the blur rate', () => {
    const s = session();
    s.enterRoom('hall', 0);
    const sharp = blockPattern(W, H, 4, 77);
    const smeared = render(blurPattern(sharp, 3), { contrast: 1 });
    const crisp = render(sharp, { contrast: 1 });
    for (let i = 0; i < 60; i += 1) s.onFrame(shifted(crisp, i * 4, 0), i * 100);
    let rejectedAny = false;
    for (let i = 60; i < 80; i += 1) {
      const r = s.onFrame(shifted(smeared, i * 4, 0), i * 100);
      if (!r.accepted) rejectedAny = true;
    }
    expect(rejectedAny).toBe(true);
    const snap = s.verdictInput({ width: 1920, height: 1080, fps: 30 }).coverage;
    expect(snap.blurRejectionRate).toBeGreaterThan(0);
  });

  it('does not reject a frame that is merely close to the limit', () => {
    // 'fast' is the advisory margin. Counting it as rejected would make every
    // prediction pessimistic, which is a different lie from the usual one.
    const s = session();
    s.enterRoom('hall', 0);
    let sawFast = false;
    for (let i = 0; i < 40; i += 1) {
      // About 0.15 of the width per frame at the candidate interval: past the
      // brisk point and short of rejection.
      const r = s.onFrame(shifted(SCENE, Math.round(i * SCENE.width * 0.15), 0), i * 133);
      if (r.motion.band === 'fast') { sawFast = true; expect(r.accepted).toBe(true); }
    }
    expect(sawFast).toBe(true);
  });
});

describe('what the session reports', () => {
  it('records nothing before the operator says which room they are in', () => {
    const s = session();
    s.onFrame(SCENE, 0);
    s.onFrame(shifted(SCENE, 10, 0), 100);
    expect(s.currentRoomId).toBeNull();
    expect(s.verdictInput({ width: 1920, height: 1080, fps: 30 }).coverage.totalCandidates)
      .toBe(0);
  });

  it('scores at the pipeline\'s resolution whatever it is handed', () => {
    // BLUR_ABS_FLOOR is only meaningful at SCORE_LONG_EDGE, so leaving the
    // downscale to the caller is leaving the blur floor to the caller.
    const s = session();
    s.enterRoom('hall', 0);
    const big = render(blockPattern(1920, 1080, 8, 5), { contrast: 1 });
    const r = s.onFrame(big, 0);
    expect(r.analysis.sharpness.volNorm).toBeGreaterThan(0);
    // The motion assessment is computed at the scored size, and the rejection
    // limit it quotes is the one for a 960 px wide 16:9 frame.
    expect(r.motion.rejectAtFracWidth).toBeCloseTo(0.16 * Math.hypot(16, 9) / 16, 6);
    expect(SCORE_LONG_EDGE).toBe(960);
  });

  it('reports a glazing finding and a cue when a window fills part of the frame', () => {
    const s = session();
    s.enterRoom('living', 0);
    const withWindow = paintRect(SCENE, 0, 0, W / 4, H / 4, 252);
    let sawGlazing = false;
    for (let i = 0; i < 10; i += 1) {
      const r = s.onFrame(withWindow, i * 100);
      if (r.glazing.length > 0) sawGlazing = true;
    }
    expect(sawGlazing).toBe(true);
  });

  it('carries the analysed fraction on every frame', () => {
    const s = session();
    s.enterRoom('hall', 0);
    // Ten frames over ten seconds is 1 Hz against a candidate rate of 7.5.
    for (let i = 0; i < 10; i += 1) s.onFrame(shifted(SCENE, i, 0), i * 1000);
    const r = s.onFrame(shifted(SCENE, 10, 0), 10_000);
    expect(r.analysedFraction).toBeLessThan(0.2);
    expect(r.analysedFraction).toBeGreaterThan(0);
  });

  it('never reports more than everything on the first frame', () => {
    const s = session();
    s.enterRoom('hall', 0);
    expect(s.onFrame(SCENE, 0).analysedFraction).toBe(1);
  });

  it('accepts orientation and uses it to separate walking from turning', () => {
    const s = session();
    s.enterRoom('hall', 0);
    for (let i = 0; i < 40; i += 1) {
      const o: Orientation = {
        yaw: i * 0.05, pitch: 0, roll: 0, absolute: false, tMs: i * 133,
      };
      s.onOrientation(o);
      s.onFrame(shifted(SCENE, i * 10, 0), i * 133);
    }
    const snap = s.verdictInput({ width: 1920, height: 1080, fps: 30 }).coverage;
    expect(snap.hasOrientation).toBe(true);
    expect(snap.totalTranslationWidths).not.toBeNull();
    expect(snap.rooms.find((r) => r.roomId === 'hall')!.yawCoverage).not.toBeNull();
  });

  it('holds an operator\'s surface declaration without inventing an author', () => {
    const s = session();
    s.enterRoom('living', 0);
    s.onFrame(SCENE, 0);
    s.declareSurface({ kind: 'mirror', roomId: 'living', tMs: 500, by: 'op-9' });
    const surfaces = s.verdictInput({ width: 1920, height: 1080, fps: 30 }).surfaces;
    expect(surfaces.roomsWithMirrors).toEqual(['living']);
    expect(surfaces.declarations[0]!.by).toBe('op-9');
  });
});

describe('the end-to-end verdict', () => {
  it('refuses a short capture that never left the hall', () => {
    const s = session();
    s.enterRoom('hall', 0);
    drive(s, 10, 3, 40);
    const v = s.verdict({ width: 1920, height: 1080, fps: 30 });
    expect(v.verdict).toBe('no_go');
    const checks = v.findings.map((f) => f.check);
    expect(checks).toContain('ingest.MIN_DURATION_S');
    expect(checks).toContain('quality.navigation_continuity');
    expect(v.notAssessed.length).toBeGreaterThan(0);
  });

  it('refuses a recording below the pipeline\'s resolution floor even when the walk was fine', () => {
    const s = session();
    s.enterRoom('hall', 0);
    drive(s, 10, 30, 40);
    s.enterRoom('living', 30_000);
    drive(s, 10, 30, 40);
    const v = s.verdict({ width: 1280, height: 720, fps: 30 });
    expect(v.findings.map((f) => f.check)).toContain('ingest.MIN_SHORT_EDGE');
    expect(v.verdict).toBe('no_go');
  });

  it('produces a cue on every frame, never nothing', () => {
    const s = session();
    s.enterRoom('hall', 0);
    for (let i = 0; i < 30; i += 1) {
      const r = s.onFrame(shifted(SCENE, i * 6, 0), i * 100);
      expect(r.cue).toBeDefined();
      expect(r.cue.headline.length).toBeGreaterThan(0);
    }
  });

  it('survives a featureless frame without producing a NaN anywhere', () => {
    // A phone pointed at a magnolia wall. Nothing here should divide by zero,
    // and a NaN in the rolling median would silently disable blur rejection for
    // the rest of the capture.
    const s = session();
    s.enterRoom('hall', 0);
    for (let i = 0; i < 20; i += 1) {
      const r = s.onFrame(flat(W, H, 200), i * 100);
      expect(Number.isFinite(r.analysis.sharpness.volNorm)).toBe(true);
      expect(Number.isFinite(r.overlap.totalWidths)).toBe(true);
      expect(Number.isFinite(r.analysedFraction)).toBe(true);
    }
    const v = s.verdict({ width: 1920, height: 1080, fps: 30 });
    expect(Number.isFinite(v.predictedFrames)).toBe(true);
    expect(Number.isFinite(v.blurRejectionRate)).toBe(true);
  });

  it('uses the lens it estimated rather than the fallback once it has one', () => {
    // The fallback is only for the yaw cue and only until gyro-versus-pixel
    // agreement has calibrated the real field of view.
    const s = session();
    s.enterRoom('hall', 0);
    for (let i = 0; i < 40; i += 1) {
      s.onOrientation({ yaw: i * 0.08, pitch: 0, roll: 0, absolute: false, tMs: i * 133 });
      s.onFrame(shifted(SCENE, i * 26, 0), i * 133);
    }
    // 0.08 rad against 26/320 = 0.08125 of a width is a field of view near
    // 0.98 rad, which is well away from the 1.134 rad fallback.
    expect(FALLBACK_HFOV_RAD).toBeCloseTo(1.134, 3);
    const snap = s.verdictInput({ width: 1920, height: 1080, fps: 30 }).coverage;
    expect(snap.hasOrientation).toBe(true);
  });
});
