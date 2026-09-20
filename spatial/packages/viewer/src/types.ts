import type { Provenance, Quat, Vec3, WorldDocument } from '@m3xi/world-core';

/**
 * Viewer-facing types.
 *
 * Everything here is DOM-free and GPU-free on purpose: the constraint solver,
 * the measurement formatter, the narrative generator and the agent seam are all
 * testable in Node, and only `render/` and `ui/` reach for WebGL or a document.
 */

/** A camera pose in world metres. Yaw/pitch are radians; yaw 0 looks down -Z. */
export interface CameraPose {
  readonly position: Vec3;
  readonly yaw: number;
  readonly pitch: number;
}

export function poseQuat(pose: CameraPose): Quat {
  // three.js YXZ order: yaw about +Y then pitch about the rotated +X.
  const cy = Math.cos(pose.yaw / 2);
  const sy = Math.sin(pose.yaw / 2);
  const cp = Math.cos(pose.pitch / 2);
  const sp = Math.sin(pose.pitch / 2);
  return [sp * cy, sy * cp, -sp * sy, cp * cy];
}

/**
 * How a world is being shown.
 *
 * `operator` is internal review: diagnostics, provenance controls and the
 * proxy-only shell are all available. `visitor` is the published experience.
 * `embed` is `visitor` minus anything an agency would not want on their own
 * site, plus their branding.
 */
export type ViewerMode = 'operator' | 'visitor' | 'embed';

export type ViewerTheme = 'light' | 'dark' | 'system';

export interface ViewerBranding {
  /** Agency name shown in embed mode. Plain text, never HTML. */
  readonly name?: string;
  /** Absolute or same-origin URL of a logo; rendered at 24px tall. */
  readonly logoUrl?: string;
  /** A single accent colour, any CSS colour. Contrast is checked at runtime. */
  readonly accent?: string;
  /** Where the agency wants "view listing" to go. */
  readonly listingUrl?: string;
}

export interface ViewerOptions {
  readonly doc: WorldDocument;
  readonly mode?: ViewerMode;
  readonly theme?: ViewerTheme;
  readonly branding?: ViewerBranding;
  /** Resolves an `Asset.url` (often `asset://...`) to something fetchable. */
  readonly resolveAssetUrl?: (url: string, doc: WorldDocument) => string;
  /** Locale for number and list formatting. */
  readonly locale?: string;
  /** Override the reduced-motion decision (defaults to the media query). */
  readonly reducedMotion?: boolean;
  /** Splat budget for this device, in Gaussians. Defaults by device class. */
  readonly splatBudget?: number;
  /** Start the visitor somewhere other than the entrance node. */
  readonly startNodeId?: string;
  /** The agent layer. Omitted means the Ask panel is not shown. */
  readonly agent?: import('./agent/contract.js').AgentPort;
  /**
   * Where the viewer reports what the visitor did: which rooms they entered,
   * how long they stayed, what they measured, what they asked, when they left.
   *
   * Omitted means the tour is not reported at all, and that is the default on
   * purpose. The viewer never opens a connection of its own -- it hands the
   * host page a fact and the host decides whether anything is listening, which
   * is what keeps this package embeddable by an agency serving a document from
   * their own origin, and what makes "do not track this visitor" a matter of
   * not passing this function rather than a flag somewhere inside it.
   *
   * It is called synchronously from the viewer's own code, so it should return
   * quickly and must not assume it can throw; see ViewerEventRecorder.
   */
  readonly onEvent?: import('./events/session.js').ViewerEventSink;
}

/** Why the viewer will not put the camera somewhere. */
export type BlockReason =
  | 'collision'   // proxy geometry is in the way
  | 'mirror'      // a reflective surface; the space behind it is not real
  | 'unsurveyed'  // no camera ever observed it
  | 'clearance'   // the gap is narrower than the camera's own radius
  | 'offgraph'    // outside every room and away from every nav corridor
  | 'invalid';    // NaN or infinite input

export interface MoveResult {
  readonly position: Vec3;
  readonly moved: boolean;
  readonly blocked: boolean;
  readonly reason?: BlockReason;
  /** Id of the surface, entity or room that stopped the move. */
  readonly blockedBy?: string;
  /** True when the move was redirected along a wall rather than stopped. */
  readonly slid: boolean;
  readonly roomId?: string;
  readonly provenance: Provenance;
}

/** Geometry a measurement wants drawn in the 3D view. DOM-free by design. */
export interface MeasurementOverlay {
  readonly id: string;
  readonly kind: 'distance' | 'area' | 'clearance' | 'fit';
  /** Polylines in world metres. */
  readonly lines: ReadonlyArray<readonly Vec3[]>;
  /** Closed rings in world metres, drawn as translucent fills. */
  readonly polygons: ReadonlyArray<readonly Vec3[]>;
  /** Text anchored to a world point. Rendered as real DOM, not a texture. */
  readonly labels: ReadonlyArray<{
    readonly at: Vec3;
    readonly text: string;
    readonly detail?: string;
    readonly status: 'defensible' | 'indicative';
  }>;
  /** Footprints for a fit test: oriented rectangles on the floor. */
  readonly footprints: ReadonlyArray<{
    readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
    readonly ok: boolean;
  }>;
}

export const EMPTY_OVERLAY: MeasurementOverlay = {
  id: 'empty', kind: 'distance', lines: [], polygons: [], labels: [], footprints: [],
};
