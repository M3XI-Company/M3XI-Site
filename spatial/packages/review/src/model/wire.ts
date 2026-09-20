import type { WorldDocument } from '@m3xi/world-core';
import {
  correctionTarget, describeCorrection,
  type CorrectionChange, type CorrectionKind, type CorrectionRecord, type DescribeContext,
} from './corrections.js';
import { isOperatorRegion } from './apply.js';

/**
 * TURNING A CORRECTION LIST INTO WHAT THE SERVER TAKES
 * ====================================================
 *
 * `applyCorrections` in apply.ts answers "what would this world look like".
 * This file answers the different and less comfortable question: "what will
 * actually still be there tomorrow".
 *
 * They are not the same question, and the gap between them is the reason this
 * file exists. The preview is computed in the browser from the document. The
 * save goes to `wv-worlds approve_corrections`, which writes rows, and the
 * world the operator sees next is RE-RENDERED from those rows. Anything the
 * rows cannot hold is lost between the preview they approved and the document
 * they get back -- silently, unless something says so first.
 *
 * The failure this is written against is specific and it is the worst one
 * available here. An operator marks fifteen corrections, presses save, reads
 * "15 applied", and one of them is gone: the room is still called what it was,
 * or the laser reading they walked across town for is showing the pipeline's
 * +/-20 mm. They have no reason to look, because the system told them it
 * worked. Later, that number is in a set of particulars.
 *
 * So every kind gets an honest answer here, including the three where the
 * honest answer is "not fully":
 *
 *   region.clear   may only withdraw an OPERATOR-added coverage note. The
 *                  server refuses a pipeline-recorded one BY NAME, because it
 *                  is the record that no camera looked there and the remedy
 *                  for that is a rescan. Worse for us: `Region` in the world
 *                  contract has no `source` field, so from the document alone
 *                  the editor CANNOT tell which it is. It says so rather than
 *                  guessing.
 *   region.mark    inserts a row whose id the server allocates, and
 *                  `wv_region` is not one of the four tables that carry
 *                  `correction_sources`, so the mark leaves no receipt in
 *                  `Grounding.sources` and `isHumanCorrected` will not see it.
 *   world.approve  is a sign-off. It is accepted and logged and it changes no
 *                  row, which is correct -- approving a world is not a fact
 *                  about the building -- but an operator who expects the
 *                  world's status to move is expecting the wrong thing.
 *
 * WHAT THIS IS NOT. It is a prediction, made from the document in front of us,
 * about a server we are not running. The server is the authority and it
 * reports its own `rejected` list. So the editor sends EVERYTHING, including
 * the records predicted to fail, and reconciles afterwards: a prediction that
 * quietly dropped a correction would be the same bug in a nicer coat.
 */

/** `MAX_CORRECTIONS` in `wv-worlds/handler.ts`. One request, at most this many. */
export const MAX_CORRECTIONS_PER_REQUEST = 500;

/**
 * The id shape `wv-worlds` accepts, from `uuid()` in `_wv_shared/http.ts`.
 *
 * Checked here because every kind resolves its target with that function and
 * refuses anything else by name, so an id that is not a uuid is a refusal we
 * can see coming without a round trip. Fixture worlds use readable ids like
 * `r_hall`, which is exactly the case this catches: the editor works perfectly
 * against the fixture and every save would be refused.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isServerId(id: string): boolean {
  return UUID.test(id);
}

/**
 * What the server does with a correction, from the operator's point of view.
 *
 * Note that 'signoff' is not a failure and 'insert' is not a plain success:
 * the value of this enum is that it refuses to collapse into a boolean.
 */
export type Persistence =
  /** A row changes, and the change is in the next rendered document. */
  | 'row'
  /** A new row appears, with an id the server allocates. */
  | 'insert'
  /** A row is deleted, and what hung off it goes too. */
  | 'removal'
  /** Accepted and logged; no row changes. */
  | 'signoff'
  /** The server will refuse this, and we can say why before we send it. */
  | 'refused'
  /** Only the server can decide, and the document does not carry what it decides on. */
  | 'server-decides';

/**
 * A correction as it goes on the wire.
 *
 * `at` and `by` are deliberately absent. The server stamps `at` from its own
 * clock and `by` from the verified token, and ignores a client-stated author.
 * Sending them anyway would put two authors on one record -- the one we sent
 * and the one that was recorded -- and invite the next reader to believe the
 * one that is easier to forge.
 */
export interface WireCorrection {
  readonly id: string;
  readonly change: CorrectionChange;
  readonly note?: string;
}

/**
 * The five text pairs `approve_corrections` accepted before the typed union,
 * and still accepts. Declared because `ApiClient.applyCorrections` is typed
 * against exactly this shape; see `CorrectionApi` in `session.ts`.
 */
export interface LegacyCorrection {
  readonly target: 'room' | 'entity';
  readonly id: string;
  readonly field: string;
  readonly value: string;
}

/** One way the saved world will differ from the preview, in the operator's words. */
export interface WireCaveat {
  /** Stable, so a test asserts on the rule rather than on the prose. */
  readonly code: string;
  readonly message: string;
}

export interface WireItem {
  readonly record: CorrectionRecord;
  readonly payload: WireCorrection;
  readonly persistence: Persistence;
  /** `describeCorrection`, so the list and this report read the same. */
  readonly sentence: string;
  /** One sentence: what the save leaves behind. */
  readonly persists: string;
  /** Present only when `persistence` is 'refused'. The server's own reason. */
  readonly refusal: string | null;
  /** Where the saved world will not match the preview the operator approved. */
  readonly caveats: readonly WireCaveat[];
}

export interface WireReport {
  readonly items: readonly WireItem[];
  /** Hand this to `applyCorrections`. Everything, in order, refusals included. */
  readonly payload: readonly WireCorrection[];
  /** Records this editor expects the server to refuse. */
  readonly refused: readonly WireItem[];
  /** Records that will save differently from the preview, or not completely. */
  readonly caveated: readonly WireItem[];
  /** True when the list is longer than one request may carry. */
  readonly overBatchLimit: boolean;
  /**
   * True when a save is worth offering at all: at least one record, and the
   * batch limit not exceeded. A list of pure refusals is still offered,
   * because the server is the authority on refusal and this is a prediction.
   */
  readonly sendable: boolean;
}

// ---------------------------------------------------------------------------
// What each kind leaves behind
// ---------------------------------------------------------------------------

/**
 * The default persistence class per kind, before the record's own contents are
 * looked at. Every kind is named: a `Record` over `CorrectionKind` means a
 * nineteenth kind added to the union breaks this file at compile time rather
 * than falling through to a cheerful default at run time.
 */
const PERSISTENCE: Readonly<Record<CorrectionKind, Persistence>> = {
  'room.rename': 'row',
  'room.kind': 'row',
  'room.delete': 'removal',
  'entity.label': 'row',
  'entity.category': 'row',
  'entity.room': 'row',
  'entity.move': 'row',
  'entity.resize': 'row',
  'entity.delete': 'removal',
  'dimension.set': 'row',
  'surface.flags': 'row',
  'opening.kind': 'row',
  'opening.connects': 'row',
  'entrance.set': 'row',
  'region.mark': 'insert',
  'region.clear': 'server-decides',
  'world.approve': 'signoff',
};

/**
 * One sentence per kind, in the operator's terms, about what survives the
 * save. These are read off the server handler, not guessed: where the handler
 * writes a column, this says which; where it writes a measurement row as well,
 * this says so, because that row is what a certificate is reissued from.
 */
const PERSISTS: Readonly<Record<CorrectionKind, string>> = {
  'room.rename': 'The room keeps this name, with your receipt on the row.',
  'room.kind': 'The room keeps this kind, with your receipt on the row.',
  'room.delete':
    'The room, its walls, floor and ceiling, and every doorway and window that named it are removed. '
    + 'Its furniture, viewpoints, cameras and coverage notes stay, detached. None of it comes back.',
  'entity.label': 'The object keeps this label, with your receipt on the row.',
  'entity.category': 'The object keeps this category, with your receipt on the row.',
  'entity.room': 'The object keeps this room, with your receipt on the row.',
  'entity.move':
    'The object keeps this position, and its bounding boxes move with it. '
    + 'Its geometry is recorded as estimated from here on, which widens every measurement that crosses it.',
  'entity.resize':
    'The object keeps this size, measured up from where it stands. '
    + 'Its geometry is recorded as estimated from here on.',
  'entity.delete': 'The object is removed, along with anything the scene graph said about it. It does not come back.',
  'dimension.set':
    'The figure is written to the row and a measurement record is written beside it, '
    + 'naming you, the method and the instrument. That record is what a measurement certificate is issued from.',
  'surface.flags': 'The surface keeps these flags, with your receipt on the row.',
  'opening.kind': 'The opening keeps this kind, with your receipt on the row.',
  'opening.connects': 'The opening keeps these rooms, with your receipt on the row.',
  'entrance.set':
    'This viewpoint becomes the only entrance, and every other is cleared. '
    + 'Viewpoints carry no receipt column, so the audit trail for this one is the server log rather than the document.',
  'region.mark':
    'The coverage note is recorded against the world and appears in the next rendered document.',
  'region.clear': 'The coverage note is removed and the volume is no longer flagged.',
  'world.approve':
    'Your sign-off is recorded in the audit log. It changes no fact about the building, '
    + 'so nothing in the world moves, and publishing remains a separate decision.',
};

// ---------------------------------------------------------------------------
// The wire form
// ---------------------------------------------------------------------------

/**
 * A `CorrectionRecord` as `normaliseCorrection` prefers to receive it: an
 * envelope carrying an id, the typed change, and the operator's note.
 */
export function toWire(record: CorrectionRecord): WireCorrection {
  return {
    id: record.id,
    change: record.change,
    ...(record.note ? { note: record.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlanOptions extends DescribeContext {}

/**
 * Work out, before anything is sent, what this list will and will not leave
 * behind.
 *
 * `base` is the world the corrections were made against, not the preview: the
 * questions asked here -- does this id exist, is this region one we added, did
 * an earlier delete take this row away -- are questions about the rows the
 * server holds.
 */
export function planWire(
  base: WorldDocument,
  records: readonly CorrectionRecord[],
  opts: PlanOptions = {},
): WireReport {
  const names = opts.names ?? nameIndex(base);
  const ctx: DescribeContext = { names };

  // Rows an earlier record in this same list will have removed by the time the
  // server reaches a later one. The server has no transaction -- fifteen
  // corrections are fifteen writes -- so order is real, and a correction that
  // names a row a previous delete cascaded away is refused rather than queued.
  const removed = new Set<string>();

  const items: WireItem[] = [];
  for (const record of records) {
    const item = planOne(base, record, ctx, removed);
    items.push(item);
    if (item.persistence !== 'refused') noteRemovals(base, record.change, removed);
  }

  return {
    items,
    payload: items.map((i) => i.payload),
    refused: items.filter((i) => i.persistence === 'refused'),
    caveated: items.filter((i) => i.caveats.length > 0),
    overBatchLimit: records.length > MAX_CORRECTIONS_PER_REQUEST,
    sendable: records.length > 0 && records.length <= MAX_CORRECTIONS_PER_REQUEST,
  };
}

function planOne(
  base: WorldDocument,
  record: CorrectionRecord,
  ctx: DescribeContext,
  removed: ReadonlySet<string>,
): WireItem {
  const change = record.change;
  const caveats: WireCaveat[] = [];
  let persistence = PERSISTENCE[change.kind];
  let refusal: string | null = null;

  const refuse = (reason: string): void => {
    if (refusal === null) { refusal = reason; persistence = 'refused'; }
  };
  const caveat = (code: string, message: string): void => {
    caveats.push({ code, message });
  };

  // -- the record id ------------------------------------------------------
  //
  // Not a refusal: `normaliseCorrection` falls back to a server-allocated id.
  // It is still worth saying, because the receipt written into
  // `Grounding.sources` is then a different id from the one in this list, and
  // `correctionIdsOf` on the reloaded world will not match this entry.
  if (!isServerId(record.id)) {
    caveat('record.id-not-uuid',
      'This entry has no server-shaped id, so the server will allocate its own. '
      + 'The receipt in the saved world will not match the id shown here.');
  }

  // -- the target ---------------------------------------------------------
  const target = correctionTarget(change);
  // `region.mark` has no target row yet, and `region.clear` has three distinct
  // answers of its own below, each more useful than "that is not a uuid".
  if (target.type !== 'world' && change.kind !== 'region.mark' && change.kind !== 'region.clear') {
    if (!isServerId(target.id)) {
      refuse(`The server identifies rows by uuid and '${target.id}' is not one, so it will refuse this correction by name.`);
    } else if (removed.has(target.id)) {
      refuse(`An earlier correction in this list removes ${target.type} '${target.id}', and the server applies the list in order, so by the time it reaches this one there is nothing to correct.`);
    }
  }

  // -- kind-specific honesty ----------------------------------------------
  switch (change.kind) {
    case 'room.delete':
      // The preview and the server genuinely disagree here, and the preview is
      // the conservative one. apply.ts leaves the openings alone so validate.ts
      // reports each dangling doorway as a blocker -- the operator is made to
      // decide. The server's delete takes them with the room. Saying so stops
      // the operator believing the door they never resolved survived.
      caveat('room.delete.openings-cascade',
        'On the server, every doorway and window naming this room is deleted with it. '
        + 'The preview keeps them and reports each one as a blocker, so that you decide rather than discover it afterwards.');
      break;

    case 'dimension.set': {
      const t = change.target;
      if (t.kind === 'room.area') {
        caveat('dimension.area.tolerance-floor',
          'The area tolerance stored on the room never tightens below this world\'s policy, even for a laser reading, '
          + 'because that column is read as the world\'s wall policy rather than as one room\'s accuracy. '
          + 'Your declared half-width is kept in the measurement record a certificate is issued from, not in the room row.');
      }
      if (t.kind === 'opening.width' || t.kind === 'opening.height' || t.kind === 'opening.sill') {
        caveat('dimension.opening.tolerance-not-stored',
          'The opening row stores the value, not its tolerance: the rendered document rebuilds every opening dimension '
          + 'with this world\'s wall tolerance. Your instrument\'s half-width is kept in the measurement record, '
          + 'so the certificate is right and the document reads the policy figure.');
      }
      if (change.method === 'site-measure' && change.instrument === 'unknown') {
        caveat('dimension.instrument-undeclared',
          'This is recorded as a site measurement with no instrument named, so its accuracy is undeclared '
          + 'and it is treated exactly like an estimate: not defensible, shown as indicative.');
      }
      break;
    }

    case 'region.mark':
      caveat('region.mark.server-id',
        'The coverage note is inserted with an id the server allocates, so the id in this preview is not the one it will have.');
      caveat('region.mark.no-receipt',
        'Coverage notes carry no receipt column, so this one will not show up as human-corrected in the saved world. '
        + 'The audit trail for it is the server log and the note\'s own text, which names you.');
      break;

    case 'region.clear': {
      // The prefix test goes through `isOperatorRegion` rather than through a
      // literal 'rg_' so apply.ts stays the single place that decides what an
      // operator-added region id looks like. The stand-in volume is never read.
      const local = isOperatorRegion({
        id: change.regionId, provenance: 'inferred', volume: { min: [0, 0, 0], max: [0, 0, 0] },
      });
      const region = base.regions.find((r) => r.id === change.regionId);
      if (local) {
        // `rg_` is the id apply.ts gives a note marked in THIS session, which
        // exists only in the preview. The row it would withdraw has never been
        // saved. Removing the `region.mark` entry from the list is the right
        // move, and the editor can say so instead of sending a pair that
        // cancels on one side and is refused on the other.
        refuse('This withdraws a coverage note added in this session, which the server has never seen. '
          + 'Remove the note from the list instead of withdrawing it.');
      } else if (!isServerId(change.regionId)) {
        refuse(`The server identifies coverage notes by uuid and '${change.regionId}' is not one, so it will refuse this correction by name.`);
      } else if (!region) {
        refuse(`There is no coverage note '${change.regionId}' in this world, so there is nothing for the server to withdraw.`);
      } else {
        // The one place the editor genuinely cannot answer. The server decides
        // on `wv_region.source`, which the world contract does not carry: to a
        // document reader, a pipeline survey gap and an operator's note are a
        // uuid and a volume. Guessing either way would be worse than saying so.
        persistence = 'server-decides';
        caveat('region.clear.source-unknown',
          'Only an operator-added coverage note can be withdrawn. A survey gap the pipeline recorded needs a rescan, '
          + 'and the server refuses it by name. The world document does not say which this is, so this correction '
          + 'may come back refused, and that refusal is the correct answer rather than a fault.');
        caveat('region.clear.preview-refuses',
          'The preview leaves this note in place, because it cannot prove the note is yours. '
          + 'If the server accepts the withdrawal, the saved world will have one fewer coverage note than the preview shows.');
      }
      break;
    }

    case 'entrance.set':
      caveat('entrance.set.no-receipt',
        'Viewpoints carry no receipt column, so the saved world will not show this as human-corrected. '
        + 'The audit trail is the server log.');
      break;

    case 'world.approve':
      caveat('world.approve.no-row',
        'Sign-off changes no row, so nothing in the saved world will look different afterwards. '
        + 'It is recorded in the audit log, and publishing is still a separate decision with its own gate.');
      break;

    default:
      break;
  }

  return {
    record,
    payload: toWire(record),
    persistence,
    sentence: describeCorrection(change, ctx),
    persists: refusal === null ? PERSISTS[change.kind] : 'Nothing. This correction will not be applied.',
    refusal,
    caveats,
  };
}

/**
 * Record what the server will have removed once this change has been applied,
 * so a later record naming one of those rows can be reported rather than sent
 * into a refusal nobody was warned about.
 *
 * Only the cascades the SERVER performs are recorded, because this set is
 * about the server's state. The room delete's opening cascade is exactly the
 * case: the preview keeps those openings, so nothing local would notice.
 */
function noteRemovals(
  base: WorldDocument, change: CorrectionChange, removed: Set<string>,
): void {
  if (change.kind === 'entity.delete') {
    removed.add(change.entityId);
    return;
  }
  if (change.kind !== 'room.delete') return;
  removed.add(change.roomId);
  for (const s of base.surfaces) if (s.roomId === change.roomId) removed.add(s.id);
  for (const o of base.openings) {
    if (o.roomA === change.roomId || o.roomB === change.roomId) removed.add(o.id);
  }
  for (const n of base.nav.nodes) if (n.roomId === change.roomId) removed.add(n.id);
}

/**
 * Display names for the sentences, so a report reads "Rename Bedroom 1" rather
 * than "Rename 6f2c...". Openings and surfaces have no name in the contract,
 * so they keep their ids and `describeCorrection` prints them as such.
 */
export function nameIndex(doc: WorldDocument): Readonly<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const r of doc.rooms) names[r.id] = r.name ?? r.id;
  for (const e of doc.entities) names[e.id] = e.label;
  return names;
}

// ---------------------------------------------------------------------------
// Reconciling what actually happened
// ---------------------------------------------------------------------------

export interface SaveOutcome {
  readonly applied: number;
  readonly rejected: readonly string[];
}

export interface SaveReconciliation {
  readonly applied: number;
  readonly rejected: readonly string[];
  /** True when the server refused something this report did not predict. */
  readonly surprises: boolean;
  /** One sentence for the operator, whatever happened. */
  readonly summary: string;
}

/**
 * Read the server's answer back against the prediction.
 *
 * The server's `rejected` is a list of sentences, not of record ids, so this
 * cannot pair them up one for one. What it can do -- and what matters -- is
 * refuse to report an unqualified success when the counts do not agree, and
 * say plainly when something was refused that this editor did not see coming,
 * because that is the case where the prediction above needs fixing.
 */
export function reconcile(report: WireReport, outcome: SaveOutcome): SaveReconciliation {
  const sent = report.payload.length;
  const rejected = outcome.rejected ?? [];
  const predicted = report.refused.length;
  const surprises = rejected.length > predicted;

  let summary: string;
  if (rejected.length === 0) {
    summary = `All ${sent} ${sent === 1 ? 'correction was' : 'corrections were'} applied.`;
  } else if (outcome.applied === 0) {
    summary = `None of the ${sent} ${sent === 1 ? 'correction' : 'corrections'} was applied. `
      + `The server refused ${rejected.length === 1 ? 'it' : 'them all'}.`;
  } else {
    summary = `${outcome.applied} of ${sent} applied. `
      + `${rejected.length} refused${surprises ? ', which this editor did not predict' : ''}.`;
  }
  return { applied: outcome.applied, rejected, surprises, summary };
}
