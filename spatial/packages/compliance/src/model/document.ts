import type { FormattedQuantity } from '@m3xi/viewer/headless';

/**
 * ONE DOCUMENT SHAPE FOR ALL FOUR SURFACES
 * ========================================
 *
 * A measurement certificate, a material-information checklist, a privacy audit
 * and an accessibility statement are four different arguments, but they are
 * the same ARTEFACT: a paginated document with a header, numbered sections, a
 * statement of what it is and is not, and a footer that says which world and
 * which moment it describes. Somebody prints each of them and is later asked
 * to produce the printout.
 *
 * So they share a model, and the model is data rather than markup. Three
 * things fall out of that, all of them the reason for the indirection:
 *
 *   1. The print rules live in ONE renderer. "A table never breaks through its
 *      header row" and "a heading never sits alone at the foot of a page" are
 *      properties of a document, not of a certificate, and four renderers
 *      would get them right three times.
 *
 *   2. The tests read documents rather than DOM. `toText(render(doc))` is the
 *      words on the page, which is what an assertion about "reads as
 *      unanswered" actually means.
 *
 *   3. A figure is a first-class block. Every number in this package arrives
 *      as a `Figure`, never as a string, so there is no code path in which a
 *      dimension is formatted without its standard and its tolerance. That is
 *      the same guarantee `@m3xi/viewer`'s formatter makes, extended to the
 *      documents somebody signs.
 *
 * Deliberately absent: any block that carries colour, an icon or a severity
 * ramp. `Note.tone` exists so the renderer can pick a border weight and a
 * word; the word is what carries the meaning, because these print in
 * greyscale and get photocopied.
 */

export type DocumentKind =
  | 'measurement-certificate'
  | 'dmcc-checklist'
  | 'privacy-audit'
  | 'accessibility-statement';

/**
 * How a dimension is being presented, which is the whole argument of the
 * certificate compressed into four words.
 *
 *   measured             the engine computed it from surveyed geometry and
 *                        `isDefensible()` is true
 *   indicative           a figure the engine will not stand behind. Shown,
 *                        never omitted, always with the reason in words
 *   declared             a person measured it on site with a named instrument
 *   declared-indicative  a person stated it without measuring it, or measured
 *                        it without naming what with
 */
export type FigurePresentation =
  | 'measured' | 'indicative' | 'declared' | 'declared-indicative';

export const PRESENTATION_WORD: Readonly<Record<FigurePresentation, string>> = {
  measured: 'MEASURED',
  indicative: 'INDICATIVE',
  declared: 'DECLARED',
  'declared-indicative': 'INDICATIVE (DECLARED)',
};

/** What a person declared, recovered from a `wv_measurement` row's basis. */
export interface DeclaredBasis {
  readonly correctionId?: string;
  readonly statedBy?: string;
  readonly statedAt?: string;
  /** 'site-measure' or 'estimate'. Printed verbatim when it is neither. */
  readonly method?: string;
  /** 'laser', 'tape' or 'unknown'. Printed verbatim when it is none of them. */
  readonly instrument?: string;
  readonly defensible: boolean;
  readonly refusalReason?: string;
  readonly note?: string;
  readonly supersededValue?: number;
  readonly supersededStandard?: string;
  readonly supersededTolerance?: number;
  readonly supersededToleranceUnit?: string;
}

/**
 * One dimension, ready to print.
 *
 * `formatted` is `@m3xi/viewer`'s own `FormattedQuantity`, so a figure in the
 * certificate and the same figure in the tour are formatted by one function.
 * Rounding that differs between the document and the viewer is the cheapest
 * possible way to look like you are hiding something.
 */
export interface Figure {
  /** Stable across issues: `room:<id>:area`. This is what a reissue diffs. */
  readonly id: string;
  /** "Bedroom 1". */
  readonly subject: string;
  /** "Floor area". */
  readonly what: string;
  readonly formatted: FormattedQuantity;
  readonly value: number;
  readonly unit: string;
  readonly standard: string;
  readonly tolerance: number;
  readonly toleranceUnit: string;
  readonly presentation: FigurePresentation;
  /**
   * 0..1, as the pipeline or the operator set it, and printed beside every
   * figure. It is not the tolerance and must not be read as one: the tolerance
   * is how wide the interval is, the confidence is how much the system trusts
   * that the interval contains the truth. A certificate that printed one
   * without the other would be quoting half a claim.
   */
  readonly confidence: number;
  /** "measured from the photographs", "estimated", "not surveyed". */
  readonly provenanceLabel: string;
  /** Plain-English reason, present whenever the presentation is indicative. */
  readonly reason?: string;
  /** What produced the number: the geometry, or the person and the instrument. */
  readonly basis: string;
  readonly declared?: DeclaredBasis;
  /** True when a human correction receipt sits on the row this figure reads. */
  readonly humanTouched: boolean;
  /** Operator ids from the receipts, as stored. */
  readonly operators: readonly string[];
}

/**
 * A dimension that cannot be printed as a number.
 *
 * `assertDisplayable` throws for a quantity with no standard, no tolerance or
 * no grounding, and it is right to: rendering it anyway would launder a
 * pipeline bug into a claim. But a certificate that threw would take the other
 * forty figures down with it, and an operator would learn nothing. So the
 * failure becomes a row of its own, named and explained, and the document
 * still prints.
 */
export interface UnpresentableFigure {
  readonly id: string;
  readonly subject: string;
  readonly what: string;
  readonly reason: string;
}

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  /** Right-align numbers so a column of figures can be read down. */
  readonly numeric?: boolean;
  /** Marks the column whose cell is the row's heading, for screen readers. */
  readonly rowHeader?: boolean;
}

export type Cell = string | Figure;

export interface TableBlock {
  readonly kind: 'table';
  readonly caption: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly (readonly Cell[])[];
  readonly note?: string;
  /** Shown instead of the table when there are no rows, in words. */
  readonly emptyMessage?: string;
}

/**
 * One material-information item.
 *
 * `answer` is a closed union with no "empty string" member on purpose. An
 * unanswered item and an item answered with nothing are different facts, and a
 * checklist that renders them the same way is the failure mode this document
 * exists to avoid: it looks complete when it is not.
 */
export type ChecklistAnswer =
  | {
      readonly state: 'from-survey';
      readonly value: string;
      /** The figures behind the value, printed under it. */
      readonly figures?: readonly Figure[];
    }
  | {
      readonly state: 'unanswered';
      /** Why the survey cannot supply it. Always specific, never "n/a". */
      readonly reason: string;
    };

export interface ChecklistItem {
  readonly id: string;
  readonly part: 'A' | 'B' | 'C';
  readonly label: string;
  /** What the CMA expects this item to cover, in one sentence. */
  readonly guidance: string;
  readonly answer: ChecklistAnswer;
  /**
   * What the survey DOES say about this item, even when it cannot answer it.
   * A door width is not an accessibility declaration, but an agent writing one
   * should be able to see it without leaving the page.
   */
  readonly evidence: readonly string[];
  /** How an agent completes it. Absent for items the survey answered. */
  readonly input?: 'text' | 'longtext' | 'money' | 'choice';
  readonly choices?: readonly string[];
  readonly placeholder?: string;
}

export interface ChecklistBlock {
  readonly kind: 'checklist';
  readonly part: 'A' | 'B' | 'C';
  readonly items: readonly ChecklistItem[];
}

/** One reviewable detection, with the decision a human has or has not made. */
export interface DetectionRow {
  readonly id: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly camera: string;
  readonly bbox: string;
  readonly detector: string;
  readonly score: string;
  /** "Removed", "Detected, not removed", ... Never a colour, always a word. */
  readonly pixels: string;
  readonly decision: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  /** False when nothing can act on it, with the reason in `actionsReason`. */
  readonly actionable: boolean;
  readonly actionsReason?: string;
}

export interface DetectionsBlock {
  readonly kind: 'detections';
  readonly caption: string;
  readonly rows: readonly DetectionRow[];
  readonly emptyMessage: string;
}

export type DocBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly intro?: string; readonly items: readonly string[] }
  | { readonly kind: 'figure'; readonly figure: Figure }
  /**
   * A measurement that arrives already formatted, from the viewer's narrative
   * builder. It is not a `Figure` because the narrative hands over a
   * `FormattedQuantity` and not the `Quantity` behind it -- and reconstructing
   * one to satisfy a type would mean inventing the fields the narrative did
   * not pass. `formatted.full` already carries value, tolerance and standard,
   * so this block cannot print a bare number either.
   */
  | {
      readonly kind: 'measurement';
      readonly label: string;
      readonly formatted: FormattedQuantity;
    }
  | { readonly kind: 'unpresentable'; readonly figure: UnpresentableFigure }
  | {
      readonly kind: 'note';
      readonly tone: 'info' | 'warn' | 'bad';
      readonly heading: string;
      readonly text: string;
    }
  | { readonly kind: 'facts'; readonly pairs: readonly (readonly [string, string])[] }
  | TableBlock
  | ChecklistBlock
  | DetectionsBlock;

export interface DocSection {
  readonly id: string;
  readonly heading: string;
  readonly level: 2 | 3;
  readonly blocks: readonly DocBlock[];
  /**
   * Start this section on a fresh page when printed. Used for the boundaries a
   * reader treats as real: Part A, Part B, Part C.
   */
  readonly pageBreakBefore?: boolean;
}

export interface ComplianceDocument {
  readonly kind: DocumentKind;
  readonly title: string;
  readonly subtitle: string;
  /** ISO-8601. The moment this copy was produced, printed in the header. */
  readonly issuedAt: string;
  readonly reference: DocumentReference;
  /**
   * What this document is and is not, printed at the top of every one of them.
   * Not a disclaimer in six-point type at the bottom: a reader who does not
   * know whether they are holding a survey or a working aid cannot use either.
   */
  readonly standing: readonly string[];
  readonly sections: readonly DocSection[];
}

export interface DocumentReference {
  readonly worldId: string;
  readonly worldVersion: number;
  readonly propertyId: string;
  readonly propertyLabel: string;
  readonly propertyRef?: string;
  readonly postcode?: string;
  readonly surveyedAt: string;
  readonly publishedAt?: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Count of unanswered items across every checklist block in a document. */
export function unansweredCount(doc: ComplianceDocument): number {
  let n = 0;
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'checklist') continue;
      for (const item of block.items) if (item.answer.state === 'unanswered') n += 1;
    }
  }
  return n;
}

/** Every figure in a document, in document order. */
export function figuresOf(doc: ComplianceDocument): readonly Figure[] {
  const out: Figure[] = [];
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind === 'figure') { out.push(block.figure); continue; }
      if (block.kind === 'table') {
        for (const row of block.rows) {
          for (const cell of row) if (typeof cell !== 'string') out.push(cell);
        }
        continue;
      }
      if (block.kind === 'checklist') {
        for (const item of block.items) {
          if (item.answer.state === 'from-survey' && item.answer.figures) {
            out.push(...item.answer.figures);
          }
        }
      }
    }
  }
  return out;
}

/** A date an operator reads, in the locale UK agencies file documents in. */
export function humanDate(iso: string | null | undefined, locale = 'en-GB'): string {
  if (!iso) return 'not recorded';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** A date and time, for anything that has to be pinned to a moment. */
export function humanDateTime(iso: string | null | undefined, locale = 'en-GB'): string {
  if (!iso) return 'not recorded';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}, `
    + `${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}
