/**
 * One capture, wired up correctly.
 *
 * Everything in this package can be used on its own, and this file exists
 * because it should not have to be. The objects here have to be fed in a
 * particular way and two of those ways are not obvious:
 *
 *   -- `OverlapTracker` and `CoverageModel` take RAW displacement, measured
 *      over whatever interval the app happened to sample at. `assessMotion`
 *      takes the same measurement and rescales it to the candidate interval
 *      before comparing it to MAX_FLOW_FRACTION. Feed the rescaled figure into
 *      the accumulators and every travel total is a third too high at 10 Hz,
 *      which reports a room as covered when a quarter of it was never walked.
 *
 *   -- `BlurJudge` and `assessMotion` decide between them whether a frame is
 *      ACCEPTED, and that one boolean drives the frame budget, the blur
 *      rejection rate, the coverage state and the verdict. Getting it from the
 *      band name instead of `motionWouldReject` counts advisory frames as
 *      rejected and makes every prediction pessimistic.
 *
 * Leaving either of those to the app is how the bug comes back in six months in
 * somebody else's file. So the session owns them, and the app drives the
 * session: frames in, cues out, a verdict at the end.
 *
 * There is still no DOM and no network here. The session holds numbers and
 * hands back numbers; the app owns the camera, the canvas, the worker and the
 * upload, and none of those are this package's business.
 */

import type {
  Cue, FrameAnalysis, GrayImage, Orientation, PlannedRoom, VerdictReport,
} from './types.js';
import { BlurJudge } from './blur.js';
import { CoverageModel } from './coverage.js';
import { analyseFrame, type Clock } from './frame.js';
import { GuidanceEngine } from './guidance.js';
import { downscaleGray } from './image.js';
import {
  FovEstimator, assessMotion, motionWouldReject, yawRate,
  type MotionAssessment, type Projections,
} from './motion.js';
import { OverlapTracker, type OverlapState } from './overlap.js';
import { PaceController } from './pace.js';
import {
  DiscontinuityWatch, discontinuityFindings, glazingFindings, summariseDeclarations,
  type DiscontinuityFinding, type GlazingFinding, type SurfaceDeclaration,
} from './reflective.js';
import {
  ANALYSIS_HZ, CANDIDATE_FPS, CUE_RAISE_FRAMES, FALLBACK_HFOV_RAD, SCORE_LONG_EDGE,
  blurWindowFrames, maxYawRateRadS,
} from './thresholds.js';
import { analysisConfidence, buildVerdict, type VerdictInput } from './verdict.js';

export interface SessionOptions {
  /** Analysis rate the app is targeting. Defaults to ANALYSIS_HZ. */
  readonly analysisHz?: number;
  /** Injected for tests, so a reservoir median is reproducible. */
  readonly random?: () => number;
  /** Injected for tests, so `costMs` is not at the mercy of a real clock. */
  readonly clock?: Clock;
}

export interface FrameResult {
  readonly analysis: FrameAnalysis;
  readonly accepted: boolean;
  readonly motion: MotionAssessment;
  readonly overlap: OverlapState;
  readonly glazing: readonly GlazingFinding[];
  readonly discontinuities: readonly DiscontinuityFinding[];
  readonly cue: Cue;
  readonly active: readonly Cue[];
  /** Fraction of the pipeline's candidates judged so far, 0-1. */
  readonly analysedFraction: number;
  /** True when the device cannot hold the candidate rate. */
  readonly degraded: boolean;
}

export class CaptureSession {
  private readonly coverage: CoverageModel;
  private readonly blurJudge: BlurJudge;
  private readonly overlap = new OverlapTracker();
  private readonly guidance = new GuidanceEngine();
  private readonly pace = new PaceController();
  private readonly fov = new FovEstimator();
  private readonly discontinuities = new DiscontinuityWatch(CUE_RAISE_FRAMES);
  private readonly rooms: readonly PlannedRoom[];
  private readonly clock: Clock | undefined;

  private projections: Projections | null = null;
  private previousTMs: number | null = null;
  private orientation: Orientation | null = null;
  private previousOrientation: Orientation | null = null;
  private declarations: SurfaceDeclaration[] = [];
  private analysed = 0;
  private lastTMs = 0;

  constructor(rooms: readonly PlannedRoom[], opts: SessionOptions = {}) {
    this.rooms = rooms;
    this.coverage = new CoverageModel(rooms, opts.random ?? Math.random);
    // The trailing window standing in for frames.py's centred 31-candidate
    // rolling median, converted to whatever rate the app is running at.
    this.blurJudge = new BlurJudge(blurWindowFrames(opts.analysisHz ?? ANALYSIS_HZ));
    this.clock = opts.clock;
  }

  /** The operator says which room they are in. Nothing is recorded before this. */
  enterRoom(roomId: string, tMs: number): void {
    this.coverage.enterRoom(roomId, tMs);
  }

  /**
   * The operator says a surface is there.
   *
   * `roomId` and `by` come from the app, never from here: this package has no
   * idea who is holding the phone and must not invent an author for an
   * assertion that will travel with the capture.
   */
  declareSurface(d: SurfaceDeclaration): void {
    this.declarations.push(d);
  }

  /** A device orientation sample. Optional: plenty of devices give none. */
  onOrientation(o: Orientation): void {
    this.previousOrientation = this.orientation;
    this.orientation = o;
  }

  /** Interval, in ms, the app should target for the next frame. */
  get intervalMs(): number { return this.pace.intervalMs(); }

  get currentRoomId(): string | null { return this.coverage.currentRoomId; }

  /**
   * One frame.
   *
   * `gray` may be at any resolution; it is downscaled to SCORE_LONG_EDGE here
   * because that is what BLUR_ABS_FLOOR is calibrated against and leaving it to
   * the caller is leaving the blur floor to the caller.
   */
  onFrame(gray: GrayImage, tMs: number): FrameResult {
    const scored = downscaleGray(gray, SCORE_LONG_EDGE);
    const dtMs = this.previousTMs === null ? this.pace.intervalMs() : tMs - this.previousTMs;
    this.previousTMs = tMs;
    this.lastTMs = tMs;
    this.analysed += 1;

    const { analysis, projections, tiles } = this.clock
      ? analyseFrame(scored, this.projections, dtMs, tMs, this.clock)
      : analyseFrame(scored, this.projections, dtMs, tMs);
    this.projections = projections;

    const blur = this.blurJudge.judge(analysis.sharpness.volNorm);
    const motion = assessMotion(analysis.motion, scored.width, scored.height);
    // The two rules stay apart all the way down: `mark_blur` and `mark_motion`
    // are separate stages in frames.py, quality.py's blur_rejection_rate counts
    // only the first, and the corrections an operator makes for them are
    // different. A frame is accepted when neither fired.
    const rejectedByMotion = motionWouldReject(motion);
    const accepted = !blur.rejected && !rejectedByMotion;

    // RAW flow into both accumulators. See the header: this is the one line in
    // the package where the distinction is easy to get wrong and expensive.
    const widths = scored.width > 0 ? analysis.motion.flowPx / scored.width : 0;
    const overlap = this.overlap.observe({
      flowPx: analysis.motion.flowPx, dtMs, widthPx: scored.width, accepted,
    });

    // Field of view, estimated from gyro against pixels where both are
    // available, so the yaw cue is anchored to the same pixel threshold as
    // everything else on whatever handset this is.
    const dYaw = this.previousOrientation && this.orientation
      ? this.orientation.yaw - this.previousOrientation.yaw
      : null;
    if (dYaw !== null && scored.width > 0) {
      this.fov.add(dYaw, analysis.motion.dxPx / scored.width, analysis.motion.tileConsensus);
    }
    const hFov = this.fov.estimate() ?? FALLBACK_HFOV_RAD;

    const glazing = glazingFindings(analysis.glare);
    // The frame-level consensus is the gate: during a shake every tile
    // disagrees with every other and singling one out is noise.
    const discontinuities = this.discontinuities.step(
      discontinuityFindings(tiles, scored.width, motion.consensusOk),
    );

    this.coverage.observe({
      tMs,
      dtMs,
      rejectedBlur: blur.rejected,
      rejectedMotion: rejectedByMotion,
      widths,
      volNorm: analysis.sharpness.volNorm,
      yaw: this.orientation ? this.orientation.yaw : null,
      yawDelta: dYaw,
      hFov,
      glare: glazing.length > 0,
    });

    this.pace.observe(analysis.costMs, tMs);
    const paceState = this.pace.state();
    const cannotKeepUp = this.pace.cannotKeepUp();
    const analysedFraction = this.analysedFraction(tMs);

    const next = this.coverage.nextAttention();
    const out = this.guidance.step({
      analysis,
      blur,
      motion,
      overlap,
      yawRateRadS: this.previousOrientation && this.orientation
        ? yawRate(this.previousOrientation, this.orientation)
        : null,
      maxYawRateRadS: maxYawRateRadS(hFov, scored.width, scored.height),
      glazing,
      discontinuities,
      coverageHint: next ? this.hintFor(next.roomId, next.reason) : null,
      degraded: paceState.degraded || cannotKeepUp,
      analysedFraction,
      nowMs: tMs,
    });

    return {
      analysis,
      accepted,
      motion,
      overlap,
      glazing,
      discontinuities,
      cue: out.primary,
      active: out.active,
      analysedFraction,
      degraded: out.degraded,
    };
  }

  /**
   * The go / no-go, from everything measured so far.
   *
   * `width`, `height` and `fps` describe the RECORDING, not the analysis image:
   * ingest.py refuses on the recorded short edge, and a capture analysed at
   * 960 px but recorded at 1080 is perfectly acceptable to it.
   */
  verdict(recording: { width: number; height: number; fps: number }): VerdictReport {
    return buildVerdict(this.verdictInput(recording));
  }

  /** The verdict's inputs, exposed so a screen can print the figures beside it. */
  verdictInput(recording: { width: number; height: number; fps: number }): VerdictInput {
    const durationS = this.lastTMs / 1000;
    return {
      durationS,
      width: recording.width,
      height: recording.height,
      fps: recording.fps,
      coverage: this.coverage.snapshot(),
      rooms: this.rooms,
      analysis: analysisConfidence(this.analysed, durationS, this.pace.cannotKeepUp()),
      surfaces: summariseDeclarations(this.declarations),
      keptFrames: this.overlap.kept,
    };
  }

  /**
   * Analysed frames as a fraction of the candidates the pipeline will decode.
   *
   * Against the PIPELINE's count and not the app's own target, because "what
   * fraction of what the pipeline will look at did we look at" is the only
   * version of the question that means anything to an operator. Capped at 1: an
   * app running faster than CANDIDATE_FPS has seen everything, not more than
   * everything.
   */
  private analysedFraction(tMs: number): number {
    const expected = (tMs / 1000) * CANDIDATE_FPS;
    // Before any time has passed there is nothing to be behind on, and 0/0 is
    // not "checking nothing" — it is the first frame.
    if (!(expected > 0)) return 1;
    return Math.min(1, this.analysed / expected);
  }

  private hintFor(roomId: string, reason: string): string {
    const name = this.rooms.find((r) => r.id === roomId)?.name ?? roomId;
    return reason === 'not started' ? `${name} not started` : name;
  }
}
