import { describe, expect, it, vi } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { AGENT_CONTRACT_VERSION, AgentContractError } from '../agent/contract.js';
import type {
  AgentAction, AgentAnswer, AgentPort, AgentQuestion, ViewerContext,
} from '../agent/contract.js';
import { AgentBridge, type ViewerCommands } from '../agent/bridge.js';
import { StubAgent } from '../agent/stub.js';
import { summariseFrames } from '../perf/instrument.js';

const world = World.fromDocument(FLAT);
const agent = new StubAgent(world, { locale: 'en-GB' });

function context(overrides: Partial<ViewerContext> = {}): ViewerContext {
  return {
    worldId: FLAT.id,
    worldVersion: FLAT.version,
    mode: 'visitor',
    locale: 'en-GB',
    pose: { position: [5.3, 1.6, 1.0], yaw: 0, pitch: 0 },
    visibleRoomIds: ['r_hall'],
    visibleEntityIds: [],
    provenance: 'reconstructed',
    activeMeasurements: [],
    loadedChunkKeys: [],
    ...overrides,
  };
}

const ask = (text: string, ctx: ViewerContext = context()): Promise<AgentAnswer> =>
  agent.ask({ text, context: ctx, history: [] });

describe('the stub agent answers from the spatial engine', () => {
  it('declares the contract version the viewer compiles against', () => {
    expect(agent.contractVersion).toBe(AGENT_CONTRACT_VERSION);
    expect(agent.capabilities.canAnswer).toBe(true);
  });

  it('gives a room area with its standard and tolerance, never a bare number', async () => {
    const answer = await ask('how big is the kitchen?');
    expect(answer.text).toContain('m²');
    expect(answer.text).toContain('±');
    expect(answer.text).toContain('RICS Code of Measuring Practice');
    const citation = answer.citations.find((c) => c.id === 'r_kitchen');
    expect(citation?.quantity?.standard).toBe('RICS-COMP-GIA');
  });

  it('walks the camera to the room it just described', async () => {
    const answer = await ask('how big is the kitchen?');
    const move = answer.actions.find((a) => a.kind === 'camera.goTo');
    expect(move).toMatchObject({ kind: 'camera.goTo', target: { kind: 'room', roomId: 'r_kitchen' } });
  });

  it('prefers the longest matching room name', async () => {
    const answer = await ask('how big is bedroom 2?');
    expect(answer.citations[0]?.id).toBe('r_bed2');
  });

  it('falls back to the room the visitor is standing in', async () => {
    const answer = await ask('how big is this room?', context({ roomId: 'r_kitchen' }));
    expect(answer.text).toContain('Kitchen/diner');
    expect(answer.text).toContain('m²');
  });

  it('refuses a room area that leans on an unsurveyed corner', async () => {
    // Bedroom 1's floor area includes the volume behind the wardrobe that no
    // camera saw, so the honest answer is a refusal with the reason, not a
    // number with a footnote.
    const answer = await ask('how big is bedroom 1?');
    expect(answer.refusal?.scope).toBe('measurement');
    expect(answer.refusal?.because).toContain('rg_bed1_far_corner');
    expect(answer.text).toContain('no camera observed');
  });

  it('measures between two named things', async () => {
    const answer = await ask('how far is the sofa from the television?');
    expect(answer.text).toMatch(/\d+\.\d+ m/);
    expect(answer.text).toContain('±');
    expect(answer.actions.some((a) => a.kind === 'measure.show')).toBe(true);
    expect(answer.actions.some((a) => a.kind === 'highlight.set')).toBe(true);
  });

  it('leads with the refusal when a measurement is not defensible', async () => {
    const answer = await ask('how tall is the bathroom ceiling?');
    expect(answer.refusal?.scope).toBe('measurement');
    expect(answer.text).toContain('never in view');
    // The figure is not quoted as fact anywhere in the sentence.
    expect(answer.text).not.toMatch(/2\.40 m/);
  });

  it('runs a fit test and draws the footprints when it passes', async () => {
    const answer = await ask('will a 0.5 m wardrobe fit in bedroom 1?');
    const overlay = answer.actions.find((a) => a.kind === 'measure.show');
    if (answer.text.startsWith('Yes')) {
      expect(overlay).toBeDefined();
      if (overlay?.kind === 'measure.show') {
        expect(overlay.overlay.footprints.length).toBeGreaterThan(0);
      }
    }
    expect(answer.text).toContain('m²');
  });

  it('says why a fit fails instead of just saying no', async () => {
    const answer = await ask('will a 9 m wardrobe fit in bedroom 1?');
    expect(answer.text).toContain('does not fit');
    expect(answer.text.length).toBeGreaterThan(60);
  });

  it('asks for a size rather than guessing one', async () => {
    const answer = await ask('will a wardrobe fit in bedroom 1?');
    expect(answer.text).toContain('How big');
    expect(answer.suggestions?.length).toBeGreaterThan(0);
  });

  it('names the assumed depth and height by naming the piece it tested', async () => {
    const answer = await ask('will a king size bed fit in bedroom 1?');
    expect(answer.text).toContain('king-size bed');
  });

  it('navigates on request and warns about a room with a gap', async () => {
    const answer = await ask('take me to bedroom 1');
    expect(answer.actions[0]).toMatchObject({ kind: 'camera.goTo' });
    expect(answer.text).toContain('not fully surveyed');
  });

  it('lists room contents and flags the estimated ones', async () => {
    const answer = await ask("what's in bedroom 1?");
    expect(answer.text).toContain('double bed');
    expect(answer.text).toContain('chest of drawers');
    expect(answer.text).toContain('estimated');
    expect(answer.actions.some((a) => a.kind === 'highlight.set')).toBe(true);
  });

  it('reports what was not surveyed when asked', async () => {
    const answer = await ask('what did the cameras not see?');
    expect(answer.text).toContain('occluded by the wardrobe');
    expect(answer.citations.some((c) => c.kind === 'region')).toBe(true);
  });

  it('counts rooms', async () => {
    const answer = await ask('how many bedrooms are there?');
    expect(answer.text).toContain('2 bedrooms');
  });

  it('offers help rather than hallucinating on an unrelated question', async () => {
    const answer = await ask('what is the council tax band?');
    expect(answer.citations).toHaveLength(0);
    expect(answer.text).toContain('I can tell you');
  });
});

// ---------------------------------------------------------------------------

function recorder(mode: ViewerCommands['mode'] = 'visitor') {
  const calls: string[] = [];
  const commands: ViewerCommands = {
    mode,
    context: () => context(),
    goTo: async (t) => { calls.push(`goTo:${JSON.stringify(t)}`); return t.kind !== 'entity'; },
    lookAt: (t) => { calls.push(`lookAt:${t.kind}`); return true; },
    viewpoint: (id) => { calls.push(`viewpoint:${id}`); return true; },
    setHighlight: (ids) => { calls.push(`highlight:${ids.join(',')}`); return ids.length > 0; },
    clearHighlight: () => { calls.push('clearHighlight'); },
    showMeasurement: (o) => { calls.push(`measure:${o.id}`); return true; },
    clearMeasurements: () => { calls.push('clearMeasure'); },
    openPanel: (p) => { calls.push(`panel:${p}`); return mode !== 'embed'; },
    emphasiseRooms: (r) => { calls.push(`emphasise:${r.join(',')}`); return true; },
    announce: (t) => { calls.push(`announce:${t.slice(0, 20)}`); },
  };
  return { calls, commands };
}

function port(answer: AgentAnswer, version: number = AGENT_CONTRACT_VERSION): AgentPort {
  return {
    contractVersion: version as typeof AGENT_CONTRACT_VERSION,
    capabilities: { canAnswer: true, canStream: false, emits: [] },
    ask: async (_q: AgentQuestion) => answer,
  };
}

describe('the bridge between the agent and the viewer', () => {
  it('refuses an agent built against a different contract version', () => {
    const { commands } = recorder();
    expect(() => new AgentBridge(port({ text: '', citations: [], actions: [] }, 99), commands))
      .toThrow(AgentContractError);
  });

  it('applies actions in order and reports each outcome', async () => {
    const { calls, commands } = recorder();
    const actions: AgentAction[] = [
      { kind: 'camera.goTo', target: { kind: 'room', roomId: 'r_bed1' } },
      { kind: 'highlight.set', entityIds: ['e_wardrobe'] },
      { kind: 'ui.open', panel: 'text' },
    ];
    const bridge = new AgentBridge(port({ text: 'ok', citations: [], actions }), commands);
    const { outcomes } = await bridge.ask('anything');
    expect(outcomes.map((o) => o.applied)).toEqual([true, true, true]);
    expect(calls[0]).toContain('goTo');
    expect(calls[1]).toContain('highlight:e_wardrobe');
    expect(calls[2]).toBe('panel:text');
  });

  it('keeps going when one action is declined', async () => {
    const { calls, commands } = recorder();
    const actions: AgentAction[] = [
      { kind: 'camera.goTo', target: { kind: 'entity', entityId: 'e_sofa' } }, // recorder says no
      { kind: 'highlight.set', entityIds: ['e_sofa'] },
    ];
    const bridge = new AgentBridge(port({ text: 'ok', citations: [], actions }), commands);
    const { outcomes } = await bridge.ask('anything');
    expect(outcomes[0]!.applied).toBe(false);
    expect(outcomes[0]!.declined).toContain('no walkable route');
    expect(outcomes[1]!.applied).toBe(true);
    expect(calls).toContain('highlight:e_sofa');
  });

  it('declines an action kind it has never heard of instead of crashing', async () => {
    const { commands } = recorder();
    const actions = [{ kind: 'camera.teleportThroughWall' } as unknown as AgentAction];
    const bridge = new AgentBridge(port({ text: 'ok', citations: [], actions }), commands);
    const { outcomes } = await bridge.ask('anything');
    expect(outcomes[0]!.applied).toBe(false);
    expect(outcomes[0]!.declined).toContain('unsupported action');
  });

  it('caps how much one answer may do to the view', async () => {
    const { commands } = recorder();
    const actions: AgentAction[] = Array.from({ length: 12 }, () => ({
      kind: 'highlight.clear' as const,
    }));
    const bridge = new AgentBridge(port({ text: 'ok', citations: [], actions }), commands);
    const { outcomes } = await bridge.ask('anything');
    expect(outcomes.filter((o) => o.applied)).toHaveLength(8);
    expect(outcomes[8]!.declined).toContain('more than 8 actions');
  });

  it('declines a panel the current mode does not offer', async () => {
    const { commands } = recorder('embed');
    const actions: AgentAction[] = [{ kind: 'ui.open', panel: 'measure' }];
    const bridge = new AgentBridge(port({ text: 'ok', citations: [], actions }), commands);
    const { outcomes } = await bridge.ask('anything');
    expect(outcomes[0]!.applied).toBe(false);
    expect(outcomes[0]!.declined).toContain('not available in this mode');
  });

  it('announces the answer to assistive technology', async () => {
    const { calls, commands } = recorder();
    const bridge = new AgentBridge(
      port({ text: 'The kitchen is 19 square metres.', speech: 'Nineteen square metres.', citations: [], actions: [] }),
      commands,
    );
    await bridge.ask('how big?');
    expect(calls.some((c) => c.startsWith('announce:Nineteen'))).toBe(true);
  });

  it('keeps the tour usable when the agent throws', async () => {
    const { commands } = recorder();
    const broken: AgentPort = {
      contractVersion: AGENT_CONTRACT_VERSION,
      capabilities: { canAnswer: true, canStream: false, emits: [] },
      ask: async () => { throw new Error('model unavailable'); },
    };
    const bridge = new AgentBridge(broken, commands);
    const { answer } = await bridge.ask('anything');
    expect(answer.refusal?.scope).toBe('knowledge');
    expect(answer.text).toContain('still works');
  });

  it('keeps a bounded transcript and passes it to the agent', async () => {
    const { commands } = recorder();
    const seen: AgentQuestion[] = [];
    const spy: AgentPort = {
      contractVersion: AGENT_CONTRACT_VERSION,
      capabilities: { canAnswer: true, canStream: false, emits: [] },
      ask: async (q) => { seen.push(q); return { text: 'ok', citations: [], actions: [] }; },
    };
    const bridge = new AgentBridge(spy, commands);
    for (let i = 0; i < 10; i++) await bridge.ask(`question ${i}`);
    expect(seen[9]!.history.length).toBeGreaterThan(0);
    expect(bridge.transcript.length).toBeLessThanOrEqual(12);
  });

  it('prefers a streaming agent when it says it can stream', async () => {
    const { commands } = recorder();
    const onEvent = vi.fn();
    const streaming: AgentPort = {
      contractVersion: AGENT_CONTRACT_VERSION,
      capabilities: { canAnswer: true, canStream: true, emits: [] },
      ask: async () => { throw new Error('should not be called'); },
      askStreaming: async (_q, emit) => {
        emit({ kind: 'text', delta: 'partial' });
        return { text: 'partial answer', citations: [], actions: [] };
      },
    };
    const bridge = new AgentBridge(streaming, commands);
    const { answer } = await bridge.ask('anything', onEvent);
    expect(answer.text).toBe('partial answer');
    expect(onEvent).toHaveBeenCalledWith({ kind: 'text', delta: 'partial' });
  });
});

describe('frame statistics', () => {
  it('reports the 1% low as the mean of the slowest frames, not a percentile', () => {
    const frames = [...Array(99).fill(16.7), 200];
    const stats = summariseFrames(frames);
    expect(stats.fpsMedian).toBeCloseTo(59.9, 0);
    expect(stats.fpsOnePercentLow).toBeCloseTo(5, 0);
    expect(stats.frameMsMax).toBe(200);
    expect(stats.jankFraction).toBeCloseTo(0.01, 3);
  });

  it('survives an empty sample without dividing by zero', () => {
    expect(summariseFrames([]).fpsMedian).toBe(0);
    expect(summariseFrames([Number.NaN, 0, -3]).count).toBe(0);
  });
});
