import type { World } from '@m3xi/spatial-engine';
import { buildNarrative, type Narrative, type NarrativeBlock } from '@m3xi/viewer/headless';
import type { ComplianceDocument, DocBlock, DocSection, DocumentReference } from './document.js';
import { humanDate, humanDateTime } from './document.js';

/**
 * THE ACCESSIBILITY STATEMENT
 * ===========================
 *
 * This is the document that makes the tour usable by somebody who cannot see
 * it. Not a conformance claim, not a badge: the property, in prose, with the
 * same numbers the 3D view shows and the same admissions about what was never
 * photographed.
 *
 * IT USES THE VIEWER'S OWN NARRATIVE AND MUST. `@m3xi/viewer/headless` exports
 * `buildNarrative`, which walks the world room by room and writes the tour out
 * with measurements from the engine and coverage from the regions. Writing a
 * second describer here would produce a document that says something slightly
 * different from the one in the viewer -- a different room order, a different
 * rounding, a different silence about the bathroom ceiling -- and the whole
 * value of a text alternative is that it is the SAME tour. So this file
 * converts, frames and states limits. It describes nothing itself.
 *
 * WHAT IT ADDS to the narrative, and why each one is not in the viewer:
 *
 *   -- a standing statement. On screen the tour is obviously the tour; on
 *      paper, handed to somebody who was not there, it needs to say what it is
 *      and where the numbers came from;
 *   -- a "what this does not tell you" section. The narrative already omits
 *      compass directions because the contract fixes no north, and says so in
 *      its own source. A reader of the printed document deserves the same
 *      list;
 *   -- nothing else. No conformance claim about the viewer, no WCAG level, no
 *      statement that this property is accessible. This document is prose
 *      about a building; whether a person can use the building is a question
 *      about that person and this survey does not answer it.
 */

export interface AccessibilityOptions {
  readonly world: World;
  readonly reference: DocumentReference;
  readonly issuedAt: string;
  readonly locale?: string;
  /** Feet and inches beside the metric. UK particulars still quote both. */
  readonly imperial?: boolean;
}

export interface AccessibilityStatement {
  readonly document: ComplianceDocument;
  readonly narrative: Narrative;
}

export function buildAccessibilityStatement(
  opts: AccessibilityOptions,
): AccessibilityStatement {
  const narrative = buildNarrative(opts.world, {
    locale: opts.locale ?? 'en-GB',
    imperial: opts.imperial === true,
    routes: true,
  });

  const sections: DocSection[] = [
    standingSection(opts, narrative),
    ...narrative.sections.map(convertSection),
    limitsSection(),
  ];

  return {
    document: {
      kind: 'accessibility-statement',
      title: 'The property in words',
      subtitle: narrative.title,
      issuedAt: opts.issuedAt,
      reference: opts.reference,
      standing: STANDING,
      sections,
    },
    narrative,
  };
}

const STANDING: readonly string[] = [
  'This is the written tour of the property: the same survey the 3D walkthrough is drawn from, '
  + 'described room by room, with the same measurements and the same account of what the '
  + 'cameras did not reach.',
  'It is not a summary of the tour and it is not a fallback for when the 3D view fails. It is '
  + 'the same tour in a different form, and it is available to everyone, always.',
  'Every dimension here carries the tolerance it was measured to and the standard it was '
  + 'measured against. A figure the survey will not stand behind says so on its own line.',
];

/**
 * A narrative section becomes a document section unchanged.
 *
 * The heading levels, the ids and the order are the narrative's, not this
 * file's. A reader who has used the viewer's text view and then prints this
 * should find the same headings in the same order; re-titling them here for
 * a printed page would break that for the sake of a nicer word.
 */
function convertSection(section: Narrative['sections'][number]): DocSection {
  return {
    id: `tour-${section.id}`,
    heading: section.heading,
    level: section.level,
    blocks: section.blocks.map(convertBlock),
    // Each floor and each room starts where the reader expects it to start.
    // Only level 2 breaks: a page break before every room would waste a page
    // per room in a five-room flat, and printing is not free.
    ...(section.level === 2 ? { pageBreakBefore: true } : {}),
  };
}

function convertBlock(block: NarrativeBlock): DocBlock {
  switch (block.kind) {
    case 'paragraph':
      return { kind: 'paragraph', text: block.text };
    case 'list':
      return block.intro
        ? { kind: 'list', intro: block.intro, items: block.items }
        : { kind: 'list', items: block.items };
    case 'measurement':
      return { kind: 'measurement', label: block.label, formatted: block.formatted };
    case 'note':
      // 'unsurveyed' is a stronger admission than 'estimated' and reads as one:
      // the tone drives a heavier rule in print, and the heading says which it
      // is in words, because the rule alone does not survive a photocopier.
      return {
        kind: 'note',
        tone: block.tone === 'unsurveyed' ? 'warn' : 'info',
        heading: block.tone === 'unsurveyed'
          ? 'Not surveyed'
          : 'Estimated rather than measured',
        text: block.text,
      };
  }
}

function standingSection(
  opts: AccessibilityOptions, narrative: Narrative,
): DocSection {
  return {
    id: 'about',
    heading: 'About this document',
    level: 2,
    blocks: [
      { kind: 'paragraph', text: narrative.lead },
      {
        kind: 'facts',
        pairs: [
          ['Property', opts.reference.propertyLabel],
          ...(opts.reference.postcode ? [['Postcode', opts.reference.postcode] as const] : []),
          ['Survey', `Version ${narrative.worldVersion}, created `
            + `${humanDate(opts.reference.surveyedAt)}`],
          ['Survey identifier', narrative.worldId],
          ['Written out', humanDateTime(opts.issuedAt)],
          ['Rooms described', String(opts.world.doc.rooms.length)],
        ],
      },
      {
        kind: 'paragraph',
        text: 'The measurements below come from the same engine that answers a question in the '
          + '3D view, so a figure here and the same figure on screen are the same number, '
          + 'rounded the same way. Nothing in this document was written by a language model.',
      },
    ],
  };
}

function limitsSection(): DocSection {
  return {
    id: 'limits',
    heading: 'What this document does not tell you',
    level: 2,
    blocks: [
      {
        kind: 'list',
        items: [
          'Which way a room faces. The survey fixes an origin and an up axis but never north, '
          + 'so "a window in the east wall" would be invented. Windows are described by their '
          + 'size and the height of their sill instead, which the survey does know.',
          'Condition, decoration or smell. The survey records shape, position and size. A wall '
          + 'that needs replastering and a wall that does not are the same wall to it.',
          'Anything behind a closed door. A cupboard nobody opened is a cupboard nobody '
          + 'measured, and the coverage section above lists what was not reached.',
          'Whether the property is suitable for you. Doorway widths and changes of level are '
          + 'measured and stated; whether they work for a particular person, a particular '
          + 'chair or a particular frame is not a question a survey can answer.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'There is no accessibility overlay on the tour this document describes, and that '
          + 'is deliberate. Overlays are found effective by a small minority of disabled users '
          + 'and routinely conflict with the assistive technology somebody has already set up. '
          + 'The accessible path here is the ordinary path: real headings, real landmarks, '
          + 'keyboard operation for everything, and this document.',
      },
    ],
  };
}
