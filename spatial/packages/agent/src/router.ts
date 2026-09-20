/**
 * The router.
 *
 * At 1,000 properties a month, conversation is about 66% of this system's
 * infrastructure cost; at 10,000 it is about 74%. Reconstruction is roughly
 * $0.74 per property and happens once. Chat happens per viewer, and a listing
 * that goes viral is a listing whose chat bill has no ceiling. That asymmetry
 * is why tier selection is an architectural decision rather than a tuning
 * knob, and why the deterministic tier is the default rather than the
 * fallback.
 *
 * The rule the tiers encode:
 *
 *   Tier 0  the spatial engine already knows the answer exactly. No model.
 *   Tier 1  the answer is known but the question is not cleanly parsed:
 *           phrasing, disambiguation, a short tool sequence. Small model.
 *   Tier 2  the question needs genuine reasoning across rooms, weighing,
 *           or resolving an ambiguity a template cannot. Strong model.
 *
 * Escalation is one-way within a turn and is always justified in the returned
 * `reason`, which lands in the logs. A tier-2 turn that nobody can explain is
 * a bug in this file.
 */

import type { Intent } from './intent.js';
import { ROUTE_CONFIDENCE } from './intent.js';
import type { ModelId, RoutingConfig } from './pricing.js';
import type { Tier } from './types.js';

export interface RouteDecision {
  readonly tier: Tier;
  readonly model: ModelId | null;
  readonly reason: string;
}

/**
 * Markers of a question that a template cannot answer honestly even when every
 * fact it needs is available: it asks for a judgement, a comparison with a
 * criterion, or an explanation.
 */
const REASONING_MARKERS: readonly RegExp[] = [
  /\bwhy\b/,
  /\bshould i\b|\bwould you\b|\bdo you think\b|\brecommend\b|\bworth\b/,
  /\bbest\b|\bbetter\b|\bsuitable\b|\bsuited\b|\bideal\b/,
  /\bcompared? (with|to)\b|\bversus\b|\bvs\b/,
  /\bexplain\b|\bwhat does .* mean\b|\bhow come\b/,
  /\bif i\b|\bcould i\b|\bwould it\b|\bassuming\b/,
  /\btrade[- ]?off\b|\bpros and cons\b/,
];

/** Two questions in one sentence. A template answers one and drops the other. */
const MULTI_CLAUSE = /\?.*\?|\band (also|then)\b|\bas well as\b|,? and (how|what|where|which|can|does|is)\b/;

export interface RouteInput {
  readonly question: string;
  readonly intent: Intent;
  /** Whether the deterministic tier actually produced an answer. */
  readonly deterministicHandled: boolean;
  /** Turns already spent in this session. */
  readonly turnsUsed: number;
  /** USD already spent in this session. */
  readonly sessionCostUsd: number;
  readonly config: RoutingConfig;
}

export function route(input: RouteInput): RouteDecision {
  const q = input.question.toLowerCase();
  const { intent, config } = input;

  // Tier 0 is not "try the cheap thing first". It is a claim that the answer
  // is exact and complete, so it is only taken when the parse was confident
  // AND a handler actually produced an answer from tool output.
  if (input.deterministicHandled && intent.confidence >= ROUTE_CONFIDENCE) {
    // One exception: a confidently parsed question that also asks for a
    // judgement got a correct factual answer, but not the answer asked for.
    // Those still escalate, with the deterministic answer available as context.
    if (needsReasoning(q)) {
      return atLeast(input, {
        tier: 'large',
        model: config.large,
        reason: 'facts resolved deterministically, but the question asks for a judgement',
      });
    }
    return { tier: 'deterministic', model: null, reason: `intent ${intent.kind} resolved by the spatial engine` };
  }

  // Beyond the cost cap the agent stops escalating entirely. A session that has
  // spent its allowance gets deterministic answers or an honest "not now",
  // never a silent overspend.
  if (input.sessionCostUsd >= config.sessionCostCapUsd) {
    return {
      tier: 'deterministic',
      model: null,
      reason: 'session cost cap reached; deterministic answers only',
    };
  }

  if (needsReasoning(q) || MULTI_CLAUSE.test(q)) {
    return {
      tier: 'large',
      model: config.large,
      reason: needsReasoning(q)
        ? 'question asks for reasoning or a judgement, not a measurement'
        : 'question contains more than one clause to answer',
    };
  }

  if (intent.kind === 'compare' && intent.confidence < ROUTE_CONFIDENCE) {
    return {
      tier: 'large',
      model: config.large,
      reason: 'comparison across rooms without a clean pair of subjects',
    };
  }

  if (intent.kind === 'unknown') {
    // An unparsed question is not automatically hard. A short one is usually
    // a rephrasing the small model can map onto a tool; a long one usually is
    // not, and paying twice (small, then large) is worse than paying once.
    const words = q.split(/\s+/).filter(Boolean).length;
    if (words > 22) {
      return { tier: 'large', model: config.large, reason: 'long unparsed question' };
    }
    return { tier: 'small', model: config.small, reason: 'unparsed but short; small model maps it onto tools' };
  }

  // Parsed, but not confidently, or the handler declined. The facts are
  // reachable; what is missing is which fact. That is the small tier's job.
  return {
    tier: 'small',
    model: config.small,
    reason: input.deterministicHandled
      ? `intent ${intent.kind} parsed below confidence ${ROUTE_CONFIDENCE}`
      : `no deterministic handler produced an answer for ${intent.kind}`,
  };
}

function needsReasoning(q: string): boolean {
  return REASONING_MARKERS.some((re) => re.test(q));
}

/**
 * Respect the cost cap even on an escalation the content justifies. Crossing
 * a cap is never the right answer to a hard question.
 */
function atLeast(input: RouteInput, decision: RouteDecision): RouteDecision {
  if (input.sessionCostUsd >= input.config.sessionCostCapUsd) {
    return {
      tier: 'deterministic',
      model: null,
      reason: 'session cost cap reached; answering from the spatial engine alone',
    };
  }
  return decision;
}

/** True when the session has no turns left. Checked before any work. */
export function turnCapReached(turnsUsed: number, config: RoutingConfig): boolean {
  return turnsUsed >= config.sessionTurnCap;
}
