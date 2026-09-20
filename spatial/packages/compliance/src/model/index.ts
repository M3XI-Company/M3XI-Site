/**
 * @m3xi/compliance/model
 *
 * The documents as data, with no DOM anywhere in them.
 *
 * The split is the same one `@m3xi/console-ui` makes and for the same reason:
 * whether a figure is indicative, whether a checklist item is answered and
 * whether a redaction category was searched for are decisions, and decisions
 * belong somewhere they can be tested in Node in a millisecond. `ui/` renders
 * what this decides and decides nothing itself.
 *
 * It is also the surface a caller needs in order to hand this package the two
 * capabilities the console cannot currently supply -- `RedactionSource` and
 * `MeasurementRecordSource` -- and to keep a `CertificateIssue` beside a filed
 * PDF so the next reissue can say what changed.
 */

export type {
  Cell, ChecklistAnswer, ChecklistBlock, ChecklistItem, ComplianceDocument, DeclaredBasis,
  DetectionRow, DetectionsBlock, DocBlock, DocSection, DocumentKind, DocumentReference,
  Figure, FigurePresentation, TableBlock, TableColumn, UnpresentableFigure,
} from './document.js';
export { PRESENTATION_WORD, figuresOf, humanDate, humanDateTime, unansweredCount } from './document.js';

export {
  CORRECTION_SOURCE_PREFIX, OPERATOR_SOURCE_PREFIX, attachMeasurements, buildFigure,
  declaredMethodSentence, declaredQuantity, figureIdOfRecord, readDeclaredBasis,
  readReceipts,
} from './figures.js';
export type { AttachedMeasurements, FigureInput, FigureResult, Receipts } from './figures.js';

export {
  buildCertificate, ceilingHeightQuantity, compareIssues, fingerprint, issueRecord, referenceFrom,
} from './certificate.js';
export type {
  Certificate, CertificateIssue, CertificateOptions, IssueDiff, IssueFigure,
} from './certificate.js';

export { accessibilityObservations, buildChecklist } from './checklist.js';
export type { Checklist, ChecklistOptions } from './checklist.js';

export {
  DETECTOR_FAMILY, KIND_LABEL, SEARCH_EVIDENCE_WORD, buildPrivacyAudit, categorise,
  detectionRows,
} from './privacy.js';
export type {
  CategoryFinding, PrivacyAudit, PrivacyAuditOptions, SearchEvidence,
} from './privacy.js';

export { buildAccessibilityStatement } from './accessibility.js';
export type { AccessibilityOptions, AccessibilityStatement } from './accessibility.js';

export { REDACTION_KINDS } from './sources.js';
export type {
  ComplianceApi, MeasurementRecord, MeasurementRecordSource, NewRedaction, PropertyFacts,
  RedactionDetection, RedactionKind, RedactionSearchRecord, RedactionSource, WorldFacts,
} from './sources.js';
