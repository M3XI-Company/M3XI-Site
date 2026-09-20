import type { Quantity } from '@m3xi/world-core';

/**
 * WHAT THIS PACKAGE IS HANDED, AND WHAT IT IS NOT
 * ===============================================
 *
 * `mountComplianceCentre` is called by the console with exactly four things:
 * a world, a world id, a property id and an `ApiClient`. Two of the four
 * documents here need facts that are in the database and are NOT on that
 * client, and the honest thing to do with that is to say so in the type
 * system and again on the screen, rather than to invent the methods.
 *
 * MISSING ONE: `wv_redaction`. The privacy audit is a report about that table.
 * `ApiClient` has `listEvents`, `listLeads`, `listExports`, `roomNames` and a
 * dozen more, and nothing that reads or writes a redaction. The table exists,
 * `..._rls.sql` grants `select` and `update` on it to `authenticated` under
 * `wv_can_write_world`, and `wv-worlds approve_corrections` accepts
 * `redaction.add` -- so every capability this document needs is implemented on
 * the server and simply has no client method. Adding one to `ApiClient` would
 * mean writing a method signature that the real Supabase client does not
 * implement, which turns a missing feature into a runtime failure on somebody
 * else's screen.
 *
 * MISSING TWO: `wv_measurement`. When an operator declares a dimension,
 * `wv-worlds` writes the value onto the row AND a `wv_measurement` row whose
 * `basis` carries `corrected`, `method`, `instrument`, `statedBy`, `statedAt`
 * and the superseded value. `supabase/functions/_wv_shared/worldDocument.ts`
 * says it plainly: "A dimension that really was declared by a person is a
 * wv_measurement row carrying its own basis, and that is where its receipt
 * lives." The rendered `WorldDocument` therefore carries the NUMBER but not
 * the METHOD. A certificate that printed a laser reading and an operator's
 * guess identically would be exactly the collapse this product exists to
 * refuse, so the certificate reads these records when a source supplies them
 * and says, in words, that it could not when none does.
 *
 * So both are narrow interfaces declared here, structurally satisfiable by the
 * console once someone adds the methods, and both are OPTIONAL on the mount
 * options. Absent, the affected surface renders what it does know and states
 * what it does not. It does not render an empty table that reads as "nothing
 * was found".
 */

// ---------------------------------------------------------------------------
// The client we actually use
// ---------------------------------------------------------------------------

/**
 * The slice of `ApiClient` this package calls.
 *
 * Declared structurally rather than imported. `@m3xi/console-ui` is not a
 * dependency of this package and making it one would couple a compliance
 * document to the console's build, for a type. A real `ApiClient` satisfies
 * this interface without knowing it exists, because every member below is a
 * member of `ApiClient` with a compatible signature -- which is checked by the
 * console at the seam, and by `assignability.test.ts` here.
 */
export interface ComplianceApi {
  /** True when the client is reading declared fixtures rather than a database. */
  readonly isFixture: boolean;
  getProperty(propertyId: string): Promise<PropertyFacts>;
  getWorld(worldId: string): Promise<WorldFacts>;
}

/** The subset of `PropertyRow` a compliance document prints. */
export interface PropertyFacts {
  readonly id: string;
  readonly ref: string | null;
  readonly label: string;
  readonly postcode: string | null;
  readonly address: Readonly<Record<string, unknown>>;
}

/** The subset of `WorldDetail` a compliance document prints. */
export interface WorldFacts {
  readonly world: {
    readonly id: string;
    readonly version: number;
    readonly status: string;
    readonly published_at: string | null;
    readonly created_at: string;
  };
  /**
   * Newest `updated_at` across the correctable tables, or null when nothing in
   * this world has ever been edited. Null means "no correction"; a certificate
   * that guessed a date here would be inventing the one fact a reissue turns
   * on.
   */
  readonly lastCorrectionAt: string | null;
}

// ---------------------------------------------------------------------------
// wv_measurement
// ---------------------------------------------------------------------------

/**
 * One `wv_measurement` row, as the table stores it.
 *
 * `a` identifies what was measured: `{ type: 'room', id, field: 'area' }`,
 * `{ type: 'room', id, field: 'ceilingHeight' }` or
 * `{ type: 'opening', id, field: 'width' | 'height' | 'sill' }`, which is what
 * `wv-worlds` writes and therefore what this reads. An unrecognised shape is
 * not discarded silently: `certificate.ts` lists it under measurements it
 * could not attach to anything in the world.
 */
export interface MeasurementRecord {
  readonly id: string;
  readonly kind: string;
  readonly a: Readonly<Record<string, unknown>>;
  readonly b?: Readonly<Record<string, unknown>> | null;
  readonly value: number;
  readonly unit: Quantity['unit'];
  readonly standard: string;
  readonly tolerance: number;
  readonly toleranceUnit: string;
  readonly confidence: number;
  readonly basis: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface MeasurementRecordSource {
  /** Every measurement row for this world, in any order. */
  listMeasurements(worldId: string): Promise<readonly MeasurementRecord[]>;
}

// ---------------------------------------------------------------------------
// wv_redaction
// ---------------------------------------------------------------------------

/**
 * The detector vocabulary `wv_redaction.kind` documents, in the order the
 * privacy report prints them: the three that are unambiguously about a person
 * first, then the four that are about what a person left lying around, then
 * vehicles.
 *
 * This list is duplicated from `REDACTION_KINDS` in
 * `supabase/functions/wv-worlds/handler.ts` rather than imported, because an
 * edge function is not importable from a browser bundle. The duplication is
 * load-bearing in one direction only: a kind the server knows and this list
 * does not still renders, under "other categories", so a divergence shows up
 * as an unfamiliar row rather than as a silently dropped detection.
 */
export const REDACTION_KINDS = [
  'face',
  'person_through_window',
  'document',
  'correspondence',
  'screen',
  'photo',
  'medication',
  'plate',
] as const;

export type RedactionKind = (typeof REDACTION_KINDS)[number];

/** One `wv_redaction` row. */
export interface RedactionDetection {
  readonly id: string;
  readonly cameraId: string | null;
  /** Free text on the column; one of `REDACTION_KINDS` in practice. */
  readonly kind: string;
  /** [x, y, w, h] in image pixels. */
  readonly bbox: readonly number[];
  readonly detector: string;
  readonly score: number | null;
  /**
   * True when the pixels were destroyed by the `redact` stage. It is NOT a
   * review decision: `wv-worlds` refuses to set it from a request, because an
   * endpoint that flipped it would be claiming a face had been blurred while
   * the frame still shows it.
   */
  readonly applied: boolean;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
}

/**
 * What the `redact` stage was configured to look for on this world.
 *
 * Optional, and its absence is the whole reason this type exists. "Did you
 * look for medication packaging in this tour" cannot be answered by a table of
 * detections alone: zero rows for `medication` is consistent both with "we
 * looked and the flat was clean" and with "that detector never ran". A
 * deployment that records its search scope can say which; one that does not
 * must say that it cannot, and `privacy.ts` does.
 */
export interface RedactionSearchRecord {
  readonly kind: string;
  readonly searched: boolean;
  readonly detector?: string;
  /** Confidence floor the stage used. Per-class and asymmetric by design. */
  readonly threshold?: number;
  readonly frames?: number;
}

export interface NewRedaction {
  readonly cameraId: string;
  readonly kind: string;
  /** [x, y, w, h] in image pixels, all non-negative, w and h positive. */
  readonly bbox: readonly [number, number, number, number];
}

/**
 * Reading and reviewing `wv_redaction`.
 *
 * `approve` and `reject` both mean "a human looked at this", because that is
 * all the table can record: it has `applied`, `reviewed_by` and `reviewed_at`
 * and no decision column. The difference between them lives in `applied`, and
 * only in the direction the pixels allow -- see `privacy.ts`, which prints the
 * consequence rather than hiding it.
 */
export interface RedactionSource {
  listDetections(worldId: string): Promise<readonly RedactionDetection[]>;
  listSearched?(worldId: string): Promise<readonly RedactionSearchRecord[]>;
  /** Sign off a detection: this removal was correct, or must happen. */
  approve(worldId: string, detectionId: string): Promise<void>;
  /** Record that a human judged this detection a false positive. */
  reject(worldId: string, detectionId: string): Promise<void>;
  /** Redact something the detectors missed. Lands as `applied: false`. */
  add(worldId: string, input: NewRedaction): Promise<void>;
}
