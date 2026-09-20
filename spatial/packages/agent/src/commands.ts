/**
 * ViewerCommand — the agent's half of the viewer contract.
 *
 * An answer in this product is not only text. "How far is the sofa from the
 * window" should draw the tape measure; "show me the second bedroom" should
 * fly the camera there along a path that does not pass through a wall. So an
 * agent turn returns prose AND a list of commands, and the viewer applies
 * them.
 *
 * Three rules govern this file, all of them about the boundary:
 *
 * 1. EVERY COMMAND IS PLAIN JSON. No functions, no class instances, no
 *    Float32Array. A command is produced in an edge function, travels over the
 *    wire, and is applied in a browser; anything that does not survive
 *    JSON.stringify is a bug waiting for a deploy.
 *
 * 2. COMMANDS DESCRIBE INTENT, NOT RENDERING. `focusRoom` says which room
 *    matters, not which framebuffer to clear. The viewer owns easing curves,
 *    materials, label placement and collision with its own UI. If a field here
 *    would only ever be read by one renderer implementation, it does not
 *    belong here.
 *
 * 3. GEOMETRY IS ALREADY SOLVED. A camera move carries nav-graph waypoints the
 *    spatial engine produced, not a start and an end for the viewer to path
 *    between. The engine is the only component allowed to decide what is
 *    walkable, so the viewer never has to reproduce that logic and the two can
 *    never disagree.
 *
 * Unknown command kinds must be ignored rather than treated as an error: this
 * list will grow, and a viewer built against an older version of it should
 * degrade to "answered in text but did not animate", never to a broken turn.
 */

import type { Quat, Vec3 } from '@m3xi/world-core';

/** Milliseconds. A viewer may clamp, but should not silently ignore. */
export type DurationMs = number;

/**
 * Why the agent is issuing this command. The viewer uses it to decide what to
 * clear: a new `answer` measurement replaces the previous one, whereas a
 * `context` highlight (what the agent believes you are looking at) sits
 * underneath and is replaced only by another context highlight.
 */
export type CommandIntent = 'answer' | 'context' | 'navigation';

export interface CommandBase {
  readonly kind: string;
  readonly intent: CommandIntent;
  /**
   * Stable within a turn. The viewer uses it to de-duplicate on retry and to
   * address an overlay for later removal.
   */
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface CameraWaypoint {
  readonly position: Vec3;
  /** Optional: when absent the viewer aims along the path tangent. */
  readonly orientation?: Quat;
  /** Nav node id this waypoint came from, for debugging and for replay. */
  readonly navNodeId?: string;
}

/**
 * Fly the camera along a route the engine solved with `findPath`. The
 * waypoints are nav-graph nodes: walking them in order never crosses a wall,
 * and `clearance` at each node was already checked against the camera radius.
 */
export interface MoveCameraCommand extends CommandBase {
  readonly kind: 'moveCamera';
  readonly waypoints: readonly CameraWaypoint[];
  /** Total travel time for the whole route, not per waypoint. */
  readonly durationMs: DurationMs;
  /** What the camera should end up aimed at, when the answer has a subject. */
  readonly lookAt?: Vec3;
  /** Present when the route came from the nav graph rather than a single hop. */
  readonly pathLengthM?: number;
}

/** Turn on the spot: "what is behind me", "look at the window". */
export interface LookAtCommand extends CommandBase {
  readonly kind: 'lookAt';
  readonly target: Vec3;
  readonly durationMs: DurationMs;
}

// ---------------------------------------------------------------------------
// Selection and emphasis
// ---------------------------------------------------------------------------

export type HighlightStyle = 'primary' | 'secondary' | 'warning';

/**
 * Emphasise entities. `warning` is reserved for geometry the agent is telling
 * the user not to trust — an inferred bounding box, an object inside a
 * generated region — so the colour must differ visibly from `primary`.
 */
export interface HighlightEntitiesCommand extends CommandBase {
  readonly kind: 'highlightEntities';
  readonly entityIds: readonly string[];
  readonly style: HighlightStyle;
  /** Null or absent means "until something replaces it". */
  readonly ttlMs?: DurationMs;
}

/** Make one entity the selection, which the resolver then treats as "it". */
export interface SelectEntityCommand extends CommandBase {
  readonly kind: 'selectEntity';
  readonly entityId: string;
}

export interface FocusRoomCommand extends CommandBase {
  readonly kind: 'focusRoom';
  readonly roomId: string;
  /** Dim everything outside the room. Off for "compare the two bedrooms". */
  readonly isolate: boolean;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/**
 * A dimension line. `label` is fully formatted by the agent — including the
 * tolerance and, where it matters, the standard — because the phrasing of a
 * measurement is a liability decision and must not be re-derived by a renderer
 * that does not know the measurement policy.
 */
export interface MeasurementOverlayCommand extends CommandBase {
  readonly kind: 'measurementOverlay';
  readonly from: Vec3;
  readonly to: Vec3;
  readonly label: string;
  readonly valueM: number;
  readonly toleranceMm: number;
  /** Drives the styling that marks an undefendable number as such. */
  readonly provenance: 'observed' | 'reconstructed' | 'inferred' | 'generated';
  readonly defensible: boolean;
}

/** Shade a room's footprint and print its area. Used for area answers. */
export interface AreaOverlayCommand extends CommandBase {
  readonly kind: 'areaOverlay';
  readonly roomId: string;
  readonly polygon: readonly (readonly [number, number])[];
  readonly floorY: number;
  readonly label: string;
  readonly valueM2: number;
  readonly tolerancePct: number;
  readonly standard: string;
  readonly defensible: boolean;
}

/** Draw the route the camera is about to take, or the one just measured. */
export interface PathOverlayCommand extends CommandBase {
  readonly kind: 'pathOverlay';
  readonly points: readonly Vec3[];
  readonly label?: string;
  readonly lengthM: number;
}

/**
 * Mark a volume nothing observed. This is the honest counterpart to a refusal:
 * when the agent declines to answer, it shows the user the hole in the capture
 * rather than only asserting that one exists.
 */
export interface RegionOverlayCommand extends CommandBase {
  readonly kind: 'regionOverlay';
  readonly regionIds: readonly string[];
  readonly provenance: 'inferred' | 'generated';
  readonly label: string;
}

/**
 * A proposed placement from a fit test: "the wardrobe goes here". The viewer
 * draws a ghost box at this pose.
 */
export interface PlacementOverlayCommand extends CommandBase {
  readonly kind: 'placementOverlay';
  readonly centre: Vec3;
  readonly half: Vec3;
  readonly quat: Quat;
  readonly label: string;
  readonly fits: boolean;
}

/** Remove overlays. Empty `ids` means "everything this agent put on screen". */
export interface ClearOverlaysCommand extends CommandBase {
  readonly kind: 'clearOverlays';
  readonly ids: readonly string[];
}

export type ViewerCommand =
  | MoveCameraCommand
  | LookAtCommand
  | HighlightEntitiesCommand
  | SelectEntityCommand
  | FocusRoomCommand
  | MeasurementOverlayCommand
  | AreaOverlayCommand
  | PathOverlayCommand
  | RegionOverlayCommand
  | PlacementOverlayCommand
  | ClearOverlaysCommand;

export type ViewerCommandKind = ViewerCommand['kind'];

export const VIEWER_COMMAND_KINDS: readonly ViewerCommandKind[] = [
  'moveCamera', 'lookAt', 'highlightEntities', 'selectEntity', 'focusRoom',
  'measurementOverlay', 'areaOverlay', 'pathOverlay', 'regionOverlay',
  'placementOverlay', 'clearOverlays',
];

/**
 * Structural validation at the boundary. The viewer half of this contract is
 * being written in parallel by someone else, so both sides get to assert the
 * same shape rather than trusting a shared type declaration that only exists
 * at compile time.
 */
export function isViewerCommand(v: unknown): v is ViewerCommand {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c['id'] !== 'string' || c['id'].length === 0) return false;
  if (c['intent'] !== 'answer' && c['intent'] !== 'context' && c['intent'] !== 'navigation') {
    return false;
  }
  if (typeof c['kind'] !== 'string') return false;
  if (!VIEWER_COMMAND_KINDS.includes(c['kind'] as ViewerCommandKind)) return false;

  const v3 = (x: unknown): boolean => Array.isArray(x) && x.length === 3
    && x.every((n) => typeof n === 'number' && Number.isFinite(n));

  switch (c['kind'] as ViewerCommandKind) {
    case 'moveCamera':
      return Array.isArray(c['waypoints'])
        && c['waypoints'].every((w) => typeof w === 'object' && w !== null
          && v3((w as Record<string, unknown>)['position']))
        && typeof c['durationMs'] === 'number';
    case 'lookAt':
      return v3(c['target']) && typeof c['durationMs'] === 'number';
    case 'highlightEntities':
      return Array.isArray(c['entityIds']) && c['entityIds'].every((e) => typeof e === 'string');
    case 'selectEntity':
      return typeof c['entityId'] === 'string';
    case 'focusRoom':
      return typeof c['roomId'] === 'string' && typeof c['isolate'] === 'boolean';
    case 'measurementOverlay':
      return v3(c['from']) && v3(c['to']) && typeof c['label'] === 'string'
        && typeof c['valueM'] === 'number';
    case 'areaOverlay':
      return typeof c['roomId'] === 'string' && Array.isArray(c['polygon'])
        && typeof c['valueM2'] === 'number';
    case 'pathOverlay':
      return Array.isArray(c['points']) && c['points'].every(v3)
        && typeof c['lengthM'] === 'number';
    case 'regionOverlay':
      return Array.isArray(c['regionIds']) && c['regionIds'].every((r) => typeof r === 'string');
    case 'placementOverlay':
      return v3(c['centre']) && v3(c['half']) && typeof c['fits'] === 'boolean';
    case 'clearOverlays':
      return Array.isArray(c['ids']) && c['ids'].every((i) => typeof i === 'string');
  }
}
