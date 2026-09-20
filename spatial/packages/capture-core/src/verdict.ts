/**
 * The last screen before the operator leaves, and the reason this package is
 * not a nice-to-have.
 *
 * A walkthrough that fails costs a second appointment. Getting back into a
 * vendor's flat is days, sometimes a week, sometimes never — and the pipeline
 * does not find out until thirty-five GPU-minutes and about $0.74 after the
 * upload, by which time the operator is three properties away. Everything else
 * in this package exists so that this function can be computed while the
 * operator is still standing in the hall with their shoes on.
 *
 * THE RULE IT IS BUILT ON: every finding here is measured against a constant
 * the pipeline will judge the capture by, and says which. No finding is
 * invented. Where the phone genuinely cannot evaluate a check — and there are
 * eight of them, the majority of quality.py's gate — the check is NAMED in
 * `notAssessed` rather than quietly dropped. A verdict that silently covers
 * four of twelve checks and presents itself as a verdict is worse than no
 * verdict, because the operator stops looking.
 *
 * WHY 'fix' EXISTS BETWEEN 'go' AND 'no_go'. The pipeline has three outcomes
 * too — pass, review, fail — and they are not the same three. `no_go` means a
 * stage will raise, so there is no world at all and the visit is wasted.
 * `fix` means the build will complete and route to an operator for correction,
 * which costs console time but not another appointment; some of those are worth
 * fixing on the spot in ninety seconds and some are not, so the findings carry
 * the room name and the action rather than a severity alone.
 *
 * WHY A DEGRADED ANALYSIS CANNOT SAY 'go'. The blur rule is a comparison
 * against a rolling median. A median over a third of the candidates is a
 * different statistic from the one `mark_blur` will compute, so a green light
 * built on it is a guess wearing the clothes of a measurement. When the device
 * could not keep up, the report still shows every figure it did measure — that
 * is the point, the operator can see what is known — but the verdict is capped
 * at `fix` and the shortfall appears as its own finding with the fraction in
 * it. A confidence figure the operator can see is the difference between
 * guidance and a lie.
 */

import type { CoverageSnapshot, PlannedRoom, Verdict, VerdictFinding, VerdictReport } from './types.js';
import type { SurfaceLedger } from './reflective.js';
import { roomCompleteness } from './coverage.js';
import { predictSelectedFrames } from './overlap.js';
import {
  ABSOLUTE_MIN_FRAMES, BLUR_FRACTION_WARN, CANDIDATE_FPS, MAX_DURATION_S, MIN_DURATION_S,
  MIN_FRAMES, MIN_SHORT_EDGE, MIN_SOURCE_FPS, MIN_TRANSLATION_SHARE,
  QUALITY_BLUR_REJECTION_RATE, QUALITY_NAVIGATION_CONTINUITY, QUALITY_ROOM_COMPLETENESS,
  VERDICT_MIN_ANALYSED_FRACTION,
} from './thresholds.js';

/**
 * How much of the capture the app actually judged.
 *
 * `expectedCandidates` is duration * CANDIDATE_FPS — the frames the PIPELINE
 * will decode, not the frames the app tried to analyse. Measuring the shortfall
 * against the pipeline's candidate count rather than the app's own target is
 * the only version that means anything: the question is "what fraction of what
 * the pipeline will look at did we look at", and an app that lowered its own
 * target and then met it has answered a different question.
 */
export interface AnalysisConfidence {
  readonly analysedFrames: number;
  readonly expectedCandidates: number;
  /** analysedFrames / expectedCandidates, clamped to 1. */
  readonly fraction: number;
  /** True when the pace controller could not hold ANALYSIS_HZ_FLOOR. */
  readonly couldNotKeepUp: boolean;
}

export function analysisConfidence(
  analysedFrames: number, durationS: number, couldNotKeepUp: boolean,
): AnalysisConfidence {
  const expected = Math.max(0, durationS) * CANDIDATE_FPS;
  const fraction = expected > 0 ? Math.min(1, Math.max(0, analysedFrames) / expected) : 0;
  return { analysedFrames, expectedCandidates: expected, fraction, couldNotKeepUp };
}

export interface VerdictInput {
  readonly durationS: number;
  /** Width and height of the RECORDING, after rotation, not of the analysis image. */
  readonly width: number;
  readonly height: number;
  /** Recording frame rate. */
  readonly fps: number;
  readonly coverage: CoverageSnapshot;
  readonly rooms: readonly PlannedRoom[];
  readonly analysis: AnalysisConfidence;
  readonly surfaces: SurfaceLedger;
  /**
   * The exact keeper count from the live `OverlapTracker`, when one was run.
   *
   * Preferred over `predictSelectedFrames` because the tracker walked the real
   * sequence and the prediction is a closed form over the total that assumes
   * travel was evenly spread. Where they differ, the tracker is right and lower.
   */
  readonly keptFrames: number | null;
}

/**
 * Checks in quality.py that need the reconstruction, with the reason.
 *
 * Exported as data so the verdict screen can list them under a heading like
 * "not checked here, and why" rather than the app pretending twelve checks are
 * four. Eight of quality.py's twelve are in this list; the honest summary is
 * that the phone predicts the CAPTURE-side checks well and the reconstruction-
 * side checks not at all.
 */
export const NOT_ASSESSABLE_ON_DEVICE: readonly { readonly check: string; readonly why: string }[] = [
  { check: 'redaction_completeness', why: 'faces and documents are detected and blurred after upload.' },
  { check: 'scale_agreement', why: 'metric scale comes from two depth models that run on a GPU.' },
  { check: 'pose_consistency', why: 'needs bundle adjustment over the whole capture.' },
  { check: 'geometry_consistency', why: 'needs the sparse reconstruction to measure reprojection error against.' },
  { check: 'identity_stability', why: 'needs entities lifted into 3D and tracked across frames.' },
  { check: 'floater_rate', why: 'needs the trained splat and the building envelope.' },
  { check: 'unobserved_fraction', why: 'needs the reconstructed interior volume to measure against.' },
  { check: 'depth_confidence', why: 'needs the depth model, which does not run on a phone.' },
  { check: 'semantic_confidence', why: 'needs the semantic pass over the reconstructed world.' },
];

function finding(
  check: string, severity: VerdictFinding['severity'], measured: number, threshold: number,
  higherIsBetter: boolean, action: string,
): VerdictFinding {
  return { check, severity, measured, threshold, higherIsBetter, action };
}

/**
 * Predicted frame count, preferring the measured walk over the model.
 *
 * `acceptedCandidates` converts the app's own accept rate onto the pipeline's
 * candidate timeline: the pipeline decodes at CANDIDATE_FPS regardless of how
 * fast this app managed to run, so the count is duration * CANDIDATE_FPS scaled
 * by the fraction that survived. Using the app's own analysed-frame count here
 * would make a slow phone predict a smaller capture, which is the device
 * reporting on itself rather than on the property.
 */
export function predictedFrames(input: VerdictInput): number {
  if (input.keptFrames !== null && Number.isFinite(input.keptFrames)) {
    return Math.max(0, Math.floor(input.keptFrames));
  }
  const c = input.coverage;
  const acceptedFraction = c.totalCandidates > 0
    ? (c.totalCandidates - c.totalRejected) / c.totalCandidates
    : 0;
  const acceptedCandidates = Math.max(0, input.durationS) * CANDIDATE_FPS * acceptedFraction;
  return predictSelectedFrames(c.totalWidths, acceptedCandidates);
}

export function buildVerdict(input: VerdictInput): VerdictReport {
  const c = input.coverage;
  const findings: VerdictFinding[] = [];
  const frames = predictedFrames(input);
  const shortEdge = Math.min(input.width, input.height);
  const roomById = new Map(input.rooms.map((r) => [r.id, r]));
  const nameOf = (id: string): string => roomById.get(id)?.name ?? id;

  // --- ingest.py: the refusals that happen in the first ten seconds ---------
  // These are StageError, not warnings. A capture that trips one produces no
  // world at all, so they are blocking and they come first.
  if (input.durationS < MIN_DURATION_S) {
    findings.push(finding(
      'ingest.MIN_DURATION_S', 'blocking', input.durationS, MIN_DURATION_S, true,
      `The capture is ${Math.round(input.durationS)} seconds. Under ${MIN_DURATION_S} the `
      + 'pipeline refuses it outright. Keep filming before you leave.',
    ));
  }
  if (shortEdge > 0 && shortEdge < MIN_SHORT_EDGE) {
    findings.push(finding(
      'ingest.MIN_SHORT_EDGE', 'blocking', shortEdge, MIN_SHORT_EDGE, true,
      `Recorded at ${input.width} by ${input.height}. The pipeline refuses anything under `
      + `${MIN_SHORT_EDGE} on the short edge. Change the camera setting and film it again `
      + 'before you leave.',
    ));
  }
  // Warnings in ingest.py, so notes here. They do not stop a build.
  if (input.durationS > MAX_DURATION_S) {
    findings.push(finding(
      'ingest.MAX_DURATION_S', 'note', input.durationS, MAX_DURATION_S, false,
      `${(input.durationS / 60).toFixed(1)} minutes is over the `
      + `${(MAX_DURATION_S / 60).toFixed(0)} minute budget. It will still build, but frame `
      + 'subsampling and cost are both worse than the estimate.',
    ));
  }
  if (input.fps > 0 && input.fps < MIN_SOURCE_FPS) {
    findings.push(finding(
      'ingest.MIN_FPS', 'note', input.fps, MIN_SOURCE_FPS, true,
      `Recorded at ${input.fps.toFixed(0)} fps. Below ${MIN_SOURCE_FPS} there are few enough `
      + 'candidates that blur rejection has little to choose between.',
    ));
  }

  // --- frames.py: the frame budget -----------------------------------------
  if (frames < ABSOLUTE_MIN_FRAMES) {
    findings.push(finding(
      'frames.ABSOLUTE_MIN_FRAMES', 'blocking', frames, ABSOLUTE_MIN_FRAMES, true,
      `About ${frames} frames will survive selection. Below ${ABSOLUTE_MIN_FRAMES} the frames `
      + 'stage raises and nothing is built. Walk the property again, more slowly.',
    ));
  } else if (frames < MIN_FRAMES) {
    findings.push(finding(
      'frames.MIN_FRAMES', 'review', frames, MIN_FRAMES, true,
      `About ${frames} frames will survive selection, against a target of ${MIN_FRAMES}. `
      + 'Expect thinner coverage and wider unobserved regions. More walking fixes it.',
    ));
  }

  // --- blur, which is both a frames.py warning and a quality.py check -------
  if (c.blurRejectionRate > QUALITY_BLUR_REJECTION_RATE) {
    findings.push(finding(
      'quality.blur_rejection_rate', 'review', c.blurRejectionRate, QUALITY_BLUR_REJECTION_RATE,
      false,
      `${Math.round(c.blurRejectionRate * 100)}% of frames were too blurred to use, against a `
      + `limit of ${Math.round(QUALITY_BLUR_REJECTION_RATE * 100)}%. This one is technique: `
      + 'walk at half pace and stop turning while you walk.',
    ));
  } else if (c.blurRejectionRate > BLUR_FRACTION_WARN) {
    findings.push(finding(
      'frames.blur_fraction_warning', 'note', c.blurRejectionRate, BLUR_FRACTION_WARN, false,
      `${Math.round(c.blurRejectionRate * 100)}% of frames were rejected as blurred. It will `
      + 'build, but the report will say capture technique was the limiting factor.',
    ));
  }

  // Motion rejection is reported on its own, against the same rate, because it
  // takes a different correction. There is no quality.py check for it — a frame
  // `mark_motion` drops simply never reaches the count — so its only effect is
  // on the frame budget above, and the only place it can be explained to the
  // person who caused it is here.
  if (c.motionRejectionRate > BLUR_FRACTION_WARN) {
    findings.push(finding(
      'frames.motion_rejection', 'note', c.motionRejectionRate, BLUR_FRACTION_WARN, false,
      `${Math.round(c.motionRejectionRate * 100)}% of frames were dropped for moving too fast `
      + 'or too unevenly, which is feet and wrists rather than focus. They come off the frame '
      + 'budget the same way blurred ones do.',
    ));
  }

  // --- quality.py: room completeness and navigation continuity -------------
  //
  // A room the operator declared and never entered is the one failure that is
  // certainly a second visit, so it is blocking rather than review: the
  // pipeline cannot invent a room, and the console cannot correct one into
  // existence. It maps to navigation_continuity, which quality.py holds at
  // exactly 1.0 — every room reachable from the entrance.
  const untouched = c.rooms.filter((r) => r.state === 'not_started');
  if (untouched.length > 0) {
    const names = untouched.map((r) => nameOf(r.roomId)).join(', ');
    findings.push(finding(
      'quality.navigation_continuity', 'blocking',
      (c.rooms.length - untouched.length) / Math.max(1, c.rooms.length),
      QUALITY_NAVIGATION_CONTINUITY, true,
      `Never filmed: ${names}. A room with no frames in it is a room the tour cannot walk `
      + 'into, and nothing downstream can add it. Film it before you leave.',
    ));
  }

  const completeness = roomCompleteness(c);
  if (untouched.length === 0 && completeness < QUALITY_ROOM_COMPLETENESS) {
    const thin = c.rooms.filter((r) => r.state === 'thin');
    const worst = thin.slice().sort((a, b) => a.widths - b.widths)[0];
    findings.push(finding(
      'quality.room_completeness', 'review', completeness, QUALITY_ROOM_COMPLETENESS, true,
      worst
        ? `${Math.round(completeness * 100)}% of rooms are fully covered against a target of `
          + `${Math.round(QUALITY_ROOM_COMPLETENESS * 100)}%. Worst is ${nameOf(worst.roomId)}: `
          + `${worst.gaps[0] ?? 'thin coverage'}`
        : `${Math.round(completeness * 100)}% of rooms are fully covered against a target of `
          + `${Math.round(QUALITY_ROOM_COMPLETENESS * 100)}%.`,
    ));
  }

  // --- CAPTURE-specific: the failure frames.py cannot see ------------------
  //
  // `select_by_overlap` measures flow and cannot tell a walk from a spin, so a
  // property shot as a panorama from the middle of each room sails through
  // frame selection and then comes apart in pose: every frame shares an optical
  // centre, nothing triangulates, and pose_consistency reports a disconnected
  // component. The gyro separates rotation from translation live, which is the
  // one thing this app knows that the pipeline does not.
  if (c.totalTranslationWidths !== null && c.totalWidths > 1) {
    const share = c.totalTranslationWidths / c.totalWidths;
    if (share < MIN_TRANSLATION_SHARE) {
      const spun = c.rooms.filter(
        (r) => r.translationWidths !== null && r.widths > 1
          && r.translationWidths / r.widths < MIN_TRANSLATION_SHARE,
      );
      findings.push(finding(
        'capture.translation_share', 'review', share, MIN_TRANSLATION_SHARE, true,
        `Only ${Math.round(share * 100)}% of the movement was walking; the rest was turning `
        + 'on the spot. Turning gives the frames nothing to measure depth from.'
        + (spun.length > 0 ? ` Worst: ${spun.map((r) => nameOf(r.roomId)).join(', ')}.` : ''),
      ));
    }
  }

  if (!c.entranceRevisited && c.rooms.length >= 3) {
    findings.push(finding(
      'capture.loop_closure', 'note', 0, 1, true,
      'The walk did not end where it started. Standing at the front door again for a few '
      + 'seconds gives the reconstruction a loop to close, which is what stops the last room '
      + 'drifting away from the first.',
    ));
  }

  // --- The verdict's own confidence ----------------------------------------
  //
  // Last in the list and first in consequence: this is the finding that says
  // the other findings are thinner than they look.
  const degraded = input.analysis.couldNotKeepUp
    || input.analysis.fraction < VERDICT_MIN_ANALYSED_FRACTION;
  if (degraded) {
    findings.push(finding(
      'capture.analysis_coverage', 'review', input.analysis.fraction,
      VERDICT_MIN_ANALYSED_FRACTION, true,
      `This phone checked ${Math.round(input.analysis.fraction * 100)}% of the frames the `
      + 'pipeline will look at. Everything above was measured from those; the blur figure in '
      + 'particular is a median over a sample, not over the capture. Treat it as indicative.',
    ));
  }

  const blocking = findings.filter((f) => f.severity === 'blocking');
  const review = findings.filter((f) => f.severity === 'review');
  let verdict: Verdict;
  if (blocking.length > 0) verdict = 'no_go';
  else if (review.length > 0) verdict = 'fix';
  else verdict = 'go';

  // There is no fourth branch for "nothing found, but the analysis was
  // partial": `degraded` always contributes a review finding, so that state
  // cannot occur. Writing the branch anyway would be a line of reassurance
  // that no input can reach, and a reader would reasonably assume it can.
  const headline = blocking.length > 0
    ? `Do not leave yet — ${blocking.length} thing${blocking.length === 1 ? '' : 's'} `
      + 'will stop this building at all.'
    : review.length > 0
      ? `This will build, but ${review.length} thing${review.length === 1 ? '' : 's'} `
        + 'will send it to an operator for correction.'
      : 'Nothing found against the checks this phone can make.';

  return {
    verdict,
    headline,
    findings,
    notAssessed: NOT_ASSESSABLE_ON_DEVICE.map((n) => `${n.check}: ${n.why}`),
    predictedFrames: frames,
    blurRejectionRate: c.blurRejectionRate,
    durationS: input.durationS,
  };
}

/**
 * One line per figure, for the screen and for the handover note that travels
 * with the upload.
 *
 * Plain numbers with their units and no decoration. The operator is comparing
 * these against a threshold in the next line, not admiring them.
 */
export function verdictFigures(input: VerdictInput, report: VerdictReport): readonly string[] {
  const c = input.coverage;
  const lines = [
    `Duration: ${input.durationS.toFixed(0)} s`,
    `Recorded: ${input.width} x ${input.height} at ${input.fps.toFixed(0)} fps`,
    `Travel: ${c.totalWidths.toFixed(1)} image widths`,
    `Frames predicted to survive selection: ${report.predictedFrames} `
      + `(target ${MIN_FRAMES}, floor ${ABSOLUTE_MIN_FRAMES})`,
    `Frames rejected as blurred: ${Math.round(c.blurRejectionRate * 100)}% `
      + `(limit ${Math.round(QUALITY_BLUR_REJECTION_RATE * 100)}%)`,
    `Rooms fully covered: ${c.rooms.filter((r) => r.state === 'done').length} of ${c.rooms.length}`,
    `Doorways crossed: ${c.doorwaysCrossed}`,
    `Frames checked on this phone: ${Math.round(input.analysis.fraction * 100)}% of the `
      + `${Math.round(input.analysis.expectedCandidates)} the pipeline will decode`,
  ];
  if (c.totalTranslationWidths !== null && c.totalWidths > 0) {
    lines.push(`Movement that was walking rather than turning: `
      + `${Math.round((c.totalTranslationWidths / c.totalWidths) * 100)}% `
      + `(minimum ${Math.round(MIN_TRANSLATION_SHARE * 100)}%)`);
  } else {
    lines.push('Movement that was walking rather than turning: not measured — this device '
      + 'reported no orientation, so turning and walking cannot be separated.');
  }
  if (input.surfaces.roomsWithMirrors.length > 0) {
    lines.push(`Mirrors declared by the operator in: `
      + `${input.surfaces.roomsWithMirrors.length} room(s)`);
  }
  return lines;
}
