/**
 * The portfolio.
 *
 * A table, not a card grid. An operator with 400 listings scans this column by
 * column looking for the one that is stuck, and a grid of thumbnails makes
 * that impossible. Density is the feature.
 *
 * Everything that narrows the list is a server-side query: search, status
 * filter, sort and page all go back to PostgREST with `count=exact`, so the
 * browser never holds more than one page. The filters live in the URL hash so
 * "the four failed builds in SW19" is a link an operator can send to a
 * colleague.
 */

import {
  DEFAULT_QUERY, PAGE_SIZES, announce, button, confirm, dateOnly, el, emptyState, findAction,
  fromQueryString, note, pageCount, portfolioActions, rangeLabel, table, toQueryString, toast,
  verdictPill, worldStatusPill, type Page, type PortfolioQuery, type PropertyRow,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame } from '../shell.js';

export async function renderPortfolio(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Portfolio',
    lede: 'Every property in this organisation, and the state of its most recent world version.',
  });

  let query: PortfolioQuery = { ...DEFAULT_QUERY, ...fromQueryString(ctx.route.query) };
  const selected = new Set<string>();
  const results = el('div', {});
  const controls = el('div', {});
  frame.body.append(controls, results);

  const actionBar = el('div', { class: 'c-head-actions' });
  frame.actions.appendChild(actionBar);

  const setQuery = (patch: Partial<PortfolioQuery>, resetPage = true): void => {
    query = { ...query, ...patch, ...(resetPage ? { page: 1 } : {}) };
    const qs = toQueryString(query);
    // Replace rather than push: a filter is not a place you want to go Back to
    // eleven times.
    window.history.replaceState(null, '', `#/portfolio${qs ? `?${qs}` : ''}`);
    void load();
  };

  function renderControls(): void {
    const search = el('input', {
      class: 'c-input',
      type: 'search',
      value: query.search,
      placeholder: 'Address, reference or postcode',
      'aria-label': 'Search properties',
      style: 'min-width:260px',
      onchange: (e: Event) => setQuery({ search: (e.target as HTMLInputElement).value }),
    });

    const status = el('select', {
      class: 'c-select', 'aria-label': 'Filter by status', style: 'min-width:150px',
      onchange: (e: Event) => setQuery({ status: (e.target as HTMLSelectElement).value as PortfolioQuery['status'] }),
    });
    for (const value of ['any', 'draft', 'capturing', 'processing', 'review', 'published', 'failed', 'archived'] as const) {
      status.appendChild(el('option', { value, selected: query.status === value },
        value === 'any' ? 'Any status' : value.charAt(0).toUpperCase() + value.slice(1)));
    }
    status.value = query.status;

    const size = el('select', {
      class: 'c-select', 'aria-label': 'Rows per page', style: 'min-width:110px',
      onchange: (e: Event) => setQuery({ pageSize: Number((e.target as HTMLSelectElement).value) }),
    });
    for (const value of PAGE_SIZES) {
      size.appendChild(el('option', { value: String(value), selected: query.pageSize === value }, `${value} per page`));
    }
    size.value = String(query.pageSize);

    const archived = el('label', { class: 'c-check' },
      el('input', {
        type: 'checkbox', checked: query.includeArchived,
        onchange: (e: Event) => setQuery({ includeArchived: (e.target as HTMLInputElement).checked }),
      }),
      'Include archived',
    );

    controls.replaceChildren(el('div', {
      class: 'c-inline',
      style: 'margin-bottom:14px',
      role: 'search',
    }, search, status, size, archived));
  }

  function renderActions(): void {
    const actions = portfolioActions({
      role: ctx.role,
      selectedCount: selected.size,
      buildCapReached: false,
    });

    const add = findAction(actions, 'property.create');
    const archive = findAction(actions, 'property.archive');

    actionBar.replaceChildren(
      el('span', { class: 'c-hint' }, selected.size > 0 ? `${selected.size} selected` : ''),
      button({
        label: archive.label,
        emphasis: 'danger',
        disabled: !archive.enabled,
        reason: archive.reason,
        onClick: () => void archiveSelected(),
      }),
      button({
        label: add.label,
        emphasis: 'primary',
        disabled: !add.enabled,
        reason: add.reason,
        onClick: () => void createProperty(),
      }),
    );
  }

  async function archiveSelected(): Promise<void> {
    const ids = [...selected];
    const ok = await confirm({
      title: `Archive ${ids.length} ${ids.length === 1 ? 'property' : 'properties'}?`,
      body: [
        'Archived properties disappear from the portfolio but nothing is deleted: every world version, every measurement and every lead is kept.',
        'A published world stays live until it is unpublished. Archiving does not take a tour off the internet.',
      ],
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.api.archiveProperties(ids);
      selected.clear();
      toast(`${ids.length} archived.`, 'ok');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  async function createProperty(): Promise<void> {
    const label = window.prompt('Address or name of the property');
    if (!label || label.trim().length === 0) return;
    const ref = window.prompt('Your own listing reference (optional)') ?? undefined;
    try {
      const created = await ctx.api.createProperty({ label: label.trim(), ...(ref ? { ref: ref.trim() } : {}) });
      toast('Property created.', 'ok');
      ctx.navigate(`#/property/${created.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  function renderTable(page: Page<PropertyRow>): void {
    const last = pageCount(page.total, page.pageSize);

    const node = table<PropertyRow>({
      caption: `${rangeLabel(page)}${query.search ? ` matching “${query.search}”` : ''}${query.status !== 'any' ? `, status ${query.status}` : ''}`,
      columns: [
        {
          key: 'label', header: 'Property', sortable: true,
          render: (row) => el('a', {
            href: `#/property/${row.id}`,
            onclick: (e: Event) => { e.preventDefault(); ctx.navigate(`#/property/${row.id}`); },
          }, row.label),
        },
        { key: 'ref', header: 'Reference', sortable: true, render: (row) => el('span', { class: 'c-mono' }, row.ref ?? '—') },
        { key: 'postcode', header: 'Postcode', sortable: true, render: (row) => row.postcode ?? '—' },
        {
          key: 'status', header: 'Latest version',
          render: (row) => {
            const latest = row.worlds[0];
            if (!latest) return el('span', { class: 'c-hint' }, 'No version yet');
            return el('span', { style: 'display:inline-flex;gap:6px;align-items:center' },
              worldStatusPill(latest.status),
              el('span', { class: 'c-hint' }, `v${latest.version}`));
          },
        },
        {
          key: 'quality', header: 'Quality',
          render: (row) => {
            const latest = row.worlds[0];
            if (!latest) return '—';
            return latest.quality_score === null
              ? verdictPill(null)
              : el('span', { class: 'c-num' }, latest.quality_score.toFixed(3));
          },
        },
        {
          key: 'live', header: 'Live',
          render: (row) => {
            const live = row.worlds.find((w) => w.status === 'published');
            if (!live) return el('span', { class: 'c-hint' }, 'Not live');
            return el('span', { style: 'display:inline-flex;gap:6px;align-items:center' },
              el('span', { class: 'c-hint' }, `v${live.version}`),
              live.slug ? el('span', { class: 'c-mono' }, `/${live.slug}`) : null);
          },
        },
        { key: 'versions', header: 'Versions', numeric: true, render: (row) => String(row.worlds.length) },
        { key: 'created_at', header: 'Added', sortable: true, numeric: true, render: (row) => dateOnly(row.created_at) },
      ],
      rows: page.rows,
      rowKey: (row) => row.id,
      sortKey: query.sort,
      ascending: query.ascending,
      onSort: (key) => {
        if (!['created_at', 'label', 'ref', 'postcode'].includes(key)) return;
        const sort = key as PortfolioQuery['sort'];
        setQuery({ sort, ascending: query.sort === sort ? !query.ascending : true });
      },
      selectable: {
        selected,
        label: (row) => row.label,
        onToggle: (key, on) => {
          if (on) selected.add(key); else selected.delete(key);
          renderActions();
        },
        onToggleAll: (on) => {
          if (on) for (const row of page.rows) selected.add(row.id);
          else selected.clear();
          renderActions();
          renderTable(page);
        },
      },
      empty: emptyState(
        query.search || query.status !== 'any' ? 'Nothing matches those filters' : 'No properties yet',
        query.search || query.status !== 'any'
          ? 'Clear the search or the status filter to see the rest of the portfolio.'
          : 'Add the first property, then start a build from an uploaded capture.',
      ),
    });

    const pager = el('div', { class: 'c-pager' },
      el('span', {}, rangeLabel(page)),
      el('span', { class: 'c-spacer' }),
      button({
        label: 'Previous', small: true, disabled: page.page <= 1,
        reason: 'This is the first page.',
        onClick: () => setQuery({ page: page.page - 1 }, false),
      }),
      el('span', {}, `Page ${page.page} of ${last}`),
      button({
        label: 'Next', small: true, disabled: page.page >= last,
        reason: 'This is the last page.',
        onClick: () => setQuery({ page: page.page + 1 }, false),
      }),
    );

    results.replaceChildren(node, pager);
  }

  async function load(): Promise<void> {
    results.replaceChildren(loading('the portfolio'));
    renderControls();
    renderActions();
    try {
      const page = await ctx.api.listProperties(query);
      renderTable(page);
      announce(`${rangeLabel(page)}.`);
    } catch (err) {
      results.replaceChildren(errorPanel(err));
    }
  }

  frame.body.insertBefore(
    note('info', null,
      'Search, filters and paging are answered by the database, not the browser, so this page behaves the same at four properties and at four hundred.'),
    controls,
  );

  await load();
  return frame.root;
}
