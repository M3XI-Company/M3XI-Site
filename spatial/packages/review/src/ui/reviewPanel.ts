import type { CorrectionRecord } from '../model/corrections.js';
import type { SessionState } from '../model/session.js';
import type { WireItem, WireReport } from '../model/wire.js';
import type { ValidationIssue, ValidationResult } from '../model/validate.js';
import { el, replace, uniqueId } from './dom.js';
import type { PlanSelection, PlanTargetType } from './plan.js';

/**
 * THE REVIEW SIDE OF THE EDITOR
 * =============================
 *
 * Three panels that together answer "what have I decided, what does it break,
 * and what will actually be saved".
 *
 * THE CORRECTION LIST IS A REVIEW DOCUMENT, NOT A KEYSTROKE LOG. Each entry is
 * the sentence `describeCorrection` produces -- "Set the floor area of
 * Bedroom 1 to 13.95 m², measured on site with a laser." -- with who made it
 * and when, and a control to withdraw that one entry without touching the
 * others. It reads like something a person signs off, because that is what it
 * is: the audit trail of an evidential claim, not an undo buffer.
 *
 * VALIDATION IS BINARY AND IT IS SHOWN AS IT CHANGES. A blocker means save is
 * not offered; a warning means save is offered with the warning attached.
 * There is no middle tier, because a middle tier is the tier operators learn
 * to scroll past. Every issue is a button that selects the thing it is about,
 * so "this is broken" and "here is the broken thing" are one click apart.
 *
 * THE SAVE BAR SAYS WHAT WILL NOT SURVIVE, BEFORE THE SAVE. `planWire` knows
 * which records the server will refuse and where the saved world will differ
 * from the preview. Reporting that after a cheerful "15 applied" is how an
 * operator loses a correction without ever knowing.
 */

// ---------------------------------------------------------------------------
// The correction list
// ---------------------------------------------------------------------------

export interface CorrectionListOptions {
  onRemove(recordId: string): void;
  onUndo(): void;
  onRedo(): void;
  describe(record: CorrectionRecord): string;
}

export interface CorrectionListHandle {
  readonly root: HTMLElement;
  update(state: SessionState, plan: WireReport): void;
  destroy(): void;
}

export function mountCorrectionList(opts: CorrectionListOptions): CorrectionListHandle {
  const headingId = uniqueId('rv-list-h');
  const root = el('section', { class: 'rv-panel', 'aria-labelledby': headingId });

  const update = (state: SessionState, plan: WireReport): void => {
    const heading = el('h3', { id: headingId },
      state.records.length === 0
        ? 'Corrections'
        : `Corrections (${state.records.length})`);

    const controls = el('div', { class: 'rv-row' },
      el('button', {
        type: 'button', class: 'rv-btn', onclick: opts.onUndo,
        disabled: !state.canUndo, 'aria-disabled': state.canUndo ? 'false' : 'true',
      }, 'Undo'),
      el('button', {
        type: 'button', class: 'rv-btn', onclick: opts.onRedo,
        disabled: !state.canRedo, 'aria-disabled': state.canRedo ? 'false' : 'true',
      }, 'Redo'));

    if (state.records.length === 0) {
      replace(root, heading, controls,
        el('p', { class: 'rv-hint' },
          'Nothing corrected yet. Everything this world says is still what the pipeline said.'));
      return;
    }

    const byId = new Map(plan.items.map((i) => [i.record.id, i] as const));
    const list = el('ul', { class: 'rv-list' },
      ...state.records.map((record) => entry(record, byId.get(record.id), opts)));

    const skipped = state.skipped.length > 0
      ? el('div', { class: 'rv-note rv-note--warn', role: 'status' },
        el('strong', {}, `${state.skipped.length} of these cannot be applied to this world`),
        el('ul', { class: 'rv-list' }, ...state.skipped.map((s) =>
          el('li', {}, `${opts.describe(s.record)} — ${s.reason}`))))
      : null;

    replace(root, heading, controls, list, skipped);
  };

  return { root, update, destroy: () => replace(root) };
}

function entry(
  record: CorrectionRecord, item: WireItem | undefined, opts: CorrectionListOptions,
): HTMLElement {
  const sentence = item?.sentence ?? opts.describe(record);
  const body = el('div', {},
    el('span', {}, sentence),
    el('div', { class: 'rv-who' }, `${record.by} · ${when(record.at)}`),
    record.note ? el('div', { class: 'rv-who' }, `Note: ${record.note}`) : null,
    item?.refusal
      ? el('div', { class: 'rv-note rv-note--bad' },
        el('strong', {}, 'This one will not be saved'), item.refusal)
      : null,
    ...(item?.caveats ?? []).map((c) =>
      el('div', { class: 'rv-note rv-note--info' }, c.message)),
  );

  return el('li', {}, body, el('button', {
    type: 'button', class: 'rv-btn rv-btn--quiet',
    onclick: () => opts.onRemove(record.id),
    // The visible word is short because the column is narrow; the accessible
    // name carries the whole sentence, so "Remove, Remove, Remove" is not what
    // a screen reader announces down a list of twelve.
    'aria-label': `Remove this correction: ${sentence}`,
  }, 'Remove'));
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface IssuesOptions {
  onSelect(selection: PlanSelection): void;
}

export interface IssuesHandle {
  readonly root: HTMLElement;
  update(result: ValidationResult): void;
  destroy(): void;
}

const SELECTABLE: Readonly<Record<string, PlanTargetType>> = {
  room: 'room', entity: 'entity', opening: 'opening', region: 'region',
};

export function mountIssues(opts: IssuesOptions): IssuesHandle {
  const headingId = uniqueId('rv-issues-h');
  const root = el('section', { class: 'rv-panel', 'aria-labelledby': headingId });

  const update = (result: ValidationResult): void => {
    const heading = el('h3', { id: headingId }, 'What this breaks');

    if (result.issues.length === 0) {
      replace(root, heading,
        el('div', { class: 'rv-note rv-note--ok', role: 'status' },
          'Nothing in this world is broken. Every room has an outline and a declared area, '
          + 'every doorway connects rooms that exist, and every object is inside one.'));
      return;
    }

    // The live region is the point of this panel: validation changes as the
    // operator edits, and a blocker appearing three panels down is no use to
    // somebody who is not looking at it.
    const summary = el('div', {
      class: result.blockers.length > 0 ? 'rv-note rv-note--bad' : 'rv-note rv-note--warn',
      role: 'status', 'aria-live': 'polite',
    },
    el('strong', {}, result.blockers.length > 0
      ? `${count(result.blockers.length, 'blocker')}: this cannot be saved`
      : `${count(result.warnings.length, 'warning')}: this can be saved, and the ${result.warnings.length === 1 ? 'warning goes' : 'warnings go'} with it`),
    result.blockers.length > 0
      ? 'Fix or withdraw the corrections that caused them.'
      : 'Read them before you sign off.');

    replace(root, heading, summary,
      ...result.blockers.map((i) => issueRow(i, opts)),
      ...result.warnings.map((i) => issueRow(i, opts)));
  };

  return { root, update, destroy: () => replace(root) };
}

function issueRow(issue: ValidationIssue, opts: IssuesOptions): HTMLElement {
  const word = issue.level === 'blocker' ? 'Blocker' : 'Warning';
  const text = el('span', {},
    el('span', { class: 'rv-level' }, word),
    issue.message);

  const type = issue.ref ? SELECTABLE[issue.ref.type] : undefined;
  if (!issue.ref || !type) {
    return el('div', { class: `rv-issue rv-issue--${issue.level}` }, text);
  }
  const ref = issue.ref;
  return el('div', { class: `rv-issue rv-issue--${issue.level}` },
    el('button', {
      type: 'button', class: 'rv-btn rv-btn--quiet',
      onclick: () => opts.onSelect({ type, id: ref.id }),
      'aria-label': `${word}: ${issue.message}. Select it on the plan.`,
    }, text));
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The save bar
// ---------------------------------------------------------------------------

export interface SaveBarOptions {
  onSave(): void;
  onSignOff(note: string): void;
  onDiscardDraft(): void;
}

export interface SaveBarHandle {
  readonly root: HTMLElement;
  update(state: SessionState, plan: WireReport, busy: boolean, message: string | null): void;
  destroy(): void;
}

export function mountSaveBar(opts: SaveBarOptions): SaveBarHandle {
  const headingId = uniqueId('rv-save-h');
  const root = el('section', { class: 'rv-panel', 'aria-labelledby': headingId });
  let signOffNote = '';

  const update = (
    state: SessionState, plan: WireReport, busy: boolean, message: string | null,
  ): void => {
    const signedOff = state.records.some((r) => r.change.kind === 'world.approve');
    const why = saveBlockedReason(state, plan, signedOff, busy);

    const noteId = uniqueId('rv-signoff');
    const signOff = signedOff
      ? el('div', { class: 'rv-note rv-note--ok' },
        'Signed off. Withdraw the sign-off from the list above if you are not ready.')
      : el('div', { class: 'rv-field' },
        el('label', { for: noteId }, 'Sign-off note (optional)'),
        el('textarea', {
          id: noteId, class: 'rv-textarea', rows: 2, maxlength: 500,
          oninput: (e: Event) => { signOffNote = (e.target as HTMLTextAreaElement).value; },
        }),
        el('span', { class: 'rv-hint' },
          'Signing off records that you, by name, checked these corrections against the property. '
          + 'It changes no fact about the building and it is not publication.'),
        el('button', {
          type: 'button', class: 'rv-btn',
          disabled: state.records.length === 0,
          'aria-disabled': state.records.length === 0 ? 'true' : 'false',
          onclick: () => opts.onSignOff(signOffNote),
        }, 'Sign off these corrections'));

    const reasonId = uniqueId('rv-save-why');
    const save = el('button', {
      type: 'button', class: 'rv-btn rv-btn--primary',
      disabled: why !== null,
      'aria-disabled': why === null ? 'false' : 'true',
      'aria-describedby': reasonId,
      onclick: opts.onSave,
    }, busy ? 'Saving…' : 'Save corrections');

    replace(root,
      el('h3', { id: headingId }, 'Save'),
      draftNote(state, opts),
      wireNote(plan),
      signOff,
      el('div', { class: 'rv-row' }, save),
      el('p', { id: reasonId, class: 'rv-hint' }, why ?? ''),
      message
        ? el('div', {
          class: 'rv-note rv-note--info', role: 'status', 'aria-live': 'polite',
        }, message)
        : el('div', { class: 'rv-sr', role: 'status', 'aria-live': 'polite' }, ''));
  };

  return { root, update, destroy: () => replace(root) };
}

/**
 * Why the save button is unavailable, in one sentence, or null when it is
 * available. Rendered as text beside the button rather than as a tooltip.
 */
export function saveBlockedReason(
  state: SessionState, plan: WireReport, signedOff: boolean, busy: boolean,
): string | null {
  if (busy) return 'Saving. Wait for the server to answer before changing anything else.';
  if (state.records.length === 0) return 'There is nothing to save yet.';
  if (state.validation.blockers.length > 0) {
    return `This world has ${count(state.validation.blockers.length, 'blocker')}. `
      + 'Saving it would publish a property that contradicts itself, so save is not offered until they are gone.';
  }
  if (plan.overBatchLimit) {
    return 'This is more corrections than one request may carry. Save in smaller batches.';
  }
  if (!signedOff) {
    return 'Sign off first. The list is an audit trail, and an audit trail with no named reviewer is not one.';
  }
  return null;
}

function draftNote(state: SessionState, opts: SaveBarOptions): HTMLElement | null {
  if (!state.draft.persisted) {
    return el('div', { class: 'rv-note rv-note--warn', role: 'status' },
      el('strong', {}, 'Your draft is not being saved'),
      state.draft.reason ?? '');
  }
  if (!state.draft.savedAt) return null;
  return el('div', { class: 'rv-row' },
    el('span', { class: 'rv-hint' }, `Draft kept in this browser, last at ${when(state.draft.savedAt)}.`),
    el('button', {
      type: 'button', class: 'rv-btn rv-btn--quiet', onclick: opts.onDiscardDraft,
    }, 'Discard draft'));
}

/**
 * The sentence that stops a correction being lost quietly.
 *
 * Rendered whether or not anything is wrong, because "all fifteen will be
 * saved as you see them" is itself worth saying before somebody commits to a
 * representation about a stranger's home.
 */
function wireNote(plan: WireReport): HTMLElement | null {
  if (plan.items.length === 0) return null;
  if (plan.refused.length === 0 && plan.caveated.length === 0) {
    return el('div', { class: 'rv-note rv-note--ok' },
      `All ${plan.items.length} will be saved exactly as the preview shows them.`);
  }
  const lines: HTMLElement[] = [];
  if (plan.refused.length > 0) {
    lines.push(el('p', {}, el('strong', {},
      `${count(plan.refused.length, 'correction')} will not be saved:`)));
    for (const item of plan.refused) {
      lines.push(el('p', {}, `${item.sentence} ${item.refusal ?? ''}`));
    }
  }
  if (plan.caveated.length > 0) {
    lines.push(el('p', {}, el('strong', {},
      `${count(plan.caveated.length, 'correction')} will save differently from the preview:`)));
    for (const item of plan.caveated) {
      for (const caveat of item.caveats) {
        lines.push(el('p', {}, `${item.sentence} ${caveat.message}`));
      }
    }
  }
  return el('div', {
    class: plan.refused.length > 0 ? 'rv-note rv-note--bad' : 'rv-note rv-note--warn',
    role: 'status',
  }, ...lines);
}
