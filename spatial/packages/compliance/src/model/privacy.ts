import type {
  ComplianceDocument, DetectionRow, DocBlock, DocSection, DocumentReference,
} from './document.js';
import { humanDate, humanDateTime } from './document.js';
import {
  REDACTION_KINDS, type RedactionDetection, type RedactionSearchRecord,
} from './sources.js';

/**
 * THE PRIVACY AND REDACTION AUDIT
 * ===============================
 *
 * A data protection officer is handed this and asks one question: "did you
 * look for medication packaging in this tour?" A report that lists what was
 * REMOVED cannot answer it. Zero medication rows is consistent with a clean
 * flat and with a detector that never ran, and those are opposite answers to
 * a DPO.
 *
 * `wv_redaction` was built for exactly this: the pipeline inserts every
 * detection "whether or not it was applied, because the question this table
 * answers is 'did you look for medication packaging in this tour', and a table
 * that only holds what was removed cannot answer it". So this report is
 * organised around the search, not around the removals:
 *
 *   1. WHAT WAS LOOKED FOR      every category, with the evidence that it was
 *                               searched, and an explicit "no evidence" where
 *                               there is none
 *   2. WHAT WAS FOUND           counts per category, including the categories
 *                               that came back clean
 *   3. EVERY DETECTION          one row each, with what happened to the pixels
 *                               and what a human decided, and when
 *   4. WHAT THIS CANNOT SAY     the limits, in the report rather than in a
 *                               footnote
 *
 * THE HONESTY PROBLEM IN SECTION 1. A deployment that records its search scope
 * can answer the DPO's question directly. This one may not: nothing in the
 * schema stores "the redact stage was configured to look for these eight
 * things on this world". Where a `RedactionSearchRecord` is supplied, this
 * report says "searched, declared". Where it is not, it falls back to two
 * weaker kinds of evidence and LABELS them as weaker:
 *
 *   -- a detection of that kind exists, so the detector ran (strong);
 *   -- a detection exists from a detector that also covers that kind, so the
 *      same model ran with that prompt in the same pass (an inference, named
 *      as one, because OWLv2 is prompted with all of its noun phrases at once);
 *   -- nothing at all, which is reported as nothing at all.
 *
 * The third case must never render as "searched, clean". That is the sentence
 * a DPO would rely on, and it would not be true.
 */

/**
 * Which detector family covers which category, from the `redact` stage as the
 * pipeline README documents it. The inference in the middle case above rests
 * entirely on this table, so it is written as the pipeline describes it and
 * not as it would be convenient for it to be.
 */
export const DETECTOR_FAMILY: Readonly<Record<string, string>> = {
  face: 'face detector (YuNet)',
  person_through_window: 'open-vocabulary detector (OWLv2)',
  document: 'text-density detector (docTR)',
  correspondence: 'text-density detector (docTR)',
  screen: 'open-vocabulary detector (OWLv2)',
  photo: 'open-vocabulary detector (OWLv2)',
  medication: 'open-vocabulary detector (OWLv2)',
  plate: 'open-vocabulary detector (OWLv2)',
};

export const KIND_LABEL: Readonly<Record<string, string>> = {
  face: 'Faces',
  person_through_window: 'People visible through windows',
  document: 'Documents and paperwork',
  correspondence: 'Correspondence and addressed mail',
  screen: 'Screens in use',
  photo: 'Framed photographs',
  medication: 'Medication and packaging',
  plate: 'Vehicle number plates',
};

/** How strongly this report can claim a category was searched. */
export type SearchEvidence = 'declared' | 'detections' | 'detector-family' | 'none';

export const SEARCH_EVIDENCE_WORD: Readonly<Record<SearchEvidence, string>> = {
  declared: 'SEARCHED (declared by the pipeline)',
  detections: 'SEARCHED (this detector produced results)',
  'detector-family': 'PROBABLY SEARCHED (inferred)',
  none: 'NO EVIDENCE OF A SEARCH',
};

export interface CategoryFinding {
  readonly kind: string;
  readonly label: string;
  readonly detector: string;
  readonly evidence: SearchEvidence;
  readonly found: number;
  readonly removed: number;
  readonly reviewed: number;
  readonly awaiting: number;
}

export interface PrivacyAuditOptions {
  readonly reference: DocumentReference;
  readonly issuedAt: string;
  /** False when no redaction source was supplied or the read failed. */
  readonly available: boolean;
  readonly error?: string;
  readonly detections?: readonly RedactionDetection[];
  readonly searched?: readonly RedactionSearchRecord[];
  /** Cameras in the world, so the report can state how many frames exist. */
  readonly cameraCount: number;
  /** Camera id to a readable name, so a row is not a bare uuid. */
  readonly cameraNames?: ReadonlyMap<string, string>;
  /** False when nothing can be approved, rejected or added from this build. */
  readonly canReview: boolean;
  readonly reviewDisabledReason?: string;
}

export interface PrivacyAudit {
  readonly document: ComplianceDocument;
  readonly findings: readonly CategoryFinding[];
  readonly rows: readonly DetectionRow[];
}

export function buildPrivacyAudit(opts: PrivacyAuditOptions): PrivacyAudit {
  const detections = opts.detections ?? [];
  const findings = opts.available ? categorise(detections, opts.searched) : [];
  const rows = opts.available ? detectionRows(detections, opts) : [];

  const sections: DocSection[] = [
    standingSection(opts, detections, findings),
    searchSection(opts, findings),
    findingsSection(opts, findings),
    detectionsSection(opts, rows),
    decisionsSection(opts, detections),
    limitsSection(opts),
  ];

  return {
    document: {
      kind: 'privacy-audit',
      title: 'Privacy and redaction audit',
      subtitle: opts.reference.propertyLabel,
      issuedAt: opts.issuedAt,
      reference: opts.reference,
      standing: STANDING,
      sections,
    },
    findings,
    rows,
  };
}

const STANDING: readonly string[] = [
  'This report describes what was looked for in the imagery behind this tour, what was found, '
  + 'what was removed from the frames, and which of those a person reviewed and when. It is '
  + 'written to be handed to a data protection officer.',
  'Removal is destructive. Faces, documents, correspondence, medication, plates and screens '
  + 'are inpainted and then blurred so that no high-frequency content survives; framed '
  + 'photographs are inpainted. Nothing is regenerated and nothing is invented in their place.',
  'This report covers personal data visible in the captured imagery. It is not a record of '
  + 'processing under Article 30, a DPIA, or a retention schedule for the source media.',
];

// ---------------------------------------------------------------------------
// Categorising
// ---------------------------------------------------------------------------

export function categorise(
  detections: readonly RedactionDetection[],
  searched: readonly RedactionSearchRecord[] | undefined,
): readonly CategoryFinding[] {
  const declared = new Map<string, RedactionSearchRecord>();
  for (const record of searched ?? []) declared.set(record.kind, record);

  // Which detector families actually produced something. This is what lets
  // "OWLv2 ran" be inferred from a single screen detection, and it is only
  // ever used to produce the explicitly weaker 'detector-family' evidence.
  const familiesSeen = new Set<string>();
  const counts = new Map<string, RedactionDetection[]>();
  for (const d of detections) {
    const list = counts.get(d.kind);
    if (list) list.push(d); else counts.set(d.kind, [d]);
    // An operator-added redaction is not evidence that any detector ran: a
    // person drew a box on a frame. Excluding it here is the difference
    // between "the model looked" and "somebody noticed".
    if (d.detector !== 'operator') {
      const family = DETECTOR_FAMILY[d.kind];
      if (family) familiesSeen.add(family);
    }
  }

  // Every known category, plus any unfamiliar kind the database holds. An
  // unknown kind is printed rather than dropped: a divergence between this
  // list and the server's vocabulary must show up as a row somebody can see.
  const kinds = [...REDACTION_KINDS as readonly string[]];
  for (const kind of counts.keys()) if (!kinds.includes(kind)) kinds.push(kind);

  return kinds.map((kind) => {
    const found = counts.get(kind) ?? [];
    const detector = DETECTOR_FAMILY[kind] ?? 'not a category this system documents';
    const declaredRecord = declared.get(kind);
    let evidence: SearchEvidence;
    if (declaredRecord) {
      evidence = declaredRecord.searched ? 'declared' : 'none';
    } else if (found.some((d) => d.detector !== 'operator')) {
      evidence = 'detections';
    } else if (DETECTOR_FAMILY[kind] && familiesSeen.has(DETECTOR_FAMILY[kind]!)) {
      evidence = 'detector-family';
    } else {
      evidence = 'none';
    }

    return {
      kind,
      label: KIND_LABEL[kind] ?? kind,
      detector,
      evidence,
      found: found.length,
      removed: found.filter((d) => d.applied).length,
      reviewed: found.filter((d) => d.reviewedAt !== null).length,
      awaiting: found.filter((d) => d.reviewedAt === null).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function detectionRows(
  detections: readonly RedactionDetection[], opts: PrivacyAuditOptions,
): readonly DetectionRow[] {
  // Awaiting review first: this table is a queue as well as a record, and the
  // rows that need a person are the rows that need to be at the top of it.
  const sorted = [...detections].sort((a, b) => {
    const ra = a.reviewedAt === null ? 0 : 1;
    const rb = b.reviewedAt === null ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });

  return sorted.map((d) => ({
    id: d.id,
    kind: d.kind,
    kindLabel: KIND_LABEL[d.kind] ?? d.kind,
    camera: d.cameraId
      ? (opts.cameraNames?.get(d.cameraId) ?? d.cameraId)
      : 'not recorded against a frame',
    bbox: bboxText(d.bbox),
    detector: d.detector === 'operator' ? 'added by an operator' : d.detector,
    score: d.score === null || !Number.isFinite(d.score)
      ? (d.detector === 'operator' ? 'not applicable' : 'not recorded')
      : d.score.toFixed(2),
    pixels: d.applied
      ? 'Removed from the frames'
      : 'Still visible in the frames',
    decision: decisionWord(d),
    reviewedBy: d.reviewedBy,
    reviewedAt: d.reviewedAt,
    actionable: opts.canReview,
    ...(opts.canReview ? {} : { actionsReason: opts.reviewDisabledReason
      ?? 'This build cannot write to the redaction table.' }),
  }));
}

/**
 * What the row can honestly say a human decided.
 *
 * `wv_redaction` has `applied`, `reviewed_by` and `reviewed_at` and NO
 * decision column, so "reviewed and approved" and "reviewed and rejected" are
 * distinguishable only through `applied` -- and only in one direction, because
 * pixels that were destroyed at build time stay destroyed whatever a reviewer
 * later decides. This function says exactly as much as the columns support and
 * not one word more; the gap itself is written up in "What this report cannot
 * say" rather than papered over with a confident label.
 */
function decisionWord(d: RedactionDetection): string {
  if (d.reviewedAt === null) return 'Awaiting review';
  if (d.applied) return 'Reviewed. The pixels were removed.';
  return 'Reviewed. Not removed — either judged unnecessary, or waiting for the next build to '
    + 'apply it.';
}

function bboxText(bbox: readonly number[]): string {
  if (bbox.length < 4) return 'not recorded';
  const [x, y, w, h] = bbox;
  return `${fmt(x)}, ${fmt(y)} — ${fmt(w)} × ${fmt(h)} px`;
}

function fmt(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? '?' : String(Math.round(v));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function standingSection(
  opts: PrivacyAuditOptions,
  detections: readonly RedactionDetection[],
  findings: readonly CategoryFinding[],
): DocSection {
  const blocks: DocBlock[] = [];

  if (!opts.available) {
    blocks.push({
      kind: 'note',
      tone: 'bad',
      heading: 'This report has no data and must not be filed',
      text: opts.error
        ? `The redaction records for this survey could not be read: ${opts.error} Nothing below `
          + 'describes this property. An empty privacy report is not evidence that a property '
          + 'was clean; it is evidence that nobody looked at the records.'
        : 'No source of redaction records was supplied to this build of the compliance centre, '
          + 'so nothing below describes this property. An empty privacy report is not evidence '
          + 'that a property was clean; it is evidence that nobody looked at the records. The '
          + 'records exist: wv_redaction holds every detection this survey produced, whether '
          + 'or not it was applied. The client this page was handed has no method that reads '
          + 'them. Until it has one, this question must be answered from the database '
          + 'directly, and this page must not be offered to a data protection officer as an '
          + 'answer.',
    });
    return { id: 'standing', heading: 'The state of this report', level: 2, blocks };
  }

  const unknownSearch = findings.filter((f) => f.evidence === 'none').length;
  const awaiting = detections.filter((d) => d.reviewedAt === null).length;
  const unapplied = detections.filter((d) => !d.applied).length;

  blocks.push({
    kind: 'facts',
    pairs: [
      ['Property', opts.reference.propertyLabel],
      ['Survey', `Version ${opts.reference.worldVersion}`],
      ['Survey identifier', opts.reference.worldId],
      ['Frames in the survey', String(opts.cameraCount)],
      ['Detections recorded', String(detections.length)],
      ['Removed from the frames', String(detections.filter((d) => d.applied).length)],
      ['Still visible in the frames', String(unapplied)],
      ['Awaiting human review', String(awaiting)],
      ['Report prepared', humanDateTime(opts.issuedAt)],
    ],
  });

  if (awaiting > 0) {
    blocks.push({
      kind: 'note',
      tone: 'warn',
      heading: `${awaiting} detection${awaiting === 1 ? '' : 's'} have not been reviewed`,
      text: 'The publication gate holds a world whose redactions have not been signed off. '
        + 'Each one is listed below with what was found and what happened to the pixels.',
    });
  }
  if (unknownSearch > 0) {
    blocks.push({
      kind: 'note',
      tone: 'warn',
      heading: `${unknownSearch} categor${unknownSearch === 1 ? 'y has' : 'ies have'} no `
        + 'evidence of a search',
      text: 'For those categories this report cannot tell you whether the property was clean or '
        + 'whether nobody looked. They are listed individually below and must not be read as '
        + '"nothing found".',
    });
  }

  return { id: 'standing', heading: 'The state of this report', level: 2, blocks };
}

function searchSection(
  opts: PrivacyAuditOptions, findings: readonly CategoryFinding[],
): DocSection {
  if (!opts.available) {
    return {
      id: 'searched',
      heading: 'What was looked for',
      level: 2,
      blocks: [{
        kind: 'paragraph',
        text: 'Not known. The records that would answer this were not read, so this section is '
          + 'empty because nothing was consulted, not because nothing was searched for.',
      }],
    };
  }

  return {
    id: 'searched',
    heading: 'What was looked for',
    level: 2,
    blocks: [
      {
        kind: 'paragraph',
        text: 'One row per category of personal data this system knows how to remove. The '
          + 'evidence column is the honest answer to "did you look": a category with no '
          + 'evidence of a search is not a clean category, and is not reported as one.',
      },
      {
        kind: 'table',
        caption: 'Categories searched for in the imagery behind this tour',
        columns: [
          { key: 'category', label: 'Category', rowHeader: true },
          { key: 'detector', label: 'Detector' },
          { key: 'evidence', label: 'Evidence that it was searched for' },
          { key: 'found', label: 'Found', numeric: true },
        ],
        rows: findings.map((f) => [
          f.label, f.detector, SEARCH_EVIDENCE_WORD[f.evidence], String(f.found),
        ] as const),
        emptyMessage: 'No categories are recorded for this survey.',
        note: 'Per-class thresholds are asymmetric by design: medication sits low because '
          + 'missing a packet is a privacy failure, and screens sit higher because '
          + 'over-redacting a television is cosmetic.',
      },
      ...(findings.some((f) => f.evidence === 'detector-family')
        ? [{
          kind: 'note' as const,
          tone: 'info' as const,
          heading: 'What "probably searched" means',
          text: 'The open-vocabulary detector is prompted with all of its categories in one '
            + 'pass, so a detection in any one of them shows the model ran with the others in '
            + 'the same prompt. That is an inference about the pipeline, not a record of it, '
            + 'and it is labelled separately from the categories that produced results of '
            + 'their own.',
        }]
        : []),
      ...(findings.some((f) => f.evidence === 'none')
        ? [{
          kind: 'note' as const,
          tone: 'warn' as const,
          heading: 'Categories with no evidence of a search',
          text: `${findings.filter((f) => f.evidence === 'none').map((f) => f.label).join(', ')}. `
            + 'Nothing in the records shows that these were looked for on this survey. They may '
            + 'have been searched and found nothing; the records do not say. Treat this as an '
            + 'open question, not as a clean result.',
        }]
        : []),
    ],
  };
}

function findingsSection(
  opts: PrivacyAuditOptions, findings: readonly CategoryFinding[],
): DocSection {
  if (!opts.available) {
    return {
      id: 'findings',
      heading: 'What was found',
      level: 2,
      blocks: [{
        kind: 'paragraph',
        text: 'Not known, for the reason given above.',
      }],
    };
  }
  const withFindings = findings.filter((f) => f.found > 0);
  const clean = findings.filter((f) => f.found === 0 && f.evidence !== 'none');

  const blocks: DocBlock[] = [
    {
      kind: 'table',
      caption: 'What was found, by category',
      columns: [
        { key: 'category', label: 'Category', rowHeader: true },
        { key: 'found', label: 'Found', numeric: true },
        { key: 'removed', label: 'Removed', numeric: true },
        { key: 'reviewed', label: 'Reviewed by a person', numeric: true },
        { key: 'awaiting', label: 'Awaiting review', numeric: true },
      ],
      rows: withFindings.map((f) => [
        f.label, String(f.found), String(f.removed), String(f.reviewed), String(f.awaiting),
      ] as const),
      emptyMessage: 'No personal data was detected anywhere in this survey.',
    },
  ];

  if (clean.length > 0) {
    blocks.push({
      kind: 'list',
      intro: 'Searched for and found clean. These categories produced no detections, and the '
        + 'evidence above shows they were looked for:',
      items: clean.map((f) => `${f.label} — ${f.detector}.`),
    });
  }

  return { id: 'findings', heading: 'What was found', level: 2, blocks };
}

function detectionsSection(
  opts: PrivacyAuditOptions, rows: readonly DetectionRow[],
): DocSection {
  return {
    id: 'detections',
    heading: 'Every detection, one row each',
    level: 2,
    pageBreakBefore: true,
    blocks: [
      {
        kind: 'paragraph',
        text: 'Each row is one detection in one frame: where it was, which detector found it, '
          + 'how confident it was, what happened to the pixels, and what a person decided. '
          + 'Rows awaiting a decision are first.',
      },
      ...(opts.canReview
        ? []
        : [{
          kind: 'note' as const,
          tone: 'warn' as const,
          heading: 'Decisions cannot be recorded from this page',
          text: opts.reviewDisabledReason
            ?? 'This build has no way to write a review decision, so the controls below are '
              + 'disabled. The table is still the record of what was found.',
        }]),
      {
        kind: 'detections',
        caption: 'Detections in this survey',
        rows,
        emptyMessage: opts.available
          ? 'No detections are recorded for this survey. Read that against the search table '
            + 'above before concluding that nothing was there.'
          : 'No records were read, so there is nothing to show. This is not an empty result.',
      },
    ],
  };
}

function decisionsSection(
  opts: PrivacyAuditOptions, detections: readonly RedactionDetection[],
): DocSection {
  if (!opts.available) {
    return {
      id: 'decisions',
      heading: 'What a person decided, and when',
      level: 2,
      blocks: [{ kind: 'paragraph', text: 'Not known, for the reason given above.' }],
    };
  }

  const reviewed = detections
    .filter((d) => d.reviewedAt !== null)
    .sort((a, b) => (a.reviewedAt! < b.reviewedAt! ? 1 : -1));

  if (reviewed.length === 0) {
    return {
      id: 'decisions',
      heading: 'What a person decided, and when',
      level: 2,
      blocks: [{
        kind: 'note',
        tone: 'warn',
        heading: 'No human has reviewed any detection on this survey',
        text: 'Every removal here was decided by a model. That is not a failure of the '
          + 'pipeline, but it is the fact a data protection officer will ask about, and it is '
          + 'stated plainly rather than left to be inferred from an empty table.',
      }],
    };
  }

  return {
    id: 'decisions',
    heading: 'What a person decided, and when',
    level: 2,
    blocks: [
      {
        kind: 'table',
        caption: 'Human review decisions on this survey',
        columns: [
          { key: 'what', label: 'What', rowHeader: true },
          { key: 'who', label: 'Reviewed by' },
          { key: 'when', label: 'When' },
          { key: 'pixels', label: 'Pixels' },
        ],
        rows: reviewed.map((d) => [
          KIND_LABEL[d.kind] ?? d.kind,
          d.reviewedBy ?? 'recorded without a user id',
          humanDateTime(d.reviewedAt),
          d.applied ? 'Removed' : 'Not removed',
        ] as const),
      },
      {
        kind: 'paragraph',
        text: `${reviewed.length} of ${detections.length} detections have been reviewed by a `
          + `person. The earliest was ${humanDate(reviewed[reviewed.length - 1]?.reviewedAt)} `
          + `and the most recent ${humanDate(reviewed[0]?.reviewedAt)}.`,
      },
    ],
  };
}

function limitsSection(opts: PrivacyAuditOptions): DocSection {
  const items: string[] = [
    'A detection recorded as removed means the pixels in the stored frames were destroyed by '
    + 'the redact stage. It does not speak to any copy of the source media held outside this '
    + 'system.',
    'A detection recorded as still visible means the instruction exists and the frames have '
    + 'not been rebuilt. Adding a redaction from this page records the instruction; it cannot '
    + 'change a pixel, because that is a GPU stage and not an HTTP request.',
    'This table cannot distinguish a detection a reviewer judged unnecessary from one that is '
    + 'waiting for the next build, because wv_redaction records that a person reviewed a row '
    + 'and whether the pixels are gone, and has no column for which way they decided. Where '
    + 'that distinction matters, it has to be recorded outside this system until the column '
    + 'exists.',
    'Rejecting a detection whose pixels were already removed does not restore them. The '
    + 'removal is destructive by design, and the rejection records a judgement about the '
    + 'removal rather than undoing it.',
    'This report covers the imagery. It says nothing about personal data in a property '
    + 'description, a lead message or an AI transcript, which are held elsewhere.',
  ];
  if (!opts.available) {
    items.unshift('Nothing in this report describes this property, because the redaction '
      + 'records were not read.');
  }
  return {
    id: 'limits',
    heading: 'What this report cannot say',
    level: 2,
    blocks: [{ kind: 'list', items }],
  };
}
