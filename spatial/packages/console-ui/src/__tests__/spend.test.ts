/**
 * Spend and caps, at the boundary and past it.
 *
 * `wv_spend_allowed` blocks with `>=`, so "at the cap" already means the next
 * request is refused. The console must say that in those words rather than
 * showing a full bar and a cheerful tone. Both the at-cap and the over-cap
 * cases are pinned here, and so is the exchange rate, because a console that
 * converted at a different rate from the function enforcing the cap would show
 * a bar at 94% to somebody who is already cut off.
 */

import { describe, expect, it } from 'vitest';
import { USD_TO_GBP, spend as fmtSpend, money } from '../logic/format.js';
import { capSentence, capView, monthStart, summariseSpend } from '../logic/spend.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const THIS_MONTH = '2026-09-10T09:00:00.000Z';
const LAST_MONTH = '2026-08-28T09:00:00.000Z';

describe('the rate is the one the database enforces', () => {
  it('is 0.79 GBP per USD, matching wv_spend_allowed', () => {
    expect(USD_TO_GBP).toBe(0.79);
  });
});

describe('capView', () => {
  it('is ok well below the cap', () => {
    const v = capView(10, 50);
    expect(v.state).toBe('ok');
    expect(v.blocked).toBe(false);
    expect(v.remaining).toBe(40);
  });

  it('warns from 75% of the allowance', () => {
    expect(capView(37, 50).state).toBe('ok');
    expect(capView(37.5, 50).state).toBe('approaching');
    expect(capView(49, 50).state).toBe('approaching');
  });

  it('is blocked exactly AT the cap, not one past it', () => {
    const v = capView(50, 50);
    expect(v.state).toBe('at_cap');
    expect(v.blocked).toBe(true);
    expect(v.ratio).toBe(1);
    expect(v.remaining).toBe(0);
  });

  it('distinguishes past the cap from at it', () => {
    const v = capView(70, 50);
    expect(v.state).toBe('over_cap');
    expect(v.blocked).toBe(true);
    expect(v.ratio).toBe(1);          // the bar cannot overflow
    expect(v.ratioRaw).toBeCloseTo(1.4, 10); // but the number is not clamped
  });

  it('treats a missing or zero cap as uncapped rather than as zero allowance', () => {
    expect(capView(3, null).state).toBe('uncapped');
    expect(capView(3, 0).state).toBe('uncapped');
    expect(capView(3, null).blocked).toBe(false);
  });

  it('never reports negative use', () => {
    expect(capView(-5, 10).used).toBe(0);
  });
});

describe('cap sentences', () => {
  it('says the next request is already refused at the cap', () => {
    expect(capSentence('builds', capView(50, 50))).toMatch(/will be refused/i);
    expect(capSentence('ai', capView(25, 25))).toMatch(/will be refused/i);
  });

  it('uses the past tense once over the cap', () => {
    expect(capSentence('ai', capView(30, 25))).toMatch(/already being refused/i);
  });

  it('calls out an uncapped AI allowance as the dangerous setting it is', () => {
    expect(capSentence('ai', capView(9, null))).toMatch(/unmetered/i);
  });

  it('counts builds remaining in whole builds', () => {
    expect(capSentence('builds', capView(46, 50))).toBe('4 of 50 builds left this month.');
  });
});

describe('summariseSpend', () => {
  const base = {
    caps: { ai_month_cap_gbp: 25, build_month_cap: 50, ai_turns_per_session: 25 },
    worldToProperty: { w1: 'p1', w2: 'p2' },
    propertyLabels: { p1: '14 Ash Grove', p2: 'Flat 2, Elm Court' },
    now: NOW,
  };

  it('counts only this calendar month, in UTC', () => {
    expect(monthStart(NOW).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    const s = summariseSpend({
      ...base,
      aiTurns: [
        { at: THIS_MONTH, cost_usd: 1, world_id: 'w1' },
        { at: LAST_MONTH, cost_usd: 100, world_id: 'w1' },
      ],
      jobs: [],
    });
    expect(s.aiTurnCount).toBe(1);
    expect(s.aiGbp).toBeCloseTo(0.79, 10);
  });

  it('counts builds by the reconstruct stage, which is what the cap counts', () => {
    const s = summariseSpend({
      ...base,
      aiTurns: [],
      jobs: [
        { stage: 'reconstruct', queued_at: THIS_MONTH, world_id: 'w1', cost_usd: 2, gpu_seconds: 900 },
        { stage: 'mesh', queued_at: THIS_MONTH, world_id: 'w1', cost_usd: 0.5, gpu_seconds: 120 },
        { stage: 'reconstruct', queued_at: LAST_MONTH, world_id: 'w1', cost_usd: 2, gpu_seconds: 900 },
      ],
    });
    expect(s.builds.used).toBe(1);
    // The bill is every stage, not only the counted one.
    expect(s.buildGbp).toBeCloseTo(2.5 * 0.79, 10);
    expect(s.gpuSeconds).toBe(1020);
  });

  it('reports at_cap when AI spend has reached the ceiling', () => {
    // 31.6459 USD * 0.79 = 25.0002... which is >= the 25.00 cap.
    const s = summariseSpend({
      ...base,
      aiTurns: [{ at: THIS_MONTH, cost_usd: 31.6459, world_id: 'w1' }],
      jobs: [],
    });
    expect(s.ai.blocked).toBe(true);
    expect(s.ai.state).toBe('over_cap');
  });

  it('reports at_cap exactly on the boundary', () => {
    const s = summariseSpend({
      ...base,
      aiTurns: [{ at: THIS_MONTH, cost_usd: 25 / 0.79, world_id: 'w1' }],
      jobs: [],
    });
    expect(s.ai.state === 'at_cap' || s.ai.state === 'over_cap').toBe(true);
    expect(s.ai.blocked).toBe(true);
  });

  it('reports the build cap as reached at exactly the cap', () => {
    const jobs = Array.from({ length: 50 }, () => ({
      stage: 'reconstruct', queued_at: THIS_MONTH, world_id: 'w1', cost_usd: 1, gpu_seconds: 10,
    }));
    const s = summariseSpend({ ...base, aiTurns: [], jobs });
    expect(s.builds.used).toBe(50);
    expect(s.builds.state).toBe('at_cap');
    expect(s.builds.blocked).toBe(true);
    expect(s.builds.remaining).toBe(0);
  });

  it('attributes spend to properties through the world map', () => {
    const s = summariseSpend({
      ...base,
      aiTurns: [
        { at: THIS_MONTH, cost_usd: 1, world_id: 'w1' },
        { at: THIS_MONTH, cost_usd: 3, world_id: 'w2' },
        { at: THIS_MONTH, cost_usd: 9, world_id: 'w_unknown' },
      ],
      jobs: [{ stage: 'reconstruct', queued_at: THIS_MONTH, world_id: 'w1', cost_usd: 2, gpu_seconds: 600 }],
    });
    const byId = Object.fromEntries(s.perProperty.map((p) => [p.propertyId, p]));
    expect(byId['p1']!.label).toBe('14 Ash Grove');
    expect(byId['p1']!.totalGbp).toBeCloseTo(3 * 0.79, 10);
    expect(byId['p2']!.totalGbp).toBeCloseTo(3 * 0.79, 10);
    // A turn on a world we cannot attribute still counts against the org.
    expect(s.aiGbp).toBeCloseTo(13 * 0.79, 10);
    expect(s.perProperty).toHaveLength(2);
  });

  it('means the cost per property across properties that actually cost something', () => {
    const s = summariseSpend({
      ...base,
      aiTurns: [{ at: THIS_MONTH, cost_usd: 10, world_id: 'w1' }],
      jobs: [{ stage: 'reconstruct', queued_at: THIS_MONTH, world_id: 'w2', cost_usd: 0, gpu_seconds: 0 }],
    });
    // p2 spent nothing, so it does not drag the mean down to half.
    expect(s.meanCostPerPropertyGbp).toBeCloseTo(7.9, 10);
  });

  it('is all zeroes and uncapped when nothing is configured and nothing happened', () => {
    const s = summariseSpend({
      caps: { ai_month_cap_gbp: null, build_month_cap: null, ai_turns_per_session: null },
      aiTurns: [], jobs: [], worldToProperty: {}, propertyLabels: {}, now: NOW,
    });
    expect(s.totalGbp).toBe(0);
    expect(s.ai.state).toBe('uncapped');
    expect(s.turnsPerSession).toBeNull();
  });

  it('reads numerics that PostgREST returned as strings', () => {
    const s = summariseSpend({
      ...base,
      aiTurns: [{ at: THIS_MONTH, cost_usd: '2.50000', world_id: 'w1' }],
      jobs: [{ stage: 'reconstruct', queued_at: THIS_MONTH, world_id: 'w1', cost_usd: '1.25', gpu_seconds: '30.5' }],
    });
    expect(s.aiGbp).toBeCloseTo(2.5 * 0.79, 10);
    expect(s.gpuSeconds).toBeCloseTo(30.5, 10);
  });
});

describe('money never flatters us', () => {
  it('rounds spend up to the penny', () => {
    expect(fmtSpend(0.001)).toBe('£0.01');
    expect(fmtSpend(1.234)).toBe('£1.24');
    expect(fmtSpend(0)).toBe('£0.00');
  });

  it('shows an unknown figure as a dash, never as zero', () => {
    expect(money(null)).toBe('—');
    expect(fmtSpend(undefined)).toBe('—');
    expect(fmtSpend(Number.NaN)).toBe('—');
  });
});
