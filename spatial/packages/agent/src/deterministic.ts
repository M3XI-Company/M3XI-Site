/**
 * Tier 0: answers with no model call at all.
 *
 * The spatial engine computes, a template phrases, the viewer is told what to
 * draw. If a question lands here it costs nothing but CPU, and it is exactly
 * as correct as the geometry.
 *
 * A handler returns `null` rather than guessing. Every null is an escalation
 * to a paid tier, so each one is a deliberate admission that the deterministic
 * path cannot answer honestly -- not a gap someone forgot to fill.
 */

import type { Grounding, Quantity, Vec3 } from '@m3xi/world-core';
import { isDefensible, math } from '@m3xi/spatial-engine';

import type { ViewerCommand } from './commands.js';
import type { Intent, SlotMatch } from './intent.js';
import {
  capitalise, formatArea, formatLength, formatShortLength, joinList, plural,
  provenanceCaveat, quantityRefusal, summariseLabels,
} from './phrase.js';
import type { ReferenceResolver } from './resolver.js';
import type { Tools, WorldRef } from './tools.js';
import { mergeGrounding, refId, refLabel, refPoint } from './tools.js';
import type { PathResultData, Refusal, ToolName, ToolResult } from './types.js';

export interface AgentAnswer {
  readonly text: string;
  readonly commands: readonly ViewerCommand[];
  /** Every claim traces to a tool result. False must never reach a user. */
  readonly grounded: boolean;
  readonly refused: boolean;
  readonly refusal?: Refusal;
  readonly tools: readonly ToolName[];
  readonly grounding: Grounding;
  /** World object ids the answer rests on. */
  readonly citations: readonly string[];
}

export interface DeterministicDeps {
  readonly tools: Tools;
  readonly resolver: ReferenceResolver;
  readonly commands: ViewerCommand[];
  readonly nextCommandId: () => string;
}

// ---------------------------------------------------------------------------
// Slot resolution
// ---------------------------------------------------------------------------

type SlotResult =
  | { readonly ok: true; readonly ref: WorldRef }
  | { readonly ok: false; readonly answer: AgentAnswer };

function resolveSlot(
  d: DeterministicDeps, slot: SlotMatch | undefined,
  opts: { type?: WorldRef['type']; contextRoomId?: string; excludeIds?: readonly string[] } = {},
): SlotResult | null {
  if (!slot) return null;
  // A slot that already carries a unique world object skips scoring entirely.
  if (slot.ref && (!opts.type || slot.ref.type === opts.type)) {
    d.resolver.noteUserMention(slot.ref);
    return { ok: true, ref: slot.ref };
  }
  const r = d.resolver.resolve(slot.phrase, {
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.contextRoomId ? { contextRoomId: opts.contextRoomId } : {}),
    ...(opts.excludeIds ? { excludeIds: opts.excludeIds } : {}),
  });
  if (r.ok) {
    d.resolver.noteUserMention(r.ref);
    return { ok: true, ref: r.ref };
  }
  if (r.reason === 'ambiguous') {
    const names = r.candidates.map((c) => refLabel(c.ref));
    return {
      ok: false,
      answer: refusalAnswer({
        code: 'ambiguous',
        reason: `"${slot.phrase}" could be ${joinList([...new Set(names)], 'or')}. Which one?`,
        evidenceIds: r.candidates.map((c) => refId(c.ref)),
      }, ['get_entity']),
    };
  }
  return {
    ok: false,
    answer: refusalAnswer({
      code: 'not_found',
      reason: `I can't find "${slot.phrase}" in this capture.`,
    }, ['find_entities']),
  };
}

/**
 * Slots in the order they appeared, which is not the order they are wanted in.
 *
 * "Will a 2 m sofa fit in bedroom 2" names the object first and the room
 * second; "is there room in bedroom 2 for a 2 m sofa" names them the other way
 * round. A handler that assumes position gets one of those wrong, so handlers
 * pick a slot by what it resolved to instead.
 */
function slotsOf(i: Intent): SlotMatch[] {
  return [i.subject, i.object].filter((x): x is SlotMatch => x !== undefined);
}

function pickSlot(i: Intent, want: WorldRef['type']): SlotMatch | undefined {
  return slotsOf(i).find((s) => s.ref?.type === want);
}

/** The first slot that is NOT one of the given kinds, resolved or not. */
function pickSlotExcept(i: Intent, ...exclude: WorldRef['type'][]): SlotMatch | undefined {
  return slotsOf(i).find((s) => !s.ref || !exclude.includes(s.ref.type));
}

/** The room a reference lives in, for co-argument context. */
function roomOfRef(ref: WorldRef): string | undefined {
  switch (ref.type) {
    case 'room': return ref.room.id;
    case 'entity': return ref.entity.roomId;
    case 'opening': return ref.opening.roomA;
    case 'surface': return ref.surface.roomId;
  }
}

function refusalAnswer(refusal: Refusal, tools: readonly ToolName[] = []): AgentAnswer {
  return {
    text: refusal.reason,
    commands: [],
    // A refusal IS grounded: the system knows, from tool output, that it does
    // not know. The flag distinguishes "answered from evidence" from "made up",
    // and a correct refusal belongs in the first category.
    grounded: true,
    refused: true,
    refusal,
    tools,
    grounding: { provenance: 'observed', confidence: 1 },
    citations: refusal.evidenceIds ?? [],
  };
}

function answer(
  d: DeterministicDeps, text: string, results: readonly ToolResult<unknown>[],
  extra: { readonly citations?: readonly string[] } = {},
): AgentAnswer {
  const oks = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  const grounding = mergeGrounding(...oks.map((r) => r.grounding));
  const citations = extra.citations ?? oks.flatMap((r) => r.consulted);
  return {
    text,
    commands: d.commands.slice(),
    grounded: oks.length > 0,
    refused: false,
    tools: d.tools.used.slice(),
    grounding,
    citations: [...new Set(citations)],
  };
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

function measurementCommand(
  d: DeterministicDeps, from: Vec3, to: Vec3, q: Quantity,
): void {
  d.commands.push({
    kind: 'measurementOverlay', id: d.nextCommandId(), intent: 'answer',
    from, to,
    label: formatShortLength(q),
    valueM: q.value,
    toleranceMm: q.tolerance,
    provenance: q.grounding.provenance,
    defensible: isDefensible(q),
  });
}

function areaCommand(d: DeterministicDeps, roomId: string, q: Quantity): void {
  const room = d.tools.world.room(roomId);
  if (!room) return;
  const ring = math.sanitiseRing(room.polygon);
  d.commands.push({
    kind: 'areaOverlay', id: d.nextCommandId(), intent: 'answer',
    roomId,
    polygon: ring.map((v) => [v[0], v[1]] as const),
    floorY: Number.isFinite(room.floorZ) ? room.floorZ : 0,
    label: `${q.value.toFixed(1)} m²`,
    valueM2: q.value,
    tolerancePct: q.tolerance,
    standard: q.standard,
    defensible: isDefensible(q),
  });
}

function highlight(
  d: DeterministicDeps, ids: readonly string[], style: 'primary' | 'secondary' | 'warning' = 'primary',
): void {
  const entities = ids.filter((id) => d.tools.world.entity(id));
  if (entities.length > 0) {
    d.commands.push({
      kind: 'highlightEntities', id: d.nextCommandId(), intent: 'answer',
      entityIds: entities, style,
    });
  }
}

function focusRoom(d: DeterministicDeps, roomId: string, isolate = false): void {
  d.commands.push({
    kind: 'focusRoom', id: d.nextCommandId(), intent: 'answer', roomId, isolate,
  });
}

function pathCommand(d: DeterministicDeps, path: PathResultData): void {
  d.commands.push({
    kind: 'pathOverlay', id: d.nextCommandId(), intent: 'navigation',
    points: path.points,
    lengthM: path.length.value,
    label: formatShortLength(path.length),
  });
}

function regionWarning(d: DeterministicDeps, q: Quantity): void {
  const ids = d.tools.world.doc.regions
    .filter((r) => r.provenance !== 'observed')
    .map((r) => r.id);
  if (ids.length === 0 || isDefensible(q)) return;
  d.commands.push({
    kind: 'regionOverlay', id: d.nextCommandId(), intent: 'answer',
    regionIds: ids,
    provenance: q.grounding.provenance === 'generated' ? 'generated' : 'inferred',
    label: 'not observed by any camera',
  });
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/**
 * Attempt a deterministic answer. Returns null when the question needs a model.
 */
export function answerDeterministically(intent: Intent, d: DeterministicDeps): AgentAnswer | null {
  switch (intent.kind) {
    case 'world_summary': return handleSummary(intent, d);
    case 'area': return handleArea(intent, d);
    case 'dimensions': return handleDimensions(intent, d);
    case 'distance': return handleDistance(intent, d);
    case 'count': return handleCount(intent, d);
    case 'contents': return handleContents(intent, d);
    case 'exists': return handleExists(intent, d);
    case 'locate': return handleLocate(intent, d);
    case 'connectivity': return handleConnectivity(intent, d);
    case 'fit': return handleFit(intent, d);
    case 'visibility': return handleVisibility(intent, d);
    case 'identify': return handleIdentify(intent, d);
    case 'surface': return handleSurface(intent, d);
    case 'provenance': return handleProvenance(intent, d);
    case 'navigate': return handleNavigate(intent, d);
    case 'compare': return handleCompare(intent, d);
    case 'unknown': return null;
  }
}

// --- world_summary ---------------------------------------------------------

function handleSummary(_i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const res = d.tools.query_world();
  if (!res.ok) return refusalAnswer(res.refusal, ['query_world']);
  const s = res.data;
  const beds = plural(s.bedroomCount, 'bedroom');
  const baths = plural(s.bathroomCount, 'bathroom');
  const total = formatArea(s.totalAreaM2);
  const soft = quantityRefusal(s.totalAreaM2);
  const roomList = s.rooms
    .map((r) => `${r.name} ${r.areaM2.toFixed(1)} m²`)
    .join(', ');
  const text = soft
    ? `${s.label}: ${beds}, ${baths}, ${s.roomCount} rooms in total (${roomList}). ${soft}`
    : `${s.label}: ${beds}, ${baths}, ${s.roomCount} rooms in total — ${total}. Room by room: ${roomList}.`;
  return answer(d, text, [res]);
}

// --- area ------------------------------------------------------------------

function handleArea(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  // "How big is the double bed" is worded as an area question and means a
  // dimensions one. Delegating is better than refusing: the user asked a
  // perfectly clear question and the phrasing was ours to interpret.
  const named = slotsOf(i)[0];
  if (named?.ref && named.ref.type !== 'room') {
    return handleDimensions({ ...i, subject: named, axis: 'all' }, d);
  }
  const slot = resolveSlot(d, pickSlot(i, 'room') ?? i.subject, { type: 'room' })
    ?? currentRoomSlot(d);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;
  if (slot.ref.type !== 'room') return null;

  const res = d.tools.measure_area(slot.ref.room.id);
  if (!res.ok) return refusalAnswer(res.refusal, ['measure_area']);
  const q = res.data;
  const soft = quantityRefusal(q);
  const name = slot.ref.room.name ?? slot.ref.room.kind;
  areaCommand(d, slot.ref.room.id, q);
  focusRoom(d, slot.ref.room.id);
  regionWarning(d, q);

  if (soft) return answer(d, `${capitalise(name)}: ${soft}`, [res]);
  const caveat = provenanceCaveat(q.grounding.provenance, q.grounding.confidence);
  const text = `${capitalise(name)} is ${formatArea(q)}.${caveat ? ` Note: ${caveat}.` : ''}`;
  return answer(d, text, [res]);
}

function currentRoomSlot(d: DeterministicDeps): SlotResult | null {
  const here = d.tools.get_current_room();
  if (!here.ok) return null;
  return { ok: true, ref: { type: 'room', room: here.data } };
}

// --- dimensions ------------------------------------------------------------

function handleDimensions(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const slot = resolveSlot(d, i.subject) ?? currentRoomSlot(d);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;
  const ref = slot.ref;
  if (ref.type === 'surface') return null;

  const res = d.tools.get_dimensions(refId(ref));
  if (!res.ok) return refusalAnswer(res.refusal, ['get_dimensions']);
  const dim = res.data;
  const name = refLabel(ref);
  const axis = i.axis ?? 'all';

  if (ref.type === 'entity') highlight(d, [ref.entity.id]);
  if (ref.type === 'room') { focusRoom(d, ref.room.id); }

  const pick = axis === 'height' ? dim.height : axis === 'width' ? dim.width : axis === 'depth' ? dim.depth : null;
  if (pick) {
    const soft = quantityRefusal(pick);
    if (soft) return answer(d, `${capitalise(name)}: ${soft}`, [res]);
    const word = axis === 'height'
      ? (ref.type === 'room' ? 'floor to ceiling' : 'tall')
      : axis === 'width' ? 'wide' : 'deep';
    return answer(d, `${capitalise(name)} is ${formatLength(pick)} ${word}.`, [res]);
  }

  const soft = quantityRefusal(dim.width) ?? quantityRefusal(dim.depth);
  if (soft) return answer(d, `${capitalise(name)}: ${soft}`, [res]);
  const parts = ref.type === 'room'
    ? `${dim.width.value.toFixed(2)} m by ${dim.depth.value.toFixed(2)} m, ${dim.height.value.toFixed(2)} m floor to ceiling`
    : `${dim.width.value.toFixed(2)} m wide, ${dim.depth.value.toFixed(2)} m deep, ${dim.height.value.toFixed(2)} m tall`;
  const tol = `±${Math.round(dim.width.tolerance)} mm`;
  const areaPart = dim.area && isDefensible(dim.area) ? ` — ${formatArea(dim.area)}` : '';
  const caveat = provenanceCaveat(res.grounding.provenance, res.grounding.confidence);
  return answer(
    d,
    `${capitalise(name)}: ${parts} (${tol})${areaPart}.${caveat ? ` Note: ${caveat}.` : ''}`,
    [res],
  );
}

// --- distance --------------------------------------------------------------

function handleDistance(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  // Resolve the unambiguous end first and use it as context for the other.
  // "How far is that from the desk" is answerable precisely because the desk
  // is not in doubt, and the desk's room is strong evidence for what "that"
  // is. Resolving strictly left to right throws that evidence away.
  const subjectIsDeictic = i.subject !== undefined && i.subject.ref === undefined;
  const objectIsDeictic = i.object !== undefined && i.object.ref === undefined;
  const anchorFirst = subjectIsDeictic && !objectIsDeictic;

  let a: SlotResult | null;
  let b: SlotResult | null;
  if (anchorFirst) {
    b = resolveSlot(d, i.object);
    if (b !== null && !b.ok) return b.answer;
    const ctx = b?.ok ? roomOfRef(b.ref) : undefined;
    a = resolveSlot(d, i.subject, {
      ...(ctx ? { contextRoomId: ctx } : {}),
      ...(b?.ok ? { excludeIds: [refId(b.ref)] } : {}),
    });
  } else {
    a = resolveSlot(d, i.subject);
    if (a !== null && !a.ok) return a.answer;
    const ctx = a?.ok ? roomOfRef(a.ref) : undefined;
    // "How far is the sofa" with one slot means "from where I am standing",
    // which is a real and common question, not an incomplete one.
    b = resolveSlot(d, i.object, {
      ...(ctx ? { contextRoomId: ctx } : {}),
      ...(a?.ok ? { excludeIds: [refId(a.ref)] } : {}),
    });
  }
  if (a === null) return null;
  if (!a.ok) return a.answer;
  if (b !== null && !b.ok) return b.answer;

  const fromRef = a.ref;
  const toRef = b?.ok ? b.ref : null;
  const res = toRef
    ? d.tools.measure_distance(refId(fromRef), refId(toRef))
    : d.tools.measure_distance(refId(fromRef), d.tools.view.position);
  if (!res.ok) return refusalAnswer(res.refusal, ['measure_distance']);
  const q = res.data;

  const pA = refPoint(fromRef);
  const pB = toRef ? refPoint(toRef) : d.tools.view.position;
  measurementCommand(d, pA, pB, q);
  highlight(d, [refId(fromRef), ...(toRef ? [refId(toRef)] : [])]);
  regionWarning(d, q);

  const soft = quantityRefusal(q);
  const aName = refLabel(fromRef);
  const bName = toRef ? refLabel(toRef) : 'where you are standing';
  if (soft) return answer(d, `${capitalise(aName)} to ${bName}: ${soft}`, [res]);

  // The nearest-surface gap is what people usually mean by "how far apart".
  // The engine computes it alongside the centre-to-centre value.
  const gap = typeof q.basis?.['gapM'] === 'number' ? (q.basis['gapM'] as number) : null;
  const gapText = gap !== null && Math.abs(gap - q.value) > 0.05
    ? ` The nearest faces are ${gap.toFixed(2)} m apart.`
    : '';
  const caveat = provenanceCaveat(q.grounding.provenance, q.grounding.confidence);
  return answer(
    d,
    `${capitalise(aName)} to ${bName} is ${formatLength(q)}, centre to centre.${gapText}${caveat ? ` Note: ${caveat}.` : ''}`,
    [res],
  );
}

// --- count -----------------------------------------------------------------

function handleCount(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  // "How many windows" / "how many chairs in the kitchen". The subject slot is
  // the thing being counted; a second slot, or the current room, scopes it.
  const subject = pickSlotExcept(i, 'room') ?? i.subject;
  if (!subject && !i.category) return null;

  // The room slot is the scope wherever it appears in the sentence.
  const scopeSlot = pickSlot(i, 'room');
  let roomId: string | undefined;
  if (scopeSlot) {
    const s = resolveSlot(d, scopeSlot, { type: 'room' });
    if (s && !s.ok) return s.answer;
    if (s?.ok && s.ref.type === 'room') roomId = s.ref.room.id;
  }

  // Counting openings is a different query from counting entities.
  const label = subject?.phrase ?? '';
  if (/\b(window|windows|door|doors|doorway|doorways)\b/.test(label)) {
    const kind = /window/.test(label) ? 'window' : 'door';
    const openings = d.tools.world.doc.openings.filter((o) => {
      const kindOk = kind === 'window' ? o.kind === 'window' || o.kind === 'rooflight'
        : o.kind === 'door' || o.kind === 'doorway';
      if (!kindOk) return false;
      if (!roomId) return true;
      return o.roomA === roomId || o.roomB === roomId;
    });
    const rel = d.tools.get_relationships(openings[0]?.id ?? (roomId ?? ''));
    const where = roomId ? ` in ${d.tools.world.room(roomId)?.name ?? 'that room'}` : ' in this property';
    return answer(
      d,
      `${capitalise(plural(openings.length, kind))}${where}.`,
      [rel],
      { citations: openings.map((o) => o.id) },
    );
  }

  const res = d.tools.find_entities({
    ...(subject && !subject.ref ? { label: subject.phrase } : {}),
    ...(subject?.ref?.type === 'entity' ? { label: subject.ref.entity.label } : {}),
    ...(i.category ? { category: i.category } : {}),
    ...(roomId ? { roomId } : {}),
  });
  if (!res.ok) return refusalAnswer(res.refusal, ['find_entities']);
  const found = res.data;
  const where = roomId ? ` in ${d.tools.world.room(roomId)?.name ?? 'that room'}` : '';
  if (found.length === 0) {
    const what = subject?.phrase ?? i.category ?? 'anything like that';
    return answer(d, `The capture shows no ${what}${where}.`, [res]);
  }
  highlight(d, found.map((e) => e.id));
  if (roomId) focusRoom(d, roomId);
  const noun = subject?.phrase ?? i.category ?? 'item';
  return answer(d, `${capitalise(plural(found.length, noun))}${where}.`, [res]);
}

// --- contents --------------------------------------------------------------

function handleContents(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const slot = resolveSlot(d, i.subject, { type: 'room' }) ?? currentRoomSlot(d);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;
  if (slot.ref.type !== 'room') return null;
  const room = slot.ref.room;

  const res = d.tools.find_entities({
    roomId: room.id,
    ...(i.category ? { category: i.category } : {}),
  });
  if (!res.ok) return refusalAnswer(res.refusal, ['find_entities']);
  const found = res.data;
  focusRoom(d, room.id, true);
  if (found.length === 0) {
    return answer(d, `${capitalise(room.name ?? room.kind)} is empty in this capture.`, [res]);
  }
  highlight(d, found.map((e) => e.id), 'secondary');
  const soft = found.filter((e) => e.grounding.provenance === 'inferred' || e.grounding.provenance === 'generated');
  const softNote = soft.length > 0
    ? ` ${joinList(soft.map((e) => e.label))} ${soft.length === 1 ? 'was' : 'were'} partly estimated rather than fully observed.`
    : '';
  return answer(
    d,
    `${capitalise(room.name ?? room.kind)} contains ${summariseLabels(found.map((e) => e.label))}.${softNote}`,
    [res],
  );
}

// --- exists ----------------------------------------------------------------

/**
 * A yes/no about presence. Worth its own handler rather than reusing count,
 * because "does the kitchen have an oven" wants "Yes" first and a number
 * second, and because the negative answer is the interesting one: saying "no
 * dishwasher" when the capture simply did not see one would be a claim the
 * geometry cannot support, so the wording is about the capture, not the flat.
 */
function handleExists(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const thing = pickSlotExcept(i, 'room') ?? i.subject;
  if (!thing) return null;
  const scope = pickSlot(i, 'room');
  let roomId: string | undefined;
  if (scope) {
    const s = resolveSlot(d, scope, { type: 'room' });
    if (s && !s.ok) return s.answer;
    if (s?.ok && s.ref.type === 'room') roomId = s.ref.room.id;
  }

  const label = thing.ref?.type === 'entity' ? thing.ref.entity.label : thing.phrase;
  const res = d.tools.find_entities({ label, ...(roomId ? { roomId } : {}) });
  if (!res.ok) return refusalAnswer(res.refusal, ['find_entities']);
  const found = res.data;
  const where = roomId ? ` in ${d.tools.world.room(roomId)?.name ?? 'that room'}` : ' in this capture';

  if (found.length === 0) {
    return answer(d, `No — the capture shows no ${label}${where}.`, [res]);
  }
  highlight(d, found.map((e) => e.id));
  if (roomId) focusRoom(d, roomId);
  const detail = found.length === 1
    ? `a ${found[0]!.label}`
    : summariseLabels(found.map((e) => e.label));
  return answer(d, `Yes — ${detail}${where}.`, [res]);
}

// --- locate ----------------------------------------------------------------

function handleLocate(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const slot = resolveSlot(d, i.subject);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;
  const ref = slot.ref;

  if (ref.type === 'room') {
    const rel = d.tools.get_relationships(ref.room.id, 'adjacent_to');
    if (!rel.ok) return refusalAnswer(rel.refusal, ['get_relationships']);
    const neighbours = rel.data.relationships
      .map((r) => d.tools.world.room(r.objectId)?.name)
      .filter((n): n is string => typeof n === 'string');
    focusRoom(d, ref.room.id);
    const text = neighbours.length > 0
      ? `${capitalise(ref.room.name ?? ref.room.kind)} sits next to ${joinList([...new Set(neighbours)])}.`
      : `${capitalise(ref.room.name ?? ref.room.kind)} is on ${d.tools.world.doc.floors.find((f) => f.id === ref.room.floorId)?.name ?? 'this floor'}.`;
    return answer(d, text, [rel]);
  }

  const id = refId(ref);
  const roomRes = d.tools.get_room(id);
  if (!roomRes.ok) return refusalAnswer(roomRes.refusal, ['get_room']);
  const room = roomRes.data;

  // "Where is the sofa" is answered better with a landmark than a coordinate.
  const rel = d.tools.get_relationships(id);
  const near = rel.ok
    ? rel.data.relationships
      .filter((r) => r.predicate === 'near' || r.predicate === 'located_on')
      .map((r) => d.tools.labelOf(r.objectId))
      .filter((n): n is string => typeof n === 'string')
      .slice(0, 3)
    : [];

  if (ref.type === 'entity') { highlight(d, [id]); }
  focusRoom(d, room.id);
  const nearText = near.length > 0 ? `, near ${joinList([...new Set(near)])}` : '';
  return answer(
    d,
    `${capitalise(refLabel(ref))} is in ${room.name ?? room.kind}${nearText}.`,
    [roomRes, rel],
  );
}

// --- connectivity ----------------------------------------------------------

function handleConnectivity(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const a = resolveSlot(d, i.subject);
  if (a === null) return null;
  if (!a.ok) return a.answer;
  const b = resolveSlot(d, i.object);
  if (b !== null && !b.ok) return b.answer;

  // Two places named: a route question.
  if (b?.ok) {
    const res = d.tools.find_path(refId(a.ref), refId(b.ref));
    if (!res.ok) {
      return refusalAnswer({
        code: res.refusal.code,
        reason: `${capitalise(refLabel(a.ref))} and ${refLabel(b.ref)}: ${res.refusal.reason}.`,
      }, ['find_path']);
    }
    pathCommand(d, res.data);
    const rooms = res.data.roomSequence
      .map((r) => d.tools.world.room(r)?.name ?? r)
      .filter((x, idx, arr) => arr[idx - 1] !== x);
    const soft = quantityRefusal(res.data.length);
    const via = rooms.length > 2 ? ` via ${joinList(rooms.slice(1, -1))}` : ' directly';
    const text = soft
      ? `There is a route from ${refLabel(a.ref)} to ${refLabel(b.ref)}${via}, but ${soft}`
      : `${capitalise(refLabel(a.ref))} to ${refLabel(b.ref)} is ${formatLength(res.data.length)} of walking${via}.`;
    return answer(d, text, [res]);
  }

  // One place named: what does it connect to.
  const id = refId(a.ref);
  const rel = d.tools.get_relationships(id);
  if (!rel.ok) return refusalAnswer(rel.refusal, ['get_relationships']);
  const connected = rel.data.relationships
    .filter((r) => r.predicate === 'connected_to' || r.predicate === 'opens_into')
    .map((r) => d.tools.world.room(r.objectId)?.name ?? d.tools.labelOf(r.objectId))
    .filter((n): n is string => typeof n === 'string');
  const adjacent = rel.data.relationships
    .filter((r) => r.predicate === 'adjacent_to')
    .map((r) => d.tools.world.room(r.objectId)?.name)
    .filter((n): n is string => typeof n === 'string');

  if (a.ref.type === 'room') focusRoom(d, a.ref.room.id);
  if (connected.length === 0 && adjacent.length === 0) {
    return answer(
      d,
      `The capture does not show ${refLabel(a.ref)} connecting to anything else.`,
      [rel],
    );
  }
  const parts: string[] = [];
  if (connected.length > 0) parts.push(`opens onto ${joinList([...new Set(connected)])}`);
  if (adjacent.length > 0) parts.push(`shares a wall with ${joinList([...new Set(adjacent)])}`);
  return answer(d, `${capitalise(refLabel(a.ref))} ${joinList(parts)}.`, [rel]);
}

// --- fit -------------------------------------------------------------------

function handleFit(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  if (!i.sizeM) return null;
  const slot = resolveSlot(d, pickSlot(i, 'room'), { type: 'room' }) ?? currentRoomSlot(d);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;
  if (slot.ref.type !== 'room') return null;
  const room = slot.ref.room;

  const res = d.tools.check_collision({
    roomId: room.id,
    sizeM: i.sizeM,
    // 50 mm of breathing room: furniture that fits to the millimetre does not
    // fit, and a viewer told otherwise will remember it.
    clearanceM: 0.05,
  });
  if (!res.ok) return refusalAnswer(res.refusal, ['check_collision']);
  const fit = res.data as { fits: boolean; placements: readonly { centre: Vec3; half: Vec3; quat: readonly [number, number, number, number] }[]; reason?: string };
  const size = i.sizeM;
  const sizeText = `${size[0].toFixed(2)} × ${size[2].toFixed(2)} m`;
  focusRoom(d, room.id);

  if (fit.fits) {
    const p = fit.placements[0];
    if (p) {
      d.commands.push({
        kind: 'placementOverlay', id: d.nextCommandId(), intent: 'answer',
        centre: p.centre, half: p.half, quat: p.quat as [number, number, number, number],
        label: `${sizeText} fits here`, fits: true,
      });
    }
    return answer(
      d,
      `Yes — ${sizeText} fits in ${room.name ?? room.kind}, clear of the furniture already there, with 50 mm to spare. I've marked one position that works; there ${fit.placements.length === 1 ? 'is 1' : `are ${fit.placements.length}`} in total.`,
      [res],
    );
  }
  return answer(
    d,
    `No — ${sizeText} does not fit in ${room.name ?? room.kind}: ${fit.reason ?? 'no clear position'}.`,
    [res],
  );
}

// --- visibility ------------------------------------------------------------

function handleVisibility(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  // "Can you see the television from the dining table": the thing looked at is
  // whichever slot the preposition does not govern, which in practice is the
  // first one. Where one slot is a room and one an object, the object is the
  // target and the room is the vantage point.
  const object = pickSlotExcept(i, 'room');
  const target = resolveSlot(d, object ?? i.subject);
  if (target === null) return null;
  if (!target.ok) return target.answer;

  const rest = slotsOf(i).find((s) => s !== (object ?? i.subject));
  const from = resolveSlot(d, rest);
  if (from !== null && !from.ok) return from.answer;
  const origin = from?.ok ? refPoint(from.ref) : d.tools.view.position;

  const res = d.tools.check_visibility(refId(target.ref), origin);
  if (!res.ok) return refusalAnswer(res.refusal, ['check_visibility']);
  const v = res.data;
  const where = from?.ok ? `from ${refLabel(from.ref)}` : 'from where you are standing';
  if (v.visible) {
    highlight(d, [refId(target.ref)]);
    return answer(d, `Yes — ${refLabel(target.ref)} is in clear line of sight ${where}.`, [res]);
  }
  const blocker = v.blockedByLabel ?? (v.blockedBy ? d.tools.labelOf(v.blockedBy) : undefined);
  return answer(
    d,
    blocker
      ? `No — ${refLabel(target.ref)} is not visible ${where}; the ${blocker} is in the way.`
      : `No — ${refLabel(target.ref)} is not visible ${where}.`,
    [res],
  );
}

// --- identify --------------------------------------------------------------

function handleIdentify(_i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const ray = d.tools.raycast();
  if (!ray.ok) return refusalAnswer(ray.refusal, ['raycast']);
  const hit = ray.data;
  if (!hit.hit) {
    return answer(d, 'Nothing is in front of the camera along that line.', [ray]);
  }
  if (hit.entityId) {
    const e = d.tools.world.entity(hit.entityId);
    if (e) {
      highlight(d, [e.id]);
      d.resolver.noteUserMention({ type: 'entity', entity: e });
      const prov = d.tools.get_provenance(e.id);
      const caveat = provenanceCaveat(e.grounding.provenance, e.grounding.confidence);
      return answer(
        d,
        `That is the ${e.label}, ${(hit.distanceM ?? 0).toFixed(2)} m ahead in ${d.tools.world.room(e.roomId ?? '')?.name ?? 'this room'}.${caveat ? ` Note: ${caveat}.` : ''}`,
        [ray, prov],
      );
    }
  }
  if (hit.surfaceId) {
    const s = d.tools.world.surface(hit.surfaceId);
    if (s) {
      const insp = d.tools.inspect_surface(s.id);
      const extras: string[] = [];
      if (s.isGlazed) extras.push('glazed');
      if (s.isReflective) extras.push('reflective, so the reconstruction behind it is unreliable');
      return answer(
        d,
        `That is a ${s.kind}${extras.length > 0 ? ` (${joinList(extras)})` : ''}, ${(hit.distanceM ?? 0).toFixed(2)} m ahead.`,
        [ray, insp],
      );
    }
  }
  return answer(d, `Something ${(hit.distanceM ?? 0).toFixed(2)} m ahead, but the capture does not identify it.`, [ray]);
}

// --- surface ---------------------------------------------------------------

function handleSurface(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  // A glazing question names a room and a window; the window is the subject.
  const named = pickSlot(i, 'opening') ?? pickSlot(i, 'surface') ?? i.subject;
  const slot = resolveSlot(d, named);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;
  const ref = slot.ref;

  if (ref.type === 'opening') {
    const o = ref.opening;
    const surface = o.surfaceId ? d.tools.world.surface(o.surfaceId) : undefined;
    const insp = surface ? d.tools.inspect_surface(surface.id) : d.tools.get_geometry(o.id);
    const dims = d.tools.get_dimensions(o.id);
    const sizeText = dims.ok
      ? `${dims.data.width.value.toFixed(2)} m by ${dims.data.height.value.toFixed(2)} m`
      : 'of a size the capture does not establish';
    // Glazing type is a material property. Reconstruction recovers geometry,
    // not whether a unit is double glazed, and asserting it would be exactly
    // the kind of plausible invention this system refuses to make.
    return answer(
      d,
      `The ${o.kind} is ${sizeText}. Whether it is double glazed is not something a capture can establish — that needs the survey or the EPC.`,
      [insp, dims],
    );
  }

  if (ref.type === 'surface') {
    const insp = d.tools.inspect_surface(ref.surface.id);
    if (!insp.ok) return refusalAnswer(insp.refusal, ['inspect_surface']);
    const s = insp.data;
    const bits: string[] = [];
    if (s.isGlazed) bits.push('glazed');
    if (s.isReflective) bits.push('reflective');
    if (s.areaM2) bits.push(`about ${s.areaM2.toFixed(1)} m²`);
    return answer(
      d,
      `That ${s.surface.kind} is ${bits.length > 0 ? joinList(bits) : 'plain'}. The capture records its shape and position, not what it is made of.`,
      [insp],
    );
  }
  return null;
}

// --- provenance ------------------------------------------------------------

function handleProvenance(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  // With no slot, the question is about the previous answer, whose subject is
  // the most salient thing in the conversation.
  const slot = resolveSlot(d, i.subject) ?? mostSalient(d);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;

  const res = d.tools.get_provenance(refId(slot.ref));
  if (!res.ok) return refusalAnswer(res.refusal, ['get_provenance']);
  const p = res.data;
  const name = refLabel(slot.ref);

  const how = p.provenance === 'observed'
    ? `a camera saw it directly (${plural(p.sources.length, 'frame')})`
    : p.provenance === 'reconstructed'
      ? `it was derived from the capture geometry${p.sources.length > 0 ? ` across ${plural(p.sources.length, 'frame')}` : ''}`
      : p.provenance === 'inferred'
        ? 'it was estimated from context rather than observed'
        : 'it was filled in by a model — nothing in the capture supports it';
  const contextNote = p.contextProvenance !== p.provenance && p.contextProvenance !== 'observed'
    ? ` The volume around it is ${p.contextProvenance} rather than directly observed.`
    : '';
  const regionNote = p.reasons.length > 0 ? ` ${capitalise(p.reasons[0]!)}.` : '';
  const confidence = `Confidence ${(p.confidence * 100).toFixed(0)}%.`;
  if (p.provenance === 'generated' || p.contextProvenance === 'generated' || !p.observed) {
    d.commands.push({
      kind: 'regionOverlay', id: d.nextCommandId(), intent: 'answer',
      regionIds: p.regionIds,
      provenance: p.provenance === 'generated' ? 'generated' : 'inferred',
      label: 'not observed',
    });
  }
  return answer(d, `${capitalise(name)}: ${how}. ${confidence}${contextNote}${regionNote}`, [res]);
}

function mostSalient(d: DeterministicDeps): SlotResult | null {
  const top = d.resolver.salience.all()[0];
  if (!top) return null;
  const hit = d.tools.lookup(top.id);
  if (hit === null || Array.isArray(hit)) return null;
  return { ok: true, ref: hit };
}

// --- navigate --------------------------------------------------------------

function handleNavigate(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const slot = resolveSlot(d, i.subject);
  if (slot === null) return null;
  if (!slot.ok) return slot.answer;
  const ref = slot.ref;

  const res = d.tools.move_camera(refId(ref));
  if (!res.ok) return refusalAnswer(res.refusal, ['move_camera']);
  pathCommand(d, res.data);
  if (ref.type === 'room') focusRoom(d, ref.room.id);
  if (ref.type === 'entity') highlight(d, [ref.entity.id]);

  const rooms = res.data.roomSequence
    .map((r) => d.tools.world.room(r)?.name ?? r);
  const via = rooms.length > 2 ? ` through ${joinList(rooms.slice(1, -1))}` : '';
  return answer(
    d,
    `Taking you to ${refLabel(ref)}${via} — ${formatShortLength(res.data.length)} from where you were.`,
    [res],
  );
}

// --- compare ---------------------------------------------------------------

function handleCompare(i: Intent, d: DeterministicDeps): AgentAnswer | null {
  const superlative = i.subject === undefined && i.object === undefined;
  if (superlative) {
    const res = d.tools.query_world();
    if (!res.ok) return refusalAnswer(res.refusal, ['query_world']);
    const sorted = [...res.data.rooms].sort((a, b) => b.areaM2 - a.areaM2);
    const biggest = sorted[0];
    if (!biggest) return null;
    focusRoom(d, biggest.id);
    areaCommand(d, biggest.id, d.tools.world.measureArea(biggest.id));
    return answer(
      d,
      `The largest room is ${biggest.name} at ${biggest.areaM2.toFixed(1)} m²; the smallest is ${sorted[sorted.length - 1]!.name} at ${sorted[sorted.length - 1]!.areaM2.toFixed(1)} m².`,
      [res],
    );
  }

  const a = resolveSlot(d, i.subject, { type: 'room' });
  const b = resolveSlot(d, i.object, { type: 'room' });
  if (a === null || b === null) return null;
  if (!a.ok) return a.answer;
  if (!b.ok) return b.answer;
  if (a.ref.type !== 'room' || b.ref.type !== 'room') return null;

  const qa = d.tools.measure_area(a.ref.room.id);
  const qb = d.tools.measure_area(b.ref.room.id);
  if (!qa.ok) return refusalAnswer(qa.refusal, ['measure_area']);
  if (!qb.ok) return refusalAnswer(qb.refusal, ['measure_area']);
  const soft = quantityRefusal(qa.data) ?? quantityRefusal(qb.data);
  if (soft) return answer(d, soft, [qa, qb]);

  areaCommand(d, a.ref.room.id, qa.data);
  areaCommand(d, b.ref.room.id, qb.data);
  const nameA = a.ref.room.name ?? a.ref.room.kind;
  const nameB = b.ref.room.name ?? b.ref.room.kind;
  const diff = qa.data.value - qb.data.value;
  // A difference inside the combined tolerance is not a difference, and saying
  // one room is bigger on the strength of 0.2 m² would be a fabrication
  // dressed up as arithmetic.
  const combinedTolM2 = (qa.data.value * qa.data.tolerance + qb.data.value * qb.data.tolerance) / 100;
  if (Math.abs(diff) <= combinedTolM2) {
    return answer(
      d,
      `${capitalise(nameA)} (${qa.data.value.toFixed(1)} m²) and ${nameB} (${qb.data.value.toFixed(1)} m²) are the same size within the measurement tolerance of ±${combinedTolM2.toFixed(1)} m².`,
      [qa, qb],
    );
  }
  const bigger = diff > 0 ? nameA : nameB;
  const smaller = diff > 0 ? nameB : nameA;
  return answer(
    d,
    `${capitalise(bigger)} is the larger by ${Math.abs(diff).toFixed(1)} m² — ${qa.data.value.toFixed(1)} m² against ${qb.data.value.toFixed(1)} m² for ${smaller}.`,
    [qa, qb],
  );
}
