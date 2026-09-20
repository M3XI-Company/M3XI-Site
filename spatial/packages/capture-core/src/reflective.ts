/**
 * Mirrors and glazing, live — and an honest account of how little of that a
 * browser can actually do.
 *
 * These are the two named reconstruction failure modes. `reflective.py` opens
 * with why: a mirror is not a hard surface to a reconstruction, it is a window
 * onto a room that does not exist, and COLMAP will triangulate the reflection
 * into a phantom bedroom nobody can find. Glazing fails the other way — the
 * exterior clips, depth becomes unconstrained, and the splat grows a cloud of
 * floaters outside every window. Both are cheap to avoid at the property and
 * impossible to fix afterwards, which is why warning about them live is worth
 * more than any other guidance in this package.
 *
 * WHAT THE PIPELINE USES, AND WHAT OF IT REACHES THE PHONE
 *
 *   signal                     weight   available in a browser?
 *   open-vocabulary detection   0.25     no. No model, no budget for one.
 *   depth behind the plane      0.45     no. No depth of any kind — no ARKit,
 *                                        no ARCore, no depth API, and nothing
 *                                        to fit a wall plane to.
 *   view dependence             0.20     no. It is the photometric residual of
 *                                        multi-view reprojection and needs the
 *                                        splat to have trained.
 *   saturation                  0.10     YES, in full, and it is also the only
 *                                        one the operator can act on.
 *
 * So the phone can compute the glazing evidence almost completely — `glazed_score`
 * weights saturation at 0.50 — and it can compute NONE of the mirror evidence.
 *
 * WHAT THIS MODULE THEREFORE DOES NOT DO. It does not produce a mirror score.
 * Inventing one from the signals that happen to be available would give the
 * operator a number that looks like `reflective_score`, agrees with it by luck,
 * and is trusted because it is on the same screen as numbers that are real.
 * That is the failure this whole product is built against: a confident figure
 * with nothing behind it.
 *
 * WHAT IT DOES INSTEAD, in three parts.
 *
 *   1. Glazing evidence, computed as `reflective.py` computes its saturation
 *      term, reported as that term and named as partial.
 *
 *   2. Depth discontinuities: tiles whose displacement disagrees with the rest
 *      of a coherent frame. A mirror shows up here, because the virtual scene
 *      behind the glass is at a different depth from the wall the glass is on
 *      and so moves with different parallax. So does a doorway into the next
 *      room, and so does a near foreground object. The phone cannot tell those
 *      apart and this module says so in the finding itself rather than in a
 *      footnote — the finding's own `ambiguity` field carries the alternatives.
 *
 *   3. An operator declaration. The person is standing in the room looking at
 *      the thing. "Is there a mirror here" is a question a human answers better
 *      than any of the four signals, and it costs one tap. It is recorded as
 *      what it is: an assertion by a named person at a known time, never an
 *      observation, because no camera saw a mirror — a camera saw a room.
 */

import type { TileDisplacement } from './motion.js';
import type { GlareRegion } from './types.js';
import { describeTile } from './exposure.js';
import { median } from './image.js';
import {
  GLAZED_SATURATION_WEIGHT, GLAZED_THRESHOLD, REFLECTIVE_THRESHOLD,
  REGION_SATURATION_CERTAIN, REGION_SATURATION_REPORT, TILE_AGREEMENT_FRAC, TILE_GRID,
} from './thresholds.js';

// ---------------------------------------------------------------------------
// What the phone cannot measure, stated so a screen can render it
// ---------------------------------------------------------------------------

export interface UnavailableSignal {
  /** The term in `reflective.py`'s score this stands for. */
  readonly signal: string;
  /** Its weight in `reflective_score`, so the shortfall is quantified. */
  readonly weight: number;
  /** Why a browser cannot compute it. One sentence, for an operator. */
  readonly because: string;
}

/**
 * The mirror evidence a phone browser does not have.
 *
 * Exported as data and not prose so the capture app can render it beside the
 * things it DID measure. An operator who is shown "mirror detection: not
 * available on this device" has been told something true and useful. An
 * operator shown nothing concludes the app looked and found no mirrors.
 *
 * The weights sum to 0.90 of `reflective_score` — everything except the
 * saturation term, which does not enter `reflective_score` at all. That is the
 * honest headline: on mirrors specifically, this device measures nothing.
 */
export const MIRROR_SIGNALS_UNAVAILABLE: readonly UnavailableSignal[] = [
  {
    signal: 'mirror detection',
    weight: 0.25,
    because: 'recognising a mirror needs an open-vocabulary detector, which is not on this device.',
  },
  {
    signal: 'depth behind the wall plane',
    weight: 0.45,
    because: 'the strongest signal, and it needs depth. A phone browser has no depth camera and '
      + 'no ARKit or ARCore to ask.',
  },
  {
    signal: 'view dependence across frames',
    weight: 0.20,
    because: 'it is measured against the trained reconstruction, which does not exist until the '
      + 'capture has been processed.',
  },
];

/** Total weight of `reflective_score` this device cannot compute: 0.90. */
export const MIRROR_EVIDENCE_UNAVAILABLE_WEIGHT = MIRROR_SIGNALS_UNAVAILABLE
  .reduce((sum, s) => sum + s.weight, 0);

/**
 * One sentence for the screen, naming the gap rather than hiding it.
 *
 * REFLECTIVE_THRESHOLD is quoted because a bare "cannot detect mirrors" invites
 * the reading "there probably are not any". Putting the threshold and the
 * missing weight together says the precise thing: the pipeline needs 0.50 of
 * evidence and this device can contribute none of it.
 */
export function mirrorCapabilityStatement(): string {
  return 'This phone cannot detect mirrors. The pipeline flags one at '
    + `${REFLECTIVE_THRESHOLD.toFixed(2)} of combined evidence, and all `
    + `${MIRROR_EVIDENCE_UNAVAILABLE_WEIGHT.toFixed(2)} of it needs depth, a detector or the `
    + 'finished reconstruction. Mark mirrors yourself as you pass them.';
}

// ---------------------------------------------------------------------------
// Glazing: the one signal that does reach the phone
// ---------------------------------------------------------------------------

export type GlazingConfidence = 'certain' | 'probable' | 'possible';

export interface GlazingFinding {
  readonly tile: number;
  /** Where it is, in words an operator can act on without looking down. */
  readonly where: string;
  /** Fraction of the tile at or above SATURATION_LEVEL. */
  readonly saturation: number;
  /** `reflective.py`'s saturation term of `glazed_score`, and nothing else. */
  readonly partialGlazedScore: number;
  /** What the pipeline needs, for comparison. Never computed, always quoted. */
  readonly pipelineThreshold: number;
  readonly confidence: GlazingConfidence;
  /** True when saturation alone already carries the pipeline over its flag. */
  readonly decidedBySaturationAlone: boolean;
}

/**
 * Turn measured tile saturation into the pipeline's own partial glazed score.
 *
 * Reporting `0.50 * saturation` rather than a bespoke "glare score" is the
 * whole design. It means the number on the phone and the number in the quality
 * report are the same number: an operator who learns what 0.45 looks like has
 * learnt something that remains true in the office. A private scale would have
 * to be re-learnt and would drift the moment `glazed_score` was reweighted.
 *
 * `certain` is not a hedge. At REGION_SATURATION_CERTAIN the saturation term
 * alone is 0.45, which IS GLAZED_THRESHOLD, so the pipeline will flag the
 * surface whatever its detector says. Below that the window detector the
 * pipeline runs is what decides, and this device does not have it — hence
 * `probable` and `possible` rather than a fabricated probability.
 */
export function glazingFindings(
  glare: readonly GlareRegion[], grid = TILE_GRID,
): GlazingFinding[] {
  const out: GlazingFinding[] = [];
  for (const g of glare) {
    if (g.saturation < REGION_SATURATION_REPORT) continue;
    const partial = GLAZED_SATURATION_WEIGHT * g.saturation;
    const decided = partial >= GLAZED_THRESHOLD;
    out.push({
      tile: g.tile,
      where: describeTile(g.tile, grid),
      saturation: g.saturation,
      partialGlazedScore: partial,
      pipelineThreshold: GLAZED_THRESHOLD,
      confidence: decided
        ? 'certain'
        : g.saturation >= (REGION_SATURATION_CERTAIN + REGION_SATURATION_REPORT) / 2
          ? 'probable'
          : 'possible',
      decidedBySaturationAlone: decided,
    });
  }
  // Worst first: the operator acts on one thing, and it should be the one that
  // will cost the most.
  out.sort((a, b) => b.saturation - a.saturation);
  return out;
}

// ---------------------------------------------------------------------------
// Depth discontinuities: where a mirror would show up, and what else does
// ---------------------------------------------------------------------------

export interface DiscontinuityFinding {
  readonly tile: number;
  readonly where: string;
  /** How far this tile's displacement is from the frame's, in image widths. */
  readonly disagreementWidths: number;
  /**
   * Everything this could be, in the order it usually is. The phone has no
   * signal that separates them, and the field exists so no caller can render
   * the finding as a mirror detection.
   */
  readonly ambiguity: readonly string[];
}

/**
 * Tiles moving differently from the rest of an otherwise coherent frame.
 *
 * The frame must be coherent overall — `frameConsensusOk` — or this means
 * nothing: during a shake every tile disagrees with every other and singling
 * one out is noise. That gate is why this takes the consensus as an argument
 * rather than recomputing it.
 *
 * A confident, persistent, isolated disagreement is a depth discontinuity. A
 * mirror is one, because the virtual scene behind the glass sits at a different
 * distance from the wall the glass is mounted on and so shows different
 * parallax as the camera walks past. A doorway into the next room is also one.
 * A chair in the foreground is also one. There is no fourth signal here to
 * separate them and this function does not pretend there is: it reports the
 * measurement and lists the readings.
 *
 * Low-confidence tiles are excluded rather than counted as disagreeing, for the
 * same reason `lk_flow` returns a neutral inlier ratio on a featureless view: a
 * blank magnolia wall has no opinion about motion, and treating silence as
 * disagreement would fire this in every hallway in the country.
 */
export function discontinuityFindings(
  tiles: readonly TileDisplacement[],
  widthPx: number,
  frameConsensusOk: boolean,
  grid = TILE_GRID,
): DiscontinuityFinding[] {
  if (!frameConsensusOk || widthPx <= 0) return [];
  const usable: Array<{ index: number; t: TileDisplacement }> = [];
  tiles.forEach((t, index) => { if (t.confidence > 0.15) usable.push({ index, t }); });
  // Fewer than three opinions is not a consensus to disagree with. Four tiles
  // is a quarter of the grid and is where a median stops being one tile's view.
  if (usable.length < 4) return [];

  const mx = median(usable.map((u) => u.t.dx));
  const my = median(usable.map((u) => u.t.dy));
  const tol = Math.max(2, TILE_AGREEMENT_FRAC * widthPx);

  const out: DiscontinuityFinding[] = [];
  for (const u of usable) {
    const off = Math.hypot(u.t.dx - mx, u.t.dy - my);
    if (off <= tol) continue;
    out.push({
      tile: u.index,
      where: describeTile(u.index, grid),
      disagreementWidths: off / widthPx,
      ambiguity: [
        'a doorway or opening into another room',
        'something close to the camera in front of a far wall',
        'a mirror or a glazed panel',
      ],
    });
  }
  out.sort((a, b) => b.disagreementWidths - a.disagreementWidths);
  return out;
}

/**
 * Persistence, because one frame is never enough.
 *
 * A single frame's tile disagreement is as likely to be a bad 1-D match as a
 * real discontinuity, and a cue that fires on one frame trains an operator to
 * ignore cues. This counts consecutive frames per tile and only reports a tile
 * that has held, which also happens to be the behaviour that distinguishes a
 * fixed feature of the room from a passing hand.
 *
 * It is a separate object from the per-frame function above so that the
 * measurement stays pure and testable and only the memory is stateful.
 */
export class DiscontinuityWatch {
  private readonly streak = new Map<number, number>();
  private readonly holdFrames: number;

  /** @param holdFrames consecutive frames a tile must disagree for. */
  constructor(holdFrames: number) {
    this.holdFrames = Math.max(1, Math.floor(holdFrames));
  }

  /** @returns the findings that have persisted, worst first. */
  step(findings: readonly DiscontinuityFinding[]): DiscontinuityFinding[] {
    const seen = new Set<number>();
    const held: DiscontinuityFinding[] = [];
    for (const f of findings) {
      seen.add(f.tile);
      const n = (this.streak.get(f.tile) ?? 0) + 1;
      this.streak.set(f.tile, n);
      if (n >= this.holdFrames) held.push(f);
    }
    for (const tile of Array.from(this.streak.keys())) {
      if (!seen.has(tile)) this.streak.delete(tile);
    }
    return held;
  }
}

// ---------------------------------------------------------------------------
// The operator's own answer
// ---------------------------------------------------------------------------

export type DeclaredSurface = 'mirror' | 'glazing' | 'television' | 'polished_floor';

/**
 * A surface the operator says is there.
 *
 * Carries `by` and `at` and calls itself a declaration because of what
 * `review/src/model/provenance.ts` establishes: a human assertion is never
 * `observed` and never `reconstructed`. Nothing in this package writes a
 * WorldDocument, so nothing here can set a provenance — but the shape it hands
 * upward decides what the capture app is ABLE to claim, and a field called
 * `detected` would have invited the pipeline to treat a tap as a measurement.
 *
 * `television` and `polished_floor` are here because operators will report them
 * and they are real: a TV is a mirror while it is off and a light source while
 * it is on, and a gloss floor produces specular view-dependence over a large
 * area. They are worth passing to the pipeline as hints even though this
 * package does nothing with them beyond recording them.
 */
export interface SurfaceDeclaration {
  readonly kind: DeclaredSurface;
  /** The room the operator was in, by the app's own room id. */
  readonly roomId: string;
  /** Milliseconds into the capture, so the frames can be found again. */
  readonly tMs: number;
  /** Operator identifier, as the app knows it. Never invented here. */
  readonly by: string;
  readonly note?: string;
}

export interface SurfaceLedger {
  readonly declarations: readonly SurfaceDeclaration[];
  /** Rooms with at least one declared mirror. */
  readonly roomsWithMirrors: readonly string[];
  /** Rooms with at least one declared glazed surface. */
  readonly roomsWithGlazing: readonly string[];
}

export function summariseDeclarations(
  declarations: readonly SurfaceDeclaration[],
): SurfaceLedger {
  const mirrors = new Set<string>();
  const glazing = new Set<string>();
  for (const d of declarations) {
    // A television counts as a mirror for reconstruction purposes whether or
    // not the operator thought of it that way: a dark screen reflects the room
    // and the depth estimator puts geometry behind it exactly as it does for
    // glass. Folding it in here rather than asking the operator to know that is
    // the difference between a checklist and a quiz.
    if (d.kind === 'mirror' || d.kind === 'television') mirrors.add(d.roomId);
    if (d.kind === 'glazing') glazing.add(d.roomId);
  }
  return {
    declarations,
    roomsWithMirrors: Array.from(mirrors),
    roomsWithGlazing: Array.from(glazing),
  };
}
