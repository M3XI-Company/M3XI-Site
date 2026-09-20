import type { NavEdge, Room, RoomKind } from '@m3xi/world-core';
import type { World } from '@m3xi/spatial-engine';
import { formatQuantity } from '@m3xi/viewer/headless';
import type {
  ChecklistItem, ComplianceDocument, DocBlock, DocSection, DocumentReference, Figure,
} from './document.js';
import { humanDateTime } from './document.js';

/**
 * THE DMCC MATERIAL INFORMATION CHECKLIST
 * =======================================
 *
 * Under the Digital Markets, Competition and Consumers Act 2024 the CMA
 * enforces consumer protection directly, with penalties of up to 10% of global
 * turnover, and an omission of material information is unfair whether or not
 * it changed anyone's decision. Parts A, B and C are the trading-standards
 * framework agencies already work to: A is what every listing must carry, B is
 * what every listing must carry about the building, C is what must be
 * disclosed where it applies.
 *
 * THE DESIGN PROBLEM IS NOT THE ITEMS. It is what an unanswered item looks
 * like. A checklist that renders "not known" and a checklist that renders a
 * blank both read, to a tired person at five o'clock, as a checklist that has
 * been done. So:
 *
 *   -- every item is in one of exactly two states, and there is no empty
 *      string in the union. An item is answered from the survey, with the
 *      figures behind it, or it is UNANSWERED with a specific reason;
 *   -- the count of unanswered items is printed at the top, in the summary,
 *      before anything else;
 *   -- an unanswered item prints the word, a ruled line to write on, and the
 *      reason the survey cannot supply it. It never prints an em dash, which
 *      is what a table cell uses for "nothing to say here";
 *   -- nothing is pre-filled with a plausible default. A property type this
 *      code could guess from five rooms on one level is a guess, and a guess
 *      in this document is the thing the Act penalises.
 *
 * WHAT THE SURVEY CAN ACTUALLY ANSWER is narrow and worth stating precisely:
 * the number and type of rooms, the measured floor areas, and a set of
 * accessibility OBSERVATIONS -- door widths, changes of level, clearances --
 * which are evidence towards Part C's accessibility item and are not an answer
 * to it. Everything else is an agency fact, a legal fact or a searches fact,
 * and the survey has no opinion about any of them.
 */

export interface ChecklistOptions {
  readonly world: World;
  readonly reference: DocumentReference;
  /**
   * The certificate's figures. Passed in rather than recomputed so that the
   * area on the checklist and the area on the certificate cannot differ: two
   * documents issued the same afternoon quoting different numbers for the same
   * room is the failure this whole system is built to prevent.
   */
  readonly figures: readonly Figure[];
  readonly issuedAt: string;
  readonly locale?: string;
}

export interface Checklist {
  readonly document: ComplianceDocument;
  readonly items: readonly ChecklistItem[];
  readonly unanswered: number;
}

export function buildChecklist(opts: ChecklistOptions): Checklist {
  const partA = buildPartA();
  const partB = buildPartB(opts);
  const partC = buildPartC(opts);
  const items = [...partA, ...partB, ...partC];
  const unanswered = items.filter((i) => i.answer.state === 'unanswered').length;

  const sections: DocSection[] = [
    summarySection(opts, items, unanswered),
    {
      id: 'part-a',
      heading: 'Part A — required on every listing',
      level: 2,
      pageBreakBefore: true,
      blocks: [
        {
          kind: 'paragraph',
          text: 'Part A is the information that must appear on every property listing from the '
            + 'moment it is published. None of it is measurable: it is priced, held and rated '
            + 'by people, not by a building.',
        },
        { kind: 'checklist', part: 'A', items: partA },
      ],
    },
    {
      id: 'part-b',
      heading: 'Part B — required on every listing, about the building',
      level: 2,
      pageBreakBefore: true,
      blocks: [
        {
          kind: 'paragraph',
          text: 'Part B describes the building itself. The survey answers the parts of it that '
            + 'are geometry — how many rooms, of what kind, and how big — and nothing else. '
            + 'Construction materials, utilities and parking rights are not visible to a camera.',
        },
        { kind: 'checklist', part: 'B', items: partB },
      ],
    },
    {
      id: 'part-c',
      heading: 'Part C — required where it applies',
      level: 2,
      pageBreakBefore: true,
      blocks: [
        {
          kind: 'paragraph',
          text: 'Part C must be disclosed where it applies to the property. "Not applicable" is '
            + 'an answer and must be recorded as one; leaving an item blank is not the same '
            + 'thing and does not discharge the duty.',
        },
        { kind: 'checklist', part: 'C', items: partC },
      ],
    },
    evidenceSection(opts),
  ];

  return {
    document: {
      kind: 'dmcc-checklist',
      title: 'Material information checklist',
      subtitle: opts.reference.propertyLabel,
      issuedAt: opts.issuedAt,
      reference: opts.reference,
      standing: STANDING,
      sections,
    },
    items,
    unanswered,
  };
}

const STANDING: readonly string[] = [
  'This is a working aid for assembling material information under the Digital Markets, '
  + 'Competition and Consumers Act 2024. It is not legal advice, and it is not a substitute '
  + 'for your agency\'s own compliance process or for your trading standards guidance.',
  'The survey fills in only what it can measure: the number and type of rooms, their floor '
  + 'areas, and observations about doorways and changes of level. Every other item is left for '
  + 'a person to complete, and is marked UNANSWERED until one does.',
  'Answers typed into this page are not saved anywhere. There is no store for material '
  + 'information in this system, so this document is a checklist to print or to copy from, not '
  + 'a record. Print it before you leave the page.',
];

// ---------------------------------------------------------------------------
// Part A
// ---------------------------------------------------------------------------

function buildPartA(): readonly ChecklistItem[] {
  const unanswerable = (reason: string) => ({ state: 'unanswered' as const, reason });
  return [
    {
      id: 'a-price',
      part: 'A',
      label: 'Price or rent',
      guidance: 'The asking price or rent, stated as a figure. A range or "offers over" must '
        + 'say which.',
      answer: unanswerable('A survey measures the building. Price is set by the seller and the '
        + 'agency, and is held in neither the world nor the property record.'),
      evidence: [],
      input: 'money',
      placeholder: 'e.g. 385,000',
    },
    {
      id: 'a-tenure',
      part: 'A',
      label: 'Tenure',
      guidance: 'Freehold, leasehold, commonhold or shared ownership. For leasehold, the '
        + 'remaining term, ground rent and service charge are all Part A.',
      answer: unanswerable('Tenure is a matter of title, not of geometry. It is not recorded '
        + 'anywhere in this system.'),
      evidence: [],
      input: 'choice',
      choices: ['Freehold', 'Leasehold', 'Commonhold', 'Shared ownership', 'Other'],
    },
    {
      id: 'a-lease-term',
      part: 'A',
      label: 'Lease: remaining term, ground rent, service charge',
      guidance: 'Required where the tenure is leasehold or shared ownership. Record "not '
        + 'applicable" where it is not.',
      answer: unanswerable('Not held in this system. It comes from the lease.'),
      evidence: [],
      input: 'longtext',
      placeholder: 'e.g. 112 years remaining, ground rent £250/yr, service charge £1,840/yr',
    },
    {
      id: 'a-council-tax',
      part: 'A',
      label: 'Council tax band',
      guidance: 'The band as listed by the Valuation Office Agency, or the rateable value for '
        + 'a commercial property.',
      answer: unanswerable('A council tax band is assigned by the VOA and is not derivable from '
        + 'a measurement of the property.'),
      evidence: [],
      input: 'choice',
      choices: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Not yet banded', 'Not applicable'],
    },
  ];
}

// ---------------------------------------------------------------------------
// Part B
// ---------------------------------------------------------------------------

function buildPartB(opts: ChecklistOptions): readonly ChecklistItem[] {
  const world = opts.world;
  const doc = world.doc;
  const rooms = doc.rooms;

  const counts = countKinds(rooms);
  const roomSummary = counts.length > 0 ? counts.join(', ') : 'no rooms were surveyed';
  const areaFigures = opts.figures.filter((f) => f.id.endsWith(':area') && f.id.startsWith('room:'));
  const levels = [...new Set(doc.floors.map((f) => f.level))].sort((a, b) => a - b);

  const items: ChecklistItem[] = [
    {
      id: 'b-property-type',
      part: 'B',
      label: 'Property type',
      guidance: 'Detached, semi-detached, terraced, flat, maisonette, bungalow, and the '
        + 'approximate age or period.',
      answer: {
        state: 'unanswered',
        reason: 'The survey records the inside of this property, not how it sits against its '
          + 'neighbours, so it cannot tell a mid-terrace from a semi. Guessing from the room '
          + 'layout would be exactly the kind of plausible invention this document refuses.',
      },
      evidence: [
        `The survey records ${rooms.length} room${rooms.length === 1 ? '' : 's'} across `
        + `${levels.length} level${levels.length === 1 ? '' : 's'}`
        + `${levels.length > 0 ? ` (${levels.map(levelWord).join(', ')})` : ''}.`,
        ...(hasKind(rooms, 'stairwell') || doc.nav.edges.some((e) => e.kind === 'stair')
          ? ['A change of level was recorded inside the property.']
          : ['No internal change of level was recorded on the walkable route.']),
      ],
      input: 'text',
      placeholder: 'e.g. Ground-floor flat in a Victorian conversion',
    },
    {
      id: 'b-construction',
      part: 'B',
      label: 'Construction materials',
      guidance: 'Walls, roof and windows, and anything non-standard: timber frame, single '
        + 'skin, thatch, concrete panel, spray foam insulation.',
      answer: {
        state: 'unanswered',
        reason: 'A reconstruction records the shape and position of a surface, never what it is '
          + 'made of. Nothing in this survey supports a statement about construction.',
      },
      evidence: [],
      input: 'longtext',
      placeholder: 'e.g. Solid brick walls, slate roof, uPVC double glazing',
    },
    {
      id: 'b-rooms',
      part: 'B',
      label: 'Number and type of rooms',
      guidance: 'Every room, described as a buyer would describe it. Room counts that differ '
        + 'between the listing and the floorplan are a common source of complaints.',
      answer: {
        state: 'from-survey',
        value: `${rooms.length} room${rooms.length === 1 ? '' : 's'}: ${roomSummary}.`,
      },
      evidence: rooms.map((r) => `${r.name ?? r.id} — recorded as ${kindWord(r.kind)}`
        + `${humanNamed(r) ? ', named by an operator' : ''}.`),
    },
    {
      id: 'b-room-sizes',
      part: 'B',
      label: 'Room measurements',
      guidance: 'Where room sizes are quoted, they must be accurate and must say what standard '
        + 'they are measured to.',
      answer: {
        state: 'from-survey',
        value: `${areaFigures.length} measured floor area`
          + `${areaFigures.length === 1 ? '' : 's'}, each with its standard and tolerance. `
          + 'The measurement certificate is the document to issue with these.',
        figures: areaFigures,
      },
      evidence: indicativeWarning(areaFigures),
    },
    {
      id: 'b-utilities',
      part: 'B',
      label: 'Utilities: electricity, gas, water, sewerage, heating',
      guidance: 'The supply type for each, and whether any is not connected. Mains, private '
        + 'supply, septic tank, oil, LPG, none.',
      answer: {
        state: 'unanswered',
        reason: 'Not visible to a survey. A boiler in a cupboard is an object the survey may '
          + 'have seen; the supply behind it is not.',
      },
      evidence: applianceEvidence(world),
      input: 'longtext',
      placeholder: 'e.g. Mains electricity, gas and water; mains drainage; gas central heating',
    },
    {
      id: 'b-broadband-mobile',
      part: 'B',
      label: 'Broadband and mobile signal',
      guidance: 'Available broadband type and speed, and indoor mobile coverage by network.',
      answer: {
        state: 'unanswered',
        reason: 'Not measurable from a visual survey. Ofcom\'s checker is the usual source.',
      },
      evidence: [],
      input: 'longtext',
      placeholder: 'e.g. FTTP available, up to 900 Mbps; indoor 4G on all four networks',
    },
    {
      id: 'b-parking',
      part: 'B',
      label: 'Parking',
      guidance: 'Allocated space, garage, driveway, on-street with or without a permit, or '
        + 'none. Where a permit is needed, say so.',
      answer: {
        state: 'unanswered',
        reason: 'Parking is a right as much as a space, and a survey of the inside of a '
          + 'property cannot see either.',
      },
      evidence: garageEvidence(opts),
      input: 'longtext',
      placeholder: 'e.g. One allocated space; residents\' permit zone C',
    },
  ];
  return items;
}

// ---------------------------------------------------------------------------
// Part C
// ---------------------------------------------------------------------------

function buildPartC(opts: ChecklistOptions): readonly ChecklistItem[] {
  const unanswerable = (reason: string) => ({ state: 'unanswered' as const, reason });
  return [
    {
      id: 'c-flood',
      part: 'C',
      label: 'Flood risk and flood history',
      guidance: 'Risk from rivers, sea, surface water and groundwater, and whether the '
        + 'property has flooded in the last five years.',
      answer: unanswerable('A flood record is a searches fact. Nothing in an interior survey '
        + 'speaks to it.'),
      evidence: [],
      input: 'longtext',
      placeholder: 'e.g. Environment Agency: low risk from rivers and sea; no flooding in 5 years',
    },
    {
      id: 'c-cladding',
      part: 'C',
      label: 'Building safety: cladding and external wall system',
      guidance: 'For flats: the EWS1 position, any remediation, and any waking watch. For '
        + 'houses: any known building-safety defect.',
      answer: unanswerable('An interior survey sees no external wall system. This comes from '
        + 'the freeholder or managing agent.'),
      evidence: [],
      input: 'longtext',
    },
    {
      id: 'c-asbestos',
      part: 'C',
      label: 'Asbestos',
      guidance: 'Any known asbestos-containing material, any survey or management plan.',
      answer: unanswerable('Asbestos is identified by sampling, never by sight and never by a '
        + 'camera. A survey that claimed to have looked for it would be dangerous.'),
      evidence: [],
      input: 'longtext',
    },
    {
      id: 'c-covenants',
      part: 'C',
      label: 'Restrictive covenants, rights and easements',
      guidance: 'Covenants, shared access, rights of way over or under the property, and any '
        + 'obligation to contribute to a shared cost.',
      answer: unanswerable('A matter of title. Not held in this system.'),
      evidence: [],
      input: 'longtext',
    },
    {
      id: 'c-tpo-listing',
      part: 'C',
      label: 'Tree preservation orders, listing and conservation area',
      guidance: 'Any TPO, listed status at any grade, conservation area, or article 4 '
        + 'direction restricting permitted development.',
      answer: unanswerable('A planning fact, held by the local authority.'),
      evidence: [],
      input: 'longtext',
    },
    {
      id: 'c-accessibility',
      part: 'C',
      label: 'Accessibility and adaptations',
      guidance: 'Step-free access, level-access shower or wet room, ramped access, stair lift, '
        + 'widened doorways, and any other adaptation.',
      answer: {
        state: 'unanswered',
        reason: 'An adaptation is a claim about what the property provides, and the survey '
          + 'measures what is there rather than what it is for. The observations below are '
          + 'evidence towards this item; they are not an answer to it and must not be copied '
          + 'into a listing as one.',
      },
      evidence: accessibilityObservations(opts.world, opts.locale ?? 'en-GB'),
      input: 'longtext',
      placeholder: 'e.g. Level access from the street; wet room; no stair lift',
    },
    {
      id: 'c-planning',
      part: 'C',
      label: 'Alterations, planning permissions and building regulations',
      guidance: 'Any extension, conversion or structural alteration, with the consents and '
        + 'completion certificates for each.',
      answer: {
        state: 'unanswered',
        reason: 'The survey shows the property as it now stands. It has no knowledge of what it '
          + 'looked like before, or of what was consented.',
      },
      evidence: [],
      input: 'longtext',
    },
    {
      id: 'c-coastal-mining',
      part: 'C',
      label: 'Coastal erosion, mining and ground stability',
      guidance: 'Required where the property is in a coalfield, a brine or mining area, or a '
        + 'coastal change management area.',
      answer: unanswerable('A searches fact, from the Coal Authority or the local authority.'),
      evidence: [],
      input: 'longtext',
    },
  ];
}

// ---------------------------------------------------------------------------
// What the survey can say
// ---------------------------------------------------------------------------

/**
 * Accessibility observations from the navigation graph.
 *
 * These are real measurements of real geometry and they are deliberately
 * phrased as observations rather than as conclusions. "The narrowest doorway
 * on the walkable route is 838 mm" is a fact this survey can defend. "The
 * property is wheelchair accessible" is a conclusion involving turning
 * circles, thresholds, floor surfaces, the approach from the street and the
 * person doing the wheeling, and nothing in a reconstruction supports it.
 *
 * The nav graph is the right source rather than the opening list: it is the
 * set of doorways a visitor actually passes through to get around, so a
 * cupboard door does not become the narrowest doorway in the property.
 */
export function accessibilityObservations(world: World, locale = 'en-GB'): readonly string[] {
  const doc = world.doc;
  const out: string[] = [];

  const entrance = doc.nav.nodes.find((n) => n.isEntrance);
  if (!entrance) {
    out.push('The survey records no entrance node, so no route through the property could be '
      + 'traced and no observation below covers the approach from outside.');
  }

  const doorEdges = doc.nav.edges.filter((e) => e.kind === 'door' && e.openingId);
  const widths = doorEdges
    .map((e) => ({ edge: e, opening: e.openingId ? world.opening(e.openingId) : undefined }))
    .filter((x): x is { edge: NavEdge; opening: NonNullable<ReturnType<World['opening']>> } =>
      x.opening !== undefined && x.opening.width !== undefined);

  if (widths.length === 0) {
    out.push('No doorway on the walkable route carries a measured width, so the survey cannot '
      + 'say how wide the narrowest one is.');
  } else {
    const narrowest = widths.reduce((a, b) => (
      (b.opening.width!.value < a.opening.width!.value ? b : a)
    ));
    const formatted = formatQuantity(narrowest.opening.width!, { locale });
    const where = describeOpening(world, narrowest.opening.id);
    out.push(`The narrowest doorway on the walkable route is ${formatted.value}, `
      + `${formatted.tolerance}${where ? ` (${where})` : ''}. `
      + `${widths.length} doorway${widths.length === 1 ? '' : 's'} on the route carry a `
      + 'measured width.');
  }

  const stairs = doc.nav.edges.filter((e) => e.kind === 'stair');
  out.push(stairs.length === 0
    ? 'The walkable route records no stair, so no change of level was measured between the '
      + 'surveyed rooms. This says nothing about the approach from the street, which the '
      + 'survey did not measure.'
    : `The walkable route includes ${stairs.length} stair `
      + `connection${stairs.length === 1 ? '' : 's'} between surveyed rooms.`);

  const clearances = doc.nav.nodes.filter((n) => Number.isFinite(n.clearance));
  if (clearances.length > 0) {
    const tightest = clearances.reduce((a, b) => (b.clearance < a.clearance ? b : a));
    const room = tightest.roomId ? world.room(tightest.roomId) : undefined;
    out.push(`The tightest measured clearance on the walkable route is `
      + `${tightest.clearance.toFixed(2)} m${room ? `, in the ${lower(room.name ?? room.id)}` : ''}. `
      + 'Clearance here is the radius of free space at a point on the route, not a turning '
      + 'circle.');
  }

  const unsurveyed = doc.regions.filter((r) => r.provenance !== 'observed');
  if (unsurveyed.length > 0) {
    out.push(`${unsurveyed.length} part${unsurveyed.length === 1 ? '' : 's'} of this property `
      + 'were estimated or never photographed. Any accessibility statement about those parts '
      + 'rests on nothing.');
  }

  return out;
}

function describeOpening(world: World, openingId: string): string | null {
  const opening = world.opening(openingId);
  if (!opening) return null;
  const a = opening.roomA ? world.room(opening.roomA) : undefined;
  const b = opening.roomB ? world.room(opening.roomB) : undefined;
  if (a && b) return `${a.name ?? a.id} to ${b.name ?? b.id}`;
  return a ? `into ${a.name ?? a.id}` : b ? `into ${b.name ?? b.id}` : null;
}

function applianceEvidence(world: World): readonly string[] {
  const appliances = world.doc.entities.filter((e) => e.category === 'appliance');
  if (appliances.length === 0) return [];
  return [
    `The survey recorded ${appliances.length} appliance`
    + `${appliances.length === 1 ? '' : 's'}: ${appliances.map((e) => e.label).join(', ')}. `
    + 'An appliance in a room is not evidence of the supply behind it.',
  ];
}

function garageEvidence(opts: ChecklistOptions): readonly string[] {
  const garages = opts.world.doc.rooms.filter((r) => r.kind === 'garage');
  if (garages.length === 0) return [];
  return garages.map((r) => {
    const figure = opts.figures.find((f) => f.id === `room:${r.id}:area`);
    return `The survey includes ${r.name ?? r.id}, recorded as a garage`
      + `${figure ? `, ${figure.formatted.value} ${figure.formatted.tolerance}` : ''}. `
      + 'Whether it conveys with the property is a matter of title.';
  });
}

function indicativeWarning(figures: readonly Figure[]): readonly string[] {
  const indicative = figures.filter((f) => f.presentation.includes('indicative'));
  if (indicative.length === 0) {
    return ['Every measured area is defensible against the geometry that produced it.'];
  }
  return [
    `${indicative.length} of these areas ${indicative.length === 1 ? 'is' : 'are'} indicative `
    + 'rather than defensible, and must not be quoted in a listing as a measurement: '
    + `${indicative.map((f) => f.subject).join(', ')}. The measurement certificate gives the `
    + 'reason for each.',
  ];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function summarySection(
  opts: ChecklistOptions, items: readonly ChecklistItem[], unanswered: number,
): DocSection {
  const answered = items.length - unanswered;
  const blocks: DocBlock[] = [
    {
      kind: 'facts',
      pairs: [
        ['Property', opts.reference.propertyLabel],
        ...(opts.reference.propertyRef
          ? [['Agency reference', opts.reference.propertyRef] as const] : []),
        ...(opts.reference.postcode ? [['Postcode', opts.reference.postcode] as const] : []),
        ['Survey', `Version ${opts.reference.worldVersion}`],
        ['Prepared', humanDateTime(opts.issuedAt)],
        ['Items on this checklist', String(items.length)],
        ['Answered from the survey', String(answered)],
        ['Still unanswered', String(unanswered)],
      ],
    },
  ];

  blocks.push(unanswered === 0
    ? {
      kind: 'note',
      tone: 'info',
      heading: 'Every item on this checklist has been answered',
      text: 'Check each answer against its source before the listing is published. An answer '
        + 'carried over from a previous instruction is not an answer to this one.',
    }
    : {
      kind: 'note',
      tone: 'warn',
      heading: `This checklist is not complete: ${unanswered} of ${items.length} items are `
        + 'unanswered',
      text: 'It must not be filed, sent or relied on in this state. Each unanswered item below '
        + 'says why the survey cannot supply it and leaves a space for the person who can. '
        + 'Under the DMCC Act an omission is unfair whether or not it changed anyone\'s '
        + 'decision, so an item left blank is not a smaller problem than a wrong answer.',
    });

  return { id: 'summary', heading: 'Where this checklist stands', level: 2, blocks };
}

function evidenceSection(opts: ChecklistOptions): DocSection {
  return {
    id: 'evidence',
    heading: 'What the survey contributed, and what it cannot',
    level: 2,
    blocks: [
      {
        kind: 'list',
        intro: 'Answered from the survey, and defensible as measurements:',
        items: [
          'The number of rooms and the kind recorded for each.',
          'The measured floor area of every room, with its standard and its tolerance. The '
          + 'measurement certificate is the document that defends them.',
        ],
      },
      {
        kind: 'list',
        intro: 'Offered as evidence but NOT as answers. Each of these is a measurement of the '
          + 'building, not a statement about the property:',
        items: [
          'Doorway widths and changes of level on the walkable route, under accessibility.',
          'Objects the survey recognised, under utilities. A boiler is an object; a gas supply '
          + 'is not.',
          'A room recorded as a garage, under parking. Whether it conveys is a matter of title.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Everything else on this checklist is an agency fact, a title fact, a searches '
          + 'fact or a planning fact. The survey has no opinion about any of them, and this '
          + 'document does not generate one.',
      },
      {
        kind: 'note',
        tone: 'warn',
        heading: 'Answers typed here are not stored',
        text: 'This system has no table for material information and no endpoint that would '
          + 'write one. Anything typed into this checklist lives in this browser tab and is '
          + 'gone when it closes. Print this page, or copy the answers into whatever your '
          + 'agency files, before you navigate away.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hasKind(rooms: readonly Room[], kind: RoomKind): boolean {
  return rooms.some((r) => r.kind === kind);
}

function humanNamed(room: Room): boolean {
  return (room.grounding.sources ?? []).some((s) => s.startsWith('correction:'));
}

function countKinds(rooms: readonly Room[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rooms) {
    const word = kindWord(r.kind);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([word, n]) => `${n} ${n === 1 ? word : plural(word)}`);
}

function kindWord(kind: RoomKind): string {
  switch (kind) {
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
    default: return 'room of no recorded kind';
  }
}

function plural(word: string): string {
  if (word.endsWith('y') && !/[aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

function levelWord(level: number): string {
  if (level === 0) return 'ground floor';
  if (level < 0) return `basement ${Math.abs(level)}`;
  return `floor ${level}`;
}

function lower(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}
