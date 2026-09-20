/**
 * The publish gate, rendered honestly.
 *
 * `supabase/functions/wv-worlds/handler.ts` refuses to publish anything whose
 * latest `wv_quality` verdict is not `pass`, including `review`, and including
 * a world that has no quality row at all. This module is the console's copy of
 * that decision — not to duplicate the authority, which stays on the server,
 * but so the UI never offers an action the server will refuse.
 *
 * The rule that matters most is the negative one: nothing in here may produce
 * a state where a world *looks* publishable and is not. So every non-pass
 * outcome carries the reason, the failing checks, and the one route that can
 * actually move the world forward.
 */

import type { QualityCheck, QualityReport } from '@m3xi/world-core';
import type { MemberRole } from './roles.js';
import { can } from './roles.js';

/** Verdicts the database may hold, plus the two the console must invent. */
export type GateState =
  /** No `wv_quality` row exists. Never assessed is not the same as passed. */
  | 'unassessed'
  /** The latest report predates a correction, so it describes a world that no
   *  longer exists. Publishing it would publish an unverified state. */
  | 'stale'
  | 'fail'
  | 'review'
  | 'pass';

/** What an operator should do next. Exactly one, never a menu of maybes. */
export type GateRoute =
  | 'build'      // queue the pipeline; there is nothing to assess yet
  | 'requality'  // re-run the quality stage over the corrected world
  | 'correct'    // open the correction editor; a human can fix this
  | 'recapture'  // the capture itself is not good enough; rescan
  | 'publish'    // it passed and the caller may publish
  | 'none';      // it passed but this caller may not publish

export interface GateInput {
  /** The latest `wv_quality` row for this world, or null when there is none. */
  readonly report: QualityReport | null;
  /** `wv_world.status`. */
  readonly worldStatus: string;
  readonly role: MemberRole | null;
  /** ISO timestamp of the most recent applied correction, when known. */
  readonly lastCorrectionAt?: string | null;
  /** True while the correction editor holds unsaved changes. */
  readonly hasUnsavedCorrections?: boolean;
}

export interface GateDecision {
  readonly state: GateState;
  /** The only question the button should ask. */
  readonly publishable: boolean;
  /** One sentence, addressed to the operator. */
  readonly reason: string;
  readonly route: GateRoute;
  /** Every check that did not pass, in report order. */
  readonly failingChecks: readonly QualityCheck[];
  /** Checks that passed but sit within 10% of their threshold. */
  readonly marginalChecks: readonly QualityCheck[];
  readonly score: number | null;
  readonly alreadyPublished: boolean;
}

/** A check is marginal when it is within this fraction of its threshold. */
const MARGIN = 0.1;

export function isMarginal(check: QualityCheck): boolean {
  if (!check.pass) return false;
  const { value, threshold } = check;
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold === 0) return false;
  const slack = check.higherIsBetter ? value - threshold : threshold - value;
  return slack >= 0 && slack <= Math.abs(threshold) * MARGIN;
}

/**
 * How far a check is from its threshold, as a signed fraction of the
 * threshold. Positive is better than required. Used for the bar, so a check
 * that scraped through does not look identical to one that sailed through.
 */
export function checkMargin(check: QualityCheck): number | null {
  const { value, threshold } = check;
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold === 0) return null;
  const slack = check.higherIsBetter ? value - threshold : threshold - value;
  return slack / Math.abs(threshold);
}

export function evaluateGate(input: GateInput): GateDecision {
  const { report, worldStatus, role } = input;
  const alreadyPublished = worldStatus === 'published';
  const mayPublish = can(role, 'world.publish');

  const failingChecks = report ? report.checks.filter((c) => !c.pass) : [];
  const marginalChecks = report ? report.checks.filter(isMarginal) : [];
  const score = report ? report.score : null;

  const base = { failingChecks, marginalChecks, score, alreadyPublished } as const;

  if (!report) {
    return {
      ...base,
      state: 'unassessed',
      publishable: false,
      reason:
        'This world has not been through the quality gate. A world that was never assessed is not the same as one that passed.',
      route: 'build',
    };
  }

  // A report older than the last correction describes a world that no longer
  // exists. The server would happily publish it; the console will not offer to.
  if (isStale(report, input.lastCorrectionAt)) {
    return {
      ...base,
      state: 'stale',
      publishable: false,
      reason:
        'Corrections were applied after this quality report was written, so the report no longer describes this world. Re-run the quality stage before publishing.',
      route: 'requality',
    };
  }

  if (input.hasUnsavedCorrections === true) {
    return {
      ...base,
      state: report.verdict === 'pass' ? 'stale' : (report.verdict as GateState),
      publishable: false,
      reason: 'There are unsaved corrections. Save or discard them before publishing.',
      route: 'correct',
    };
  }

  if (report.verdict === 'fail') {
    return {
      ...base,
      state: 'fail',
      publishable: false,
      reason: failingChecks.length > 0
        ? `The quality gate failed on ${listNames(failingChecks)}. A failed world cannot be corrected into a pass — the capture itself is not good enough.`
        : 'The quality gate failed. The capture itself is not good enough to publish.',
      route: 'recapture',
    };
  }

  if (report.verdict === 'review') {
    return {
      ...base,
      state: 'review',
      publishable: false,
      reason: failingChecks.length > 0
        ? `The quality gate wants a human on ${listNames(failingChecks)}. Correct what is wrong, then re-run quality.`
        : 'The quality gate wants a human to look at this world before it is published.',
      route: 'correct',
    };
  }

  if (report.verdict !== 'pass') {
    // An unknown verdict string is a refusal, not a shrug. `wv_quality.verdict`
    // is a plain text column, so this is reachable from a bad pipeline write.
    return {
      ...base,
      state: 'fail',
      publishable: false,
      reason: `The quality gate returned an unrecognised verdict (“${String(report.verdict)}”), so this world will not be published.`,
      route: 'requality',
    };
  }

  if (!mayPublish) {
    return {
      ...base,
      state: 'pass',
      publishable: false,
      reason: 'This world passed the quality gate. Your role cannot publish — ask an operator, admin or owner.',
      route: 'none',
    };
  }

  return {
    ...base,
    state: 'pass',
    publishable: true,
    reason: alreadyPublished
      ? 'This world passed the quality gate and is live.'
      : 'This world passed the quality gate and can be published.',
    route: 'publish',
  };
}

function isStale(report: QualityReport, lastCorrectionAt: string | null | undefined): boolean {
  if (!lastCorrectionAt) return false;
  const reportAt = Date.parse(report.createdAt);
  const correctedAt = Date.parse(lastCorrectionAt);
  if (!Number.isFinite(reportAt) || !Number.isFinite(correctedAt)) return false;
  return correctedAt > reportAt;
}

function listNames(checks: readonly QualityCheck[]): string {
  const names = checks.map((c) => c.name.replace(/[_-]+/g, ' '));
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Turn a raw `wv_quality` row into the contract's `QualityReport`.
 *
 * The column is jsonb and the pipeline writes it, so this is the boundary
 * where a malformed report becomes a *missing* report rather than a report
 * that quietly reads as passing. Anything it cannot understand is dropped and
 * counted, and a report with no understandable checks is null.
 */
export interface ParsedQuality {
  readonly report: QualityReport | null;
  /** Checks discarded because they were not shaped like a check. */
  readonly discarded: number;
}

export function parseQualityRow(row: {
  checks?: unknown; score?: unknown; verdict?: unknown; created_at?: unknown;
} | null | undefined): ParsedQuality {
  if (!row) return { report: null, discarded: 0 };

  const raw = Array.isArray(row.checks) ? row.checks : [];
  const checks: QualityCheck[] = [];
  let discarded = 0;
  for (const item of raw) {
    const parsed = parseCheck(item);
    if (parsed) checks.push(parsed); else discarded += 1;
  }

  const verdict = row.verdict;
  if (typeof verdict !== 'string' || verdict.length === 0) return { report: null, discarded };

  const score = Number(row.score);
  const createdAt = typeof row.created_at === 'string' ? row.created_at : new Date(0).toISOString();

  return {
    report: {
      checks,
      score: Number.isFinite(score) ? score : 0,
      verdict: verdict as QualityReport['verdict'],
      createdAt,
    },
    discarded,
  };
}

function parseCheck(item: unknown): QualityCheck | null {
  if (typeof item !== 'object' || item === null) return null;
  const c = item as Record<string, unknown>;
  const name = typeof c['name'] === 'string' ? c['name'] : null;
  const value = Number(c['value']);
  const threshold = Number(c['threshold']);
  if (!name || !Number.isFinite(value) || !Number.isFinite(threshold)) return null;

  const higherIsBetter = c['higherIsBetter'] === undefined
    ? true
    : c['higherIsBetter'] === true;
  // `pass` is taken from the row when present. It is NOT recomputed from the
  // threshold: the pipeline decides, and a console that disagreed with it
  // would be quietly overriding the gate.
  const pass = typeof c['pass'] === 'boolean'
    ? c['pass']
    : (higherIsBetter ? value >= threshold : value <= threshold);

  const detail = typeof c['detail'] === 'string' ? c['detail'] : undefined;
  return detail === undefined
    ? { name, value, threshold, higherIsBetter, pass }
    : { name, value, threshold, higherIsBetter, pass, detail };
}

/**
 * Plain-English names for the checks the pipeline writes, so an operator does
 * not have to read `unobserved_volume_fraction`. An unknown check keeps its
 * own name rather than being hidden.
 */
export const CHECK_LABELS: Readonly<Record<string, { label: string; meaning: string }>> = {
  scale_agreement: {
    label: 'Scale agreement',
    meaning: 'How closely the independent scale estimators agreed. Disagreement means the metres are not trustworthy.',
  },
  pose_coverage: {
    label: 'Pose coverage',
    meaning: 'Share of frames whose camera position was solved. Unposed frames are frames the world cannot use.',
  },
  unobserved_volume_fraction: {
    label: 'Unobserved volume',
    meaning: 'Share of the property’s volume no camera ever saw. Lower is better.',
  },
  ceiling_observed_fraction: {
    label: 'Ceilings observed',
    meaning: 'Share of ceiling area actually in view. An inferred ceiling cannot carry a height measurement.',
  },
  blur_rejected_fraction: {
    label: 'Frames rejected for blur',
    meaning: 'Share of frames dropped as too blurred to measure from.',
  },
  room_closure: {
    label: 'Room closure',
    meaning: 'Share of room outlines that closed into a watertight polygon.',
  },
  redaction_reviewed: {
    label: 'Redactions reviewed',
    meaning: 'Share of detected faces, documents and screens a human has signed off.',
  },
};
