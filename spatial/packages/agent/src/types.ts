/**
 * The agent's own contract: what a tool returns, what a turn records, and what
 * "grounded" means operationally.
 *
 * The central type here is `ToolResult`. Every tool in this package returns
 * one, and every tool result carries its own grounding. That is not decoration:
 * the agent composes answers only from tool results, and the answer's grounding
 * is the weakest of the tool results it used. A claim with no tool result
 * behind it cannot be phrased, because the phrasing functions take tool
 * results as input and there is no other way in.
 */

import type {
  Camera, Entity, Grounding, NavNode, Obb, Opening, Provenance, Quantity,
  Relationship, Room, Surface, Vec3,
} from '@m3xi/world-core';

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

export type ToolName =
  | 'get_current_camera' | 'get_current_room' | 'get_visible_entities'
  | 'get_entity' | 'find_entities' | 'get_room'
  | 'get_geometry' | 'get_dimensions' | 'get_relationships'
  | 'measure_distance' | 'measure_area'
  | 'raycast' | 'check_visibility' | 'check_collision' | 'find_path'
  | 'highlight_entity' | 'move_camera' | 'select_entity'
  | 'inspect_surface' | 'query_world' | 'get_provenance';

export const TOOL_NAMES: readonly ToolName[] = [
  'get_current_camera', 'get_current_room', 'get_visible_entities',
  'get_entity', 'find_entities', 'get_room',
  'get_geometry', 'get_dimensions', 'get_relationships',
  'measure_distance', 'measure_area',
  'raycast', 'check_visibility', 'check_collision', 'find_path',
  'highlight_entity', 'move_camera', 'select_entity',
  'inspect_surface', 'query_world', 'get_provenance',
];

/**
 * Why a tool declined. These are not errors in the "something broke" sense;
 * they are the system correctly refusing to assert. The distinction matters
 * because `not_found` is a conversational problem (ask a better question) and
 * `unobserved` is an epistemic one (no question will fix it).
 */
export type RefusalCode =
  | 'not_found'          // nothing in the world matches the reference
  | 'ambiguous'          // several things match and none dominates
  | 'unobserved'         // the answer lies in a volume no camera saw
  | 'generated'          // the geometry involved was invented by a model
  | 'not_established'    // the capture simply does not settle this
  | 'out_of_scope'       // a real question this system is not a source for
  | 'invalid_argument';

export interface Refusal {
  readonly code: RefusalCode;
  /** Written for a member of the public, not for a log. */
  readonly reason: string;
  /** Region or entity ids the viewer can highlight to show the gap. */
  readonly evidenceIds?: readonly string[];
}

export interface ToolOk<T> {
  readonly ok: true;
  readonly tool: ToolName;
  readonly data: T;
  /** Weakest grounding across everything this result touched. */
  readonly grounding: Grounding;
  /** Ids of world objects consulted, so an answer can be audited. */
  readonly consulted: readonly string[];
}

export interface ToolFail {
  readonly ok: false;
  readonly tool: ToolName;
  readonly refusal: Refusal;
}

export type ToolResult<T> = ToolOk<T> | ToolFail;

export function isOk<T>(r: ToolResult<T>): r is ToolOk<T> {
  return r.ok;
}

// ---------------------------------------------------------------------------
// Tool payloads
// ---------------------------------------------------------------------------

export interface CameraState {
  readonly position: Vec3;
  readonly orientation: readonly [number, number, number, number];
  readonly roomId?: string;
  readonly fovRad: number;
}

export interface VisibleEntitiesResult {
  readonly entities: readonly Entity[];
  readonly openings: readonly Opening[];
  readonly rooms: readonly Room[];
}

export interface GeometryResult {
  readonly id: string;
  readonly type: 'entity' | 'room' | 'surface' | 'opening';
  readonly aabb?: { readonly min: Vec3; readonly max: Vec3 };
  readonly obb?: Obb;
  readonly polygon?: readonly (readonly [number, number])[];
  readonly polygon3?: readonly Vec3[];
  readonly centroid: Vec3;
  readonly floorY?: number;
  readonly ceilingY?: number;
}

/** Dimensions are Quantities, never bare numbers. See world-core. */
export interface DimensionsResult {
  readonly id: string;
  readonly type: 'entity' | 'room' | 'opening';
  readonly width: Quantity;
  readonly depth: Quantity;
  readonly height: Quantity;
  /** Only for rooms and openings; entities have no meaningful "floor area". */
  readonly area?: Quantity;
}

export interface RaycastResult {
  readonly hit: boolean;
  readonly point?: Vec3;
  readonly distanceM?: number;
  readonly normal?: Vec3;
  readonly surfaceId?: string;
  readonly entityId?: string;
  readonly roomId?: string;
  readonly provenance: Provenance;
}

export interface VisibilityResult {
  readonly visible: boolean;
  readonly targetId: string;
  readonly blockedBy?: string;
  readonly blockedByLabel?: string;
}

export interface CollisionResult {
  readonly collides: boolean;
  readonly withIds: readonly string[];
  readonly withLabels: readonly string[];
}

export interface PathResultData {
  readonly nodes: readonly NavNode[];
  readonly points: readonly Vec3[];
  readonly length: Quantity;
  readonly roomSequence: readonly string[];
}

export interface FitResultData {
  readonly fits: boolean;
  readonly roomId: string;
  readonly sizeM: Vec3;
  readonly placements: readonly Obb[];
  readonly reason?: string;
}

export interface SurfaceInspection {
  readonly surface: Surface;
  readonly roomId?: string;
  readonly areaM2?: number;
  readonly isGlazed: boolean;
  readonly isReflective: boolean;
  /** Openings sitting in this surface — windows in a wall, a hatch in a ceiling. */
  readonly openings: readonly Opening[];
}

export interface WorldSummary {
  readonly worldId: string;
  readonly label: string;
  readonly version: number;
  readonly roomCount: number;
  readonly bedroomCount: number;
  readonly bathroomCount: number;
  readonly totalAreaM2: Quantity;
  readonly floors: number;
  readonly rooms: readonly {
    readonly id: string; readonly name: string; readonly kind: string;
    readonly areaM2: number;
  }[];
  readonly qualityVerdict: 'pass' | 'review' | 'fail';
  readonly measurementStandard: string;
}

export interface ProvenanceResult {
  readonly subjectId?: string;
  readonly point?: Vec3;
  /**
   * The subject's OWN provenance: did a camera see this object. Kept separate
   * from the volume it stands in, because "the sofa was observed but the room
   * around it was reconstructed" is two facts and collapsing them to the
   * weaker one throws away the answer to the question that was asked.
   */
  readonly provenance: Provenance;
  /** Provenance of the volume the subject occupies. Never stronger than useful. */
  readonly contextProvenance: Provenance;
  readonly observed: boolean;
  readonly confidence: number;
  /** Camera ids that saw it. Empty is itself informative. */
  readonly sources: readonly string[];
  readonly regionIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface RelationshipsResult {
  readonly subjectId: string;
  readonly relationships: readonly Relationship[];
}

// ---------------------------------------------------------------------------
// Turn accounting
// ---------------------------------------------------------------------------

export type Tier = 'deterministic' | 'small' | 'large';

/** One row of wv_ai_turn, built in the agent so the edge function only writes. */
export interface TurnRecord {
  readonly worldId: string;
  readonly sessionId: string | null;
  readonly tier: Tier;
  readonly model: string | null;
  readonly question: string;
  readonly tools: readonly ToolName[];
  readonly grounded: boolean;
  readonly refused: boolean;
  readonly inTokens: number;
  readonly outTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}
