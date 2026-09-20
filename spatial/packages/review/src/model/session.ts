import type { WorldDocument } from '@m3xi/world-core';
import {
  correctionKey, describeCorrection,
  type CorrectionChange, type CorrectionRecord,
} from './corrections.js';
import { applyCorrections, type ApplyResult } from './apply.js';
import { validateWorld, type ValidationResult } from './validate.js';
import { nameIndex, planWire, type WireReport } from './wire.js';

/**
 * THE EDITING SESSION
 * ===================
 *
 * Everything an operator does between opening a world and pressing save, held
 * as one value: a base document that never changes, and an ordered list of
 * correction records.
 *
 * UNDO IS DROPPING A RECORD AND RECOMPUTING. There is no inverse operation per
 * field anywhere in this package, and that is the single reason this design
 * was chosen over an in-place editor. An inverse-per-field undo has to be
 * written correctly eighteen times, and each one has to remember what the
 * field was before -- including the parts a correction changes as a side
 * effect, like the provenance floor, the confidence, the receipt in
 * `Grounding.sources` and, for `entity.resize`, the centroid that moved
 * because the box grew upward from its base. Getting one of those wrong
 * produces a world that looks right and carries a laundered provenance.
 * Recomputing from the base cannot be wrong, because the base is untouched.
 *
 * The cost is recomputation: undo re-applies the whole list. For a list of a
 * few dozen records over a flat-sized document that is microseconds, and it is
 * paid only on an edit, never per frame. If a world ever arrives where it
 * matters, the fix is memoising prefixes of the list -- still pure, still no
 * inverses.
 *
 * A SECOND CORRECTION TO THE SAME FACT REPLACES THE FIRST. The list is a
 * review document that someone reads before saving, not a keystroke log, and
 * "Rename the hall to Halway. Rename the hall to Hallway." reads as two
 * decisions when it is one decision and a typo. `correctionKey` decides what
 * collides; `region.mark` and `world.approve` deliberately never collide.
 */

// ---------------------------------------------------------------------------
// Draft storage
// ---------------------------------------------------------------------------

/**
 * The slice of `localStorage` this uses. An interface rather than the real
 * thing so the tests can supply a store that throws on write -- which is not
 * a hypothetical, it is Safari private mode and a full quota.
 */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFT_KEY_PREFIX = 'm3xi.review.draft.';

/** Bumped when the stored shape changes, so an old draft is refused, not misread. */
export const DRAFT_FORMAT = 1;

export interface DraftPayload {
  readonly format: number;
  readonly worldId: string;
  /** The world version the corrections were made against. */
  readonly version: number;
  readonly by: string;
  readonly savedAt: string;
  readonly records: readonly CorrectionRecord[];
}

/**
 * Whether the operator's work is being kept anywhere but in this tab.
 *
 * `false` is a first-class state with a sentence attached, shown in the
 * editor, because the alternative -- a draft that silently is not saved -- is
 * how someone loses an afternoon. Private browsing, a full quota and a
 * storage-disabled profile all land here rather than throwing.
 */
export interface DraftStatus {
  readonly persisted: boolean;
  readonly reason: string | null;
  readonly savedAt: string | null;
}

/** What is in storage for this world, and whether it may be applied. */
export type DraftInspection =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly savedAt: string; readonly by: string; readonly count: number }
  | { readonly kind: 'refused'; readonly reason: string; readonly savedAt: string | null; readonly count: number };

/**
 * `localStorage`, if this environment has one that works.
 *
 * Reached through `globalThis` and a try/catch because merely NAMING
 * `localStorage` throws in a profile with site data disabled, and because this
 * package has to import cleanly in Node, where there is no such global.
 */
export function defaultDraftStore(): DraftStore | null {
  try {
    const store = (globalThis as { localStorage?: DraftStore }).localStorage;
    if (!store) return null;
    // Prove it works rather than trusting that it exists: Safari's private
    // mode has historically offered the object and thrown on every write.
    const probe = `${DRAFT_KEY_PREFIX}probe`;
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * A record id in the shape the server accepts.
 *
 * `crypto.randomUUID` where there is one. The fallback is `Math.random`, which
 * is not a CSPRNG and does not need to be: this id is a correlation key
 * between a list entry, a receipt in `Grounding.sources` and a log line. It is
 * not a secret, it grants nothing, and the server re-stamps the author and the
 * time regardless of what arrives. What it must be is unique within a world,
 * and 122 random bits is that.
 */
export function newRecordId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number): string => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface SessionOptions {
  readonly base: WorldDocument;
  readonly worldId: string;
  /** Operator identifier, for the local receipt. The server re-stamps it. */
  readonly by: string;
  /** Pass `null` to opt out of drafts entirely; omit to use `localStorage`. */
  readonly store?: DraftStore | null;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

export interface SessionState {
  readonly records: readonly CorrectionRecord[];
  readonly world: WorldDocument;
  readonly validation: ValidationResult;
  /** Records `applyCorrections` could not apply, with the engine's reason. */
  readonly skipped: ApplyResult['skipped'];
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly draft: DraftStatus;
}

type Listener = (state: SessionState) => void;

export class CorrectionSession {
  readonly base: WorldDocument;
  readonly worldId: string;
  readonly by: string;

  private readonly store: DraftStore | null;
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private readonly names: Readonly<Record<string, string>>;

  /**
   * The undo stack is a stack of LISTS, not of operations. Each entry is a
   * complete, immutable record list; moving between them is assignment.
   * `cursor` is which one is current, so redo is simply moving forward again
   * and any new edit truncates the future.
   */
  private history: readonly CorrectionRecord[][] = [[]];
  private cursor = 0;

  private listeners = new Set<Listener>();
  private cache: { records: readonly CorrectionRecord[]; result: ApplyResult; validation: ValidationResult } | null = null;
  private draft: DraftStatus = { persisted: true, reason: null, savedAt: null };

  constructor(opts: SessionOptions) {
    this.base = opts.base;
    this.worldId = opts.worldId;
    this.by = opts.by;
    this.store = opts.store === undefined ? defaultDraftStore() : opts.store;
    this.clock = opts.clock ?? (() => new Date());
    this.newId = opts.newId ?? newRecordId;
    this.names = nameIndex(opts.base);
    if (!this.store) {
      this.draft = {
        persisted: false,
        reason: 'This browser is not letting the page store anything, so your draft is not being saved. '
          + 'Finish and save before you close the tab.',
        savedAt: null,
      };
    }
  }

  // -- reading ------------------------------------------------------------

  get records(): readonly CorrectionRecord[] {
    return this.history[this.cursor] ?? [];
  }

  get dirty(): boolean {
    return this.records.length > 0;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.history.length - 1;
  }

  get draftStatus(): DraftStatus {
    return this.draft;
  }

  /** The corrected world: `base` plus every record, recomputed and memoised. */
  get world(): WorldDocument {
    return this.compute().result.doc;
  }

  get skipped(): ApplyResult['skipped'] {
    return this.compute().result.skipped;
  }

  get validation(): ValidationResult {
    return this.compute().validation;
  }

  get state(): SessionState {
    const { result, validation } = this.compute();
    return {
      records: this.records,
      world: result.doc,
      validation,
      skipped: result.skipped,
      dirty: this.dirty,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      draft: this.draft,
    };
  }

  /** One sentence per record, for the review list. */
  describe(record: CorrectionRecord): string {
    return describeCorrection(record.change, { names: this.names });
  }

  /** What the server will and will not keep. See `wire.ts`. */
  plan(): WireReport {
    return planWire(this.base, this.records, { names: this.names });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // -- writing ------------------------------------------------------------

  /**
   * Add a correction, replacing any pending correction to the same fact.
   *
   * The replacement keeps the earlier record's POSITION in the list. Order is
   * not cosmetic: the server applies the list in order and has no transaction,
   * so a rename that moved to the end could land after a delete that was
   * always meant to follow it.
   */
  add(change: CorrectionChange, note?: string): CorrectionRecord {
    const record: CorrectionRecord = {
      id: this.newId(),
      at: this.clock().toISOString(),
      by: this.by,
      change,
      ...(note && note.trim() ? { note: note.trim() } : {}),
    };
    const key = correctionKey(record);
    const current = this.records;
    const at = current.findIndex((r) => correctionKey(r) === key);
    const next = at >= 0
      ? current.map((r, i) => (i === at ? record : r))
      : [...current, record];
    this.commit(next);
    return record;
  }

  /** Withdraw one entry. The rest of the list is unaffected and recomputed. */
  remove(recordId: string): boolean {
    const current = this.records;
    const next = current.filter((r) => r.id !== recordId);
    if (next.length === current.length) return false;
    this.commit(next);
    return true;
  }

  clear(): void {
    if (this.records.length === 0) return;
    this.commit([]);
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.cursor -= 1;
    this.afterMove();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this.cursor += 1;
    this.afterMove();
    return true;
  }

  /**
   * Adopt a record list wholesale, as a restored draft or a reset after a
   * successful save. It lands as a new history entry, so an operator who
   * restores a draft by accident can undo it.
   */
  replaceAll(records: readonly CorrectionRecord[]): void {
    this.commit([...records]);
  }

  // -- drafts -------------------------------------------------------------

  private get draftKey(): string {
    return `${DRAFT_KEY_PREFIX}${this.worldId}`;
  }

  /**
   * What is in storage for this world, and whether it belongs to the world in
   * front of us.
   *
   * The version check is the point of this method. Corrections are records
   * about specific rows in a specific version: `entity.move` carries a
   * centroid in a coordinate frame, `dimension.set` supersedes a particular
   * figure, and `region.clear` names a row id. A rebuild between the draft and
   * now can have moved every one of them. Applying the draft anyway would put
   * a hand-placed sofa at coordinates from a world that no longer exists, with
   * a receipt saying an operator put it there. So it is refused, with the two
   * versions named, and the operator decides.
   */
  inspectDraft(): DraftInspection {
    if (!this.store) {
      return { kind: 'unavailable', reason: this.draft.reason ?? 'No draft storage is available in this browser.' };
    }
    let raw: string | null;
    try {
      raw = this.store.getItem(this.draftKey);
    } catch (err) {
      return { kind: 'unavailable', reason: `The draft could not be read: ${message(err)}` };
    }
    if (!raw) return { kind: 'none' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        kind: 'refused',
        reason: 'The saved draft is not readable. It has been left alone rather than guessed at; discard it to start clean.',
        savedAt: null,
        count: 0,
      };
    }

    const draft = asDraft(parsed);
    if (!draft) {
      return {
        kind: 'refused',
        reason: 'The saved draft is not in a shape this editor recognises, so it has not been applied.',
        savedAt: null,
        count: 0,
      };
    }
    if (draft.format !== DRAFT_FORMAT) {
      return {
        kind: 'refused',
        reason: `The saved draft was written by an older editor (format ${draft.format}, this one reads ${DRAFT_FORMAT}), so it has not been applied.`,
        savedAt: draft.savedAt,
        count: draft.records.length,
      };
    }
    if (draft.worldId !== this.worldId) {
      return {
        kind: 'refused',
        reason: `The saved draft belongs to world ${draft.worldId}, not to this one.`,
        savedAt: draft.savedAt,
        count: draft.records.length,
      };
    }
    if (draft.version !== this.base.version) {
      return {
        kind: 'refused',
        reason: `The draft was made against version ${draft.version} of this world and you are looking at version ${this.base.version}. `
          + 'The rooms and objects it names may have moved, been rebuilt or gone, so applying it would put your corrections on '
          + 'geometry you never saw. Start again against this version, or reopen version '
          + `${draft.version} if it is still available.`,
        savedAt: draft.savedAt,
        count: draft.records.length,
      };
    }
    return {
      kind: 'ready', savedAt: draft.savedAt, by: draft.by, count: draft.records.length,
    };
  }

  /**
   * Apply the stored draft if `inspectDraft` says it may be applied.
   *
   * Returns the inspection so a caller has one code path: a refusal carries
   * its reason and nothing is applied.
   */
  restoreDraft(): DraftInspection {
    const inspection = this.inspectDraft();
    if (inspection.kind !== 'ready' || !this.store) return inspection;
    try {
      const raw = this.store.getItem(this.draftKey);
      const draft = raw ? asDraft(JSON.parse(raw)) : null;
      if (!draft) return { kind: 'none' };
      this.replaceAll(draft.records);
      return inspection;
    } catch (err) {
      return { kind: 'unavailable', reason: `The draft could not be read: ${message(err)}` };
    }
  }

  discardDraft(): void {
    if (!this.store) return;
    try {
      this.store.removeItem(this.draftKey);
    } catch {
      // A draft that cannot be removed is not worth failing an edit over. The
      // version check refuses it on the next open regardless.
    }
  }

  // -- internals ----------------------------------------------------------

  private commit(records: readonly CorrectionRecord[]): void {
    // Anything ahead of the cursor is a future that this edit has replaced.
    this.history = [...this.history.slice(0, this.cursor + 1), [...records]];
    this.cursor = this.history.length - 1;
    this.afterMove();
  }

  private afterMove(): void {
    this.cache = null;
    this.persist();
    const state = this.state;
    for (const fn of this.listeners) fn(state);
  }

  /**
   * Write the draft, and never throw.
   *
   * Three failures are ordinary rather than exceptional: no store at all,
   * a store that refuses writes, and a quota that is full. All three end in
   * the same place -- `draft.persisted` false with a sentence the editor
   * shows -- because to the operator they are one fact: what is on the screen
   * is the only copy.
   */
  private persist(): void {
    if (!this.store) return;
    if (this.records.length === 0) {
      this.discardDraft();
      this.draft = { persisted: true, reason: null, savedAt: null };
      return;
    }
    const savedAt = this.clock().toISOString();
    const payload: DraftPayload = {
      format: DRAFT_FORMAT,
      worldId: this.worldId,
      version: this.base.version,
      by: this.by,
      savedAt,
      records: this.records,
    };
    try {
      this.store.setItem(this.draftKey, JSON.stringify(payload));
      this.draft = { persisted: true, reason: null, savedAt };
    } catch (err) {
      this.draft = {
        persisted: false,
        reason: `Your draft is not being saved: ${message(err)}. `
          + 'What is on this screen is the only copy, so finish and save rather than closing the tab.',
        savedAt: null,
      };
    }
  }

  private compute(): { result: ApplyResult; validation: ValidationResult } {
    const records = this.records;
    if (this.cache && this.cache.records === records) return this.cache;
    const result = applyCorrections(this.base, records);
    const validation = validateWorld(result.doc);
    this.cache = { records, result, validation };
    return this.cache;
  }
}

// ---------------------------------------------------------------------------
// Parsing what came out of storage
// ---------------------------------------------------------------------------

/**
 * Storage is untrusted input. It survives a version of this editor being
 * replaced, it can be edited by hand, and in a shared browser profile it was
 * not necessarily written by the person reading it. So the shape is checked
 * rather than cast, and anything that does not match is refused with a reason
 * instead of being coerced into a correction list.
 */
function asDraft(value: unknown): DraftPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['worldId'] !== 'string') return null;
  if (typeof v['version'] !== 'number' || !Number.isFinite(v['version'])) return null;
  if (typeof v['format'] !== 'number') return null;
  if (!Array.isArray(v['records'])) return null;

  const records: CorrectionRecord[] = [];
  for (const raw of v['records']) {
    const record = asRecord(raw);
    if (!record) return null;
    records.push(record);
  }
  return {
    format: v['format'],
    worldId: v['worldId'],
    version: v['version'],
    by: typeof v['by'] === 'string' ? v['by'] : 'unknown',
    savedAt: typeof v['savedAt'] === 'string' ? v['savedAt'] : '',
    records,
  };
}

function asRecord(value: unknown): CorrectionRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || typeof v['at'] !== 'string' || typeof v['by'] !== 'string') return null;
  const change = v['change'];
  if (typeof change !== 'object' || change === null) return null;
  if (typeof (change as Record<string, unknown>)['kind'] !== 'string') return null;
  // The kind is not checked against the union here. `applyCorrections` is
  // total over the union and skips what it cannot apply with a reason, and
  // `planWire` reports what the server will refuse; a draft carrying a kind
  // this build does not know reaches both of those and is reported, which is
  // more useful than being silently dropped at the door.
  return {
    id: v['id'],
    at: v['at'],
    by: v['by'],
    change: change as CorrectionChange,
    ...(typeof v['note'] === 'string' ? { note: v['note'] } : {}),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
