/**
 * What has actually been seen, tracked as the walk happens.
 *
 * Be clear about what a phone browser can and cannot know here, because the
 * temptation is to draw a floorplan filling in, and that would be a lie.
 *
 * NOT KNOWABLE without pose estimation: position. `DeviceMotionEvent` gives
 * linear acceleration; integrating it twice for position accumulates error as
 * t-squared and is useless past two or three seconds. There is no visual-
 * inertial odometry in a browser, no ARKit, no ARCore. The app therefore never
 * claims to know where the operator is.
 *
 * KNOWABLE: which way the camera pointed (`DeviceOrientationEvent`), how far
 * the view travelled in image widths (projection matching, which is the
 * selector's own unit), how long, how sharp, how often rejected — and which
 * room, because the operator tells us by tapping the checklist. That last one
 * is not a workaround for a missing sensor; it is better than a sensor, since
 * a room is a human concept and the operator is standing in it.
 *
 * The load-bearing idea is the unit. `select_by_overlap` keeps one frame per
 * TARGET_DISPLACEMENT_FRAC of accumulated flow, so accumulated displacement in
 * image widths IS the currency the reconstruction is bought with, and it can
 * be measured live without knowing a single pose. Everything the verdict
 * screen says about "enough" is denominated in it.
 */

import type {
  CoverageSnapshot, PlannedRoom, RoomCoverage, RoomState,
} from './types.js';
import { clamp, median } from './image.js';
import { predictSelectedFrames } from './overlap.js';
import {
  CANDIDATE_FPS, MIN_TRANSLATION_SHARE, QUALITY_BLUR_REJECTION_RATE,
  ROOM_YAW_COVERAGE_TARGET, YAW_BINS, roomDisplacementTarget,
} from './thresholds.js';

/** One observation, as the analyser produces them. */
export interface CoverageObservation {
  readonly tMs: number;
  readonly dtMs: number;
  /**
   * The two rejection rules, reported separately.
   *
   * A single `accepted` boolean was not enough. quality.py's
   * `blur_rejection_rate` is frames.py's `n_blur / len(scores)` — blur only —
   * so an app that counts motion rejections in the same total reports a figure
   * the pipeline will not reproduce, and tells an operator whose problem is
   * pace that their problem is camera shake. A frame is accepted when neither
   * rule rejected it, and that is derived here rather than passed in so the two
   * cannot disagree.
   */
  readonly rejectedBlur: boolean;
  readonly rejectedMotion: boolean;
  /**
   * Displacement over this interval, divided by the image width.
   *
   * RAW, measured over `dtMs`. It must NOT have been through
   * `toCandidateInterval`: these are summed, and summing rescaled samples
   * inflates the total by analysisHz / CANDIDATE_FPS. See the header of
   * `overlap.ts`, which is where the same quantity is accumulated for the
   * frame-budget prediction, so the two must be fed identically or the room
   * totals and the capture total will disagree.
   */
  readonly widths: number;
  readonly volNorm: number;
  /** Radians. Null when the device gives no orientation. */
  readonly yaw: number | null;
  /** Yaw change over this interval, radians. Null without orientation. */
  readonly yawDelta: number | null;
  /** Radians, for the field of view the frame covered. */
  readonly hFov: number;
  readonly glare: boolean;
}

interface RoomAccumulator {
  seconds: number;
  candidates: number;
  rejectedBlur: number;
  rejectedMotion: number;
  rejected: number;
  widths: number;
  /**
   * Displacement the gyro alone accounts for. A yaw of psi radians moves the
   * image by psi / hFov of its width whether or not the camera went anywhere,
   * so subtracting this from `widths` leaves what walking contributed.
   */
  rotationWidths: number;
  yawBins: boolean[];
  volNorms: number[];
  /** Accepted frames seen in this room, including ones the reservoir dropped. */
  acceptedSeen: number;
  glareSeconds: number;
}

/**
 * Cap on the sharpness samples kept per room.
 *
 * A ten-minute capture at ANALYSIS_HZ is six thousand frames, and an unbounded
 * array of them on a phone is both memory and a sort. 600 is two minutes in one
 * room at the analysis rate, which is longer than any room in a domestic
 * property gets.
 */
const SHARPNESS_SAMPLE_CAP = 600;

function emptyRoom(): RoomAccumulator {
  return {
    seconds: 0, candidates: 0, rejectedBlur: 0, rejectedMotion: 0, rejected: 0,
    widths: 0, rotationWidths: 0,
    yawBins: new Array<boolean>(YAW_BINS).fill(false),
    volNorms: [], acceptedSeen: 0, glareSeconds: 0,
  };
}

export class CoverageModel {
  private readonly rooms: readonly PlannedRoom[];
  private readonly acc = new Map<string, RoomAccumulator>();
  private readonly visitOrder: string[] = [];
  private current: string | null = null;
  private sawOrientation = false;
  private doorways = 0;
  private entranceRevisited = false;

  private readonly random: () => number;

  /**
   * @param random injected so the reservoir is deterministic under test. A
   * median over a randomly-thinned sample is only defensible if the thinning
   * can be reproduced, and a test that cannot reproduce it can only assert
   * something weaker than the property it is there to protect.
   */
  constructor(rooms: readonly PlannedRoom[], random: () => number = Math.random) {
    this.rooms = rooms;
    this.random = random;
    for (const r of rooms) this.acc.set(r.id, emptyRoom());
  }

  get currentRoomId(): string | null { return this.current; }

  /**
   * Keep a bounded, unbiased sample of the room's sharpness scores.
   *
   * Vitter's Algorithm R, and the algorithm matters. The obvious version —
   * "once the array is full, overwrite a random slot" — is NOT unbiased: it
   * gives every frame after the cap a 1/600 chance of eviction per subsequent
   * frame, so the early frames are ground away and the median drifts toward
   * whatever the operator did last. In a walkthrough that is systematically the
   * end of the capture, which is the part shot in a hurry on the way back to
   * the front door. Algorithm R replaces slot j only when j < cap for
   * j = floor(random * n), which keeps every accepted frame at exactly
   * cap / n probability of being in the sample, so the median describes the
   * room rather than the last thirty seconds in it.
   */
  private addSharpnessSample(a: RoomAccumulator, volNorm: number): void {
    if (a.volNorms.length < SHARPNESS_SAMPLE_CAP) {
      a.volNorms.push(volNorm);
      return;
    }
    const j = Math.floor(this.random() * a.acceptedSeen);
    if (j < SHARPNESS_SAMPLE_CAP) a.volNorms[j] = volNorm;
  }

  /**
   * The operator says which room they are in.
   *
   * A change of room is counted as a doorway crossing, because in a flat it is
   * one. Doorways matter on their own: they are the only place two rooms are
   * visible at once, which is the only place the pose graph can connect them,
   * which is what `navigation_continuity` in quality.py measures at 1.0.
   */
  enterRoom(roomId: string, _tMs: number): void {
    if (!this.acc.has(roomId)) return;
    if (this.current !== null && this.current !== roomId) {
      this.doorways += 1;
      const entrance = this.rooms.find((r) => r.isEntrance);
      // Returning to the entrance after having been round the property is the
      // loop closure. Two rooms in between, because stepping into the hall and
      // back out again is not a loop.
      if (entrance && roomId === entrance.id && new Set(this.visitOrder).size >= 3) {
        this.entranceRevisited = true;
      }
    }
    this.current = roomId;
    if (this.visitOrder[this.visitOrder.length - 1] !== roomId) this.visitOrder.push(roomId);
  }

  observe(o: CoverageObservation): void {
    if (this.current === null) return;
    const a = this.acc.get(this.current);
    if (!a) return;
    const accepted = !o.rejectedBlur && !o.rejectedMotion;
    const dt = Math.max(0, o.dtMs) / 1000;
    a.seconds += dt;
    a.candidates += 1;
    if (o.rejectedBlur) a.rejectedBlur += 1;
    if (o.rejectedMotion) a.rejectedMotion += 1;
    if (!accepted) a.rejected += 1;
    a.widths += Math.max(0, o.widths);
    if (o.yawDelta !== null && o.hFov > 0) {
      a.rotationWidths += Math.min(Math.abs(o.yawDelta) / o.hFov, Math.max(0, o.widths));
    }
    if (o.glare) a.glareSeconds += dt;
    // Sharpness is only meaningful for frames that were kept; a median that
    // includes rejected frames describes the mistakes, not the material.
    if (accepted) {
      a.acceptedSeen += 1;
      this.addSharpnessSample(a, o.volNorm);
    }
    if (o.yaw !== null && accepted) {
      this.sawOrientation = true;
      this.markYaw(a, o.yaw, o.hFov);
    }
  }

  /**
   * Light every bin the lens covered, not only the one it was centred on.
   *
   * A 65-degree lens sees four and a bit 15-degree bins at once, and pretending
   * it saw one would make a properly swept room look like a series of dots.
   */
  private markYaw(a: RoomAccumulator, yaw: number, hFov: number): void {
    const half = Math.max(0, hFov) / 2;
    const step = (Math.PI * 2) / YAW_BINS;
    const from = Math.floor((yaw - half) / step);
    const to = Math.ceil((yaw + half) / step);
    for (let i = from; i <= to; i += 1) {
      const bin = ((i % YAW_BINS) + YAW_BINS) % YAW_BINS;
      a.yawBins[bin] = true;
    }
  }

  snapshot(): CoverageSnapshot {
    const target = roomDisplacementTarget(this.rooms.length);
    const rooms: RoomCoverage[] = [];
    let totalSeconds = 0;
    let totalCandidates = 0;
    let totalRejected = 0;
    let totalRejectedBlur = 0;
    let totalRejectedMotion = 0;
    let totalWidths = 0;

    for (const room of this.rooms) {
      const a = this.acc.get(room.id) ?? emptyRoom();
      totalSeconds += a.seconds;
      totalCandidates += a.candidates;
      totalRejected += a.rejected;
      totalRejectedBlur += a.rejectedBlur;
      totalRejectedMotion += a.rejectedMotion;
      totalWidths += a.widths;

      const translationWidths = this.sawOrientation
        ? Math.max(0, a.widths - a.rotationWidths)
        : null;
      const covered = a.yawBins.filter(Boolean).length;
      const yawCoverage = this.sawOrientation ? covered / YAW_BINS : null;
      const blurRate = a.candidates > 0 ? a.rejectedBlur / a.candidates : 0;
      const motionRate = a.candidates > 0 ? a.rejectedMotion / a.candidates : 0;
      const accepted = a.candidates - a.rejected;
      // Candidates the pipeline will have, not analysis frames: the pipeline
      // decodes at CANDIDATE_FPS regardless of how fast this app ran.
      const acceptedCandidates = a.candidates > 0
        ? a.seconds * CANDIDATE_FPS * (accepted / a.candidates)
        : 0;
      const predictedFrames = predictSelectedFrames(a.widths, acceptedCandidates);

      const gaps: string[] = [];
      if (a.candidates === 0) {
        gaps.push('Not started.');
      } else {
        if (a.widths < target) {
          gaps.push(`Walk further in here — about ${Math.max(1, Math.round(target - a.widths))} `
            + 'more sweeps of the view.');
        }
        if (yawCoverage !== null && yawCoverage < ROOM_YAW_COVERAGE_TARGET) {
          gaps.push(`${Math.round((1 - yawCoverage) * 100)}% of the directions in this room `
            + 'were never faced.');
        }
        // Two rules, two gaps, two different corrections. "Too blurred" when
        // the operator should hold the phone steadier, "moving too fast" when
        // they should walk slower — and telling someone to steady their hands
        // while the real problem is their feet is how guidance gets ignored.
        if (blurRate > QUALITY_BLUR_REJECTION_RATE) {
          gaps.push(`${Math.round(blurRate * 100)}% of frames here were too blurred to use.`);
        }
        if (motionRate > QUALITY_BLUR_REJECTION_RATE) {
          gaps.push(`${Math.round(motionRate * 100)}% of frames here were dropped for moving `
            + 'too fast or too unevenly.');
        }
        if (a.glareSeconds > a.seconds * 0.3 && a.seconds > 2) {
          gaps.push('A bright window or mirror was in shot for most of this room.');
        }
        if (translationWidths !== null && a.widths > 1
          && translationWidths / a.widths < MIN_TRANSLATION_SHARE) {
          gaps.push('Mostly turning on the spot here. Walk across the room as well, or '
            + 'nothing in it can be measured.');
        }
      }

      let state: RoomState;
      if (a.candidates === 0) state = 'not_started';
      else if (gaps.length === 0) state = 'done';
      else state = 'thin';

      rooms.push({
        roomId: room.id,
        state,
        seconds: a.seconds,
        candidates: a.candidates,
        rejectedBlur: a.rejectedBlur,
        rejectedMotion: a.rejectedMotion,
        rejected: a.rejected,
        widths: a.widths,
        translationWidths,
        predictedFrames,
        yawCoverage,
        yawBins: a.yawBins.slice(),
        medianVolNorm: median(a.volNorms),
        glareSeconds: a.glareSeconds,
        gaps,
      });
    }

    const totalTranslationWidths = this.sawOrientation
      ? rooms.reduce((sum, r) => sum + (r.translationWidths ?? 0), 0)
      : null;
    const acceptedTotal = totalCandidates - totalRejected;
    const acceptedCandidates = totalCandidates > 0
      ? totalSeconds * CANDIDATE_FPS * (acceptedTotal / totalCandidates)
      : 0;

    return {
      rooms,
      totalSeconds,
      totalCandidates,
      totalRejectedBlur,
      totalRejectedMotion,
      totalRejected,
      totalWidths,
      totalTranslationWidths,
      predictedFrames: predictSelectedFrames(totalWidths, acceptedCandidates),
      // BLUR ONLY. This is the value quality.py's `blur_rejection_rate` check
      // will be given, and frames.py computes it as n_blur / len(scores).
      blurRejectionRate: totalCandidates > 0 ? totalRejectedBlur / totalCandidates : 0,
      motionRejectionRate: totalCandidates > 0 ? totalRejectedMotion / totalCandidates : 0,
      entranceRevisited: this.entranceRevisited,
      doorwaysCrossed: this.doorways,
      hasOrientation: this.sawOrientation,
    };
  }

  /**
   * The room the operator should go to next, and why.
   *
   * Nearest-first is impossible without position, so the order is the route's:
   * unstarted rooms in plan order, then thin ones worst-first. "Worst" is
   * measured in the selector's own unit, so the room that will contribute the
   * fewest frames is the one named.
   */
  nextAttention(): { roomId: string; reason: string } | null {
    const snap = this.snapshot();
    const byId = new Map(snap.rooms.map((r) => [r.roomId, r]));
    for (const room of this.rooms) {
      const c = byId.get(room.id);
      if (c && c.state === 'not_started') {
        return { roomId: room.id, reason: 'not started' };
      }
    }
    const thin = snap.rooms.filter((r) => r.state === 'thin');
    if (thin.length === 0) return null;
    thin.sort((a, b) => a.widths - b.widths);
    const worst = thin[0]!;
    return { roomId: worst.roomId, reason: worst.gaps[0] ?? 'thin coverage' };
  }
}

/** Fraction of planned rooms that reached `done`. Compare to quality.py's 0.80. */
export function roomCompleteness(snapshot: CoverageSnapshot): number {
  if (snapshot.rooms.length === 0) return 0;
  const done = snapshot.rooms.filter((r) => r.state === 'done').length;
  return clamp(done / snapshot.rooms.length, 0, 1);
}
