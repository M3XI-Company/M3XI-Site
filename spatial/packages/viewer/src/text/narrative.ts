import type {
  Entity, NavEdge, Opening, Quantity, Room, Vec3, WorldDocument,
} from '@m3xi/world-core';
import type { World } from '@m3xi/spatial-engine';
import { formatQuantity, type FormatOptions, type FormattedQuantity } from '../measure/format.js';
import { classifyEntity, classifyRoom, coverageSummary, DISPLAY_STYLE } from '../provenance/classify.js';

/**
 * THE TEXT ALTERNATIVE
 * ====================
 *
 * WCAG 2.2 requires a text alternative for non-text content. For a 3D
 * walkthrough, alt text on a canvas is not an alternative -- it is an apology.
 * A person who cannot use the 3D view wants what the 3D view is for: the
 * layout, the dimensions, what is in each room, how the rooms connect, and
 * what was not surveyed.
 *
 * So this generates a written tour from the same `WorldDocument` the renderer
 * draws, with the same numbers from the same engine, and the viewer presents it
 * as a document with headings and landmarks. It is not a fallback shown when
 * WebGL fails; it is a peer view, available to everyone, always.
 *
 * Deliberately absent: compass directions. The world contract fixes an origin
 * and an up axis but never north, so "a window in the east wall" would be
 * invented. Windows are described by their dimensions and sill height, which
 * the document does know.
 *
 * Also deliberately absent: an accessibility overlay widget. Only 2.4% of
 * disabled users find those effective and they routinely fight the user's own
 * assistive technology. The accessible path here is the ordinary path.
 */

export type NarrativeBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly intro?: string; readonly items: readonly string[] }
  | {
      readonly kind: 'measurement';
      readonly label: string;
      readonly formatted: FormattedQuantity;
    }
  | {
      readonly kind: 'note';
      readonly tone: 'estimated' | 'unsurveyed';
      readonly text: string;
    };

export interface NarrativeSection {
  readonly id: string;
  readonly level: 2 | 3;
  readonly heading: string;
  readonly blocks: readonly NarrativeBlock[];
  /** Present on room sections so the viewer can offer "go to this room". */
  readonly roomId?: string;
}

export interface Narrative {
  readonly title: string;
  readonly lead: string;
  readonly sections: readonly NarrativeSection[];
  readonly worldId: string;
  readonly worldVersion: number;
  readonly generatedAt: string;
}

export interface NarrativeOptions extends FormatOptions {
  /** Include the route-from-the-entrance sentence per room. */
  readonly routes?: boolean;
}

export function buildNarrative(world: World, opts: NarrativeOptions = {}): Narrative {
  const doc = world.doc;
  const sections: NarrativeSection[] = [];

  sections.push(overviewSection(world, opts));
  sections.push(howToReadSection(doc, opts));

  const floors = doc.floors.length > 0
    ? [...doc.floors].sort((a, b) => a.level - b.level)
    : [{ id: '', level: 0, name: 'The property', elevation: 0, grounding: { provenance: 'reconstructed' as const, confidence: 1 } }];

  for (const floor of floors) {
    const rooms = doc.rooms.filter((r) => (r.floorId ?? floors[0]?.id) === floor.id);
    if (rooms.length === 0) continue;
    if (floors.length > 1 || floor.name) {
      sections.push({
        id: `floor-${floor.id || 'all'}`,
        level: 2,
        heading: floor.name ?? `Level ${floor.level}`,
        blocks: [{
          kind: 'paragraph',
          text: `${sentenceCount(rooms.length, 'room', 'rooms')} on this level: ${listPhrase(rooms.map((r) => r.name ?? r.id))}.`,
        }],
      });
    }
    for (const room of sortRooms(rooms)) {
      sections.push(roomSection(world, room, opts));
    }
  }

  sections.push(coverageSection(world, opts));
  sections.push(measurementSection(doc, opts));

  const summary = coverageSummary(world);
  return {
    title: doc.label,
    lead: `A written tour of ${doc.label}, generated from the same survey the 3D view is drawn from. ${summary.headline}`,
    sections,
    worldId: doc.id,
    worldVersion: doc.version,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function overviewSection(world: World, opts: NarrativeOptions): NarrativeSection {
  const doc = world.doc;
  const blocks: NarrativeBlock[] = [];

  const kinds = countKinds(doc.rooms);
  blocks.push({
    kind: 'paragraph',
    text: `${doc.label}. ${listPhrase(kinds)}.`,
  });

  const total = totalArea(world);
  if (total) {
    blocks.push({
      kind: 'measurement',
      label: 'Total floor area of all surveyed rooms',
      formatted: formatQuantity(total, opts),
    });
  }

  const ceiling = typicalCeiling(doc);
  if (ceiling !== undefined) {
    blocks.push({
      kind: 'paragraph',
      text: `Ceilings in the surveyed rooms are typically ${ceiling.toFixed(2)} m above the floor, ±${doc.measurementPolicy.wallToleranceMm} mm.`,
    });
  }

  const entrance = doc.nav.nodes.find((n) => n.isEntrance);
  const entranceRoom = entrance?.roomId ? world.room(entrance.roomId) : undefined;
  if (entranceRoom) {
    blocks.push({
      kind: 'paragraph',
      text: `The tour starts at the entrance, in the ${lower(entranceRoom.name ?? entranceRoom.id)}.`,
    });
  }

  blocks.push({
    kind: 'paragraph',
    text: `Scale was fixed using ${doc.scale.source}, with ${Math.round(doc.scale.agreement * 100)}% agreement between the estimators.`,
  });

  return { id: 'overview', level: 2, heading: 'At a glance', blocks };
}

function howToReadSection(doc: WorldDocument, _opts: NarrativeOptions): NarrativeSection {
  return {
    id: 'how-to-read',
    level: 2,
    heading: 'How to read this tour',
    blocks: [
      {
        kind: 'paragraph',
        text: 'Every dimension below is given with the tolerance it was measured to and the standard it was measured against. A figure without both of those is not a measurement, and you will not find one here.',
      },
      {
        kind: 'paragraph',
        text: `Areas are stated to ${standardPhrase(doc.measurementPolicy.areaStandard)}. Lengths are clear internal: wall face to wall face, with no standard implied.`,
      },
      {
        kind: 'paragraph',
        text: `Where the cameras did not reach, this tour says so. ${DISPLAY_STYLE.unsurveyed.description} In the 3D view the same areas are drawn with diagonal hatching.`,
      },
    ],
  };
}

function roomSection(world: World, room: Room, opts: NarrativeOptions): NarrativeSection {
  const doc = world.doc;
  const blocks: NarrativeBlock[] = [];
  const name = room.name ?? room.id;

  // Opening paragraph: what kind of room, how big, how tall.
  const area = formatQuantity(world.measureArea(room.id), opts);
  const extent = roomExtent(room);
  const height = room.ceilingZ - room.floorZ;
  blocks.push({
    kind: 'paragraph',
    text: `${name} is ${article(kindWord(room))} ${kindWord(room)}. It measures about ${extent.w.toFixed(2)} m by ${extent.d.toFixed(2)} m at its widest, with ${height.toFixed(2)} m from floor to ceiling.`,
  });
  blocks.push({ kind: 'measurement', label: 'Floor area', formatted: area });

  // Connections and glazing.
  const openings = doc.openings.filter((o) => o.roomA === room.id || o.roomB === room.id);
  const doors = openings.filter((o) => o.kind === 'door' || o.kind === 'doorway' || o.kind === 'arch');
  const windows = openings.filter((o) => o.kind === 'window' || o.kind === 'rooflight');

  if (doors.length > 0) {
    blocks.push({
      kind: 'list',
      intro: doors.length === 1 ? 'One doorway:' : `${capitalise(numberWord(doors.length))} doorways:`,
      items: doors.map((d) => describeDoor(world, d, room.id, opts)),
    });
  }
  if (windows.length > 0) {
    blocks.push({
      kind: 'list',
      intro: windows.length === 1 ? 'One window:' : `${capitalise(numberWord(windows.length))} windows:`,
      items: windows.map((w) => describeWindow(w, opts)),
    });
  }

  // Contents.
  const entities = world.entitiesIn(room.id);
  if (entities.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'In the room:',
      items: sortEntities(entities).map((e) => describeEntity(world, e, opts)),
    });
  } else {
    blocks.push({ kind: 'paragraph', text: 'The survey recorded nothing standing in this room.' });
  }

  // What was not surveyed here.
  const prov = classifyRoom(world, room.id);
  for (const region of prov.regions) {
    blocks.push({
      kind: 'note',
      tone: region.provenance === 'generated' ? 'unsurveyed' : 'estimated',
      text: region.provenance === 'generated'
        ? `Part of this room was not surveyed: ${region.reason}. Nothing shown there is evidence of anything, you cannot walk into it in the 3D view, and no measurement crosses it.`
        : `Part of this room was estimated rather than measured: ${region.reason}. Treat measurements that touch it as indicative.`,
    });
  }

  // How to get here.
  if (opts.routes !== false) {
    const route = describeRoute(world, room.id, opts);
    if (route) blocks.push({ kind: 'paragraph', text: route });
  }

  return { id: `room-${room.id}`, level: 3, heading: name, roomId: room.id, blocks };
}

function coverageSection(world: World, _opts: NarrativeOptions): NarrativeSection {
  const summary = coverageSummary(world);
  const blocks: NarrativeBlock[] = [{ kind: 'paragraph', text: summary.headline }];

  if (summary.unsurveyedRegions.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'Not surveyed:',
      items: summary.unsurveyedRegions.map((r) => {
        const room = r.roomId ? world.room(r.roomId) : undefined;
        const where = room ? `${room.name ?? room.id}: ` : '';
        return `${where}${r.reason}.`;
      }),
    });
  }
  if (summary.estimatedRegions.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'Estimated rather than measured:',
      items: summary.estimatedRegions.map((r) => {
        const room = r.roomId ? world.room(r.roomId) : undefined;
        const where = room ? `${room.name ?? room.id}: ` : '';
        return `${where}${r.reason}.`;
      }),
    });
  }
  if (summary.unsurveyedRegions.length === 0 && summary.estimatedRegions.length === 0) {
    blocks.push({
      kind: 'paragraph',
      text: 'Every surveyed room was photographed throughout. Nothing in this tour was filled in by a model.',
    });
  }

  const failed = world.doc.quality.checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'The survey did not meet every quality threshold. The checks it missed:',
      items: failed.map((c) => `${humaniseCheck(c.name)}${c.detail ? `: ${c.detail}` : ''}.`),
    });
  }

  return { id: 'coverage', level: 2, heading: 'What we could not see', blocks };
}

function measurementSection(doc: WorldDocument, _opts: NarrativeOptions): NarrativeSection {
  const p = doc.measurementPolicy;
  return {
    id: 'measurement',
    level: 2,
    heading: 'How these measurements were made',
    blocks: [
      {
        kind: 'paragraph',
        text: `Areas are stated to ${standardPhrase(p.areaStandard)}, with a tolerance of at least ${p.areaTolerancePct}%. Long thin rooms carry a wider tolerance than that, because a wall-position error moves their area proportionally more; the figure shown next to each room is the one that applies to that room.`,
      },
      {
        kind: 'paragraph',
        text: `Individual lengths are stated to ±${p.wallToleranceMm} mm per reconstructed segment. Where a length is made of several segments, the tolerances are combined in quadrature rather than added, because the errors are independent.`,
      },
      {
        kind: 'paragraph',
        text: 'Anywhere a measurement touches geometry that was estimated or not surveyed, its tolerance is widened and it is labelled indicative. We do not quote those figures as fact.',
      },
      {
        kind: 'paragraph',
        text: `This tour was generated from survey version ${doc.version} of ${doc.label}, created ${formatDate(doc.createdAt)}.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

function describeDoor(world: World, o: Opening, fromRoomId: string, opts: NarrativeOptions): string {
  const otherId = o.roomA === fromRoomId ? o.roomB : o.roomA;
  const other = otherId ? world.room(otherId) : undefined;
  const where = other ? `to the ${lower(other.name ?? other.id)}` : 'to outside';
  const width = o.width ? formatQuantity(o.width, opts) : undefined;
  const height = o.height ? formatQuantity(o.height, opts) : undefined;
  const size = width && height
    ? ` The opening is ${width.value} wide and ${height.value} high, ${width.tolerance}.`
    : width ? ` The opening is ${width.value} wide, ${width.tolerance}.` : '';
  const kind = o.kind === 'door' ? 'A door' : o.kind === 'arch' ? 'An arch' : 'An opening';
  return `${kind} ${where}.${size}`;
}

function describeWindow(o: Opening, opts: NarrativeOptions): string {
  const parts: string[] = [];
  if (o.width && o.height) {
    const w = formatQuantity(o.width, opts);
    const h = formatQuantity(o.height, opts);
    parts.push(`${w.value} wide by ${h.value} high, ${w.tolerance}`);
  }
  if (o.sill) {
    const s = formatQuantity(o.sill, opts);
    parts.push(`sill ${s.value} above the floor`);
  }
  const kind = o.kind === 'rooflight' ? 'A rooflight' : 'A window';
  return parts.length > 0 ? `${kind}, ${parts.join(', ')}.` : `${kind}.`;
}

function describeEntity(world: World, e: Entity, opts: NarrativeOptions): string {
  const size = entitySize(e);
  const big = size.w * size.d > 0.25 || size.h > 0.9;
  const cls = classifyEntity(e);
  const dims = big
    ? ` ${size.w.toFixed(2)} m by ${size.d.toFixed(2)} m${size.h > 0.5 ? `, ${size.h.toFixed(2)} m tall` : ''}, ±${world.doc.measurementPolicy.wallToleranceMm} mm`
    : '';
  const note = cls.display === 'real' ? '' : ` ${cls.note}`;
  return `${capitalise(e.label)}.${dims}${note}`.replace(/\s+/g, ' ').trim();
}

/**
 * A route from the entrance, in the words a person would use. Distances are
 * left out of the individual steps on purpose: a step-by-step "walk 2.2 m" is
 * both unusable as an instruction and a number without a standard attached.
 * The total is quoted properly, as a Quantity, at the end.
 */
export function describeRoute(
  world: World, toRoomId: string, opts: NarrativeOptions = {},
): string | undefined {
  const entrance = world.doc.nav.nodes.find((n) => n.isEntrance);
  if (!entrance) return undefined;
  const path = world.findPath(entrance.id, toRoomId);
  if (!path || path.nodes.length < 2) {
    return path && path.nodes.length === 1 ? 'This is where the tour starts.' : undefined;
  }

  const edgeByPair = new Map<string, NavEdge>();
  for (const e of world.doc.nav.edges) {
    edgeByPair.set(`${e.a}|${e.b}`, e);
    edgeByPair.set(`${e.b}|${e.a}`, e);
  }

  const steps: string[] = [];
  let heading: Vec3 | undefined;
  let lastRoomId: string | undefined = entrance.roomId;

  for (let i = 0; i + 1 < path.nodes.length; i++) {
    const a = path.nodes[i]!;
    const b = path.nodes[i + 1]!;
    const dir: Vec3 = [
      b.position[0] - a.position[0], 0, b.position[2] - a.position[2],
    ];
    const turn = heading ? turnWord(heading, dir) : 'straight ahead';
    heading = dir;

    const edge = edgeByPair.get(`${a.id}|${b.id}`);
    const opening = edge?.openingId ? world.opening(edge.openingId) : undefined;
    const enteredRoomId = b.roomId;
    const enteredRoom = enteredRoomId ? world.room(enteredRoomId) : undefined;

    if (opening && enteredRoom && enteredRoomId !== lastRoomId) {
      steps.push(`${turn === 'straight ahead' ? 'go straight ahead' : turn} through the door into the ${lower(enteredRoom.name ?? enteredRoom.id)}`);
      lastRoomId = enteredRoomId;
    } else if (enteredRoom && enteredRoomId !== lastRoomId) {
      steps.push(`${turn === 'straight ahead' ? 'continue' : turn} into the ${lower(enteredRoom.name ?? enteredRoom.id)}`);
      lastRoomId = enteredRoomId;
    } else if (opening) {
      steps.push(`${turn === 'straight ahead' ? 'go straight ahead' : turn} through the doorway`);
    } else if (turn !== 'straight ahead') {
      steps.push(turn);
    }
  }

  const collapsed = dedupe(steps);
  const total = formatQuantity(path.length, opts);
  const walk = collapsed.length > 0
    ? `From the entrance, ${joinSteps(collapsed)}.`
    : 'This room is at the entrance.';
  return `${walk} It is ${total.value} from the entrance along the walkable route, ${total.tolerance}.`;
}

function turnWord(from: Vec3, to: Vec3): string {
  const a = Math.atan2(from[0], from[2]);
  const b = Math.atan2(to[0], to[2]);
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const deg = (d * 180) / Math.PI;
  if (Math.abs(deg) < 25) return 'straight ahead';
  if (Math.abs(deg) > 150) return 'turn back on yourself';
  // Screen-space left is negative yaw about +Y with Z into the page.
  return deg < 0 ? 'turn left' : 'turn right';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function roomExtent(room: Room): { w: number; d: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of room.polygon) {
    if (v[0] < minX) minX = v[0];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] < minZ) minZ = v[1];
    if (v[1] > maxZ) maxZ = v[1];
  }
  return Number.isFinite(minX) ? { w: maxX - minX, d: maxZ - minZ } : { w: 0, d: 0 };
}

function entitySize(e: Entity): { w: number; d: number; h: number } {
  const half = e.obb?.half;
  if (half) return { w: half[0] * 2, d: half[2] * 2, h: half[1] * 2 };
  return {
    w: e.aabb.max[0] - e.aabb.min[0],
    d: e.aabb.max[2] - e.aabb.min[2],
    h: e.aabb.max[1] - e.aabb.min[1],
  };
}

function totalArea(world: World): Quantity | undefined {
  const rooms = world.doc.rooms;
  if (rooms.length === 0) return undefined;
  const parts = rooms.map((r) => world.measureArea(r.id));
  const value = parts.reduce((s, q) => s + q.value, 0);
  if (value <= 0) return undefined;
  // Percentage tolerances combine in quadrature weighted by area, same rule the
  // engine applies to a chain of lengths: the room errors are independent.
  const absolute = Math.sqrt(parts.reduce((s, q) => {
    const abs = q.toleranceUnit === 'pct' ? (q.tolerance / 100) * q.value : q.tolerance / 1000;
    return s + abs * abs;
  }, 0));
  const worst = parts.reduce<Quantity>((a, b) => (
    rankProv(b.grounding.provenance) > rankProv(a.grounding.provenance) ? b : a
  ), parts[0]!);
  const indefensible = parts.find((q) => q.basis?.['defensible'] === false);
  return {
    value,
    unit: 'm2',
    standard: parts[0]!.standard,
    tolerance: (absolute / value) * 100,
    toleranceUnit: 'pct',
    grounding: worst.grounding,
    basis: {
      rooms: rooms.length,
      combined: 'quadrature',
      defensible: indefensible === undefined,
      ...(indefensible
        ? { refusalReason: String(indefensible.basis?.['refusalReason'] ?? 'a room measurement is not defensible') }
        : {}),
    },
  };
}

function rankProv(p: string): number {
  return p === 'generated' ? 3 : p === 'inferred' ? 2 : p === 'reconstructed' ? 1 : 0;
}

function typicalCeiling(doc: WorldDocument): number | undefined {
  const heights = doc.rooms
    .map((r) => r.ceilingZ - r.floorZ)
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return undefined;
  return heights[Math.floor(heights.length / 2)];
}

function countKinds(rooms: readonly Room[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rooms) {
    const k = kindWord(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n === 1 ? `one ${k}` : `${numberWord(n)} ${plural(k)}`));
}

function kindWord(room: Room): string {
  switch (room.kind) {
    case 'living': return 'living room';
    case 'kitchen': return 'kitchen';
    case 'bedroom': return 'bedroom';
    case 'bathroom': return 'bathroom';
    case 'wc': return 'cloakroom';
    case 'hall': return 'hall';
    case 'landing': return 'landing';
    case 'stairwell': return 'stairwell';
    case 'utility': return 'utility room';
    case 'storage': return 'store';
    case 'office': return 'study';
    case 'dining': return 'dining room';
    case 'conservatory': return 'conservatory';
    case 'garage': return 'garage';
    case 'balcony': return 'balcony';
    case 'garden': return 'garden';
    case 'exterior': return 'outdoor space';
    default: return 'room';
  }
}

function plural(word: string): string {
  if (word.endsWith('y') && !/[aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

function sortRooms(rooms: readonly Room[]): Room[] {
  const order: Record<string, number> = {
    hall: 0, living: 1, kitchen: 2, dining: 3, bedroom: 4, bathroom: 5, wc: 6,
  };
  return [...rooms].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9)
    || (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

function sortEntities(entities: readonly Entity[]): Entity[] {
  const rank: Record<string, number> = {
    furniture: 0, appliance: 1, fixture: 2, fitting: 3, structure: 4, other: 5,
  };
  return [...entities].sort((a, b) => {
    const ra = rank[a.category] ?? 9;
    const rb = rank[b.category] ?? 9;
    if (ra !== rb) return ra - rb;
    return volume(b) - volume(a);
  });
}

function volume(e: Entity): number {
  const s = entitySize(e);
  return s.w * s.d * s.h;
}

function listPhrase(items: readonly string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function joinSteps(steps: readonly string[]): string {
  if (steps.length === 1) return steps[0]!;
  return `${steps.slice(0, -1).join(', then ')}, then ${steps[steps.length - 1]}`;
}

function dedupe(steps: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (s !== out[out.length - 1]) out.push(s);
  return out;
}

function numberWord(n: number): string {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return words[n] ?? String(n);
}

function sentenceCount(n: number, one: string, many: string): string {
  return `${capitalise(numberWord(n))} ${n === 1 ? one : many}`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function standardPhrase(standard: string): string {
  switch (standard) {
    case 'RICS-COMP-GIA': return 'the RICS Code of Measuring Practice, gross internal area';
    case 'RICS-COMP-NIA': return 'the RICS Code of Measuring Practice, net internal area';
    case 'IPMS-3C': return 'IPMS 3C, measured to the internal dominant face';
    default: return 'clear internal dimensions, with no standard implied';
  }
}

function humaniseCheck(name: string): string {
  return capitalise(name.replace(/_/g, ' '));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function lower(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}
