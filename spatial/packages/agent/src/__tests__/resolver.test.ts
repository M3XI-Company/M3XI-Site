import { describe, expect, it } from 'vitest';

import { hallView, kitchenView, makeAgent, makeTools } from './harness.js';
import {
  ReferenceResolver, SALIENCE_DECAY_PER_TURN, SalienceModel, pronounClass,
} from '../resolver.js';
import { refId } from '../tools.js';

describe('salience model', () => {
  it('decays geometrically and drops what falls below the floor', () => {
    const s = new SalienceModel();
    s.beginTurn();
    s.note('e_sofa', 'entity', 'sofa', 'user');
    expect(s.scoreFor('e_sofa')).toBeCloseTo(1.0, 6);

    s.beginTurn();
    expect(s.scoreFor('e_sofa')).toBeCloseTo(SALIENCE_DECAY_PER_TURN, 6);
    s.beginTurn();
    expect(s.scoreFor('e_sofa')).toBeCloseTo(SALIENCE_DECAY_PER_TURN ** 2, 6);

    for (let i = 0; i < 8; i++) s.beginTurn();
    expect(s.scoreFor('e_sofa')).toBe(0);
    expect(s.all().map((m) => m.id)).not.toContain('e_sofa');
  });

  it('weights a user mention above a tool consultation', () => {
    const s = new SalienceModel();
    s.beginTurn();
    s.note('e_sofa', 'entity', 'sofa', 'user');
    s.note('e_tv', 'entity', 'television', 'consulted');
    expect(s.scoreFor('e_sofa')).toBeGreaterThan(s.scoreFor('e_tv'));
  });

  it('a re-mention refreshes rather than accumulates', () => {
    const s = new SalienceModel();
    s.beginTurn();
    s.note('e_sofa', 'entity', 'sofa', 'user');
    s.beginTurn();
    s.note('e_sofa', 'entity', 'sofa', 'user');
    expect(s.scoreFor('e_sofa')).toBeCloseTo(1.0, 6);
    expect(s.all().filter((m) => m.id === 'e_sofa')).toHaveLength(1);
  });

  it('survives a round trip through JSON, which is how a session persists', () => {
    const s = new SalienceModel();
    s.beginTurn();
    s.note('e_sofa', 'entity', 'sofa', 'user');
    s.beginTurn();
    const revived = SalienceModel.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(revived.currentTurn).toBe(s.currentTurn);
    expect(revived.scoreFor('e_sofa')).toBeCloseTo(s.scoreFor('e_sofa'), 6);
  });

  it('ignores malformed persisted state rather than throwing', () => {
    expect(SalienceModel.fromJSON(null).all()).toEqual([]);
    expect(SalienceModel.fromJSON({ turn: 'x', mentions: [{ id: 5 }, 'nope'] }).all()).toEqual([]);
  });
});

describe('pronoun classification', () => {
  it('separates things, places and groups', () => {
    expect(pronounClass('it')).toBe('any');
    expect(pronounClass('that')).toBe('any');
    expect(pronounClass('there')).toBe('place');
    expect(pronounClass('this room')).toBe('place');
    expect(pronounClass('them')).toBe('plural');
    expect(pronounClass('the sofa')).toBeNull();
  });
});

describe('reference resolver', () => {
  it('resolves "it" to the most recently mentioned thing', () => {
    const { tools, salience } = makeTools();
    const r = new ReferenceResolver(tools, salience);
    salience.beginTurn();
    salience.note('e_tv', 'entity', 'television', 'user');
    salience.beginTurn();
    const res = r.resolve('it');
    expect(res.ok).toBe(true);
    if (res.ok) expect(refId(res.ref)).toBe('e_tv');
  });

  it('lets the live selection beat an older mention', () => {
    const { tools, salience, view } = makeTools();
    const r = new ReferenceResolver(tools, salience);
    salience.beginTurn();
    salience.note('e_tv', 'entity', 'television', 'user');
    salience.beginTurn();
    salience.beginTurn();
    view.selectedEntityId = 'e_coffee_table';
    const res = r.resolve('that');
    expect(res.ok).toBe(true);
    if (res.ok) expect(refId(res.ref)).toBe('e_coffee_table');
  });

  it('resolves "there" to a room, never to an object', () => {
    const { tools, salience } = makeTools();
    const r = new ReferenceResolver(tools, salience);
    salience.beginTurn();
    salience.note('e_sofa', 'entity', 'sofa', 'user');
    const res = r.resolve('there');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ref.type).toBe('room');
  });

  it('uses the current room to disambiguate a shared name', () => {
    const inKitchen = makeTools(kitchenView());
    const r1 = new ReferenceResolver(inKitchen.tools, inKitchen.salience);
    inKitchen.salience.beginTurn();
    const res1 = r1.resolve('window');
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      expect(['o_win_kitchen_w', 'o_win_kitchen_s']).toContain(refId(res1.ref));
    }
  });

  it('reports ambiguity instead of picking when nothing distinguishes', () => {
    // Standing in the bathroom: neither bed has been mentioned, neither is
    // visible and neither is in this room, so nothing favours either.
    const { tools, salience } = makeTools({
      position: [3.5, 1.6, 5.2], orientation: [0, 0, 0, 1], fovRad: (60 * Math.PI) / 180,
    });
    const r = new ReferenceResolver(tools, salience);
    salience.beginTurn();
    const res = r.resolve('bed');
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === 'ambiguous') {
      expect(res.candidates.length).toBeGreaterThan(1);
    } else {
      expect.fail(`expected ambiguity, got ${JSON.stringify(res)}`);
    }
  });

  it('resolves an unnamed thing from gaze alone', () => {
    // Standing in bedroom 2 looking at the bookshelf, which no turn has named.
    const { tools, salience } = makeTools({
      position: [8.5, 1.6, 4.4],
      orientation: [0, 1, 0, 0], // facing +Z, toward the bookshelf wall
      fovRad: (60 * Math.PI) / 180,
    });
    const r = new ReferenceResolver(tools, salience);
    salience.beginTurn();
    const res = r.resolve('that');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.why.join(' ')).toMatch(/in view|pointing/);
    }
  });
});

describe('multi-turn conversation', () => {
  it('inherits the previous operation for a bare follow-up', async () => {
    const { agent, view } = makeAgent();
    const first = await agent.ask('How far is the sofa from the television?', view);
    expect(first.intent.kind).toBe('distance');
    expect(first.answer.text).toMatch(/\d+\.\d+ m/);

    const second = await agent.ask('What about the coffee table?', view);
    expect(second.intent.kind).toBe('distance');
    expect(second.intent.followUp).toBe(true);
    // The sofa is kept as the subject; the coffee table replaces the object.
    expect(second.intent.subject?.phrase).toBe('sofa');
    expect(second.intent.object?.phrase).toBe('coffee table');
    expect(second.decision.tier).toBe('deterministic');
    expect(second.answer.text).toMatch(/sofa/i);
    expect(second.answer.text).toMatch(/coffee table/i);
  });

  it('resolves "that" against what the previous answer was about', async () => {
    const { agent, view } = makeAgent();
    await agent.ask('Where is the bookshelf?', view);
    const second = await agent.ask('How far is that from the desk?', view);
    expect(second.decision.tier).toBe('deterministic');
    expect(second.answer.text).toMatch(/bookshelf/i);
    expect(second.answer.text).toMatch(/desk/i);
  });

  it('carries the subject across a change of question type', async () => {
    const { agent, view } = makeAgent();
    await agent.ask('Where is the wardrobe?', view);
    const second = await agent.ask('How do you know?', view);
    expect(second.intent.kind).toBe('provenance');
    expect(second.decision.tier).toBe('deterministic');
    expect(second.answer.text).toMatch(/wardrobe/i);
  });

  it('moves the camera and answers the next question from the new room', async () => {
    const { agent, view } = makeAgent();
    const move = await agent.ask('Show me bedroom 2', view);
    expect(move.commands.some((c) => c.kind === 'moveCamera')).toBe(true);
    expect(view.roomId).toBe('r_bed2');

    const next = await agent.ask('What is in here?', view);
    expect(next.decision.tier).toBe('deterministic');
    expect(next.answer.text).toMatch(/bookshelf|desk|single bed/i);
  });

  it('does not let a failed turn become the antecedent of the next one', async () => {
    const { agent, view } = makeAgent();
    await agent.ask('How far is the sofa from the television?', view);
    await agent.ask('Where is the boiler?', view);
    const third = await agent.ask('What about the coffee table?', view);
    // The boiler turn was refused, so the follow-up inherits the distance
    // question rather than compounding the failure.
    expect(third.intent.kind).toBe('distance');
    expect(third.answer.text).toMatch(/coffee table/i);
  });
});
