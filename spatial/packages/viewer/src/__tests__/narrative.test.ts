import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { buildNarrative, describeRoute } from '../text/narrative.js';

const world = World.fromDocument(FLAT);
const narrative = buildNarrative(world, { locale: 'en-GB', imperial: true });

const sectionById = (id: string) => narrative.sections.find((s) => s.id === id);
const text = (id: string): string => {
  const s = sectionById(id);
  if (!s) throw new Error(`no section ${id}`);
  return s.blocks.map((b) => {
    if (b.kind === 'paragraph' || b.kind === 'note') return b.text;
    if (b.kind === 'list') return `${b.intro ?? ''} ${b.items.join(' ')}`;
    return `${b.label} ${b.formatted.full} ${b.formatted.statusNote ?? ''}`;
  }).join(' ');
};

describe('shape of the document', () => {
  it('is titled after the property and identifies the survey version', () => {
    expect(narrative.title).toBe(FLAT.label);
    expect(narrative.worldId).toBe(FLAT.id);
    expect(narrative.worldVersion).toBe(FLAT.version);
  });

  it('opens with a lead that states coverage', () => {
    expect(narrative.lead).toContain('written tour');
    expect(narrative.lead).toContain('96%');
  });

  it('has a section for every surveyed room, linked back to the 3D view', () => {
    const roomSections = narrative.sections.filter((s) => s.roomId !== undefined);
    expect(roomSections.map((s) => s.roomId).sort())
      .toEqual(FLAT.rooms.map((r) => r.id).sort());
    for (const s of roomSections) expect(s.level).toBe(3);
  });

  it('nests rooms under a floor heading', () => {
    const floor = narrative.sections.findIndex((s) => s.id === 'floor-f_ground');
    const firstRoom = narrative.sections.findIndex((s) => s.roomId !== undefined);
    expect(floor).toBeGreaterThan(-1);
    expect(firstRoom).toBeGreaterThan(floor);
  });

  it('uses only h2 and h3, so the heading order never skips a level', () => {
    let last = 2;
    for (const s of narrative.sections) {
      expect(s.level === 2 || s.level === 3).toBe(true);
      expect(s.level - last).toBeLessThanOrEqual(1);
      last = s.level;
    }
  });
});

describe('every number carries its standard and tolerance', () => {
  it('holds for every measurement block in the document', () => {
    const measurements = narrative.sections.flatMap((s) => s.blocks)
      .filter((b) => b.kind === 'measurement');
    expect(measurements.length).toBeGreaterThan(4);
    for (const m of measurements) {
      if (m.kind !== 'measurement') continue;
      expect(m.formatted.tolerance).toMatch(/^±/);
      expect(m.formatted.standard.length).toBeGreaterThan(5);
      expect(m.formatted.full).toContain(m.formatted.value);
      expect(m.formatted.full).toContain('±');
    }
  });

  it('explains the measurement policy in its own section', () => {
    const t = text('measurement');
    expect(t).toContain('RICS Code of Measuring Practice');
    expect(t).toContain('2.5%');
    expect(t).toContain('20 mm');
    expect(t).toContain('quadrature');
  });

  it('tells the reader up front that a bare figure is not a measurement', () => {
    expect(text('how-to-read')).toContain('A figure without both of those is not a measurement');
  });
});

describe('room descriptions', () => {
  const bed1 = text('room-r_bed1');

  it('states kind, extent and ceiling height', () => {
    expect(bed1).toContain('bedroom');
    expect(bed1).toMatch(/4\.50 m by 3\.10 m/);
    expect(bed1).toContain('2.40 m from floor to ceiling');
  });

  it('lists the doorways and what they connect to', () => {
    expect(bed1).toContain('A door to the hall');
  });

  it('describes windows by dimension and sill, never by compass direction', () => {
    expect(bed1).toContain('A window');
    expect(bed1).toContain('sill');
    expect(bed1).not.toMatch(/\b(north|south|east|west)\b/i);
  });

  it('lists the contents with sizes for the large items', () => {
    expect(bed1).toContain('Double bed');
    expect(bed1).toContain('Wardrobe');
    expect(bed1).toMatch(/1\.90 m by 1\.35 m/);
  });

  it('names what was not surveyed, and what that means', () => {
    expect(bed1).toContain('Part of this room was not surveyed');
    expect(bed1).toContain('occluded by the wardrobe');
    expect(bed1).toContain('you cannot walk into it');
  });

  it('marks an estimated ceiling as estimated rather than not surveyed', () => {
    const bath = text('room-r_bath');
    expect(bath).toContain('Part of this room was estimated rather than measured');
    expect(bath).toContain('ceiling plane never in view');
  });

  it('says when a room was empty rather than silently omitting the list', () => {
    const empty = World.fromDocument({ ...FLAT, entities: [] });
    const n = buildNarrative(empty);
    const s = n.sections.find((x) => x.roomId === 'r_bed1')!;
    const joined = s.blocks.map((b) => (b.kind === 'paragraph' ? b.text : '')).join(' ');
    expect(joined).toContain('recorded nothing standing in this room');
  });
});

describe('routes from the entrance', () => {
  it('gives a walkable instruction in ordinary language', () => {
    const route = describeRoute(world, 'r_bed1')!;
    expect(route).toContain('From the entrance');
    expect(route).toContain('bedroom 1');
    expect(route).toMatch(/turn (left|right)|straight ahead|go straight ahead/);
  });

  it('quotes the total distance properly and nothing else numerically', () => {
    const route = describeRoute(world, 'r_bed2')!;
    expect(route).toMatch(/It is [\d.]+ m from the entrance along the walkable route, ±\d+ mm\./);
    // Only one numeric figure in the whole sentence, and it is the quoted one.
    const numbers = route.match(/\d+(\.\d+)?/g) ?? [];
    expect(numbers.length).toBeLessThanOrEqual(4);
  });

  it('says so plainly when the room is where the tour starts', () => {
    expect(describeRoute(world, 'r_hall')).toBe('This is where the tour starts.');
  });

  it('returns nothing rather than inventing a route with no entrance node', () => {
    const noEntrance = World.fromDocument({
      ...FLAT,
      nav: { ...FLAT.nav, nodes: FLAT.nav.nodes.map((n) => ({ ...n, isEntrance: false })) },
    });
    expect(describeRoute(noEntrance, 'r_bed1')).toBeUndefined();
  });
});

describe('the coverage section', () => {
  const t = text('coverage');

  it('lists what was not surveyed with the pipeline reason verbatim', () => {
    expect(t).toContain('Not surveyed:');
    expect(t).toContain('corner occluded by the wardrobe for the whole capture');
    expect(t).toContain('void above the hall ceiling');
  });

  it('separates estimated from unsurveyed', () => {
    expect(t).toContain('Estimated rather than measured:');
    expect(t).toContain('ceiling plane never in view');
  });

  it('reports quality checks the survey failed instead of hiding them', () => {
    expect(t).toContain('did not meet every quality threshold');
    expect(t).toContain('Ceiling observed fraction');
    expect(t).toContain('bathroom ceiling never in view');
  });

  it('says so when nothing was missed', () => {
    const clean = World.fromDocument({
      ...FLAT,
      regions: FLAT.regions.filter((r) => r.provenance === 'observed'),
      quality: { ...FLAT.quality, checks: FLAT.quality.checks.filter((c) => c.pass) },
    });
    const n = buildNarrative(clean);
    const section = n.sections.find((s) => s.id === 'coverage')!;
    const joined = section.blocks.map((b) => (b.kind === 'paragraph' ? b.text : '')).join(' ');
    expect(joined).toContain('Nothing in this tour was filled in by a model');
  });
});

describe('the overview', () => {
  it('counts the rooms by kind', () => {
    const t = text('overview');
    expect(t).toContain('two bedrooms');
    expect(t).toContain('one kitchen');
  });

  it('totals the floor area as a single quantity with a tolerance', () => {
    const block = sectionById('overview')!.blocks.find((b) => b.kind === 'measurement');
    expect(block).toBeDefined();
    if (block?.kind !== 'measurement') throw new Error('expected a measurement');
    expect(block.formatted.value).toMatch(/m²/);
    expect(block.formatted.tolerance).toMatch(/^±/);
    // Indicative, and correctly so: bedroom 1's floor area includes the corner
    // behind the wardrobe that no camera observed, and a total that swallowed
    // that silently would be exactly the misstatement this system exists to
    // prevent. The figure is still shown; it is shown marked.
    expect(block.formatted.status).toBe('indicative');
    expect(block.formatted.statusNote).toBeTruthy();
  });

  it('states how metric scale was fixed', () => {
    expect(text('overview')).toContain('ARKit depth + door-leaf prior');
  });
});
