/**
 * Shared test rig. Builds an agent over the flat fixture with a deterministic
 * clock, deterministic command ids and a fake model, so every assertion in
 * this suite is reproducible.
 */

import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';

import { Agent } from '../agent.js';
import type { ViewerCommand } from '../commands.js';
import { ReferenceResolver, SalienceModel } from '../resolver.js';
import { FakeModelClient } from '../model.js';
import type { RoutingConfig } from '../pricing.js';
import { DEFAULT_ROUTING } from '../pricing.js';
import { Tools } from '../tools.js';
import type { ViewerState } from '../view.js';

export { FLAT };

/** Standing in the middle of the kitchen/diner, facing the sitting end. */
export function kitchenView(): ViewerState {
  return {
    position: [2.2, 1.6, 2.6],
    // Yaw +Z (looking down +Z, i.e. toward the sofa end of the L).
    orientation: [0, 1, 0, 0],
    fovRad: (60 * Math.PI) / 180,
  };
}

export function hallView(): ViewerState {
  return { position: [5.3, 1.6, 3.2], orientation: [0, 0, 0, 1], fovRad: (60 * Math.PI) / 180 };
}

export interface Rig {
  world: World;
  tools: Tools;
  view: ViewerState;
  commands: ViewerCommand[];
  resolver: ReferenceResolver;
  salience: SalienceModel;
}

export function makeTools(view: ViewerState = kitchenView()): Rig {
  const world = World.fromDocument(FLAT);
  const commands: ViewerCommand[] = [];
  let n = 0;
  const tools = new Tools(world, view, {
    emit: (c) => commands.push(c),
    nextCommandId: () => `cmd_${++n}`,
  });
  const salience = new SalienceModel();
  const resolver = new ReferenceResolver(tools, salience);
  return { world, tools, view, commands, resolver, salience };
}

export function makeAgent(opts: {
  view?: ViewerState;
  model?: FakeModelClient;
  config?: Partial<RoutingConfig>;
} = {}): { agent: Agent; view: ViewerState; model: FakeModelClient } {
  const view = opts.view ?? kitchenView();
  const model = opts.model ?? new FakeModelClient();
  let clock = 1_000;
  let n = 0;
  const agent = new Agent({
    world: World.fromDocument(FLAT),
    worldId: FLAT.id,
    sessionId: 'sess_test',
    model,
    config: { ...DEFAULT_ROUTING, ...(opts.config ?? {}) },
    now: () => (clock += 7),
    idFactory: () => `cmd_${++n}`,
  });
  return { agent, view, model };
}
