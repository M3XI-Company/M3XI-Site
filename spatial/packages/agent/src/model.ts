/**
 * The model boundary.
 *
 * Everything above this line is deterministic and testable; everything below
 * it is a network call to somebody else's GPU. Keeping that boundary narrow is
 * what makes the rest of the agent verifiable without a key, and it is what
 * lets a deployment swap Haiku for Gemini without touching the router.
 *
 * A model in this system is never a source of facts. It receives tool results
 * that are already grounded and its job is phrasing, disambiguation and
 * deciding which tool to call next. That is why `ModelRequest` carries
 * structured `toolResults` rather than a rendered transcript: the caller can
 * assert afterwards that every number in the reply appeared in the input.
 */

import type { ModelId, Usage } from './pricing.js';
import type { ToolName } from './types.js';

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ModelToolCall {
  readonly name: ToolName;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly model: ModelId;
  /**
   * Stable across every turn of every session for a given deployment. Marked
   * cacheable; if this string varies per turn the cache never hits and the
   * cost model is wrong by about a third.
   */
  readonly system: string;
  /**
   * Stable across every turn of ONE session: the scene-graph digest for this
   * world. Also cacheable, and the larger of the two.
   */
  readonly context: string;
  readonly messages: readonly ModelMessage[];
  /** Grounded facts, already computed. The model may phrase, not invent. */
  readonly toolResults: readonly { readonly tool: ToolName; readonly json: string }[];
  readonly maxOutputTokens: number;
  /** Tools the model is permitted to request this turn. */
  readonly allowedTools: readonly ToolName[];
}

export interface ModelResponse {
  readonly text: string;
  readonly usage: Usage;
  readonly stopReason: 'end' | 'length' | 'tool_use' | 'refusal';
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelClient {
  /** Must not throw for ordinary provider errors; surface them as a refusal. */
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/**
 * Token estimate used for pre-flight spend checks and by the fake client.
 *
 * Four characters per token is the usual English approximation and is close
 * enough for a cap that exists to stop runaway spend, not to bill a customer.
 * The real token counts written to wv_ai_turn always come from the provider.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function requestTokens(req: ModelRequest): { cached: number; fresh: number } {
  const cached = estimateTokens(req.system) + estimateTokens(req.context);
  let fresh = 0;
  for (const m of req.messages) fresh += estimateTokens(m.content);
  for (const t of req.toolResults) fresh += estimateTokens(t.json) + 4;
  return { cached, fresh };
}

// ---------------------------------------------------------------------------
// Deterministic fake
// ---------------------------------------------------------------------------

export interface FakeModelOptions {
  /**
   * Turns the fake has already seen for this prefix. A second call with the
   * same system+context reports its prefix as cached, which is what a real
   * provider does and what the cost tests need to observe.
   */
  readonly primedPrefixes?: Set<string>;
  /** Replies to hand back in order. Exhausting the list falls back to a digest. */
  readonly scripted?: readonly Partial<ModelResponse>[];
  /** Tokens of output to claim when a scripted reply does not say. */
  readonly outputTokens?: number;
}

/**
 * A ModelClient that never leaves the process.
 *
 * It is not a mock in the "returns undefined" sense: it produces a reply that
 * is a deterministic function of its input, reports realistic token counts and
 * honours prefix caching, so the router, the cost accounting and the grounding
 * checks all get exercised end to end. The only thing it cannot exercise is
 * whether a real model writes good English, which is the one thing a test
 * could not assert anyway.
 */
export class FakeModelClient implements ModelClient {
  readonly calls: ModelRequest[] = [];
  private readonly primed: Set<string>;
  private readonly scripted: Partial<ModelResponse>[];
  private readonly outputTokens: number;

  constructor(opts: FakeModelOptions = {}) {
    this.primed = opts.primedPrefixes ?? new Set<string>();
    this.scripted = [...(opts.scripted ?? [])];
    this.outputTokens = opts.outputTokens ?? 120;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const key = `${req.model}|${req.system.length}|${req.context.length}`;
    const wasPrimed = this.primed.has(key);
    this.primed.add(key);

    const { cached, fresh } = requestTokens(req);
    const next = this.scripted.shift();

    const text = next?.text ?? renderDigest(req);
    // The prefix is part of inTokens either way; what changes is the rate it
    // is billed at. A first call writes it; every later call reads it.
    const usage: Usage = next?.usage ?? {
      inTokens: cached + fresh,
      cachedTokens: wasPrimed ? cached : 0,
      cacheWriteTokens: wasPrimed ? 0 : cached,
      outTokens: next?.text ? estimateTokens(next.text) : this.outputTokens,
    };
    return {
      text,
      usage,
      stopReason: next?.stopReason ?? (next?.toolCalls?.length ? 'tool_use' : 'end'),
      ...(next?.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  }
}

/**
 * The fake's default reply: a faithful restatement of the tool results it was
 * given. Faithful matters -- the grounding assertion in agent.ts checks that
 * every number in a reply came from a tool, and a fake that invented numbers
 * would make that assertion untestable.
 */
function renderDigest(req: ModelRequest): string {
  if (req.toolResults.length === 0) {
    const last = req.messages[req.messages.length - 1];
    return `The capture does not establish that. (no tool evidence for: ${last?.content ?? ''})`;
  }
  const parts = req.toolResults.map((t) => `${t.tool}: ${t.json}`);
  return parts.join('\n');
}

/**
 * A client that always fails, for testing the path where the provider is down.
 * A failed model call must degrade to a grounded refusal, never to a guess.
 */
export class UnavailableModelClient implements ModelClient {
  readonly reason: string;

  constructor(reason = 'model provider unavailable') {
    this.reason = reason;
  }

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    // Zero usage, not a thrown error: a provider outage still produces a turn
    // row, and that row must say the turn cost nothing and answered nothing.
    return {
      text: '',
      usage: { inTokens: 0, outTokens: 0, cachedTokens: 0 },
      stopReason: 'refusal',
    };
  }
}
