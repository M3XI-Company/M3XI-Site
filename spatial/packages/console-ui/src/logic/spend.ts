/**
 * Usage against the caps, shown before anyone hits one.
 *
 * `wv_spend_allowed` refuses an AI turn when
 * `sum(cost_usd) * 0.79 >= ai_month_cap_gbp`, and refuses a build when the
 * count of `reconstruct` jobs queued this calendar month has reached
 * `build_month_cap`. Both are hard stops with no grace, so the console's job
 * is to make the ceiling visible from a distance. Nobody should discover a cap
 * by hitting it.
 *
 * Two details that have to match the server exactly or the bar lies:
 *   - the comparison is `>=`, so "at the cap" already means blocked;
 *   - builds are counted by the `reconstruct` stage, not by world or by job.
 */

import { USD_TO_GBP, usdToGbp } from './format.js';

export type CapState =
  | 'ok'          // plenty of headroom
  | 'approaching' // 75% or more of the allowance is gone
  | 'at_cap'      // blocked; the next request is refused
  | 'over_cap'    // already past it, which a concurrent write can produce
  | 'uncapped';   // no ceiling configured

/** The stage `wv_spend_allowed` counts when it decides whether a build may start. */
export const BUILD_COUNTED_STAGE = 'reconstruct';

/** Where the bar changes from informative to a warning. */
export const APPROACHING_AT = 0.75;

export interface CapView {
  readonly used: number;
  readonly cap: number | null;
  /** used / cap, clamped to 0..1 for the bar. */
  readonly ratio: number;
  /** used / cap, unclamped, so "140% of the cap" can be stated. */
  readonly ratioRaw: number;
  readonly remaining: number;
  readonly state: CapState;
  /** True when the next request of this kind will be refused. */
  readonly blocked: boolean;
}

export function capView(used: number, cap: number | null | undefined): CapView {
  const u = Number.isFinite(used) && used > 0 ? used : 0;
  if (cap === null || cap === undefined || !Number.isFinite(cap) || cap <= 0) {
    return { used: u, cap: null, ratio: 0, ratioRaw: 0, remaining: Infinity, state: 'uncapped', blocked: false };
  }
  const ratioRaw = u / cap;
  const state: CapState = ratioRaw > 1 ? 'over_cap'
    : ratioRaw >= 1 ? 'at_cap'
      : ratioRaw >= APPROACHING_AT ? 'approaching'
        : 'ok';
  return {
    used: u,
    cap,
    ratio: Math.max(0, Math.min(1, ratioRaw)),
    ratioRaw,
    remaining: Math.max(0, cap - u),
    // `wv_spend_allowed` uses >=, so at the cap is already refused.
    blocked: ratioRaw >= 1,
    state,
  };
}

export interface OrgCaps {
  readonly ai_month_cap_gbp: number | string | null;
  readonly build_month_cap: number | string | null;
  readonly ai_turns_per_session: number | string | null;
}

export interface AiTurnRow {
  readonly cost_usd?: number | string | null;
  readonly at: string;
  readonly world_id?: string | null;
  readonly tier?: string | null;
}

export interface BuildJobRow {
  readonly stage: string;
  readonly queued_at?: string | null;
  readonly world_id?: string | null;
  readonly cost_usd?: number | string | null;
  readonly gpu_seconds?: number | string | null;
}

export interface SpendInput {
  readonly caps: OrgCaps;
  readonly aiTurns: readonly AiTurnRow[];
  readonly jobs: readonly BuildJobRow[];
  /** Maps a world id to the property it belongs to, for per-property costs. */
  readonly worldToProperty: Readonly<Record<string, string>>;
  readonly propertyLabels: Readonly<Record<string, string>>;
  /** "Now", so the month boundary is testable rather than ambient. */
  readonly now: Date;
}

export interface PropertySpend {
  readonly propertyId: string;
  readonly label: string;
  readonly aiGbp: number;
  readonly buildGbp: number;
  readonly totalGbp: number;
  readonly builds: number;
  readonly gpuSeconds: number;
  readonly aiTurns: number;
}

export interface SpendSummary {
  readonly monthStart: string;
  readonly ai: CapView;
  readonly builds: CapView;
  readonly turnsPerSession: number | null;
  /** This month's AI spend converted to GBP at the rate the server enforces. */
  readonly aiGbp: number;
  readonly aiTurnCount: number;
  readonly buildGbp: number;
  readonly gpuSeconds: number;
  readonly totalGbp: number;
  readonly perProperty: readonly PropertySpend[];
  /** Mean spend across properties that cost anything this month. */
  readonly meanCostPerPropertyGbp: number;
  readonly rate: number;
}

function n(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function capOf(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** `date_trunc('month', now())` in UTC, which is what the function compares to. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function summariseSpend(input: SpendInput): SpendSummary {
  const start = monthStart(input.now).getTime();

  const turns = input.aiTurns.filter((t) => {
    const at = Date.parse(t.at);
    return Number.isFinite(at) && at >= start;
  });
  const aiUsd = turns.reduce((sum, t) => sum + n(t.cost_usd), 0);
  const aiGbp = usdToGbp(aiUsd);

  const builds = input.jobs.filter((j) => {
    if (j.stage !== BUILD_COUNTED_STAGE) return false;
    const at = j.queued_at ? Date.parse(j.queued_at) : NaN;
    return Number.isFinite(at) && at >= start;
  });

  // Build cost is every job's cost this month, not only the counted stage: the
  // cap counts reconstructions, but the bill is the whole pipeline.
  const monthJobs = input.jobs.filter((j) => {
    const at = j.queued_at ? Date.parse(j.queued_at) : NaN;
    return Number.isFinite(at) && at >= start;
  });
  const buildGbp = usdToGbp(monthJobs.reduce((sum, j) => sum + n(j.cost_usd), 0));
  const gpuSeconds = monthJobs.reduce((sum, j) => sum + n(j.gpu_seconds), 0);

  const perProperty = new Map<string, {
    aiGbp: number; buildGbp: number; builds: number; gpuSeconds: number; aiTurns: number;
  }>();
  const bump = (propertyId: string): { aiGbp: number; buildGbp: number; builds: number; gpuSeconds: number; aiTurns: number } => {
    const existing = perProperty.get(propertyId);
    if (existing) return existing;
    const fresh = { aiGbp: 0, buildGbp: 0, builds: 0, gpuSeconds: 0, aiTurns: 0 };
    perProperty.set(propertyId, fresh);
    return fresh;
  };

  for (const t of turns) {
    const propertyId = t.world_id ? input.worldToProperty[t.world_id] : undefined;
    if (!propertyId) continue;
    const slot = bump(propertyId);
    slot.aiGbp += usdToGbp(n(t.cost_usd));
    slot.aiTurns += 1;
  }
  for (const j of monthJobs) {
    const propertyId = j.world_id ? input.worldToProperty[j.world_id] : undefined;
    if (!propertyId) continue;
    const slot = bump(propertyId);
    slot.buildGbp += usdToGbp(n(j.cost_usd));
    slot.gpuSeconds += n(j.gpu_seconds);
    if (j.stage === BUILD_COUNTED_STAGE) slot.builds += 1;
  }

  const rows: PropertySpend[] = [...perProperty.entries()]
    .map(([propertyId, v]) => ({
      propertyId,
      label: input.propertyLabels[propertyId] ?? propertyId,
      aiGbp: v.aiGbp,
      buildGbp: v.buildGbp,
      totalGbp: v.aiGbp + v.buildGbp,
      builds: v.builds,
      gpuSeconds: v.gpuSeconds,
      aiTurns: v.aiTurns,
    }))
    .sort((a, b) => b.totalGbp - a.totalGbp || a.label.localeCompare(b.label));

  const spending = rows.filter((r) => r.totalGbp > 0);

  return {
    monthStart: monthStart(input.now).toISOString(),
    ai: capView(aiGbp, capOf(input.caps.ai_month_cap_gbp)),
    builds: capView(builds.length, capOf(input.caps.build_month_cap)),
    turnsPerSession: capOf(input.caps.ai_turns_per_session),
    aiGbp,
    aiTurnCount: turns.length,
    buildGbp,
    gpuSeconds,
    totalGbp: aiGbp + buildGbp,
    perProperty: rows,
    meanCostPerPropertyGbp: spending.length === 0
      ? 0
      : spending.reduce((sum, r) => sum + r.totalGbp, 0) / spending.length,
    rate: USD_TO_GBP,
  };
}

/**
 * The sentence next to the bar. Written so that "at the cap" never reads as a
 * warning about the future — it has already happened.
 */
export function capSentence(kind: 'ai' | 'builds', view: CapView): string {
  if (view.state === 'uncapped') {
    return kind === 'ai'
      ? 'No monthly AI cap is set on this organisation. Viewer conversations are unmetered, which is the one setting that can outrun the plan.'
      : 'No monthly build cap is set on this organisation.';
  }
  const noun = kind === 'ai' ? 'AI conversation' : 'build';
  switch (view.state) {
    case 'over_cap':
      return `Past the cap. The next ${noun} is already being refused.`;
    case 'at_cap':
      return `At the cap. The next ${noun} will be refused until the cap is raised or the month rolls over.`;
    case 'approaching':
      return kind === 'ai'
        ? `${Math.round(view.ratioRaw * 100)}% of this month's AI allowance is gone.`
        : `${view.remaining} of ${view.cap} builds left this month.`;
    default:
      return kind === 'ai'
        ? `${Math.round(view.ratioRaw * 100)}% of this month's AI allowance used.`
        : `${view.remaining} of ${view.cap} builds left this month.`;
  }
}
