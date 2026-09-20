/**
 * Model catalogue and cost accounting.
 *
 * Every price in this file is a number someone will be invoiced for, so the
 * arithmetic is explicit, unit-tested and done in one place. Nothing computes
 * a cost at a call site.
 *
 * Prices are US dollars per million tokens, as published. They change; that is
 * why they are data rather than code, and why `ModelCatalogue` is injectable.
 *
 * On caching. The system prompt and the scene-graph context are the same on
 * every turn of a session and they dominate the input: a two-bed flat's room
 * list, entity labels and relationship summary is a few thousand tokens, and
 * the question is twenty. Caching that prefix is the difference between a
 * conversation that pays for itself and one that does not, which is why the
 * cache multipliers are first-class here rather than an afterthought applied
 * to a total. On Claude-class models a cache read costs a tenth of a fresh
 * input token and a cache write costs a quarter more than one, which nets out
 * at roughly a third off a realistic multi-turn session -- the ~35% the cost
 * model assumes.
 */

export type ModelId =
  | 'claude-haiku-4.5'
  | 'claude-sonnet-5'
  | 'claude-opus-5'
  | 'gemini-3.1-flash-lite'
  | 'llama-3.3-70b-deepinfra';

export interface ModelPrice {
  readonly id: ModelId;
  readonly vendor: 'anthropic' | 'google' | 'deepinfra';
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
  /**
   * Multiplier on the input price for a token served from cache. 0.1 on
   * Claude-class models; Gemini's implicit cache discount is shallower; a
   * DeepInfra-hosted open model has no prefix cache at all, so 1.
   */
  readonly cacheReadMultiplier: number;
  /** Multiplier on the input price for writing a token into the cache. */
  readonly cacheWriteMultiplier: number;
  /** Rough class, used by the router when a tier is configured by capability. */
  readonly class: 'small' | 'large';
}

/**
 * Prices as of this build. A deploy that wants different ones passes its own
 * catalogue; nothing in the agent reads a global.
 */
export const DEFAULT_CATALOGUE: Readonly<Record<ModelId, ModelPrice>> = {
  'claude-haiku-4.5': {
    id: 'claude-haiku-4.5', vendor: 'anthropic',
    inputPerMTok: 1.00, outputPerMTok: 5.00,
    cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, class: 'small',
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5', vendor: 'anthropic',
    inputPerMTok: 2.00, outputPerMTok: 10.00,
    cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, class: 'large',
  },
  'claude-opus-5': {
    id: 'claude-opus-5', vendor: 'anthropic',
    inputPerMTok: 5.00, outputPerMTok: 25.00,
    cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, class: 'large',
  },
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite', vendor: 'google',
    inputPerMTok: 0.25, outputPerMTok: 1.50,
    cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0, class: 'small',
  },
  'llama-3.3-70b-deepinfra': {
    id: 'llama-3.3-70b-deepinfra', vendor: 'deepinfra',
    inputPerMTok: 0.10, outputPerMTok: 0.32,
    // No prefix cache on this hosting. Pretending otherwise would understate
    // its cost and make the router prefer it for the wrong reason.
    cacheReadMultiplier: 1.0, cacheWriteMultiplier: 1.0, class: 'small',
  },
};

export interface Usage {
  /**
   * Total input tokens for the call, INCLUSIVE of both the cached ones and the
   * ones written into the cache. Every input token is billed exactly once, at
   * one of three rates; a provider that reports these as separate buckets must
   * be normalised to this shape before it gets here, or the bill is wrong in
   * whichever direction the provider happens to report.
   */
  readonly inTokens: number;
  readonly outTokens: number;
  /** Of `inTokens`, how many were served from cache (read rate). */
  readonly cachedTokens?: number;
  /** Of `inTokens`, how many were written into the cache (write rate). */
  readonly cacheWriteTokens?: number;
}

export interface CostBreakdown {
  readonly model: ModelId;
  readonly freshInputUsd: number;
  readonly cachedInputUsd: number;
  readonly cacheWriteUsd: number;
  readonly outputUsd: number;
  readonly totalUsd: number;
  /** What the same call would have cost with no cache. For the dashboard. */
  readonly uncachedTotalUsd: number;
  readonly savingUsd: number;
  readonly savingPct: number;
}

const PER_TOKEN = 1 / 1_000_000;

function clampCount(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

/**
 * The one place a token count becomes money.
 *
 * `cachedTokens` and `cacheWriteTokens` are both subsets of `inTokens`, and
 * they do not overlap: a token is read from the cache, or written into it, or
 * neither, never two of those. The fresh portion is what is left. Getting this
 * wrong in the obvious way -- counting the prefix once as input and again as a
 * cache write on the turn that primes it -- overstates a session's cost by
 * about a fifth and makes the cache look less valuable than it is.
 */
export function computeCost(
  price: ModelPrice, usage: Usage,
): CostBreakdown {
  const inTokens = clampCount(usage.inTokens);
  const outTokens = clampCount(usage.outTokens);
  const cached = Math.min(inTokens, clampCount(usage.cachedTokens));
  const written = Math.min(inTokens - cached, clampCount(usage.cacheWriteTokens));
  const fresh = inTokens - cached - written;

  const freshInputUsd = fresh * PER_TOKEN * price.inputPerMTok;
  const cachedInputUsd = cached * PER_TOKEN * price.inputPerMTok * price.cacheReadMultiplier;
  const cacheWriteUsd = written * PER_TOKEN * price.inputPerMTok * price.cacheWriteMultiplier;
  const outputUsd = outTokens * PER_TOKEN * price.outputPerMTok;
  const totalUsd = freshInputUsd + cachedInputUsd + cacheWriteUsd + outputUsd;

  // The counterfactual: the same prompt with no cache at all. Cache writes
  // vanish (nothing is written) and every input token is charged fresh.
  const uncachedTotalUsd = inTokens * PER_TOKEN * price.inputPerMTok + outputUsd;
  const savingUsd = uncachedTotalUsd - totalUsd;

  return {
    model: price.id,
    freshInputUsd, cachedInputUsd, cacheWriteUsd, outputUsd, totalUsd,
    uncachedTotalUsd,
    savingUsd,
    savingPct: uncachedTotalUsd > 0 ? (savingUsd / uncachedTotalUsd) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Routing configuration
// ---------------------------------------------------------------------------

/**
 * Which model serves which tier. Configuration, never a constant at a call
 * site: swapping Sonnet for Opus on the hard tier, or Llama for Haiku on the
 * cheap one, is an operations decision made per deployment and sometimes per
 * org, and it must not require a code change.
 */
export interface RoutingConfig {
  readonly small: ModelId;
  readonly large: ModelId;
  readonly catalogue: Readonly<Record<ModelId, ModelPrice>>;
  /** Hard ceiling per session, in USD. Beyond it the agent stops escalating. */
  readonly sessionCostCapUsd: number;
  /** Turn cap per session, mirrored from the org row. */
  readonly sessionTurnCap: number;
  /**
   * Tokens in the cacheable prefix: system prompt plus scene-graph context.
   * Used to estimate a turn's cost before it is made, which is how a spend cap
   * gets enforced *before* work starts rather than after the bill arrives.
   */
  readonly cachedPrefixTokens: number;
}

export const DEFAULT_ROUTING: RoutingConfig = {
  // Haiku over Gemini Flash-Lite for the small tier despite Gemini being four
  // times cheaper per token: the cache read multiplier is what dominates a
  // multi-turn session, and 0.1 against 0.25 on a 3,000-token prefix beats the
  // headline rate. A deployment that disagrees passes its own config.
  small: 'claude-haiku-4.5',
  large: 'claude-sonnet-5',
  catalogue: DEFAULT_CATALOGUE,
  sessionCostCapUsd: 0.25,
  sessionTurnCap: 25,
  cachedPrefixTokens: 3_000,
};

export function priceOf(config: RoutingConfig, id: ModelId): ModelPrice {
  const p = config.catalogue[id];
  if (!p) throw new Error(`no price for model '${id}'`);
  return p;
}

/**
 * Estimated cost of a turn before it happens.
 *
 * Deliberately pessimistic on output (a model that rambles must not blow a cap
 * that was set using its median) and optimistic on nothing. Used by the spend
 * guard, which refuses a turn whose estimate would cross a cap.
 */
export function estimateTurnCost(
  config: RoutingConfig, model: ModelId,
  opts: { readonly freshInputTokens: number; readonly maxOutputTokens: number; readonly primed: boolean },
): number {
  const price = priceOf(config, model);
  const cached = opts.primed ? config.cachedPrefixTokens : 0;
  const written = opts.primed ? 0 : config.cachedPrefixTokens;
  return computeCost(price, {
    inTokens: config.cachedPrefixTokens + Math.max(0, opts.freshInputTokens),
    cachedTokens: cached,
    cacheWriteTokens: written,
    outTokens: Math.max(0, opts.maxOutputTokens),
  }).totalUsd;
}

/** USD to GBP, for comparing against the org's sterling monthly cap. */
export const DEFAULT_GBP_PER_USD = 0.79;
