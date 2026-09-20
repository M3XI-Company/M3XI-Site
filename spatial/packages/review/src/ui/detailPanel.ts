import type { Grounding, MeasurementStandard } from '@m3xi/world-core';
import type { CorrectionChange, DimensionMethod, Instrument } from '../model/corrections.js';
import { el, replace, uniqueId } from './dom.js';
import {
  INSTRUMENT_LABEL, dimensionConsequence, dimensionProblem, provenanceConsequence,
  type ChoiceField, type CoverageField, type DangerField, type DetailField, type DetailModel,
  type DimensionField, type ProvenanceView, type SurfaceField, type TextField, type Vec3Field,
} from './detail.js';

/**
 * THE DETAIL PANEL
 * ================
 *
 * One selected object, its correctable fields, and -- beside every one of them
 * -- what correcting it will do to the world's claim about the property.
 *
 * Three rules this file exists to enforce, in the markup rather than in
 * guidance:
 *
 *   1. NOTHING IS APPLIED UNTIL IT IS COMPLETE. Every Apply button is disabled
 *      while its field's `make` returns null, and the reason is rendered as
 *      text beside the button and wired with `aria-describedby`, not hidden in
 *      a `title`. "Why can't I click this" is answered on the screen.
 *   2. A DIMENSION CANNOT BE ENTERED WITHOUT SAYING HOW IT IS KNOWN. The
 *      method radios have no default, which means the first render of this
 *      panel is in an invalid state on purpose. The flattering answer -- site
 *      measure, laser -- is one click away and is never the one already
 *      selected, because a pre-ticked box is an assertion nobody made.
 *   3. A DELETE STATES ITS CONSEQUENCE BEFORE IT HAPPENS. The checkbox in
 *      front of it exists so the sentence has to be read past.
 *
 * Every control is a real one: a `<label for>` pointing at a real `<input>`,
 * a `<fieldset><legend>` around the radio group, a real `<select>`. None of it
 * is a div with a click handler, so the operator's own assistive technology,
 * their browser's autofill and their keyboard all work without this file
 * knowing they exist.
 */

export interface DetailPanelOptions {
  onCorrection(change: CorrectionChange, note?: string): void;
}

export interface DetailPanelHandle {
  readonly root: HTMLElement;
  update(model: DetailModel | null): void;
  destroy(): void;
}

export function mountDetailPanel(opts: DetailPanelOptions): DetailPanelHandle {
  const root = el('section', { class: 'rv-panel', 'aria-labelledby': uniqueId('rv-detail-h') });
  let note = '';

  const emit = (change: CorrectionChange): void => {
    opts.onCorrection(change, note || undefined);
    note = '';
    // The note belongs to the correction it was written for. Carrying it to
    // the next one would attach somebody's reasoning about a bathroom door to
    // a bedroom wardrobe.
    const box = noteBox();
    if (box) box.value = '';
  };

  let noteRef: HTMLTextAreaElement | null = null;
  const noteBox = (): HTMLTextAreaElement | null => noteRef;

  const update = (model: DetailModel | null): void => {
    if (!model) {
      replace(root,
        el('h3', {}, 'Nothing selected'),
        el('p', { class: 'rv-hint' },
          'Choose a room, a doorway or an object on the plan. Use the arrow keys to move between them.'));
      return;
    }

    if (model.missing) {
      replace(root,
        el('h3', {}, model.title),
        el('div', { class: 'rv-note rv-note--info', role: 'status' }, model.missing));
      return;
    }

    const heading = el('h3', {}, model.title);
    const children: (Node | null)[] = [
      heading,
      el('p', { class: 'rv-hint' }, model.subtitle),
      model.provenance ? provenanceTable(model.provenance) : null,
    ];

    const noteId = uniqueId('rv-note');
    noteRef = el('textarea', {
      id: noteId,
      class: 'rv-textarea',
      rows: 2,
      maxlength: 500,
      oninput: (e: Event) => { note = (e.target as HTMLTextAreaElement).value; },
    });
    children.push(el('div', { class: 'rv-field' },
      el('label', { for: noteId }, 'Note for the next correction (optional)'),
      noteRef,
      el('span', { class: 'rv-hint' },
        'Goes into the audit trail beside the correction and onto the measurement record.')));

    for (const field of model.fields) {
      children.push(renderField(field, model.provenance, emit));
    }

    replace(root, ...children.filter((c): c is Node => c !== null));
  };

  return {
    root,
    update,
    destroy: () => { replace(root); noteRef = null; },
  };
}

// ---------------------------------------------------------------------------
// Provenance, stated before anything is changed
// ---------------------------------------------------------------------------

function provenanceTable(p: ProvenanceView): HTMLElement {
  const rows: (readonly [string, string])[] = [
    ['The pipeline says', p.now],
    ['Confidence', p.confidence.toFixed(2)],
    ['Cameras behind it', p.cameras === 0 ? 'none recorded' : String(p.cameras)],
    ['Naming or relabelling it', p.afterSemantic],
    ['Moving, resizing or measuring it', p.afterGeometric],
  ];
  if (p.corrected) {
    rows.push(['Already corrected by',
      p.operators.length > 0 ? p.operators.join(', ') : 'an operator (not named on this row)']);
  }
  return el('table', { class: 'rv-prov' },
    el('caption', { class: 'rv-sr' }, 'Provenance of the selected object, and what a correction would do to it'),
    el('tbody', {}, ...rows.map(([k, v]) => el('tr', {},
      el('th', { scope: 'row' }, k),
      el('td', {}, v)))));
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

type Emit = (change: CorrectionChange) => void;
type Prov = DetailModel['provenance'];

function renderField(field: DetailField, prov: Prov, emit: Emit): HTMLElement {
  switch (field.control) {
    case 'text': return textField(field, prov, emit);
    case 'choice': return choiceField(field, prov, emit);
    case 'vec3': return vec3Field(field, prov, emit);
    case 'dimension': return dimensionFieldView(field, emit);
    case 'surface': return surfaceFieldView(field, emit);
    case 'coverage': return coverageFieldView(field, emit);
    case 'danger': return dangerFieldView(field, emit);
  }
}

/**
 * An Apply button plus the sentence that explains why it is unavailable.
 *
 * The sentence is a sibling element wired with `aria-describedby`, not a
 * tooltip: a disabled control whose reason lives in a `title` is a control
 * nobody can find out about with a keyboard.
 */
function applyRow(
  label: string, run: () => void, describe: () => string | null,
): { row: HTMLElement; refresh: () => void } {
  const reasonId = uniqueId('rv-why');
  const reason = el('span', { id: reasonId, class: 'rv-hint' });
  const btn = el('button', {
    type: 'button', class: 'rv-btn', onclick: run, 'aria-describedby': reasonId,
  }, label);
  const refresh = (): void => {
    const why = describe();
    if (why) {
      btn.setAttribute('disabled', '');
      btn.setAttribute('aria-disabled', 'true');
      reason.textContent = why;
    } else {
      btn.removeAttribute('disabled');
      btn.setAttribute('aria-disabled', 'false');
      reason.textContent = '';
    }
  };
  refresh();
  return { row: el('div', {}, el('div', { class: 'rv-row' }, btn), reason), refresh };
}

function consequenceLine(change: CorrectionChange | null, prov: Prov): HTMLElement {
  const g: Grounding | null = prov
    ? { provenance: prov.provenance, confidence: prov.confidence }
    : null;
  return el('p', { class: 'rv-hint' },
    change && g ? provenanceConsequence(change, g) : '');
}

function textField(field: TextField, prov: Prov, emit: Emit): HTMLElement {
  const id = uniqueId('rv-f');
  let value = field.value;
  const consequence = consequenceLine(field.make(value), prov);
  const input = el('input', {
    id, class: 'rv-input', type: 'text', maxlength: field.maxLength, value,
    oninput: (e: Event) => {
      value = (e.target as HTMLInputElement).value;
      apply.refresh();
      const change = field.make(value);
      consequence.textContent = change && prov
        ? provenanceConsequence(change, { provenance: prov.provenance, confidence: prov.confidence })
        : '';
    },
  });
  const apply = applyRow(`Correct ${field.label.toLowerCase()}`, () => {
    const change = field.make(value);
    if (change) emit(change);
  }, () => (field.make(value) ? null : 'Enter a value first.'));

  return el('div', { class: 'rv-field' },
    el('label', { for: id }, field.label),
    input,
    field.hint ? el('span', { class: 'rv-hint' }, field.hint) : null,
    consequence,
    apply.row);
}

function choiceField(field: ChoiceField, prov: Prov, emit: Emit): HTMLElement {
  const id = uniqueId('rv-f');
  let value = field.value;
  const select = el('select', {
    id, class: 'rv-select',
    onchange: (e: Event) => { value = (e.target as HTMLSelectElement).value; apply.refresh(); },
  }, ...field.options.map((o) => el('option', {
    value: o.value, selected: o.value === field.value,
  }, o.label)));
  const apply = applyRow(`Correct ${field.label.toLowerCase()}`, () => {
    const change = field.make(value);
    if (change) emit(change);
  }, () => {
    if (value === field.value) return 'This is already what the world says.';
    return field.make(value) ? null : 'That combination is not a correction this world can take.';
  });

  return el('div', { class: 'rv-field' },
    el('label', { for: id }, field.label),
    select,
    field.hint ? el('span', { class: 'rv-hint' }, field.hint) : null,
    consequenceLine(field.make(value), prov),
    apply.row);
}

function vec3Field(field: Vec3Field, prov: Prov, emit: Emit): HTMLElement {
  const value: [number, number, number] = [field.value[0], field.value[1], field.value[2]];
  const inputs = [0, 1, 2].map((i) => {
    const id = uniqueId('rv-f');
    const input = el('input', {
      id, class: 'rv-input', type: 'number', step: '0.01', value: String(round(value[i]!)),
      oninput: (e: Event) => {
        value[i] = Number((e.target as HTMLInputElement).value);
        apply.refresh();
      },
    });
    return el('div', { class: 'rv-field' },
      el('label', { for: id }, field.axes[i] ?? `axis ${i}`), input);
  });

  const apply = applyRow(field.label, () => {
    const change = field.make([value[0], value[1], value[2]]);
    if (change) emit(change);
  }, () => (field.make([value[0], value[1], value[2]])
    ? null
    : 'All three figures must be numbers, and a size must be positive.'));

  return el('fieldset', { class: 'rv-field' },
    el('legend', {}, field.label),
    field.hint ? el('span', { class: 'rv-hint' }, field.hint) : null,
    el('div', { class: 'rv-row' }, ...inputs),
    consequenceLine(field.make([value[0], value[1], value[2]]), prov),
    apply.row);
}

/**
 * The dimension field. The one control in this editor that can make a figure
 * BETTER than the reconstruction, and the one that can quietly make a guess
 * look like a survey.
 *
 * Method has no preselected radio. Instrument appears only once a site
 * measurement is claimed, and it too has no default -- its first option is a
 * disabled placeholder, so "laser" is never what the form says before anybody
 * has answered.
 */
function dimensionFieldView(field: DimensionField, emit: Emit): HTMLElement {
  const valueId = uniqueId('rv-f');
  const standardId = uniqueId('rv-f');
  const instrumentId = uniqueId('rv-f');
  const groupName = uniqueId('rv-method');

  // Mutable on purpose: `DimensionInput` is readonly because it is a value
  // handed to `make`, and this is the form state on its way to becoming one.
  const input: {
    value: number;
    method: DimensionMethod | null;
    instrument: Instrument | null;
    standard: MeasurementStandard;
  } = {
    value: Number.NaN,
    method: null,
    instrument: null,
    standard: field.defaultStandard,
  };

  const consequence = el('p', { class: 'rv-hint' },
    dimensionConsequence(null, null, field.unit));
  const instrumentWrap = el('div', { class: 'rv-field', hidden: true });

  const refreshAll = (): void => {
    consequence.textContent = dimensionConsequence(
      input.method ?? null, input.instrument ?? null, field.unit,
    );
    if (input.method === 'site-measure') instrumentWrap.removeAttribute('hidden');
    else instrumentWrap.setAttribute('hidden', '');
    apply.refresh();
  };

  const valueInput = el('input', {
    id: valueId, class: 'rv-input', type: 'number', step: field.unit === 'm2' ? '0.01' : '0.001',
    min: '0', inputmode: 'decimal',
    oninput: (e: Event) => {
      input.value = Number((e.target as HTMLInputElement).value);
      refreshAll();
    },
  });

  const methodRadios = el('fieldset', { class: 'rv-field' },
    el('legend', {}, 'How do you know this figure?'),
    el('div', { class: 'rv-radios' },
      radio(groupName, 'estimate', 'I estimated it — from a plan, or by eye.', (v) => {
        input.method = v as DimensionMethod;
        input.instrument = null;
        refreshAll();
      }),
      radio(groupName, 'site-measure', 'I measured it on site.', (v) => {
        input.method = v as DimensionMethod;
        refreshAll();
      })));

  const instrumentSelect = el('select', {
    id: instrumentId, class: 'rv-select',
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      input.instrument = v ? (v as Instrument) : null;
      refreshAll();
    },
  },
  el('option', { value: '', selected: true }, 'Choose the instrument…'),
  ...(['laser', 'tape', 'unknown'] as const).map((i) =>
    el('option', { value: i }, INSTRUMENT_LABEL[i])));
  instrumentWrap.appendChild(el('label', { for: instrumentId }, 'Measured with'));
  instrumentWrap.appendChild(instrumentSelect);

  const standardSelect = el('select', {
    id: standardId, class: 'rv-select',
    onchange: (e: Event) => {
      input.standard = (e.target as HTMLSelectElement).value as MeasurementStandard;
    },
  }, ...field.standards.map((s) => el('option', {
    value: s.value, selected: s.value === field.defaultStandard,
  }, s.label)));

  const apply = applyRow(`Correct ${field.label.toLowerCase()}`, () => {
    const change = field.make({
      value: input.value as number,
      method: input.method ?? null,
      instrument: input.instrument ?? null,
      standard: input.standard,
    });
    if (change) emit(change);
  }, () => dimensionProblem(input));

  refreshAll();

  return el('fieldset', { class: 'rv-panel' },
    el('legend', {}, field.label),
    el('p', { class: 'rv-figure' },
      el('span', { class: 'rv-sr' }, 'The world currently says: '),
      field.currentText),
    field.hint ? el('p', { class: 'rv-hint' }, field.hint) : null,
    el('div', { class: 'rv-field' },
      el('label', { for: valueId }, `New figure (${field.unit === 'm2' ? 'square metres' : 'metres'})`),
      valueInput),
    methodRadios,
    instrumentWrap,
    el('div', { class: 'rv-field' },
      el('label', { for: standardId }, 'Measured to'),
      standardSelect,
      el('span', { class: 'rv-hint' },
        'A figure with no declared standard cannot be shown to anyone. GIA, NIA and IPMS give different numbers for the same building.')),
    consequence,
    apply.row);
}

function radio(
  name: string, value: string, label: string, onPick: (value: string) => void,
): HTMLElement {
  const id = uniqueId('rv-r');
  return el('div', { class: 'rv-radio' },
    el('input', {
      type: 'radio', id, name, value,
      onchange: () => onPick(value),
    }),
    el('label', { for: id }, el('span', {}, label)));
}

function surfaceFieldView(field: SurfaceField, emit: Emit): HTMLElement {
  const selectId = uniqueId('rv-f');
  const first = field.surfaces[0];
  let chosen = first?.id ?? '';
  let reflective = first?.isReflective ?? false;
  let glazed = first?.isGlazed ?? false;

  const current = (): { isReflective: boolean; isGlazed: boolean } | null => {
    const s = field.surfaces.find((x) => x.id === chosen);
    return s ? { isReflective: s.isReflective, isGlazed: s.isGlazed } : null;
  };
  const diff = (): { isReflective?: boolean; isGlazed?: boolean } => {
    const c = current();
    if (!c) return {};
    return {
      ...(reflective === c.isReflective ? {} : { isReflective: reflective }),
      ...(glazed === c.isGlazed ? {} : { isGlazed: glazed }),
    };
  };

  const reflectiveBox = el('input', {
    type: 'checkbox', id: uniqueId('rv-c'),
    onchange: (e: Event) => { reflective = (e.target as HTMLInputElement).checked; apply.refresh(); },
  });
  const glazedBox = el('input', {
    type: 'checkbox', id: uniqueId('rv-c'),
    onchange: (e: Event) => { glazed = (e.target as HTMLInputElement).checked; apply.refresh(); },
  });
  if (reflective) reflectiveBox.setAttribute('checked', '');
  if (glazed) glazedBox.setAttribute('checked', '');

  const select = el('select', {
    id: selectId, class: 'rv-select',
    onchange: (e: Event) => {
      chosen = (e.target as HTMLSelectElement).value;
      const c = current();
      reflective = c?.isReflective ?? false;
      glazed = c?.isGlazed ?? false;
      setChecked(reflectiveBox, reflective);
      setChecked(glazedBox, glazed);
      apply.refresh();
    },
  }, ...field.surfaces.map((s) => el('option', { value: s.id }, s.label)));

  const apply = applyRow('Correct these flags', () => {
    const change = field.make(chosen, diff());
    if (change) emit(change);
  }, () => {
    const d = diff();
    if (d.isReflective === undefined && d.isGlazed === undefined) {
      return 'Neither flag differs from what the world already says.';
    }
    return null;
  });

  return el('fieldset', { class: 'rv-panel' },
    el('legend', {}, field.label),
    field.hint ? el('p', { class: 'rv-hint' }, field.hint) : null,
    el('div', { class: 'rv-field' },
      el('label', { for: selectId }, 'Surface'),
      select),
    el('div', { class: 'rv-radio' },
      reflectiveBox,
      el('label', { for: reflectiveBox.id }, el('span', {}, 'Mirrored. A mirror invents a room behind it.'))),
    el('div', { class: 'rv-radio' },
      glazedBox,
      el('label', { for: glazedBox.id }, el('span', {}, 'Glazed. Glazing blows the depth out and puts a hole in the wall.'))),
    el('p', { class: 'rv-hint' },
      'Classed as semantic: the panel\'s polygon was reconstructed before you looked at it and still is. What changes is what we know the panel IS.'),
    apply.row);
}

function coverageFieldView(field: CoverageField, emit: Emit): HTMLElement {
  const groupName = uniqueId('rv-cov');
  const reasonId = uniqueId('rv-f');
  let provenance: 'inferred' | 'generated' | null = null;
  let reason = '';

  const reasonBox = el('textarea', {
    id: reasonId, class: 'rv-textarea', rows: 2, maxlength: 300,
    oninput: (e: Event) => { reason = (e.target as HTMLTextAreaElement).value; apply.refresh(); },
  });

  const apply = applyRow('Record the gap', () => {
    if (!provenance) return;
    const change = field.make(provenance, reason);
    if (change) emit(change);
  }, () => {
    if (!provenance) return 'Say which of the two this is.';
    if (!reason.trim()) return 'A coverage note must say why, because somebody will read it in six months.';
    return null;
  });

  return el('fieldset', { class: 'rv-panel' },
    el('legend', {}, field.label),
    field.hint ? el('p', { class: 'rv-hint' }, field.hint) : null,
    el('div', { class: 'rv-radios' },
      radio(groupName, 'inferred', 'Uncertain — the reconstruction is not confident here.', () => {
        provenance = 'inferred'; apply.refresh();
      }),
      radio(groupName, 'generated', 'Not surveyed — nobody looked. The viewer will refuse to walk in and every measurement crossing it publishes as indicative.', () => {
        provenance = 'generated'; apply.refresh();
      })),
    el('div', { class: 'rv-field' },
      el('label', { for: reasonId }, 'Why'),
      reasonBox),
    apply.row);
}

function dangerFieldView(field: DangerField, emit: Emit): HTMLElement {
  const checkId = uniqueId('rv-c');
  let understood = false;
  const check = el('input', {
    type: 'checkbox', id: checkId,
    onchange: (e: Event) => { understood = (e.target as HTMLInputElement).checked; apply.refresh(); },
  });
  const apply = applyRow(field.label, () => {
    if (understood) emit(field.make());
  }, () => (understood ? null : 'Tick the box above first. This one cannot be undone after it is saved.'));

  return el('fieldset', { class: 'rv-panel' },
    el('legend', {}, field.label),
    el('p', {}, field.consequence),
    el('div', { class: 'rv-radio' },
      check,
      el('label', { for: checkId }, el('span', {}, 'I have read what goes with it.'))),
    apply.row);
}

function setChecked(node: HTMLInputElement, on: boolean): void {
  node.checked = on;
  if (on) node.setAttribute('checked', '');
  else node.removeAttribute('checked');
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
