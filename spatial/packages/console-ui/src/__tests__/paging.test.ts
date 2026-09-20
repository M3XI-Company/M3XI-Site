/**
 * Portfolio paging. The behaviour that matters at 400 listings is that a
 * filter change never leaves the operator on an empty page seven.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY, clampPage, fromQueryString, pageCount, rangeFor, rangeLabel, toQueryString, withFilter,
} from '../logic/paging.js';
import { dateOnly, bytes, duration, gpuSeconds, humanise, percent, relative } from '../logic/format.js';

describe('paging arithmetic', () => {
  it('computes the last page, with a floor of one', () => {
    expect(pageCount(412, 50)).toBe(9);
    expect(pageCount(400, 50)).toBe(8);
    expect(pageCount(0, 50)).toBe(1);
  });

  it('turns a page into a PostgREST range', () => {
    expect(rangeFor({ ...DEFAULT_QUERY, page: 1, pageSize: 50 })).toEqual({ from: 0, to: 49 });
    expect(rangeFor({ ...DEFAULT_QUERY, page: 3, pageSize: 50 })).toEqual({ from: 100, to: 149 });
  });

  it('pulls an out-of-range page back to the last real one', () => {
    expect(clampPage({ ...DEFAULT_QUERY, page: 99 }, 412).page).toBe(9);
    expect(clampPage({ ...DEFAULT_QUERY, page: 0 }, 412).page).toBe(1);
    expect(clampPage({ ...DEFAULT_QUERY, page: 2 }, 412).page).toBe(2);
  });

  it('labels the visible range against the server total', () => {
    expect(rangeLabel({ rows: new Array(50).fill(0), total: 412, page: 2, pageSize: 50 }))
      .toBe('51–100 of 412');
    expect(rangeLabel({ rows: new Array(12).fill(0), total: 412, page: 9, pageSize: 50 }))
      .toBe('401–412 of 412');
    expect(rangeLabel({ rows: [], total: 0, page: 1, pageSize: 50 })).toBe('No properties');
  });
});

describe('filter changes', () => {
  it('returns to page one on any change but the page itself', () => {
    const at7 = { ...DEFAULT_QUERY, page: 7 };
    expect(withFilter(at7, { search: 'ash' }).page).toBe(1);
    expect(withFilter(at7, { status: 'published' }).page).toBe(1);
    expect(withFilter(at7, { pageSize: 100 }).page).toBe(1);
    expect(withFilter(at7, { page: 8 }).page).toBe(8);
  });
});

describe('the query survives the URL', () => {
  it('round-trips', () => {
    const query = {
      search: 'ash grove', status: 'published' as const, sort: 'label' as const,
      ascending: true, page: 4, pageSize: 100, includeArchived: true,
    };
    expect(fromQueryString(toQueryString(query))).toEqual(query);
  });

  it('omits defaults so a plain link stays plain', () => {
    expect(toQueryString(DEFAULT_QUERY)).toBe('');
  });

  it('ignores junk rather than trusting it', () => {
    const q = fromQueryString('status=nonsense&sort=drop+table&size=7&page=-2');
    expect(q.status).toBe('any');
    expect(q.sort).toBe('created_at');
    expect(q.pageSize).toBe(50);
    expect(q.page).toBe(1);
  });
});

describe('formatting', () => {
  it('scales bytes to a unit an operator reads', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(18_220_100)).toBe('18 MB');
    expect(bytes(1_500)).toBe('1.5 kB');
    expect(bytes(null)).toBe('—');
  });

  it('reads durations in seconds, minutes and hours', () => {
    expect(duration(45_000)).toBe('45s');
    expect(duration(90_000)).toBe('1m 30s');
    expect(duration(3_600_000)).toBe('1h');
    expect(duration(5_460_000)).toBe('1h 31m');
    expect(gpuSeconds(900)).toBe('15m');
  });

  it('formats percentages and dates, and dashes what it does not know', () => {
    expect(percent(0.615, 1)).toBe('61.5%');
    expect(percent(null)).toBe('—');
    // Intl's en-GB short month for September is "Sept", not "Sep".
    expect(dateOnly('2026-09-19T12:00:00Z')).toMatch(/19 Sept? 2026/);
    expect(dateOnly('not a date')).toBe('—');
    expect(relative('2026-09-19T11:00:00Z', new Date('2026-09-19T12:00:00Z'))).toMatch(/hour/);
  });

  it('humanises a stage or check key', () => {
    expect(humanise('unobserved_volume_fraction')).toBe('Unobserved volume fraction');
    expect(humanise('blur-reject')).toBe('Blur reject');
  });
});
