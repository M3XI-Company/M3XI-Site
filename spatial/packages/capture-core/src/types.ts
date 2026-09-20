/**
 * The shapes the capture app and its core agree on.
 *
 * Kept separate from the code that produces them so a screen can import a type
 * without pulling in an image-processing loop, and so the worker boundary has
 * something explicit to serialise across.
 */

import type { RoomKind } from '@m3xi/world-core';

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * A single-channel image. Deliberately NOT `ImageData`: everything in this
 * package must run under vitest in Node, where there is no canvas, and the
 * analysis worker is happier with a plain buffer it can transfer.
 */
export interface GrayImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** An RGBA buffer in the browser's canvas layout. */
export interface RgbaImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Per-frame analysis
// ---------------------------------------------------------------------------

export interface SharpnessScore {
  /** Raw variance of the Laplacian. What wv_camera.sharpness stores. */
  readonly vol: number;
  /** Contrast-normalised. What every threshold is written against. */
  readonly volNorm: number;
}

export interface ExposureScore {
  /** Fraction of pixels at or above SATURATION_LEVEL. */
  readonly blownFraction: number;
  /** Fraction at or below SHADOW_LEVEL. */
  readonly crushedFraction: number;
  /** Mean luma, 0-255. */
  readonly meanLuma: number;
  /** Brightest tile mean divided by darkest, >= 1. */
  readonly tileDynamicRange: number;
  /** Per-tile mean luma, row-major, TILE_GRID x TILE_GRID. */
  readonly tileLuma: readonly number[];
}

export interface GlareRegion {
  /** Tile index, row-major over the TILE_GRID grid. */
  readonly tile: number;
  /** Fraction of that tile at or above SATURATION_LEVEL. */
  readonly saturation: number;
  /**
   * `glazed_score` as reflective.py would compute it from saturation alone,
   * with no window detector available on the phone.
   */
  readonly glazedScoreFromSaturationAlone: number;
}

export interface MotionScore {
  /** Median tile displacement in pixels at the analysis resolution. */
  readonly flowPx: number;
  /** Signed global displacement, pixels, positive x rightwards in the image. */
  readonly dxPx: number;
  readonly dyPx: number;
  /** Fraction of tiles agreeing with the frame median translation. */
  readonly tileConsensus: number;
  /** Milliseconds since the previous analysed frame. */
  readonly dtMs: number;
  /** True when there was no previous frame to compare against. */
  readonly first: boolean;
}

export interface FrameAnalysis {
  readonly tMs: number;
  readonly sharpness: SharpnessScore;
  readonly exposure: ExposureScore;
  readonly glare: readonly GlareRegion[];
  readonly motion: MotionScore;
  /** Milliseconds the analysis itself took. Fed to the adaptive controller. */
  readonly costMs: number;
}

/** What the blur judge concluded, using frames.py's own rule. */
export interface BlurVerdict {
  readonly rejected: boolean;
  readonly volNorm: number;
  readonly localMedian: number;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/** Device orientation in radians. Yaw increases clockwise viewed from above. */
export interface Orientation {
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** True when the yaw is referenced to magnetic north, not an arbitrary zero. */
  readonly absolute: boolean;
  readonly tMs: number;
}

// ---------------------------------------------------------------------------
// Rooms and coverage
// ---------------------------------------------------------------------------

export interface PlannedRoom {
  readonly id: string;
  readonly name: string;
  readonly kind: RoomKind;
  /** Floor level, 0 ground, -1 basement. Drives the route order. */
  readonly level: number;
  /** True for the room the front door opens into. Exactly one should be. */
  readonly isEntrance: boolean;
}

export type RoomState = 'not_started' | 'thin' | 'done';

export interface RoomCoverage {
  readonly roomId: string;
  readonly state: RoomState;
  /** Seconds of accepted recording attributed to this room. */
  readonly seconds: number;
  /** Candidate frames analysed while in this room. */
  readonly candidates: number;
  /**
   * Candidates the BLUR rule rejected.
   *
   * Kept apart from motion rejections because frames.py reports
   * `blur_rejection_fraction` as `n_blur / len(scores)` — blur only — and
   * quality.py's `blur_rejection_rate` check is that number. Folding motion
   * rejections in would make the app report a value the pipeline will not
   * reproduce, and would tell an operator to hold the phone steadier when what
   * they were doing was walking too fast.
   */
  readonly rejectedBlur: number;
  /** Candidates the MOTION rule rejected: too fast, or moving incoherently. */
  readonly rejectedMotion: number;
  /** Either. This is what the frame budget is reduced by. */
  readonly rejected: number;
  /** Accumulated displacement in image widths. The selector's own unit. */
  readonly widths: number;
  /**
   * The share of `widths` that came from moving rather than turning. Null
   * without orientation, because the two cannot be separated without a gyro.
   */
  readonly translationWidths: number | null;
  /** Frames this room will contribute to the reconstruction, predicted. */
  readonly predictedFrames: number;
  /** Fraction of the yaw circle observed, 0-1. Null without orientation. */
  readonly yawCoverage: number | null;
  /** Bins observed, for the dial. Empty without orientation. */
  readonly yawBins: readonly boolean[];
  /** Median contrast-normalised sharpness of accepted frames. */
  readonly medianVolNorm: number;
  /** Tiles where glazing or a mirror was seen, for the operator's attention. */
  readonly glareSeconds: number;
  /** What is still missing, in words an operator can act on. */
  readonly gaps: readonly string[];
}

export interface CoverageSnapshot {
  readonly rooms: readonly RoomCoverage[];
  readonly totalSeconds: number;
  readonly totalCandidates: number;
  readonly totalRejectedBlur: number;
  readonly totalRejectedMotion: number;
  /** Rejected by either rule. */
  readonly totalRejected: number;
  readonly totalWidths: number;
  /** Null without orientation. */
  readonly totalTranslationWidths: number | null;
  readonly predictedFrames: number;
  /**
   * Blur rejections over candidates. This is quality.py's `blur_rejection_rate`
   * and frames.py's `blur_rejection_fraction`, and it counts BLUR ONLY.
   */
  readonly blurRejectionRate: number;
  /** Motion rejections over candidates. A separate failure, separate advice. */
  readonly motionRejectionRate: number;
  readonly entranceRevisited: boolean;
  readonly doorwaysCrossed: number;
  readonly hasOrientation: boolean;
}

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

export type CueId =
  | 'blur' | 'too_fast' | 'turning_fast' | 'overlap_gap' | 'blown'
  | 'too_dark' | 'uneven_light' | 'glare' | 'reflection' | 'coverage'
  | 'steady' | 'degraded';

export type CueLevel = 'act' | 'advise' | 'ok';

export interface Cue {
  readonly id: CueId;
  readonly level: CueLevel;
  /** Two or three words. This is what someone reads while walking. */
  readonly headline: string;
  /** One short sentence. Read when they stop, not while they move. */
  readonly detail: string;
  readonly since: number;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export type RouteStepKind = 'entrance' | 'room' | 'doorway' | 'stairs' | 'close';

export interface RouteStep {
  readonly index: number;
  readonly kind: RouteStepKind;
  readonly roomId: string | null;
  readonly title: string;
  /** Exactly one line. The app shows a route, not a manual. */
  readonly why: string;
  readonly seconds: number;
}

export interface Route {
  readonly steps: readonly RouteStep[];
  readonly estimatedSeconds: number;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Verdict = 'go' | 'fix' | 'no_go';

export interface VerdictFinding {
  /** The pipeline check or stage this predicts. */
  readonly check: string;
  readonly severity: 'blocking' | 'review' | 'note';
  readonly measured: number;
  readonly threshold: number;
  readonly higherIsBetter: boolean;
  /** What the operator should do, naming the room where there is one. */
  readonly action: string;
}

export interface VerdictReport {
  readonly verdict: Verdict;
  readonly headline: string;
  readonly findings: readonly VerdictFinding[];
  /** Checks the phone cannot evaluate. Named, never silently omitted. */
  readonly notAssessed: readonly string[];
  readonly predictedFrames: number;
  readonly blurRejectionRate: number;
  readonly durationS: number;
}
