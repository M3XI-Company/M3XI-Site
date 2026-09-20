/**
 * Formatting an operator can act on.
 *
 * Two rules run through all of it. Money is never rounded in a direction that
 * flatters us: spend rounds UP to the penny, so a bill is never understated in
 * the console and then larger on the invoice. And a number that is not known
 * is rendered as an em dash, never as 0, because "no data" and "zero" lead to
 * different decisions.
 */

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const GBP_PRECISE = new Intl.NumberFormat('en-GB', {
  style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 4,
});
const INT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** The em dash the whole console uses for "not known". */
export const UNKNOWN = '—';

/**
 * USD to GBP, matching `wv_spend_allowed` in
 * supabase/migrations/20260919170500_world_viewer_rls.sql, which blocks an AI
 * turn when `spent_usd * 0.79 >= ai_month_cap_gbp`.
 *
 * It is a fixed rate, not a live one, and it is duplicated here on purpose:
 * if the console converted at a different rate from the function that enforces
 * the cap, an operator would watch a bar at 94% and be cut off anyway. When
 * the migration changes, change this and the test that pins it.
 */
export const USD_TO_GBP = 0.79;

export function usdToGbp(usd: number): number {
  return usd * USD_TO_GBP;
}

export function money(gbp: number | null | undefined): string {
  if (gbp === null || gbp === undefined || !Number.isFinite(gbp)) return UNKNOWN;
  return GBP.format(gbp);
}

/**
 * Spend, rounded up to the penny. A 0.3 p accrual shows as £0.01, not £0.00,
 * because "free so far" is the one wrong answer here.
 */
export function spend(gbp: number | null | undefined): string {
  if (gbp === null || gbp === undefined || !Number.isFinite(gbp)) return UNKNOWN;
  if (gbp === 0) return GBP.format(0);
  const pence = Math.ceil(gbp * 100 - 1e-9);
  return GBP.format(pence / 100);
}

/** Unit costs are sub-penny, so they get their own formatter. */
export function unitCost(gbp: number | null | undefined): string {
  if (gbp === null || gbp === undefined || !Number.isFinite(gbp)) return UNKNOWN;
  return GBP_PRECISE.format(gbp);
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  return INT.format(n);
}

export function percent(fraction: number | null | undefined, dp = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return UNKNOWN;
  return `${(fraction * 100).toFixed(dp)}%`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n < 1000) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** Durations an operator reads in seconds, minutes and hours — never "3600 s". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

export function gpuSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return UNKNOWN;
  return duration(s * 1000);
}

export function dateTime(iso: string | null | undefined, locale = 'en-GB'): string {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleString(locale, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function dateOnly(iso: string | null | undefined, locale = 'en-GB'): string {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "4 days ago" / "in 2 hours". Used beside, never instead of, the timestamp. */
export function relative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  const deltaS = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(deltaS);
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  if (abs < 60) return rtf.format(deltaS, 'second');
  if (abs < 3600) return rtf.format(Math.round(deltaS / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(deltaS / 3600), 'hour');
  if (abs < 2592000) return rtf.format(Math.round(deltaS / 86400), 'day');
  return rtf.format(Math.round(deltaS / 2592000), 'month');
}

/**
 * Percentages that add up.
 *
 * Rounding each share independently produces a column that sums to 99% or
 * 101%, and an operator who notices that stops trusting the whole page. The
 * largest-remainder method gives whole percentages whose total is exactly 100
 * (or exactly 0 when every input is 0).
 */
export function wholePercentShares(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  if (total <= 0) return values.map(() => 0);

  const exact = values.map((v) => ((Number.isFinite(v) && v > 0 ? v : 0) / total) * 100);
  const floors = exact.map((v) => Math.floor(v));
  let remaining = 100 - floors.reduce((a, b) => a + b, 0);

  // Hand the leftover points to the largest fractional parts, ties to the
  // larger raw value so the order is deterministic across runs.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v), raw: exact[i] ?? 0 }))
    .sort((a, b) => (b.frac - a.frac) || (b.raw - a.raw) || (a.i - b.i));

  const out = [...floors];
  let k = 0;
  while (remaining > 0 && order.length > 0) {
    const slot = order[k % order.length]!;
    out[slot.i] = (out[slot.i] ?? 0) + 1;
    remaining -= 1;
    k += 1;
  }
  return out;
}

/** Title-cases a snake_case or kebab-case identifier for display. */
export function humanise(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
