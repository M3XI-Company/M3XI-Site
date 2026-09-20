/**
 * Plans and billing.
 *
 * Prices are numbers, on the page, without an email address in between. No
 * "enquire", no "contact sales", no "custom pricing" — that pattern exists to
 * find out how much an agency can pay before quoting them, and this product
 * does not do it.
 *
 * The metering of AI conversation is explained rather than buried, because an
 * unmetered agent on a popular listing is the single line item that can outrun
 * the subscription, and a customer who does not know that will be surprised by
 * a cap instead of managing one.
 */

import {
  AI_METERING_NOTE, ANNUAL_PLAN_AVAILABLE, BILLING_NOTES, PLANS, can, compareAllowances, el,
  money, note, pill, table, type AllowanceComparison, type Plan,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { pageFrame, section } from '../shell.js';

export async function renderPlans(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Plans',
    lede: 'What it costs. Prices are per organisation, in pounds, excluding VAT.',
  });

  const cards = el('div', { class: 'c-grid', style: 'align-items:start' });
  for (const plan of PLANS) cards.appendChild(planCard(plan));

  frame.body.append(
    section('Prices', undefined, cards),

    section('AI conversation is metered', undefined,
      note('warn', 'Read this before you turn the viewer chat on',
        AI_METERING_NOTE,
        el('p', {},
          'Your organisation’s current ceilings are ',
          el('b', {}, `${ctx.membership.org.build_month_cap ?? 'no'} builds a month`),
          ', ',
          el('b', {}, money(Number(ctx.membership.org.ai_month_cap_gbp ?? 0))),
          ' of AI a month, and ',
          el('b', {}, `${ctx.membership.org.ai_turns_per_session ?? 'unlimited'} questions per visitor session`),
          '.'),
      ),
    ),

    section('What your account is actually set to',
      'The plan states an allowance; the database enforces whatever is on your organisation’s row. If the two ever differ, the enforced value wins and it is shown here.',
      allowanceTable(ctx),
    ),

    section('Billing', undefined,
      el('ul', { style: 'padding-left:20px;color:var(--ink-dim);max-width:74ch' },
        ...BILLING_NOTES.map((line) => el('li', {}, line))),
      ANNUAL_PLAN_AVAILABLE ? null : el('p', { class: 'c-hint' }, 'There is no annual plan and no annual discount. Monthly is the only option.'),
      can(ctx.role, 'billing.manage')
        ? note('info', 'Changing plan',
          'Plan changes need a billing endpoint that does not exist in this deployment yet. Nothing on this page can take a payment, and it does not pretend to.')
        : note('info', 'Your role cannot change the plan',
          `A ${ctx.role} can read this page. Changing the plan needs an admin or owner.`),
    ),
  );

  return frame.root;
}

function planCard(plan: Plan): HTMLElement {
  return el('div', { class: 'c-card' },
    el('div', { style: 'display:flex;align-items:baseline;gap:8px' },
      el('h3', { style: 'font-size:15px;margin:0' }, plan.name),
      plan.period === 'one-off' ? pill('one-off', 'muted') : null),
    el('div', { class: 'c-stat', style: 'margin:6px 0 2px' },
      money(plan.priceGbp),
      el('span', { style: 'font-size:13px;font-weight:400;color:var(--ink-dim)' },
        plan.period === 'month' ? ' / month' : ' once')),
    el('p', { class: 'c-stat-sub', style: 'margin-bottom:10px' }, plan.summary),
    el('dl', { class: 'c-facts', style: 'margin-bottom:10px' },
      el('dt', {}, 'Reconstructions'), el('dd', {}, `${plan.allowances.buildsPerMonth} a month`),
      el('dt', {}, 'AI ceiling'), el('dd', {}, `${money(plan.allowances.aiMonthCapGbp)} a month`),
      el('dt', {}, 'Questions per session'), el('dd', {}, String(plan.allowances.aiTurnsPerSession)),
    ),
    el('ul', { style: 'padding-left:18px;margin:0;color:var(--ink-dim);font-size:13px' },
      ...plan.includes.map((line) => el('li', {}, line))),
    plan.notIncluded && plan.notIncluded.length > 0
      ? el('div', { style: 'margin-top:8px' },
        el('b', { style: 'font-size:12px' }, 'Not included'),
        el('ul', { style: 'padding-left:18px;margin:2px 0 0;color:var(--ink-faint);font-size:12px' },
          ...plan.notIncluded.map((line) => el('li', {}, line))))
      : null,
  );
}

function allowanceTable(ctx: PageContext): HTMLElement {
  // The comparison is made against Standard, which is the plan whose stated
  // allowances match the schema defaults on `wv_org`.
  const standard = PLANS.find((p) => p.id === 'standard')!;
  const rows = compareAllowances(standard, ctx.membership.org);

  return table<AllowanceComparison>({
    caption: 'Stated on the Standard plan, versus enforced on this organisation',
    columns: [
      { key: 'label', header: 'Allowance', render: (r) => r.label },
      {
        key: 'stated', header: 'Stated', numeric: true,
        render: (r) => (r.key === 'aiMonthCapGbp' ? money(r.stated) : String(r.stated)),
      },
      {
        key: 'enforced', header: 'Enforced here', numeric: true,
        render: (r) => (r.enforced === null ? 'not set'
          : r.key === 'aiMonthCapGbp' ? money(r.enforced) : String(r.enforced)),
      },
      {
        key: 'match', header: 'Agrees',
        render: (r) => el('span', { class: `c-pill c-pill--${r.matches ? 'ok' : 'warn'}` },
          r.matches ? 'yes' : 'differs'),
      },
    ],
    rows,
    rowKey: (r) => r.key,
  });
}
