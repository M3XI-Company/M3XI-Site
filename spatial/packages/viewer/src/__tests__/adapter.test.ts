import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { adaptM3xiAgent, type ExternalAgent, type ExternalAskResult } from '../agent/m3xiAdapter.js';
import { AgentBridge, type ViewerCommands } from '../agent/bridge.js';
import type { ViewerContext } from '../agent/contract.js';

const world = World.fromDocument(FLAT);

/**
 * A stand-in for `@m3xi/agent` that emits its documented `ViewerCommand`
 * shapes verbatim. Structural, not imported: the adapter exists precisely so
 * neither package has to depend on the other, and this test would be lying if
 * it proved that by importing the thing.
 */
function fakeExternal(result: ExternalAskResult): ExternalAgent {
  return { ask: async () => result };
}

const context: ViewerContext = {
  worldId: FLAT.id,
  worldVersion: FLAT.version,
  mode: 'visitor',
  locale: 'en-GB',
  pose: { position: [5.3, 1.6, 1.0], yaw: 0.4, pitch: -0.1 },
  roomId: 'r_hall',
  visibleRoomIds: ['r_hall'],
  visibleEntityIds: [],
  provenance: 'reconstructed',
  activeMeasurements: [],
  loadedChunkKeys: [],
};

const askVia = async (result: ExternalAskResult) => {
  const port = adaptM3xiAgent(fakeExternal(result), { world });
  return port.ask({ text: 'anything', context, history: [] });
};

const base = { answer: { text: 'ok', refused: false, citations: [], grounded: true }, commands: [] };

describe('viewer state handed to the agent', () => {
  it('sends a normalised quaternion, a field of view and the selection', async () => {
    let captured: unknown;
    const port = adaptM3xiAgent(
      { ask: async (_q, view) => { captured = view; return base; } },
      { world },
    );
    await port.ask({
      text: 'how far is that',
      context: { ...context, selection: { kind: 'entity', id: 'e_sofa' } },
      history: [],
    });
    const view = captured as { orientation: number[]; fovRad: number; selectedEntityId?: string; roomId?: string };
    const length = Math.hypot(...view.orientation);
    expect(length).toBeCloseTo(1, 9);
    expect(view.fovRad).toBeCloseTo(Math.PI / 3, 6);
    expect(view.selectedEntityId).toBe('e_sofa');
    expect(view.roomId).toBe('r_hall');
  });
});

describe('command translation', () => {
  it('turns moveCamera into a nav-node walk the viewer re-solves itself', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'moveCamera', id: 'c1', intent: 'navigation',
        waypoints: [
          { position: [5.3, 0, 1.0], navNodeId: 'n_hall_a' },
          { position: [9.1, 0, 1.7], navNodeId: 'n_bed1_a' },
        ],
        durationMs: 4000,
        pathLengthM: 5.2,
        lookAt: [10.3, 1.2, 1.0],
      }],
    });
    expect(answer.actions[0]).toMatchObject({
      kind: 'camera.goTo',
      target: { kind: 'navNode', nodeId: 'n_bed1_a' },
      lookAt: { kind: 'point', position: [10.3, 1.2, 1.0] },
      style: 'walk',
    });
    const action = answer.actions[0]!;
    if (action.kind !== 'camera.goTo') throw new Error('wrong kind');
    expect(action.speedMps).toBeCloseTo(1.3, 1);
  });

  it('falls back to a bare point when the agent sends no nav node', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'moveCamera', id: 'c1', intent: 'navigation',
        waypoints: [{ position: [3.2, 0, 2.0] }], durationMs: 1000,
      }],
    });
    expect(answer.actions[0]).toMatchObject({ target: { kind: 'point', position: [3.2, 0, 2.0] } });
  });

  it('translates a measurement overlay and keeps the agent’s own label', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'measurementOverlay', id: 'm1', intent: 'answer',
        from: [1, 1, 1], to: [3, 1, 1],
        label: '2.00 m ±20 mm', valueM: 2, toleranceMm: 20,
        provenance: 'reconstructed', defensible: true,
      }],
    });
    const action = answer.actions[0]!;
    if (action.kind !== 'measure.show') throw new Error('wrong kind');
    expect(action.overlay.lines[0]).toEqual([[1, 1, 1], [3, 1, 1]]);
    expect(action.overlay.labels[0]!.text).toBe('2.00 m ±20 mm');
    expect(action.overlay.labels[0]!.at).toEqual([2, 1, 1]);
    expect(action.overlay.labels[0]!.status).toBe('defensible');
  });

  it('marks an undefendable measurement as indicative, not as normal', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'measurementOverlay', id: 'm1', intent: 'answer',
        from: [1, 1, 1], to: [3, 1, 1], label: 'about 2 m', valueM: 2,
        toleranceMm: 80, provenance: 'generated', defensible: false,
      }],
    });
    const action = answer.actions[0]!;
    if (action.kind !== 'measure.show') throw new Error('wrong kind');
    expect(action.overlay.labels[0]!.status).toBe('indicative');
  });

  it('lifts an area polygon onto the room floor plane', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'areaOverlay', id: 'a1', intent: 'answer', roomId: 'r_bed1',
        polygon: [[6.25, 0.25], [10.75, 0.25], [10.75, 3.35], [6.25, 3.35]],
        floorY: 0, label: '13.95 m²', valueM2: 13.95, tolerancePct: 2.5,
        standard: 'RICS-COMP-GIA', defensible: true,
      }],
    });
    const action = answer.actions[0]!;
    if (action.kind !== 'measure.show') throw new Error('wrong kind');
    expect(action.overlay.polygons[0]).toHaveLength(4);
    expect(action.overlay.polygons[0]![0]![1]).toBeCloseTo(0.01, 6);
    expect(action.overlay.labels[0]!.detail).toBe('RICS-COMP-GIA');
  });

  it('draws a placement footprint from an oriented box', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'placementOverlay', id: 'p1', intent: 'answer',
        centre: [9, 1, 2], half: [1, 1, 0.3], quat: [0, 0, 0, 1],
        label: 'Wardrobe fits here', fits: true,
      }],
    });
    const action = answer.actions[0]!;
    if (action.kind !== 'measure.show') throw new Error('wrong kind');
    const footprint = action.overlay.footprints[0]!;
    expect(footprint.ok).toBe(true);
    expect(footprint.corners).toHaveLength(4);
    for (const corner of footprint.corners) expect(corner[1]).toBeCloseTo(0.012, 6);
  });

  it('resolves a region overlay against the world document', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'regionOverlay', id: 'r1', intent: 'answer',
        regionIds: ['rg_bed1_far_corner'], provenance: 'generated',
        label: 'Not surveyed',
      }],
    });
    const action = answer.actions[0]!;
    if (action.kind !== 'measure.show') throw new Error('wrong kind');
    expect(action.overlay.polygons).toHaveLength(1);
    expect(action.overlay.labels[0]!.status).toBe('indicative');
  });

  it('drops a region overlay that names nothing real, rather than drawing a void', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'regionOverlay', id: 'r1', intent: 'answer',
        regionIds: ['rg_does_not_exist'], provenance: 'generated', label: 'x',
      }],
    });
    expect(answer.actions).toHaveLength(0);
  });

  it('maps highlight styles, and carries the warning style into words', async () => {
    const answer = await askVia({
      ...base,
      commands: [{
        kind: 'highlightEntities', id: 'h1', intent: 'answer',
        entityIds: ['e_chest_drawers'], style: 'warning',
      }],
    });
    expect(answer.actions[0]).toMatchObject({
      kind: 'highlight.set',
      entityIds: ['e_chest_drawers'],
      label: 'Marked as not fully surveyed',
    });
  });

  it('emphasises a focused room on the floorplan without dimming the property', async () => {
    const answer = await askVia({
      ...base,
      commands: [{ kind: 'focusRoom', id: 'f1', intent: 'context', roomId: 'r_bed2', isolate: true }],
    });
    expect(answer.actions).toEqual([{ kind: 'floorplan.emphasise', roomIds: ['r_bed2'] }]);
  });

  it('treats an empty clearOverlays as clearing highlights too', async () => {
    const answer = await askVia({
      ...base,
      commands: [{ kind: 'clearOverlays', id: 'x1', intent: 'answer', ids: [] }],
    });
    expect(answer.actions.map((a) => a.kind)).toEqual(['measure.clear', 'highlight.clear']);
  });

  it('ignores a command kind from a newer agent without losing the answer', async () => {
    const answer = await askVia({
      answer: { text: 'Still answered.', refused: false, citations: [], grounded: true },
      commands: [{ kind: 'holographicProjection', id: 'z1', intent: 'answer' }],
    });
    expect(answer.actions).toHaveLength(0);
    expect(answer.text).toBe('Still answered.');
  });
});

describe('answers, citations and refusals', () => {
  it('resolves bare world ids into labelled citations with provenance', async () => {
    const answer = await askVia({
      answer: {
        text: 'ok', refused: false, grounded: true,
        citations: ['r_bed1', 'e_chest_drawers', 'rg_bed1_far_corner', 'o_door_bed1', 'made_up'],
      },
      commands: [],
    });
    expect(answer.citations[0]).toMatchObject({ kind: 'room', label: 'Bedroom 1' });
    expect(answer.citations[1]).toMatchObject({ kind: 'entity', label: 'chest of drawers', provenance: 'inferred' });
    expect(answer.citations[2]).toMatchObject({ kind: 'region', provenance: 'generated' });
    expect(answer.citations[3]).toMatchObject({ kind: 'opening', label: 'door' });
    expect(answer.citations[4]).toMatchObject({ kind: 'quantity', id: 'made_up' });
  });

  it('maps refusal codes onto the scopes the viewer knows how to display', async () => {
    const measurement = await askVia({
      answer: {
        text: 'no', refused: true, grounded: true, citations: [],
        refusal: { code: 'not_measurable', reason: 'That crosses a volume nothing observed.', evidenceIds: ['rg_bed1_far_corner'] },
      },
      commands: [],
    });
    expect(measurement.refusal).toEqual({
      scope: 'measurement',
      text: 'That crosses a volume nothing observed.',
      because: ['rg_bed1_far_corner'],
    });

    const policy = await askVia({
      answer: {
        text: 'no', refused: true, grounded: true, citations: [],
        refusal: { code: 'out_of_scope', reason: 'I only answer questions about this property.' },
      },
      commands: [],
    });
    expect(policy.refusal?.scope).toBe('policy');
  });
});

describe('end to end through the bridge', () => {
  it('an adapted agent drives the viewer exactly as the stub does', async () => {
    const calls: string[] = [];
    const commands: ViewerCommands = {
      mode: 'visitor',
      context: () => context,
      goTo: async (t) => { calls.push(`goTo:${t.kind}`); return true; },
      lookAt: () => { calls.push('lookAt'); return true; },
      viewpoint: () => true,
      setHighlight: (ids) => { calls.push(`highlight:${ids.length}`); return true; },
      clearHighlight: () => { calls.push('clearHighlight'); },
      showMeasurement: () => { calls.push('measure'); return true; },
      clearMeasurements: () => { calls.push('clearMeasure'); },
      openPanel: () => true,
      emphasiseRooms: () => true,
      announce: (t) => { calls.push(`announce:${t.slice(0, 6)}`); },
    };
    const port = adaptM3xiAgent(fakeExternal({
      answer: { text: 'Bedroom 1 is 13.95 m² ±2.5%.', refused: false, grounded: true, citations: ['r_bed1'] },
      commands: [
        { kind: 'moveCamera', id: 'c1', intent: 'navigation', waypoints: [{ position: [9.1, 0, 1.7], navNodeId: 'n_bed1_a' }], durationMs: 3000 },
        { kind: 'areaOverlay', id: 'a1', intent: 'answer', roomId: 'r_bed1', polygon: [[6.25, 0.25], [10.75, 0.25], [10.75, 3.35]], floorY: 0, label: '13.95 m²', valueM2: 13.95, tolerancePct: 2.5, standard: 'RICS-COMP-GIA', defensible: true },
      ],
    }), { world });

    const bridge = new AgentBridge(port, commands);
    const { answer, outcomes } = await bridge.ask('how big is bedroom 1?');
    expect(answer.citations[0]?.label).toBe('Bedroom 1');
    expect(outcomes.every((o) => o.applied)).toBe(true);
    expect(calls).toEqual(['goTo:navNode', 'measure', 'announce:Bedroo']);
  });
});
