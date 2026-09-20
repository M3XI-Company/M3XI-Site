/**
 * Usage and spend.
 *
 * `wv_spend_allowed` refuses a build or an AI turn the moment usage reaches the
 * cap, with no grace and no warning of its own. This page is the warning.
 * Nobody should discover a cap by hitting it, so the ceiling is drawn, the
 * distance to it is stated in the unit that matters, and "at the cap" is
 * phrased in the past tense because by then it has already happened.
 */

import {
  capSentence, el, gpuSeconds as fmtGpu, meter, money, note, percent, spend, summariseSpend, table,
  type PropertySpend, type SpendSummary,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame, section } from '../shell.js';

export async function renderUsage(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Usage and spend',
    lede: 'This calendar month, against the ceilings your organisation is actually enforced at.',
  });
  frame.body.appendChild(loading('this month’s usage'));

  try {
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [turns, jobs, worldToProperty] = await Promise.all([
      ctx.api.listAiTurns(since),
      ctx.api.listJobsForOrg(since),
      ctx.api.worldPropertyMap(),
    ]);

    // Labels for the per-property table. Spend can land on any property in the
    // portfolio, including an archived one, so this pages through the whole
    // list rather than naming the first page and showing raw ids for the rest.
    // Bounded at 40 pages so a pathological account cannot hang the page.
    const labels: Record<string, string> = {};
    for (let page = 1; page <= 40; page += 1) {
      const result = await ctx.api.listProperties({
        search: '', status: 'any', sort: 'created_at', ascending: false,
        page, pageSize: 100, includeArchived: true,
      });
      for (const row of result.rows) labels[row.id] = row.label;
      if (page * 100 >= result.total || result.rows.length === 0) break;
    }

    const summary = summariseSpend({
      caps: ctx.membership.org,
      aiTurns: turns,
      jobs,
      worldToProperty,
      propertyLabels: labels,
      now,
    });

    frame.body.replaceChildren(renderSpend(summary, ctx));
  } catch (err) {
    frame.body.replaceChildren(errorPanel(err));
  }
  return frame.root;
}

function renderSpend(summary: SpendSummary, ctx: PageContext): HTMLElement {
  const blocked = summary.ai.blocked || summary.builds.blocked;

  return el('div', {},
    blocked
      ? note('bad', 'Something is already being refused',
        [summary.builds.blocked ? 'New builds are being refused: this organisation has used its monthly build allowance.' : '',
          summary.ai.blocked ? 'Viewer conversations are being refused: this month’s AI ceiling has been reached. The walkthroughs still work; only the questions have stopped.' : '',
        ].filter(Boolean).join(' '))
      : null,

    section('Against the caps',
      'Both ceilings are checked before work starts, never after. At the cap means the next request is already refused.',
      meter({
        label: 'Reconstructions this month',
        valueText: summary.builds.cap === null
          ? `${summary.builds.used} (no cap set)`
          : `${summary.builds.used} of ${summary.builds.cap}`,
        ratio: summary.builds.ratio,
        state: summary.builds.state,
        caption: capSentence('builds', summary.builds),
        now: summary.builds.used,
        max: summary.builds.cap ?? summary.builds.used,
      }),
      meter({
        label: 'AI conversation this month',
        valueText: summary.ai.cap === null
          ? `${spend(summary.aiGbp)} (no cap set)`
          : `${spend(summary.aiGbp)} of ${money(summary.ai.cap)}`,
        ratio: summary.ai.ratio,
        state: summary.ai.state,
        caption: capSentence('ai', summary.ai),
        now: Number(summary.aiGbp.toFixed(2)),
        max: summary.ai.cap ?? 1,
      }),
      el('p', { class: 'c-hint' },
        `${summary.aiTurnCount} questions answered this month. `
        + (summary.turnsPerSession === null
          ? 'No per-session question limit is set, so one visitor can ask without bound.'
          : `Each visitor session may ask up to ${summary.turnsPerSession} questions.`)),
    ),

    section('This month', undefined,
      el('div', { class: 'c-grid' },
        el('div', { class: 'c-card' },
          el('h3', {}, 'Total'),
          el('div', { class: 'c-stat' }, spend(summary.totalGbp)),
          el('p', { class: 'c-stat-sub' }, 'Builds and AI together, excluding your subscription.')),
        el('div', { class: 'c-card' },
          el('h3', {}, 'Builds'),
          el('div', { class: 'c-stat' }, spend(summary.buildGbp)),
          el('p', { class: 'c-stat-sub' }, `${fmtGpu(summary.gpuSeconds)} of GPU time`)),
        el('div', { class: 'c-card' },
          el('h3', {}, 'AI conversation'),
          el('div', { class: 'c-stat' }, spend(summary.aiGbp)),
          el('p', { class: 'c-stat-sub' }, `${summary.aiTurnCount} questions`)),
        el('div', { class: 'c-card' },
          el('h3', {}, 'Mean per property'),
          el('div', { class: 'c-stat' }, spend(summary.meanCostPerPropertyGbp)),
          el('p', { class: 'c-stat-sub' }, 'Across properties that cost anything this month.')),
      ),
    ),

    section('By property',
      'Where the money went. A property that is quiet costs nothing; a popular listing with a chatty viewer is the line item to watch.',
      table<PropertySpend>({
        caption: `${summary.perProperty.length} properties with activity this month`,
        columns: [
          {
            key: 'label', header: 'Property',
            render: (r) => el('a', {
              href: `#/property/${r.propertyId}`,
              onclick: (e: Event) => { e.preventDefault(); ctx.navigate(`#/property/${r.propertyId}`); },
            }, r.label),
          },
          { key: 'builds', header: 'Builds', numeric: true, render: (r) => String(r.builds) },
          { key: 'gpu', header: 'GPU time', numeric: true, render: (r) => fmtGpu(r.gpuSeconds) },
          { key: 'buildGbp', header: 'Build cost', numeric: true, render: (r) => spend(r.buildGbp) },
          { key: 'turns', header: 'Questions', numeric: true, render: (r) => String(r.aiTurns) },
          { key: 'aiGbp', header: 'AI cost', numeric: true, render: (r) => spend(r.aiGbp) },
          { key: 'total', header: 'Total', numeric: true, render: (r) => el('b', {}, spend(r.totalGbp)) },
          {
            key: 'share', header: 'Share',
            render: (r) => percent(summary.totalGbp === 0 ? 0 : r.totalGbp / summary.totalGbp, 0),
          },
        ],
        rows: summary.perProperty,
        rowKey: (r) => r.propertyId,
        empty: 'Nothing has cost anything this month.',
      }),
    ),

    section('How these numbers are worked out', undefined,
      note('info', null,
        `AI cost is charged in US dollars and converted at ${summary.rate} GBP per USD — the same fixed rate the database uses when it decides whether to refuse a turn, so this bar and that decision never disagree. `
        + 'Build cost is every stage of every build queued this month, while the build cap counts reconstructions only. Money is rounded up to the penny, never down.'),
    ),
  );
}
