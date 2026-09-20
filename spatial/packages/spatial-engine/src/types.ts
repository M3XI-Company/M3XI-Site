import type { Provenance, Vec3 } from '@m3xi/world-core';

/**
 * A triangle soup the pipeline exports for collision and occlusion. Positions
 * are xyz triples in world metres; indices are triangle corners.
 *
 * `surfaceIds`, when present, is interpreted as an index into
 * `WorldDocument.surfaces` -- one entry per triangle, or one per vertex (in
 * which case the first corner's value wins). Values outside the surface array
 * mean "no attribution", which is what an untagged triangle gets.
 */
export interface ProxyMesh {
  positions: Float32Array;
  indices: Uint32Array;
  surfaceIds?: Uint32Array;
}

export type Target =
  | Vec3
  | { entityId: string }
  | { roomId: string }
  | { openingId: string }
  | { surfaceId: string };

export interface RayHit {
  point: Vec3;
  distance: number;
  /** Unit geometric normal of the hit triangle, flipped to oppose the ray. */
  normal: Vec3;
  surfaceId?: string;
  entityId?: string;
  provenance: Provenance;
}
