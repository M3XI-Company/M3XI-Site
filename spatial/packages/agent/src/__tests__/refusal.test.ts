import { describe, expect, it } from 'vitest';

import { isDefensible, refusalReason } from '@m3xi/spatial-engine';

import { FLAT, makeAgent, makeTools } from './harness.js';
import { verifyGrounded } from '../agent.js';
import { FakeModelClient, UnavailableModelClient } from '../model.js';
import { World } from '@m3xi/spatial-engine';
import { Agent } from '../agent.js';

describe('refusal on unobserved and generated geometry', () => {
  it('the fixture really does contain a generated volume', () => {
    const gen = FLAT.regions.filter((r) => r.provenance === 'generated');
    expect(gen.map((r) => r.id)).toContain('rg_bed1_far_corner');
  });

  it('refuses to quote an area that reaches into a generated region', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('How big is bedroom 1?', view);
    expect(res.decision.tier).toBe('deterministic');
    expect(res.answer.text).toMatch(/won't quote|no camera|not observe|filled in/i);
    // The number itself is never printed as a fact.
    expect(res.answer.text).not.toMatch(/13\.9|14\.0 m²/);
  });

  it('quotes the neighbouring bedroom, which was fully observed', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('How big is bedroom 2?', view);
    expect(res.answer.text).toMatch(/12\.\d m²/);
    expect(res.answer.refused).toBe(false);
  });

  it('marks the unobserved volume on screen when it refuses', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('How big is bedroom 1?', view);
    const overlay = res.commands.find((c) => c.kind === 'regionOverlay');
    expect(overlay).toBeTruthy();
    if (overlay && overlay.kind === 'regionOverlay') {
      expect(overlay.regionIds).toContain('rg_bed1_far_corner');
    }
  });

  it('a measurement into the generated corner is flagged undefendable by the engine', () => {
    const { tools } = makeTools();
    const q = tools.measure_distance('e_wardrobe', [10.3, 1.0, 2.7]);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(isDefensible(q.data)).toBe(false);
    expect(refusalReason(q.data)).toMatch(/generated|no camera|observ/i);
  });

  it('says a material question is outside what a capture can establish', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('Is the kitchen window double glazed?', view);
    expect(res.answer.text).toMatch(/not something a capture can establish/i);
    expect(res.answer.text).toMatch(/survey|EPC/);
  });

  it('reports absence rather than inventing a plausible fixture', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('Where is the boiler?', view);
    expect(res.answer.refused).toBe(true);
    expect(res.answer.refusal?.code).toBe('not_found');
    expect(res.record.grounded).toBe(true);
    expect(res.record.refused).toBe(true);
  });

  it('distinguishes an inferred object from an observed one when asked', async () => {
    const { agent, view } = makeAgent();
    const res = await agent.ask('Was the chest of drawers actually measured?', view);
    expect(res.answer.text).toMatch(/estimated|inferred|context/i);
    expect(res.answer.text).not.toMatch(/camera saw it directly/);
  });

  it('logs grounded and refused on every turn', async () => {
    const { agent, view } = makeAgent();
    const rows = [
      await agent.ask('How big is the kitchen?', view),
      await agent.ask('Where is the boiler?', view),
      await agent.ask('How big is bedroom 1?', view),
    ];
    for (const r of rows) {
      expect(typeof r.record.grounded).toBe('boolean');
      expect(typeof r.record.refused).toBe('boolean');
      expect(r.record.worldId).toBe(FLAT.id);
      expect(r.record.sessionId).toBe('sess_test');
      expect(r.record.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(rows[1]!.record.refused).toBe(true);
    expect(rows[0]!.record.refused).toBe(false);
  });
});

describe('grounding enforcement on model replies', () => {
  it('accepts a reply whose numbers all come from tool output', () => {
    const v = verifyGrounded('The kitchen is 20.2 m², about 218 sq ft.', [
      { tool: 'measure_area', json: '{"value":20.23,"tolerance":2.5}' },
    ]);
    expect(v.grounded).toBe(true);
  });

  it('rejects a reply containing a number no tool produced', () => {
    const v = verifyGrounded('The kitchen is 31.7 m² and the boiler is 12 years old.', [
      { tool: 'measure_area', json: '{"value":20.23,"tolerance":2.5}' },
    ]);
    expect(v.grounded).toBe(false);
    expect(v.offending).toContain('31.7');
  });

  it('allows a unit conversion the model is entitled to do', () => {
    const v = verifyGrounded('That is 2.44 m, which is 8 ft.', [
      { tool: 'measure_distance', json: '{"value":2.44}' },
    ]);
    expect(v.grounded).toBe(true);
  });

  it('does not treat small counts as measurements', () => {
    const v = verifyGrounded('There are 4 dining chairs and 2 bedrooms.', [
      { tool: 'find_entities', json: '[]' },
    ]);
    expect(v.grounded).toBe(true);
  });

  it('discards an ungrounded model answer instead of shipping it', async () => {
    const model = new FakeModelClient({
      scripted: [{ text: 'The loft conversion adds 41.8 m² and was finished in 2019.' }],
    });
    const agent = new Agent({
      world: World.fromDocument(FLAT),
      worldId: FLAT.id,
      sessionId: 'sess_test',
      model,
      idFactory: () => 'cmd_1',
    });
    const res = await agent.ask('Why is the bathroom ceiling marked as uncertain?', {
      position: [3.5, 1.6, 5.2], orientation: [0, 0, 0, 1], fovRad: 1,
    });
    expect(res.decision.tier).toBe('large');
    expect(res.answer.text).not.toMatch(/loft conversion/);
    expect(res.record.grounded).toBe(false);
    // The turn still cost money and the row still records it.
    expect(res.record.costUsd).toBeGreaterThan(0);
  });

  it('falls back to a grounded refusal when the provider is unreachable', async () => {
    const agent = new Agent({
      world: World.fromDocument(FLAT),
      worldId: FLAT.id,
      sessionId: 'sess_test',
      model: new UnavailableModelClient(),
      idFactory: () => 'cmd_1',
    });
    const res = await agent.ask('Why is the bathroom ceiling marked as uncertain?', {
      position: [3.5, 1.6, 5.2], orientation: [0, 0, 0, 1], fovRad: 1,
    });
    expect(res.answer.text).toMatch(/could not reach|does not establish|estimated/i);
    expect(res.record.costUsd).toBe(0);
    expect(res.record.inTokens).toBe(0);
  });
});
