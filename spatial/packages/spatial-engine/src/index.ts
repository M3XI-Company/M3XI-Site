/**
 * @m3xi/spatial-engine
 *
 * Deterministic spatial computation over a WorldDocument. Pure TypeScript, no
 * runtime dependencies, no DOM, no network: identical results in a browser, in
 * a Deno edge function and in Node.
 *
 * The contract it computes over lives in @m3xi/world-core and is not modified
 * here. Where this engine needs a concept the contract does not carry -- the
 * refusal flag on a measurement, for instance -- it goes in `Quantity.basis`
 * rather than in a new field.
 */

export { World } from './world.js';
export type { VisibleSet, FitResult, PathResult } from './world.js';

export { buildSceneGraph, roomFrame, SCENE_GRAPH_THRESHOLDS } from './sceneGraph.js';
export type { SceneGraphOpts, RoomFrame } from './sceneGraph.js';

export type { ProxyMesh, RayHit, Target } from './types.js';

export {
  areaQuantity, combineInQuadrature, Evidence, isDefensible, LENGTH_STANDARD,
  lengthQuantity, PROVENANCE_TOLERANCE_FACTOR, refusalReason, toleranceFactor,
} from './measure.js';
export type { AreaOpts, LengthOpts } from './measure.js';

export { buildSoup, roomAnchor } from './proxy.js';
export type { Soup } from './proxy.js';

export { Bvh } from './accel/bvh.js';
export type { BvhClosest, BvhRayHit } from './accel/bvh.js';
export { XZGrid } from './accel/xzGrid.js';
export type { Bounds2 } from './accel/xzGrid.js';

export * as math from './math/index.js';
