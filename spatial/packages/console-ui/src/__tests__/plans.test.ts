/**
 * Pricing.
 *
 * The rule being enforced is a product rule, not an engineering one: the price
 * is a number on the page. "Enquire", "contact sales" and "price on request"
 * are the pattern this product exists partly to avoid, so they are asserted
 * against rather than left to code review.
 */

import { describe, expect, it } from 'vitest';
import { AI_METERING_NOTE, ANNUAL_PLAN_AVAILABLE, BILLING_NOTES, PLANS, compareAllowances, planById } from '../logic/plans.js';

const FORBIDDEN = /enquire|enquiry|contact sales|price on request|get a quote|talk to sales|custom pricing/i;

describe('every plan states a number', () => {
  it('has the three prices the product sells', () => {
    expect(PLANS.map((p) => p.priceGbp)).toEqual([5, 200, 500]);
    expect(planById('trial').period).toBe('one-off');
    expect(planById('standard').period).toBe('month');
    expect(planById('business').period).toBe('month');
  });

  it('never uses an enquire-style phrase anywhere in the catalogue', () => {
    const text = JSON.stringify(PLANS) + BILLING_NOTES.join(' ') + AI_METERING_NOTE;
    expect(text).not.toMatch(FORBIDDEN);
  });

  it('gives every plan a positive, finite price', () => {
    for (const plan of PLANS) {
      expect(Number.isFinite(plan.priceGbp), plan.id).toBe(true);
      expect(plan.priceGbp, plan.id).toBeGreaterThan(0);
    }
  });

  it('states all three allowances on every plan', () => {
    for (const plan of PLANS) {
      expect(plan.allowances.buildsPerMonth, plan.id).toBeGreaterThan(0);
      expect(plan.allowances.aiMonthCapGbp, plan.id).toBeGreaterThan(0);
      expect(plan.allowances.aiTurnsPerSession, plan.id).toBeGreaterThan(0);
    }
  });

  it('gives business strictly higher allowances than standard', () => {
    const s = planById('standard').allowances;
    const b = planById('business').allowances;
    expect(b.buildsPerMonth).toBeGreaterThan(s.buildsPerMonth);
    expect(b.aiMonthCapGbp).toBeGreaterThan(s.aiMonthCapGbp);
    expect(b.aiTurnsPerSession).toBeGreaterThan(s.aiTurnsPerSession);
  });

  it('has no annual plan, and says so', () => {
    expect(ANNUAL_PLAN_AVAILABLE).toBe(false);
    expect(BILLING_NOTES.join(' ')).toMatch(/no annual plan/i);
  });
});

describe('AI metering is explained, not implied', () => {
  it('says the word metered and names both limits', () => {
    expect(AI_METERING_NOTE).toMatch(/metered/i);
    expect(AI_METERING_NOTE).toMatch(/session/i);
    expect(AI_METERING_NOTE).toMatch(/month/i);
    expect(AI_METERING_NOTE).toMatch(/before the model is called/i);
  });

  it('says the walkthrough keeps working when the cap is reached', () => {
    expect(AI_METERING_NOTE).toMatch(/walkthrough itself keeps working/i);
  });
});

describe('stated versus enforced allowances', () => {
  it('matches when the org row carries the plan’s numbers', () => {
    const rows = compareAllowances(planById('standard'), {
      build_month_cap: 50, ai_month_cap_gbp: 25, ai_turns_per_session: 25,
    });
    expect(rows.every((r) => r.matches)).toBe(true);
  });

  it('shows a divergence rather than hiding it', () => {
    const rows = compareAllowances(planById('standard'), {
      build_month_cap: 10, ai_month_cap_gbp: '25.00', ai_turns_per_session: null,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['buildsPerMonth']!.matches).toBe(false);
    expect(byKey['buildsPerMonth']!.enforced).toBe(10);
    expect(byKey['aiMonthCapGbp']!.matches).toBe(true);
    expect(byKey['aiTurnsPerSession']!.enforced).toBeNull();
    expect(byKey['aiTurnsPerSession']!.matches).toBe(false);
  });
});
