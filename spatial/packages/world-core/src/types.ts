/**
 * World Viewer — the world contract.
 *
 * Every package in this system compiles against this file. The pipeline writes
 * these shapes, the spatial engine computes over them, the viewer renders them
 * and the agent answers from them. If a concept is not here, it is not part of
 * the world.
 *
 * Conventions, enforced everywhere:
 *   - Units are SI. Lengths in metres, angles in radians, areas in m². A number
 *     in this system is never "some unit the caller remembers".
 *   - The world frame is right-handed, +Y up, origin at the property's ground
 *     datum (the lowest reconstructed floor plane of the lowest floor).
 *   - Quaternions are [x, y, z, w].
 *   - Room footprints are 2D rings on the XZ plane; height lives in floorZ and
 *     ceilingZ. A property is mostly extruded polygons and this keeps it cheap.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
/** Column-major 4x4, same convention as three.js. */
export type Mat4 = readonly number[];

export interface Aabb { readonly min: Vec3; readonly max: Vec3 }
export interface Obb { readonly centre: Vec3; readonly half: Vec3; readonly quat: Quat }
/** Plane as n·x + d = 0, n normalised. */
export interface Plane { readonly n: Vec3; readonly d: number }
/** Closed ring on the XZ plane, counter-clockwise when viewed from above. */
export type Ring = readonly Vec2[];

// ---------------------------------------------------------------------------
// Provenance — the distinction the product rests on
// ---------------------------------------------------------------------------

/**
 * observed      a camera saw this
 * reconstructed geometry derived it from observations
 * inferred      a model estimated it (semantics, metric scale, layout closure)
 * generated     a model invented it; no observation supports it
 *
 * These never collapse into each other. A viewer must be able to tell a real
 * room from a plausible one, and the agent must refuse to assert across the
 * boundary. In UK property marketing that distinction is not a nicety: under
 * the DMCC Act 2024 a misleading representation is directly enforceable.
 */
export type Provenance = 'observed' | 'reconstructed' | 'inferred' | 'generated';

/** Ordering used when a fact is supported by several sources: worst wins. */
export const PROVENANCE_RANK: Record<Provenance, number> = {
  observed: 0, reconstructed: 1, inferred: 2, generated: 3,
};

export function weakestProvenance(...p: Provenance[]): Provenance {
  return p.reduce((a, b) => (PROVENANCE_RANK[b] > PROVENANCE_RANK[a] ? b : a), 'observed');
}

/** Attached to every derived fact. `sources` are camera ids where relevant. */
export interface Grounding {
  readonly provenance: Provenance;
  /** 0..1. Not a probability — a calibrated-ish confidence the pipeline sets. */
  readonly confidence: number;
  readonly sources?: readonly string[];
}

// ---------------------------------------------------------------------------
// Measurement — never a bare number
// ---------------------------------------------------------------------------

/**
 * Declared measurement standards. A stated area is meaningless without one:
 * GIA, NIA and IPMS 3 give different numbers for the same building, and the
 * UK mis-measurement record (1 in 8 London properties out by 100+ sq ft,
 * 60% overstated) is what happens when nobody declares which they used.
 */
export type MeasurementStandard =
  | 'RICS-COMP-GIA'   // RICS Code of Measuring Practice, gross internal area
  | 'RICS-COMP-NIA'   // net internal area
  | 'IPMS-3C'         // IPMS 3C, occupier level, internal dominant face
  | 'CLEAR-INTERNAL'; // wall face to wall face, no standard implied

/**
 * A quantity that can be shown to a customer. If any of value, standard or
 * tolerance is missing, it must not leave the system — that is a liability,
 * not a feature. `basis` records the geometry that produced it so a
 * measurement certificate can be reissued and defended later.
 */
export interface Quantity {
  readonly value: number;
  readonly unit: 'm' | 'm2' | 'm3' | 'deg';
  readonly standard: MeasurementStandard;
  /** Half-width of the interval, in millimetres for lengths, percent for areas. */
  readonly tolerance: number;
  readonly toleranceUnit: 'mm' | 'pct';
  readonly grounding: Grounding;
  readonly basis?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Cameras and observation — spatial context
// ---------------------------------------------------------------------------

export interface Intrinsics {
  readonly fx: number; readonly fy: number;
  readonly cx: number; readonly cy: number;
  readonly width: number; readonly height: number;
  readonly model?: 'pinhole' | 'opencv' | 'fisheye';
  readonly dist?: readonly number[];
}

/**
 * A camera is a first-class spatial object, not a rendering detail. Every frame
 * the pipeline ingests exists here with an explicit pose, which is what makes
 * "these two images show the same room" a computation rather than a guess.
 */
export interface Camera {
  readonly id: string;
  readonly captureId?: string;
  readonly frameIndex?: number;
  readonly tMs?: number;
  readonly position: Vec3;
  readonly orientation: Quat;
  readonly intrinsics: Intrinsics;
  readonly poseConfidence?: number;
  /** Variance-of-Laplacian; the blur-rejection stage writes it. */
  readonly sharpness?: number;
  readonly roomId?: string;
}

export type AssetRole =
  | 'splat' | 'splat_chunk' | 'proxy_mesh' | 'visual_mesh' | 'pointcloud'
  | 'floorplan' | 'cover' | 'depth_archive' | 'source_media' | 'export_bundle';

export interface Asset {
  readonly id: string;
  readonly role: AssetRole;
  readonly format: string;
  readonly url: string;
  readonly bytes?: number;
  readonly checksum?: string;
  readonly lod?: number;
  /** Room or tile key, for progressive room-by-room loading. */
  readonly chunkKey?: string;
  readonly splatCount?: number;
  readonly meta?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export type RoomKind =
  | 'living' | 'kitchen' | 'bedroom' | 'bathroom' | 'wc' | 'hall' | 'landing'
  | 'stairwell' | 'utility' | 'storage' | 'office' | 'dining' | 'conservatory'
  | 'garage' | 'balcony' | 'garden' | 'exterior' | 'unknown';

export type SurfaceKind = 'wall' | 'floor' | 'ceiling' | 'soffit' | 'column' | 'unknown';
export type OpeningKind = 'door' | 'doorway' | 'window' | 'rooflight' | 'stair' | 'hatch' | 'arch';

export interface Floor {
  readonly id: string;
  readonly level: number;       // 0 ground, -1 basement
  readonly name?: string;
  readonly elevation: number;   // metres, world Y
  readonly grounding: Grounding;
}

export interface Room {
  readonly id: string;
  /** Stable across rescans where matching succeeds. */
  readonly stableKey: string;
  readonly floorId?: string;
  readonly name?: string;
  readonly kind: RoomKind;
  readonly polygon: Ring;
  readonly floorZ: number;
  readonly ceilingZ: number;
  readonly area: Quantity;
  readonly grounding: Grounding;
}

export interface Surface {
  readonly id: string;
  readonly roomId?: string;
  readonly kind: SurfaceKind;
  readonly plane: Plane;
  readonly polygon: readonly Vec3[];
  readonly area?: Quantity;
  /**
   * Mirrors invent rooms and glazing blows out. Flagging them is how the
   * reconstruction stops trusting its own reflections, and how the viewer
   * knows not to let a camera walk through a mirror.
   */
  readonly isReflective: boolean;
  readonly isGlazed: boolean;
  readonly grounding: Grounding;
}

export interface Opening {
  readonly id: string;
  readonly kind: OpeningKind;
  readonly surfaceId?: string;
  readonly roomA?: string;
  readonly roomB?: string;
  readonly centre: Vec3;
  readonly normal?: Vec3;
  readonly width?: Quantity;
  readonly height?: Quantity;
  readonly sill?: Quantity;
  readonly grounding: Grounding;
}

/** One sofa is one sofa, across fifteen frames and across a rescan. */
export interface Entity {
  readonly id: string;
  readonly stableKey: string;
  readonly label: string;
  readonly category: 'furniture' | 'appliance' | 'fixture' | 'fitting' | 'structure' | 'other';
  readonly roomId?: string;
  readonly centroid: Vec3;
  readonly aabb: Aabb;
  readonly obb?: Obb;
  /** Camera ids that established it. Provenance is a receipt, not a label. */
  readonly observedIn: readonly string[];
  readonly grounding: Grounding;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Scene graph — computed from geometry, never asked of a language model
// ---------------------------------------------------------------------------

export type Predicate =
  | 'inside' | 'contains' | 'adjacent_to' | 'connected_to' | 'near' | 'far_from'
  | 'above' | 'below' | 'left_of' | 'right_of' | 'attached_to' | 'intersects'
  | 'visible_from' | 'blocks' | 'opens_into' | 'supports' | 'located_on';

export type NodeType = 'room' | 'entity' | 'surface' | 'opening' | 'floor';

export interface Relationship {
  readonly subjectType: NodeType;
  readonly subjectId: string;
  readonly predicate: Predicate;
  readonly objectType: NodeType;
  readonly objectId: string;
  /** Metres for near/far, radians for angular, 0..1 for overlap. */
  readonly value?: number;
  readonly grounding: Grounding;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavNode {
  readonly id: string;
  readonly roomId?: string;
  readonly position: Vec3;
  /** Radius of free space. The camera controller will not enter below its own. */
  readonly clearance: number;
  readonly isEntrance: boolean;
  readonly isViewpoint: boolean;
}

export interface NavEdge {
  readonly a: string;
  readonly b: string;
  readonly cost: number;
  readonly width?: number;
  readonly kind: 'walk' | 'door' | 'stair';
  readonly openingId?: string;
}

// ---------------------------------------------------------------------------
// What was never seen
// ---------------------------------------------------------------------------

/**
 * If a camera never looked behind a wall, the system must not behave as though
 * it did. Unobserved and generated volumes are recorded explicitly so the
 * viewer can mark them and the agent can decline to answer inside them.
 */
export interface Region {
  readonly id: string;
  readonly provenance: Exclude<Provenance, 'reconstructed'>;
  readonly volume: Aabb;
  readonly roomId?: string;
  readonly reason?: string;
  readonly confidence?: number;
}

// ---------------------------------------------------------------------------
// The world document
// ---------------------------------------------------------------------------

/**
 * The complete, self-contained world. This is what the viewer loads, what the
 * agent reasons over, and what an export bundle contains — so that a customer
 * who takes their bundle and walks away still has a working world, with no
 * call back to us. That is the permanence promise, expressed as a data type.
 */
export interface WorldDocument {
  readonly formatVersion: 1;
  readonly id: string;
  readonly propertyId: string;
  readonly version: number;
  readonly slug?: string;
  readonly label: string;
  readonly createdAt: string;
  readonly publishedAt?: string;

  readonly units: { readonly length: 'm'; readonly angle: 'rad' };
  readonly upAxis: 'Y';
  readonly handedness: 'right';

  /** How metric scale was fixed, and how well the estimators agreed. */
  readonly scale: {
    readonly source: string;
    readonly agreement: number;
    readonly grounding: Grounding;
  };

  readonly floors: readonly Floor[];
  readonly rooms: readonly Room[];
  readonly surfaces: readonly Surface[];
  readonly openings: readonly Opening[];
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  readonly nav: { readonly nodes: readonly NavNode[]; readonly edges: readonly NavEdge[] };
  readonly regions: readonly Region[];
  readonly cameras: readonly Camera[];
  readonly assets: readonly Asset[];

  readonly quality: QualityReport;
  /** Declared once, applied to every dimension the viewer shows. */
  readonly measurementPolicy: {
    readonly areaStandard: MeasurementStandard;
    readonly areaTolerancePct: number;
    readonly wallToleranceMm: number;
  };
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

export interface QualityCheck {
  readonly name: string;
  readonly value: number;
  readonly threshold: number;
  readonly higherIsBetter: boolean;
  readonly pass: boolean;
  readonly detail?: string;
}

/**
 * A world becomes viewable because it passed, not because the pipeline
 * finished. `fail` blocks publication outright; `review` routes to an operator.
 */
export interface QualityReport {
  readonly checks: readonly QualityCheck[];
  readonly score: number;
  readonly verdict: 'pass' | 'review' | 'fail';
  readonly createdAt: string;
}
