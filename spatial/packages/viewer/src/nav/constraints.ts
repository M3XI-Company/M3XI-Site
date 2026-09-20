import type { NavEdge, NavNode, Provenance, Vec3 } from '@m3xi/world-core';
import { math, type World } from '@m3xi/spatial-engine';
import type { BlockReason, MoveResult } from '../types.js';

const { add, distance, dot, isFiniteV3, normalise, scale, sub } = math;

export interface CameraConstraintOptions {
  /** Standing eye height above the floor slab, metres. */
  readonly eyeHeight?: number;
  /**
   * The camera's own radius. `NavNode.clearance` is "radius of free space" and
   * the contract says the controller will not enter below its own, so this is
   * the number that sentence is about. 0.28 m is a shoulder-width human
   * reduced to a cylinder -- tight enough to get through a 0.762 m bathroom
   * door, wide enough that you cannot squeeze between a bath and a wall.
   */
  readonly radius?: number;
  /**
   * Operator review may need to inspect generated geometry from inside it.
   * Visitors never get this: walking into invented space and being shown a
   * photoreal-looking room is exactly the misrepresentation we are avoiding.
   */
  readonly allowUnsurveyed?: boolean;
  /** How far outside a room a nav corridor extends. Doorway nodes live here. */
  readonly corridorRadius?: number;
  /** Slide attempts per move. Two handles an inside corner; more just costs. */
  readonly maxSlides?: number;
}

const DEFAULTS = {
  eyeHeight: 1.6,
  radius: 0.28,
  allowUnsurveyed: false,
  corridorRadius: 0.6,
  maxSlides: 2,
} as const;

/** Heights probed for wall contact: shin, hip, eye. */
const PROBE_HEIGHTS = [0.3, 0.95, 1.55] as const;

export interface StandCheck {
  readonly ok: boolean;
  readonly reason?: BlockReason;
  readonly blockedBy?: string;
  readonly roomId?: string;
  readonly provenance: Provenance;
}

/**
 * The thing that stops the camera leaving the building.
 *
 * It is deliberately not a bounding box and not a "stay near the path" leash.
 * Every refusal comes from something the world document actually says: proxy
 * triangles the pipeline exported, a `Surface.isReflective` flag, a `Region`
 * whose provenance is not `observed`, or the absence of any room or nav
 * corridor at that point. A world with a bigger flat gets a bigger walkable
 * area for free, and a world with a mirror gets a wall there without anyone
 * hand-authoring one.
 */
export class CameraConstraint {
  private readonly opts: Required<CameraConstraintOptions>;
  private readonly reflectiveSurfaceIds: ReadonlySet<string>;
  private readonly edges: ReadonlyArray<{ a: Vec3; b: Vec3; radius: number }>;

  constructor(readonly world: World, opts: CameraConstraintOptions = {}) {
    this.opts = { ...DEFAULTS, ...stripUndefined(opts) };
    this.reflectiveSurfaceIds = new Set(
      world.doc.surfaces.filter((s) => s.isReflective).map((s) => s.id),
    );
    const byId = new Map(world.doc.nav.nodes.map((n) => [n.id, n]));
    const edges: Array<{ a: Vec3; b: Vec3; radius: number }> = [];
    for (const e of world.doc.nav.edges as readonly NavEdge[]) {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!a || !b) continue;
      // A doorway is only as wide as the doorway. Using the declared width
      // keeps the camera from cutting the corner through the door frame.
      const half = e.width !== undefined && e.width > 0 ? e.width / 2 : this.opts.corridorRadius;
      edges.push({ a: a.position, b: b.position, radius: Math.max(half, this.opts.radius) });
    }
    this.edges = edges;
  }

  get eyeHeight(): number { return this.opts.eyeHeight; }
  get radius(): number { return this.opts.radius; }

  /**
   * Where a visitor starts: the entrance node, at eye height, facing the
   * cheapest way into the property rather than at an arbitrary yaw.
   */
  spawn(startNodeId?: string): { position: Vec3; yaw: number; pitch: number; nodeId: string } {
    const nodes = this.world.doc.nav.nodes;
    const named = startNodeId ? nodes.find((n) => n.id === startNodeId) : undefined;
    const entrance = named
      ?? nodes.find((n) => n.isEntrance)
      ?? nodes.find((n) => n.isViewpoint)
      ?? nodes[0];
    if (!entrance) {
      return { position: [0, this.opts.eyeHeight, 0], yaw: 0, pitch: 0, nodeId: '' };
    }
    const position = this.standingPoint(entrance.position);
    return {
      position,
      yaw: this.yawTowards(position, this.firstStepFrom(entrance)),
      pitch: 0,
      nodeId: entrance.id,
    };
  }

  /** Neighbour used to aim the spawn: the far end of the cheapest edge. */
  private firstStepFrom(node: NavNode): Vec3 | undefined {
    const byId = new Map(this.world.doc.nav.nodes.map((n) => [n.id, n]));
    let best: { pos: Vec3; cost: number } | undefined;
    for (const e of this.world.doc.nav.edges) {
      const other = e.a === node.id ? byId.get(e.b) : e.b === node.id ? byId.get(e.a) : undefined;
      if (!other) continue;
      if (!best || e.cost < best.cost) best = { pos: other.position, cost: e.cost };
    }
    return best?.pos;
  }

  yawTowards(from: Vec3, to: Vec3 | undefined): number {
    if (!to) return 0;
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
    // Yaw 0 looks down -Z, positive yaw turns towards -X (three.js convention).
    return Math.atan2(-dx, -dz);
  }

  /** Lift a floor-level nav position to eye height using the room's slab. */
  standingPoint(p: Vec3): Vec3 {
    const room = this.world.roomAt([p[0], p[1] + 0.05, p[2]]) ?? this.world.roomAt(p);
    const floor = room && Number.isFinite(room.floorZ) ? room.floorZ : p[1];
    return [p[0], floor + this.opts.eyeHeight, p[2]];
  }

  /**
   * Can the camera stand here? Four independent refusals, checked cheapest
   * first. Order matters only for which reason the user is told.
   */
  canStand(p: Vec3): StandCheck {
    if (!isFiniteV3(p)) return { ok: false, reason: 'invalid', provenance: 'generated' };

    const provenance = this.world.provenanceAt(p);
    const room = this.world.roomAt(p);

    if (!room && !this.nearCorridor(p)) {
      return { ok: false, reason: 'offgraph', provenance, roomId: undefined };
    }
    if (!this.opts.allowUnsurveyed && provenance === 'generated') {
      const region = this.regionAt(p);
      return {
        ok: false,
        reason: 'unsurveyed',
        provenance,
        ...(region ? { blockedBy: region } : {}),
        ...(room ? { roomId: room.id } : {}),
      };
    }
    const near = this.world.bvh.closestPoint(p[0], p[1], p[2], this.opts.radius);
    if (near && near.distance < this.opts.radius) {
      return {
        ok: false,
        reason: 'clearance',
        provenance,
        ...(this.describeTriangle(near.tri) ? { blockedBy: this.describeTriangle(near.tri)! } : {}),
        ...(room ? { roomId: room.id } : {}),
      };
    }
    return { ok: true, provenance, ...(room ? { roomId: room.id } : {}) };
  }

  /**
   * Resolve a desired horizontal move.
   *
   * Vertical motion is not a thing a walking visitor does, so `delta`'s Y is
   * ignored and the camera is re-seated on whatever floor it ends up over.
   * That is also what stops a crouch-and-clip exploit against the proxy.
   */
  move(from: Vec3, delta: Vec3): MoveResult {
    if (!isFiniteV3(from) || !isFiniteV3(delta)) {
      return {
        position: isFiniteV3(from) ? from : [0, this.opts.eyeHeight, 0],
        moved: false, blocked: true, reason: 'invalid', slid: false, provenance: 'generated',
      };
    }
    let remaining: Vec3 = [delta[0], 0, delta[2]];
    if (Math.hypot(remaining[0], remaining[2]) < 1e-6) {
      const here = this.canStand(from);
      return {
        position: from, moved: false, blocked: false, slid: false,
        provenance: here.provenance, ...(here.roomId ? { roomId: here.roomId } : {}),
      };
    }

    let position = from;
    let slid = false;
    let lastBlock: { reason: BlockReason; by?: string } | undefined;

    for (let attempt = 0; attempt <= this.opts.maxSlides; attempt++) {
      const len = Math.hypot(remaining[0], remaining[2]);
      if (len < 1e-4) break;

      const hit = this.sweep(position, remaining, len);
      if (!hit) {
        const target = this.seat(add(position, remaining));
        const check = this.canStand(target);
        if (check.ok) {
          position = target;
          remaining = [0, 0, 0];
          break;
        }
        lastBlock = { reason: check.reason ?? 'collision', ...(check.blockedBy ? { by: check.blockedBy } : {}) };
        // Refused on grounds other than geometry (unsurveyed, off-graph). There
        // is nothing to slide along, so try a reduced step instead: walking
        // towards a boundary should stop at it, not stop a metre short.
        remaining = this.shorten(position, remaining);
        continue;
      }

      if (hit.mirror) {
        lastBlock = { reason: 'mirror', by: hit.id ?? 'mirror' };
        break;
      }

      // Move up to the contact point, then slide the rest along the wall.
      const dir = normalise(remaining);
      const travel = Math.max(0, hit.distance - this.opts.radius);
      if (travel > 1e-4) {
        const stepped = this.seat(add(position, scale(dir, travel)));
        if (this.canStand(stepped).ok) position = stepped;
      }
      const leftover = scale(dir, len - travel);
      const n: Vec3 = [hit.normal[0], 0, hit.normal[2]];
      const nl = Math.hypot(n[0], n[2]);
      if (nl < 1e-6) { lastBlock = { reason: 'collision', ...(hit.id ? { by: hit.id } : {}) }; break; }
      const un: Vec3 = [n[0] / nl, 0, n[2] / nl];
      remaining = sub(leftover, scale(un, dot(leftover, un)));
      slid = true;
      lastBlock = { reason: 'collision', ...(hit.id ? { by: hit.id } : {}) };
    }

    const moved = distance(position, from) > 1e-5;
    const check = this.canStand(position);
    return {
      position,
      moved,
      blocked: !moved && lastBlock !== undefined,
      slid: slid && moved,
      provenance: check.provenance,
      ...(lastBlock && !moved ? { reason: lastBlock.reason } : {}),
      ...(lastBlock?.by && !moved ? { blockedBy: lastBlock.by } : {}),
      ...(check.roomId ? { roomId: check.roomId } : {}),
    };
  }

  /**
   * Halve the step towards a boundary the constraint refused, so the camera
   * comes to rest against an unsurveyed volume instead of stopping short of it.
   */
  private shorten(position: Vec3, remaining: Vec3): Vec3 {
    const half: Vec3 = [remaining[0] * 0.5, 0, remaining[2] * 0.5];
    if (Math.hypot(half[0], half[2]) < 0.02) return [0, 0, 0];
    const target = this.seat(add(position, half));
    return this.canStand(target).ok ? half : [half[0] * 0.5, 0, half[2] * 0.5];
  }

  /** Put a point back on the floor of whatever room it is over. */
  private seat(p: Vec3): Vec3 {
    const room = this.world.roomAt(p);
    if (room && Number.isFinite(room.floorZ)) return [p[0], room.floorZ + this.opts.eyeHeight, p[2]];
    return p;
  }

  /**
   * Cast the body against the proxy soup. Three heights, not one: a single
   * eye-height ray walks straight over a kitchen island and through a bath.
   */
  private sweep(
    from: Vec3, delta: Vec3, len: number,
  ): { distance: number; normal: Vec3; id?: string; mirror: boolean } | null {
    const dir = normalise([delta[0], 0, delta[2]]);
    const maxDistance = len + this.opts.radius;
    const base = this.floorOf(from);
    let best: { distance: number; normal: Vec3; id?: string; mirror: boolean } | null = null;

    for (const h of PROBE_HEIGHTS) {
      const origin: Vec3 = [from[0], base + h, from[2]];
      const hit = this.world.raycast(origin, dir, { maxDistance });
      if (!hit) continue;
      const mirror = hit.surfaceId !== undefined && this.reflectiveSurfaceIds.has(hit.surfaceId);
      const id = hit.entityId ?? hit.surfaceId;
      if (!best || hit.distance < best.distance || (mirror && !best.mirror)) {
        best = {
          distance: hit.distance,
          normal: hit.normal,
          mirror,
          ...(id ? { id } : {}),
        };
      }
    }
    return best;
  }

  private floorOf(p: Vec3): number {
    const room = this.world.roomAt(p);
    return room && Number.isFinite(room.floorZ) ? room.floorZ : p[1] - this.opts.eyeHeight;
  }

  /** Distance from a point to the nav graph, in the XZ plane. */
  nearCorridor(p: Vec3): boolean {
    for (const e of this.edges) {
      const d = distanceToSegmentXZ(p, e.a, e.b);
      if (d <= e.radius + this.opts.radius) return true;
    }
    for (const n of this.world.doc.nav.nodes) {
      const d = Math.hypot(p[0] - n.position[0], p[2] - n.position[2]);
      if (d <= Math.max(n.clearance, this.opts.radius)) return true;
    }
    return false;
  }

  private regionAt(p: Vec3): string | undefined {
    for (const r of this.world.doc.regions) {
      if (r.provenance === 'observed') continue;
      const v = r.volume;
      if (p[0] < v.min[0] || p[0] > v.max[0]) continue;
      if (p[1] < v.min[1] || p[1] > v.max[1]) continue;
      if (p[2] < v.min[2] || p[2] > v.max[2]) continue;
      return r.id;
    }
    return undefined;
  }

  private describeTriangle(tri: number): string | undefined {
    const si = this.world.soup.triSurface[tri];
    const ei = this.world.soup.triEntity[tri];
    if (ei !== undefined && ei >= 0) return this.world.doc.entities[ei]?.id;
    if (si !== undefined && si >= 0) return this.world.doc.surfaces[si]?.id;
    return undefined;
  }

  /** Nearest declared viewpoint, for "stand back and look at this room". */
  nearestViewpoint(p: Vec3, roomId?: string): NavNode | undefined {
    let best: NavNode | undefined;
    let bestD = Infinity;
    for (const n of this.world.doc.nav.nodes) {
      if (!n.isViewpoint) continue;
      if (roomId && n.roomId !== roomId) continue;
      const d = distance(n.position, p);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }
}

export function distanceToSegmentXZ(p: Vec3, a: Vec3, b: Vec3): number {
  const ax = a[0], az = a[2];
  const bx = b[0], bz = b[2];
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-12) return Math.hypot(p[0] - ax, p[2] - az);
  let t = ((p[0] - ax) * dx + (p[2] - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (ax + t * dx), p[2] - (az + t * dz));
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
