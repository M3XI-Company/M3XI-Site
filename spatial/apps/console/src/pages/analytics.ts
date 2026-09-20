/**
 * Viewer analytics.
 *
 * The headline counts are the caption; the room table is the page. "1,204
 * views" changes nothing an agency can act on. "Half of visitors go back to
 * the kitchen and two-thirds of sessions end in the second bedroom" changes
 * the photographs, the description and occasionally the price.
 */

import {
  aggregate, duration, el, inlineBar, note, percent, sparkline, table,
  type AnalyticsSummary, type RoomStat,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame, section } from '../shell.js';

const WINDOWS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

export async function renderAnalytics(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Analytics',
    lede: 'What visitors did inside your published walkthroughs.',
  });

  let days = 30;
  const body = el('div', {});
  const picker = el('select', {
    class: 'c-select', 'aria-label': 'Time range', style: 'min-width:150px',
    onchange: (e: Event) => { days = Number((e.target as HTMLSelectElement).value); void load(); },
  }, ...WINDOWS.map((w) => el('option', { value: String(w.days), selected: w.days === days }, w.label)));
  frame.actions.appendChild(picker);
  frame.body.appendChild(body);

  async function load(): Promise<void> {
    body.replaceChildren(loading('analytics'));
    try {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const events = await ctx.api.listEvents({ since });
      // Room names live per world. The org-wide view merges rooms with the same
      // id across worlds, which is correct here because a room id is unique to
      // a world; names come from the first world that can supply one.
      const worldIds = new Set<string>();
      for (const e of events) {
        const id = (e.session_id ?? '').split('_s')[0];
        if (id) worldIds.add(id);
      }
      const nameMaps = await Promise.all(
        [...worldIds].slice(0, 12).map((id) => ctx.api.roomNames(id).catch(() => ({}))),
      );
      const names: Record<string, string> = {};
      for (const map of nameMaps) Object.assign(names, map);

      const summary = aggregate(events, names);
      body.replaceChildren(renderSummary(summary, days));
    } catch (err) {
      body.replaceChildren(errorPanel(err));
    }
  }

  await load();
  return frame.root;
}

function renderSummary(summary: AnalyticsSummary, days: number): HTMLElement {
  if (summary.sessions === 0) {
    return note('info', 'No sessions in this window',
      'Nobody has opened a published walkthrough in the last '
      + `${days} days, or the viewer is not yet reporting events for this organisation.`);
  }

  const totalDwell = summary.rooms.reduce((s, r) => s + r.dwellMs, 0);
  const mostRevisited = [...summary.rooms].sort((a, b) => b.revisitRate - a.revisitRate)[0];
  const commonExit = [...summary.rooms].sort((a, b) => b.exits - a.exits)[0];

  return el('div', {},
    section('Overall', undefined,
      el('div', { class: 'c-grid' },
        el('div', { class: 'c-card' },
          el('h3', {}, 'Sessions'),
          el('div', { class: 'c-stat' }, String(summary.sessions)),
          el('p', { class: 'c-stat-sub' }, `${summary.completedSessions} ended cleanly`)),
        el('div', { class: 'c-card' },
          el('h3', {}, 'Median visit'),
          el('div', { class: 'c-stat' }, duration(summary.medianSessionMs)),
          el('p', { class: 'c-stat-sub' }, `mean ${duration(summary.meanSessionMs)}`)),
        el('div', { class: 'c-card' },
          el('h3', {}, 'Leads'),
          el('div', { class: 'c-stat' }, String(summary.funnel.leads)),
          el('p', { class: 'c-stat-sub' }, `${percent(summary.funnel.leadRate, 1)} of sessions`)),
        el('div', { class: 'c-card' },
          el('h3', {}, 'Asked a question'),
          el('div', { class: 'c-stat' }, String(summary.funnel.asked)),
          el('p', { class: 'c-stat-sub' }, 'Each one is metered against your AI allowance')),
      ),
      el('div', { style: 'margin-top:14px' },
        sparkline(summary.daily, `Sessions per day over the last ${days} days`),
        el('p', { class: 'c-hint' },
          `Sessions per day, ${summary.daily[0]?.date ?? ''} to ${summary.daily[summary.daily.length - 1]?.date ?? ''}.`)),
    ),

    section('Rooms',
      'Dwell time is the signal worth acting on. The share column is whole percentages of total time and adds up to exactly 100.',
      table<RoomStat>({
        caption: `${summary.rooms.length} rooms, ${duration(totalDwell)} of recorded time`,
        columns: [
          { key: 'name', header: 'Room', render: (r) => r.name },
          { key: 'dwell', header: 'Total time', numeric: true, render: (r) => duration(r.dwellMs) },
          {
            key: 'share', header: 'Share of time',
            render: (r) => inlineBar(r.dwellShare / 100, `${r.dwellShare}%`),
          },
          { key: 'mean', header: 'Per session', numeric: true, render: (r) => duration(r.meanDwellPerSessionMs) },
          { key: 'sessions', header: 'Sessions', numeric: true, render: (r) => String(r.sessions) },
          {
            key: 'revisit', header: 'Went back',
            render: (r) => inlineBar(r.revisitRate, percent(r.revisitRate, 0)),
          },
          { key: 'exits', header: 'Left from here', numeric: true, render: (r) => String(r.exits) },
        ],
        rows: summary.rooms,
        rowKey: (r) => r.roomId,
      }),
      el('p', { class: 'c-hint', style: 'margin-top:8px' },
        mostRevisited
          ? `${mostRevisited.name} is the most revisited room: ${percent(mostRevisited.revisitRate, 0)} of the sessions that entered it came back. `
          : '',
        commonExit ? `Most sessions ended in ${commonExit.name}.` : ''),
    ),

    section('What visitors did',
      'One count per session, not per event, so a visitor who asked four questions counts once.',
      table({
        caption: 'Funnel',
        columns: [
          { key: 'stage', header: 'Stage', render: (r: { stage: string; n: number; of: number }) => r.stage },
          { key: 'n', header: 'Sessions', numeric: true, render: (r) => String(r.n) },
          {
            key: 'share', header: 'Share',
            render: (r) => inlineBar(r.of === 0 ? 0 : r.n / r.of, percent(r.of === 0 ? 0 : r.n / r.of, 0)),
          },
        ],
        rows: [
          { stage: 'Opened the walkthrough', n: summary.funnel.entered, of: summary.sessions },
          { stage: 'Measured something', n: summary.funnel.measured, of: summary.sessions },
          { stage: 'Asked the property a question', n: summary.funnel.asked, of: summary.sessions },
          { stage: 'Left their details', n: summary.funnel.leads, of: summary.sessions },
        ],
        rowKey: (r) => r.stage,
      }),
    ),

    summary.discardedEvents > 0
      ? note('warn', 'Some events could not be counted',
        `${summary.discardedEvents} events had no session or an unreadable timestamp and were left out rather than guessed at.`)
      : null,
  );
}
