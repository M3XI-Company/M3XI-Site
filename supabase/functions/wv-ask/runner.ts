/**
 * The real AgentRunner: the bridge from the edge function to @m3xi/agent.
 *
 * Kept apart from handler.ts on purpose. The handler enforces the caps and
 * owns the security properties, and it is tested with a fake runner so those
 * properties are verified without loading a spatial engine. This file is the
 * wiring, and it is the part that needs a model key to exercise fully.
 *
 * `worldCache` matters more than it looks. Building a World means building a
 * BVH over the proxy geometry, which is the expensive part of a turn; an edge
 * function instance serves many requests, and rebuilding per turn would make
 * the deterministic tier slower than the model it is meant to replace.
 */

import type { Db } from '../_wv_shared/deps.ts';
import { buildWorldDocument } from '../_wv_shared/worldDocument.ts';
import type { AgentRunner, AgentTurnResult } from './handler.ts';

/**
 * Structural types for the agent bundle, declared rather than imported so this
 * file compiles without the package present. The vendored bundle satisfies it.
 */
export interface AgentModule {
  Agent: new (opts: Record<string, unknown>) => {
    ask(question: string, view: unknown): Promise<{
      answer: { text: string; refused: boolean; grounded: boolean };
      commands: unknown[];
      record: AgentTurnResult['record'];
    }>;
    salience: { toJSON(): unknown };
  };
  World: { fromDocument(doc: unknown): unknown };
  SalienceModel: { fromJSON(raw: unknown): unknown };
  sanitiseViewerState(raw: unknown, fallback?: unknown): unknown;
  DEFAULT_ROUTING: Record<string, unknown>;
}

export interface ModelClientLike {
  complete(req: unknown): Promise<unknown>;
}

export interface RunnerOptions {
  readonly db: Db;
  readonly agentModule: AgentModule;
  readonly modelClient: ModelClientLike;
  /** Overrides on DEFAULT_ROUTING, e.g. a per-org model choice. */
  readonly routing?: Record<string, unknown>;
  readonly maxCachedWorlds?: number;
}

export function makeAgentRunner(opts: RunnerOptions): AgentRunner {
  const { agentModule: A } = opts;
  const limit = opts.maxCachedWorlds ?? 4;
  const cache = new Map<string, unknown>();

  const worldFor = async (worldId: string): Promise<unknown> => {
    const hit = cache.get(worldId);
    if (hit) {
      // Refresh recency: a Map preserves insertion order, so deleting and
      // re-setting is a one-line LRU with no extra structure.
      cache.delete(worldId);
      cache.set(worldId, hit);
      return hit;
    }
    const doc = await buildWorldDocument(opts.db, worldId);
    const world = A.World.fromDocument(doc);
    cache.set(worldId, world);
    while (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return world;
  };

  return {
    async run(input) {
      const world = await worldFor(input.worldId);
      const agent = new A.Agent({
        world,
        worldId: input.worldId,
        sessionId: input.sessionId,
        model: opts.modelClient,
        config: {
          ...A.DEFAULT_ROUTING,
          ...(opts.routing ?? {}),
          sessionTurnCap: input.turnCap,
        },
        salience: A.SalienceModel.fromJSON(input.salience),
        turnsUsed: input.turnsUsed,
        sessionCostUsd: input.sessionCostUsd,
      });

      // The pose is client-supplied and therefore hostile. It is coerced, not
      // trusted; a malformed one degrades to standing at the origin, which
      // yields an honest "you are not in any room" rather than a crash.
      const view = A.sanitiseViewerState(input.view);
      const res = await agent.ask(input.question, view as never);

      return {
        answer: res.answer,
        commands: res.commands,
        record: res.record,
        salience: agent.salience.toJSON(),
      };
    },
  };
}
