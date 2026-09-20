import type { Provenance, Quantity, Vec3 } from '@m3xi/world-core';
import type { CameraPose, MeasurementOverlay, ViewerMode } from '../types.js';

/**
 * THE AGENT SEAM
 * ==============
 *
 * The viewer owns the camera, the DOM and the world's geometry. The agent owns
 * language. This file is the whole of the contract between them, and it is
 * deliberately one-directional in dependency terms: `@m3xi/viewer` imports
 * nothing from `@m3xi/agent`. The viewer is handed an object satisfying
 * `AgentPort` and never learns what is behind it -- a local rule-based stub, a
 * tool-calling model over the same `World`, or a network endpoint.
 *
 * Three rules shaped it.
 *
 * 1. THE AGENT NEVER TOUCHES THE CAMERA DIRECTLY. It returns a description of
 *    what it would like to happen (`AgentAction[]`) and the viewer decides
 *    whether that is possible. An agent asking to stand inside a wall, in an
 *    unobserved volume, or beyond the nav graph gets refused by the same
 *    constraint solver a human user hits. That is not defensive programming:
 *    it is the only way "the camera cannot walk through a wall" stays true once
 *    a model is in the loop.
 *
 * 2. NUMBERS CROSS THIS BOUNDARY AS `Quantity`, NEVER AS `number`. A `Quantity`
 *    carries its standard, its tolerance and its grounding. If the agent wants
 *    to say "3.7 metres" it must hand over the Quantity that says so, and the
 *    viewer renders it through one formatter that cannot drop the tolerance.
 *
 * 3. REFUSAL IS A FIRST-CLASS ANSWER. `AgentAnswer.refusal` is not an error
 *    path. "The far corner of this bedroom was never photographed, so I can't
 *    tell you what is behind the wardrobe" is a correct, complete answer and
 *    the viewer has a settled way to display it.
 *
 * Versioning: `AGENT_CONTRACT_VERSION` is bumped on any breaking change, and
 * `AgentPort.contractVersion` lets the viewer refuse an incompatible agent
 * rather than mis-render its output.
 */
export const AGENT_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// What the viewer tells the agent
// ---------------------------------------------------------------------------

/**
 * Everything the agent gets about the user's situation. The agent may ignore
 * all of it; it may not assume anything not listed here. Note what is absent:
 * no DOM, no camera object, no renderer. The agent cannot reach into the view.
 */
export interface ViewerContext {
  readonly worldId: string;
  readonly worldVersion: number;
  readonly mode: ViewerMode;
  readonly locale: string;
  /** Where the user is standing and looking, right now. */
  readonly pose: CameraPose;
  /** Room containing the camera, if any. Absent in a doorway. */
  readonly roomId?: string;
  /** Rooms and entities currently in view, computed by the spatial engine. */
  readonly visibleRoomIds: readonly string[];
  readonly visibleEntityIds: readonly string[];
  /** What the user last clicked or focused, if anything. */
  readonly selection?: { readonly kind: 'entity' | 'room' | 'opening' | 'surface'; readonly id: string };
  /** Provenance of the point the user is standing on. */
  readonly provenance: Provenance;
  /** Measurements currently on screen, so the agent can refer to them. */
  readonly activeMeasurements: readonly MeasurementOverlay[];
  /** Rooms whose splat chunk has finished loading; the rest are proxy only. */
  readonly loadedChunkKeys: readonly string[];
}

export interface AgentQuestion {
  /** Raw user text. Never pre-parsed by the viewer. */
  readonly text: string;
  readonly context: ViewerContext;
  /** Prior turns, oldest first. The viewer keeps the transcript, not the agent. */
  readonly history: readonly AgentTurn[];
  readonly signal?: AbortSignal;
}

export interface AgentTurn {
  readonly role: 'user' | 'agent';
  readonly text: string;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// What the agent asks the viewer to do
// ---------------------------------------------------------------------------

/**
 * A place the agent can name. Resolved by the viewer against the world, so a
 * bad id is a viewer-side no-op with a logged reason rather than a crash.
 */
export type AgentTarget =
  | { readonly kind: 'point'; readonly position: Vec3 }
  | { readonly kind: 'room'; readonly roomId: string }
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'opening'; readonly openingId: string }
  | { readonly kind: 'navNode'; readonly nodeId: string };

/**
 * Camera moves. `tour` is the one that matters: the agent hands over a
 * destination and the viewer walks there along `World.findPath`, through
 * doorways, at walking pace, obeying `prefers-reduced-motion`. The agent does
 * not get to specify a trajectory, because a trajectory it invented would not
 * be constrained by the building.
 */
export type AgentAction =
  /** Walk the camera to a place along the nav graph. */
  | {
      readonly kind: 'camera.goTo';
      readonly target: AgentTarget;
      /** Face this after arriving. */
      readonly lookAt?: AgentTarget;
      /** 'walk' follows the nav graph; 'cut' jumps (used under reduced motion). */
      readonly style?: 'walk' | 'cut';
      readonly speedMps?: number;
    }
  /** Turn on the spot to face something, without moving. */
  | { readonly kind: 'camera.lookAt'; readonly target: AgentTarget }
  /** Stand at a declared viewpoint node (`NavNode.isViewpoint`). */
  | { readonly kind: 'camera.viewpoint'; readonly nodeId: string }
  /** Outline entities in the 3D view and list them in the live region. */
  | { readonly kind: 'highlight.set'; readonly entityIds: readonly string[]; readonly label?: string }
  | { readonly kind: 'highlight.clear' }
  /** Draw a measurement. The overlay carries its own geometry and labels. */
  | { readonly kind: 'measure.show'; readonly overlay: MeasurementOverlay }
  | { readonly kind: 'measure.clear' }
  /** Open a panel. The viewer may decline in embed mode. */
  | { readonly kind: 'ui.open'; readonly panel: 'rooms' | 'measure' | 'info' | 'floorplan' | 'text' }
  /** Move the floorplan's room emphasis without moving the camera. */
  | { readonly kind: 'floorplan.emphasise'; readonly roomIds: readonly string[] };

// ---------------------------------------------------------------------------
// What the agent answers
// ---------------------------------------------------------------------------

/**
 * A claim's receipt. Every number or spatial assertion in `AgentAnswer.text`
 * should have one, and the viewer renders them as a "shown from" list under the
 * answer. `quantity` is present whenever the citation backs a number.
 */
export interface AgentCitation {
  readonly kind: 'room' | 'entity' | 'opening' | 'surface' | 'quantity' | 'region' | 'camera';
  readonly id: string;
  readonly label: string;
  readonly quantity?: Quantity;
  readonly provenance: Provenance;
}

/**
 * Why the agent would not assert something. `scope` tells the viewer how to
 * present it: a `measurement` refusal sits next to the number, a `spatial`
 * refusal sits next to the room it concerns, a `policy` refusal is about the
 * question rather than the world.
 */
export interface AgentRefusal {
  readonly scope: 'measurement' | 'spatial' | 'knowledge' | 'policy';
  /** Plain English, shown verbatim to the visitor. No jargon, no codes. */
  readonly text: string;
  /** Ids of regions or entities that caused it, for the provenance overlay. */
  readonly because?: readonly string[];
}

export interface AgentAnswer {
  /** The prose answer. Plain text; the viewer does not render HTML from it. */
  readonly text: string;
  /** Optional shorter form for the live region and for speech. */
  readonly speech?: string;
  readonly citations: readonly AgentCitation[];
  readonly actions: readonly AgentAction[];
  readonly refusal?: AgentRefusal;
  /** 0..1, the agent's own confidence. Displayed only in operator mode. */
  readonly confidence?: number;
  /** Follow-ups the viewer offers as buttons. Max 3 are shown. */
  readonly suggestions?: readonly string[];
}

/** Incremental output. An agent that cannot stream simply never emits these. */
export type AgentEvent =
  | { readonly kind: 'text'; readonly delta: string }
  | { readonly kind: 'action'; readonly action: AgentAction }
  | { readonly kind: 'status'; readonly text: string };

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface AgentCapabilities {
  /** Show the Ask panel only if the agent says it can answer questions. */
  readonly canAnswer: boolean;
  /** Whether `askStreaming` is meaningfully implemented. */
  readonly canStream: boolean;
  /** Action kinds the agent will ever emit, so the viewer can pre-authorise. */
  readonly emits: readonly AgentAction['kind'][];
  /** Shown in the Ask panel's empty state. Max 4 are displayed. */
  readonly examples?: readonly string[];
  /** Displayed in operator mode next to the answer. */
  readonly label?: string;
}

/**
 * The single object the viewer needs. `@m3xi/agent` exports something that
 * satisfies this; `StubAgent` in this package satisfies it against the spatial
 * engine alone, so the viewer is complete and testable with no agent present.
 */
export interface AgentPort {
  readonly contractVersion: typeof AGENT_CONTRACT_VERSION;
  readonly capabilities: AgentCapabilities;
  ask(question: AgentQuestion): Promise<AgentAnswer>;
  /**
   * Optional. Resolves with the same final answer `ask` would return; `onEvent`
   * fires as output becomes available. The viewer prefers this when
   * `capabilities.canStream` is true.
   */
  askStreaming?(question: AgentQuestion, onEvent: (e: AgentEvent) => void): Promise<AgentAnswer>;
  dispose?(): void;
}

/** Thrown by the bridge when an agent declares an incompatible contract. */
export class AgentContractError extends Error {
  constructor(readonly got: number) {
    super(`agent implements contract version ${got}, viewer requires ${AGENT_CONTRACT_VERSION}`);
    this.name = 'AgentContractError';
  }
}

/** Outcome of applying one action, surfaced in operator diagnostics. */
export interface ActionOutcome {
  readonly action: AgentAction;
  readonly applied: boolean;
  /** Present when the viewer declined: an unknown id, a blocked move, embed mode. */
  readonly declined?: string;
}
