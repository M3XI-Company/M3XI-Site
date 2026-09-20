/**
 * wv-ask — the AI endpoint.
 *
 * The order of the first three checks is the whole design. Turn cap, then
 * org spend cap, then work. Both caps are enforced BEFORE anything is
 * computed and before any model is contacted, because a cap checked afterwards
 * is not a cap, it is a report.
 *
 * Tenant isolation here is subtler than in wv-view and matters more: the AI is
 * the one component that can be talked into fetching things. It cannot, in
 * this design, because it never chooses what world to load. The world comes
 * from the SESSION row, not from the request body, so a caller who knows
 * another org's world id and pairs it with their own session gets their own
 * property described back to them, and a caller who guesses a session id
 * cannot use it against a different world.
 */

import type { BaseDeps } from '../_wv_shared/deps.ts';
import type { HttpRequest, HttpResponse } from '../_wv_shared/http.ts';
import { fail, json, str, uuid } from '../_wv_shared/http.ts';

/** Shapes the agent package satisfies, declared here so this file imports nothing heavy. */
export interface AgentTurnRecord {
  readonly tier: 'deterministic' | 'small' | 'large';
  readonly model: string | null;
  readonly tools: readonly string[];
  readonly grounded: boolean;
  readonly refused: boolean;
  readonly inTokens: number;
  readonly outTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}

export interface AgentTurnResult {
  readonly answer: { readonly text: string; readonly refused: boolean; readonly grounded: boolean };
  readonly commands: readonly unknown[];
  readonly record: AgentTurnRecord;
  /** Serialised salience, persisted on the session so the next turn has context. */
  readonly salience?: unknown;
}

export interface AgentRunner {
  /**
   * Loads the world, restores conversation state, answers, and returns the
   * turn. Injected so this handler is testable without the spatial engine and
   * so a deployment can swap the model client without touching routing.
   */
  run(input: {
    readonly worldId: string;
    readonly sessionId: string;
    readonly question: string;
    readonly view: unknown;
    readonly salience: unknown;
    readonly turnsUsed: number;
    readonly sessionCostUsd: number;
    readonly turnCap: number;
  }): Promise<AgentTurnResult>;
}

export interface AskDeps extends BaseDeps {
  readonly agent: AgentRunner;
}

/** Hard ceiling on a question, before it reaches a tokeniser. */
const MAX_QUESTION_CHARS = 600;

export async function handleAsk(req: HttpRequest, deps: AskDeps): Promise<HttpResponse> {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const sessionId = uuid(body['sessionId']);
  const viewerKey = str(body['viewerKey'], 128);
  const question = str(body['question'], MAX_QUESTION_CHARS);
  if (!sessionId || !viewerKey) return fail(400, 'Start a tour first.');
  if (!question) return fail(400, 'Ask a question.');

  // The session is the capability. It names the world; the request body does
  // not get a vote, so no request can address a world it was not issued for.
  const sessions = await deps.db.select('wv_session', {
    columns: ['id', 'world_id', 'viewer_key', 'ai_turns', 'ai_cost_usd', 'ended_at'],
    eq: { id: sessionId },
    limit: 1,
  });
  const session = sessions[0];
  if (!session || session['viewer_key'] !== viewerKey) return fail(404, 'Not found.');
  if (session['ended_at'] !== null && session['ended_at'] !== undefined) {
    return fail(409, 'This tour has ended. Reload to start again.');
  }
  const worldId = String(session['world_id']);

  // A world can be unpublished after a session starts. The session must not
  // outlive that decision.
  const worlds = await deps.db.select('wv_world', {
    columns: ['id', 'status'],
    eq: { id: worldId, status: 'published' },
    limit: 1,
  });
  if (!worlds[0]) return fail(404, 'Not found.');

  // --- Cap 1: per-session turns -------------------------------------------
  const turnsUsed = numberOf(session['ai_turns']);
  const sessionCostUsd = numberOf(session['ai_cost_usd']);
  const turnCap = await turnCapFor(worldId, deps);
  if (turnsUsed >= turnCap) {
    deps.log('wv_ask_turn_cap', { sessionId, worldId, turnsUsed, turnCap });
    return json({
      answer: `This conversation has reached its limit of ${turnCap} questions. Reload the tour to start a new one.`,
      refused: true, grounded: true, commands: [], capped: 'turns',
    }, 429);
  }

  // --- Cap 2: per-org monthly spend, in the database, before any work ------
  let allowed: { allowed?: boolean; reason?: string };
  try {
    allowed = await deps.db.rpc<{ allowed?: boolean; reason?: string }>('wv_spend_allowed', {
      p_world: worldId, p_kind: 'ai',
    });
  } catch (err) {
    // A spend check that cannot run is a spend check that failed. Refusing is
    // the only safe direction: the alternative is unmetered spend during an
    // outage, which is exactly the failure this cap exists to prevent.
    deps.log('wv_ask_spend_check_failed', { worldId, error: String(err) });
    return json({
      answer: 'The assistant is briefly unavailable. Everything else in the tour still works.',
      refused: true, grounded: true, commands: [], capped: 'unavailable',
    }, 503);
  }
  if (allowed?.allowed !== true) {
    deps.log('wv_ask_spend_cap', { worldId, reason: allowed?.reason });
    return json({
      answer: 'The assistant is unavailable on this listing right now. The measurements and the floorplan are all still here.',
      refused: true, grounded: true, commands: [], capped: allowed?.reason ?? 'spend',
    }, 429);
  }

  // --- Only now does any work happen --------------------------------------
  const stateRows = await deps.db.select('wv_event', {
    columns: ['payload'],
    eq: { session_id: sessionId, kind: 'ai_state' },
    order: { column: 'at', ascending: false },
    limit: 1,
  });
  const salience = (stateRows[0]?.['payload'] as Record<string, unknown> | undefined)?.['salience'] ?? null;

  let result: AgentTurnResult;
  try {
    result = await deps.agent.run({
      worldId,
      sessionId,
      question,
      view: body['view'],
      salience,
      turnsUsed,
      sessionCostUsd,
      turnCap,
    });
  } catch (err) {
    deps.log('wv_ask_agent_failed', { worldId, sessionId, error: String(err) });
    // A crash still writes a turn row, marked ungrounded and refused, because
    // an invisible failure is how a broken router stays broken.
    await writeTurn(deps, worldId, sessionId, question, {
      tier: 'deterministic', model: null, tools: [], grounded: false, refused: true,
      inTokens: 0, outTokens: 0, cachedTokens: 0, costUsd: 0, latencyMs: 0,
    });
    return json({
      answer: 'Something went wrong working that out. Nothing was charged for it.',
      refused: true, grounded: false, commands: [],
    }, 500);
  }

  await writeTurn(deps, worldId, sessionId, question, result.record);

  // Meter the session AFTER the work, from the authoritative record. The cap
  // above read these same columns, so the next turn sees this one.
  await deps.db.update('wv_session', {
    ai_turns: turnsUsed + 1,
    ai_cost_usd: round6(sessionCostUsd + result.record.costUsd),
  }, { id: sessionId });

  if (result.salience !== undefined) {
    await deps.db.insert('wv_event', {
      world_id: worldId, session_id: sessionId, kind: 'ai_state',
      payload: { salience: result.salience },
    });
  }

  return json({
    answer: result.answer.text,
    refused: result.answer.refused,
    grounded: result.answer.grounded,
    commands: result.commands,
    // The viewer shows a turn counter; hiding it until the wall is hit makes
    // the wall feel arbitrary.
    turnsRemaining: Math.max(0, turnCap - (turnsUsed + 1)),
    tier: result.record.tier,
  });
}

async function turnCapFor(worldId: string, deps: AskDeps): Promise<number> {
  try {
    const orgId = await deps.db.rpc<string | null>('wv_org_of_world', { p_world: worldId });
    if (!orgId) return 1;
    const orgs = await deps.db.select('wv_org', {
      columns: ['ai_turns_per_session'], eq: { id: orgId }, limit: 1,
    });
    const n = numberOf(orgs[0]?.['ai_turns_per_session']);
    // A missing or absurd value must not become "unlimited".
    return n >= 1 && n <= 500 ? Math.floor(n) : 25;
  } catch {
    return 1;
  }
}

async function writeTurn(
  deps: AskDeps, worldId: string, sessionId: string, question: string,
  record: AgentTurnRecord,
): Promise<void> {
  try {
    await deps.db.insert('wv_ai_turn', {
      world_id: worldId,
      session_id: sessionId,
      tier: record.tier,
      model: record.model,
      question: question.slice(0, MAX_QUESTION_CHARS),
      tools: record.tools,
      grounded: record.grounded,
      refused: record.refused,
      in_tokens: record.inTokens,
      out_tokens: record.outTokens,
      cached_tokens: record.cachedTokens,
      cost_usd: round6(record.costUsd),
      latency_ms: Math.round(record.latencyMs),
    });
  } catch (err) {
    // Losing an accounting row is serious but it is not worth failing a turn
    // the customer already received. It is logged loudly instead.
    deps.log('wv_ask_turn_write_failed', { worldId, sessionId, error: String(err) });
  }
}

function numberOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
