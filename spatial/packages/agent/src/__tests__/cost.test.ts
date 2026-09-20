import { describe, expect, it } from 'vitest';

import { makeAgent } from './harness.js';
import {
  DEFAULT_CATALOGUE, DEFAULT_ROUTING, computeCost, estimateTurnCost, priceOf,
} from '../pricing.js';
import { FakeModelClient, estimateTokens } from '../model.js';

describe('cost arithmetic', () => {
  it('prices a plain call at the published rates', () => {
    const haiku = DEFAULT_CATALOGUE['claude-haiku-4.5'];
    const c = computeCost(haiku, { inTokens: 1_000_000, outTokens: 1_000_000 });
    expect(c.freshInputUsd).toBeCloseTo(1.0, 10);
    expect(c.outputUsd).toBeCloseTo(5.0, 10);
    expect(c.totalUsd).toBeCloseTo(6.0, 10);
  });

  it('charges every model in the catalogue at its own rate', () => {
    const cases: Array<[keyof typeof DEFAULT_CATALOGUE, number, number]> = [
      ['claude-haiku-4.5', 1.0, 5.0],
      ['claude-sonnet-5', 2.0, 10.0],
      ['claude-opus-5', 5.0, 25.0],
      ['gemini-3.1-flash-lite', 0.25, 1.5],
      ['llama-3.3-70b-deepinfra', 0.10, 0.32],
    ];
    for (const [id, inRate, outRate] of cases) {
      const p = DEFAULT_CATALOGUE[id];
      expect(p.inputPerMTok, id).toBe(inRate);
      expect(p.outputPerMTok, id).toBe(outRate);
      const c = computeCost(p, { inTokens: 100_000, outTokens: 10_000 });
      expect(c.totalUsd, id).toBeCloseTo(0.1 * inRate + 0.01 * outRate, 10);
    }
  });

  it('cached input costs a tenth on Claude-class models', () => {
    const p = DEFAULT_CATALOGUE['claude-sonnet-5'];
    const c = computeCost(p, { inTokens: 1_000_000, cachedTokens: 1_000_000, outTokens: 0 });
    expect(c.cachedInputUsd).toBeCloseTo(0.2, 10);
    expect(c.freshInputUsd).toBe(0);
    expect(c.uncachedTotalUsd).toBeCloseTo(2.0, 10);
    expect(c.savingPct).toBeCloseTo(90, 6);
  });

  it('a cache write costs a quarter more than a fresh token', () => {
    const p = DEFAULT_CATALOGUE['claude-haiku-4.5'];
    const c = computeCost(p, {
      inTokens: 1_000_000, cacheWriteTokens: 1_000_000, outTokens: 0,
    });
    expect(c.cacheWriteUsd).toBeCloseTo(1.25, 10);
    expect(c.freshInputUsd).toBe(0);
  });

  it('bills each input token exactly once, never as both input and cache write', () => {
    const p = DEFAULT_CATALOGUE['claude-haiku-4.5'];
    const c = computeCost(p, {
      inTokens: 3_000, cacheWriteTokens: 3_000, outTokens: 0,
    });
    // 3,000 written, 0 fresh. Double-charging would give 1.25x + 1x = 2.25x.
    expect(c.totalUsd).toBeCloseTo(3_000 * (1 / 1_000_000) * 1.0 * 1.25, 12);
  });

  it('never claims a cache discount for a model that has no cache', () => {
    const p = DEFAULT_CATALOGUE['llama-3.3-70b-deepinfra'];
    const c = computeCost(p, { inTokens: 100_000, cachedTokens: 100_000, outTokens: 0 });
    expect(c.totalUsd).toBeCloseTo(0.01, 10);
    expect(c.savingUsd).toBeCloseTo(0, 10);
  });

  it('cached tokens can never exceed input tokens', () => {
    const p = DEFAULT_CATALOGUE['claude-haiku-4.5'];
    const c = computeCost(p, { inTokens: 100, cachedTokens: 10_000, outTokens: 0 });
    expect(c.cachedInputUsd).toBeCloseTo(100 * (1 / 1_000_000) * 1.0 * 0.1, 12);
    expect(c.freshInputUsd).toBe(0);
  });

  it('ignores negative and non-finite token counts rather than crediting them', () => {
    const p = DEFAULT_CATALOGUE['claude-haiku-4.5'];
    const c = computeCost(p, {
      inTokens: -5, outTokens: Number.NaN, cachedTokens: -1, cacheWriteTokens: Infinity,
    });
    expect(c.totalUsd).toBe(0);
  });

  /**
   * The headline claim in the cost model: caching the system prompt and the
   * scene-graph context saves roughly 35% across a realistic session.
   *
   * The realised saving depends entirely on the ratio of cacheable prefix to
   * per-turn fresh input, so the test states that ratio rather than hiding it.
   * At roughly equal parts -- a 3,000-token prefix against 3,000 tokens of
   * question plus tool results, which is what an escalated turn on this world
   * actually looks like -- the saving lands near a third. A conversation with
   * lighter tool results saves MORE, never less, so 35% is a floor in practice
   * and this test pins the floor rather than an optimistic best case.
   */
  function sessionSaving(perTurnFresh: number, turns = 8): number {
    const p = DEFAULT_CATALOGUE['claude-haiku-4.5'];
    const prefix = DEFAULT_ROUTING.cachedPrefixTokens; // system + scene graph
    const perTurnOut = 160;
    let cached = 0;
    let uncached = 0;
    for (let i = 0; i < turns; i++) {
      const c = computeCost(p, {
        inTokens: prefix + perTurnFresh,
        cachedTokens: i === 0 ? 0 : prefix,
        cacheWriteTokens: i === 0 ? prefix : 0,
        outTokens: perTurnOut,
      });
      cached += c.totalUsd;
      uncached += c.uncachedTotalUsd;
    }
    return (uncached - cached) / uncached;
  }

  it('prefix caching saves about a third over a realistic multi-turn session', () => {
    const balanced = sessionSaving(DEFAULT_ROUTING.cachedPrefixTokens);
    expect(balanced).toBeGreaterThan(0.30);
    expect(balanced).toBeLessThan(0.40);
    // eslint-disable-next-line no-console
    console.log(`\n  PREFIX CACHE SAVING (prefix == fresh, 8 turns): ${(balanced * 100).toFixed(1)}%\n`);
  });

  it('saves more, never less, as the per-turn payload shrinks', () => {
    // Monotonic in the right direction: the cheaper the turn's own tokens, the
    // larger the share of the bill the cached prefix accounts for.
    expect(sessionSaving(250)).toBeGreaterThan(sessionSaving(3_000));
    expect(sessionSaving(3_000)).toBeGreaterThan(sessionSaving(12_000));
    expect(sessionSaving(250)).toBeLessThan(0.9);
  });

  it('a one-turn session saves nothing, because the cache is only written', () => {
    expect(sessionSaving(3_000, 1)).toBeLessThan(0);
  });

  it('estimates a turn before it happens, and the estimate bounds the truth', () => {
    const est = estimateTurnCost(DEFAULT_ROUTING, 'claude-haiku-4.5', {
      freshInputTokens: 400, maxOutputTokens: 400, primed: true,
    });
    const actual = computeCost(priceOf(DEFAULT_ROUTING, 'claude-haiku-4.5'), {
      inTokens: DEFAULT_ROUTING.cachedPrefixTokens + 400,
      cachedTokens: DEFAULT_ROUTING.cachedPrefixTokens,
      outTokens: 150,
    });
    expect(est).toBeGreaterThan(actual.totalUsd);
  });
});

describe('per-turn accounting', () => {
  it('records zero cost and no model on a deterministic turn', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('How big is the kitchen?', view);
    expect(res.record.tier).toBe('deterministic');
    expect(res.record.model).toBeNull();
    expect(res.record.costUsd).toBe(0);
    expect(res.record.inTokens).toBe(0);
    expect(res.record.outTokens).toBe(0);
    expect(res.record.tools.length).toBeGreaterThan(0);
  });

  it('records tier, model, tokens, cached tokens, cost and latency on an escalation', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('Why is the bathroom ceiling marked as uncertain?', view);
    expect(res.record.tier).toBe('large');
    expect(res.record.model).toBe(DEFAULT_ROUTING.large);
    expect(res.record.inTokens).toBeGreaterThan(0);
    expect(res.record.outTokens).toBeGreaterThan(0);
    expect(res.record.costUsd).toBeGreaterThan(0);
    expect(res.record.latencyMs).toBeGreaterThanOrEqual(0);
    // First escalation of a session writes the cache rather than reading it.
    expect(res.record.cachedTokens).toBe(0);
  });

  it('reports cached tokens once the prefix is primed', async () => {
    const model = new FakeModelClient();
    const { agent, view } = makeAgent({ model });
    await agent.ask('Why is the bathroom ceiling marked as uncertain?', view);
    const second = await agent.ask('Should I be worried about the bathroom ceiling?', view);
    expect(second.record.tier).toBe('large');
    // Exactly the cacheable prefix: system prompt plus scene-graph digest.
    expect(second.record.cachedTokens).toBe(agent.contextTokens);
    expect(second.record.cachedTokens).toBeGreaterThan(500);
    expect(model.calls[0]!.system).toBe(model.calls[1]!.system);
    expect(model.calls[0]!.context).toBe(model.calls[1]!.context);
  });

  it('the cacheable prefix is byte-identical across turns, or the cache never hits', async () => {
    const model = new FakeModelClient();
    const { agent, view } = makeAgent({ model });
    await agent.ask('Why is the bathroom ceiling uncertain?', view);
    await agent.ask('Show me bedroom 2', view);
    await agent.ask('Should I worry about that?', view);
    const prefixes = new Set(model.calls.map((c) => `${c.system}\u0000${c.context}`));
    expect(prefixes.size).toBe(1);
  });

  it('the scene context is a meaningful share of the prompt, which is why caching matters', () => {
    const { agent } = makeAgent();
    expect(agent.contextTokens).toBeGreaterThan(500);
    expect(estimateTokens('How big is the kitchen?')).toBeLessThan(20);
  });

  it('accumulates session cost across turns', async () => {
    const { agent, view } = makeAgent();
    const first = await agent.ask('Why is the bathroom ceiling uncertain?', view);
    expect(first.record.costUsd).toBeGreaterThan(0);
    expect(agent.sessionCostUsd).toBeCloseTo(first.record.costUsd, 12);

    const second = await agent.ask('Should I be worried about the layout?', view);
    expect(second.record.costUsd).toBeGreaterThan(0);
    expect(agent.sessionCostUsd).toBeCloseTo(first.record.costUsd + second.record.costUsd, 12);

    // A deterministic turn in between adds nothing at all.
    const third = await agent.ask('How big is the kitchen?', view);
    expect(third.record.costUsd).toBe(0);
  });

  it('refuses to escalate when the estimate alone would cross the cap', async () => {
    // The cap is below the cost of a single escalated turn, so the guard has
    // to fire on the ESTIMATE, before the provider is called at all.
    const { agent, view, model } = makeAgent({ config: { sessionCostCapUsd: 0.001 } });
    const res = await agent.ask('Why is the bathroom ceiling uncertain?', view);
    expect(res.decision.tier).toBe('deterministic');
    expect(res.decision.reason).toMatch(/cap/);
    expect(res.record.costUsd).toBe(0);
    expect(model.calls).toHaveLength(0);
  });

  /**
   * The session cost figures quoted to the business, derived rather than
   * asserted from a spreadsheet. A "session class" is a whole conversation,
   * not one turn.
   */
  it('prices the three session classes', () => {
    const prefix = DEFAULT_ROUTING.cachedPrefixTokens;
    const price = (id: keyof typeof DEFAULT_CATALOGUE, turns: number): number => {
      const p = DEFAULT_CATALOGUE[id];
      let total = 0;
      for (let i = 0; i < turns; i++) {
        total += computeCost(p, {
          inTokens: prefix + 1_200,
          cachedTokens: i === 0 ? 0 : prefix,
          cacheWriteTokens: i === 0 ? prefix : 0,
          outTokens: 200,
        }).totalUsd;
      }
      return total;
    };

    // A "session class" is a whole conversation, not a turn. The shapes below
    // are what the three classes look like in this system: a tier-1 session is
    // a short clarifying exchange, a tier-2 session is a long one.
    const tier0 = 0;
    const tier1 = price('claude-haiku-4.5', 3);
    const tier2 = price('claude-sonnet-5', 8);

    expect(tier0).toBe(0);
    expect(tier1).toBeGreaterThan(0.006);
    expect(tier1).toBeLessThan(0.013);
    expect(tier2).toBeGreaterThan(0.040);
    expect(tier2).toBeLessThan(0.055);

    // eslint-disable-next-line no-console
    console.log(
      `\n  SESSION COST BY CLASS (${prefix}-token cached prefix, 1200 fresh in / 200 out per turn)`
      + `\n    tier 0 deterministic, any number of turns : $0.000000`
      + `\n    tier 1 haiku-4.5, 3 turns                : $${tier1.toFixed(6)}  ($${(tier1 / 3).toFixed(6)}/turn)`
      + `\n    tier 2 sonnet-5,  8 turns                : $${tier2.toFixed(6)}  ($${(tier2 / 8).toFixed(6)}/turn)\n`,
    );
  });
});
