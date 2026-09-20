/**
 * A realistic property question set.
 *
 * These are the questions people actually type into a property tour: mostly
 * measurements and contents, some navigation, a few that no capture can
 * answer, and a handful that need real reasoning. The mix matters more than
 * the count -- a set stuffed with "how far is X from Y" would report a
 * flattering deterministic fraction and tell us nothing.
 *
 * `expect` is the tier this question SHOULD land in. Where a question is
 * genuinely on a boundary the expectation is written as the cheapest tier that
 * can answer it honestly, and the router is allowed to be cheaper but not more
 * expensive without the test noticing.
 */

import type { Tier } from '../types.js';

export interface QuestionCase {
  readonly q: string;
  readonly expect: Tier;
  /** What a correct answer must mention, as a loose substring or regex. */
  readonly must?: RegExp;
  readonly note?: string;
}

export const QUESTIONS: readonly QuestionCase[] = [
  // --- Property-level facts (deterministic) --------------------------------
  { q: 'How many bedrooms does this property have?', expect: 'deterministic', must: /2 bedrooms/i },
  { q: 'How many bathrooms are there?', expect: 'deterministic', must: /1 bathroom/i },
  { q: 'How many rooms in total?', expect: 'deterministic', must: /5 rooms/i },
  { q: 'Tell me about this property', expect: 'deterministic' },
  { q: 'How big is the flat overall?', expect: 'deterministic' },

  // --- Areas ---------------------------------------------------------------
  { q: 'How big is the kitchen?', expect: 'deterministic', must: /m²/ },
  { q: 'What is the floor area of bedroom 2?', expect: 'deterministic', must: /m²/ },
  { q: 'How large is the bathroom?', expect: 'deterministic', must: /m²/ },
  { q: 'What is the area of the hall?', expect: 'deterministic', must: /m²/ },
  { q: 'How many square metres is bedroom 2?', expect: 'deterministic' },
  // Bedroom 1 contains a generated region, so its area is refused, not quoted.
  { q: 'How big is bedroom 1?', expect: 'deterministic', must: /won't quote|not observe|no camera/i },

  // --- Dimensions ----------------------------------------------------------
  { q: 'What are the dimensions of bedroom 2?', expect: 'deterministic', must: /m by|by .* m/ },
  { q: 'How wide is the kitchen?', expect: 'deterministic' },
  { q: 'How tall are the ceilings?', expect: 'deterministic' },
  { q: 'What is the ceiling height in the hall?', expect: 'deterministic' },
  { q: 'How big is the double bed?', expect: 'deterministic' },
  { q: 'How wide is the front door?', expect: 'deterministic' },
  { q: 'What size is the wardrobe?', expect: 'deterministic' },

  // --- Distances -----------------------------------------------------------
  { q: 'How far is the sofa from the television?', expect: 'deterministic', must: /\d+\.\d+ m/ },
  { q: 'What is the distance between the fridge freezer and the sink?', expect: 'deterministic' },
  { q: 'How far is the dining table from the window?', expect: 'deterministic' },
  { q: 'How close is the bed to the wardrobe?', expect: 'deterministic' },
  { q: 'How far is it from the front door to bedroom 2?', expect: 'deterministic' },

  // --- Counts --------------------------------------------------------------
  { q: 'How many dining chairs are there?', expect: 'deterministic', must: /4 dining chairs/i },
  { q: 'How many windows does the kitchen have?', expect: 'deterministic' },
  { q: 'How many appliances are in the kitchen?', expect: 'deterministic' },

  // --- Room contents -------------------------------------------------------
  { q: 'What is in the bathroom?', expect: 'deterministic', must: /bath|wc|basin/i },
  { q: 'What furniture is in bedroom 2?', expect: 'deterministic' },
  { q: "What's in the kitchen?", expect: 'deterministic' },
  { q: 'Does the kitchen have an oven?', expect: 'deterministic' },

  // --- Location ------------------------------------------------------------
  { q: 'Where is the sofa?', expect: 'deterministic', must: /kitchen|diner/i },
  { q: 'Which room is the bookshelf in?', expect: 'deterministic', must: /bedroom 2/i },
  { q: 'Where is the boiler?', expect: 'deterministic', must: /can't find|no /i },

  // --- Connectivity and routes --------------------------------------------
  { q: 'Does the kitchen connect to the hall?', expect: 'deterministic' },
  { q: 'What is next to the bathroom?', expect: 'deterministic' },
  { q: 'How do I get from the kitchen to bedroom 1?', expect: 'deterministic' },
  { q: 'What rooms open onto the hall?', expect: 'deterministic' },

  // --- Fit -----------------------------------------------------------------
  { q: 'Will a 2.0 m by 0.9 m sofa fit in bedroom 2?', expect: 'deterministic', must: /yes|no/i },
  { q: 'Is there room for a 1.4 x 2.0 m double bed in bedroom 2?', expect: 'deterministic' },
  { q: 'Would a 3 m by 3 m table fit in the bathroom?', expect: 'deterministic', must: /no/i },

  // --- Visibility ----------------------------------------------------------
  { q: 'Can you see the television from the dining table?', expect: 'deterministic' },
  { q: 'Is the wardrobe visible from the bedroom 1 door?', expect: 'deterministic' },

  // --- Navigation ----------------------------------------------------------
  { q: 'Show me bedroom 2', expect: 'deterministic', must: /taking you/i },
  { q: 'Take me to the bathroom', expect: 'deterministic' },

  // --- Provenance ----------------------------------------------------------
  { q: 'How do you know the kitchen is that size?', expect: 'deterministic', must: /camera|derived|frame/i },
  { q: 'Was the chest of drawers actually measured?', expect: 'deterministic', must: /estimated|inferred|context/i },

  // --- Comparison ----------------------------------------------------------
  { q: 'Which is the biggest room?', expect: 'deterministic', must: /kitchen|diner/i },
  { q: 'Is bedroom 2 bigger than the bathroom?', expect: 'deterministic' },

  // --- Surfaces and materials ---------------------------------------------
  { q: 'Is the kitchen window double glazed?', expect: 'deterministic', must: /not something a capture|survey|EPC/i },

  // --- Genuinely needs a model --------------------------------------------
  { q: 'Why is the bathroom ceiling marked as uncertain?', expect: 'large', note: 'asks for an explanation' },
  { q: 'Which bedroom would be better for a home office, and how much desk space is there?', expect: 'large', note: 'judgement plus a second clause' },
  { q: 'Should I be worried that part of bedroom 1 was not scanned?', expect: 'large', note: 'asks for a judgement' },
  { q: 'Is this flat suitable for a family of four?', expect: 'large', note: 'judgement with no spatial answer' },
  { q: 'Compared with the kitchen, how does bedroom 2 feel for space?', expect: 'large', note: 'comparison with a criterion' },
  { q: 'What would you change about the layout?', expect: 'large', note: 'opinion' },

  // --- Rephrasings the templates do not parse ------------------------------
  { q: 'give me the lowdown on the sitting area', expect: 'small', note: 'unparsed but short' },
  { q: 'any idea about the storage situation', expect: 'small', note: 'unparsed but short' },
];

export const DETERMINISTIC_TARGET = 0.6;
