import type { WorldDocument } from '@m3xi/world-core';
import type { CorrectionChange } from '../model/corrections.js';
import { CorrectionSession, type DraftStore } from '../model/session.js';
import { operatorName, sendCorrections, type CorrectionApi } from '../model/client.js';
import { buildDetail } from './detail.js';
import { buildPlan, sameSelection, type PlanModel, type PlanSelection } from './plan.js';
import { el, replace } from './dom.js';
import { ensureReviewStyles } from './styles.js';
import { mountDetailPanel } from './detailPanel.js';
import { mountPlan } from './planView.js';
import { mountCorrectionList, mountIssues, mountSaveBar } from './reviewPanel.js';
import { mountViewerBridge } from './viewerBridge.js';

/**
 * THE CORRECTION EDITOR
 * =====================
 *
 * Composition, and nothing else. The plan decides what can be picked, the
 * detail panel decides what can be corrected, `validate.ts` decides what is
 * broken and `wire.ts` decides what will survive a save. This file wires those
 * four to a `CorrectionSession` and re-renders when it changes.
 *
 * The one decision it does make is the SAVE GATE, and it makes it in `save()`
 * rather than in the button, because the console mounts its own Save button
 * beside this editor and calls the same handle. A gate that lived in the
 * button would be a gate with a door next to it:
 *
 *   - a blocker refuses the save outright;
 *   - a warning does not, and travels with it;
 *   - an unsigned list refuses the save, because a list of evidential claims
 *     with no named reviewer is not an audit trail.
 *
 * Failures are loud. A `world` this cannot read a document out of throws from
 * `mountCorrectionEditor` with the reason, which the console's seam renders as
 * "The correction editor failed to start" plus that sentence. It does not
 * mount an empty plan: an empty plan and a property with no rooms look
 * identical, and only one of them is a fault.
 */

/** Structural stand-in for `World` from `@m3xi/spatial-engine`. */
export type WorldLike = object;

/**
 * One field on one row, as the console's `Correction` type declares it. The
 * console uses it to count what is pending; see `emitLegacy` below.
 */
export interface LegacyCorrectionSignal {
  readonly target: 'room' | 'entity';
  readonly id: string;
  readonly field: string;
  readonly value: string;
}

export interface CorrectionEditorOptions {
  /** A `World` from the spatial engine, or the `WorldDocument` itself. */
  readonly world: WorldLike;
  readonly worldId: string;
  readonly api: CorrectionApi;
  onDirty(dirty: boolean): void;
  onCorrection(c: LegacyCorrectionSignal): void;
  /** Test seam. Omit for `localStorage`; pass null to disable drafts. */
  readonly store?: DraftStore | null;
}

export interface CorrectionEditorHandle {
  destroy(): void;
  save(): Promise<void>;
}

export function mountCorrectionEditor(
  host: HTMLElement, opts: CorrectionEditorOptions,
): CorrectionEditorHandle {
  const doc = readDocument(opts.world);
  ensureReviewStyles(host.ownerDocument ?? undefined);

  const session = new CorrectionSession({
    base: doc,
    worldId: opts.worldId,
    by: operatorName(opts.api),
    ...(opts.store === undefined ? {} : { store: opts.store }),
  });

  let selection: PlanSelection | null = null;
  let plan: PlanModel = buildPlan(doc);
  let busy = false;
  let message: string | null = null;
  let lastDirty = false;

  const root = el('div', { class: 'rv' });
  const left = el('div', {});
  const right = el('div', {});
  const banner = el('div', {});

  const planView = mountPlan({
    onSelect: (next) => {
      if (sameSelection(next, selection)) return;
      selection = next;
      render();
    },
  });

  const detailPanel = mountDetailPanel({
    onCorrection: (change, note) => apply(change, note),
  });

  const list = mountCorrectionList({
    onRemove: (id) => { session.remove(id); },
    onUndo: () => { session.undo(); },
    onRedo: () => { session.redo(); },
    describe: (record) => session.describe(record),
  });

  const issues = mountIssues({
    onSelect: (next) => { selection = next; render(); },
  });

  const saveBar = mountSaveBar({
    onSave: () => { void save(); },
    onSignOff: (note) => {
      apply({ kind: 'world.approve', ...(note.trim() ? { note: note.trim() } : {}) });
    },
    onDiscardDraft: () => { session.discardDraft(); render(); },
  });

  // The viewer is mounted once and never re-rendered: restarting a WebGL
  // context on every keystroke would be both slow and wrong, and the corrected
  // document it is handed is read at the moment the operator opens it.
  const viewer = mountViewerBridge({ doc: () => session.world });

  replace(left, banner, planView.root, viewer.root);
  replace(right, detailPanel.root, list.root, issues.root, saveBar.root);
  replace(root, left, right);
  host.appendChild(root);

  const unsubscribe = session.subscribe(() => {
    // The preview is a pure function of base plus records, so the plan is
    // rebuilt from the corrected world rather than patched. A patched plan is
    // a second implementation of `applyCorrections` that can disagree with the
    // first one.
    plan = buildPlan(session.world);
    render();
  });

  renderBanner();
  render();

  function apply(change: CorrectionChange, note?: string): void {
    const record = session.add(change, note);
    // `add` has already told the subscriber, which rendered with the previous
    // message. Set the new one and render again rather than leaving the
    // operator's own action unacknowledged until their next keystroke.
    message = `Added: ${session.describe(record)}`;
    emitLegacy(change);
    render();
  }

  /**
   * Tell the console about the corrections it can express.
   *
   * `Correction` on the console's side is the five legacy text pairs, and it
   * keys a pending map by `target:id:field`. Thirteen of the eighteen kinds
   * have no honest shape in it: there is no `{target:'room', field:'area_m2'}`
   * the server would accept, and handing the console one would put a rejected
   * shape into the map that gates its Publish button.
   *
   * Nothing is lost by staying quiet about them. `onDirty(true)` fires for
   * every correction, and the console gates publication on
   * `dirty || pending.size > 0`.
   */
  function emitLegacy(change: CorrectionChange): void {
    switch (change.kind) {
      case 'room.rename':
        opts.onCorrection({ target: 'room', id: change.roomId, field: 'name', value: change.name });
        return;
      case 'room.kind':
        opts.onCorrection({ target: 'room', id: change.roomId, field: 'kind', value: change.roomKind });
        return;
      case 'entity.label':
        opts.onCorrection({ target: 'entity', id: change.entityId, field: 'label', value: change.label });
        return;
      case 'entity.category':
        opts.onCorrection({ target: 'entity', id: change.entityId, field: 'category', value: change.category });
        return;
      case 'entity.room':
        opts.onCorrection({
          target: 'entity', id: change.entityId, field: 'room_id', value: change.roomId ?? '',
        });
        return;
      default:
        return;
    }
  }

  function renderBanner(): void {
    const draft = session.inspectDraft();
    if (draft.kind === 'none') { replace(banner); return; }

    if (draft.kind === 'unavailable') {
      replace(banner, el('div', { class: 'rv-note rv-note--warn', role: 'status' },
        el('strong', {}, 'Drafts are not available in this browser'), draft.reason));
      return;
    }

    if (draft.kind === 'refused') {
      replace(banner, el('div', { class: 'rv-note rv-note--bad', role: 'status' },
        el('strong', {}, 'A saved draft was found and has NOT been applied'),
        draft.reason,
        el('div', { class: 'rv-row', style: 'margin-top:8px' },
          el('button', {
            type: 'button', class: 'rv-btn',
            onclick: () => { session.discardDraft(); renderBanner(); },
          }, 'Discard that draft'))));
      return;
    }

    replace(banner, el('div', { class: 'rv-note rv-note--info', role: 'status' },
      el('strong', {}, 'You have an unsaved draft for this world'),
      `${draft.count} ${draft.count === 1 ? 'correction' : 'corrections'}, last kept ${draft.savedAt}, by ${draft.by}. `
      + 'It was made against this same version of the world.',
      el('div', { class: 'rv-row', style: 'margin-top:8px' },
        el('button', {
          type: 'button', class: 'rv-btn rv-btn--primary',
          onclick: () => {
            const result = session.restoreDraft();
            message = result.kind === 'ready'
              ? `Restored ${result.count} ${result.count === 1 ? 'correction' : 'corrections'} from your draft.`
              : 'The draft could not be restored.';
            renderBanner();
            render();
          },
        }, 'Restore it'),
        el('button', {
          type: 'button', class: 'rv-btn',
          onclick: () => { session.discardDraft(); renderBanner(); },
        }, 'Discard it'))));
  }

  function render(): void {
    const state = session.state;
    const wire = session.plan();

    planView.update(plan, selection);
    detailPanel.update(selection ? buildDetail(state.world, selection) : null);
    list.update(state, wire);
    issues.update(state.validation);
    saveBar.update(state, wire, busy, message);

    if (state.dirty !== lastDirty) {
      lastDirty = state.dirty;
      opts.onDirty(state.dirty);
    }
  }

  /**
   * The save gate, and the one place the server's answer is read back.
   *
   * It rejects rather than returning quietly, because the console's own Save
   * button turns a rejection into a visible toast and a silent resolve into a
   * claim that the corrections were written.
   */
  async function save(): Promise<void> {
    const state = session.state;
    if (state.records.length === 0) throw new Error('There are no corrections to save.');
    if (state.validation.blockers.length > 0) {
      throw new Error(
        `This world has ${state.validation.blockers.length} blocker(s) and cannot be saved: `
        + state.validation.blockers.map((b) => b.message).join(' '),
      );
    }
    if (!state.records.some((r) => r.change.kind === 'world.approve')) {
      throw new Error(
        'Sign off the corrections before saving. The list is an audit trail, and an audit trail with no named reviewer is not one.',
      );
    }

    busy = true;
    message = null;
    render();
    try {
      const outcome = await sendCorrections(opts.api, opts.worldId, session.plan());
      message = outcome.summary + (outcome.rejected.length > 0
        ? ` Refused: ${outcome.rejected.join('; ')}`
        : '');
      if (outcome.rejected.length === 0) {
        // Everything landed, so the list has done its job and the draft with
        // it. Anything refused stays in the list on purpose: the operator has
        // to decide what to do about it, and clearing it would be the quiet
        // loss this package exists to prevent.
        session.clear();
        session.discardDraft();
      }
      if (outcome.rejected.length > 0) {
        throw new Error(message);
      }
    } finally {
      busy = false;
      renderBanner();
      render();
    }
  }

  return {
    destroy(): void {
      unsubscribe();
      planView.destroy();
      detailPanel.destroy();
      list.destroy();
      issues.destroy();
      saveBar.destroy();
      viewer.destroy();
      replace(root);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
    save,
  };
}

/**
 * Get a `WorldDocument` out of whatever the console handed over.
 *
 * `apps/console` passes `World.fromDocument(doc)` when the engine loads and
 * the raw document when it does not, and both are typed `object` at the seam.
 * Reading `.doc` first and falling back to the value itself covers both
 * honestly.
 *
 * Anything else throws. A correction editor with no world is not a degraded
 * editor, it is a lie with input boxes: every control would produce a
 * correction against nothing, and the operator would find out when the save
 * was refused.
 */
export function readDocument(world: unknown): WorldDocument {
  const candidate = (world as { doc?: unknown } | null)?.doc ?? world;
  if (isWorldDocument(candidate)) return candidate;
  throw new TypeError(
    'The correction editor was given something that is neither a World nor a WorldDocument, '
    + 'so there is nothing to correct. This is a wiring fault in the page that mounted it, not a fault in the world.',
  );
}

function isWorldDocument(v: unknown): v is WorldDocument {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return Array.isArray(d['rooms'])
    && Array.isArray(d['entities'])
    && Array.isArray(d['openings'])
    && Array.isArray(d['surfaces'])
    && typeof d['measurementPolicy'] === 'object' && d['measurementPolicy'] !== null;
}
