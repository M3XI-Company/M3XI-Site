/**
 * The banner an operator reads while walking.
 *
 * Two constraints fight here and the resolution matters more than any single
 * threshold in this package.
 *
 * Guidance has to be immediate, because a warning about a doorway you have
 * already walked through is not guidance, it is a complaint. And it has to be
 * quiet, because phone-video capture at five to ten minutes a property is the
 * entire economic argument for this product — it is what collapses the
 * 150-to-400-pound-per-property labour cost that tripod-based capture carries.
 * A system that stops someone every eight seconds has rebuilt the tripod out
 * of interruptions.
 *
 * So: exactly one cue on screen at a time, chosen by priority; a cue must be
 * true for three consecutive frames before it appears and false for eight
 * before it goes; and once shown it stays for at least CUE_MIN_VISIBLE_MS so a
 * glance catches it. A headline of two or three words, and one sentence
 * underneath for when they stop walking. Never a paragraph.
 *
 * The priority order is not arbitrary. Blur is first because five to ten
 * blurred frames among three hundred measurably degrade the whole
 * reconstruction, so it is the one failure whose cost is out of all proportion
 * to how it looks on screen. Coverage is last because it is the only one that
 * can be fixed after the fact by walking back.
 */

import type { BlurVerdict, Cue, CueId, CueLevel, FrameAnalysis } from './types.js';
import type { MotionAssessment } from './motion.js';
import type { OverlapState } from './overlap.js';
import type { DiscontinuityFinding, GlazingFinding } from './reflective.js';
import {
  BLOWN_FRACTION_ACT, BLOWN_FRACTION_WARN, CRUSHED_FRACTION_ACT, CUE_CLEAR_FRAMES,
  CUE_MIN_VISIBLE_MS, CUE_RAISE_FRAMES, MOTION_CUE_RAISE, OVERLAP_FRACTURE_ABOVE,
  TILE_DYNAMIC_RANGE_ACT,
} from './thresholds.js';

export interface GuidanceInput {
  readonly analysis: FrameAnalysis;
  readonly blur: BlurVerdict;
  readonly motion: MotionAssessment;
  /**
   * The overlap tracker's current state.
   *
   * Passed whole rather than as a loose "gap in widths" number, because the
   * question the cue asks is `gapOpen` — has the accumulation since the last
   * KEPT frame passed the fracture bound — and a caller handing in a
   * displacement measured from some other reference would produce a cue that
   * fires on a correctly paced walk. The tracker is the only thing that knows
   * where the last keeper was.
   */
  readonly overlap: OverlapState;
  /** Radians per second, or null when the device gives no orientation. */
  readonly yawRateRadS: number | null;
  /** The rate above which turning alone costs frames, for this lens. */
  readonly maxYawRateRadS: number;
  /** Tiles bright enough that the pipeline would call them glazing. */
  readonly glazing: readonly GlazingFinding[];
  /**
   * Tiles moving differently from the rest of the frame, having persisted.
   *
   * Explicitly ambiguous — a mirror, a doorway or a near object — so the cue
   * built on them asks a question rather than announcing a detection.
   */
  readonly discontinuities: readonly DiscontinuityFinding[];
  /** One short phrase naming what to cover next, or null. */
  readonly coverageHint: string | null;
  /** True when the analyser cannot hold CANDIDATE_FPS. */
  readonly degraded: boolean;
  /**
   * Fraction of the pipeline's candidates this app has actually judged, 0-1.
   *
   * Required, not optional, and it appears in the wording of both the degraded
   * cue and the steady one. A green "Good" computed from a third of the frames
   * is the single most damaging thing this package could put on a screen,
   * because it is indistinguishable from a green "Good" computed from all of
   * them. Making the caller supply the figure means it cannot be forgotten.
   */
  readonly analysedFraction: number;
  readonly nowMs: number;
}

export interface GuidanceOutput {
  /** The one cue to show. Never null: 'steady' is a real state worth showing. */
  readonly primary: Cue;
  /** Everything currently true, for the post-capture summary. */
  readonly active: readonly Cue[];
  /** True when the analyser is not keeping up and the app must say so. */
  readonly degraded: boolean;
}

interface Candidate {
  readonly id: CueId;
  readonly level: CueLevel;
  readonly headline: string;
  readonly detail: string;
  readonly raiseAfter: number;
}

/** Lower number wins. */
const PRIORITY: Record<CueId, number> = {
  blur: 0,
  too_fast: 1,
  turning_fast: 2,
  overlap_gap: 3,
  blown: 4,
  glare: 5,
  // Above the lighting advisories and below the glazing one. A mirror left in
  // shot invents a room that does not exist, which is a worse outcome than an
  // uneven exposure — but the phone cannot confirm a mirror, so the cue asks
  // the operator to look, and a question that fires too often is ignored.
  reflection: 6,
  too_dark: 7,
  uneven_light: 8,
  coverage: 9,
  degraded: 10,
  steady: 11,
};

interface TrackState {
  trueFor: number;
  falseFor: number;
  shownAt: number | null;
  since: number;
}

/**
 * The degraded headline, as a ratio rather than a percentage.
 *
 * "1 frame in 3" is four short words and a person walking reads it without
 * stopping. "Checking 33% of frames" is the same fact and takes a beat longer
 * to turn into an intuition, and the whole point of a headline here is that it
 * survives a glance. The detail line carries the percentage for anyone who
 * stops to read it.
 */
function oneFrameIn(fraction: number): string {
  if (!(fraction > 0)) return 'Not checking frames';
  const n = Math.round(1 / Math.min(1, fraction));
  return n <= 1 ? 'Guidance slowed' : `1 frame in ${n}`;
}

export class GuidanceEngine {
  private readonly tracks = new Map<CueId, TrackState>();
  private lastPrimary: Cue | null = null;

  step(input: GuidanceInput): GuidanceOutput {
    const candidates = this.candidates(input);
    const byId = new Map(candidates.map((c) => [c.id, c]));

    const active: Cue[] = [];
    for (const id of Object.keys(PRIORITY) as CueId[]) {
      if (id === 'steady') continue;
      const track = this.tracks.get(id) ?? { trueFor: 0, falseFor: 0, shownAt: null, since: 0 };
      const candidate = byId.get(id);
      if (candidate) {
        track.trueFor += 1;
        track.falseFor = 0;
        if (track.shownAt === null && track.trueFor >= candidate.raiseAfter) {
          track.shownAt = input.nowMs;
          track.since = input.nowMs;
        }
      } else {
        track.falseFor += 1;
        track.trueFor = 0;
        const heldLongEnough = track.shownAt !== null
          && input.nowMs - track.shownAt >= CUE_MIN_VISIBLE_MS;
        if (track.shownAt !== null && track.falseFor >= CUE_CLEAR_FRAMES && heldLongEnough) {
          track.shownAt = null;
        }
      }
      this.tracks.set(id, track);
      if (track.shownAt !== null) {
        // While a cue is held past its trigger the wording must not go stale,
        // so the live text is used when the condition is still true and the
        // last known text when it is being held open.
        const source = candidate ?? this.lastText(id);
        if (source) {
          active.push({
            id, level: source.level, headline: source.headline,
            detail: source.detail, since: track.since,
          });
        }
      }
      if (candidate) this.remember(id, candidate);
    }

    active.sort((a, b) => PRIORITY[a.id] - PRIORITY[b.id]);
    const primary: Cue = active[0] ?? {
      id: 'steady', level: 'ok', headline: 'Good',
      // The fallback state still carries its own provenance. When the analyser
      // is behind, "Good" without the qualifier is the green banner computed
      // from a third of the frames that this package exists to prevent, and the
      // degraded cue cannot be relied on to cover it — it can be suppressed by
      // hysteresis in the frames right after the rate drops.
      detail: input.analysedFraction >= 0.999
        ? (input.coverageHint ?? 'Keep the same pace.')
        : `${input.coverageHint ?? 'Keep the same pace.'} Checked on `
          + `${Math.round(input.analysedFraction * 100)}% of frames.`,
      since: input.nowMs,
    };
    this.lastPrimary = primary;
    return { primary, active, degraded: input.degraded };
  }

  /** The most recent cue shown, for a screen that re-renders without a frame. */
  get current(): Cue | null { return this.lastPrimary; }

  private readonly texts = new Map<CueId, Candidate>();
  private remember(id: CueId, c: Candidate): void { this.texts.set(id, c); }
  private lastText(id: CueId): Candidate | null { return this.texts.get(id) ?? null; }

  private candidates(input: GuidanceInput): Candidate[] {
    const out: Candidate[] = [];
    const { analysis, blur, motion } = input;

    if (blur.rejected) {
      out.push({
        id: 'blur', level: 'act', headline: 'Too blurred', raiseAfter: CUE_RAISE_FRAMES,
        detail: 'These frames will be thrown away. Slow down and hold the phone steadier.',
      });
    }

    // Turning fast and moving fast reach the same rejection by different routes
    // and take different corrections, so the rotation case is tested first and
    // suppresses the generic one. Telling someone standing still to "slow down"
    // while they pan is how an operator learns the banner is noise.
    const turningTooFast = input.yawRateRadS !== null
      && input.maxYawRateRadS > 0
      && Math.abs(input.yawRateRadS) > input.maxYawRateRadS;

    if (turningTooFast) {
      const secondsPerTurn = (Math.PI * 2) / input.maxYawRateRadS;
      out.push({
        id: 'turning_fast', level: 'act', headline: 'Turn slower', raiseAfter: CUE_RAISE_FRAMES,
        detail: `Take at least ${secondsPerTurn.toFixed(0)} seconds for a full turn, or the `
          + 'frames will not overlap.',
      });
    }

    if (motion.band === 'incoherent') {
      out.push({
        id: 'too_fast', level: 'act', headline: 'Hold steadier', raiseAfter: MOTION_CUE_RAISE,
        detail: 'The image is moving in different directions at once — usually a shake or a '
          + 'sharp wrist turn.',
      });
    } else if (motion.band === 'rejected' && !turningTooFast) {
      out.push({
        id: 'too_fast', level: 'act', headline: 'Slow down', raiseAfter: CUE_RAISE_FRAMES,
        detail: 'You are moving faster than the frames can follow, so they are being dropped.',
      });
    } else if (motion.band === 'fast' && !turningTooFast) {
      out.push({
        id: 'too_fast', level: 'advise', headline: 'Ease off', raiseAfter: CUE_RAISE_FRAMES,
        detail: 'Close to the speed at which frames start to be dropped.',
      });
    }

    // A gap is different from moving fast: it means every candidate since the
    // last kept frame was thrown away while the camera kept going, so there is
    // a hole in the chain that nothing downstream can bridge. Walking slower
    // from here does not close it; walking back does.
    if (input.overlap.gapOpen) {
      out.push({
        id: 'overlap_gap', level: 'act', headline: 'Go back', raiseAfter: CUE_RAISE_FRAMES,
        detail: `Nothing usable was kept for the last ${input.overlap.pendingWidths.toFixed(1)} `
          + `sweeps of the view, past the ${OVERLAP_FRACTURE_ABOVE.toFixed(2)} at which the `
          + 'frames stop joining up. Re-cover what you just passed.',
      });
    }

    const { exposure } = analysis;
    if (exposure.blownFraction >= BLOWN_FRACTION_ACT) {
      out.push({
        id: 'blown', level: 'act', headline: 'Blown out', raiseAfter: CUE_RAISE_FRAMES,
        detail: 'A quarter of the frame has no detail left. Turn away from the light source.',
      });
    } else if (exposure.blownFraction >= BLOWN_FRACTION_WARN) {
      out.push({
        id: 'blown', level: 'advise', headline: 'Bright window', raiseAfter: CUE_RAISE_FRAMES,
        detail: 'Angle away from the glass so the room keeps its detail.',
      });
    }

    // Glazing findings arrive sorted worst-first from `glazingFindings`.
    const worstGlazing = input.glazing[0];
    if (worstGlazing) {
      out.push({
        id: 'glare',
        level: worstGlazing.decidedBySaturationAlone ? 'act' : 'advise',
        headline: worstGlazing.decidedBySaturationAlone ? 'Window blown out' : 'Bright glass',
        raiseAfter: CUE_RAISE_FRAMES,
        detail: `${worstGlazing.where}, ${Math.round(worstGlazing.saturation * 100)}% of it with `
          + 'no detail left. A few steps sideways usually clears it; depth behind glass is '
          + 'guesswork and the splat grows floaters there.',
      });
    }

    // Deliberately a question. The phone has none of the three signals
    // `reflective_score` is made of, so this cue reports a depth discontinuity
    // — which a mirror is, and so is a doorway — and asks the one entity in the
    // building that can tell them apart.
    const worstDiscontinuity = input.discontinuities[0];
    if (worstDiscontinuity) {
      out.push({
        id: 'reflection', level: 'advise', headline: 'Mirror there?',
        raiseAfter: CUE_RAISE_FRAMES,
        detail: `Something ${worstDiscontinuity.where} is moving differently from the rest of `
          + 'the view. That is a mirror, a doorway or something close to you — this phone '
          + 'cannot tell which. If it is a mirror, mark it: a mirror left unmarked invents a '
          + 'room that is not there.',
      });
    }

    if (exposure.crushedFraction >= CRUSHED_FRACTION_ACT) {
      out.push({
        id: 'too_dark', level: 'advise', headline: 'Too dark', raiseAfter: CUE_RAISE_FRAMES,
        detail: 'Put the lights on. A third of this frame has no detail to reconstruct from.',
      });
    }

    if (exposure.tileDynamicRange >= TILE_DYNAMIC_RANGE_ACT
      && exposure.blownFraction < BLOWN_FRACTION_ACT) {
      out.push({
        id: 'uneven_light', level: 'advise', headline: 'Uneven light', raiseAfter: CUE_RAISE_FRAMES,
        detail: 'Over two stops across one frame. Turn the room lights on or change your angle.',
      });
    }

    if (input.degraded) {
      const pct = Math.round(Math.max(0, Math.min(1, input.analysedFraction)) * 100);
      out.push({
        id: 'degraded', level: 'advise', headline: oneFrameIn(input.analysedFraction),
        raiseAfter: CUE_RAISE_FRAMES,
        detail: `This phone is keeping up with ${pct}% of the frames the pipeline will look at, `
          + 'so anything green below is measured from a sample. Walk more slowly than usual.',
      });
    }

    if (input.coverageHint) {
      out.push({
        id: 'coverage', level: 'advise', headline: input.coverageHint, raiseAfter: CUE_RAISE_FRAMES,
        detail: 'Still to cover before you leave.',
      });
    }

    return out;
  }
}
