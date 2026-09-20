/**
 * Deterministic question understanding.
 *
 * This file is the economics of the product. Research on this system's own
 * cost model puts LLM conversation at roughly 66% of infrastructure cost at
 * 1,000 properties a month and 74% at 10,000, because conversation scales with
 * *viewers* and reconstruction scales with *customers*. A single popular
 * listing with an unmetered chat outruns the margin on the whole account.
 *
 * So the router's Tier 0 is not an optimisation, it is the architecture: a
 * question that the spatial engine can answer exactly must never reach a
 * model. That requires understanding the question without one, which is what
 * this file does -- lexical, ordered, and boring on purpose.
 *
 * The parse is deliberately conservative. A question it is not sure about gets
 * a low confidence and is routed upward to a model, which is the correct
 * failure direction: paying a fraction of a penny is better than answering the
 * wrong question for free.
 */

import type { Vec3 } from '@m3xi/world-core';

import type { WorldRef } from './tools.js';
import { normalisePhrase } from './resolver.js';

export type IntentKind =
  | 'world_summary'      // how many bedrooms, how big is the flat
  | 'area'               // how big is the kitchen
  | 'dimensions'         // how wide, how tall, what are the dimensions
  | 'distance'           // how far is X from Y
  | 'count'              // how many chairs
  | 'contents'           // what is in the kitchen
  | 'exists'             // does the kitchen have an oven
  | 'locate'             // where is the sofa
  | 'connectivity'       // does the kitchen open onto the hall, route from A to B
  | 'fit'                // will a 2.1 m sofa fit
  | 'visibility'         // can you see the garden from the kitchen
  | 'identify'           // what is that
  | 'surface'            // is that window double glazed, what is the wall made of
  | 'provenance'         // how do you know, was that measured
  | 'navigate'           // show me the second bedroom
  | 'compare'            // which bedroom is bigger
  | 'unknown';

export interface SlotMatch {
  /** The phrase as it appeared in the question. */
  readonly phrase: string;
  /** Resolved immediately when the phrase names exactly one thing. */
  readonly ref?: WorldRef;
  readonly start: number;
  readonly end: number;
}

export interface Intent {
  readonly kind: IntentKind;
  readonly subject?: SlotMatch;
  readonly object?: SlotMatch;
  /** For fit questions: the box the user described, in metres. */
  readonly sizeM?: Vec3;
  /** For count/contents questions: 'furniture' | 'appliance' | ... */
  readonly category?: string;
  /** For dimension questions: which axis the user asked about. */
  readonly axis?: 'width' | 'depth' | 'height' | 'all';
  /**
   * 0..1. Above ROUTE_CONFIDENCE the router will answer deterministically;
   * below it, a model gets involved.
   */
  readonly confidence: number;
  /** True when the question only makes sense against the previous one. */
  readonly followUp: boolean;
  /** Phrases that looked like references but resolved to nothing. */
  readonly unresolved: readonly string[];
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export interface VocabEntry {
  readonly phrase: string;
  readonly ref: WorldRef;
}

/**
 * Every name the world answers to, longest first so "dining table" wins over
 * "table" and "bedroom 2" wins over "bedroom".
 */
export function buildVocabulary(refs: readonly WorldRef[]): VocabEntry[] {
  const out: VocabEntry[] = [];
  const push = (phrase: string | undefined, ref: WorldRef): void => {
    const p = (phrase ?? '').trim().toLowerCase();
    if (p.length < 2) return;
    out.push({ phrase: p, ref });
  };
  for (const ref of refs) {
    switch (ref.type) {
      case 'room':
        push(ref.room.name, ref);
        push(ref.room.stableKey.replace(/-/g, ' '), ref);
        // A room's kind is a name only when it is the only room of that kind;
        // the caller filters that, because "bedroom" in a two-bed flat is an
        // ambiguity the resolver should surface, not a synonym.
        push(ref.room.kind, ref);
        break;
      case 'entity':
        push(ref.entity.label, ref);
        push(ref.entity.stableKey.replace(/_/g, ' '), ref);
        break;
      case 'opening':
        push(ref.opening.kind, ref);
        break;
      case 'surface':
        break;
    }
  }
  out.sort((a, b) => b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));
  return out;
}

/** Deixis is matched like vocabulary so slot order survives. */
const DEICTIC = [
  'that one', 'this one', 'the other one', 'that room', 'this room',
  'there', 'here', 'that', 'this', 'it', 'them', 'those', 'these', 'both',
];

/**
 * English uses "it" and "there" as grammatical filler that refers to nothing:
 * "how far is IT from the door to the hall", "how many chairs are THERE".
 * Treating those as references sends the resolver hunting for an antecedent
 * that does not exist and produces a spurious ambiguity, so they are struck
 * out before slot matching rather than resolved and discarded afterwards.
 */
const EXPLETIVE = /\b(is|was|are|were)\s+(it|there)\b/g;

function maskExpletives(text: string): string {
  // Blanked with spaces rather than deleted so every character index the
  // caller reports still points at the original question.
  return text.replace(EXPLETIVE, (match, verb: string) => {
    const keep = match.slice(0, verb.length);
    return keep + ' '.repeat(match.length - keep.length);
  });
}

// ---------------------------------------------------------------------------
// Unknown nouns
//
// "Where is the boiler?" is a question this system understands perfectly and
// cannot answer, which is a very different thing from a question it failed to
// parse. Pulling the head noun out of the common frames lets the deterministic
// tier return "there is no boiler in this capture" -- grounded, correct, free
// -- instead of paying a model to discover the same absence.
// ---------------------------------------------------------------------------

const NOUN_FRAMES: readonly RegExp[] = [
  /\bwhere(?:'s| is| are)\s+(?:the\s+|a\s+|an\s+|any\s+)?([a-z][a-z ]{2,28}?)\s*[?.!]?$/,
  /\bwhich room (?:is|are)\s+(?:the\s+)?([a-z][a-z ]{2,28}?)\s+in\b/,
  /\bhow many\s+([a-z][a-z ]{2,28}?)\s*(?:are there|are|is there|is|does|do|in|\?|$)/,
  /\b(?:is|are) there (?:a |an |any )?([a-z][a-z ]{2,28}?)\s*(?:in|\?|$)/,
  /\b(?:does|do) .{0,30}?\bhave (?:a |an |any )?([a-z][a-z ]{2,28}?)\s*[?.!]?$/,
];

function extractNoun(q: string): string | null {
  for (const re of NOUN_FRAMES) {
    const m = re.exec(q);
    const raw = m?.[1]?.trim();
    if (!raw) continue;
    // Strip a trailing plural so it matches singular world labels.
    const singular = /ies$/.test(raw) ? `${raw.slice(0, -3)}y`
      : /(ches|shes|xes|ses)$/.test(raw) ? raw.slice(0, -2)
        : /[^s]s$/.test(raw) ? raw.slice(0, -1) : raw;
    if (STOP_NOUNS.has(singular)) continue;
    return singular;
  }
  return null;
}

/** Words the frames can capture that are never a thing in a property. */
const STOP_NOUNS = new Set([
  'it', 'that', 'this', 'there', 'here', 'them', 'those', 'these',
  'room', 'rooms', 'thing', 'things', 'one', 'ones',
]);

// ---------------------------------------------------------------------------
// Lexicon
//
// Ordered from most specific to least. English overlaps -- "how far is the
// sofa from the window" also contains "the window", and "how big" also
// contains "how" -- so each pattern is only reached after every pattern that
// could shadow it. Reordering these changes which questions are free.
// ---------------------------------------------------------------------------

const RE = {
  howMany: /\bhow many\b/,
  howFar: /\bhow (far|close)\b|\bdistance\b|\bhow much space\b/,
  howBig: /\bhow (big|large)\b|\bfloor area\b|\bsquare (metres|meters|feet|foot|ft|m2)\b|\bsq ?(m|ft)\b|\bwhat ?'?s? the area\b|\barea of\b/,
  dimensions: /\bdimensions?\b|\bhow (wide|deep|long|tall|high)\b|\bwidth\b|\bheight\b|\bceiling height\b|\bhow much headroom\b|\bwhat size\b/,
  where: /\bwhere\b|\bwhich room\b|\bwhat room\b/,
  whatsIn: /\bwhat(?:'s| is| are)?\b[^?]*\b(in|inside|contains?|got|furniture|appliances?)\b/,
  fit: /\b(fit|fits|room for|space for|go in|squeeze)\b/,
  visible: /\b(can (you|i|we) see|visible|see the|line of sight|overlook)\b/,
  connect: /\b(connect|connects|lead|leads|open onto|opens onto|adjoin|next to|adjacent|get (from|to)|route|walk from|how do i get)\b/,
  identify: /\bwhat (is|are) (that|this|those|these|i looking at)\b|\bwhat am i looking at\b/,
  provenance: /\b(how do you know|is that (measured|estimated|guessed)|provenance|how (accurate|reliable|confident)|did (you|a camera) (see|scan))\b|\bwas\b[^?]{0,45}\b(measured|scanned|observed|estimated|guessed)\b/,
  navigate: /\b(show me|take me|go to|fly (me )?to|walk me|bring me|navigate)\b/,
  compare: /\b(bigger|larger|smaller|biggest|largest|smallest|compare)\b/,
  surface: /\b(glazed|double glaz|glass|mirror|reflective|window pane|wall made|surface|material|skylight)\b/,
  summary: /\b(how many (bed|bath|room)|total (area|size)|overall size|how big is (the|this) (flat|property|place|house|apartment)|square footage|tell me about)\b/,
  // "Does the kitchen have an oven", "is there a dishwasher": a yes/no about
  // presence. Anchored at the start so it cannot swallow "how far is there".
  exists: /^(does|do|has|have|is there|are there)\b/,
} as const;

/**
 * "How big is the bed" is a dimensions question, not an area one: furniture
 * has no floor area worth quoting. Tested before the area branch so the
 * wording does not decide the answer's shape.
 */
const OBJECT_SIZE = /\bhow (big|large) (is|are) (the |a |an |my )?(bed|sofa|settee|table|desk|wardrobe|bath|shower|window|door|fridge|oven|cupboard|unit|chair|bookshelf|television|tv)\b/;

const AXIS_WORDS: ReadonlyArray<readonly [RegExp, 'width' | 'depth' | 'height']> = [
  [/\bhow (tall|high)\b|\bheight\b|\bceiling height\b|\bheadroom\b/, 'height'],
  [/\bhow wide\b|\bwidth\b/, 'width'],
  [/\bhow (deep|long)\b|\bdepth\b|\blength\b/, 'depth'],
];

const CATEGORY_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfurniture\b/, 'furniture'],
  [/\bappliances?\b/, 'appliance'],
  [/\bfixtures?\b/, 'fixture'],
  [/\bfittings?\b/, 'fitting'],
];

/** Below this the router escalates rather than answering. */
export const ROUTE_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Size parsing, for fit questions
// ---------------------------------------------------------------------------

const UNIT_TO_M: Readonly<Record<string, number>> = {
  m: 1, metre: 1, metres: 1, meter: 1, meters: 1,
  cm: 0.01, centimetre: 0.01, centimetres: 0.01,
  mm: 0.001,
  ft: 0.3048, foot: 0.3048, feet: 0.3048,
  in: 0.0254, inch: 0.0254, inches: 0.0254, '"': 0.0254, "'": 0.3048,
};

/**
 * "2.1m x 0.9m", "210 by 90 cm", "6ft by 3ft". A unit stated on either number
 * applies to both, which is how people actually write it.
 */
export function parseSize(q: string): Vec3 | null {
  const text = q.toLowerCase();
  const U = '(m|cm|mm|ft|in|metres?|meters?|centimetres?|feet|foot|inch(?:es)?|"|\')?';
  const N = '(\\d+(?:\\.\\d+)?)';
  const re = new RegExp(`${N}\\s*${U}\\s*(?:x|by|\\*)\\s*${N}\\s*${U}(?:\\s*(?:x|by|\\*)\\s*${N}\\s*${U})?`);
  const m = re.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const c = m[5] === undefined ? undefined : Number(m[5]);
  const f = (u: string | undefined): number => (u ? UNIT_TO_M[u] ?? 1 : 1);
  const unitA = m[2] ?? m[4] ?? m[6];
  const unitB = m[4] ?? m[2] ?? m[6];
  const unitC = m[6] ?? m[4] ?? m[2];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const w = a * f(unitA);
  const d = b * f(unitB);
  if (c !== undefined && Number.isFinite(c)) {
    // Three numbers read as width x depth x height, in that order.
    return [w, c * f(unitC), d];
  }
  // Two numbers describe a footprint. Height defaults to a domestic 0.9 m --
  // a sofa back, a bed, a table -- so the fit test still checks headroom
  // rather than silently assuming the object is flat.
  return [w, 0.9, d];
}

// ---------------------------------------------------------------------------
// Slot extraction
// ---------------------------------------------------------------------------

function findSlots(q: string, vocab: readonly VocabEntry[]): SlotMatch[] {
  const text = maskExpletives(q.toLowerCase());
  const taken: boolean[] = new Array(text.length).fill(false);
  const found: SlotMatch[] = [];

  const consider = (phrase: string, ref?: WorldRef): void => {
    let from = 0;
    for (;;) {
      const i = text.indexOf(phrase, from);
      if (i < 0) return;
      // A world label is stored singular ("dining chair") and asked plural
      // ("how many dining chairs"), so the match is allowed to swallow a
      // trailing plural suffix. Without this every count question misses.
      let end = i + phrase.length;
      for (const suffix of ['es', 's']) {
        if (text.startsWith(suffix, end)
          && (end + suffix.length >= text.length || !/[a-z0-9]/.test(text[end + suffix.length]!))) {
          end += suffix.length;
          break;
        }
      }
      const beforeOk = i === 0 || !/[a-z0-9]/.test(text[i - 1]!);
      const afterOk = end >= text.length || !/[a-z0-9]/.test(text[end]!);
      let free = beforeOk && afterOk;
      if (free) for (let k = i; k < end; k++) if (taken[k]) { free = false; break; }
      if (free) {
        for (let k = i; k < end; k++) taken[k] = true;
        found.push(ref
          ? { phrase, ref, start: i, end }
          : { phrase, start: i, end });
        return;
      }
      from = i + 1;
    }
  };

  // World names first (longest already), then deixis in the gaps.
  for (const v of vocab) consider(v.phrase, v.ref);
  for (const d of DEICTIC) consider(d);

  found.sort((a, b) => a.start - b.start);
  return found;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyOpts {
  readonly vocab: readonly VocabEntry[];
  /** The previous turn's intent, for follow-up inheritance. */
  readonly previous?: Intent | undefined;
  /**
   * Whether the camera is standing in an identified room right now.
   *
   * This is genuinely part of understanding the question: "how tall are the
   * ceilings" has an unambiguous subject when the viewer is inside a room and
   * none at all when it is not, so the parse confidence differs. Passing the
   * fact in beats having the handler guess and the router mis-price it.
   */
  readonly hasCurrentRoom?: boolean;
}

/**
 * Turn a question into an intent plus slots.
 *
 * Order matters and is not arbitrary. The most specific patterns are tested
 * first because English overlaps: "how far is the sofa from the window" also
 * contains "the window", and "how big" also matches "how". Each branch below
 * is tried only after every branch that could shadow it.
 */
export function classify(question: string, opts: ClassifyOpts): Intent {
  const raw = String(question ?? '');
  const q = raw.toLowerCase().trim();
  if (q.length === 0) {
    return { kind: 'unknown', confidence: 0, followUp: false, unresolved: [] };
  }

  const slots = findSlots(q, opts.vocab);
  const unresolved: string[] = [];
  const size = parseSize(q);

  const axis: Intent['axis'] = (() => {
    for (const [re, a] of AXIS_WORDS) if (re.test(q)) return a;
    return undefined;
  })();
  const category = (() => {
    for (const [re, c] of CATEGORY_WORDS) if (re.test(q)) return c;
    return undefined;
  })();

  const s0 = slots[0];
  const s1 = slots[1];
  /**
   * A subjectless measurement question is complete when the viewer is inside a
   * room -- it means "this room". Without one it is genuinely underspecified.
   */
  const implicitSubject = opts.hasCurrentRoom === true;
  const withImplicit = (whenNamed: number, whenImplicit: number, whenNeither: number): number =>
    (slots.length > 0 ? whenNamed : implicitSubject ? whenImplicit : whenNeither);

  const make = (
    kind: IntentKind, confidence: number,
    over: Partial<Intent> = {},
  ): Intent => ({
    kind,
    confidence,
    followUp: false,
    unresolved,
    ...(s0 ? { subject: s0 } : {}),
    ...(s1 ? { object: s1 } : {}),
    ...(size ? { sizeM: size } : {}),
    ...(category ? { category } : {}),
    ...(axis ? { axis } : {}),
    ...over,
  });

  // --- Follow-up with no verb of its own: "what about the door?" ------------
  // These mean "redo the last operation with this instead". Detected before
  // anything else because the surface form is too thin to match any content
  // pattern -- but the test has to be tight, or an ordinary short question
  // like "what is in here?" gets swallowed and answered as the wrong
  // operation entirely.
  if (opts.previous && slots.length > 0 && isFollowUpShape(q, slots)) {
    const prev = opts.previous;
    // Replace the slot the new phrase is most plausibly filling. When the
    // previous intent had two slots the new phrase replaces the object,
    // because "how far is the sofa from the window / what about the door"
    // keeps the sofa and swaps the window.
    const inherited: Intent = prev.object
      ? { ...prev, object: s0!, confidence: Math.min(0.9, prev.confidence), followUp: true, unresolved }
      : { ...prev, subject: s0!, confidence: Math.min(0.9, prev.confidence), followUp: true, unresolved };
    return inherited;
  }

  // --- Provenance: asked about the answer, not about the property ----------
  if (RE.provenance.test(q)) return make('provenance', 0.9);

  // --- Navigation, which is an instruction rather than a question ----------
  if (RE.navigate.test(q)) return make('navigate', 0.92);

  // --- Fit: distinctive, and the size parse confirms it --------------------
  if (RE.fit.test(q)) {
    // Without a size the question is "will my sofa fit", which needs a sofa we
    // do not have. That is a genuine escalation, not a deterministic answer.
    return make('fit', size ? 0.9 : 0.35);
  }

  // --- Distance ------------------------------------------------------------
  if (RE.howFar.test(q)) {
    return make('distance', slots.length >= 2 ? 0.93 : slots.length === 1 ? 0.7 : 0.4);
  }

  // --- Counting ------------------------------------------------------------
  if (RE.howMany.test(q)) {
    // "How many bedrooms" is a property-level question; "how many chairs in
    // the kitchen" is an entity count. The difference is whether the noun is a
    // room kind.
    const roomKind = /\bhow many (bed ?rooms?|bath ?rooms?|rooms?|floors?|storeys?|stories)\b/.test(q);
    if (roomKind) return make('world_summary', 0.95);
    if (slots.length > 0) return make('count', 0.88);
    const noun = extractNoun(q);
    if (noun) return make('count', 0.85, { subject: { phrase: noun, start: 0, end: noun.length } });
    return make('count', 0.7);
  }

  // --- Property-level summary ---------------------------------------------
  if (RE.summary.test(q)) return make('world_summary', 0.9);

  // --- Comparison ----------------------------------------------------------
  if (RE.compare.test(q)) {
    // Two named rooms make this a deterministic two-measurement comparison.
    // "Which is the biggest room" is deterministic too. Anything vaguer is not.
    const named = slots.filter((s) => s.ref?.type === 'room').length;
    const superlative = /\b(biggest|largest|smallest)\b/.test(q);
    return make('compare', named >= 2 ? 0.9 : superlative ? 0.86 : 0.45);
  }

  // --- Area ----------------------------------------------------------------
  if (OBJECT_SIZE.test(q)) {
    return make('dimensions', slots.length > 0 ? 0.9 : 0.5, { axis: 'all' });
  }
  if (RE.howBig.test(q)) {
    const aboutProperty = /\b(flat|property|place|house|apartment|whole)\b/.test(q);
    if (aboutProperty && slots.length === 0) return make('world_summary', 0.9);
    return make('area', withImplicit(0.92, 0.85, 0.5));
  }

  // --- Dimensions ----------------------------------------------------------
  if (RE.dimensions.test(q)) {
    return make('dimensions', withImplicit(0.9, 0.85, 0.5), { axis: axis ?? 'all' });
  }

  // --- Visibility ----------------------------------------------------------
  if (RE.visible.test(q)) return make('visibility', slots.length > 0 ? 0.85 : 0.4);

  // --- Connectivity and routes --------------------------------------------
  if (RE.connect.test(q)) {
    return make('connectivity', slots.length >= 1 ? 0.87 : 0.4);
  }

  // --- Identify ------------------------------------------------------------
  if (RE.identify.test(q)) return make('identify', 0.85);

  // --- Surfaces ------------------------------------------------------------
  if (RE.surface.test(q)) return make('surface', slots.length > 0 ? 0.82 : 0.45);

  // --- Contents ------------------------------------------------------------
  if (RE.whatsIn.test(q)) {
    return make('contents', withImplicit(0.88, 0.85, 0.55));
  }

  // --- Existence -----------------------------------------------------------
  // After contents, because "what is in the kitchen" is not a yes/no question,
  // and before locate, because "is there a boiler" contains no "where".
  if (RE.exists.test(q)) {
    const noun = extractNoun(q);
    return make('exists', slots.length > 0 || noun ? 0.86 : 0.4,
      noun && !slots.some((x) => x.ref?.type === 'entity')
        ? { subject: { phrase: noun, start: 0, end: noun.length } }
        : {});
  }

  // --- Location ------------------------------------------------------------
  // Last of the content branches: "where" is a weak signal on its own and
  // several stronger patterns above also contain it.
  if (RE.where.test(q)) {
    if (slots.length > 0) return make('locate', 0.9);
    // No known name, but the frame is unmistakable. Carrying the noun through
    // turns this into a deterministic, grounded "there is no such thing here".
    const noun = extractNoun(q);
    if (noun) {
      return make('locate', 0.88, { subject: { phrase: noun, start: 0, end: noun.length } });
    }
    return make('locate', 0.45);
  }

  // Nothing matched. Record any noun phrases that looked like references so
  // the escalation has something to work with.
  for (const s of slots) if (!s.ref) unresolved.push(s.phrase);
  return make('unknown', 0.1);
}

/**
 * Is this a bare follow-up rather than a question of its own?
 *
 * Two shapes qualify and nothing else does:
 *   - an explicit connective: "and the door?", "what about the window?"
 *   - the question IS the noun phrase: "the door?", "bedroom 2?"
 *
 * Anything carrying its own interrogative or verb ("what is in here?") is a
 * new question, however short. Getting this wrong is expensive in a way tests
 * catch late: the turn is answered confidently, with the wrong operation.
 */
function isFollowUpShape(q: string, slots: readonly SlotMatch[]): boolean {
  const cleaned = q.replace(/[?.!,]+$/g, '').trim();
  if (/^(and|or|what about|how about|same (for|with)|ok(?:ay)?,? (?:and|what about)|the same for)\b/.test(cleaned)) {
    return true;
  }
  if (/\b(what|where|which|who|how|why|when|is|are|does|do|can|could|will|would|show|take|tell)\b/.test(cleaned)) {
    return false;
  }
  const s0 = slots[0];
  if (!s0) return false;
  const bare = cleaned.replace(/^(the|a|an|my|our)\s+/, '').trim();
  return bare === s0.phrase || bare === `${s0.phrase}s` || bare === `${s0.phrase}es`;
}

/** Convenience for tests and for the router's logging. */
export function describeIntent(i: Intent): string {
  const parts: string[] = [i.kind];
  if (i.subject) parts.push(`subject=${i.subject.phrase}`);
  if (i.object) parts.push(`object=${i.object.phrase}`);
  if (i.sizeM) parts.push(`size=${i.sizeM.map((v) => v.toFixed(2)).join('x')}`);
  if (i.followUp) parts.push('follow-up');
  return `${parts.join(' ')} (${i.confidence.toFixed(2)})`;
}

export { normalisePhrase };
