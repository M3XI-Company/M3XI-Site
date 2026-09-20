/**
 * Reference resolution.
 *
 * "How far is that from the window?" is the question this product lives or
 * dies on, and it has no answer in a transcript. It has an answer in a place:
 * someone standing in the kitchen, facing the sofa, having just asked about
 * the sofa. So references resolve against a model of what is salient right
 * now, not against a prompt containing the last ten messages.
 *
 * Why not just stuff history into the prompt:
 *
 *   - It costs money on every turn, and conversation cost is the thing that
 *     breaks this product's economics at viewer scale.
 *   - It is not checkable. A model that picks the wrong "that" produces a
 *     fluent, wrong, ungrounded answer and nothing in the system notices. A
 *     resolver returns a candidate list with scores, so a weak best candidate
 *     becomes a clarifying question instead of a confident mistake.
 *   - It throws away the spatial half. Gaze direction, the current room and
 *     the current selection are stronger evidence than word order, and they
 *     cannot be expressed in a transcript at all.
 *
 * The model: every mention deposits salience, salience decays geometrically
 * per turn, and the live viewer state contributes salience of its own that
 * does not decay because it is not a memory, it is a fact about now.
 */

import { math } from '@m3xi/spatial-engine';

import type { Tools, WorldRef } from './tools.js';
import { refId, refLabel, refPoint } from './tools.js';

// ---------------------------------------------------------------------------
// Salience
// ---------------------------------------------------------------------------

/**
 * Multiplier applied per elapsed turn. 0.55 means a thing mentioned three
 * turns ago is worth about a sixth of one mentioned now, so a topic survives
 * two or three turns of follow-ups -- which is how long real property
 * conversations stay on one object -- and then gets out of the way.
 */
export const SALIENCE_DECAY_PER_TURN = 0.55;

/** Below this a mention is dropped entirely rather than kept as noise. */
export const SALIENCE_FLOOR = 0.02;

/** How many mentions to keep. Bounded because this lives in a session row. */
export const MAX_MENTIONS = 32;

export type MentionRole =
  /** The user named it. */
  | 'user'
  /** The answer was about it. */
  | 'answer'
  /** A tool consulted it on the way to an answer. */
  | 'consulted';

export const ROLE_WEIGHT: Readonly<Record<MentionRole, number>> = {
  user: 1.0,
  answer: 0.85,
  consulted: 0.3,
};

export interface Mention {
  readonly id: string;
  readonly type: WorldRef['type'];
  readonly label: string;
  readonly role: MentionRole;
  /** Turn index at which it was mentioned. */
  readonly turn: number;
}

/** Live, non-decaying evidence from the viewer, blended with the memory. */
export const LIVE_WEIGHT = {
  /** The user clicked it. Nothing beats this. */
  selection: 1.6,
  /** In frame and unoccluded. */
  visible: 0.45,
  /** In the room the camera is standing in. */
  sameRoom: 0.3,
  /** Within about 12 degrees of the gaze axis. */
  gaze: 0.55,
  /**
   * Another slot in the same question resolved to something in this room.
   *
   * "How far is that from the desk" asked while standing in the kitchen means
   * the bookshelf next to the desk, not the window in front of you. A distance
   * question almost always relates two things in one place, and that is a
   * spatial fact the resolver can use rather than a guess about word order.
   */
  coArgumentRoom: 0.9,
} as const;

/**
 * How much the live-view signals are worth for a candidate OUTSIDE the room
 * the question's other argument named.
 *
 * Discounting rather than only boosting is what makes the co-argument
 * decisive. Boosting alone leaves "the window I happen to be staring at"
 * competitive with "the bookshelf I just asked about that sits beside the desk
 * I am asking about now", and it should not be: the other argument says which
 * part of the property is under discussion, and ambient gaze does not override
 * that. Memory is deliberately not discounted -- a thing the conversation
 * established stays established wherever it is.
 */
export const OFF_CONTEXT_LIVE_FACTOR = 0.35;

export interface Candidate {
  readonly ref: WorldRef;
  /** Evidence only. Proximity is deliberately excluded -- see `rank`. */
  readonly score: number;
  /** Metres from the camera, used to order equals, never to choose. */
  readonly distanceM: number;
  readonly why: readonly string[];
}

export class SalienceModel {
  private mentions: Mention[] = [];
  private turn = 0;

  /** Advance the clock. Called once per user turn, before resolution. */
  beginTurn(): number {
    this.turn += 1;
    this.mentions = this.mentions.filter((m) => this.scoreOf(m) >= SALIENCE_FLOOR);
    return this.turn;
  }

  get currentTurn(): number {
    return this.turn;
  }

  note(id: string, type: WorldRef['type'], label: string, role: MentionRole): void {
    // A re-mention replaces the old record rather than stacking: salience is
    // about recency, and two mentions of the sofa do not make it twice as
    // present as the thing the user just clicked.
    //
    // Within ONE turn, though, the strongest role wins. An answer's citation
    // list contains the thing the question was about, so a naive replace would
    // let a 'consulted' note (0.3) overwrite the 'user' note (1.0) deposited
    // moments earlier and quietly forget what the turn was about.
    const existing = this.mentions.find((m) => m.id === id);
    if (existing && existing.turn === this.turn && ROLE_WEIGHT[existing.role] >= ROLE_WEIGHT[role]) {
      return;
    }
    this.mentions = this.mentions.filter((m) => m.id !== id);
    this.mentions.push({ id, type, label, role, turn: this.turn });
    if (this.mentions.length > MAX_MENTIONS) {
      this.mentions = this.mentions
        .slice()
        .sort((a, b) => this.scoreOf(b) - this.scoreOf(a))
        .slice(0, MAX_MENTIONS);
    }
  }

  scoreOf(m: Mention): number {
    const age = Math.max(0, this.turn - m.turn);
    return ROLE_WEIGHT[m.role] * Math.pow(SALIENCE_DECAY_PER_TURN, age);
  }

  scoreFor(id: string): number {
    let best = 0;
    for (const m of this.mentions) {
      if (m.id !== id) continue;
      const s = this.scoreOf(m);
      if (s > best) best = s;
    }
    return best;
  }

  all(): readonly Mention[] {
    return this.mentions.slice().sort((a, b) => this.scoreOf(b) - this.scoreOf(a));
  }

  /** Serialisable, so a session survives an edge function's cold start. */
  toJSON(): { turn: number; mentions: Mention[] } {
    return { turn: this.turn, mentions: this.mentions.slice() };
  }

  static fromJSON(raw: unknown): SalienceModel {
    const m = new SalienceModel();
    if (typeof raw !== 'object' || raw === null) return m;
    const src = raw as { turn?: unknown; mentions?: unknown };
    m.turn = typeof src.turn === 'number' && Number.isFinite(src.turn)
      ? Math.max(0, Math.floor(src.turn)) : 0;
    if (Array.isArray(src.mentions)) {
      for (const raw2 of src.mentions.slice(0, MAX_MENTIONS)) {
        if (typeof raw2 !== 'object' || raw2 === null) continue;
        const e = raw2 as Record<string, unknown>;
        if (typeof e['id'] !== 'string' || typeof e['label'] !== 'string') continue;
        const role = e['role'];
        if (role !== 'user' && role !== 'answer' && role !== 'consulted') continue;
        const type = e['type'];
        if (type !== 'entity' && type !== 'room' && type !== 'surface' && type !== 'opening') continue;
        m.mentions.push({
          id: e['id'], type, label: e['label'], role,
          turn: typeof e['turn'] === 'number' ? e['turn'] : 0,
        });
      }
    }
    return m;
  }
}

// ---------------------------------------------------------------------------
// Pronouns and deixis
// ---------------------------------------------------------------------------

/** Words that refer without naming. Ordered longest-first when matched. */
const PRONOUN_ANY = new Set([
  'it', 'that', 'this', 'that one', 'this one', 'the same', 'the other one',
]);
const PRONOUN_PLACE = new Set([
  'there', 'here', 'that room', 'this room', 'the room', 'in there', 'in here',
]);
const PRONOUN_PLURAL = new Set(['them', 'those', 'these', 'both']);

export type PronounClass = 'any' | 'place' | 'plural' | null;

export function pronounClass(phrase: string): PronounClass {
  const p = phrase.trim().toLowerCase().replace(/[?.!,]+$/, '');
  if (PRONOUN_PLACE.has(p)) return 'place';
  if (PRONOUN_PLURAL.has(p)) return 'plural';
  if (PRONOUN_ANY.has(p)) return 'any';
  return null;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** Restrict to a kind: "what about the door" should not return a sofa. */
  readonly type?: WorldRef['type'];
  /** Score gap below which two candidates count as genuinely ambiguous. */
  readonly ambiguityMargin?: number;
  /**
   * The room another slot in this same question resolved to. Set by a handler
   * that resolves its unambiguous slot first and then uses it as context.
   */
  readonly contextRoomId?: string;
  /**
   * Things already spoken for by another slot. "How far is that from the desk"
   * cannot mean the desk from the desk, and without this the co-argument boost
   * makes the desk the single best candidate for "that".
   */
  readonly excludeIds?: readonly string[];
}

export type Resolution =
  | { readonly ok: true; readonly ref: WorldRef; readonly score: number; readonly why: readonly string[] }
  | { readonly ok: false; readonly reason: 'none'; readonly phrase: string }
  | { readonly ok: false; readonly reason: 'ambiguous'; readonly phrase: string; readonly candidates: readonly Candidate[] };

/** Default gap. Two candidates within 15% of each other are a real ambiguity. */
const AMBIGUITY_MARGIN = 0.15;

export class ReferenceResolver {
  private readonly tools: Tools;
  readonly salience: SalienceModel;

  constructor(tools: Tools, salience: SalienceModel) {
    this.tools = tools;
    this.salience = salience;
  }

  /**
   * Resolve a noun phrase. A pronoun goes to the salience model plus live
   * viewer evidence; a name goes to the world, scoped by the current room so
   * "the window" in the bathroom is the bathroom's window.
   */
  resolve(phrase: string, opts: ResolveOptions = {}): Resolution {
    const cleaned = normalisePhrase(phrase);
    if (cleaned.length === 0) return { ok: false, reason: 'none', phrase };

    const pron = pronounClass(cleaned);
    if (pron !== null) return this.resolvePronoun(cleaned, pron, opts);

    // A name still goes through scoring, because a name can be ambiguous too:
    // "the bed" in a two-bedroom flat is two beds, and which one the user
    // means is a salience question, not a lexical one.
    const scoped = this.tools.view.roomId ?? this.tools.world.roomAt(this.tools.view.position)?.id;
    const hit = this.tools.lookup(cleaned, scoped ? { roomId: scoped } : undefined);
    if (hit === null) {
      const wide = this.tools.lookup(cleaned);
      if (wide === null) return { ok: false, reason: 'none', phrase };
      return this.rank(Array.isArray(wide) ? wide : [wide], cleaned, opts);
    }
    return this.rank(Array.isArray(hit) ? hit : [hit], cleaned, opts);
  }

  private resolvePronoun(phrase: string, cls: Exclude<PronounClass, null>, opts: ResolveOptions): Resolution {
    const wantType: WorldRef['type'] | undefined = cls === 'place' ? 'room' : opts.type;
    const pool = new Map<string, WorldRef>();

    const add = (id: string): void => {
      if (pool.has(id)) return;
      const hit = this.tools.lookup(id);
      if (hit === null || Array.isArray(hit)) return;
      if (wantType && hit.type !== wantType) return;
      pool.set(id, hit);
    };

    for (const m of this.salience.all()) add(m.id);
    if (this.tools.view.selectedEntityId) add(this.tools.view.selectedEntityId);
    const here = this.tools.world.roomAt(this.tools.view.position);
    if (here) add(here.id);
    // Visible things are candidates even if never mentioned: "what is that"
    // while looking at a bookshelf nobody has named yet must still work.
    const vis = this.tools.world.visibleFrom({
      position: this.tools.view.position,
      orientation: this.tools.view.orientation,
      fov: this.tools.view.fovRad,
    }, { maxDistance: 12 });
    for (const e of vis.entities) add(e.id);
    for (const o of vis.openings) add(o.id);

    if (pool.size === 0) return { ok: false, reason: 'none', phrase };
    return this.rank([...pool.values()], phrase, { ...opts, ...(wantType ? { type: wantType } : {}) });
  }

  /** Score a candidate set against memory and the live pose. */
  rank(refs: readonly WorldRef[], phrase: string, opts: ResolveOptions = {}): Resolution {
    const excluded = new Set(opts.excludeIds ?? []);
    const filtered = refs.filter((r) => (!opts.type || r.type === opts.type) && !excluded.has(refId(r)));
    if (filtered.length === 0) return { ok: false, reason: 'none', phrase };

    const view = this.tools.view;
    const here = this.tools.world.roomAt(view.position);
    const forward = math.forwardOf(view.orientation);
    const visibleIds = new Set<string>();
    if (filtered.length > 1) {
      const vis = this.tools.world.visibleFrom(
        { position: view.position, orientation: view.orientation, fov: view.fovRad },
        { maxDistance: 20 },
      );
      for (const e of vis.entities) visibleIds.add(e.id);
      for (const o of vis.openings) visibleIds.add(o.id);
      for (const r of vis.rooms) visibleIds.add(r.id);
    }

    const scored: Candidate[] = filtered.map((ref) => {
      const id = refId(ref);
      const why: string[] = [];
      let distanceM = Infinity;

      // Two buckets, kept apart on purpose. `memory` is what the conversation
      // established; `live` is what is true of the viewer right now. They are
      // weighed differently when the question itself names a place.
      let memory = 0;
      let live = 0;

      const mem = this.salience.scoreFor(id);
      if (mem > 0) { memory += mem; why.push(`mentioned recently (${mem.toFixed(2)})`); }

      if (view.selectedEntityId === id) {
        live += LIVE_WEIGHT.selection;
        why.push('currently selected');
      }
      if (visibleIds.has(id)) { live += LIVE_WEIGHT.visible; why.push('in view'); }

      const roomOf = ref.type === 'entity' ? ref.entity.roomId
        : ref.type === 'room' ? ref.room.id
          : ref.type === 'opening' ? ref.opening.roomA
            : ref.surface.roomId;
      if (here && roomOf === here.id) { live += LIVE_WEIGHT.sameRoom; why.push('in this room'); }

      // Gaze alignment, falling off with the cosine so a thing dead ahead wins
      // over a thing at the edge of the frame without a hard cut-off.
      const p = refPoint(ref);
      const d = math.sub(p, view.position);
      const len = math.length(d);
      if (len > 1e-3) {
        distanceM = len;
        const cos = math.dot(d, forward) / len;
        if (cos > 0.85) {
          live += LIVE_WEIGHT.gaze * (cos - 0.85) / 0.15;
          why.push('close to where the camera is pointing');
        }
      } else {
        distanceM = 0;
      }

      let score = memory + live;
      if (opts.contextRoomId) {
        if (roomOf === opts.contextRoomId) {
          score = memory + live + LIVE_WEIGHT.coArgumentRoom;
          why.push('in the same room as the other thing in the question');
        } else {
          score = memory + live * OFF_CONTEXT_LIVE_FACTOR;
          why.push('not in the room the question is about');
        }
      }
      return { ref, score, distanceM, why };
    });

    // Order by evidence, then by proximity. Proximity is NOT added to the
    // score: letting "slightly nearer" outvote "no evidence at all" is how a
    // resolver ends up confidently picking one of two identical beds because
    // one happens to be 40 cm closer. Nearness breaks ties; it never makes
    // the decision, and it never suppresses an ambiguity.
    scored.sort((a, b) => b.score - a.score
      || a.distanceM - b.distanceM
      || refId(a.ref).localeCompare(refId(b.ref)));
    const best = scored[0]!;
    const second = scored[1];
    const margin = opts.ambiguityMargin ?? AMBIGUITY_MARGIN;

    if (best.score <= 1e-9) {
      // Nothing is salient, nothing is visible, nothing is in this room. With
      // exactly one candidate that is still a clean answer; with several it is
      // a question for the user, not a coin toss.
      if (scored.length === 1) {
        return { ok: true, ref: best.ref, score: 0, why: ['only candidate'] };
      }
      return { ok: false, reason: 'ambiguous', phrase, candidates: scored.slice(0, 5) };
    }
    if (second && best.score - second.score < margin * best.score) {
      return { ok: false, reason: 'ambiguous', phrase, candidates: scored.slice(0, 5) };
    }
    return { ok: true, ref: best.ref, score: best.score, why: best.why };
  }

  /** Record everything an answer touched, so the next turn can say "that". */
  noteAnswer(subject: WorldRef | undefined, consulted: readonly string[]): void {
    if (subject) this.salience.note(refId(subject), subject.type, refLabel(subject), 'answer');
    for (const id of consulted) {
      // The subject is always among the citations; re-noting it as merely
      // consulted is what the same-turn guard in note() exists to stop, and
      // skipping it here keeps the intent explicit.
      if (subject && id === refId(subject)) continue;
      const hit = this.tools.lookup(id);
      if (hit === null || Array.isArray(hit)) continue;
      this.salience.note(id, hit.type, refLabel(hit), 'consulted');
    }
  }

  noteUserMention(ref: WorldRef): void {
    this.salience.note(refId(ref), ref.type, refLabel(ref), 'user');
  }
}

// ---------------------------------------------------------------------------

const ARTICLES = /^(the|a|an|my|our|your|its)\s+/i;
const FILLER = /\b(please|just|actually|exactly|roughly|about)\b/gi;

export function normalisePhrase(p: string): string {
  let s = String(p ?? '').toLowerCase().trim();
  s = s.replace(FILLER, ' ').replace(/[?!.,;:]+$/g, '').replace(/\s+/g, ' ').trim();
  // Only one article is stripped: "the other one" keeps its shape, and
  // stripping repeatedly would turn "a the" into nonsense nobody typed.
  s = s.replace(ARTICLES, '').trim();
  return s;
}
