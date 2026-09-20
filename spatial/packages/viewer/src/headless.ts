/**
 * Everything in the viewer that does not need a browser.
 *
 * Imported by the tests, by the agent package (which needs the same
 * measurement formatting the viewer shows), and by any server-side renderer
 * that wants the written tour as text.
 */

export type {
  BlockReason, CameraPose, MeasurementOverlay, MoveResult, ViewerBranding, ViewerMode,
  ViewerOptions, ViewerTheme,
} from './types.js';
export { EMPTY_OVERLAY, poseQuat } from './types.js';

export { CameraConstraint, distanceToSegmentXZ } from './nav/constraints.js';
export type { CameraConstraintOptions, StandCheck } from './nav/constraints.js';

export { buildCameraPath, lerpAngle, pitchTo, yawTo } from './nav/path.js';
export type { CameraPath, CameraPathOptions, CameraSample } from './nav/path.js';

export { assertDisplayable, formatExtent, formatQuantity } from './measure/format.js';
export type { FormatOptions, FormattedQuantity } from './measure/format.js';

export { COMMON_FITS, MeasurementSession } from './measure/session.js';
export type { FitSpec, MeasurementResult, MeasureTool, SessionState } from './measure/session.js';

// What the visitor did, and the bookkeeping that decides when each of the
// seven kinds is true. DOM-free, so a host page can hold one of these itself.
export { ViewerEventRecorder } from './events/session.js';
export type {
  ViewerAskEvent, ViewerDwellEvent, ViewerEnterEvent, ViewerEvent, ViewerEventKind,
  ViewerEventRecorderOptions, ViewerEventSink, ViewerExitEvent, ViewerLeadEvent,
  ViewerMeasureEvent, ViewerRoomEvent,
} from './events/session.js';

export {
  classifyEntity, classifyPoint, classifyRoom, classifyViewpoint, coverageSummary,
  DISPLAY_CLASS_OF, DISPLAY_STYLE,
} from './provenance/classify.js';
export type {
  CoverageSummary, DisplayClass, DisplayClassStyle, PointProvenance, RegionNote,
  ViewpointProvenance,
} from './provenance/classify.js';

export { buildNarrative, describeRoute } from './text/narrative.js';
export type { Narrative, NarrativeBlock, NarrativeOptions, NarrativeSection } from './text/narrative.js';

export {
  DEFAULT_CHUNK_THRESHOLD_BYTES, DEFAULT_SPLAT_BUDGET, pickLod, planChunks, roomOrder,
} from './assets/chunks.js';
export type { ChunkPlan, ChunkPlanOptions, LoadPhase, PlannedAsset } from './assets/chunks.js';

export { deviceProfile, PerfMonitor, summariseFrames } from './perf/instrument.js';
export type { FrameStats, PerfReport } from './perf/instrument.js';

export * from './agent/index.js';
