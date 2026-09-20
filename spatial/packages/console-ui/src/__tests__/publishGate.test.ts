/**
 * The publish gate.
 *
 * The invariant under test is one sentence: the console offers publication if
 * and only if the latest quality verdict is `pass`. Everything else — review,
 * fail, missing, malformed, stale, unsaved corrections — must come back
 * `publishable: false` with a reason and a route. If any case here ever flips,
 * the console is offering an action `wv-worlds` will refuse with a 409.
 */

import { describe, expect, it } from 'vitest';
import type { QualityCheck, QualityReport } from '@m3xi/world-core';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { checkMargin, evaluateGate, isMarginal, parseQualityRow } from '../logic/publishGate.js';
import type { MemberRole } from '../logic/roles.js';
import type { WorldDetail } from '../logic/api.js';

function report(verdict: QualityReport['verdict'], checks: QualityCheck[] = [], createdAt = '2026-09-01T10:00:00.000Z'): QualityReport {
  return { checks, score: 0.9, verdict, createdAt };
}

const FAILING_CHECK: QualityCheck = {
  name: 'ceiling_observed_fraction', value: 0.61, threshold: 0.85, higherIsBetter: true, pass: false,
  detail: 'bathroom ceiling never in view',
};
const PASSING_CHECK: QualityCheck = {
  name: 'scale_agreement', value: 0.981, threshold: 0.95, higherIsBetter: true, pass: true,
};

describe('evaluateGate', () => {
  it('publishes a pass for a role that may publish', () => {
    const d = evaluateGate({ report: report('pass', [PASSING_CHECK]), worldStatus: 'review', role: 'operator' });
    expect(d.publishable).toBe(true);
    expect(d.state).toBe('pass');
    expect(d.route).toBe('publish');
  });

  it('refuses a review verdict and routes it to correction', () => {
    const d = evaluateGate({ report: report('review', [FAILING_CHECK]), worldStatus: 'review', role: 'operator' });
    expect(d.publishable).toBe(false);
    expect(d.state).toBe('review');
    expect(d.route).toBe('correct');
    expect(d.failingChecks.map((c) => c.name)).toEqual(['ceiling_observed_fraction']);
    expect(d.reason).toContain('ceiling observed fraction');
  });

  it('refuses a fail verdict and routes it to recapture, not correction', () => {
    const d = evaluateGate({ report: report('fail', [FAILING_CHECK]), worldStatus: 'processing', role: 'owner' });
    expect(d.publishable).toBe(false);
    expect(d.state).toBe('fail');
    expect(d.route).toBe('recapture');
  });

  it('refuses a world with no quality report at all', () => {
    const d = evaluateGate({ report: null, worldStatus: 'draft', role: 'owner' });
    expect(d.publishable).toBe(false);
    expect(d.state).toBe('unassessed');
    expect(d.route).toBe('build');
    expect(d.reason).toMatch(/never assessed/i);
  });

  it('refuses an unrecognised verdict rather than shrugging', () => {
    const d = evaluateGate({
      report: { ...report('pass'), verdict: 'probably fine' as QualityReport['verdict'] },
      worldStatus: 'review', role: 'owner',
    });
    expect(d.publishable).toBe(false);
    expect(d.reason).toMatch(/unrecognised verdict/i);
  });

  it('refuses a pass whose report predates the last correction', () => {
    const d = evaluateGate({
      report: report('pass', [PASSING_CHECK], '2026-09-01T10:00:00.000Z'),
      worldStatus: 'review',
      role: 'owner',
      lastCorrectionAt: '2026-09-02T09:00:00.000Z',
    });
    expect(d.publishable).toBe(false);
    expect(d.state).toBe('stale');
    expect(d.route).toBe('requality');
  });

  it('accepts a pass whose report postdates the last correction', () => {
    const d = evaluateGate({
      report: report('pass', [PASSING_CHECK], '2026-09-03T10:00:00.000Z'),
      worldStatus: 'review',
      role: 'owner',
      lastCorrectionAt: '2026-09-02T09:00:00.000Z',
    });
    expect(d.publishable).toBe(true);
  });

  it('refuses a pass while corrections are unsaved', () => {
    const d = evaluateGate({
      report: report('pass', [PASSING_CHECK]), worldStatus: 'review', role: 'owner',
      hasUnsavedCorrections: true,
    });
    expect(d.publishable).toBe(false);
    expect(d.reason).toMatch(/unsaved/i);
  });

  it('refuses a pass for a viewer and says why', () => {
    const d = evaluateGate({ report: report('pass', [PASSING_CHECK]), worldStatus: 'review', role: 'viewer' });
    expect(d.publishable).toBe(false);
    expect(d.state).toBe('pass');
    expect(d.route).toBe('none');
    expect(d.reason).toMatch(/cannot publish/i);
  });

  it('still surfaces a failed check inside a passing report', () => {
    // A verdict of pass with an individual check failing is possible: the
    // pipeline weighs them. The console shows both rather than only the verdict.
    const d = evaluateGate({
      report: report('pass', [PASSING_CHECK, FAILING_CHECK]), worldStatus: 'review', role: 'owner',
    });
    expect(d.publishable).toBe(true);
    expect(d.failingChecks).toHaveLength(1);
  });

  it('refuses every non-pass verdict for every role', () => {
    const roles = ['owner', 'admin', 'operator', 'viewer'] as const;
    for (const verdict of ['review', 'fail'] as const) {
      for (const role of roles) {
        const d = evaluateGate({ report: report(verdict, [FAILING_CHECK]), worldStatus: 'review', role });
        expect(d.publishable, `${verdict}/${role}`).toBe(false);
      }
    }
  });
});

/**
 * The path, not just the rule.
 *
 * `stale` was unreachable for as long as nothing filled in the timestamp: the
 * four correctable tables had no `updated_at`, `get_world` returned nothing
 * for it, and the client hardcoded null. Every one of those is now real, so
 * what is worth pinning here is the composition the world pages perform —
 * `WorldDetail` in, `GateDecision` out — because a regression anywhere along
 * it turns the gate off silently and leaves a green Publish button over a
 * report that describes a world that no longer exists.
 */
function gateFor(detail: WorldDetail, role: MemberRole = 'owner') {
  // Exactly what pages/worldQuality.ts and pages/worldReview.ts do.
  return evaluateGate({
    report: parseQualityRow(detail.quality as never).report,
    worldStatus: detail.world.status,
    role,
    lastCorrectionAt: detail.lastCorrectionAt,
  });
}

function detailWith(lastCorrectionAt: string | null, reportAt = '2026-09-01T10:00:00.000Z'): WorldDetail {
  return {
    world: {
      id: 'w1', property_id: 'p1', version: 2, status: 'review', published_at: null,
      quality_score: 0.93, slug: null, created_at: '2026-09-01T08:00:00.000Z', supersedes_id: null,
    },
    jobs: [],
    // The raw jsonb row, as `get_world` projects it — not a parsed report.
    quality: {
      checks: [{ name: 'scale_agreement', value: 0.981, threshold: 0.95, higherIsBetter: true, pass: true }],
      score: 0.93,
      verdict: 'pass',
      created_at: reportAt,
    },
    qualityHistory: [],
    assetCount: 8,
    assetBytes: 19_212_644,
    roomCount: 5,
    captures: [],
    lastCorrectionAt,
  };
}

describe('lastCorrectionAt reaching the gate', () => {
  it('publishes a passing world that has never been corrected', () => {
    const d = gateFor(detailWith(null));
    expect(d.state).toBe('pass');
    expect(d.publishable).toBe(true);
  });

  it('closes the gate once a correction postdates the report', () => {
    const d = gateFor(detailWith('2026-09-01T11:30:00.000Z'));
    expect(d.state).toBe('stale');
    expect(d.publishable).toBe(false);
    expect(d.route).toBe('requality');
    expect(d.reason).toMatch(/re-run the quality stage/i);
  });

  it('opens again once quality has been re-run over the corrected world', () => {
    const d = gateFor(detailWith('2026-09-01T11:30:00.000Z', '2026-09-01T12:00:00.000Z'));
    expect(d.state).toBe('pass');
    expect(d.publishable).toBe(true);
  });

  it('does not call a report stale against a correction it already covers', () => {
    // Equal timestamps are the report having been written for that state. The
    // comparison is strictly "after", so this must not flip.
    const d = gateFor(detailWith('2026-09-01T10:00:00.000Z'));
    expect(d.state).toBe('pass');
  });

  it('keeps the role check ahead of nothing: a viewer still cannot publish a fresh pass', () => {
    const d = gateFor(detailWith(null), 'viewer');
    expect(d.publishable).toBe(false);
    expect(d.route).toBe('none');
  });

  it('holds stale above role, because the world itself is the problem', () => {
    const d = gateFor(detailWith('2026-09-01T11:30:00.000Z'), 'viewer');
    expect(d.state).toBe('stale');
    expect(d.route).toBe('requality');
  });
});

describe('the shipped fixture', () => {
  it('is a review, and the console refuses to publish it', () => {
    // FLAT's quality block is a `review` with ceiling_observed_fraction failing.
    // If a future edit turned it into a pass this test would catch the change
    // to the one fixture every package tests against.
    expect(FLAT.quality.verdict).toBe('review');
    const d = evaluateGate({ report: FLAT.quality, worldStatus: 'review', role: 'owner' });
    expect(d.publishable).toBe(false);
    expect(d.failingChecks.map((c) => c.name)).toEqual(['ceiling_observed_fraction']);
  });
});

describe('check margins', () => {
  it('flags a check that scraped through', () => {
    expect(isMarginal({ name: 'x', value: 0.86, threshold: 0.85, higherIsBetter: true, pass: true })).toBe(true);
    expect(isMarginal({ name: 'x', value: 0.99, threshold: 0.85, higherIsBetter: true, pass: true })).toBe(false);
  });

  it('handles lower-is-better checks the right way round', () => {
    expect(isMarginal({ name: 'x', value: 0.079, threshold: 0.08, higherIsBetter: false, pass: true })).toBe(true);
    expect(isMarginal({ name: 'x', value: 0.01, threshold: 0.08, higherIsBetter: false, pass: true })).toBe(false);
  });

  it('never calls a failing check marginal', () => {
    expect(isMarginal(FAILING_CHECK)).toBe(false);
  });

  it('measures the margin as a signed fraction of the threshold', () => {
    expect(checkMargin({ name: 'x', value: 0.99, threshold: 0.9, higherIsBetter: true, pass: true }))
      .toBeCloseTo(0.1, 10);
    expect(checkMargin({ name: 'x', value: 0.5, threshold: 1, higherIsBetter: false, pass: true }))
      .toBeCloseTo(0.5, 10);
    expect(checkMargin({ name: 'x', value: 1, threshold: 0, higherIsBetter: true, pass: true })).toBeNull();
  });
});

describe('parseQualityRow', () => {
  it('reads a well-formed jsonb row', () => {
    const { report: parsed, discarded } = parseQualityRow({
      checks: [{ name: 'scale_agreement', value: 0.98, threshold: 0.95, higherIsBetter: true, pass: true }],
      score: 0.93, verdict: 'pass', created_at: '2026-09-01T10:00:00.000Z',
    });
    expect(discarded).toBe(0);
    expect(parsed?.verdict).toBe('pass');
    expect(parsed?.checks).toHaveLength(1);
  });

  it('discards a malformed check but keeps the rest', () => {
    const { report: parsed, discarded } = parseQualityRow({
      checks: [
        { name: 'ok', value: 1, threshold: 0.5, pass: true },
        { name: 'broken' },
        'nonsense',
      ],
      score: 0.5, verdict: 'review', created_at: '2026-09-01T10:00:00.000Z',
    });
    expect(discarded).toBe(2);
    expect(parsed?.checks.map((c) => c.name)).toEqual(['ok']);
  });

  it('returns no report when the verdict is missing, so the gate refuses', () => {
    const { report: parsed } = parseQualityRow({ checks: [], score: 1, created_at: 'x' });
    expect(parsed).toBeNull();
    expect(evaluateGate({ report: parsed, worldStatus: 'review', role: 'owner' }).publishable).toBe(false);
  });

  it('trusts the row’s own pass flag rather than recomputing it', () => {
    // The pipeline decides. A console that recomputed pass from the threshold
    // would be quietly overriding the gate.
    const { report: parsed } = parseQualityRow({
      checks: [{ name: 'x', value: 0.1, threshold: 0.9, higherIsBetter: true, pass: true }],
      score: 1, verdict: 'pass', created_at: '2026-09-01T10:00:00.000Z',
    });
    expect(parsed?.checks[0]?.pass).toBe(true);
  });

  it('falls back to the threshold only when the row omits pass', () => {
    const { report: parsed } = parseQualityRow({
      checks: [{ name: 'x', value: 0.1, threshold: 0.9, higherIsBetter: true }],
      score: 1, verdict: 'review', created_at: '2026-09-01T10:00:00.000Z',
    });
    expect(parsed?.checks[0]?.pass).toBe(false);
  });

  it('treats a null row as no report', () => {
    expect(parseQualityRow(null).report).toBeNull();
  });
});
