import { describe, expect, it } from 'vitest';

import { makeAgent } from './harness.js';
import { DETERMINISTIC_TARGET, QUESTIONS } from './questions.js';
import type { Tier } from '../types.js';

const TIER_RANK: Record<Tier, number> = { deterministic: 0, small: 1, large: 2 };

interface Row {
  q: string;
  expected: Tier;
  actual: Tier;
  text: string;
  reason: string;
  ok: boolean;
}

/**
 * The whole question set, each question asked in a fresh session so no turn
 * can borrow context from the one before it. This is the pessimistic
 * measurement: in a real conversation the resolver's salience makes short
 * follow-ups cheaper, so the live deterministic fraction is higher than this.
 */
async function runSet(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of QUESTIONS) {
    const { agent, view } = makeAgent();
    const res = await agent.ask(c.q, view);
    rows.push({
      q: c.q,
      expected: c.expect,
      actual: res.decision.tier,
      text: res.answer.text,
      reason: res.decision.reason,
      ok: TIER_RANK[res.decision.tier] <= TIER_RANK[c.expect],
    });
  }
  return rows;
}

describe('router', () => {
  it('answers the clear majority of a realistic question set with no model call', async () => {
    const rows = await runSet();
    const det = rows.filter((r) => r.actual === 'deterministic');
    const fraction = det.length / rows.length;

    const byTier = {
      deterministic: det.length,
      small: rows.filter((r) => r.actual === 'small').length,
      large: rows.filter((r) => r.actual === 'large').length,
    };
    // Printed rather than only asserted: the number is a product metric, and
    // a regression in it should be visible in CI output, not just a red X.
    // eslint-disable-next-line no-console
    console.log(
      `\n  DETERMINISTIC FRACTION: ${(fraction * 100).toFixed(1)}% of ${rows.length} questions`
      + `\n  tier 0 ${byTier.deterministic} | tier 1 ${byTier.small} | tier 2 ${byTier.large}\n`
      + rows.filter((r) => r.actual !== 'deterministic')
        .map((r) => `    [${r.actual}] ${r.q}  -- ${r.reason}`).join('\n'),
    );

    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(fraction).toBeGreaterThan(DETERMINISTIC_TARGET);
  });

  it('never routes a question to a more expensive tier than it needs', async () => {
    const rows = await runSet();
    const overspent = rows.filter((r) => !r.ok);
    expect(
      overspent.map((r) => `${r.q} -> ${r.actual} (wanted ${r.expected}): ${r.reason}`),
    ).toEqual([]);
  });

  it('gives an answer that mentions what it should', async () => {
    const failures: string[] = [];
    for (const c of QUESTIONS) {
      if (!c.must) continue;
      const { agent, view } = makeAgent();
      const res = await agent.ask(c.q, view);
      if (!c.must.test(res.answer.text)) {
        failures.push(`${c.q}\n      got: ${res.answer.text}\n      want: ${c.must}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('escalates a judgement question even when the facts are deterministic', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('How big is the kitchen, and should I be worried about it?', view);
    expect(res.decision.tier).toBe('large');
    expect(res.decision.reason).toMatch(/judgement|clause/);
  });

  it('stops escalating once the session cost cap is reached', async () => {
    const { agent, view } = makeAgent({ config: { sessionCostCapUsd: 0 } });
    const res = await agent.ask('Why is the bathroom ceiling uncertain?', view);
    expect(res.decision.tier).toBe('deterministic');
    expect(res.record.costUsd).toBe(0);
    expect(res.decision.reason).toMatch(/cap/);
  });

  it('refuses once the session turn cap is reached, before doing any work', async () => {
    const { agent, view } = makeAgent({ config: { sessionTurnCap: 2 } });
    await agent.ask('How many bedrooms?', view);
    await agent.ask('How big is the kitchen?', view);
    const third = await agent.ask('How big is the bathroom?', view);
    expect(third.answer.refused).toBe(true);
    expect(third.answer.text).toMatch(/limit of 2 questions/);
    expect(third.record.tools).toEqual([]);
    expect(third.record.costUsd).toBe(0);
  });
});
