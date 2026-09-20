/**
 * The tool surface.
 *
 * Twenty-one tools over the spatial engine. Every one of them returns
 * structured data with grounding attached and never a sentence: phrasing is a
 * separate concern (see phrase.ts) precisely so that a language model, when
 * one is involved at all, is handed facts it cannot quietly change.
 *
 * Three invariants hold across the file:
 *
 *   - A tool never invents an id. If a reference does not resolve, the tool
 *     returns a `not_found` refusal; it does not pick the nearest-sounding
 *     thing and hope.
 *   - A tool never returns a number without its grounding. Where the engine
 *     produces a `Quantity` that is automatic; where it does not, the tool
 *     builds one with `Evidence` so the tolerance rules still apply.
 *   - The three side-effecting tools (highlight, move, select) do not touch
 *     the world. They emit `ViewerCommand`s and update `ViewerState`, which is
 *     the only mutable thing the agent owns.
 */

import type {
  Entity, Grounding, Obb, Opening, Provenance, Quantity, Room, Surface, Vec3,
} from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';
import {
  Evidence, World, areaQuantity, isDefensible, lengthQuantity, math, refusalReason,
} from '@m3xi/spatial-engine';

import type { ViewerCommand } from './commands.js';
import type {
  CameraState, CollisionResult, DimensionsResult, FitResultData, GeometryResult,
  PathResultData, ProvenanceResult, RaycastResult, RelationshipsResult, SurfaceInspection,
  ToolFail, ToolName, ToolOk, ToolResult, VisibilityResult, VisibleEntitiesResult,
  WorldSummary,
} from './types.js';
import type { ViewerState } from './view.js';

/** Height a standing person's eye sits at, used for "from where I am" rays. */
const EYE_HEIGHT_M = 1.6;

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok<T>(
  tool: ToolName, data: T, grounding: Grounding, consulted: readonly string[] = [],
): ToolOk<T> {
  return { ok: true, tool, data, grounding, consulted };
}

function fail(
  tool: ToolName, code: ToolFail['refusal']['code'], reason: string,
  evidenceIds?: readonly string[],
): ToolFail {
  return {
    ok: false,
    tool,
    refusal: evidenceIds && evidenceIds.length > 0
      ? { code, reason, evidenceIds }
      : { code, reason },
  };
}

/** Weakest provenance, lowest confidence, union of sources. */
export function mergeGrounding(...gs: readonly (Grounding | undefined)[]): Grounding {
  let provenance: Provenance | null = null;
  let confidence = 1;
  const sources = new Set<string>();
  for (const g of gs) {
    if (!g) continue;
    provenance = provenance === null ? g.provenance : weakestProvenance(provenance, g.provenance);
    if (Number.isFinite(g.confidence)) confidence = Math.min(confidence, g.confidence);
    for (const s of g.sources ?? []) sources.add(s);
  }
  if (provenance === null) return { provenance: 'inferred', confidence: 0.5 };
  return sources.size > 0
    ? { provenance, confidence, sources: [...sources] }
    : { provenance, confidence };
}

function quantityGrounding(q: Quantity | undefined): Grounding | undefined {
  return q?.grounding;
}

// ---------------------------------------------------------------------------
// Reference resolution at the tool boundary
// ---------------------------------------------------------------------------

export type WorldRef =
  | { readonly type: 'entity'; readonly entity: Entity }
  | { readonly type: 'room'; readonly room: Room }
  | { readonly type: 'surface'; readonly surface: Surface }
  | { readonly type: 'opening'; readonly opening: Opening };

export function refId(r: WorldRef): string {
  switch (r.type) {
    case 'entity': return r.entity.id;
    case 'room': return r.room.id;
    case 'surface': return r.surface.id;
    case 'opening': return r.opening.id;
  }
}

export function refLabel(r: WorldRef): string {
  switch (r.type) {
    case 'entity': return r.entity.label;
    case 'room': return r.room.name ?? r.room.kind;
    case 'surface': return `${r.surface.kind} surface`;
    case 'opening': return r.opening.kind;
  }
}

export function refGrounding(r: WorldRef): Grounding {
  switch (r.type) {
    case 'entity': return r.entity.grounding;
    case 'room': return r.room.grounding;
    case 'surface': return r.surface.grounding;
    case 'opening': return r.opening.grounding;
  }
}

/** The point a reference measures from: centroid, anchor or centre. */
export function refPoint(r: WorldRef): Vec3 {
  switch (r.type) {
    case 'entity': return r.entity.centroid;
    case 'room': {
      const ring = math.sanitiseRing(r.room.polygon);
      const c = ring.length >= 3 ? math.ringCentroid(ring) : ([0, 0] as const);
      const floorY = Number.isFinite(r.room.floorZ) ? r.room.floorZ : 0;
      return [c[0], floorY + EYE_HEIGHT_M, c[1]];
    }
    case 'surface': {
      const pts = r.surface.polygon.filter(math.isFiniteV3);
      if (pts.length === 0) return [0, 0, 0];
      return math.scale(pts.reduce(math.add, [0, 0, 0] as Vec3), 1 / pts.length);
    }
    case 'opening': return r.opening.centre;
  }
}

// ---------------------------------------------------------------------------
// The toolset
// ---------------------------------------------------------------------------

export interface ToolsOpts {
  /** Collects the side effects the viewer should apply. */
  readonly emit: (command: ViewerCommand) => void;
  /** Monotonic id source, injected so tests are deterministic. */
  readonly nextCommandId: () => string;
}

export class Tools {
  readonly world: World;
  readonly view: ViewerState;
  private readonly emit: (command: ViewerCommand) => void;
  private readonly nextCommandId: () => string;
  /** Tools actually invoked this turn, in order, for the audit row. */
  readonly used: ToolName[] = [];

  constructor(world: World, view: ViewerState, opts: ToolsOpts) {
    this.world = world;
    this.view = view;
    this.emit = opts.emit;
    this.nextCommandId = opts.nextCommandId;
  }

  private mark(t: ToolName): void {
    if (this.used[this.used.length - 1] !== t) this.used.push(t);
  }

  // -------------------------------------------------------------------------
  // Lookup by id or by name
  // -------------------------------------------------------------------------

  /**
   * Resolve an opaque reference to a world object. Tries ids first (exact,
   * cheap, unambiguous) and only then names. Name matching is deliberately
   * strict-to-loose in stages and stops at the first stage that produces
   * exactly one candidate, because "the bed" in a flat with a double bed and a
   * single bed is an ambiguity the agent must surface rather than resolve by
   * coin toss.
   */
  lookup(ref: string, opts?: { readonly roomId?: string }): WorldRef | WorldRef[] | null {
    if (typeof ref !== 'string' || ref.length === 0) return null;
    const doc = this.world.doc;

    const e = this.world.entity(ref);
    if (e) return { type: 'entity', entity: e };
    const r = this.world.room(ref);
    if (r) return { type: 'room', room: r };
    const s = this.world.surface(ref);
    if (s) return { type: 'surface', surface: s };
    const o = this.world.opening(ref);
    if (o) return { type: 'opening', opening: o };

    const needle = ref.trim().toLowerCase();
    if (needle.length === 0) return null;

    const pool: WorldRef[] = [];
    for (const room of doc.rooms) pool.push({ type: 'room', room });
    for (const entity of doc.entities) pool.push({ type: 'entity', entity });
    for (const opening of doc.openings) pool.push({ type: 'opening', opening });

    const scoped = opts?.roomId
      ? pool.filter((p) => {
        if (p.type === 'entity') return (p.entity.roomId ?? '') === opts.roomId;
        if (p.type === 'room') return p.room.id === opts.roomId;
        if (p.type === 'opening') return p.opening.roomA === opts.roomId || p.opening.roomB === opts.roomId;
        return false;
      })
      : pool;
    const search = scoped.length > 0 ? scoped : pool;

    const names = (p: WorldRef): string[] => {
      switch (p.type) {
        case 'room': return [p.room.name ?? '', p.room.kind, p.room.stableKey].filter(Boolean);
        case 'entity': return [p.entity.label, p.entity.stableKey].filter(Boolean);
        case 'opening': return [p.opening.kind, p.opening.id].filter(Boolean);
        case 'surface': return [p.surface.kind];
      }
    };

    const exact = search.filter((p) => names(p).some((n) => n.toLowerCase() === needle));
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return exact;

    // Word-boundary containment, not substring. "bed" must match "double bed"
    // and "single bed" but NOT "bedroom 1" or "bedside table": a substring
    // match quietly turns a two-candidate ambiguity into a five-candidate one
    // and then resolves it on irrelevant evidence.
    const word = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const contains = search.filter((p) => names(p).some((n) => word.test(n.toLowerCase())));
    if (contains.length === 1) return contains[0]!;
    if (contains.length > 1) return contains;

    // Last resort: the needle contains the name ("the kitchen window" -> window).
    const reverse = search.filter((p) => names(p).some((n) => n.length >= 3 && needle.includes(n.toLowerCase())));
    if (reverse.length === 1) return reverse[0]!;
    if (reverse.length > 1) return reverse;
    return null;
  }

  private resolveOne(tool: ToolName, ref: string): WorldRef | ToolFail {
    const hit = this.lookup(ref);
    if (hit === null) return fail(tool, 'not_found', `nothing in this capture is called "${ref}"`);
    if (Array.isArray(hit)) {
      const names = hit.slice(0, 5).map((h) => `${refLabel(h)} (${refId(h)})`);
      return fail(tool, 'ambiguous', `"${ref}" matches ${hit.length}: ${names.join(', ')}`,
        hit.map(refId));
    }
    return hit;
  }

  // -------------------------------------------------------------------------
  // 1. get_current_camera
  // -------------------------------------------------------------------------

  get_current_camera(): ToolResult<CameraState> {
    this.mark('get_current_camera');
    const room = this.world.roomAt(this.view.position);
    const state: CameraState = {
      position: this.view.position,
      orientation: this.view.orientation,
      fovRad: this.view.fovRad,
      ...(room ? { roomId: room.id } : {}),
    };
    // The pose itself is a viewer fact, not a reconstruction fact; what carries
    // provenance is the geometry it sits in.
    const g: Grounding = room
      ? room.grounding
      : { provenance: this.world.provenanceAt(this.view.position), confidence: 0.5 };
    return ok('get_current_camera', state, g, room ? [room.id] : []);
  }

  // -------------------------------------------------------------------------
  // 2. get_current_room
  // -------------------------------------------------------------------------

  get_current_room(): ToolResult<Room> {
    this.mark('get_current_room');
    const room = this.world.roomAt(this.view.position);
    if (!room) {
      return fail('get_current_room', 'not_established',
        'the camera is not inside any reconstructed room outline');
    }
    return ok('get_current_room', room, room.grounding, [room.id]);
  }

  // -------------------------------------------------------------------------
  // 3. get_visible_entities
  // -------------------------------------------------------------------------

  get_visible_entities(opts?: { readonly maxDistance?: number }): ToolResult<VisibleEntitiesResult> {
    this.mark('get_visible_entities');
    const set = this.world.visibleFrom(
      { position: this.view.position, orientation: this.view.orientation, fov: this.view.fovRad },
      { maxDistance: Number.isFinite(opts?.maxDistance) ? opts!.maxDistance! : 30 },
    );
    const g = mergeGrounding(
      ...set.entities.map((e) => e.grounding),
      ...set.rooms.map((r) => r.grounding),
    );
    const consulted = [
      ...set.entities.map((e) => e.id),
      ...set.openings.map((o) => o.id),
      ...set.rooms.map((r) => r.id),
    ];
    return ok('get_visible_entities', set, g, consulted);
  }

  // -------------------------------------------------------------------------
  // 4. get_entity
  // -------------------------------------------------------------------------

  get_entity(ref: string): ToolResult<Entity> {
    this.mark('get_entity');
    const hit = this.resolveOne('get_entity', ref);
    if ('ok' in hit) return hit;
    if (hit.type !== 'entity') {
      return fail('get_entity', 'not_found', `"${ref}" is a ${hit.type}, not an object in the room`);
    }
    return ok('get_entity', hit.entity, hit.entity.grounding, [hit.entity.id]);
  }

  // -------------------------------------------------------------------------
  // 5. find_entities
  // -------------------------------------------------------------------------

  find_entities(q: {
    readonly label?: string; readonly category?: string; readonly roomId?: string;
    readonly near?: Vec3; readonly within?: number; readonly limit?: number;
  } = {}): ToolResult<readonly Entity[]> {
    this.mark('find_entities');
    if (q.roomId !== undefined && !this.world.room(q.roomId)) {
      return fail('find_entities', 'not_found', `no room "${q.roomId}" in this capture`);
    }
    const found = this.world.findEntities(q);
    const g = found.length > 0
      ? mergeGrounding(...found.map((e) => e.grounding))
      : ({ provenance: 'observed', confidence: 1 } as Grounding);
    // An empty result is a real, grounded answer -- "there is no dishwasher" --
    // and must not be confused with a failure to look.
    return ok('find_entities', found, g, found.map((e) => e.id));
  }

  // -------------------------------------------------------------------------
  // 6. get_room
  // -------------------------------------------------------------------------

  get_room(ref: string): ToolResult<Room> {
    this.mark('get_room');
    const hit = this.resolveOne('get_room', ref);
    if ('ok' in hit) return hit;
    if (hit.type === 'room') return ok('get_room', hit.room, hit.room.grounding, [hit.room.id]);
    // "the room the sofa is in" is a legitimate way to name a room.
    const rid = hit.type === 'entity' ? hit.entity.roomId
      : hit.type === 'opening' ? hit.opening.roomA
        : hit.surface.roomId;
    const room = rid ? this.world.room(rid) : undefined;
    if (!room) return fail('get_room', 'not_found', `"${ref}" is not in any identified room`);
    return ok('get_room', room, room.grounding, [room.id]);
  }

  // -------------------------------------------------------------------------
  // 7. get_geometry
  // -------------------------------------------------------------------------

  get_geometry(ref: string): ToolResult<GeometryResult> {
    this.mark('get_geometry');
    const hit = this.resolveOne('get_geometry', ref);
    if ('ok' in hit) return hit;
    const id = refId(hit);
    const g = refGrounding(hit);

    if (hit.type === 'entity') {
      const e = hit.entity;
      const data: GeometryResult = {
        id, type: 'entity', aabb: e.aabb, centroid: e.centroid,
        ...(e.obb ? { obb: e.obb } : {}),
      };
      return ok('get_geometry', data, g, [id]);
    }
    if (hit.type === 'room') {
      const r = hit.room;
      const ring = math.sanitiseRing(r.polygon);
      const b = ring.length >= 3 ? math.ringBounds(ring) : null;
      const floorY = Number.isFinite(r.floorZ) ? r.floorZ : 0;
      const ceilY = Number.isFinite(r.ceilingZ) && r.ceilingZ > floorY ? r.ceilingZ : floorY + 2.4;
      const data: GeometryResult = {
        id, type: 'room',
        polygon: ring.map((v) => [v[0], v[1]] as const),
        centroid: refPoint(hit),
        floorY, ceilingY: ceilY,
        ...(b ? { aabb: { min: [b.minX, floorY, b.minZ] as Vec3, max: [b.maxX, ceilY, b.maxZ] as Vec3 } } : {}),
      };
      return ok('get_geometry', data, g, [id]);
    }
    if (hit.type === 'surface') {
      const s = hit.surface;
      const pts = s.polygon.filter(math.isFiniteV3);
      const data: GeometryResult = {
        id, type: 'surface', polygon3: pts, centroid: refPoint(hit),
        ...(pts.length > 0 ? { aabb: math.aabbFromPoints(pts) } : {}),
      };
      return ok('get_geometry', data, g, [id]);
    }
    const o = hit.opening;
    const w = (o.width?.value ?? 0.85) / 2;
    const h = (o.height?.value ?? 2) / 2;
    const data: GeometryResult = {
      id, type: 'opening', centroid: o.centre,
      aabb: {
        min: [o.centre[0] - w, o.centre[1] - h, o.centre[2] - w] as Vec3,
        max: [o.centre[0] + w, o.centre[1] + h, o.centre[2] + w] as Vec3,
      },
    };
    return ok('get_geometry', data, g, [id]);
  }

  // -------------------------------------------------------------------------
  // 8. get_dimensions
  // -------------------------------------------------------------------------

  /**
   * Width, depth and height as Quantities.
   *
   * For an entity the numbers come from its oriented box, so a sofa at an
   * angle reports 1.9 m long rather than the 2.3 m its axis-aligned bound
   * would suggest. For a room they come from the footprint's bounding box in
   * the room's own frame, which is what an estate agent means by "4.5 by 3.1".
   */
  get_dimensions(ref: string): ToolResult<DimensionsResult> {
    this.mark('get_dimensions');
    const hit = this.resolveOne('get_dimensions', ref);
    if ('ok' in hit) return hit;
    const doc = this.world.doc;
    const id = refId(hit);

    const ev = (): Evidence => {
      const e = new Evidence();
      e.addGrounding(refGrounding(hit));
      return e;
    };

    if (hit.type === 'entity') {
      const e = hit.entity;
      const obb = e.obb ?? (e.aabb ? math.obbFromAabb(e.aabb) : undefined);
      if (!obb) return fail('get_dimensions', 'not_established', `no measurable box for "${ref}"`);
      const evi = ev();
      // An object standing in a region no camera saw cannot be measured
      // defensibly, however crisp its bounding box looks.
      if (!this.world.isObserved(e.centroid)) evi.markUnobserved();
      evi.addProvenance(this.world.provenanceAt(e.centroid));
      const data: DimensionsResult = {
        id, type: 'entity',
        width: lengthQuantity(doc, obb.half[0] * 2, evi, { basis: { axis: 'x', id } }),
        height: lengthQuantity(doc, obb.half[1] * 2, ev(), { basis: { axis: 'y', id } }),
        depth: lengthQuantity(doc, obb.half[2] * 2, ev(), { basis: { axis: 'z', id } }),
      };
      return ok('get_dimensions', data, mergeGrounding(data.width.grounding), [id]);
    }

    if (hit.type === 'room') {
      const r = hit.room;
      const ring = math.sanitiseRing(r.polygon);
      if (ring.length < 3) {
        return fail('get_dimensions', 'not_established', `room "${ref}" has no usable outline`);
      }
      // Measure in the room's own dominant direction, not in world axes: a
      // flat whose walls run at 12 degrees to north is still "4.5 by 3.1".
      const frame = roomExtents(ring);
      const floorY = Number.isFinite(r.floorZ) ? r.floorZ : 0;
      const ceilY = Number.isFinite(r.ceilingZ) && r.ceilingZ > floorY ? r.ceilingZ : floorY + 2.4;
      const areaRes = this.measure_area(r.id);
      const data: DimensionsResult = {
        id, type: 'room',
        width: lengthQuantity(doc, frame.long, ev(), { basis: { axis: 'long', roomId: id } }),
        depth: lengthQuantity(doc, frame.short, ev(), { basis: { axis: 'short', roomId: id } }),
        height: lengthQuantity(doc, ceilY - floorY, ev(), { basis: { axis: 'height', roomId: id } }),
        ...(areaRes.ok ? { area: areaRes.data } : {}),
      };
      return ok('get_dimensions', data,
        mergeGrounding(r.grounding, areaRes.ok ? areaRes.grounding : undefined), [id]);
    }

    if (hit.type === 'opening') {
      const o = hit.opening;
      if (!o.width || !o.height) {
        return fail('get_dimensions', 'not_established',
          `the capture does not establish the size of this ${o.kind}`);
      }
      const data: DimensionsResult = {
        id, type: 'opening',
        width: o.width,
        height: o.height,
        depth: lengthQuantity(doc, 0, ev(), { basis: { axis: 'depth', note: 'openings have no depth' } }),
      };
      return ok('get_dimensions', data,
        mergeGrounding(quantityGrounding(o.width), quantityGrounding(o.height)), [id]);
    }

    return fail('get_dimensions', 'invalid_argument', 'a surface has an area, not three dimensions');
  }

  // -------------------------------------------------------------------------
  // 9. get_relationships
  // -------------------------------------------------------------------------

  get_relationships(ref: string, predicate?: string): ToolResult<RelationshipsResult> {
    this.mark('get_relationships');
    const hit = this.resolveOne('get_relationships', ref);
    if ('ok' in hit) return hit;
    const id = refId(hit);
    const rels = this.world.relationships(id, predicate as never);
    const g = rels.length > 0
      ? mergeGrounding(...rels.map((r) => r.grounding))
      : refGrounding(hit);
    return ok('get_relationships', { subjectId: id, relationships: rels }, g,
      [id, ...rels.map((r) => r.objectId)]);
  }

  // -------------------------------------------------------------------------
  // 10. measure_distance
  // -------------------------------------------------------------------------

  measure_distance(a: string | Vec3, b: string | Vec3): ToolResult<Quantity> {
    this.mark('measure_distance');
    const left = this.asTarget('measure_distance', a);
    if ('ok' in left && left.ok === false) return left;
    const right = this.asTarget('measure_distance', b);
    if ('ok' in right && right.ok === false) return right;

    const q = this.world.measureDistance(
      (left as { target: Parameters<World['measureDistance']>[0]; ids: string[] }).target,
      (right as { target: Parameters<World['measureDistance']>[0]; ids: string[] }).target,
    );
    const ids = [
      ...(left as { ids: string[] }).ids,
      ...(right as { ids: string[] }).ids,
    ];
    return ok('measure_distance', q, q.grounding, ids);
  }

  private asTarget(
    tool: ToolName, t: string | Vec3,
  ): ToolFail | { target: Parameters<World['measureDistance']>[0]; ids: string[] } {
    if (typeof t !== 'string') {
      if (!math.isFiniteV3(t)) return fail(tool, 'invalid_argument', 'a point must be three finite metres');
      return { target: t, ids: [] };
    }
    const hit = this.resolveOne(tool, t);
    if ('ok' in hit) return hit;
    const id = refId(hit);
    switch (hit.type) {
      case 'entity': return { target: { entityId: id }, ids: [id] };
      case 'room': return { target: { roomId: id }, ids: [id] };
      case 'opening': return { target: { openingId: id }, ids: [id] };
      case 'surface': return { target: { surfaceId: id }, ids: [id] };
    }
  }

  // -------------------------------------------------------------------------
  // 11. measure_area
  // -------------------------------------------------------------------------

  measure_area(ref: string): ToolResult<Quantity> {
    this.mark('measure_area');
    const hit = this.resolveOne('measure_area', ref);
    if ('ok' in hit) return hit;
    let roomId: string | undefined;
    if (hit.type === 'room') roomId = hit.room.id;
    else if (hit.type === 'entity') roomId = hit.entity.roomId;
    if (!roomId || !this.world.room(roomId)) {
      return fail('measure_area', 'not_found', `"${ref}" is not a room with a measurable floor`);
    }
    const q = this.world.measureArea(roomId);
    return ok('measure_area', q, q.grounding, [roomId]);
  }

  // -------------------------------------------------------------------------
  // 12. raycast
  // -------------------------------------------------------------------------

  /** Defaults to the viewer's own eye and gaze: "what am I looking at". */
  raycast(opts?: {
    readonly origin?: Vec3; readonly direction?: Vec3; readonly maxDistance?: number;
  }): ToolResult<RaycastResult> {
    this.mark('raycast');
    const origin = opts?.origin && math.isFiniteV3(opts.origin) ? opts.origin : this.view.position;
    const dir = opts?.direction && math.isFiniteV3(opts.direction)
      ? opts.direction
      : math.forwardOf(this.view.orientation);
    const hit = this.world.raycast(origin, dir, {
      ...(Number.isFinite(opts?.maxDistance) ? { maxDistance: opts!.maxDistance! } : {}),
    });
    if (!hit) {
      const p = this.world.provenanceAt(origin);
      return ok('raycast', { hit: false, provenance: p }, { provenance: p, confidence: 0.5 }, []);
    }
    const room = this.world.roomAt(hit.point);
    const data: RaycastResult = {
      hit: true, point: hit.point, distanceM: hit.distance, normal: hit.normal,
      provenance: hit.provenance,
      ...(hit.surfaceId ? { surfaceId: hit.surfaceId } : {}),
      ...(hit.entityId ? { entityId: hit.entityId } : {}),
      ...(room ? { roomId: room.id } : {}),
    };
    const owner = hit.entityId ? this.world.entity(hit.entityId)?.grounding
      : hit.surfaceId ? this.world.surface(hit.surfaceId)?.grounding : undefined;
    const g = mergeGrounding(owner, { provenance: hit.provenance, confidence: owner?.confidence ?? 0.7 });
    return ok('raycast', data, g, [hit.entityId, hit.surfaceId, room?.id].filter((x): x is string => !!x));
  }

  // -------------------------------------------------------------------------
  // 13. check_visibility
  // -------------------------------------------------------------------------

  check_visibility(ref: string, from?: Vec3): ToolResult<VisibilityResult> {
    this.mark('check_visibility');
    const hit = this.resolveOne('check_visibility', ref);
    if ('ok' in hit) return hit;
    const id = refId(hit);
    const origin = from && math.isFiniteV3(from) ? from : this.view.position;
    const r = this.world.checkVisibility(origin, id);
    const blockerLabel = r.blockedBy ? this.labelOf(r.blockedBy) : undefined;
    const data: VisibilityResult = {
      visible: r.visible, targetId: id,
      ...(r.blockedBy ? { blockedBy: r.blockedBy } : {}),
      ...(blockerLabel ? { blockedByLabel: blockerLabel } : {}),
    };
    return ok('check_visibility', data, refGrounding(hit),
      [id, ...(r.blockedBy ? [r.blockedBy] : [])]);
  }

  // -------------------------------------------------------------------------
  // 14. check_collision  (also answers "does it fit")
  // -------------------------------------------------------------------------

  /**
   * Two questions, one tool, because they are the same question asked twice.
   * With an `obb` it answers "does this box, here, hit anything". With a
   * `roomId` and a `size` it searches the room for somewhere the box does not,
   * which is the engine's fit test, and is what "will my sofa fit in the living
   * room" actually means.
   */
  check_collision(arg: {
    readonly obb?: Obb;
    readonly roomId?: string;
    readonly sizeM?: Vec3;
    readonly againstWall?: boolean;
    readonly clearanceM?: number;
  }): ToolResult<CollisionResult | FitResultData> {
    this.mark('check_collision');
    if (arg.obb) {
      const r = this.world.checkCollision(arg.obb);
      const labels = r.with.map((id) => this.labelOf(id) ?? id);
      const data: CollisionResult = { collides: r.collides, withIds: r.with, withLabels: labels };
      const g = mergeGrounding(...r.with.map((id) => this.groundingOf(id)));
      return ok('check_collision', data, g, r.with);
    }
    if (!arg.roomId || !arg.sizeM) {
      return fail('check_collision', 'invalid_argument',
        'needs either a box to test or a room and a size to fit');
    }
    const hit = this.resolveOne('check_collision', arg.roomId);
    if ('ok' in hit) return hit;
    if (hit.type !== 'room') {
      return fail('check_collision', 'not_found', `"${arg.roomId}" is not a room`);
    }
    if (!math.isFiniteV3(arg.sizeM) || arg.sizeM.some((v) => v <= 0)) {
      return fail('check_collision', 'invalid_argument', 'a size is three positive metres');
    }
    const r = this.world.fitTest(hit.room.id, arg.sizeM, {
      ...(arg.againstWall === true ? { againstWall: true } : {}),
      ...(Number.isFinite(arg.clearanceM) ? { clearance: arg.clearanceM! } : {}),
    });
    const data: FitResultData = {
      fits: r.fits, roomId: hit.room.id, sizeM: arg.sizeM, placements: r.placements,
      ...(r.reason ? { reason: r.reason } : {}),
    };
    // A fit answer leans on every object in the room, so its grounding is the
    // weakest of them plus the room itself.
    const g = mergeGrounding(
      hit.room.grounding,
      ...this.world.entitiesIn(hit.room.id).map((e) => e.grounding),
    );
    return ok('check_collision', data, g, [hit.room.id]);
  }

  // -------------------------------------------------------------------------
  // 15. find_path
  // -------------------------------------------------------------------------

  find_path(from: string | Vec3, to: string | Vec3): ToolResult<PathResultData> {
    this.mark('find_path');
    const a = this.asNavTarget('find_path', from);
    if (typeof a === 'object' && 'ok' in a) return a;
    const b = this.asNavTarget('find_path', to);
    if (typeof b === 'object' && 'ok' in b) return b;

    const path = this.world.findPath(a as Vec3 | string, b as Vec3 | string);
    if (!path) {
      return fail('find_path', 'not_established',
        'no walkable route between those two places in this capture');
    }
    const rooms: string[] = [];
    for (const n of path.nodes) {
      const rid = n.roomId ?? this.world.roomAt(n.position)?.id;
      if (rid && rooms[rooms.length - 1] !== rid) rooms.push(rid);
    }
    const data: PathResultData = {
      nodes: path.nodes,
      points: path.nodes.map((n) => n.position),
      length: path.length,
      roomSequence: rooms,
    };
    return ok('find_path', data, path.length.grounding, rooms);
  }

  private asNavTarget(tool: ToolName, t: string | Vec3): Vec3 | string | ToolFail {
    if (typeof t !== 'string') {
      if (!math.isFiniteV3(t)) return fail(tool, 'invalid_argument', 'a point must be three finite metres');
      return t;
    }
    const hit = this.resolveOne(tool, t);
    if ('ok' in hit) return hit;
    return refId(hit);
  }

  // -------------------------------------------------------------------------
  // 16. highlight_entity  (side effect)
  // -------------------------------------------------------------------------

  highlight_entity(
    refs: readonly string[], style: 'primary' | 'secondary' | 'warning' = 'primary',
  ): ToolResult<{ readonly entityIds: readonly string[] }> {
    this.mark('highlight_entity');
    const ids: string[] = [];
    for (const ref of refs) {
      const hit = this.lookup(ref);
      if (hit === null || Array.isArray(hit)) continue;
      if (hit.type === 'entity') ids.push(hit.entity.id);
    }
    if (ids.length === 0) {
      return fail('highlight_entity', 'not_found', 'nothing matching to highlight');
    }
    this.emit({
      kind: 'highlightEntities', id: this.nextCommandId(), intent: 'answer',
      entityIds: ids, style,
    });
    const g = mergeGrounding(...ids.map((i) => this.world.entity(i)?.grounding));
    return ok('highlight_entity', { entityIds: ids }, g, ids);
  }

  // -------------------------------------------------------------------------
  // 17. move_camera  (side effect)
  // -------------------------------------------------------------------------

  /**
   * Moves along the nav graph, never in a straight line. A camera that flies
   * through a party wall to reach the second bedroom is the single most
   * effective way to make a viewer feel fake, and the nav graph already
   * encodes where a body can go.
   */
  move_camera(to: string | Vec3, opts?: { readonly durationMs?: number }): ToolResult<PathResultData> {
    this.mark('move_camera');
    const path = this.find_path(this.view.position, to);
    if (!path.ok) return path;

    const target = typeof to === 'string' ? this.lookup(to) : null;
    const lookAt = target && !Array.isArray(target) ? refPoint(target) : undefined;
    const durationMs = Number.isFinite(opts?.durationMs)
      ? Math.max(200, Math.min(20_000, opts!.durationMs!))
      // Roughly a brisk walk: 1.4 m/s, floored so a one-metre hop still reads
      // as movement rather than a teleport.
      : Math.max(800, Math.round((path.data.length.value / 1.4) * 1000));

    this.emit({
      kind: 'moveCamera', id: this.nextCommandId(), intent: 'navigation',
      waypoints: path.data.nodes.map((n) => ({ position: n.position, navNodeId: n.id })),
      durationMs,
      pathLengthM: path.data.length.value,
      ...(lookAt ? { lookAt } : {}),
    });
    // The agent's own idea of where the viewer is must track the command it
    // just issued, or the next turn's "that" resolves against a stale pose.
    const last = path.data.nodes[path.data.nodes.length - 1];
    if (last) {
      this.view.position = [last.position[0], last.position[1] + EYE_HEIGHT_M, last.position[2]];
      const room = last.roomId ?? this.world.roomAt(this.view.position)?.id;
      this.view.roomId = room;
    }
    return path;
  }

  // -------------------------------------------------------------------------
  // 18. select_entity  (side effect)
  // -------------------------------------------------------------------------

  select_entity(ref: string): ToolResult<Entity> {
    this.mark('select_entity');
    const hit = this.resolveOne('select_entity', ref);
    if ('ok' in hit) return hit;
    if (hit.type !== 'entity') {
      return fail('select_entity', 'invalid_argument', 'only objects can be selected');
    }
    this.emit({
      kind: 'selectEntity', id: this.nextCommandId(), intent: 'answer',
      entityId: hit.entity.id,
    });
    this.view.selectedEntityId = hit.entity.id;
    return ok('select_entity', hit.entity, hit.entity.grounding, [hit.entity.id]);
  }

  // -------------------------------------------------------------------------
  // 19. inspect_surface
  // -------------------------------------------------------------------------

  inspect_surface(ref: string): ToolResult<SurfaceInspection> {
    this.mark('inspect_surface');
    const hit = this.resolveOne('inspect_surface', ref);
    if ('ok' in hit) return hit;
    if (hit.type !== 'surface') {
      return fail('inspect_surface', 'invalid_argument', `"${ref}" is a ${hit.type}, not a surface`);
    }
    const s = hit.surface;
    const openings = this.world.doc.openings.filter((o) => o.surfaceId === s.id);
    const pts = s.polygon.filter(math.isFiniteV3);
    const data: SurfaceInspection = {
      surface: s,
      isGlazed: s.isGlazed,
      isReflective: s.isReflective,
      openings,
      ...(s.roomId ? { roomId: s.roomId } : {}),
      ...(s.area ? { areaM2: s.area.value } : pts.length >= 3 ? { areaM2: planarArea(pts) } : {}),
    };
    return ok('inspect_surface', data, s.grounding, [s.id, ...openings.map((o) => o.id)]);
  }

  // -------------------------------------------------------------------------
  // 20. query_world
  // -------------------------------------------------------------------------

  /**
   * The property in one object: how many rooms, how many bedrooms, how big.
   * Answers the single most common opening question a buyer asks, with no
   * model call and no iteration over tools.
   */
  query_world(): ToolResult<WorldSummary> {
    this.mark('query_world');
    const doc = this.world.doc;
    const ev = new Evidence();
    let total = 0;
    let perimeter = 0;
    const rooms: Array<{ id: string; name: string; kind: string; areaM2: number }> = [];
    for (const r of doc.rooms) {
      const q = this.world.measureArea(r.id);
      total += q.value;
      const ring = math.sanitiseRing(r.polygon);
      if (ring.length >= 3) perimeter += math.ringPerimeter(ring);
      ev.addGrounding(q.grounding);
      if (!isDefensible(q)) ev.markUnobserved();
      rooms.push({ id: r.id, name: r.name ?? r.kind, kind: r.kind, areaM2: q.value });
    }
    const totalArea = areaQuantity(doc, total, ev, {
      perimeter,
      basis: { kind: 'sum-of-room-areas', rooms: doc.rooms.length },
    });
    const data: WorldSummary = {
      worldId: doc.id,
      label: doc.label,
      version: doc.version,
      roomCount: doc.rooms.length,
      bedroomCount: doc.rooms.filter((r) => r.kind === 'bedroom').length,
      bathroomCount: doc.rooms.filter((r) => r.kind === 'bathroom' || r.kind === 'wc').length,
      totalAreaM2: totalArea,
      floors: doc.floors.length,
      rooms,
      qualityVerdict: doc.quality.verdict,
      measurementStandard: doc.measurementPolicy.areaStandard,
    };
    return ok('query_world', data, totalArea.grounding, doc.rooms.map((r) => r.id));
  }

  // -------------------------------------------------------------------------
  // 21. get_provenance
  // -------------------------------------------------------------------------

  /**
   * Where a fact came from. This is the tool the refusal path runs on, and the
   * one an operator reaches for when a customer disputes a number.
   */
  get_provenance(target: string | Vec3): ToolResult<ProvenanceResult> {
    this.mark('get_provenance');
    let point: Vec3 | undefined;
    let subjectId: string | undefined;
    let base: Grounding | undefined;

    if (typeof target !== 'string') {
      if (!math.isFiniteV3(target)) {
        return fail('get_provenance', 'invalid_argument', 'a point must be three finite metres');
      }
      point = target;
    } else {
      const hit = this.resolveOne('get_provenance', target);
      if ('ok' in hit) return hit;
      subjectId = refId(hit);
      base = refGrounding(hit);
      point = refPoint(hit);
    }

    const regions = this.world.doc.regions.filter((r) => math.aabbContains(r.volume, point!));
    const contextProvenance = this.world.provenanceAt(point);
    const observed = this.world.isObserved(point);
    // A subject reports its own provenance; the volume reports the context.
    const provenance = base ? base.provenance : contextProvenance;
    const sources = new Set<string>(base?.sources ?? []);
    if (typeof target === 'string') {
      const e = this.world.entity(subjectId!);
      for (const c of e?.observedIn ?? []) sources.add(c);
    }
    const reasons = regions.map((r) => r.reason).filter((x): x is string => typeof x === 'string');
    const data: ProvenanceResult = {
      provenance,
      contextProvenance,
      observed,
      confidence: base?.confidence ?? (regions[0]?.confidence ?? 0.5),
      sources: [...sources],
      regionIds: regions.map((r) => r.id),
      reasons,
      ...(subjectId ? { subjectId } : {}),
      ...(point ? { point } : {}),
    };
    // The grounding on the RESULT is the weakest of the two, because that is
    // what any answer built on it can defend.
    return ok('get_provenance', data, {
      provenance: weakestProvenance(provenance, contextProvenance),
      confidence: data.confidence,
    }, [
      ...(subjectId ? [subjectId] : []), ...data.regionIds,
    ]);
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  labelOf(id: string): string | undefined {
    const e = this.world.entity(id);
    if (e) return e.label;
    const r = this.world.room(id);
    if (r) return r.name ?? r.kind;
    const s = this.world.surface(id);
    if (s) return `${s.kind}`;
    const o = this.world.opening(id);
    if (o) return o.kind;
    return undefined;
  }

  groundingOf(id: string): Grounding | undefined {
    return this.world.entity(id)?.grounding
      ?? this.world.room(id)?.grounding
      ?? this.world.surface(id)?.grounding
      ?? this.world.opening(id)?.grounding;
  }

  /** Re-exported so the phrasing layer can explain why a number is soft. */
  static refusalFor(q: Quantity): string | undefined {
    return isDefensible(q) ? undefined : refusalReason(q);
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers local to the tool layer
// ---------------------------------------------------------------------------

/**
 * Long and short extents of a footprint in its own dominant frame. Found by
 * rotating-calipers over the ring's edge directions, which for the rectangular
 * and L-shaped rooms this system deals with lands on the wall direction.
 */
function roomExtents(ring: readonly (readonly [number, number])[]): { long: number; short: number } {
  let best: { long: number; short: number; areaSq: number } | null = null;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uz = dz / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of ring) {
      const u = p[0] * ux + p[1] * uz;
      const v = -p[0] * uz + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const areaSq = w * h;
    if (best === null || areaSq < best.areaSq - 1e-9) {
      best = { long: Math.max(w, h), short: Math.min(w, h), areaSq };
    }
  }
  if (best === null) return { long: 0, short: 0 };
  return { long: best.long, short: best.short };
}

/** Area of a planar polygon in 3D, by the Newell cross-product sum. */
function planarArea(pts: readonly Vec3[]): number {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]!;
    const b = pts[i]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.hypot(nx, ny, nz) / 2;
}
