/**
 * `@m3xi/review/model` — the correction model with no DOM in it.
 *
 * Everything here is a pure function or a plain object over a
 * `WorldDocument`: the typed union of corrections, how a human assertion is
 * represented without lying about it, how a list is applied, what it breaks,
 * what the server will keep, and the session that holds an operator's work.
 *
 * The split from `src/ui` is the same one `@m3xi/console-ui` makes and for the
 * same reason: every decision in this package is testable in Node in
 * milliseconds, and none of it can drift out of step with the screen that
 * renders it, because the screen renders these values rather than recomputing
 * them.
 */

export type {
  CorrectionChange, CorrectionClass, CorrectionKind, CorrectionRecord, CorrectionTargetRef,
  DescribeContext, DimensionMethod, DimensionTarget, Instrument,
} from './corrections.js';
export {
  INSTRUMENT_TOLERANCE_MM, correctionClass, correctionKey, correctionTarget, describeCorrection,
} from './corrections.js';

export {
  CORRECTION_SOURCE_PREFIX, HUMAN_ASSERTION_CONFIDENCE, OPERATOR_SOURCE_PREFIX, cameraSourcesOf,
  correctGrounding, correctedQuantity, correctionIdsOf, correctionSource, isHumanCorrected,
  operatorSource, operatorsOf, provenanceFloor,
} from './provenance.js';
export type { CorrectedQuantityOpts } from './provenance.js';

export { applyCorrections, isOperatorRegion, receiptsIn, regionCorrectionId } from './apply.js';
export type { ApplyResult } from './apply.js';

export { validateWorld } from './validate.js';
export type { IssueLevel, ValidationIssue, ValidationResult } from './validate.js';

export {
  MAX_CORRECTIONS_PER_REQUEST, isServerId, nameIndex, planWire, reconcile, toWire,
} from './wire.js';
export type {
  LegacyCorrection, Persistence, PlanOptions, SaveOutcome, SaveReconciliation, WireCaveat,
  WireCorrection, WireItem, WireReport,
} from './wire.js';

export {
  CorrectionSession, DRAFT_FORMAT, DRAFT_KEY_PREFIX, defaultDraftStore, newRecordId,
} from './session.js';
export type {
  DraftInspection, DraftPayload, DraftStatus, DraftStore, SessionOptions, SessionState,
} from './session.js';

export { operatorName, sendCorrections } from './client.js';
export type { CorrectionApi } from './client.js';
