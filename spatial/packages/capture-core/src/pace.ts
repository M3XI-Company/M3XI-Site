/**
 * Keeping the analyser honest about what the device can actually do.
 *
 * The guidance in this app is only a faithful preview of the pipeline if the
 * app sees every frame the pipeline will see — that is, if it analyses at or
 * above CANDIDATE_FPS. A phone that cannot sustain that has two options, and
 * only one of them is acceptable.
 *
 * The tempting option is to lower the analysis resolution. It is the wrong
 * one: variance of the Laplacian is resolution-dependent, so scoring at 640px
 * instead of 960px silently changes what BLUR_ABS_FLOOR means and the app
 * starts measuring something that is no longer the pipeline's quantity.
 *
 * So the rate comes down instead, to a floor of CANDIDATE_FPS. Below that the
 * app says the guidance is degraded, in as many words, on the screen. An
 * operator who is told the blur detector is running at half speed can decide
 * to walk slower; an operator shown a green light computed from a third of the
 * frames cannot decide anything.
 */

import { ANALYSIS_BUDGET_MS, ANALYSIS_HZ, ANALYSIS_HZ_FLOOR } from './thresholds.js';

export interface PaceState {
  readonly hz: number;
  readonly medianCostMs: number;
  readonly degraded: boolean;
}

export class PaceController {
  private readonly costs: number[] = [];
  private hz = ANALYSIS_HZ;
  private lastChangeAt = 0;

  /** @returns the interval, in ms, the analyser should target next. */
  intervalMs(): number { return 1000 / this.hz; }

  state(): PaceState {
    return {
      hz: this.hz,
      medianCostMs: this.medianCost(),
      // Degraded means "below the rate at which every pipeline candidate has a
      // live analogue", which is exactly ANALYSIS_HZ_FLOOR.
      degraded: this.hz < ANALYSIS_HZ_FLOOR - 1e-6,
    };
  }

  /**
   * Fold in one measured analysis cost.
   *
   * Decisions are made on the median of the last twenty, never on one frame:
   * a single garbage-collection pause is not a reason to halve the rate, and a
   * single fast frame is not a reason to raise it. Changes are also rate-limited
   * to one every two seconds, because an analyser whose period oscillates makes
   * the motion measurement's dt jitter, and dt is a divisor in
   * `toCandidateInterval`.
   */
  observe(costMs: number, nowMs: number): void {
    this.costs.push(costMs);
    if (this.costs.length > 20) this.costs.shift();
    if (this.costs.length < 10) return;
    if (nowMs - this.lastChangeAt < 2000) return;

    const cost = this.medianCost();
    if (cost > ANALYSIS_BUDGET_MS && this.hz > ANALYSIS_HZ_FLOOR) {
      this.hz = Math.max(ANALYSIS_HZ_FLOOR, this.hz - 1);
      this.lastChangeAt = nowMs;
      this.costs.length = 0;
    } else if (cost < ANALYSIS_BUDGET_MS * 0.6 && this.hz < ANALYSIS_HZ) {
      this.hz = Math.min(ANALYSIS_HZ, this.hz + 1);
      this.lastChangeAt = nowMs;
      this.costs.length = 0;
    }
  }

  /**
   * True when even the floor rate cannot be held.
   *
   * At that point the app is not measuring what it claims to measure and says
   * so, rather than showing a confident green banner built from a third of the
   * frames.
   */
  cannotKeepUp(): boolean {
    return this.costs.length >= 10 && this.medianCost() > (1000 / ANALYSIS_HZ_FLOOR) * 0.9;
  }

  private medianCost(): number {
    if (this.costs.length === 0) return 0;
    const a = Array.from(this.costs).sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 === 1 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
  }
}
