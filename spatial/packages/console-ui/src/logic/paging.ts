/**
 * Portfolio query state.
 *
 * An agency with 400 listings must not be worse off than one with 4, which in
 * practice means one rule: the browser never holds the portfolio. Search,
 * filter, sort and page are a query the server answers, `count=exact` gives
 * the total, and the table renders one page. The alternative — fetch
 * everything and filter in JavaScript — is fine at 4 and unusable at 400 on
 * the laptop an estate agent actually has.
 */

export type PortfolioStatus =
  | 'any' | 'draft' | 'capturing' | 'processing' | 'review' | 'published' | 'failed' | 'archived';

export type PortfolioSort = 'created_at' | 'label' | 'ref' | 'postcode';

export interface PortfolioQuery {
  readonly search: string;
  readonly status: PortfolioStatus;
  readonly sort: PortfolioSort;
  readonly ascending: boolean;
  readonly page: number;      // 1-based
  readonly pageSize: number;
  readonly includeArchived: boolean;
}

export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZES: readonly number[] = [25, 50, 100];

export const DEFAULT_QUERY: PortfolioQuery = {
  search: '',
  status: 'any',
  sort: 'created_at',
  ascending: false,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  includeArchived: false,
};

export interface Page<T> {
  readonly rows: readonly T[];
  /** Total matching rows on the server, not the length of `rows`. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function clampPage(query: PortfolioQuery, total: number): PortfolioQuery {
  const last = pageCount(total, query.pageSize);
  if (query.page <= last && query.page >= 1) return query;
  return { ...query, page: Math.min(Math.max(1, query.page), last) };
}

/** PostgREST `Range`-style offsets. Inclusive, as the header is. */
export function rangeFor(query: PortfolioQuery): { from: number; to: number } {
  const from = (Math.max(1, query.page) - 1) * query.pageSize;
  return { from, to: from + query.pageSize - 1 };
}

/** "51–100 of 412". Reads better than a page number on its own. */
export function rangeLabel(page: Page<unknown>): string {
  if (page.total === 0) return 'No properties';
  const from = (page.page - 1) * page.pageSize + 1;
  const to = Math.min(page.total, from + page.rows.length - 1);
  return `${from}–${to} of ${page.total}`;
}

/**
 * Any change other than turning the page returns to page 1. Landing on an
 * empty page 7 after narrowing a search is a bug an operator reads as "no
 * results".
 */
export function withFilter(query: PortfolioQuery, patch: Partial<PortfolioQuery>): PortfolioQuery {
  const next = { ...query, ...patch };
  const onlyPaging = Object.keys(patch).every((k) => k === 'page');
  return onlyPaging ? next : { ...next, page: 1 };
}

/** Serialise into the URL hash so a filtered portfolio can be linked to. */
export function toQueryString(query: PortfolioQuery): string {
  const p = new URLSearchParams();
  if (query.search) p.set('q', query.search);
  if (query.status !== 'any') p.set('status', query.status);
  if (query.sort !== DEFAULT_QUERY.sort) p.set('sort', query.sort);
  if (query.ascending !== DEFAULT_QUERY.ascending) p.set('dir', query.ascending ? 'asc' : 'desc');
  if (query.page !== 1) p.set('page', String(query.page));
  if (query.pageSize !== DEFAULT_PAGE_SIZE) p.set('size', String(query.pageSize));
  if (query.includeArchived) p.set('archived', '1');
  return p.toString();
}

export function fromQueryString(value: string): PortfolioQuery {
  const p = new URLSearchParams(value);
  const statuses: readonly PortfolioStatus[] = [
    'any', 'draft', 'capturing', 'processing', 'review', 'published', 'failed', 'archived',
  ];
  const sorts: readonly PortfolioSort[] = ['created_at', 'label', 'ref', 'postcode'];
  const status = p.get('status');
  const sort = p.get('sort');
  const size = Number(p.get('size'));
  const page = Number(p.get('page'));
  return {
    search: (p.get('q') ?? '').slice(0, 120),
    status: statuses.includes(status as PortfolioStatus) ? (status as PortfolioStatus) : 'any',
    sort: sorts.includes(sort as PortfolioSort) ? (sort as PortfolioSort) : DEFAULT_QUERY.sort,
    ascending: p.get('dir') === 'asc',
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    pageSize: PAGE_SIZES.includes(size) ? size : DEFAULT_PAGE_SIZE,
    includeArchived: p.get('archived') === '1',
  };
}
