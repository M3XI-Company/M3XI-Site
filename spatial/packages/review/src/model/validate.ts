import type { Aabb, Vec3, WorldDocument } from '@m3xi/world-core';
import { World, isDefensible } from '@m3xi/spatial-engine';

/**
 * DOES THIS CORRECTION BREAK THE WORLD?
 * =====================================
 *
 * The correction editor's most important job is not making a change easy; it
 * is making a *destructive* change visible before it is committed. A world is
 * a graph as much as it is geometry, and the two failure modes the brief names
 * are exactly the ones a field-by-field editor cannot see:
 *
 *   - delete a room and the door into it now connects a room that is not
 *     there, so the nav graph, the scene graph and the written tour all
 *     describe a property that does not exist;
 *   - drag an object out of every room and it is still in the document, still
 *     measured against, still described by the agent, and in no room.
 *
 * Both are checked here against the SPATIAL ENGINE rather than against the
 * document, because the engine is what everything downstream reads. If
 * `World.roomAt` cannot place a sofa, then no amount of `roomId` in the JSON
 * makes the sofa be in the kitchen.
 *
 * Severity is binary on purpose. A `blocker` means save is not offered; a
 * `warning` means save is offered with the warning attached. There is no
 * middle tier, because a middle tier is a tier operators learn to ignore.
 */

export type IssueLevel = 'blocker' | 'warning';

export interface ValidationIssue {
  readonly level: IssueLevel;
  /** Stable code so a test asserts on the rule, not on the prose. */
  readonly code: string;
  readonly message: string;
  /** What to select in the plan when the operator clicks the issue. */
  readonly ref?: { readonly type: string; readonly id: string };
}

export interface ValidationResult {
  readonly issues: readonly ValidationIssue[];
  readonly blockers: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  /** True when nothing blocks; the editor offers save only then. */
  readonly savable: boolean;
}

/**
 * How far outside every room outline an object may sit before it counts as out
 * of bounds. Matched to the engine's own wall-thickness tolerance, because an
 * object in the thickness of a partition -- a radiator bracket, a wall-mounted
 * TV, a door handle -- is in the building even when it is in no room polygon.
 */
const OUT_OF_BOUNDS_TOLERANCE_M = 0.3;

export function validateWorld(doc: WorldDocument): ValidationResult {
  const issues: ValidationIssue[] = [];

  let world: World;
  try {
    world = World.fromDocument(doc);
  } catch (err) {
    return finish([{
      level: 'blocker',
      code: 'world.unbuildable',
      message: `The spatial engine cannot build this world: ${err instanceof Error ? err.message : String(err)}`,
    }]);
  }

  const roomIds = new Set(doc.rooms.map((r) => r.id));
  const roomName = new Map(doc.rooms.map((r) => [r.id, r.name ?? r.id] as const));
  const name = (id: string): string => roomName.get(id) ?? id;

  // -- structure ------------------------------------------------------------

  if (doc.rooms.length === 0) {
    issues.push({
      level: 'blocker', code: 'world.no-rooms',
      message: 'This world has no rooms left. A property with no rooms cannot be published or described.',
    });
  }

  for (const room of doc.rooms) {
    if (room.polygon.length < 3) {
      issues.push({
        level: 'blocker', code: 'room.degenerate',
        message: `${name(room.id)} has an outline of ${room.polygon.length} points, which encloses no floor.`,
        ref: { type: 'room', id: room.id },
      });
      continue;
    }
    if (!(room.ceilingZ > room.floorZ)) {
      issues.push({
        level: 'blocker', code: 'room.inverted-height',
        message: `${name(room.id)} has its ceiling at or below its floor.`,
        ref: { type: 'room', id: room.id },
      });
    }
    if (room.ceilingZ - room.floorZ < 1.9) {
      issues.push({
        level: 'warning', code: 'room.low-ceiling',
        message: `${name(room.id)} is ${(room.ceilingZ - room.floorZ).toFixed(2)} m floor to ceiling. Below about 1.9 m a room is not habitable space and should not be counted as one.`,
        ref: { type: 'room', id: room.id },
      });
    }
    if (room.floorId && !doc.floors.some((f) => f.id === room.floorId)) {
      issues.push({
        level: 'warning', code: 'room.orphan-floor',
        message: `${name(room.id)} is on level '${room.floorId}', which is not in this world.`,
        ref: { type: 'room', id: room.id },
      });
    }
  }

  // -- openings: the deleted-room case --------------------------------------

  for (const opening of doc.openings) {
    for (const [side, id] of [['roomA', opening.roomA], ['roomB', opening.roomB]] as const) {
      if (!id) continue;
      if (!roomIds.has(id)) {
        issues.push({
          level: 'blocker', code: 'opening.dangling-room',
          message: `The ${opening.kind} '${opening.id}' still connects ${side === 'roomA' ? 'from' : 'to'} '${id}', which is no longer in this world. Reconnect it or delete it before saving.`,
          ref: { type: 'opening', id: opening.id },
        });
      }
    }
    if (opening.roomA && opening.roomA === opening.roomB) {
      issues.push({
        level: 'blocker', code: 'opening.self-connected',
        message: `The ${opening.kind} '${opening.id}' connects ${name(opening.roomA)} to itself.`,
        ref: { type: 'opening', id: opening.id },
      });
    }
    if (!opening.roomA && !opening.roomB) {
      issues.push({
        level: 'warning', code: 'opening.unconnected',
        message: `The ${opening.kind} '${opening.id}' connects nothing. It will be drawn but it will not appear in the route through the property.`,
        ref: { type: 'opening', id: opening.id },
      });
    }
    if (opening.surfaceId && !doc.surfaces.some((s) => s.id === opening.surfaceId)) {
      issues.push({
        level: 'blocker', code: 'opening.dangling-surface',
        message: `The ${opening.kind} '${opening.id}' sits in surface '${opening.surfaceId}', which is no longer in this world.`,
        ref: { type: 'opening', id: opening.id },
      });
    }
    for (const [label, q] of [['width', opening.width], ['height', opening.height], ['sill', opening.sill]] as const) {
      if (!q) continue;
      if (!q.standard || !Number.isFinite(q.tolerance)) {
        issues.push({
          level: 'blocker', code: 'quantity.undeclared',
          message: `The ${label} of '${opening.id}' has no declared standard or tolerance, so it cannot be shown to anyone.`,
          ref: { type: 'opening', id: opening.id },
        });
      }
      if (!(q.value > 0)) {
        issues.push({
          level: 'blocker', code: 'quantity.non-positive',
          message: `The ${label} of '${opening.id}' is ${q.value}, which is not a dimension.`,
          ref: { type: 'opening', id: opening.id },
        });
      }
    }
  }

  // -- surfaces -------------------------------------------------------------

  for (const surface of doc.surfaces) {
    if (surface.roomId && !roomIds.has(surface.roomId)) {
      issues.push({
        level: 'blocker', code: 'surface.dangling-room',
        message: `Surface '${surface.id}' belongs to '${surface.roomId}', which is no longer in this world.`,
        ref: { type: 'surface', id: surface.id },
      });
    }
    if (surface.isReflective && surface.isGlazed) {
      // Physically possible (a mirrored window film) and almost always a
      // mislabel, because the two are corrected from the same panel.
      issues.push({
        level: 'warning', code: 'surface.mirror-and-glass',
        message: `Surface '${surface.id}' is marked both mirrored and glazed. The camera is blocked at a mirror and lets light through glazing, so one of the two is likely wrong.`,
        ref: { type: 'surface', id: surface.id },
      });
    }
  }

  // -- entities: the out-of-bounds case -------------------------------------

  for (const entity of doc.entities) {
    if (!finiteVec(entity.centroid) || !finiteAabb(entity.aabb)) {
      issues.push({
        level: 'blocker', code: 'entity.non-finite',
        message: `'${entity.label}' has a position or a bounding box that is not a finite set of metres.`,
        ref: { type: 'entity', id: entity.id },
      });
      continue;
    }
    if (entity.aabb.max.some((v, i) => v < entity.aabb.min[i]!)) {
      issues.push({
        level: 'blocker', code: 'entity.inverted-box',
        message: `'${entity.label}' has a bounding box whose maximum is below its minimum.`,
        ref: { type: 'entity', id: entity.id },
      });
      continue;
    }
    if (entity.roomId && !roomIds.has(entity.roomId)) {
      issues.push({
        level: 'blocker', code: 'entity.dangling-room',
        message: `'${entity.label}' is assigned to room '${entity.roomId}', which is no longer in this world.`,
        ref: { type: 'entity', id: entity.id },
      });
    }

    const containing = world.roomAt(entity.centroid);
    if (!containing) {
      const near = nearestRoomWithin(doc, entity.centroid, OUT_OF_BOUNDS_TOLERANCE_M);
      if (!near) {
        issues.push({
          level: 'blocker', code: 'entity.out-of-bounds',
          message: `'${entity.label}' is at ${fmt(entity.centroid)}, which is outside every room in this property. Put it back inside a room, assign it to one, or delete it.`,
          ref: { type: 'entity', id: entity.id },
        });
      } else {
        issues.push({
          level: 'warning', code: 'entity.in-the-wall',
          message: `'${entity.label}' sits in the thickness of a wall next to ${name(near)}. That is right for a radiator or a wall-mounted screen and wrong for anything that stands on a floor.`,
          ref: { type: 'entity', id: entity.id },
        });
      }
    } else if (entity.roomId && entity.roomId !== containing.id) {
      issues.push({
        level: 'warning', code: 'entity.room-mismatch',
        message: `'${entity.label}' is recorded as being in ${name(entity.roomId)} but its position is inside ${name(containing.id)}.`,
        ref: { type: 'entity', id: entity.id },
      });
    }
  }

  // -- navigation -----------------------------------------------------------

  const nodeIds = new Set(doc.nav.nodes.map((n) => n.id));
  for (const edge of doc.nav.edges) {
    for (const end of [edge.a, edge.b]) {
      if (!nodeIds.has(end)) {
        issues.push({
          level: 'blocker', code: 'nav.dangling-edge',
          message: `A route segment leads to '${end}', which is no longer a point in this world.`,
          ref: { type: 'navEdge', id: `${edge.a}->${edge.b}` },
        });
      }
    }
    if (edge.openingId && !doc.openings.some((o) => o.id === edge.openingId)) {
      issues.push({
        level: 'warning', code: 'nav.dangling-opening',
        message: `A route segment passes through opening '${edge.openingId}', which is no longer in this world.`,
        ref: { type: 'navEdge', id: `${edge.a}->${edge.b}` },
      });
    }
  }
  for (const node of doc.nav.nodes) {
    if (node.roomId && !roomIds.has(node.roomId)) {
      issues.push({
        level: 'blocker', code: 'nav.dangling-node-room',
        message: `The viewpoint '${node.id}' is in room '${node.roomId}', which is no longer in this world.`,
        ref: { type: 'navNode', id: node.id },
      });
    }
  }

  const entrances = doc.nav.nodes.filter((n) => n.isEntrance);
  if (doc.nav.nodes.length > 0 && entrances.length === 0) {
    issues.push({
      level: 'blocker', code: 'nav.no-entrance',
      message: 'No entrance is set, so a visitor has nowhere to arrive. Pick the point someone walks in at.',
    });
  } else if (entrances.length > 1) {
    issues.push({
      level: 'blocker', code: 'nav.many-entrances',
      message: `${entrances.length} points are marked as the entrance. Exactly one is the front door.`,
    });
  }

  // -- rooms that can no longer be reached ----------------------------------

  const entrance = entrances[0];
  if (entrance) {
    for (const room of doc.rooms) {
      if (!doc.nav.nodes.some((n) => n.roomId === room.id)) continue;
      if (world.findPath(entrance.id, room.id) === null) {
        issues.push({
          level: 'warning', code: 'nav.unreachable-room',
          message: `${name(room.id)} cannot be reached from the entrance. A visitor will be able to see it on the plan but not walk to it.`,
          ref: { type: 'room', id: room.id },
        });
      }
    }
  }

  // -- regions and measurement ----------------------------------------------

  for (const region of doc.regions) {
    if (!finiteAabb(region.volume)) {
      issues.push({
        level: 'blocker', code: 'region.non-finite',
        message: `Coverage note '${region.id}' has a volume that is not finite.`,
        ref: { type: 'region', id: region.id },
      });
      continue;
    }
    const size = [0, 1, 2].map((i) => region.volume.max[i]! - region.volume.min[i]!);
    if (size.some((v) => v <= 0)) {
      issues.push({
        level: 'warning', code: 'region.empty',
        message: `Coverage note '${region.id}' encloses no volume, so nothing will be marked by it.`,
        ref: { type: 'region', id: region.id },
      });
    }
    if (region.roomId && !roomIds.has(region.roomId)) {
      issues.push({
        level: 'warning', code: 'region.dangling-room',
        message: `Coverage note '${region.id}' refers to room '${region.roomId}', which is no longer in this world.`,
        ref: { type: 'region', id: region.id },
      });
    }
  }

  for (const room of doc.rooms) {
    if (!room.area) {
      issues.push({
        level: 'blocker', code: 'room.no-area',
        message: `${name(room.id)} has no declared area.`,
        ref: { type: 'room', id: room.id },
      });
      continue;
    }
    if (!room.area.standard || !Number.isFinite(room.area.tolerance)) {
      issues.push({
        level: 'blocker', code: 'quantity.undeclared',
        message: `The area of ${name(room.id)} has no declared standard or tolerance, so it cannot be shown to anyone.`,
        ref: { type: 'room', id: room.id },
      });
      continue;
    }
    if (room.polygon.length < 3) continue;

    // A declared area that contradicts the outline it is supposed to describe
    // is the single most dangerous thing in this document: it is the shape of
    // the failure that cost an agency GBP 1,000 at Property Redress. The
    // editor never silently reconciles them -- it names both numbers.
    const derived = world.measureArea(room.id);
    const halfWidthPct = room.area.toleranceUnit === 'pct'
      ? room.area.tolerance
      : (room.area.tolerance / 1000) / Math.max(room.area.value, 1e-6) * 100;
    const deltaPct = Math.abs(derived.value - room.area.value) / Math.max(room.area.value, 1e-6) * 100;
    if (deltaPct > Math.max(halfWidthPct, derived.toleranceUnit === 'pct' ? derived.tolerance : 0)) {
      issues.push({
        level: 'warning', code: 'room.area-contradiction',
        message: `${name(room.id)} declares ${room.area.value.toFixed(2)} m² but its outline measures ${derived.value.toFixed(2)} m², a difference of ${deltaPct.toFixed(1)}%. Both will appear on the measurement certificate, with the declaration named as an operator statement.`,
        ref: { type: 'room', id: room.id },
      });
    }
    if (!isDefensible(derived)) {
      issues.push({
        level: 'warning', code: 'room.area-indicative',
        message: `The area of ${name(room.id)} is computed across geometry no camera observed, so it will publish as indicative rather than as a measurement.`,
        ref: { type: 'room', id: room.id },
      });
    }
  }

  return finish(issues);
}

// ---------------------------------------------------------------------------

function finish(issues: readonly ValidationIssue[]): ValidationResult {
  const blockers = issues.filter((i) => i.level === 'blocker');
  const warnings = issues.filter((i) => i.level === 'warning');
  return { issues, blockers, warnings, savable: blockers.length === 0 };
}

/** Room id whose outline is within `tol` of the point, ignoring height. */
function nearestRoomWithin(
  doc: WorldDocument, p: Vec3, tol: number,
): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const room of doc.rooms) {
    if (room.polygon.length < 3) continue;
    const d = distanceToRingXZ(room.polygon, p[0], p[2]);
    if (d < bestD) { bestD = d; best = room.id; }
  }
  if (best === null || bestD > tol) return null;
  // Height still has to be plausible: a light fitting 4 m above the hall is
  // near the hall's outline in plan and is not in the hall.
  const room = doc.rooms.find((r) => r.id === best);
  if (!room) return null;
  const floorY = Number.isFinite(room.floorZ) ? room.floorZ : 0;
  const ceilY = Number.isFinite(room.ceilingZ) && room.ceilingZ > floorY ? room.ceilingZ : floorY + 2.4;
  if (p[1] < floorY - 0.05 || p[1] > ceilY + 0.05) return null;
  return best;
}

function distanceToRingXZ(ring: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    best = Math.min(best, distanceToSegment(x, z, a[0], a[1], b[0], b[1]));
  }
  return best;
}

function distanceToSegment(
  px: number, pz: number, ax: number, az: number, bx: number, bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function finiteVec(v: Vec3): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
}

function finiteAabb(b: Aabb): boolean {
  return !!b && finiteVec(b.min) && finiteVec(b.max);
}

function fmt(v: Vec3): string {
  return `${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)}`;
}
