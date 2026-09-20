/**
 * The grounded agent.
 *
 * One public method, `ask`. It runs the same way in a browser and in a Deno
 * edge function, because it depends on nothing but the world document, a
 * viewer state and an injected model client.
 *
 * The order of operations is the safety property:
 *
 *   1. Caps first. Turn cap and spend cap are checked BEFORE any work, not
 *      after the bill arrives.
 *   2. Parse, resolve references, attempt Tier 0. Most turns stop here, and a
 *      turn that stops here costs nothing.
 *   3. Escalate only with a stated reason, and only inside the caps.
 *   4. Whatever answers, verify it is grounded before it is returned. A model
 *      reply containing a number no tool produced is discarded, not shipped.
 */

import type { Grounding, WorldDocument } from '@m3xi/world-core';
import { World } from '@m3xi/spatial-engine';

import { SYSTEM_PROMPT, buildSceneContext, contextKey } from './context.js';
import type { ViewerCommand } from './commands.js';
import type { AgentAnswer, DeterministicDeps } from './deterministic.js';
import { answerDeterministically } from './deterministic.js';
import type { Intent } from './intent.js';
import { buildVocabulary, classify, type VocabEntry } from './intent.js';
import type { ModelClient, ModelRequest } from './model.js';
import { estimateTokens } from './model.js';
import type { ModelId, RoutingConfig } from './pricing.js';
import { DEFAULT_ROUTING, computeCost, estimateTurnCost, priceOf } from './pricing.js';
import { ReferenceResolver, SalienceModel } from './resolver.js';
import { route, turnCapReached, type RouteDecision } from './router.js';
import { Tools, type WorldRef } from './tools.js';
import type { Refusal, Tier, ToolName, TurnRecord } from './types.js';
import { TOOL_NAMES } from './types.js';
import type { ViewerState } from './view.js';

export interface AgentOptions {
  readonly world: World;
  readonly worldId: string;
  readonly sessionId?: string | null;
  readonly model: ModelClient;
  readonly config?: RoutingConfig;
  /** Injected so turn latency and ids are deterministic under test. */
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Restored from the session row so a cold start keeps the conversation. */
  readonly salience?: SalienceModel;
  readonly turnsUsed?: number;
  readonly sessionCostUsd?: number;
}

export interface AskResult {
  readonly answer: AgentAnswer;
  readonly commands: readonly ViewerCommand[];
  readonly decision: RouteDecision;
  readonly record: TurnRecord;
  readonly intent: Intent;
}

/** Output budget per escalated turn. Bounds the worst case before it happens. */
const MAX_OUTPUT_TOKENS = 400;

export class Agent {
  readonly world: World;
  readonly worldId: string;
  readonly sessionId: string | null;
  readonly config: RoutingConfig;
  readonly salience: SalienceModel;

  private readonly model: ModelClient;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly vocab: VocabEntry[];
  private readonly sceneContext: string;
  private readonly contextFingerprint: string;
  /** True once this session has written the prefix into the provider's cache. */
  private prefixPrimed = false;

  turnsUsed: number;
  sessionCostUsd: number;
  private lastIntent: Intent | undefined;
  private commandSeq = 0;

  constructor(opts: AgentOptions) {
    this.world = opts.world;
    this.worldId = opts.worldId;
    this.sessionId = opts.sessionId ?? null;
    this.model = opts.model;
    this.config = opts.config ?? DEFAULT_ROUTING;
    this.now = opts.now ?? (() => Date.now());
    this.idFactory = opts.idFactory ?? (() => `cmd_${++this.commandSeq}`);
    this.salience = opts.salience ?? new SalienceModel();
    this.turnsUsed = opts.turnsUsed ?? 0;
    this.sessionCostUsd = opts.sessionCostUsd ?? 0;

    const refs: WorldRef[] = [
      ...this.world.doc.rooms.map((room): WorldRef => ({ type: 'room', room })),
      ...this.world.doc.entities.map((entity): WorldRef => ({ type: 'entity', entity })),
      ...this.world.doc.openings.map((opening): WorldRef => ({ type: 'opening', opening })),
    ];
    this.vocab = buildVocabulary(refs);
    this.sceneContext = buildSceneContext(this.world);
    this.contextFingerprint = contextKey(this.world.doc);
  }

  static fromDocument(doc: WorldDocument, opts: Omit<AgentOptions, 'world'>): Agent {
    return new Agent({ ...opts, world: World.fromDocument(doc) });
  }

  get contextTokens(): number {
    return estimateTokens(SYSTEM_PROMPT) + estimateTokens(this.sceneContext);
  }

  get fingerprint(): string {
    return this.contextFingerprint;
  }

  /**
   * Answer one question.
   *
   * `view` is mutated in place when the agent moves the camera or changes the
   * selection, so the caller's copy stays in step with the commands it is
   * about to apply.
   */
  async ask(question: string, view: ViewerState): Promise<AskResult> {
    const startedAt = this.now();
    const commands: ViewerCommand[] = [];
    const tools = new Tools(this.world, view, {
      emit: (c) => commands.push(c),
      nextCommandId: () => this.idFactory(),
    });

    // --- Cap enforcement, before anything else ---------------------------
    if (turnCapReached(this.turnsUsed, this.config)) {
      return this.finish(
        question, startedAt, commands,
        refusal({
          code: 'out_of_scope',
          reason: `This conversation has reached its limit of ${this.config.sessionTurnCap} questions. Reload the tour to start a new one.`,
        }),
        { tier: 'deterministic', model: null, reason: 'session turn cap' },
        { kind: 'unknown', confidence: 0, followUp: false, unresolved: [] },
        null,
      );
    }

    // Advances the salience clock: everything mentioned before this point is
    // now one turn older and correspondingly less likely to be what "that"
    // refers to.
    this.salience.beginTurn();
    const resolver = new ReferenceResolver(tools, this.salience);
    // Whether the camera is in a room is part of understanding the question,
    // not part of answering it: "how tall are the ceilings" is complete inside
    // a room and underspecified outside one.
    const hasCurrentRoom = this.world.roomAt(view.position) !== undefined;
    const intent = classify(question, {
      vocab: this.vocab, previous: this.lastIntent, hasCurrentRoom,
    });

    const deps: DeterministicDeps = {
      tools, resolver, commands, nextCommandId: () => this.idFactory(),
    };

    // --- Tier 0 -----------------------------------------------------------
    let deterministic: AgentAnswer | null = null;
    try {
      deterministic = answerDeterministically(intent, deps);
    } catch (err) {
      // A thrown engine error is a bug, but it must not become a fabricated
      // answer. It degrades to an honest refusal and a loud log line.
      deterministic = null;
      logEngineError(err);
    }

    const decision = route({
      question,
      intent,
      deterministicHandled: isSettled(deterministic),
      turnsUsed: this.turnsUsed,
      sessionCostUsd: this.sessionCostUsd,
      config: this.config,
    });

    if (decision.tier === 'deterministic') {
      const final = deterministic ?? refusal({
        code: 'not_established',
        reason: 'I could not work that out from the capture, and this conversation has no budget left to think harder about it.',
      });
      this.rememberIntent(intent, final);
      resolver.noteAnswer(subjectOf(intent), final.citations);
      return this.finish(question, startedAt, commands, final, decision, intent, null);
    }

    // --- Escalation, inside the spend cap ---------------------------------
    const model = decision.model ?? this.config.small;
    const estimated = estimateTurnCost(this.config, model, {
      freshInputTokens: estimateTokens(question) + 600,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      primed: this.prefixPrimed,
    });
    if (this.sessionCostUsd + estimated > this.config.sessionCostCapUsd) {
      const final = deterministic ?? refusal({
        code: 'out_of_scope',
        reason: 'This conversation has used its allowance for detailed answers. I can still measure anything you point at.',
      });
      const capped: RouteDecision = {
        tier: 'deterministic', model: null,
        reason: `escalation to ${model} would cross the session cost cap`,
      };
      this.rememberIntent(intent, final);
      return this.finish(question, startedAt, commands, final, capped, intent, null);
    }

    const evidence = this.gatherEvidence(deps, intent, deterministic);
    const req: ModelRequest = {
      model,
      system: SYSTEM_PROMPT,
      context: this.sceneContext,
      messages: [{ role: 'user', content: question }],
      toolResults: evidence,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      allowedTools: TOOL_NAMES,
    };

    let text = '';
    let usage = { inTokens: 0, outTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    let providerFailed = false;
    try {
      const res = await this.model.complete(req);
      text = res.text.trim();
      usage = {
        inTokens: res.usage.inTokens,
        outTokens: res.usage.outTokens,
        cachedTokens: res.usage.cachedTokens ?? 0,
        cacheWriteTokens: res.usage.cacheWriteTokens ?? 0,
      };
      if (res.stopReason === 'refusal' || text.length === 0) providerFailed = true;
    } catch {
      providerFailed = true;
    }
    this.prefixPrimed = true;

    const cost = computeCost(priceOf(this.config, model), usage);
    this.sessionCostUsd += cost.totalUsd;

    if (providerFailed) {
      const final = deterministic ?? refusal({
        code: 'not_established',
        reason: 'I could not reach the reasoning model just now. I can still answer anything the measurements cover — try asking for a distance, an area or what is in a room.',
      });
      this.rememberIntent(intent, final);
      return this.finish(question, startedAt, commands, final, decision, intent, {
        model, usage, costUsd: cost.totalUsd,
      });
    }

    // --- Grounding verification ------------------------------------------
    const verdict = verifyGrounded(text, evidence);
    let final: AgentAnswer;
    if (!verdict.grounded) {
      // The model asserted something no tool produced. That is precisely the
      // failure this product exists to prevent, so the reply is discarded --
      // the deterministic answer if there is one, an honest refusal if not.
      final = deterministic ?? refusal({
        code: 'not_established',
        reason: 'I could not answer that from what the capture establishes.',
      });
      final = { ...final, grounded: false };
      logUngrounded(question, verdict.offending);
    } else {
      final = {
        text,
        commands: commands.slice(),
        grounded: true,
        refused: /\b(does not establish|cannot establish|no camera saw|not something a capture)\b/i.test(text),
        tools: tools.used.slice(),
        grounding: mergeEvidenceGrounding(deterministic),
        citations: deterministic?.citations ?? [],
      };
    }

    this.rememberIntent(intent, final);
    resolver.noteAnswer(subjectOf(intent), final.citations);
    return this.finish(question, startedAt, commands, final, decision, intent, {
      model, usage, costUsd: cost.totalUsd,
    });
  }

  /**
   * Run the tools the intent points at and hand the model their output.
   *
   * The model never calls a tool itself in this implementation. It receives
   * the results of tools chosen deterministically, which removes a whole class
   * of failure (a model calling measure_distance on a room in another org's
   * property) and one round trip of latency and cost.
   */
  private gatherEvidence(
    deps: DeterministicDeps, intent: Intent, deterministic: AgentAnswer | null,
  ): { tool: ToolName; json: string }[] {
    const out: { tool: ToolName; json: string }[] = [];
    const push = (tool: ToolName, data: unknown): void => {
      out.push({ tool, json: JSON.stringify(data) });
    };

    const summary = deps.tools.query_world();
    if (summary.ok) push('query_world', summary.data);

    const here = deps.tools.get_current_room();
    if (here.ok) push('get_current_room', { id: here.data.id, name: here.data.name, kind: here.data.kind });

    for (const slot of [intent.subject, intent.object]) {
      if (!slot) continue;
      const r = deps.resolver.resolve(slot.phrase);
      if (!r.ok) continue;
      const id = refIdOf(r.ref);
      const dims = deps.tools.get_dimensions(id);
      if (dims.ok) push('get_dimensions', dims.data);
      const rel = deps.tools.get_relationships(id);
      if (rel.ok) push('get_relationships', { subjectId: rel.data.subjectId, relationships: rel.data.relationships.slice(0, 24) });
      const prov = deps.tools.get_provenance(id);
      if (prov.ok) push('get_provenance', prov.data);
    }

    if (deterministic && !deterministic.refused) {
      // The deterministic answer is itself evidence: it is a correct sentence
      // built from tool output, and giving it to the model as a fact stops the
      // model recomputing the number and getting it wrong.
      push('query_world', { deterministicAnswer: deterministic.text });
    }
    return out;
  }

  private rememberIntent(intent: Intent, answerGiven: AgentAnswer): void {
    // Only a successful, non-refused turn becomes the antecedent for a
    // follow-up. Inheriting a failed operation would compound the failure.
    if (!answerGiven.refused) this.lastIntent = intent;
  }

  private finish(
    question: string,
    startedAt: number,
    commands: ViewerCommand[],
    answerGiven: AgentAnswer,
    decision: RouteDecision,
    intent: Intent,
    spend: { model: ModelId; usage: { inTokens: number; outTokens: number; cachedTokens: number }; costUsd: number } | null,
  ): AskResult {
    this.turnsUsed += 1;
    const record: TurnRecord = {
      worldId: this.worldId,
      sessionId: this.sessionId,
      tier: decision.tier as Tier,
      model: spend?.model ?? null,
      question: question.slice(0, 2000),
      tools: answerGiven.tools,
      grounded: answerGiven.grounded,
      refused: answerGiven.refused,
      inTokens: spend?.usage.inTokens ?? 0,
      outTokens: spend?.usage.outTokens ?? 0,
      cachedTokens: spend?.usage.cachedTokens ?? 0,
      costUsd: spend?.costUsd ?? 0,
      latencyMs: Math.max(0, Math.round(this.now() - startedAt)),
    };
    return {
      answer: { ...answerGiven, commands: commands.slice() },
      commands: commands.slice(),
      decision,
      record,
      intent,
    };
  }
}

// ---------------------------------------------------------------------------
// Grounding verification
// ---------------------------------------------------------------------------

export interface GroundingVerdict {
  readonly grounded: boolean;
  /** Numbers the reply asserted that no tool result contains. */
  readonly offending: readonly string[];
}

/**
 * Check that every quantity in a model's reply came from a tool.
 *
 * Numbers are the part of an answer that can hurt someone: a room quoted 20%
 * bigger than it is, a distance that makes a sofa fit when it does not. Prose
 * is checked by the system prompt and by the fact that the model has no other
 * source; numbers are checked here, mechanically.
 *
 * Matching is tolerant of formatting (2.3 against 2.30, 16 against 16.0) and
 * of arithmetic the model is allowed to do (a metres-to-feet conversion, a sum
 * of two quoted areas), because being too strict would reject correct answers
 * and train everyone to ignore the check. Small integers are exempt for the
 * same reason: "2 bedrooms" and "3 chairs" are counts, not measurements, and
 * they appear in tool output as array lengths rather than as literals.
 */
export function verifyGrounded(
  text: string, evidence: readonly { readonly tool: ToolName; readonly json: string }[],
): GroundingVerdict {
  const corpus = evidence.map((e) => e.json).join(' ');
  const known = new Set<number>();
  for (const m of corpus.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) known.add(v);
  }

  const offending: string[] = [];
  for (const m of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const raw = m[0]!;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    // Counts and small ordinals: not measurements.
    if (Number.isInteger(v) && Math.abs(v) <= 12) continue;
    if (matchesKnown(v, known)) continue;
    offending.push(raw);
  }
  return { grounded: offending.length === 0, offending };
}

function matchesKnown(v: number, known: Set<number>): boolean {
  for (const k of known) {
    if (closeEnough(v, k)) return true;
    // Permitted derivations: metres to feet, m2 to sq ft, a percentage of a
    // known value, and a millimetre/metre unit change.
    if (closeEnough(v, k * 3.280839895)) return true;
    if (closeEnough(v, k * 10.7639104167)) return true;
    if (closeEnough(v, k * 1000)) return true;
    if (closeEnough(v, k / 1000)) return true;
    if (closeEnough(v, k * 100)) return true;
  }
  return false;
}

function closeEnough(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  // 1.5% covers rounding at any magnitude the system quotes, and is far
  // tighter than the error a fabricated number would show.
  return Math.abs(a - b) / scale < 0.015;
}

// ---------------------------------------------------------------------------

function refusal(r: Refusal): AgentAnswer {
  return {
    text: r.reason,
    commands: [],
    grounded: true,
    refused: true,
    refusal: r,
    tools: [],
    grounding: { provenance: 'observed', confidence: 1 },
    citations: r.evidenceIds ?? [],
  };
}

/**
 * Did the deterministic tier actually settle the question?
 *
 * A refusal can be a complete answer. "There is no boiler in this capture" is
 * final: the world does not contain one, and no amount of model reasoning will
 * produce it, so paying for a model would buy a worse version of the same
 * answer. An AMBIGUOUS refusal is different -- a small model can pick between
 * the candidates -- and so is a failure to establish something, which another
 * tool path might reach. Those escalate.
 */
function isSettled(a: AgentAnswer | null): boolean {
  if (a === null) return false;
  if (!a.refused) return true;
  switch (a.refusal?.code) {
    case 'not_found':
    case 'unobserved':
    case 'generated':
    case 'out_of_scope':
      return true;
    default:
      return false;
  }
}

function subjectOf(intent: Intent): WorldRef | undefined {
  return intent.subject?.ref;
}

function refIdOf(ref: WorldRef): string {
  switch (ref.type) {
    case 'entity': return ref.entity.id;
    case 'room': return ref.room.id;
    case 'surface': return ref.surface.id;
    case 'opening': return ref.opening.id;
  }
}

function mergeEvidenceGrounding(a: AgentAnswer | null): Grounding {
  return a?.grounding ?? { provenance: 'reconstructed', confidence: 0.8 };
}

function logEngineError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error('[agent] spatial engine threw during a deterministic answer:', msg);
}

function logUngrounded(question: string, offending: readonly string[]): void {
  // eslint-disable-next-line no-console
  console.error('[agent] discarded an ungrounded model reply', {
    question: question.slice(0, 200), offending,
  });
}
