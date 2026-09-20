import type { Grounding, Opening, Quantity, Room, WorldDocument } from '@m3xi/world-core';
import { Evidence, lengthQuantity, type World } from '@m3xi/spatial-engine';
import type {
  ComplianceDocument, DocBlock, DocSection, DocumentReference, Figure, UnpresentableFigure,
} from './document.js';
import { humanDate, humanDateTime } from './document.js';
import {
  attachMeasurements, buildFigure, declaredQuantity, readDeclaredBasis,
  type AttachedMeasurements,
} from './figures.js';
import type { MeasurementRecord, PropertyFacts, WorldFacts } from './sources.js';

/**
 * THE MEASUREMENT CERTIFICATE
 * ===========================
 *
 * Every dimension this world can show a customer, with the standard it was
 * measured against, the tolerance it was measured to, the confidence behind it
 * and what produced it -- timestamped, and reissuable so that the copy in a
 * file and the copy on the screen can be compared line by line.
 *
 * Four decisions shape it.
 *
 * 1. THE ENGINE DECIDES DEFENSIBILITY, NOT THIS FILE. `isDefensible(q)` is
 *    read, never recomputed. A figure it refuses is printed as INDICATIVE with
 *    the reason in the same words the viewer shows a buyer, because a
 *    certificate that describes a measurement differently from the tour it
 *    certifies is worth nothing in the argument it exists for.
 *
 * 2. NOTHING IS OMITTED. Not the bedroom whose corner is model infill, not the
 *    figure whose quantity is malformed. The first is shown as indicative; the
 *    second is shown as a named failure. An omission is automatically unfair
 *    under the DMCC Act regardless of whether it changed anyone's decision,
 *    and the figures most likely to be omitted are exactly the ones that would.
 *
 * 3. A HUMAN DECLARATION IS A DIFFERENT CLAIM AND PRINTS DIFFERENTLY. The
 *    world document carries the operator's NUMBER but not their METHOD -- by
 *    design, because `correction_sources` is a receipt for the row and
 *    stamping it onto a derived area would claim a person measured something
 *    nobody touched. The method lives in `wv_measurement.basis`. Where those
 *    records are supplied the certificate prints the method, the instrument,
 *    who, when, and the reconstruction's own figure that the declaration
 *    superseded. Where they are not, it says so, and does not guess.
 *
 * 4. THE DOCUMENT IS A FUNCTION OF THE WORLD. Same world, same numbers, same
 *    fingerprint. `issuedAt` is the only thing that moves between two issues
 *    of an unchanged world, and it is printed rather than hidden so that two
 *    copies can be told apart at a glance and still reconciled.
 */

export interface CertificateOptions {
  readonly world: World;
  readonly reference: DocumentReference;
  /** `wv_measurement` rows for this world, when a source supplied them. */
  readonly measurements?: readonly MeasurementRecord[];
  /**
   * False when no source could be asked. Drives the paragraph that tells the
   * reader whether "no declared measurements" means none exist or none were
   * read -- two facts a compliance document must never conflate.
   */
  readonly measurementsAvailable: boolean;
  readonly measurementsError?: string;
  /** From `getWorld`. Null means no correction has ever touched this world. */
  readonly lastCorrectionAt?: string | null;
  readonly previousIssue?: CertificateIssue;
  readonly issuedAt: string;
  readonly locale?: string;
}

/**
 * What a certificate is compared against when it is reissued.
 *
 * Small on purpose: an issue record is meant to be stored beside the PDF, in
 * whatever an agency uses for files, and read back years later by software
 * that may not exist yet. It carries the figures, not the prose.
 */
export interface CertificateIssue {
  readonly issuedAt: string;
  readonly worldId: string;
  readonly worldVersion: number;
  readonly fingerprint: string;
  readonly figures: readonly IssueFigure[];
}

export interface IssueFigure {
  readonly id: string;
  readonly subject: string;
  readonly what: string;
  readonly value: number;
  readonly unit: string;
  readonly standard: string;
  readonly tolerance: number;
  readonly toleranceUnit: string;
  readonly presentation: string;
}

export interface Certificate {
  readonly document: ComplianceDocument;
  readonly issue: CertificateIssue;
  readonly figures: readonly Figure[];
  readonly unpresentable: readonly UnpresentableFigure[];
}

/**
 * THE SCHEDULE IS BLOCKS, NOT A TABLE, AND THAT IS A PRINT DECISION.
 *
 * Each dimension has to carry six things: what it is, the figure, the
 * tolerance, the standard, the confidence and what produced it -- and the last
 * of those is a sentence. Six columns, two of them prose, measured 994 CSS
 * pixels against a 673-pixel A4 text width when this was a table, so the right
 * hand of every row fell off the page. A table that is clipped in print is
 * worse than no table, because the figure survives and the reason it is
 * indicative does not.
 *
 * Narrowing the columns was tried and does not work: the prose is the point.
 * Dropping the basis column was tried and is a worse document: "the geometry
 * that produced it" is what makes a certificate defensible rather than
 * decorative. So each figure is a block -- heading line, figure line, then its
 * confidence and its basis in small print -- which wraps to any width, never
 * breaks across a page, and reads the way a surveyor's schedule of dimensions
 * already reads.
 *
 * Tables survive in this package only where every cell is short: the privacy
 * report's category counts, and the human review log.
 */

export function buildCertificate(opts: CertificateOptions): Certificate {
  const world = opts.world;
  const doc = world.doc;
  const locale = opts.locale ?? 'en-GB';

  // Pass one: every dimension the world carries, as an engine figure. Pass two
  // replaces the ones a person has since declared. Two passes rather than one
  // because a declared measurement is matched by figure id, and the ids are
  // only known once the world has been walked.
  const drafts = collectDrafts(world);
  const knownIds = new Set(drafts.map((d) => d.id));
  const attached = attachMeasurements(opts.measurements ?? [], knownIds);

  const figures: Figure[] = [];
  const unpresentable: UnpresentableFigure[] = [];
  for (const draft of drafts) {
    const record = attached.current.get(draft.id);
    const built = record
      ? buildFigure({
        id: draft.id,
        subject: draft.subject,
        what: draft.what,
        quantity: declaredQuantity(record, draft.rowGrounding),
        basis: draft.basis,
        rowGrounding: draft.rowGrounding,
        declared: readDeclaredBasis(record.basis),
      }, locale)
      : buildFigure({
        id: draft.id,
        subject: draft.subject,
        what: draft.what,
        quantity: draft.quantity,
        basis: draft.basis,
        rowGrounding: draft.rowGrounding,
      }, locale);
    if (built.ok) figures.push(built.figure); else unpresentable.push(built.figure);
  }

  const issue = issueRecord(opts.issuedAt, doc, figures);
  const sections: DocSection[] = [
    identitySection(opts, doc, figures),
    howToReadSection(doc),
    ...roomSections(world, figures),
    ...openingsSections(figures),
    declarationsSection(opts, attached, figures),
    reissueSection(opts, issue),
  ];
  if (unpresentable.length > 0) sections.push(unpresentableSection(unpresentable));

  return {
    document: {
      kind: 'measurement-certificate',
      title: 'Measurement certificate',
      subtitle: opts.reference.propertyLabel,
      issuedAt: opts.issuedAt,
      reference: opts.reference,
      standing: STANDING,
      sections,
    },
    issue,
    figures,
    unpresentable,
  };
}

const STANDING: readonly string[] = [
  'This certificate states every dimension held for this property, the standard each one is '
  + 'measured against, the tolerance it is measured to and what produced it. It is issued from '
  + 'the survey named below and can be reissued from it unchanged.',
  'It is not a RICS measured building survey and it is not a valuation. Where a figure was '
  + 'declared by a person rather than measured by the reconstruction, it says so, and says with '
  + 'what.',
  'A figure this system will not stand behind is shown here marked INDICATIVE, with the reason. '
  + 'It is not omitted, because a dimension left out of a certificate reads as a dimension with '
  + 'nothing wrong with it.',
];

// ---------------------------------------------------------------------------
// Collecting the world's dimensions
// ---------------------------------------------------------------------------

interface FigureDraft {
  readonly id: string;
  readonly subject: string;
  readonly what: string;
  readonly quantity: Quantity;
  readonly basis: string;
  readonly rowGrounding: Grounding;
  readonly roomId?: string;
}

function collectDrafts(world: World): readonly FigureDraft[] {
  const doc = world.doc;
  const drafts: FigureDraft[] = [];

  for (const room of doc.rooms) {
    const name = roomName(room);
    drafts.push({
      id: `room:${room.id}:area`,
      subject: name,
      what: 'Floor area',
      // The ENGINE's area, not the document's stored one. They are the same
      // number in a healthy world; where they differ, the difference is a fact
      // about the world and `areaDiscrepancy` prints it rather than picking a
      // winner quietly.
      quantity: world.measureArea(room.id),
      basis: areaBasisSentence(room),
      rowGrounding: room.grounding,
      roomId: room.id,
    });
    drafts.push({
      id: `room:${room.id}:ceilingHeight`,
      subject: name,
      what: 'Floor to ceiling',
      quantity: ceilingHeightQuantity(world, room),
      basis: 'Derived from the floor and ceiling planes this room was reconstructed with, '
        + 'widened for the weaker of the two and for any estimated or unsurveyed volume '
        + 'between them.',
      rowGrounding: room.grounding,
      roomId: room.id,
    });
  }

  for (const opening of doc.openings) {
    const subject = openingName(world, opening);
    const basis = 'Fitted to the opening in the reconstructed wall surface.';
    if (opening.width) {
      drafts.push({
        id: `opening:${opening.id}:width`,
        subject,
        what: 'Width',
        quantity: opening.width,
        basis,
        rowGrounding: opening.grounding,
      });
    }
    if (opening.height) {
      drafts.push({
        id: `opening:${opening.id}:height`,
        subject,
        what: 'Height',
        quantity: opening.height,
        basis,
        rowGrounding: opening.grounding,
      });
    }
    if (opening.sill) {
      drafts.push({
        id: `opening:${opening.id}:sill`,
        subject,
        what: 'Sill above floor',
        quantity: opening.sill,
        basis,
        rowGrounding: opening.grounding,
      });
    }
  }

  for (const surface of doc.surfaces) {
    if (!surface.area) continue;
    const room = surface.roomId ? world.room(surface.roomId) : undefined;
    drafts.push({
      id: `surface:${surface.id}:area`,
      subject: `${room ? `${roomName(room)}, ` : ''}${surface.kind}`,
      what: 'Surface area',
      quantity: surface.area,
      basis: 'Area of the reconstructed surface polygon.',
      rowGrounding: surface.grounding,
      ...(surface.roomId ? { roomId: surface.roomId } : {}),
    });
  }

  return drafts;
}

/**
 * Floor-to-ceiling height, built from the world's own planes.
 *
 * `Room` stores `floorZ` and `ceilingZ` as bare numbers, so a height is not a
 * `Quantity` anywhere in the contract -- and a certificate that printed
 * "2.40 m" with no tolerance would be doing the exact thing this system
 * refuses. Two options were considered.
 *
 *   -- Leave heights out. Cheap, and wrong twice: `dimension.set` has a
 *      `room.ceilingHeight` target, so an operator can declare one and it
 *      would have nowhere to print; and a ceiling height is the dimension a
 *      buyer of a period flat asks about first.
 *
 *   -- Add it to `@m3xi/spatial-engine`. The right long-term home, and not
 *      this package's file to change.
 *
 * So it is derived here, THROUGH the engine's own primitives rather than
 * beside them: `Evidence` accumulates the room's grounding, the ceiling
 * surface's grounding and the provenance of any region sitting in the ceiling
 * band, and `lengthQuantity` applies the document's wall tolerance and the
 * provenance factor. A bathroom whose ceiling was never in view comes out
 * inferred, widened and not defensible, which is the correct answer and is
 * arrived at by the same arithmetic as every other length in the system.
 */
export function ceilingHeightQuantity(world: World, room: Room): Quantity {
  const doc = world.doc;
  const evidence = new Evidence();
  evidence.addGrounding(room.grounding);

  const ceiling = doc.surfaces.find((s) => s.roomId === room.id && s.kind === 'ceiling');
  if (ceiling) evidence.addGrounding(ceiling.grounding);
  const floor = doc.surfaces.find((s) => s.roomId === room.id && s.kind === 'floor');
  if (floor) evidence.addGrounding(floor.grounding);

  // Only regions that sit in the band the measurement crosses matter. A
  // generated void ABOVE the ceiling says nothing about the height of the room
  // below it, and treating it as though it did would make every flat with an
  // unscanned loft report indicative ceilings.
  const bounds = ringBoundsXZ(room);
  const band = {
    min: [bounds.minX, room.floorZ - 0.05, bounds.minZ] as const,
    max: [bounds.maxX, room.ceilingZ + 0.05, bounds.maxZ] as const,
  };
  for (const region of doc.regions) {
    if (!overlaps(band, region.volume)) continue;
    evidence.addProvenance(region.provenance);
    if (region.provenance !== 'observed') evidence.markUnobserved();
  }

  const height = room.ceilingZ - room.floorZ;
  return lengthQuantity(doc, Number.isFinite(height) ? height : 0, evidence, {
    segments: 1,
    basis: {
      kind: 'floor-to-ceiling',
      roomId: room.id,
      floorZ: room.floorZ,
      ceilingZ: room.ceilingZ,
      ceilingSurfaceId: ceiling?.id,
    },
  });
}

interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number }

function ringBoundsXZ(room: Room): Bounds {
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  for (const v of room.polygon) {
    if (v[0] < minX) minX = v[0];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] < minZ) minZ = v[1];
    if (v[1] > maxZ) maxZ = v[1];
  }
  return Number.isFinite(minX)
    ? { minX, minZ, maxX, maxZ }
    : { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
}

function overlaps(
  a: { min: readonly number[]; max: readonly number[] },
  b: { min: readonly number[]; max: readonly number[] },
): boolean {
  for (let i = 0; i < 3; i++) {
    if ((a.max[i] ?? 0) < (b.min[i] ?? 0) || (a.min[i] ?? 0) > (b.max[i] ?? 0)) return false;
  }
  return true;
}

function areaBasisSentence(room: Room): string {
  return `Computed from the room outline: ${room.polygon.length} vertices on the XZ plane, `
    + 'wall face to wall face, with the tolerance widened for a long thin room because a '
    + 'wall-position error moves its area proportionally more.';
}

function roomName(room: Room): string {
  return room.name ?? room.id;
}

function openingName(world: World, opening: Opening): string {
  const a = opening.roomA ? world.room(opening.roomA) : undefined;
  const b = opening.roomB ? world.room(opening.roomB) : undefined;
  const kind = capitalise(opening.kind);
  if (a && b) return `${kind}, ${roomName(a)} to ${roomName(b)}`;
  if (a) return `${kind} in ${roomName(a)}`;
  if (b) return `${kind} in ${roomName(b)}`;
  return `${kind} ${opening.id}`;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function identitySection(
  opts: CertificateOptions, doc: WorldDocument, figures: readonly Figure[],
): DocSection {
  const ref = opts.reference;
  const indicative = figures.filter((f) => f.presentation.includes('indicative')).length;
  const declared = figures.filter((f) => f.declared).length;

  const pairs: (readonly [string, string])[] = [
    ['Property', ref.propertyLabel],
    ...(ref.propertyRef ? [['Agency reference', ref.propertyRef] as const] : []),
    ...(ref.postcode ? [['Postcode', ref.postcode] as const] : []),
    ['Survey', `Version ${ref.worldVersion}, created ${humanDate(ref.surveyedAt)}`],
    ['Survey identifier', ref.worldId],
    ['Issued', humanDateTime(opts.issuedAt)],
    ['Dimensions certified', String(figures.length)],
    ['Shown as indicative', String(indicative)],
    ['Declared by a person', String(declared)],
    ['Measurement standard for areas', standardPhrase(doc.measurementPolicy.areaStandard)],
    ['Scale', `${doc.scale.source}, ${Math.round(doc.scale.agreement * 100)}% agreement `
      + 'between the estimators'],
  ];

  return {
    id: 'identity',
    heading: 'What this certificate covers',
    level: 2,
    blocks: [
      { kind: 'facts', pairs },
      {
        kind: 'paragraph',
        text: `${figures.length} dimensions are certified below. `
          + (indicative === 0
            ? 'Every one of them is defensible against the geometry that produced it.'
            : `${indicative} of them are shown as indicative: the survey produced a figure but `
              + 'will not stand behind it, and each one says why on its own line.'),
      },
    ],
  };
}

function howToReadSection(doc: WorldDocument): DocSection {
  const policy = doc.measurementPolicy;
  return {
    id: 'how-to-read',
    heading: 'How to read a figure in this document',
    level: 2,
    blocks: [
      {
        kind: 'paragraph',
        text: 'Every figure carries three things and is meaningless without all three: the '
          + 'value, the tolerance it was measured to, and the standard it was measured '
          + 'against. GIA, NIA and IPMS 3C give different numbers for the same building, so a '
          + 'stated area without its standard is not a measurement.',
      },
      {
        kind: 'list',
        intro: 'The status word on each line means:',
        items: [
          'MEASURED — computed from surveyed geometry. The system will stand behind it.',
          'INDICATIVE — a figure the survey produced but will not stand behind, because it '
          + 'crosses geometry that was estimated or never photographed. The reason is printed '
          + 'beside it.',
          'DECLARED — a person measured it on site with a named instrument. The method, the '
          + 'instrument, who and when are printed beside it, along with the figure it superseded.',
          'INDICATIVE (DECLARED) — a person stated it without measuring it, or measured it '
          + 'without naming what with. It is a human assertion, not an observation.',
        ],
      },
      {
        kind: 'paragraph',
        text: `Areas are stated to ${standardPhrase(policy.areaStandard)}, with a tolerance of at `
          + `least ${policy.areaTolerancePct}%. Lengths are clear internal — wall face to wall `
          + `face, no standard implied — to ±${policy.wallToleranceMm} mm per reconstructed `
          + 'segment. Where a length spans several segments the tolerances combine in '
          + 'quadrature rather than adding, because the errors are independent.',
      },
      {
        kind: 'paragraph',
        text: 'Where geometry was estimated rather than photographed, the tolerance is doubled; '
          + 'where it was generated by a model, quadrupled. That widening is applied by the '
          + 'measurement engine, not by this document.',
      },
    ],
  };
}

function roomSections(world: World, figures: readonly Figure[]): readonly DocSection[] {
  const byRoom = new Map<string, Figure[]>();
  for (const figure of figures) {
    const roomId = figure.id.startsWith('room:') ? figure.id.split(':')[1] : undefined;
    if (!roomId) continue;
    const list = byRoom.get(roomId);
    if (list) list.push(figure); else byRoom.set(roomId, [figure]);
  }

  const sections: DocSection[] = [{
    id: 'rooms',
    heading: 'Schedule of room dimensions',
    level: 2,
    pageBreakBefore: true,
    blocks: [{
      kind: 'paragraph',
      text: world.doc.rooms.length === 0
        ? 'This survey contains no rooms, so there are no room dimensions to certify.'
        : `One entry per dimension, for each of the ${world.doc.rooms.length} rooms in this `
          + 'survey. Each entry states the figure, the tolerance, the standard it is measured '
          + 'to, how confident the survey is in it and what produced it.',
    }],
  }];

  for (const room of world.doc.rooms) {
    const list = byRoom.get(room.id) ?? [];
    const blocks: DocBlock[] = list.map((figure) => ({ kind: 'figure', figure }));
    const discrepancy = areaDiscrepancy(world, room);
    if (discrepancy) blocks.push(discrepancy);
    if (blocks.length === 0) {
      blocks.push({
        kind: 'paragraph',
        text: 'No dimension in this survey could be certified for this room.',
      });
    }
    sections.push({ id: `room-${room.id}`, heading: roomName(room), level: 3, blocks });
  }

  return sections;
}

/**
 * The stored area and the recomputed area, when they disagree.
 *
 * `Room.area` is what the pipeline wrote; `world.measureArea` is what the
 * outline actually encloses. In a healthy world these agree to the last
 * millimetre. When they do not, one of two things happened -- the outline was
 * corrected without the area being recomputed, or the area was set without the
 * outline moving -- and both are worth a sentence on a certificate, because
 * whichever of the two numbers is right, the other one is in the database.
 *
 * The threshold is the stated tolerance itself, not an arbitrary epsilon: a
 * difference inside the tolerance is not a disagreement, it is the tolerance
 * doing its job.
 */
function areaDiscrepancy(world: World, room: Room): DocBlock | null {
  const stored = room.area;
  if (!stored || !Number.isFinite(stored.value)) return null;
  const measured = world.measureArea(room.id);
  const half = stored.toleranceUnit === 'pct'
    ? (stored.tolerance / 100) * Math.abs(stored.value)
    : stored.tolerance / 1000;
  const delta = Math.abs(measured.value - stored.value);
  if (delta <= Math.max(half, 1e-6)) return null;
  return {
    kind: 'note',
    tone: 'warn',
    heading: `${roomName(room)}: the stored area and the outline disagree`,
    text: `The survey stores ${stored.value.toFixed(2)} m² for this room, but its outline `
      + `encloses ${measured.value.toFixed(2)} m² — a difference of ${delta.toFixed(2)} m², `
      + `wider than the ±${stored.tolerance.toFixed(1)}${stored.toleranceUnit === 'pct' ? '%' : ' mm'} `
      + 'this figure claims. The certified figure above is the one computed from the outline. '
      + 'Rebuild the world, or correct the outline, before this certificate is relied on.',
  };
}

function openingsSections(figures: readonly Figure[]): readonly DocSection[] {
  const relevant = figures.filter(
    (f) => f.id.startsWith('opening:') || f.id.startsWith('surface:'),
  );

  const bySubject = new Map<string, Figure[]>();
  for (const figure of relevant) {
    const list = bySubject.get(figure.subject);
    if (list) list.push(figure); else bySubject.set(figure.subject, [figure]);
  }

  const sections: DocSection[] = [{
    id: 'openings',
    heading: 'Schedule of openings and surfaces',
    level: 2,
    pageBreakBefore: true,
    blocks: [{
      kind: 'paragraph',
      text: relevant.length === 0
        ? 'This survey records no dimensioned openings or surfaces.'
        : 'A door or window width here is the clear opening between the reveals, not the '
          + 'frame, and a sill height is measured from the finished floor.',
    }],
  }];

  for (const [subject, list] of bySubject) {
    sections.push({
      id: `opening-${list[0]!.id}`,
      heading: subject,
      level: 3,
      blocks: list.map((figure) => ({ kind: 'figure', figure })),
    });
  }

  return sections;
}

/**
 * The human declarations, gathered in one place.
 *
 * Two readers need this section and they need opposite things from it. An
 * agent wants to know which numbers on their particulars came off a laser. A
 * solicitor, later, wants to know which numbers came off a person at all. So
 * it lists every declaration with its method, its instrument, who and when,
 * and what it superseded -- and where the records could not be read, it says
 * that instead of showing an empty table.
 */
function declarationsSection(
  opts: CertificateOptions, attached: AttachedMeasurements, figures: readonly Figure[],
): DocSection {
  const blocks: DocBlock[] = [];
  const declared = figures.filter((f) => f.declared);

  if (!opts.measurementsAvailable) {
    blocks.push({
      kind: 'note',
      tone: 'bad',
      heading: 'Declared measurements could not be read',
      text: opts.measurementsError
        ? `This build could not read the measurement records for this world: `
          + `${opts.measurementsError} Any figure above that a person declared is therefore `
          + 'printed with the number they stated but without the method or the instrument '
          + 'behind it, and this certificate cannot tell you which figures those are.'
        : 'No source of measurement records was supplied to this build of the compliance '
          + 'centre, so this section is empty because nothing was read, not because nothing '
          + 'was declared. A declared dimension writes a wv_measurement row carrying its '
          + 'method, its instrument and the value it superseded; without that row a '
          + 'certificate can print the number but cannot say how it was arrived at.',
    });
    const touched = figures.filter((f) => f.humanTouched);
    if (touched.length > 0) {
      blocks.push({
        kind: 'paragraph',
        text: `${touched.length} of the figures above sit on rows carrying a human correction `
          + 'receipt, so a person has changed something about them. What, and by what method, '
          + 'is in the measurement records this build could not read.',
      });
    }
    return { id: 'declarations', heading: 'Figures declared by a person', level: 2, blocks };
  }

  if (declared.length === 0) {
    blocks.push({
      kind: 'paragraph',
      text: 'No dimension in this survey was declared by a person. Every figure above was '
        + 'computed from the surveyed geometry.',
    });
  } else {
    // Blocks again rather than a table, for the same reason the schedule is:
    // the method sentence is the content, and a column that holds a sentence
    // cannot be made narrow enough for A4 without clipping it.
    blocks.push({
      kind: 'paragraph',
      text: `${declared.length} dimension${declared.length === 1 ? '' : 's'} in this survey `
        + `${declared.length === 1 ? 'was' : 'were'} declared by a person rather than computed `
        + 'from the geometry. A declared site measurement carries the accuracy of the '
        + 'instrument it was taken with, which is tighter than the reconstruction\'s. A '
        + 'declared estimate carries the document policy widened for a human assertion, and is '
        + 'shown as indicative.',
    });
    for (const figure of declared) {
      blocks.push({ kind: 'figure', figure });
      blocks.push({
        kind: 'facts',
        pairs: [
          ['Stated by', figure.declared?.statedBy ?? 'not recorded'],
          ['Stated at', figure.declared?.statedAt
            ? humanDateTime(figure.declared.statedAt) : 'not recorded'],
          ['Correction record', figure.declared?.correctionId ?? 'not recorded'],
          ['Superseded figure', supersededText(figure)],
          ...(figure.declared?.note ? [['Operator note', figure.declared.note] as const] : []),
        ],
      });
    }
  }

  const restated = [...attached.superseded.entries()];
  if (restated.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'Dimensions that have been declared more than once. The current figure is above; '
        + 'the earlier readings are kept so a change of mind can be read rather than inferred:',
      items: restated.map(([figureId, records]) => {
        const figure = figures.find((f) => f.id === figureId);
        const subject = figure ? `${figure.subject}, ${lower(figure.what)}` : figureId;
        const readings = records
          .map((r) => `${r.value} ${r.unit} on ${humanDate(r.createdAt)}`)
          .join('; ');
        return `${subject}: ${records.length} earlier reading${records.length === 1 ? '' : 's'} — ${readings}.`;
      }),
    });
  }

  if (attached.unplaceable.length > 0) {
    blocks.push({
      kind: 'note',
      tone: 'warn',
      heading: 'Declared measurements that do not match anything in this survey',
      text: `${attached.unplaceable.length} measurement record`
        + `${attached.unplaceable.length === 1 ? '' : 's'} in this world name a subject that is `
        + 'not in the current version of it — usually a room or opening that a later build '
        + 'removed or renumbered. They are named here rather than dropped, because a '
        + 'measurement nobody can see is a measurement that might as well not have been taken: '
        + `${attached.unplaceable.map((r) => `${r.kind} ${r.value} ${r.unit} (${r.id})`).join('; ')}.`,
    });
  }

  return { id: 'declarations', heading: 'Figures declared by a person', level: 2, blocks };
}

function supersededText(f: Figure): string {
  const d = f.declared;
  if (!d || d.supersededValue === undefined) return 'none recorded';
  const unit = d.supersededToleranceUnit === 'pct' ? '%' : ' mm';
  const tolerance = d.supersededTolerance === undefined
    ? ''
    : ` ±${d.supersededTolerance}${unit}`;
  return `${d.supersededValue}${tolerance}`
    + `${d.supersededStandard ? ` (${d.supersededStandard})` : ''}`;
}

/**
 * Reissue.
 *
 * The question a reissued certificate has to answer is not "is this the same
 * document" -- the issue timestamp guarantees it is not -- but "are these the
 * same numbers". So the fingerprint covers the figures and nothing else, and
 * the diff below is figure by figure.
 *
 * `lastCorrectionAt` is the second half of the answer and it works even when
 * no previous issue was kept: the world itself knows when it was last edited.
 * A certificate issued before that moment is superseded whether or not anyone
 * kept a copy of it.
 */
function reissueSection(opts: CertificateOptions, issue: CertificateIssue): DocSection {
  const blocks: DocBlock[] = [
    {
      kind: 'facts',
      pairs: [
        ['Figure fingerprint', issue.fingerprint],
        ['Issued', humanDateTime(issue.issuedAt)],
        ['Survey version', String(issue.worldVersion)],
        ['Last correction to this survey', opts.lastCorrectionAt === null
          ? 'none — nothing in this survey has been edited'
          : opts.lastCorrectionAt === undefined
            ? 'not read by this build'
            : humanDateTime(opts.lastCorrectionAt)],
      ],
    },
    {
      kind: 'paragraph',
      text: 'The fingerprint is computed from every figure above: its subject, its value, its '
        + 'unit, its standard, its tolerance and its status. Two certificates of the same '
        + 'survey carry the same fingerprint however many times they are issued. A fingerprint '
        + 'that has changed means a figure has changed, and the section below says which.',
    },
  ];

  const previous = opts.previousIssue;
  if (!previous) {
    blocks.push({
      kind: 'paragraph',
      text: 'No previous issue of this certificate was supplied, so this document cannot say '
        + 'what has changed since one. It is a first issue as far as it can tell. Keep this '
        + 'fingerprint with the file: it is what makes the next reissue able to answer the '
        + 'question.',
    });
    if (opts.lastCorrectionAt) {
      blocks.push({
        kind: 'note',
        tone: 'info',
        heading: 'This survey has been corrected',
        text: `A correction was applied to this survey on ${humanDateTime(opts.lastCorrectionAt)}. `
          + 'Any certificate issued before that moment is superseded by this one, whether or '
          + 'not a copy of it was kept.',
      });
    }
    return { id: 'reissue', heading: 'Issue and reissue', level: 2, blocks };
  }

  const diff = compareIssues(previous, issue);
  blocks.push({
    kind: 'facts',
    pairs: [
      ['Previous issue', humanDateTime(previous.issuedAt)],
      ['Previous fingerprint', previous.fingerprint],
      ['Previous survey version', String(previous.worldVersion)],
    ],
  });

  if (diff.identical) {
    blocks.push({
      kind: 'paragraph',
      text: 'Every figure in this issue is identical to the previous one. This is a reissue of '
        + 'the same certificate: the same survey, the same numbers, a later timestamp.',
    });
    return { id: 'reissue', heading: 'Issue and reissue', level: 2, blocks };
  }

  blocks.push({
    kind: 'paragraph',
    text: `This issue differs from the previous one: ${diff.changed.length} figure`
      + `${diff.changed.length === 1 ? '' : 's'} changed, ${diff.added.length} added, `
      + `${diff.removed.length} no longer present.`,
  });
  if (diff.changed.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'Changed since the previous issue:',
      items: diff.changed.map((c) => `${c.subject}, ${lower(c.what)}: `
        + `was ${c.before.value} ${c.before.unit} ±${c.before.tolerance}`
        + `${c.before.toleranceUnit === 'pct' ? '%' : ' mm'} (${c.before.presentation}), `
        + `now ${c.after.value} ${c.after.unit} ±${c.after.tolerance}`
        + `${c.after.toleranceUnit === 'pct' ? '%' : ' mm'} (${c.after.presentation}).`),
    });
  }
  if (diff.added.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'Present in this issue and not the previous one:',
      items: diff.added.map((f) => `${f.subject}, ${lower(f.what)}: ${f.value} ${f.unit}.`),
    });
  }
  if (diff.removed.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'In the previous issue and not this one. A dimension that has disappeared is a '
        + 'change to the property record, not a tidy-up:',
      items: diff.removed.map((f) => `${f.subject}, ${lower(f.what)}: was ${f.value} ${f.unit}.`),
    });
  }
  return { id: 'reissue', heading: 'Issue and reissue', level: 2, blocks };
}

function unpresentableSection(rows: readonly UnpresentableFigure[]): DocSection {
  return {
    id: 'unpresentable',
    heading: 'Dimensions that cannot be certified',
    level: 2,
    blocks: [
      {
        kind: 'paragraph',
        text: `${rows.length} dimension${rows.length === 1 ? '' : 's'} in this survey cannot be `
          + 'printed as a figure. This is a fault in the survey data, not a property of the '
          + 'building, and it is named here rather than omitted so that it can be fixed.',
      },
      ...rows.map((row): DocBlock => ({ kind: 'unpresentable', figure: row })),
    ],
  };
}

function standardPhrase(standard: string): string {
  switch (standard) {
    case 'RICS-COMP-GIA': return 'the RICS Code of Measuring Practice, gross internal area';
    case 'RICS-COMP-NIA': return 'the RICS Code of Measuring Practice, net internal area';
    case 'IPMS-3C': return 'IPMS 3C, measured to the internal dominant face';
    default: return 'clear internal dimensions, with no standard implied';
  }
}

function lower(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Issue records and the fingerprint
// ---------------------------------------------------------------------------

export function issueRecord(
  issuedAt: string, doc: WorldDocument, figures: readonly Figure[],
): CertificateIssue {
  const issueFigures: IssueFigure[] = figures.map((f) => ({
    id: f.id,
    subject: f.subject,
    what: f.what,
    value: round(f.value),
    unit: f.unit,
    standard: f.standard,
    tolerance: round(f.tolerance),
    toleranceUnit: f.toleranceUnit,
    presentation: f.presentation,
  }));
  return {
    issuedAt,
    worldId: doc.id,
    worldVersion: doc.version,
    fingerprint: fingerprint(issueFigures),
    figures: issueFigures,
  };
}

/**
 * Rounded before it is hashed, and before it is stored.
 *
 * Floating-point area arithmetic is reproducible on one machine and not
 * guaranteed to be identical in the last bit across engines. A fingerprint
 * that changed because a figure moved by 10^-15 m² would train its readers to
 * ignore it, which is worse than not having one. Six decimal places is a
 * thousandth of a millimetre: far below every tolerance in this system and far
 * above the noise floor.
 */
function round(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
}

/**
 * A 64-bit FNV-1a over the figures, as sixteen hex characters.
 *
 * Not a cryptographic hash and not presented as one: this detects change, it
 * does not resist an adversary who wants two different certificates to agree.
 * The tamper-evident version of this document is the signed PDF an agency
 * produces from it. Implemented here rather than taken from a library because
 * this package is allowed no dependencies, and because `crypto.subtle` is
 * asynchronous, which would make building a document asynchronous for a
 * checksum.
 *
 * Two 32-bit lanes with different offset bases rather than BigInt: the
 * arithmetic stays in 32-bit integer operations, which are exact in
 * JavaScript, and the result is the same on every engine.
 */
export function fingerprint(figures: readonly IssueFigure[]): string {
  const canonical = figures
    .map((f) => [f.id, f.value, f.unit, f.standard, f.tolerance, f.toleranceUnit, f.presentation].join('|'))
    .sort()
    .join('\n');
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x01000193)}`;
}

function fnv1a(input: string, offset: number): string {
  let hash = offset >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash * 16777619, in shifts, so it never leaves 32-bit integer territory.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface IssueDiff {
  readonly identical: boolean;
  readonly changed: readonly {
    readonly id: string;
    readonly subject: string;
    readonly what: string;
    readonly before: IssueFigure;
    readonly after: IssueFigure;
  }[];
  readonly added: readonly IssueFigure[];
  readonly removed: readonly IssueFigure[];
}

export function compareIssues(previous: CertificateIssue, current: CertificateIssue): IssueDiff {
  const before = new Map(previous.figures.map((f) => [f.id, f]));
  const after = new Map(current.figures.map((f) => [f.id, f]));

  const changed: IssueDiff['changed'][number][] = [];
  const added: IssueFigure[] = [];
  const removed: IssueFigure[] = [];

  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) { added.push(a); continue; }
    if (sameFigure(a, b)) continue;
    changed.push({ id, subject: a.subject, what: a.what, before: b, after: a });
  }
  for (const [id, b] of before) if (!after.has(id)) removed.push(b);

  return {
    identical: changed.length === 0 && added.length === 0 && removed.length === 0,
    changed,
    added,
    removed,
  };
}

function sameFigure(a: IssueFigure, b: IssueFigure): boolean {
  return a.value === b.value
    && a.unit === b.unit
    && a.standard === b.standard
    && a.tolerance === b.tolerance
    && a.toleranceUnit === b.toleranceUnit
    && a.presentation === b.presentation;
}

/** The reference block every document in this package prints in its header. */
export function referenceFrom(
  doc: WorldDocument, property: PropertyFacts | null, world: WorldFacts | null,
): DocumentReference {
  return {
    worldId: doc.id,
    worldVersion: doc.version,
    propertyId: doc.propertyId,
    propertyLabel: property?.label ?? doc.label,
    ...(property?.ref ? { propertyRef: property.ref } : {}),
    ...(property?.postcode ? { postcode: property.postcode } : {}),
    surveyedAt: doc.createdAt,
    ...(doc.publishedAt ?? world?.world.published_at
      ? { publishedAt: doc.publishedAt ?? world?.world.published_at ?? '' }
      : {}),
  };
}
