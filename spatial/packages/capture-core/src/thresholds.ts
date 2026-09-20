/**
 * Every number the capture app judges an operator by, and where it came from.
 *
 * This file is the contract between the phone in someone's hand and
 * `spatial/pipeline/worldengine/stages/*.py`. A capture app that invents its
 * own thresholds is worse than one with no guidance at all: it tells an
 * operator their walk was fine and then the pipeline rejects it thirty-five
 * GPU-minutes and $0.74 later, by which time they have left the property.
 *
 * So each constant below is one of three things, and says which:
 *
 *   MIRRORED   the identical value from a named pipeline constant. Changing it
 *              here without changing it there is a bug.
 *   DERIVED    computed from mirrored constants plus stated physics or
 *              geometry. The derivation is written out.
 *   CAPTURE    a value the pipeline does not have, because the pipeline never
 *              sees a live camera. These are argued from the pipeline's
 *              consequences and are labelled so nobody mistakes them for
 *              pipeline truth.
 *
 * Nothing here is a round number chosen because it looked reasonable.
 */

// ---------------------------------------------------------------------------
// MIRRORED — stages/frames.py
// ---------------------------------------------------------------------------

/** frames.py TARGET_FPS. The rate the selector aims to keep frames at. */
export const TARGET_FPS = 2.5;

/**
 * frames.py CANDIDATE_FPS. The rate the pipeline DECODES at, and therefore the
 * only rate at which a live measurement is comparable to a pipeline one. Flow
 * measured over any other interval must be rescaled to this one before it is
 * compared to MAX_FLOW_FRACTION — see `toCandidateInterval`.
 */
export const CANDIDATE_FPS = 7.5;

/** frames.py BLUR_REL_FACTOR. Rejected below this fraction of the local median. */
export const BLUR_REL_FACTOR = 0.55;
/** frames.py BLUR_ABS_FLOOR. Backstop for when a whole window is blurred. */
export const BLUR_ABS_FLOOR = 0.0020;
/** frames.py BLUR_WINDOW, in CANDIDATE_FPS frames (31 frames = 4.13 s). */
export const BLUR_WINDOW = 31;

/** frames.py MIN_TRACK_INLIER_RATIO. */
export const MIN_TRACK_INLIER_RATIO = 0.55;
/** frames.py MAX_FLOW_FRACTION, as a fraction of the image DIAGONAL. */
export const MAX_FLOW_FRACTION = 0.16;

/** frames.py TARGET_DISPLACEMENT_FRAC, as a fraction of image WIDTH. */
export const TARGET_DISPLACEMENT_FRAC = 0.30;
/** frames.py MIN_DISPLACEMENT_FRAC. Below this a frame is redundant. */
export const MIN_DISPLACEMENT_FRAC = 0.10;
/** frames.py MAX_DISPLACEMENT_FRAC. Above this the pose graph fractures. */
export const MAX_DISPLACEMENT_FRAC = 0.55;

/** frames.py MIN_FRAMES / MAX_FRAMES / ABSOLUTE_MIN_FRAMES. */
export const MIN_FRAMES = 200;
export const MAX_FRAMES = 400;
export const ABSOLUTE_MIN_FRAMES = 60;

/**
 * frames.py SCORE_LONG_EDGE. The app scores at exactly this resolution.
 *
 * This is not an efficiency choice, it is a correctness one. Variance of the
 * Laplacian is resolution-dependent — the same scene sampled twice as finely
 * has roughly four times the gradient energy per pixel pair — so BLUR_ABS_FLOOR
 * is only meaningful against a 960px long edge. Score anywhere else and the
 * absolute floor silently stops meaning anything.
 */
export const SCORE_LONG_EDGE = 960;

/**
 * frames.py run(): a capture with more than this fraction of candidates
 * rejected as blurred earns the "capture technique is the limiting factor"
 * warning. The live app should never let an operator reach it.
 */
export const BLUR_FRACTION_WARN = 0.25;

// ---------------------------------------------------------------------------
// MIRRORED — stages/ingest.py
// ---------------------------------------------------------------------------

/** ingest.py MIN_DURATION_S. Below this the capture is refused outright. */
export const MIN_DURATION_S = 45.0;
/** ingest.py MAX_DURATION_S. Above this, cost and subsampling both degrade. */
export const MAX_DURATION_S = 720.0;
/** ingest.py MIN_SHORT_EDGE. Below this, pose error roughly doubles. */
export const MIN_SHORT_EDGE = 1080;
/** ingest.py MIN_FPS. Below this, blur rejection has nothing to choose from. */
export const MIN_SOURCE_FPS = 24.0;

// ---------------------------------------------------------------------------
// MIRRORED — stages/quality.py (the gate the build is judged by)
// ---------------------------------------------------------------------------

/** quality.py blur_rejection_rate threshold, lower is better. */
export const QUALITY_BLUR_REJECTION_RATE = 0.30;
/** quality.py unobserved_fraction threshold, lower is better. */
export const QUALITY_UNOBSERVED_FRACTION = 0.25;
/** quality.py room_completeness threshold, higher is better. */
export const QUALITY_ROOM_COMPLETENESS = 0.80;
/** quality.py navigation_continuity threshold. Exactly 1.0: every room reachable. */
export const QUALITY_NAVIGATION_CONTINUITY = 1.0;

// ---------------------------------------------------------------------------
// MIRRORED — reflective.py
// ---------------------------------------------------------------------------

/**
 * reflective.py SATURATION_LEVEL. Pixels at or above this are clipped; not 255
 * because phone ISPs land blown highlights in the 248-255 band.
 */
export const SATURATION_LEVEL = 248;

/**
 * reflective.py GLAZED_THRESHOLD (0.45) and the saturation weight in
 * `glazed_score` (0.50).
 *
 * DERIVED: with no window detector on the phone, saturation is the only term
 * the app can compute. 0.50 * s >= 0.45 means a region at 90% clipped is
 * flagged as glazing by the pipeline on saturation ALONE. That is the point at
 * which the operator is not looking at a bright wall, they are looking out of
 * a window, and the pipeline will treat it as one.
 */
export const GLAZED_THRESHOLD = 0.45;
export const GLAZED_SATURATION_WEIGHT = 0.50;
export const REGION_SATURATION_CERTAIN = GLAZED_THRESHOLD / GLAZED_SATURATION_WEIGHT; // 0.90

/**
 * reflective.py REFLECTIVE_THRESHOLD. A surface is flagged as a mirror at this
 * combined score.
 *
 * MIRRORED, and carried here for one reason only: so `reflective.ts` can state,
 * in the operator's units, how far short of it the phone's evidence falls. The
 * phone has NONE of the three terms that make up `reflective_score` — mirror
 * detection, depth-behind-plane and multi-view view-dependence all need either
 * a model or a trained splat. Quoting the threshold the phone cannot reach is
 * how the app says "I cannot tell you this" with a number attached, instead of
 * inventing a mirror score of its own that would agree with the pipeline only
 * by luck.
 */
export const REFLECTIVE_THRESHOLD = 0.50;

/**
 * Fraction of a tile that must be clipped before the tile is reported as
 * probable glazing rather than merely bright.
 *
 * DERIVED: `REGION_SATURATION_CERTAIN` (0.90) is where saturation ALONE carries
 * `glazed_score` over the flag. Half of it is where saturation carries half the
 * evidence and the window detector the pipeline WILL run would take it the rest
 * of the way. Reporting at the half point is the moment an operator can still
 * do something; reporting at 0.90 is reporting a fact, not guidance.
 */
export const REGION_SATURATION_REPORT = REGION_SATURATION_CERTAIN / 2; // 0.45

// ---------------------------------------------------------------------------
// DERIVED — live analysis
// ---------------------------------------------------------------------------

/**
 * The rate the on-device analyser aims to run at, in Hz.
 *
 * DERIVED from CANDIDATE_FPS. Analysing slower than 7.5 Hz means pipeline
 * candidates exist that the app never judged, so a burst of blur can pass
 * unremarked. Analysing much faster buys nothing for blur — those frames will
 * never be decoded — but does buy responsiveness, and a cue that arrives 400 ms
 * after the mistake is a cue about the wrong doorway. 10 Hz is one comfortable
 * step above the candidate rate: at a 0.7 m/s walking pace it is one judgement
 * every 7 cm.
 */
export const ANALYSIS_HZ = 10;

/**
 * The floor the adaptive controller will not go below.
 *
 * CAPTURE: below CANDIDATE_FPS the app is no longer seeing every frame the
 * pipeline will see, so guidance stops being a faithful preview. When a device
 * cannot sustain this, the app says the guidance is degraded rather than
 * quietly becoming decorative.
 */
export const ANALYSIS_HZ_FLOOR = CANDIDATE_FPS;

/**
 * Per-frame analysis budget in milliseconds.
 *
 * DERIVED: at ANALYSIS_HZ the interval is 100 ms. Holding analysis to a third
 * of its own interval leaves the encoder, the compositor and the preview the
 * rest. Above this the adaptive controller lowers the rate rather than the
 * resolution, because lowering the resolution would invalidate BLUR_ABS_FLOOR.
 */
export const ANALYSIS_BUDGET_MS = 33;

/**
 * Trailing window, in analysis frames, standing in for frames.py's CENTRED
 * 31-candidate rolling median.
 *
 * DERIVED: BLUR_WINDOW / CANDIDATE_FPS = 4.13 s of history, converted to the
 * app's own rate. It is trailing rather than centred because the future is not
 * available live. The consequence is asymmetric and worth stating: at the
 * START of a blurred burst the live judgement is slightly HARSHER than the
 * pipeline's (the median is still made of sharp frames), and at the END of one
 * slightly softer. Harsher-at-onset is the right way round — it warns while
 * the operator is still doing the thing that caused it.
 */
export function blurWindowFrames(analysisHz: number): number {
  return Math.max(5, Math.round((BLUR_WINDOW / CANDIDATE_FPS) * analysisHz));
}

/**
 * Rescale a flow magnitude measured over `dtMs` into the displacement the
 * pipeline would measure between two consecutive candidates.
 *
 * Flow is displacement per unit time, so the conversion is linear in the
 * interval ratio. Without it, an app sampling at 10 Hz would compare a 100 ms
 * displacement against a threshold written for a 133 ms one and let a 33%
 * overspeed through.
 *
 * USE THIS FOR INSTANTANEOUS COMPARISONS ONLY, never before accumulating.
 * `MAX_FLOW_FRACTION` is a limit on ONE candidate interval, so a live rate must
 * be converted to that interval before the comparison. The overlap band is not:
 * it is a limit on displacement ACCUMULATED between kept frames, and an
 * accumulated path length is a property of the path, not of how often it was
 * sampled. Rescaling each sample and then summing them inflates the total by
 * exactly analysisHz / CANDIDATE_FPS — a third, at 10 Hz — which would tell an
 * operator a room was covered when three quarters of it was. `overlap.ts`
 * accumulates raw measured displacement for that reason.
 */
export function toCandidateInterval(flow: number, dtMs: number): number {
  if (!(dtMs > 0)) return 0;
  return flow * ((1000 / CANDIDATE_FPS) / dtMs);
}

/**
 * Maximum displacement between consecutive candidates, as a fraction of image
 * WIDTH, before frames.py `mark_motion` rejects the frame.
 *
 * DERIVED: MAX_FLOW_FRACTION is a fraction of the DIAGONAL, and everything
 * else in the selector is a fraction of the width, so the two are only
 * comparable once the aspect ratio is applied. For 16:9 this is
 * 0.16 * sqrt(1 + (9/16)^2) = 0.1835 of the width — tighter than
 * MAX_DISPLACEMENT_FRAC, which is why motion rejection bites before the pose
 * graph starts to fracture.
 */
export function maxFlowFracOfWidth(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return MAX_FLOW_FRACTION;
  return MAX_FLOW_FRACTION * Math.hypot(width, height) / width;
}

/**
 * Advisory margin on the motion limit.
 *
 * CAPTURE: 0.75. A cue that fires exactly at the rejection threshold arrives
 * when frames are already being lost. Firing at three quarters of it gives an
 * operator walking at 0.7 m/s roughly a second to slow down, which is about
 * how long a person takes to act on a glanced instruction.
 */
export const MOTION_ADVISORY_FACTOR = 0.75;

/**
 * Yaw rate, in radians per second, at which turning alone puts the frame past
 * the motion-rejection limit.
 *
 * DERIVED: a pure yaw of psi radians shifts the image by psi / hFov of its
 * width. Setting that equal to `maxFlowFracOfWidth` over one candidate
 * interval gives the rate below. For a 16:9 frame from a 65-degree lens:
 * 0.1835 * 1.1345 rad * 7.5 = 1.56 rad/s, i.e. about 89 degrees per second —
 * a full turn in no less than four seconds.
 */
export function maxYawRateRadS(hFovRad: number, width: number, height: number): number {
  return maxFlowFracOfWidth(width, height) * hFovRad * CANDIDATE_FPS;
}

/**
 * Fallback horizontal field of view, in radians, for a phone rear camera in
 * 16:9 video.
 *
 * CAPTURE: 65 degrees. Used ONLY until `FovEstimator` has calibrated the real
 * one from gyro-versus-pixel agreement, and only for the yaw cue. Every other
 * threshold is measured in pixels and needs no lens model at all.
 */
export const FALLBACK_HFOV_RAD = (65 * Math.PI) / 180;

// ---------------------------------------------------------------------------
// DERIVED — the overlap band, and what the pipeline does NOT check
// ---------------------------------------------------------------------------

/**
 * Displacement between consecutive KEPT frames at which the pipeline stops
 * treating a candidate as redundant, as a fraction of image width.
 *
 * This is `MIN_DISPLACEMENT_FRAC` under its proper name, and the rename is the
 * point. `MIN/TARGET/MAX_DISPLACEMENT_FRAC` are limits on the displacement
 * `select_by_overlap` ACCUMULATES between keepers, not on the flow of a single
 * candidate. A candidate's own flow at CANDIDATE_FPS is roughly
 * TARGET_DISPLACEMENT_FRAC * TARGET_FPS / CANDIDATE_FPS = 0.10 of the width for
 * a correctly paced walk, which is numerically equal to MIN_DISPLACEMENT_FRAC
 * and means something completely different. Comparing a per-candidate flow to
 * the overlap band tells a correctly-paced operator they are being redundant.
 */
export const OVERLAP_REDUNDANT_BELOW = MIN_DISPLACEMENT_FRAC;
export const OVERLAP_TARGET = TARGET_DISPLACEMENT_FRAC;

/**
 * Accumulated displacement above which the pose graph starts to fracture.
 *
 * MIRRORED from frames.py MAX_DISPLACEMENT_FRAC, and the one mirrored constant
 * the pipeline itself never enforces. Read `select_by_overlap`: it backs the
 * target spacing DOWN when there are too few frames and never checks the upper
 * bound, because the only way to exceed it is for every candidate across a
 * stretch to be rejected — and by the time frames.py runs, that stretch is
 * already unrecoverable. The live app is the only place in the system where
 * something can still be done about it, which is why `overlap.ts` raises a cue
 * on it and the pipeline does not.
 */
export const OVERLAP_FRACTURE_ABOVE = MAX_DISPLACEMENT_FRAC;

/**
 * Per-candidate displacement a correctly paced walk produces, as a fraction of
 * image width.
 *
 * DERIVED: the selector keeps one frame per OVERLAP_TARGET of accumulated
 * travel and aims to keep them at TARGET_FPS, so CANDIDATE_FPS / TARGET_FPS = 3
 * candidates separate two keepers and each contributes a third of the target.
 * Used only to label an instantaneous pace as slow or brisk; nothing is
 * rejected on it, because nothing in the pipeline rejects on it.
 */
export const CANDIDATE_TARGET_FRAC = TARGET_DISPLACEMENT_FRAC * (TARGET_FPS / CANDIDATE_FPS);

/**
 * Fraction of the pipeline's candidates the app must have actually analysed
 * before its verdict is allowed to say "go".
 *
 * CAPTURE: 0.90. A go/no-go computed from a third of the frames is not a
 * cautious verdict, it is a false one — the blur rule is a comparison against a
 * rolling median, and a median over a third of the candidates is a different
 * statistic from the one frames.py will compute. Ninety percent is where the
 * sampled median and the full median agree closely enough that the verdict is
 * about the capture rather than about the phone. Below it the app still shows
 * every measurement it made, and says plainly that it is not a verdict.
 */
export const VERDICT_MIN_ANALYSED_FRACTION = 0.90;

// ---------------------------------------------------------------------------
// CAPTURE — exposure
// ---------------------------------------------------------------------------

/**
 * Whole-frame clipped fraction at which the app tells the operator to change
 * angle.
 *
 * CAPTURE, argued from frames.py: a clipped pixel has no gradient, so it adds
 * nothing to the Laplacian numerator while still adding to the intensity
 * variance denominator. Both move vol_norm the same way. `blur.test.ts`
 * measures it: clipping a quarter of a sharp frame drops vol_norm well below
 * the 0.55x local median that `mark_blur` rejects at. 0.25 is therefore not a
 * taste threshold — it is where the blur stage starts throwing the frame away
 * for a reason the operator would never guess from looking at the screen.
 */
export const BLOWN_FRACTION_ACT = 0.25;
/** CAPTURE: advisory at 10%, one step before it starts costing frames. */
export const BLOWN_FRACTION_WARN = 0.10;

/**
 * Level at or below which a pixel is crushed.
 *
 * CAPTURE: 8 of 255. Below it the 8-bit quantisation step is a larger fraction
 * of the local signal than the four-neighbour Laplacian can separate from
 * sensor noise, so the pixels are as gradient-free as clipped ones and count
 * against the frame the same way.
 */
export const SHADOW_LEVEL = 8;
/** CAPTURE: same argument as BLOWN_FRACTION_ACT, applied to crushed shadow. */
export const CRUSHED_FRACTION_ACT = 0.35;

/**
 * Ratio between the brightest and darkest tile mean at which one exposure
 * cannot serve the frame.
 *
 * CAPTURE, argued from bilagrid.py: the bilateral grid absorbs the ISP's
 * exposure RAMP between frames, which is why walking between rooms is fine.
 * It cannot recover detail the sensor never captured WITHIN a frame. One stop
 * is 2x; bilagrid.py calls a room-to-room change of "well over a stop" the
 * thing worth correcting, so two stops inside a single frame — 4x — is where
 * the app says to change angle.
 */
export const TILE_DYNAMIC_RANGE_ACT = 4.0;

/** CAPTURE: tiles per axis for the exposure and motion-consensus grids. */
export const TILE_GRID = 4;

/**
 * Fraction of tiles whose displacement must agree with the frame median for
 * the motion to count as one rigid transform.
 *
 * MIRRORED value, DERIVED meaning: frames.py measures the fraction of
 * Lucas-Kanade tracks consistent with one HOMOGRAPHY and rejects below 0.55.
 * The phone has neither the budget for LK nor for a RANSAC homography, so the
 * app measures the fraction of tiles consistent with one TRANSLATION. That is
 * a strictly stronger requirement — real perspective change through a doorway
 * breaks a translation fit that a homography would absorb — so the same 0.55
 * is used but the cue requires persistence (see MOTION_CUE_RAISE) rather than
 * firing on a single frame.
 */
export const MIN_TILE_CONSENSUS = MIN_TRACK_INLIER_RATIO;

/**
 * Tolerance on a tile's displacement before it counts as disagreeing,
 * as a fraction of the image width.
 *
 * CAPTURE: 0.02, i.e. about 19 px at the 960 px scoring width. Parallax
 * between a near and a far tile in a 3 m room at walking pace is around this
 * size, so a tighter tolerance would call every honest walk incoherent.
 */
export const TILE_AGREEMENT_FRAC = 0.02;

// ---------------------------------------------------------------------------
// CAPTURE — cue hysteresis
// ---------------------------------------------------------------------------

/**
 * A cue must be true for this many consecutive analysis frames before it is
 * shown, and false for this many before it is withdrawn.
 *
 * CAPTURE: 3 up (300 ms at ANALYSIS_HZ), 8 down (800 ms). Asymmetric on
 * purpose. Raising slowly stops a single bad frame from flashing a warning at
 * someone who is walking; clearing slowly stops the cue strobing while they
 * correct. 300 ms is under the quarter-second at which a person stops
 * attributing a message to what they just did.
 */
export const CUE_RAISE_FRAMES = 3;
export const CUE_CLEAR_FRAMES = 8;
/** CAPTURE: motion-consensus cue needs longer, per MIN_TILE_CONSENSUS above. */
export const MOTION_CUE_RAISE = 5;

/**
 * Minimum time a cue stays on screen once shown, in milliseconds.
 *
 * CAPTURE: 900 ms. Shorter than this and a glancing operator misses it
 * entirely, which is worse than not showing it — they learn the banner is
 * noise.
 */
export const CUE_MIN_VISIBLE_MS = 900;

// ---------------------------------------------------------------------------
// CAPTURE — coverage
// ---------------------------------------------------------------------------

/**
 * Width of a yaw coverage bin, in degrees.
 *
 * CAPTURE: 15 degrees, 24 bins to the circle. Narrower than a quarter of a
 * typical 65-degree lens, so a single stationary frame lights up about four
 * bins and the model cannot claim a room was swept from one still pose.
 */
export const YAW_BIN_DEG = 15;
export const YAW_BINS = 360 / YAW_BIN_DEG;

/**
 * Fraction of the yaw circle a room needs before its coverage counts as
 * complete.
 *
 * CAPTURE: 0.75. A room walked round its perimeter facing the walls lights
 * every bin. A room shot from the doorway lights about a third. Three quarters
 * is reachable without walking a full circle in a fitted bedroom where the bed
 * blocks one corner, and unreachable from a single standpoint.
 */
export const ROOM_YAW_COVERAGE_TARGET = 0.75;

/**
 * Displacement a room must accumulate, in image widths, to be counted done.
 *
 * DERIVED, and the load-bearing idea in the coverage model. `select_by_overlap`
 * keeps one frame per TARGET_DISPLACEMENT_FRAC of accumulated flow, so the
 * number of frames a room will contribute to the reconstruction is exactly
 * its accumulated displacement divided by 0.30 — no pose estimation required.
 * MIN_FRAMES / (typical 6-room property) is about 33 frames per room, so a
 * room needs 33 * 0.30 = 10 image widths of travel. `roomDisplacementTarget`
 * does this properly against the real room count.
 */
export function roomDisplacementTarget(roomCount: number): number {
  const fromFrameBudget = (MIN_FRAMES / Math.max(1, roomCount)) * TARGET_DISPLACEMENT_FRAC;
  return Math.max(fromFrameBudget, ROOM_MIN_WIDTHS);
}

/**
 * The floor under `roomDisplacementTarget`, in image widths.
 *
 * DERIVED: covering ROOM_YAW_COVERAGE_TARGET of the yaw circle means sweeping
 * 0.75 * 2pi = 4.71 rad, which through a 65-degree lens is 4.16 image widths —
 * but every one of those widths is pure rotation, and a frame that rotated
 * without translating has no baseline, so nothing can be triangulated from it.
 * Doubling it requires as much travel as turning, which is the minimum that
 * gives a room both angular coverage and parallax. Without this floor, a
 * twelve-room house would be asked for five image widths a room and every
 * room would come out `inferred` rather than `reconstructed`, failing
 * quality.py's room_completeness at 0.80.
 */
export const ROOM_MIN_WIDTHS =
  2 * ((ROOM_YAW_COVERAGE_TARGET * Math.PI * 2) / FALLBACK_HFOV_RAD);

/**
 * Seconds a comfortable indoor pace takes to accumulate one image width of
 * displacement.
 *
 * DERIVED: at 0.7 m/s — the walking pace frames.py's TARGET_FPS comment
 * assumes — and 2.5 m from the wall being filmed, a 65-degree lens spans
 * 2 * 2.5 * tan(32.5) = 3.19 m of that wall, crossed in 4.6 s. Used only to
 * estimate how long the suggested route will take, never to judge anybody.
 */
export const SECONDS_PER_IMAGE_WIDTH = 4.5;

/**
 * Minimum share of a room's accumulated displacement that must come from
 * TRANSLATION rather than rotation.
 *
 * CAPTURE, and the one place this app knows something frames.py does not.
 * `select_by_overlap` measures flow and cannot tell a walk from a spin, so a
 * capture shot as a series of panoramas from the middle of each room sails
 * through frame selection and then falls apart in pose: every frame shares an
 * optical centre, there is no baseline, nothing triangulates, and
 * `pose_consistency` reports a disconnected component — one room floating
 * relative to the rest. Subtracting the gyro's contribution from the measured
 * flow separates the two live. Half is the requirement because a perimeter
 * walk facing the walls is naturally about half rotation.
 */
export const MIN_TRANSLATION_SHARE = 0.5;

/** DERIVED: frames a stretch of walking will contribute to the reconstruction. */
export function predictedKeeperCount(accumulatedWidths: number): number {
  return Math.floor(Math.max(0, accumulatedWidths) / TARGET_DISPLACEMENT_FRAC);
}

/**
 * Seconds the operator should stand still at the entrance, at the start and
 * again at the end.
 *
 * CAPTURE: 3 s. At CANDIDATE_FPS that is 22 near-identical candidates of the
 * same view from the same place. `select_by_overlap` discards them as
 * redundant — which is the point: they cost nothing, and bundle adjustment
 * gets a dense cluster of mutually-matchable frames at the one place the walk
 * returns to, which is what closes the loop.
 */
export const ENTRANCE_DWELL_S = 3;

/**
 * Seconds to spend crossing a doorway.
 *
 * CAPTURE: 2 s, from the selector's arithmetic. A doorway is the only place in
 * a flat where two rooms are visible at once, so it is the only place the pose
 * graph can connect them. At 0.7 m/s a normal stride carries a person through
 * a 0.9 m opening in 1.3 s, which yields about 10 candidates and perhaps three
 * keepers. Two seconds of deliberate crossing roughly doubles that.
 */
export const DOORWAY_CROSS_S = 2;

// ---------------------------------------------------------------------------
// The MIRRORED manifest — machine-readable, so the two sides cannot drift
// ---------------------------------------------------------------------------

/**
 * How a mirrored value is found in the Python source.
 *
 *   assign     a module-level `NAME = <number>` statement.
 *   checkspec  a positional `CheckSpec("name", <threshold>, ...)` entry in
 *              quality.py's SPECS tuple.
 *   expr       a bare literal inside an expression, matched by a regex whose
 *              first capture group is the number. Used where the pipeline never
 *              gave the value a name. Those are the DANGEROUS ones: an unnamed
 *              literal is exactly what somebody edits without thinking about a
 *              TypeScript package on the other side of the repository.
 */
export type MirrorKind = 'assign' | 'checkspec' | 'expr';

export interface MirroredConstant {
  /** The export in this file. */
  readonly name: string;
  /** Its value, captured here so the test compares numbers and not names. */
  readonly value: number;
  /** Path relative to `spatial/pipeline/worldengine/`. */
  readonly file: string;
  /** Python symbol, quality.py check name, or a description for `expr`. */
  readonly symbol: string;
  readonly how: MirrorKind;
  /** For `expr` only: a regex source whose group 1 is the number. */
  readonly pattern?: string;
}

/**
 * Every constant in this file that claims to be a copy of a pipeline number.
 *
 * A comment saying "frames.py TARGET_FPS" is a promise nothing checks, and this
 * package's whole reason for existing is that an unchecked promise between the
 * phone and the pipeline costs an operator a second visit to a property. So the
 * claims are data, and `__tests__/mirrored.test.ts` reads the Python and fails
 * if any of them has stopped being true.
 *
 * Two alternatives were rejected. Generating this file from the Python at build
 * time would remove the drift entirely, but it would also remove the argument:
 * half the value of `thresholds.ts` is the prose explaining what each number
 * does to an operator, and generated files do not carry arguments. Parsing the
 * Python at RUNTIME is worse still — it would put a filesystem read and a
 * pipeline checkout inside a library that has to run in a phone browser.
 * Checking at test time costs one file read per constant in CI and nothing at
 * all on the device.
 */
export const MIRRORED_FROM_PIPELINE: readonly MirroredConstant[] = [
  // stages/frames.py
  { name: 'TARGET_FPS', value: TARGET_FPS, file: 'stages/frames.py', symbol: 'TARGET_FPS', how: 'assign' },
  { name: 'CANDIDATE_FPS', value: CANDIDATE_FPS, file: 'stages/frames.py', symbol: 'CANDIDATE_FPS', how: 'assign' },
  { name: 'BLUR_REL_FACTOR', value: BLUR_REL_FACTOR, file: 'stages/frames.py', symbol: 'BLUR_REL_FACTOR', how: 'assign' },
  { name: 'BLUR_ABS_FLOOR', value: BLUR_ABS_FLOOR, file: 'stages/frames.py', symbol: 'BLUR_ABS_FLOOR', how: 'assign' },
  { name: 'BLUR_WINDOW', value: BLUR_WINDOW, file: 'stages/frames.py', symbol: 'BLUR_WINDOW', how: 'assign' },
  { name: 'MIN_TRACK_INLIER_RATIO', value: MIN_TRACK_INLIER_RATIO, file: 'stages/frames.py', symbol: 'MIN_TRACK_INLIER_RATIO', how: 'assign' },
  { name: 'MAX_FLOW_FRACTION', value: MAX_FLOW_FRACTION, file: 'stages/frames.py', symbol: 'MAX_FLOW_FRACTION', how: 'assign' },
  { name: 'TARGET_DISPLACEMENT_FRAC', value: TARGET_DISPLACEMENT_FRAC, file: 'stages/frames.py', symbol: 'TARGET_DISPLACEMENT_FRAC', how: 'assign' },
  { name: 'MIN_DISPLACEMENT_FRAC', value: MIN_DISPLACEMENT_FRAC, file: 'stages/frames.py', symbol: 'MIN_DISPLACEMENT_FRAC', how: 'assign' },
  { name: 'MAX_DISPLACEMENT_FRAC', value: MAX_DISPLACEMENT_FRAC, file: 'stages/frames.py', symbol: 'MAX_DISPLACEMENT_FRAC', how: 'assign' },
  { name: 'MIN_FRAMES', value: MIN_FRAMES, file: 'stages/frames.py', symbol: 'MIN_FRAMES', how: 'assign' },
  { name: 'MAX_FRAMES', value: MAX_FRAMES, file: 'stages/frames.py', symbol: 'MAX_FRAMES', how: 'assign' },
  { name: 'ABSOLUTE_MIN_FRAMES', value: ABSOLUTE_MIN_FRAMES, file: 'stages/frames.py', symbol: 'ABSOLUTE_MIN_FRAMES', how: 'assign' },
  { name: 'SCORE_LONG_EDGE', value: SCORE_LONG_EDGE, file: 'stages/frames.py', symbol: 'SCORE_LONG_EDGE', how: 'assign' },
  {
    name: 'BLUR_FRACTION_WARN', value: BLUR_FRACTION_WARN, how: 'expr',
    file: 'stages/frames.py', symbol: 'run(): the blur_frac warning literal',
    pattern: 'blur_frac\\s*>\\s*([0-9.]+)',
  },

  // stages/ingest.py
  { name: 'MIN_DURATION_S', value: MIN_DURATION_S, file: 'stages/ingest.py', symbol: 'MIN_DURATION_S', how: 'assign' },
  { name: 'MAX_DURATION_S', value: MAX_DURATION_S, file: 'stages/ingest.py', symbol: 'MAX_DURATION_S', how: 'assign' },
  { name: 'MIN_SHORT_EDGE', value: MIN_SHORT_EDGE, file: 'stages/ingest.py', symbol: 'MIN_SHORT_EDGE', how: 'assign' },
  { name: 'MIN_SOURCE_FPS', value: MIN_SOURCE_FPS, file: 'stages/ingest.py', symbol: 'MIN_FPS', how: 'assign' },

  // stages/quality.py — the gate the finished world is judged by
  { name: 'QUALITY_BLUR_REJECTION_RATE', value: QUALITY_BLUR_REJECTION_RATE, file: 'stages/quality.py', symbol: 'blur_rejection_rate', how: 'checkspec' },
  { name: 'QUALITY_UNOBSERVED_FRACTION', value: QUALITY_UNOBSERVED_FRACTION, file: 'stages/quality.py', symbol: 'unobserved_fraction', how: 'checkspec' },
  { name: 'QUALITY_ROOM_COMPLETENESS', value: QUALITY_ROOM_COMPLETENESS, file: 'stages/quality.py', symbol: 'room_completeness', how: 'checkspec' },
  { name: 'QUALITY_NAVIGATION_CONTINUITY', value: QUALITY_NAVIGATION_CONTINUITY, file: 'stages/quality.py', symbol: 'navigation_continuity', how: 'checkspec' },

  // reflective.py
  { name: 'SATURATION_LEVEL', value: SATURATION_LEVEL, file: 'reflective.py', symbol: 'SATURATION_LEVEL', how: 'assign' },
  { name: 'GLAZED_THRESHOLD', value: GLAZED_THRESHOLD, file: 'reflective.py', symbol: 'GLAZED_THRESHOLD', how: 'assign' },
  { name: 'REFLECTIVE_THRESHOLD', value: REFLECTIVE_THRESHOLD, file: 'reflective.py', symbol: 'REFLECTIVE_THRESHOLD', how: 'assign' },
  {
    name: 'GLAZED_SATURATION_WEIGHT', value: GLAZED_SATURATION_WEIGHT, how: 'expr',
    file: 'reflective.py', symbol: 'glazed_score: the saturation weight',
    pattern: '([0-9.]+)\\s*\\*\\s*self\\.saturation_fraction',
  },
];
