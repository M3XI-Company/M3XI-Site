import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { buildNarrative } from '@m3xi/viewer/headless';
import { buildAccessibilityStatement } from '../model/accessibility.js';
import { referenceFrom } from '../model/certificate.js';
import { renderDocument } from '../ui/render.js';
import { toHtml, toText } from '../render/vnode.js';
import { PROPERTY, WORLD_FACTS } from './fixtures.js';

const ISSUED = '2026-03-04T09:00:00.000Z';
const world = World.fromDocument(FLAT);
const statement = buildAccessibilityStatement({
  world,
  reference: referenceFrom(FLAT, PROPERTY, WORLD_FACTS),
  issuedAt: ISSUED,
});
const text = toText(renderDocument(statement.document));
const html = toHtml(renderDocument(statement.document));

describe('the narrative comes from the viewer', () => {
  const direct = buildNarrative(world, { locale: 'en-GB', imperial: false, routes: true });

  it('uses buildNarrative rather than a second describer', () => {
    expect(statement.narrative.lead).toBe(direct.lead);
    expect(statement.narrative.sections.map((s) => s.id))
      .toEqual(direct.sections.map((s) => s.id));
  });

  it('keeps the viewer\'s headings and order, unrenamed', () => {
    const headings = statement.document.sections
      .filter((s) => s.id.startsWith('tour-'))
      .map((s) => s.heading);
    expect(headings).toEqual(direct.sections.map((s) => s.heading));
  });

  it('describes every room by name', () => {
    for (const room of FLAT.rooms) expect(text).toContain(room.name!);
  });

  it('reads as prose about the property, not a transcribed table', () => {
    expect(text).toContain('Bedroom 1 is a bedroom.');
    expect(text).toContain('From the entrance');
    expect(text).toContain('It is ');
  });
});

describe('what it says about the survey', () => {
  it('states coverage, including what was not surveyed', () => {
    expect(text).toContain('What we could not see');
    expect(text).toContain('Not surveyed');
    expect(text).toContain('occluded by the wardrobe');
  });

  it('carries the tolerance and the standard with every measurement it quotes', () => {
    const measurements = statement.document.sections
      .flatMap((s) => s.blocks)
      .filter((b) => b.kind === 'measurement');
    expect(measurements.length).toBeGreaterThan(0);
    for (const block of measurements) {
      if (block.kind !== 'measurement') continue;
      expect(block.formatted.tolerance).toMatch(/±/);
      expect(block.formatted.standardShort.length).toBeGreaterThan(0);
      expect(html).toContain(block.formatted.standardShort);
    }
  });

  it('marks an indicative figure as indicative in the prose too', () => {
    expect(text).toContain('INDICATIVE');
  });
});

describe('what it says about itself', () => {
  it('is the tour, not a summary of it and not a fallback', () => {
    const standing = statement.document.standing.join(' ');
    expect(standing).toContain('same tour in a different form');
    expect(standing).toContain('available to everyone');
  });

  it('lists what it cannot tell you, including why there is no compass direction', () => {
    expect(text).toContain('What this document does not tell you');
    expect(text).toContain('never north');
    expect(text).toContain('Condition, decoration');
  });

  it('says there is no accessibility overlay, and why', () => {
    expect(text).toContain('no accessibility overlay');
    expect(text).toContain('assistive technology');
  });

  it('makes no conformance claim about the viewer and no claim about the property', () => {
    expect(text).not.toMatch(/WCAG\s*2\.\d\s*(AA|AAA)\b/);
    expect(text).not.toMatch(/wheelchair accessible/i);
    expect(text).toContain('not a question a survey can answer');
  });
});

describe('the markup', () => {
  it('uses real headings in a sane order', () => {
    const levels = [...html.matchAll(/<h([1-3])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    // No level is ever skipped on the way down: an h3 only follows an h2.
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
  });

  it('binds each section to its own heading', () => {
    for (const section of statement.document.sections) {
      expect(html).toContain(`aria-labelledby="cp-accessibility-statement-${section.id}"`);
    }
  });

  it('breaks pages between sections, never inside one', () => {
    for (const section of statement.document.sections) {
      if (section.level !== 2 || !section.id.startsWith('tour-')) continue;
      expect(section.pageBreakBefore).toBe(true);
    }
    expect(html).toContain('class="cp-section cp-section--break"');
  });
});
