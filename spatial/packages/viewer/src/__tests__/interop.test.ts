import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { adaptM3xiAgent, type ExternalAgent } from '../agent/m3xiAdapter.js';
import { AGENT_CONTRACT_VERSION } from '../agent/contract.js';
import type { ViewerContext } from '../agent/contract.js';

/**
 * Live interoperability check against the real `@m3xi/agent`.
 *
 * It reaches across package boundaries into their source on purpose, and it
 * SKIPS rather than fails when that source is absent or has moved. `@m3xi/viewer`
 * must build and ship with no agent at all, so this test is allowed to notice
 * that the other half is missing; it is not allowed to make that a failure.
 */
// The specifiers are variables on purpose. A literal would pull another
// package's SOURCE into this project's TypeScript file list, and `tsc -b`
// would then try to compile their files under our rootDir. The viewer must
// build with no agent present at all.
const AGENT_MODULE = '../../../agent/src/agent.js';
const MODEL_MODULE = '../../../agent/src/model.js';

const loaded = await (async (): Promise<{ Agent: new (o: never) => ExternalAgent; Model: new () => unknown } | null> => {
  try {
    const [agentMod, modelMod] = await Promise.all([
      import(/* @vite-ignore */ AGENT_MODULE) as Promise<Record<string, unknown>>,
      import(/* @vite-ignore */ MODEL_MODULE) as Promise<Record<string, unknown>>,
    ]);
    const Agent = agentMod['Agent'];
    const Model = modelMod['FakeModelClient'];
    if (typeof Agent !== 'function' || typeof Model !== 'function') return null;
    return { Agent, Model } as { Agent: new (o: never) => ExternalAgent; Model: new () => unknown };
  } catch {
    return null;
  }
})();

const world = World.fromDocument(FLAT);

const context: ViewerContext = {
  worldId: FLAT.id, worldVersion: FLAT.version, mode: 'visitor', locale: 'en-GB',
  pose: { position: [5.3, 1.6, 1.0], yaw: 0, pitch: 0 },
  roomId: 'r_hall', visibleRoomIds: ['r_hall'], visibleEntityIds: [],
  provenance: 'reconstructed', activeMeasurements: [], loadedChunkKeys: [],
};

describe.skipIf(loaded === null)('@m3xi/agent through the adapter', () => {
  const makePort = () => {
    const agent = new loaded!.Agent({
      world, worldId: FLAT.id, model: new loaded!.Model(),
    } as never);
    return adaptM3xiAgent(agent, { world });
  };

  it('satisfies the ExternalAgent shape the adapter duck-types', () => {
    const port = makePort();
    expect(port.contractVersion).toBe(AGENT_CONTRACT_VERSION);
    expect(port.capabilities.canAnswer).toBe(true);
  });

  it('answers an area question with the standard and tolerance intact', async () => {
    const answer = await makePort().ask({ text: 'how big is the kitchen?', context, history: [] });
    expect(answer.text).toContain('m²');
    expect(answer.text).toContain('±');
    expect(answer.text).toMatch(/RICS/);
  });

  it('resolves their bare citation ids into labelled, provenanced citations', async () => {
    const answer = await makePort().ask({ text: 'how big is the kitchen?', context, history: [] });
    expect(answer.citations[0]).toMatchObject({
      kind: 'room', id: 'r_kitchen', label: 'Kitchen/diner', provenance: 'reconstructed',
    });
  });

  it('turns their ViewerCommand stream into actions this viewer can apply', async () => {
    const answer = await makePort().ask({ text: 'how big is the kitchen?', context, history: [] });
    const kinds = new Set(answer.actions.map((a) => a.kind));
    expect(kinds.size).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect([
        'camera.goTo', 'camera.lookAt', 'camera.viewpoint', 'highlight.set', 'highlight.clear',
        'measure.show', 'measure.clear', 'ui.open', 'floorplan.emphasise',
      ]).toContain(kind);
    }
  });

  it('walks the camera when asked to navigate', async () => {
    const answer = await makePort().ask({ text: 'take me to bedroom 1', context, history: [] });
    const move = answer.actions.find((a) => a.kind === 'camera.goTo');
    if (move) expect(move).toHaveProperty('target');
    // Some routes answer in text alone; what must never happen is an action
    // this viewer cannot understand.
    expect(answer.text.length).toBeGreaterThan(0);
  });
});
