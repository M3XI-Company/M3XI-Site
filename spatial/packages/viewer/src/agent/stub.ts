import type { Entity, Quantity, Room, Vec3 } from '@m3xi/world-core';
import { isDefensible, refusalReason, type World } from '@m3xi/spatial-engine';
import { formatQuantity, type FormatOptions } from '../measure/format.js';
import { classifyRoom, coverageSummary } from '../provenance/classify.js';
import { AGENT_CONTRACT_VERSION } from './contract.js';
import type {
  AgentAction, AgentAnswer, AgentCapabilities, AgentCitation, AgentPort, AgentQuestion,
} from './contract.js';

/**
 * A REAL AGENT THAT IS NOT A MODEL
 * ================================
 *
 * `@m3xi/agent` is being written in parallel by someone else. Rather than mock
 * the seam and discover at integration time that it does not fit, this is a
 * complete `AgentPort` implementation that answers the questions visitors
 * actually ask, entirely from the spatial engine: areas, distances, fit tests,
 * room contents, navigation, and what was not surveyed.
 *
 * It is deliberately not a language model and does not pretend to be. Its
 * value is that it exercises every part of the contract -- citations, actions,
 * refusals, quantities -- so when the model-backed agent is plugged in, the
 * viewer half is known to work.
 *
 * It also sets the behavioural bar. Look at `refuse()`: when a measurement is
 * not defensible, this stub does not quote the number and add a caveat. It
 * leads with the refusal. The model-backed agent should do the same.
 */
export class StubAgent implements AgentPort {
  readonly contractVersion = AGENT_CONTRACT_VERSION;
  readonly capabilities: AgentCapabilities;

  constructor(private readonly world: World, private readonly fmt: FormatOptions = {}) {
    this.capabilities = {
      canAnswer: true,
      canStream: false,
      emits: ['camera.goTo', 'camera.lookAt', 'highlight.set', 'highlight.clear', 'measure.show', 'measure.clear', 'ui.open'],
      label: 'Spatial engine (offline)',
      examples: [
        'How big is the kitchen?',
        'Will a 2 m wardrobe fit in bedroom 1?',
        'Take me to the bathroom',
        'What was not surveyed?',
      ],
    };
  }

  async ask(question: AgentQuestion): Promise<AgentAnswer> {
    const text = question.text.trim();
    if (text.length === 0) return this.help();
    const lower = text.toLowerCase();

    // Order matters: "how far is the sofa from the window" contains "how far"
    // and two entity names, and must not be caught by the area handler.
    if (/\b(fit|go in|squeeze|room for)\b/.test(lower)) return this.fit(lower, question);
    if (/\bhow far|distance between|distance from\b/.test(lower)) return this.distance(lower);
    if (/\b(how big|how large|area|square met|sq ?m|size of)\b/.test(lower)) return this.area(lower, question);
    if (/\b(take me|go to|show me|walk|navigate|stand in)\b/.test(lower)) return this.goTo(lower);
    if (/\b(what is in|what's in|contents|furniture in)\b/.test(lower)) return this.contents(lower, question);
    // Written without word boundaries on purpose: "not surveyed" and "not
    // survey" must both match, and \b after "survey" would reject the first.
    if (/(unsurveyed|not survey|didn'?t see|did not see|couldn'?t see|could not see|not see|cameras (miss|never)|coverage|not photograph|made up|invented|is this real)/.test(lower)) {
      return this.coverage();
    }
    if (/\b(how many|number of)\b/.test(lower)) return this.count(lower);
    if (/\bceiling|head ?height|how tall\b/.test(lower)) return this.ceiling(lower, question);
    return this.help();
  }

  // -------------------------------------------------------------------------

  private area(text: string, q: AgentQuestion): AgentAnswer {
    const room = this.findRoom(text) ?? this.contextRoom(q);
    if (!room) {
      return this.clarify('Which room would you like the floor area of?', this.roomSuggestions());
    }
    const quantity = this.world.measureArea(room.id);
    const f = formatQuantity(quantity, this.fmt);
    const cls = classifyRoom(this.world, room.id);

    if (!isDefensible(quantity)) {
      return this.refuse(
        'measurement',
        `I can work out a figure for ${lowerName(room)}, but part of it rests on geometry no camera observed, so I will not quote it as a measurement. ${f.statusNote ?? ''}`.trim(),
        [this.roomCitation(room, quantity)],
        cls.regions.map((r) => r.id),
      );
    }

    const gaps = cls.regions.length > 0
      ? ` Note that ${cls.regions.length === 1 ? 'one part' : `${cls.regions.length} parts`} of this room ${cls.regions.length === 1 ? 'was' : 'were'} not fully surveyed, which is why the tolerance is what it is.`
      : '';

    return {
      text: `${room.name ?? room.id} has a floor area of ${f.value}, ${f.tolerance}, measured to ${f.standard}.${gaps}`,
      speech: `${room.name ?? room.id}. ${f.speech}`,
      citations: [this.roomCitation(room, quantity)],
      actions: [
        { kind: 'camera.goTo', target: { kind: 'room', roomId: room.id }, style: 'walk' },
        { kind: 'measure.show', overlay: areaOverlay(room, f.value, f.tolerance, f.status) },
      ],
      suggestions: [`Will a double bed fit in ${lowerName(room)}?`, `What is in ${lowerName(room)}?`],
    };
  }

  private distance(text: string): AgentAnswer {
    const targets = this.findTwoTargets(text);
    if (!targets) {
      return this.clarify(
        'Which two things would you like the distance between?',
        this.world.doc.entities.slice(0, 3).map((e) => `How far is the ${e.label} from the window?`),
      );
    }
    const [a, b] = targets;
    const quantity = this.world.measureDistance(
      'id' in a ? { entityId: a.id } : { roomId: (a as Room).id },
      'id' in b ? { entityId: b.id } : { roomId: (b as Room).id },
    );
    const f = formatQuantity(quantity, this.fmt);
    if (!isDefensible(quantity)) {
      return this.refuse(
        'measurement',
        `That distance runs through part of the property the cameras never saw, so I cannot stand behind a figure for it. ${refusalReason(quantity) ?? ''}`.trim(),
        [],
      );
    }
    const gap = typeof quantity.basis?.['gapM'] === 'number' ? quantity.basis['gapM'] as number : undefined;
    return {
      text: `${labelOf(a)} and ${labelOf(b)} are ${f.value} apart centre to centre, ${f.tolerance}, ${f.standard}.${gap !== undefined ? ` The nearest faces are ${gap.toFixed(2)} m apart.` : ''}`,
      speech: f.speech,
      citations: [
        { kind: 'quantity', id: 'distance', label: `${labelOf(a)} to ${labelOf(b)}`, quantity, provenance: quantity.grounding.provenance },
      ],
      actions: [
        { kind: 'highlight.set', entityIds: [a, b].filter(isEntity).map((e) => e.id), label: 'Measured between these' },
        {
          kind: 'measure.show',
          overlay: {
            id: 'agent-distance',
            kind: 'distance',
            lines: [[centreOf(a), centreOf(b)]],
            polygons: [],
            footprints: [],
            labels: [{
              at: midpoint(centreOf(a), centreOf(b)),
              text: f.value,
              detail: `${f.tolerance} · ${f.standardShort}`,
              status: f.status,
            }],
          },
        },
      ],
    };
  }

  private fit(text: string, q: AgentQuestion): AgentAnswer {
    const room = this.findRoom(text) ?? this.contextRoom(q);
    if (!room) return this.clarify('Which room should I test?', this.roomSuggestions());

    const size = parseSize(text);
    if (!size) {
      return this.clarify(
        'How big is the thing you want to fit? Give me a width, for example "a 2 m wardrobe".',
        ['Will a 2 m wardrobe fit in bedroom 1?', 'Will a king bed fit in bedroom 2?'],
      );
    }
    const res = this.world.fitTest(room.id, size.size, { clearance: size.clearance, againstWall: size.againstWall });
    const area = this.world.measureArea(room.id);
    const f = formatQuantity(area, this.fmt);

    const citations: AgentCitation[] = [this.roomCitation(room, area)];
    if (!res.fits) {
      return {
        text: `A ${size.label} does not fit in ${lowerName(room)}: ${res.reason ?? 'no valid placement was found'}. The room is ${f.value}, ${f.tolerance}, ${f.standard}.`,
        citations,
        actions: [{ kind: 'camera.goTo', target: { kind: 'room', roomId: room.id }, style: 'walk' }],
        suggestions: [`How big is ${lowerName(room)}?`, `What is in ${lowerName(room)}?`],
      };
    }

    return {
      text: `Yes. A ${size.label} fits in ${lowerName(room)}${size.clearance ? `, leaving ${size.clearance.toFixed(2)} m to walk around it` : ''}. I have drawn ${res.placements.length === 1 ? 'the position' : `${res.placements.length} positions`} it can stand in. The room is ${f.value}, ${f.tolerance}, ${f.standard}.`,
      citations,
      actions: [
        { kind: 'camera.goTo', target: { kind: 'room', roomId: room.id }, style: 'walk' },
        {
          kind: 'measure.show',
          overlay: {
            id: 'agent-fit',
            kind: 'fit',
            lines: [], polygons: [], labels: [],
            footprints: res.placements.map((obb) => ({
              corners: floorCorners(obb, room.floorZ + 0.012),
              ok: true,
            })),
          },
        },
      ],
      suggestions: [`How big is ${lowerName(room)}?`],
    };
  }

  private goTo(text: string): AgentAnswer {
    const room = this.findRoom(text);
    const entity = room ? undefined : this.findEntity(text);
    if (!room && !entity) {
      return this.clarify('Where would you like to go?', this.roomSuggestions());
    }
    if (room) {
      const cls = classifyRoom(this.world, room.id);
      const note = cls.regions.length > 0
        ? ` Part of it was not fully surveyed; that area is hatched and you will not be able to walk into it.`
        : '';
      return {
        text: `Walking through to ${lowerName(room)}.${note}`,
        speech: `Walking through to ${lowerName(room)}.`,
        citations: [{ kind: 'room', id: room.id, label: room.name ?? room.id, provenance: room.grounding.provenance }],
        actions: [
          { kind: 'camera.goTo', target: { kind: 'room', roomId: room.id }, style: 'walk' },
          { kind: 'floorplan.emphasise', roomIds: [room.id] },
        ],
        suggestions: [`How big is ${lowerName(room)}?`, `What is in ${lowerName(room)}?`],
      };
    }
    const e = entity!;
    return {
      text: `Taking you to the ${e.label}.`,
      citations: [{ kind: 'entity', id: e.id, label: e.label, provenance: e.grounding.provenance }],
      actions: [
        { kind: 'camera.goTo', target: { kind: 'entity', entityId: e.id }, lookAt: { kind: 'entity', entityId: e.id }, style: 'walk' },
        { kind: 'highlight.set', entityIds: [e.id], label: e.label },
      ],
    };
  }

  private contents(text: string, q: AgentQuestion): AgentAnswer {
    const room = this.findRoom(text) ?? this.contextRoom(q);
    if (!room) return this.clarify('Which room?', this.roomSuggestions());
    const entities = this.world.entitiesIn(room.id);
    if (entities.length === 0) {
      return {
        text: `The survey recorded nothing standing in ${lowerName(room)}.`,
        citations: [{ kind: 'room', id: room.id, label: room.name ?? room.id, provenance: room.grounding.provenance }],
        actions: [{ kind: 'camera.goTo', target: { kind: 'room', roomId: room.id }, style: 'walk' }],
      };
    }
    const labels = entities.map((e) => e.label);
    const estimated = entities.filter((e) => e.grounding.provenance === 'inferred' || e.grounding.provenance === 'generated');
    const note = estimated.length > 0
      ? ` The ${listOf(estimated.map((e) => e.label))} ${estimated.length === 1 ? 'was' : 'were'} only partly visible during the capture, so ${estimated.length === 1 ? 'its' : 'their'} dimensions are estimated.`
      : '';
    return {
      text: `${room.name ?? room.id} contains ${listOf(labels)}.${note}`,
      citations: entities.map((e) => ({
        kind: 'entity' as const, id: e.id, label: e.label, provenance: e.grounding.provenance,
      })),
      actions: [
        { kind: 'camera.goTo', target: { kind: 'room', roomId: room.id }, style: 'walk' },
        { kind: 'highlight.set', entityIds: entities.map((e) => e.id), label: `Everything in ${lowerName(room)}` },
      ],
    };
  }

  private coverage(): AgentAnswer {
    const summary = coverageSummary(this.world);
    const lines = [summary.headline];
    for (const r of summary.unsurveyedRegions) {
      const room = r.roomId ? this.world.room(r.roomId) : undefined;
      lines.push(`${room ? `${room.name ?? room.id}: ` : ''}${r.reason}.`);
    }
    for (const r of summary.estimatedRegions) {
      const room = r.roomId ? this.world.room(r.roomId) : undefined;
      lines.push(`${room ? `${room.name ?? room.id}: ` : ''}${r.reason} — estimated rather than measured.`);
    }
    return {
      text: lines.join(' '),
      citations: [...summary.unsurveyedRegions, ...summary.estimatedRegions].map((r) => ({
        kind: 'region' as const, id: r.id, label: r.reason, provenance: r.provenance,
      })),
      actions: [{ kind: 'ui.open', panel: 'text' }],
      suggestions: ['How big is the kitchen?'],
    };
  }

  private count(text: string): AgentAnswer {
    const kind = /bedroom/.test(text) ? 'bedroom'
      : /bathroom/.test(text) ? 'bathroom'
      : /room/.test(text) ? undefined : undefined;
    const rooms = kind ? this.world.doc.rooms.filter((r) => r.kind === kind) : this.world.doc.rooms;
    const what = kind ? `${kind}s` : 'surveyed rooms';
    return {
      text: `There ${rooms.length === 1 ? 'is' : 'are'} ${rooms.length} ${rooms.length === 1 ? what.replace(/s$/, '') : what}: ${listOf(rooms.map((r) => r.name ?? r.id))}.`,
      citations: rooms.map((r) => ({
        kind: 'room' as const, id: r.id, label: r.name ?? r.id, provenance: r.grounding.provenance,
      })),
      actions: [{ kind: 'ui.open', panel: 'floorplan' }],
    };
  }

  private ceiling(text: string, q: AgentQuestion): AgentAnswer {
    const room = this.findRoom(text) ?? this.contextRoom(q);
    if (!room) return this.clarify('Which room?', this.roomSuggestions());
    const centre = roomCentre(room);
    const quantity = this.world.measureDistance(
      [centre[0], room.floorZ, centre[2]], [centre[0], room.ceilingZ, centre[2]],
    );
    const f = formatQuantity(quantity, this.fmt);
    if (!isDefensible(quantity)) {
      return this.refuse(
        'measurement',
        `${room.name ?? room.id} has a ceiling that was never in view during the capture, so its height was closed from the neighbouring rooms rather than measured. I will not quote it as a measurement.`,
        [{ kind: 'quantity', id: 'ceiling', label: 'Floor to ceiling', quantity, provenance: quantity.grounding.provenance }],
      );
    }
    return {
      text: `${room.name ?? room.id} is ${f.value} from floor to ceiling, ${f.tolerance}, ${f.standard}.`,
      speech: f.speech,
      citations: [{ kind: 'quantity', id: 'ceiling', label: 'Floor to ceiling', quantity, provenance: quantity.grounding.provenance }],
      actions: [{ kind: 'camera.goTo', target: { kind: 'room', roomId: room.id }, style: 'walk' }],
    };
  }

  // -------------------------------------------------------------------------

  private help(): AgentAnswer {
    return {
      text: 'I can tell you how big a room is, how far apart two things are, whether a piece of furniture will fit, what is in each room, and which parts of this property the cameras did not reach. I can also walk you to any room.',
      citations: [],
      actions: [],
      suggestions: this.capabilities.examples?.slice(0, 3) ?? [],
    };
  }

  private clarify(text: string, suggestions: readonly string[]): AgentAnswer {
    return { text, citations: [], actions: [], suggestions: suggestions.slice(0, 3) };
  }

  private refuse(
    scope: 'measurement' | 'spatial' | 'knowledge' | 'policy',
    text: string,
    citations: AgentCitation[],
    because: readonly string[] = [],
  ): AgentAnswer {
    // A refusal deliberately emits NO actions. An earlier version opened the
    // written tour, which yanked the visitor out of the conversation at the
    // exact moment they were being told something they need to read. The
    // refusal is the answer; it stays where they are looking.
    return {
      text,
      citations,
      actions: [],
      refusal: { scope, text, ...(because.length > 0 ? { because } : {}) },
    };
  }

  private roomCitation(room: Room, quantity?: Quantity): AgentCitation {
    return {
      kind: 'room',
      id: room.id,
      label: room.name ?? room.id,
      provenance: room.grounding.provenance,
      ...(quantity ? { quantity } : {}),
    };
  }

  private roomSuggestions(): string[] {
    return this.world.doc.rooms.slice(0, 3).map((r) => `How big is ${lowerName(r)}?`);
  }

  private contextRoom(q: AgentQuestion): Room | undefined {
    return q.context.roomId ? this.world.room(q.context.roomId) : undefined;
  }

  /** Longest matching room name or kind wins, so "bedroom 1" beats "bedroom". */
  private findRoom(text: string): Room | undefined {
    let best: { room: Room; len: number } | undefined;
    for (const room of this.world.doc.rooms) {
      for (const candidate of [room.name, room.id.replace(/^r_/, ''), room.kind, room.stableKey]) {
        if (!candidate) continue;
        const needle = candidate.toLowerCase().replace(/[-_/]/g, ' ');
        if (!text.includes(needle)) continue;
        if (!best || needle.length > best.len) best = { room, len: needle.length };
      }
    }
    return best?.room;
  }

  private findEntity(text: string): Entity | undefined {
    let best: { e: Entity; len: number } | undefined;
    for (const e of this.world.doc.entities) {
      const needle = e.label.toLowerCase();
      if (!text.includes(needle)) continue;
      if (!best || needle.length > best.len) best = { e, len: needle.length };
    }
    return best?.e;
  }

  /** Both sides of "how far is A from B", in the order they appear in the text. */
  private findTwoTargets(text: string): [Entity | Room, Entity | Room] | undefined {
    const found: Array<{ at: number; thing: Entity | Room }> = [];
    for (const e of this.world.doc.entities) {
      const at = text.indexOf(e.label.toLowerCase());
      if (at >= 0) found.push({ at, thing: e });
    }
    for (const r of this.world.doc.rooms) {
      const name = (r.name ?? r.id).toLowerCase();
      const at = text.indexOf(name);
      if (at >= 0) found.push({ at, thing: r });
    }
    found.sort((a, b) => a.at - b.at);
    const unique: Array<Entity | Room> = [];
    for (const f of found) {
      if (!unique.some((u) => idOf(u) === idOf(f.thing))) unique.push(f.thing);
    }
    return unique.length >= 2 ? [unique[0]!, unique[1]!] : undefined;
  }
}

// ---------------------------------------------------------------------------

/**
 * "a 2 m wardrobe", "a 1.8 metre sofa", "a king bed". Width is what people
 * quote; depth and height come from a small table of what the thing usually is,
 * and the answer says which piece of furniture it tested so the assumption is
 * visible rather than hidden.
 */
function parseSize(text: string): { size: Vec3; label: string; clearance?: number; againstWall?: boolean } | undefined {
  const known: Array<[RegExp, { size: Vec3; label: string; clearance: number; againstWall: boolean }]> = [
    [/king\s*(size)?\s*bed/, { size: [1.5, 0.6, 2.0], label: 'king-size bed', clearance: 0.45, againstWall: false }],
    [/double\s*bed/, { size: [1.35, 0.6, 1.9], label: 'double bed', clearance: 0.45, againstWall: false }],
    [/single\s*bed/, { size: [0.9, 0.6, 1.9], label: 'single bed', clearance: 0.4, againstWall: false }],
    [/washing\s*machine/, { size: [0.6, 0.85, 0.6], label: 'washing machine', clearance: 0.05, againstWall: true }],
    [/dishwasher/, { size: [0.6, 0.85, 0.6], label: 'dishwasher', clearance: 0.05, againstWall: true }],
  ];
  for (const [re, spec] of known) if (re.test(text)) return spec;

  const m = /(\d+(?:\.\d+)?)\s*(m|metre|meter|cm)\b/.exec(text);
  if (!m) return undefined;
  const raw = Number(m[1]);
  const width = m[2] === 'cm' ? raw / 100 : raw;
  if (!Number.isFinite(width) || width <= 0 || width > 20) return undefined;

  if (/wardrobe/.test(text)) {
    return { size: [width, 2.05, 0.6], label: `${m[1]} m wardrobe`, clearance: 0.6, againstWall: true };
  }
  if (/sofa|settee|couch/.test(text)) {
    return { size: [width, 0.85, 0.95], label: `${m[1]} m sofa`, clearance: 0.4 };
  }
  if (/table|desk/.test(text)) {
    return { size: [width, 0.75, 0.9], label: `${m[1]} m table`, clearance: 0.75 };
  }
  // No furniture word: treat the number as a square footprint the visitor
  // wants to stand something in, and say so in the label.
  return { size: [width, 1.0, width], label: `${m[1]} m by ${m[1]} m footprint`, clearance: 0.3 };
}

function isEntity(t: Entity | Room): t is Entity {
  return 'centroid' in t;
}

function idOf(t: Entity | Room): string {
  return t.id;
}

function labelOf(t: Entity | Room): string {
  return isEntity(t) ? `the ${t.label}` : (t.name ?? t.id);
}

function centreOf(t: Entity | Room): Vec3 {
  return isEntity(t) ? t.centroid : roomCentre(t);
}

function roomCentre(room: Room): Vec3 {
  let x = 0, z = 0;
  for (const v of room.polygon) { x += v[0]; z += v[1]; }
  const n = Math.max(1, room.polygon.length);
  return [x / n, room.floorZ + 1.2, z / n];
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function lowerName(room: Room): string {
  const n = room.name ?? room.id;
  return n.length > 0 ? n[0]!.toLowerCase() + n.slice(1) : n;
}

function listOf(items: readonly string[]): string {
  const unique = [...new Set(items)];
  if (unique.length === 0) return 'nothing';
  if (unique.length === 1) return `a ${unique[0]}`;
  return `${unique.slice(0, -1).map((s) => `a ${s}`).join(', ')} and a ${unique[unique.length - 1]}`;
}

function areaOverlay(room: Room, value: string, tolerance: string, status: 'defensible' | 'indicative') {
  const ring = room.polygon.map((v): Vec3 => [v[0], room.floorZ + 0.01, v[1]]);
  const centre = roomCentre(room);
  return {
    id: `agent-area-${room.id}`,
    kind: 'area' as const,
    lines: [[...ring, ring[0]!]],
    polygons: [ring],
    footprints: [],
    labels: [{ at: [centre[0], room.floorZ + 0.02, centre[2]] as Vec3, text: value, detail: tolerance, status }],
  };
}

function floorCorners(
  obb: { centre: Vec3; half: Vec3; quat: readonly number[] }, y: number,
): [Vec3, Vec3, Vec3, Vec3] {
  const q = obb.quat;
  const yaw = Math.atan2(
    2 * ((q[3] ?? 1) * (q[1] ?? 0) + (q[0] ?? 0) * (q[2] ?? 0)),
    1 - 2 * ((q[1] ?? 0) ** 2 + (q[0] ?? 0) ** 2),
  );
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hx = obb.half[0];
  const hz = obb.half[2];
  const at = (sx: number, sz: number): Vec3 => [
    obb.centre[0] + c * (hx * sx) + s * (hz * sz),
    y,
    obb.centre[2] - s * (hx * sx) + c * (hz * sz),
  ];
  return [at(1, 1), at(1, -1), at(-1, -1), at(-1, 1)];
}
