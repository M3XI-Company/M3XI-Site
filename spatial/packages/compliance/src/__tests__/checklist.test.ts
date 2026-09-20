import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { buildCertificate, referenceFrom } from '../model/certificate.js';
import { accessibilityObservations, buildChecklist } from '../model/checklist.js';
import { unansweredCount } from '../model/document.js';
import { renderDocument } from '../ui/render.js';
import { toHtml, toText } from '../render/vnode.js';
import { PROPERTY, WORLD_FACTS } from './fixtures.js';

const ISSUED = '2026-03-04T09:00:00.000Z';
const world = World.fromDocument(FLAT);
const reference = referenceFrom(FLAT, PROPERTY, WORLD_FACTS);
const certificate = buildCertificate({
  world, reference, measurementsAvailable: false, issuedAt: ISSUED,
});
const checklist = buildChecklist({
  world, reference, figures: certificate.figures, issuedAt: ISSUED,
});
const text = toText(renderDocument(checklist.document));
const html = toHtml(renderDocument(checklist.document));

describe('the three parts', () => {
  it('covers Part A: price, tenure and council tax band', () => {
    const partA = checklist.items.filter((i) => i.part === 'A').map((i) => i.label.toLowerCase());
    expect(partA.some((l) => l.includes('price'))).toBe(true);
    expect(partA.some((l) => l.includes('tenure'))).toBe(true);
    expect(partA.some((l) => l.includes('council tax'))).toBe(true);
  });

  it('covers Part B: type, construction, rooms, utilities and parking', () => {
    const partB = checklist.items.filter((i) => i.part === 'B').map((i) => i.label.toLowerCase());
    for (const needle of ['property type', 'construction', 'rooms', 'utilities', 'parking']) {
      expect(partB.some((l) => l.includes(needle))).toBe(true);
    }
  });

  it('covers Part C: flood, cladding, asbestos, covenants, TPOs and accessibility', () => {
    const partC = checklist.items.filter((i) => i.part === 'C').map((i) => i.label.toLowerCase());
    for (const needle of ['flood', 'cladding', 'asbestos', 'covenant', 'tree preservation', 'accessibility']) {
      expect(partC.some((l) => l.includes(needle))).toBe(true);
    }
  });

  it('starts each part on its own printed page', () => {
    const parts = checklist.document.sections.filter((s) => s.id.startsWith('part-'));
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part.pageBreakBefore).toBe(true);
    expect(html).toContain('cp-section--break');
  });
});

describe('what the survey can actually answer', () => {
  it('fills in the number and type of rooms', () => {
    const rooms = checklist.items.find((i) => i.id === 'b-rooms');
    expect(rooms!.answer.state).toBe('from-survey');
    expect(text).toContain('5 rooms');
    expect(text).toContain('2 bedrooms');
  });

  it('fills in the measured areas, with their standards and tolerances', () => {
    const sizes = checklist.items.find((i) => i.id === 'b-room-sizes');
    expect(sizes!.answer.state).toBe('from-survey');
    const figures = sizes!.answer.state === 'from-survey' ? sizes!.answer.figures ?? [] : [];
    expect(figures.length).toBe(FLAT.rooms.length);
    for (const figure of figures) expect(figure.formatted.tolerance).toMatch(/±/);
    expect(text).toContain('RICS GIA');
  });

  it('warns that an indicative area must not be quoted as a measurement', () => {
    const sizes = checklist.items.find((i) => i.id === 'b-room-sizes');
    expect(sizes!.evidence.join(' ')).toContain('indicative');
    expect(sizes!.evidence.join(' ')).toContain('Bedroom 1');
  });

  it('offers accessibility observations from the nav graph as evidence, not as an answer', () => {
    const item = checklist.items.find((i) => i.id === 'c-accessibility')!;
    expect(item.answer.state).toBe('unanswered');
    expect(item.evidence.length).toBeGreaterThan(2);
    expect(item.evidence.join(' ')).toContain('narrowest doorway');
    expect(text).toContain('evidence and not an answer');
  });

  it('measures the narrowest doorway on the walkable route, with a tolerance', () => {
    const observations = accessibilityObservations(world).join(' ');
    // The bathroom door is the narrowest in the shared fixture, and it is the
    // narrowest ON THE WALKABLE ROUTE that matters: a cupboard door must never
    // become the answer. The tolerance travels with it, because a width here
    // without one would be the exact failure this system exists to prevent.
    expect(observations).toContain('The narrowest doorway on the walkable route is 0.76 m');
    expect(observations).toContain('±20 mm');
    expect(observations).toContain('Bathroom');
    expect(observations).toContain('no stair');
  });
});

describe('an unanswered item cannot be mistaken for a complete one', () => {
  it('states the count of unanswered items before anything else', () => {
    expect(checklist.unanswered).toBeGreaterThan(10);
    expect(unansweredCount(checklist.document)).toBe(checklist.unanswered);
    expect(text).toContain(`Still unanswered`);
    expect(text).toContain(
      `This checklist is not complete: ${checklist.unanswered} of ${checklist.items.length} items are unanswered`,
    );
  });

  it('prints the word UNANSWERED beside every unanswered item, next to its label', () => {
    for (const item of checklist.items) {
      if (item.answer.state !== 'unanswered') continue;
      const at = text.indexOf(`${item.part}. ${item.label}`);
      expect(at, `"${item.label}" does not appear on the page`).toBeGreaterThan(-1);
      // The word has to be ON the row, not somewhere else in the document.
      // The status sits immediately after the label in the item header, so a
      // short window is the right assertion: a document that said UNANSWERED
      // once at the top and nowhere else would pass a looser one.
      expect(text.slice(at, at + item.label.length + 40)).toContain('UNANSWERED');
    }
  });

  it('prints it for those items and for no others', () => {
    // One extra occurrence is the standing statement at the top, which tells
    // the reader what the word means before they meet it.
    const occurrences = text.split('UNANSWERED').length - 1;
    expect(occurrences).toBe(checklist.unanswered + 1);
    expect(checklist.document.standing.join(' ')).toContain('marked UNANSWERED');
  });

  it('gives a specific reason, never an em dash and never "n/a"', () => {
    for (const item of checklist.items) {
      if (item.answer.state !== 'unanswered') continue;
      expect(item.answer.reason.length).toBeGreaterThan(30);
      expect(item.answer.reason).not.toMatch(/^—$|n\/a/i);
    }
    expect(text).toContain('This checklist has no answer for this item.');
  });

  it('leaves a real labelled field for the person who can answer it', () => {
    const price = checklist.items.find((i) => i.id === 'a-price')!;
    expect(price.input).toBe('money');
    expect(html).toContain('for="cp-dmcc-checklist-a-price"');
    expect(html).toContain('id="cp-dmcc-checklist-a-price"');
    // Empty, and empty is the point: a pre-filled plausible default is the
    // invention this document exists to refuse.
    expect(html).toContain('id="cp-dmcc-checklist-a-price" class="cp-input" placeholder="e.g. 385,000" type="text" value=""');
  });

  it('does not offer a field over a figure the survey measured', () => {
    const sizes = checklist.items.find((i) => i.id === 'b-room-sizes')!;
    expect(sizes.input).toBeUndefined();
    expect(html).not.toContain('id="cp-dmcc-checklist-b-room-sizes"');
  });
});

describe('what this document says about itself', () => {
  it('says it is a working aid and not legal advice', () => {
    const standing = checklist.document.standing.join(' ');
    expect(standing).toContain('working aid');
    expect(standing).toContain('not legal advice');
    expect(standing).toContain('own compliance process');
  });

  it('says the answers are not saved anywhere', () => {
    expect(text).toContain('not saved');
    expect(text).toContain('Answers typed here are not stored');
  });

  it('names the Act it is written against', () => {
    expect(text).toContain('Digital Markets, Competition and Consumers Act 2024');
    expect(text).toContain('omission');
  });
});
