/**
 * What it costs, in numbers, on the page.
 *
 * No "enquire", no "price on request", no "contact sales". A letting agency
 * comparing three products at 9pm gets the number here or goes elsewhere, and
 * hiding it is a tell that the number depends on how much they look like they
 * can pay.
 *
 * The allowances below are the console's stated plan catalogue. What is
 * actually enforced is whatever sits on the `wv_org` row —
 * `ai_month_cap_gbp`, `build_month_cap`, `ai_turns_per_session` — so the plans
 * page shows both, side by side. If they ever diverge, the operator sees it
 * rather than finding out at the cap.
 */

export type PlanId = 'trial' | 'standard' | 'business';

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly priceGbp: number;
  readonly period: 'one-off' | 'month';
  readonly summary: string;
  /** The three numbers that decide whether a plan fits. */
  readonly allowances: {
    /** Reconstructions per calendar month — `build_month_cap`. */
    readonly buildsPerMonth: number;
    /** Monthly AI spend ceiling in GBP — `ai_month_cap_gbp`. */
    readonly aiMonthCapGbp: number;
    /** Questions one visitor may ask in one session — `ai_turns_per_session`. */
    readonly aiTurnsPerSession: number;
  };
  readonly includes: readonly string[];
  readonly notIncluded?: readonly string[];
}

/**
 * The £5 trial is a one-off, not a monthly plan, and it is deliberately small
 * enough to be one property: the point is to prove the thing works on YOUR
 * flat before anyone signs anything.
 */
export const PLANS: readonly Plan[] = [
  {
    id: 'trial',
    name: 'Trial',
    priceGbp: 5,
    period: 'one-off',
    summary: 'One property, once, so you can see the whole thing end to end before committing.',
    allowances: { buildsPerMonth: 1, aiMonthCapGbp: 2, aiTurnsPerSession: 10 },
    includes: [
      'One reconstruction',
      'Full quality report with every check and threshold',
      'Public link and embed',
      'Permanence bundle — yours to keep, whatever happens next',
    ],
    notIncluded: ['Additional properties', 'Team members beyond the account owner'],
  },
  {
    id: 'standard',
    name: 'Standard',
    priceGbp: 200,
    period: 'month',
    summary: 'The working plan for an agency with a normal pipeline of listings.',
    allowances: { buildsPerMonth: 50, aiMonthCapGbp: 25, aiTurnsPerSession: 25 },
    includes: [
      '50 reconstructions a month',
      'Unlimited published properties — a world stays live and stays yours',
      'Every version kept; a rescan never destroys the previous one',
      'Team members with owner, admin, operator and viewer roles',
      'Leads and room-level analytics',
      'Permanence bundle for every property, on demand',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    priceGbp: 500,
    period: 'month',
    summary: 'Higher allowances for a larger portfolio or a busier viewer chat.',
    allowances: { buildsPerMonth: 200, aiMonthCapGbp: 100, aiTurnsPerSession: 40 },
    includes: [
      '200 reconstructions a month',
      'Four times the monthly AI allowance',
      'Longer visitor conversations before the per-session limit',
      'Everything in Standard',
    ],
  },
];

/** There is no annual plan. Stated, not implied by its absence. */
export const ANNUAL_PLAN_AVAILABLE = false;

export const BILLING_NOTES: readonly string[] = [
  'Prices are per organisation, in pounds, excluding VAT.',
  'There is no annual plan. Monthly, cancel whenever you like.',
  'Cancelling stops new builds. It does not take your properties away: every world you have exported stays working, standalone, forever.',
];

/**
 * The metering explanation, spelled out rather than buried in a footnote.
 *
 * An unmetered agent on a popular listing is the single line item that can
 * outrun this product's economics — one viral flat with 40,000 visitors asking
 * three questions each is a five-figure model bill against a £200 subscription.
 * So it is capped twice, per session and per month, and both numbers are shown.
 */
export const AI_METERING_NOTE = [
  'AI conversation is metered. Every question a visitor asks the property costs money to answer, and that cost is charged against your organisation, not theirs.',
  'Two limits protect you. Each visitor session may ask a fixed number of questions. Each month has a spend ceiling in pounds, checked before the model is called, never after.',
  'When the monthly ceiling is reached, viewer chat stops answering until the cap is raised or the month rolls over. The walkthrough itself keeps working — it costs nothing to walk.',
].join(' ');

export function planById(id: PlanId): Plan {
  const plan = PLANS.find((p) => p.id === id);
  if (!plan) throw new Error(`Unknown plan ${id}`);
  return plan;
}

/**
 * Compare a plan's stated allowances with what is actually on the org row.
 * Divergence is shown, never smoothed over.
 */
export interface AllowanceComparison {
  readonly key: 'buildsPerMonth' | 'aiMonthCapGbp' | 'aiTurnsPerSession';
  readonly label: string;
  readonly stated: number;
  readonly enforced: number | null;
  readonly matches: boolean;
}

export function compareAllowances(plan: Plan, org: {
  build_month_cap?: number | string | null;
  ai_month_cap_gbp?: number | string | null;
  ai_turns_per_session?: number | string | null;
}): readonly AllowanceComparison[] {
  const num = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const rows: AllowanceComparison[] = [
    {
      key: 'buildsPerMonth', label: 'Reconstructions a month',
      stated: plan.allowances.buildsPerMonth, enforced: num(org.build_month_cap), matches: false,
    },
    {
      key: 'aiMonthCapGbp', label: 'Monthly AI ceiling',
      stated: plan.allowances.aiMonthCapGbp, enforced: num(org.ai_month_cap_gbp), matches: false,
    },
    {
      key: 'aiTurnsPerSession', label: 'Questions per visitor session',
      stated: plan.allowances.aiTurnsPerSession, enforced: num(org.ai_turns_per_session), matches: false,
    },
  ];
  return rows.map((r) => ({ ...r, matches: r.enforced !== null && r.enforced === r.stated }));
}
