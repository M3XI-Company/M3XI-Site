/**
 * One world version: the workspace an operator lives in between a capture and
 * a published tour.
 *
 * Tabs rather than separate routes, because build, quality, review and share
 * are one task with four views of it and an operator moves between them
 * constantly. The tab state is in the URL so a colleague can be sent straight
 * to the failing build.
 */

import {
  aggregate, bytes as fmtBytes, dateTime, el, facts, note, parseQualityRow, percent, table,
  verdictPill, worldStatusPill, type RoomStat, type WorldDetail,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame, section } from '../shell.js';
import { renderBuild, type BuildTab } from './worldBuild.js';
import { renderQuality } from './worldQuality.js';
import { renderReview, type ReviewTab } from './worldReview.js';
import { renderShare } from './worldShare.js';
import { renderExportsFor } from './exports.js';

const TABS = ['build', 'quality', 'review', 'share', 'analytics', 'export'] as const;
type TabId = (typeof TABS)[number];

const TAB_LABELS: Readonly<Record<TabId, string>> = {
  build: 'Build',
  quality: 'Quality gate',
  review: 'Review and publish',
  share: 'Share',
  analytics: 'Analytics',
  export: 'Permanence bundle',
};

export async function renderWorld(ctx: PageContext): Promise<HTMLElement> {
  const worldId = ctx.route.params[0];
  const requested = ctx.route.params[1];
  const active: TabId = (TABS as readonly string[]).includes(requested ?? '') ? (requested as TabId) : 'build';

  const frame = pageFrame({
    title: 'World version',
    crumbs: [{ label: 'Portfolio', href: '#/portfolio' }, { label: 'Property' }, { label: 'Version' }],
  });
  frame.body.appendChild(loading('this version'));

  if (!worldId) {
    frame.body.replaceChildren(note('bad', 'No world', 'That link is missing a world id.'));
    return frame.root;
  }

  let detail: WorldDetail;
  let propertyLabel = 'Property';
  try {
    detail = await ctx.api.getWorld(worldId);
    const property = await ctx.api.getProperty(detail.world.property_id);
    propertyLabel = property.label;
  } catch (err) {
    frame.body.replaceChildren(errorPanel(err));
    return frame.root;
  }

  frame.heading.textContent = `${propertyLabel} — v${detail.world.version}`;
  const crumbs = frame.root.querySelector('.c-crumbs');
  if (crumbs) {
    crumbs.replaceChildren();
    const portfolio = el('a', {
      href: '#/portfolio',
      onclick: (e: Event) => { e.preventDefault(); ctx.navigate('#/portfolio'); },
    }, 'Portfolio');
    const property = el('a', {
      href: `#/property/${detail.world.property_id}`,
      onclick: (e: Event) => { e.preventDefault(); ctx.navigate(`#/property/${detail.world.property_id}`); },
    }, propertyLabel);
    crumbs.append(portfolio, document.createTextNode(' / '), property, document.createTextNode(` / v${detail.world.version}`));
  }

  const parsed = parseQualityRow(detail.quality as never);

  const badges: HTMLElement[] = [
    worldStatusPill(detail.world.status),
    verdictPill(parsed.report?.verdict ?? null),
  ];
  if (detail.world.published_at) {
    badges.push(el('span', { class: 'c-hint' }, `Live since ${dateTime(detail.world.published_at)}`));
  }
  frame.actions.replaceChildren(...badges);

  const header = section('At a glance', undefined,
    facts([
      ['Version', `v${detail.world.version}`],
      ['Status', worldStatusPill(detail.world.status)],
      ['Created', dateTime(detail.world.created_at)],
      ['Published', dateTime(detail.world.published_at)],
      ['Public link', detail.world.slug ? el('span', { class: 'c-mono' }, `/${detail.world.slug}`) : '—'],
      ['Rooms', String(detail.roomCount)],
      ['Assets', detail.assetCount === 0 ? 'none yet' : `${detail.assetCount}, ${fmtBytes(detail.assetBytes)}`],
      ['Scale', detail.world.scale_source ?? '—'],
      ['Scale agreement', detail.world.scale_agreement === null || detail.world.scale_agreement === undefined
        ? '—' : percent(Number(detail.world.scale_agreement), 1)],
    ]),
  );

  const tabList = el('div', { class: 'c-tabs', role: 'tablist', 'aria-label': 'World sections' });
  const panel = el('div', { role: 'tabpanel', tabindex: '0', id: 'world-panel' });
  let live: BuildTab | ReviewTab | null = null;

  const show = (tab: TabId, moveFocus: boolean): void => {
    live?.destroy();
    live = null;
    for (const button of Array.from(tabList.querySelectorAll('button'))) {
      const selected = button.dataset['tab'] === tab;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
      if (selected && moveFocus) button.focus();
    }
    panel.setAttribute('aria-labelledby', `tab-${tab}`);
    window.history.replaceState(null, '', `#/world/${worldId}/${tab}`);

    switch (tab) {
      case 'build': {
        const built = renderBuild(ctx, detail, () => ctx.reload());
        live = built;
        panel.replaceChildren(built.root);
        break;
      }
      case 'quality':
        panel.replaceChildren(renderQuality(ctx, detail));
        break;
      case 'review': {
        const review = renderReview(ctx, detail, () => ctx.reload());
        live = review;
        panel.replaceChildren(review.root);
        break;
      }
      case 'share':
        panel.replaceChildren(renderShare(ctx, detail, propertyLabel));
        break;
      case 'analytics':
        panel.replaceChildren(loading('this world’s analytics'));
        void renderWorldAnalytics(ctx, detail).then((node) => panel.replaceChildren(node));
        break;
      case 'export':
        panel.replaceChildren(loading('the bundle'));
        void renderExportsFor(ctx, detail).then((node) => panel.replaceChildren(node));
        break;
    }
  };

  TABS.forEach((tab, i) => {
    const button = el('button', {
      class: 'c-tab', role: 'tab', type: 'button', id: `tab-${tab}`,
      'aria-controls': 'world-panel',
      onclick: () => show(tab, false),
      onkeydown: (e: Event) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'ArrowRight') { e.preventDefault(); show(TABS[(i + 1) % TABS.length]!, true); }
        else if (key === 'ArrowLeft') { e.preventDefault(); show(TABS[(i - 1 + TABS.length) % TABS.length]!, true); }
        else if (key === 'Home') { e.preventDefault(); show(TABS[0]!, true); }
        else if (key === 'End') { e.preventDefault(); show(TABS[TABS.length - 1]!, true); }
      },
    }, TAB_LABELS[tab]);
    button.dataset['tab'] = tab;
    tabList.appendChild(button);
  });

  frame.body.replaceChildren(header, tabList, panel);
  show(active, false);

  // The build tab polls and the review tab holds a WebGL context; both must be
  // torn down when the route changes, not left running behind the next page.
  frame.root.addEventListener('m3xi:teardown', () => live?.destroy());

  return frame.root;
}

async function renderWorldAnalytics(ctx: PageContext, detail: WorldDetail): Promise<HTMLElement> {
  try {
    const [events, rooms] = await Promise.all([
      ctx.api.listEvents({ worldId: detail.world.id }),
      ctx.api.roomNames(detail.world.id),
    ]);
    const summary = aggregate(events, rooms);

    if (summary.sessions === 0) {
      return section('Nobody has walked this version yet',
        'Room-level figures appear as soon as the first visitor arrives.');
    }

    return el('div', {},
      section('This version', undefined,
        el('div', { class: 'c-grid' },
          el('div', { class: 'c-card' }, el('h3', {}, 'Sessions'), el('div', { class: 'c-stat' }, String(summary.sessions))),
          el('div', { class: 'c-card' }, el('h3', {}, 'Median visit'),
            el('div', { class: 'c-stat' }, `${Math.round(summary.medianSessionMs / 1000)}s`)),
          el('div', { class: 'c-card' }, el('h3', {}, 'Leads'),
            el('div', { class: 'c-stat' }, String(summary.funnel.leads)),
            el('p', { class: 'c-stat-sub' }, `${percent(summary.funnel.leadRate, 1)} of sessions`)),
        ),
      ),
      section('Rooms', 'Where visitors actually spent their time in this version.',
        table<RoomStat>({
          caption: `${summary.rooms.length} rooms`,
          columns: [
            { key: 'name', header: 'Room', render: (r) => r.name },
            { key: 'dwell', header: 'Total dwell', numeric: true, render: (r) => `${Math.round(r.dwellMs / 1000)}s` },
            { key: 'share', header: 'Share', numeric: true, render: (r) => `${r.dwellShare}%` },
            { key: 'revisit', header: 'Revisited by', numeric: true, render: (r) => percent(r.revisitRate, 0) },
            { key: 'exits', header: 'Ended here', numeric: true, render: (r) => String(r.exits) },
          ],
          rows: summary.rooms,
          rowKey: (r) => r.roomId,
        }),
      ),
    );
  } catch (err) {
    return errorPanel(err);
  }
}
