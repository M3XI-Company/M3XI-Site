import type {
  Cell, ChecklistItem, ComplianceDocument, DetectionRow, DocBlock, DocSection, Figure,
  TableBlock, TableColumn, UnpresentableFigure,
} from '../model/document.js';
import { humanDateTime, PRESENTATION_WORD } from '../model/document.js';
import { h, hx, toHtml, type VElement, type VNode } from '../render/vnode.js';
import { COMPLIANCE_CSS } from './styles.js';

/**
 * One renderer for all four documents, producing a tree that is materialised
 * into the console's DOM and serialised into the file somebody keeps.
 *
 * The markup is the accessibility work. Not a layer on top of it:
 *
 *   -- a table is a `<table>` with a `<caption>`, a `<thead>` and `scope`d
 *      headers, so a screen reader announces "Bedroom 1, floor area, 13.95
 *      square metres" instead of reading a grid of numbers;
 *   -- a checklist is an `<ol>` of `<li>`, each with a real `<label>` bound to
 *      a real control by id, so clicking the label focuses the field and the
 *      field announces what it is for;
 *   -- a figure's status is a WORD in the cell, plus a `<span class="cp-sr">`
 *      carrying the reason for anybody who cannot see the second line;
 *   -- every disabled control carries its reason in an element that is read,
 *      not only in a `title` a keyboard user never sees.
 *
 * The one thing this file deliberately does NOT do is decide anything. Which
 * figures are indicative, which items are unanswered, what a detection means:
 * all of that is settled in `model/` and arrives here already decided. A
 * renderer that made judgements would be a second place for the rules to live,
 * and the second place is always the one that is wrong.
 */

export interface DocumentHandlers {
  /** Current checklist answers, keyed by item id. Not persisted anywhere. */
  readonly checklistValues?: ReadonlyMap<string, string>;
  onChecklistInput?(itemId: string, value: string): void;
  onApprove?(detectionId: string): void;
  onReject?(detectionId: string): void;
  onAddRedaction?(input: { cameraId: string; kind: string; bbox: [number, number, number, number] }): void;
  /** Cameras the operator can attach a new redaction to. */
  readonly cameraOptions?: readonly { readonly id: string; readonly label: string }[];
  readonly redactionKinds?: readonly string[];
  /** Disables the add form, with the reason shown beside it. */
  readonly addDisabledReason?: string;
}

export function renderDocument(
  doc: ComplianceDocument, handlers: DocumentHandlers = {},
): VElement {
  return h('article', { class: 'cp-doc', 'aria-labelledby': `cp-title-${doc.kind}` },
    h('h1', { id: `cp-title-${doc.kind}` }, doc.title),
    h('p', { class: 'cp-subtitle' },
      `${doc.subtitle} — issued ${humanDateTime(doc.issuedAt)}`),
    h('div', { class: 'cp-standing', role: 'note', 'aria-label': 'What this document is' },
      ...doc.standing.map((text) => h('p', {}, text))),
    ...doc.sections.map((section) => renderSection(doc, section, handlers)),
    renderFooter(doc));
}

function renderSection(
  doc: ComplianceDocument, section: DocSection, handlers: DocumentHandlers,
): VElement {
  const classes = section.pageBreakBefore ? 'cp-section cp-section--break' : 'cp-section';
  const headingId = `cp-${doc.kind}-${section.id}`;
  return h('section', { class: classes, 'aria-labelledby': headingId },
    h(section.level === 2 ? 'h2' : 'h3', { id: headingId }, section.heading),
    ...section.blocks.map((block) => renderBlock(doc, section, block, handlers)));
}

function renderBlock(
  doc: ComplianceDocument, section: DocSection, block: DocBlock, handlers: DocumentHandlers,
): VNode {
  switch (block.kind) {
    case 'paragraph':
      return h('p', {}, block.text);

    case 'list':
      return h('div', {},
        block.intro ? h('p', {}, block.intro) : null,
        h('ul', {}, ...block.items.map((item) => h('li', {}, item))));

    case 'facts':
      return h('dl', { class: 'cp-facts' },
        ...block.pairs.flatMap(([label, value]) => [
          h('dt', {}, label),
          h('dd', {}, value),
        ]));

    case 'note':
      return h('div', { class: `cp-note cp-note--${block.tone}`, role: 'note' },
        h('h4', {}, block.heading),
        h('p', {}, block.text));

    case 'measurement':
      return h('dl', { class: 'cp-facts' },
        h('dt', {}, block.label),
        h('dd', {},
          h('span', { class: 'cp-figure-value' }, block.formatted.value),
          ' ',
          h('span', { class: 'cp-figure-tol' }, block.formatted.tolerance),
          ' · ',
          block.formatted.standardShort,
          block.formatted.statusNote
            ? h('span', { class: 'cp-status-reason' },
              `INDICATIVE. ${block.formatted.statusNote}`)
            : null));

    case 'figure':
      return renderFigureBlock(block.figure);

    case 'unpresentable':
      return renderUnpresentable(block.figure);

    case 'table':
      return renderTable(block);

    case 'checklist':
      return renderChecklist(doc, block.items, handlers);

    case 'detections':
      return renderDetections(section, block.caption, block.rows, block.emptyMessage, handlers);
  }
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * One dimension, whole.
 *
 * Six things have to travel together or the entry is not a certified figure:
 * what it is, the value, the tolerance, the standard, the confidence and what
 * produced it. They are in one block that never breaks across a page, so a
 * reader holding page four cannot be holding a number whose standard was on
 * page three.
 *
 * The confidence is printed with the provenance word beside it, because 0.94
 * on its own is a number nobody can act on: 0.94 from a photographed wall and
 * 0.94 from a model's guess at a wall are different claims, and the contract
 * keeps them apart precisely so a document like this can.
 */
function renderFigureBlock(figure: Figure): VElement {
  const declared = figure.declared;
  return h('div', { class: 'cp-figure' },
    h('dl', { class: 'cp-facts' },
      h('dt', {}, `${figure.subject} — ${figure.what}`),
      h('dd', {}, figureValue(figure), ' ', figureStatus(figure))),
    h('p', { class: 'cp-figure-basis' },
      `Confidence ${figure.confidence.toFixed(2)}, ${figure.provenanceLabel}.`,
      figure.humanTouched
        ? ` A human correction has touched this record${figure.operators.length > 0
          ? ` (${figure.operators.join(', ')})` : ''}.`
        : null),
    h('p', { class: 'cp-figure-basis' }, figure.basis),
    declared && declared.supersededValue !== undefined
      ? h('p', { class: 'cp-figure-basis' },
        `Supersedes the reconstruction's ${declared.supersededValue}`
        + `${declared.supersededStandard ? ` (${declared.supersededStandard})` : ''}, `
        + 'which is kept so that both figures survive.')
      : null);
}

/**
 * The number, its tolerance and its standard, always together.
 *
 * ALWAYS ALL THREE, in the cell itself. An earlier version of this function
 * printed the value and the tolerance and left the standard to a column of the
 * table, which is fine in a table and silently wrong everywhere else -- the
 * checklist shows figures in a definition list, and there a figure would have
 * reached a reader without the standard that defines it. GIA, NIA and IPMS 3C
 * give different numbers for the same room, so that is not a formatting
 * detail; it is the claim.
 *
 * `formatted.full` is the viewer's own single line and could be printed as one
 * string. It is split into spans instead so a column of figures lines up on
 * the decimal point when a reader scans down it, and so the tolerance and the
 * standard can take the quieter colour without becoming a different claim. The
 * spoken form is the viewer's `speech`, which expands every symbol.
 */
function figureValue(figure: Figure): VElement {
  return h('span', {},
    h('span', { class: 'cp-figure-value' }, figure.formatted.value),
    ' ',
    h('span', { class: 'cp-figure-tol' }, figure.formatted.tolerance),
    ' · ',
    h('span', { class: 'cp-figure-tol' }, figure.formatted.standardShort),
    h('span', { class: 'cp-sr' }, ` ${figure.formatted.speech}`));
}

function figureStatus(figure: Figure): VElement {
  const kind = figure.presentation === 'measured' ? 'measured'
    : figure.presentation === 'declared' ? 'declared' : 'indicative';
  return h('span', { class: `cp-status-word cp-status--${kind}` },
    PRESENTATION_WORD[figure.presentation],
    figure.reason ? h('span', { class: 'cp-status-reason' }, figure.reason) : null);
}

function renderUnpresentable(figure: UnpresentableFigure): VElement {
  return h('div', { class: 'cp-note cp-note--bad', role: 'note' },
    h('h4', {}, `${figure.subject} — ${figure.what}: cannot be certified`),
    h('p', {}, figure.reason));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function renderTable(block: TableBlock): VElement {
  if (block.rows.length === 0) {
    return h('div', {},
      h('p', { class: 'cp-empty' },
        block.emptyMessage ?? 'Nothing to show in this table.'));
  }
  return h('div', { class: 'cp-table-wrap' },
    h('table', { class: 'cp-table' },
      h('caption', {}, block.caption),
      h('thead', {},
        h('tr', {}, ...block.columns.map((c) => h('th', {
          scope: 'col', class: c.numeric ? 'cp-num' : null,
        }, c.label)))),
      h('tbody', {}, ...block.rows.map((row) => renderRow(row, block.columns)))),
    block.note ? h('p', { class: 'cp-table-note' }, block.note) : null);
}

function renderRow(row: readonly Cell[], columns: readonly TableColumn[]): VElement {
  return h('tr', {}, ...row.map((cell, i) => {
    const column = columns[i];
    const tag = column?.rowHeader ? 'th' : 'td';
    const attrs = {
      ...(column?.rowHeader ? { scope: 'row' } : {}),
      ...(column?.numeric ? { class: 'cp-num' } : {}),
    };
    if (typeof cell === 'string') return h(tag, attrs, cell);
    // A figure cell renders as the value, or as the status word, depending on
    // which column it landed in: the same object is used for both so that a
    // row cannot show a figure in one column and a status belonging to another.
    return h(tag, attrs, column?.key === 'status'
      ? figureStatus(cell)
      : figureValue(cell));
  }));
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

function renderChecklist(
  doc: ComplianceDocument, items: readonly ChecklistItem[], handlers: DocumentHandlers,
): VElement {
  return h('ol', { class: 'cp-items' },
    ...items.map((item) => renderChecklistItem(doc, item, handlers)));
}

/**
 * An unanswered item has to READ as unanswered.
 *
 * Three signals, and all three are words or structure rather than styling,
 * because this is the row that decides whether a checklist is honest:
 *
 *   1. the word UNANSWERED where the answer would be;
 *   2. the specific reason the survey cannot supply it -- never "n/a", never
 *      an em dash, which is what a table cell uses for "nothing to say";
 *   3. an empty labelled field, which prints as a ruled line to write on.
 *
 * An answered item shows the value and no field at all: a survey measurement
 * is not something an agent should be able to overtype in a compliance
 * document, and a box around it invites exactly that.
 */
function renderChecklistItem(
  doc: ComplianceDocument, item: ChecklistItem, handlers: DocumentHandlers,
): VElement {
  const fieldId = `cp-${doc.kind}-${item.id}`;
  const answered = item.answer.state === 'from-survey';
  const value = handlers.checklistValues?.get(item.id) ?? '';

  return h('li', { class: 'cp-item' },
    h('div', { class: 'cp-item-head' },
      h('span', { class: 'cp-item-label' }, `${item.part}. ${item.label}`),
      h('span', { class: `cp-status-word cp-status--${answered ? 'measured' : 'indicative'}` },
        answered ? 'FROM THE SURVEY' : 'UNANSWERED')),
    h('p', { class: 'cp-item-guidance' }, item.guidance),
    item.answer.state === 'from-survey'
      ? h('p', { class: 'cp-item-answer' }, item.answer.value)
      : h('p', { class: 'cp-item-reason' },
        `This checklist has no answer for this item. ${item.answer.reason}`),
    item.answer.state === 'from-survey' && item.answer.figures && item.answer.figures.length > 0
      ? h('dl', { class: 'cp-facts' },
        ...item.answer.figures.flatMap((figure) => [
          h('dt', {}, `${figure.subject} — ${figure.what}`),
          h('dd', {}, figureValue(figure), ' ', figureStatus(figure)),
        ]))
      : null,
    item.answer.state === 'unanswered' ? renderField(fieldId, item, value, handlers) : null,
    item.evidence.length > 0
      ? h('div', {},
        h('p', { class: 'cp-item-guidance' },
          answered
            ? 'From the survey:'
            : 'What the survey does record about this, which is evidence and not an answer:'),
        h('ul', { class: 'cp-item-evidence' },
          ...item.evidence.map((line) => h('li', {}, line))))
      : null);
}

function renderField(
  fieldId: string, item: ChecklistItem, value: string, handlers: DocumentHandlers,
): VElement {
  const label = h('label', { class: 'cp-field-label', for: fieldId },
    `Answer — ${item.label}`);
  const onInput = handlers.onChecklistInput;

  if (item.input === 'choice' && item.choices) {
    const options = ['', ...item.choices].map((choice) => h('option', {
      value: choice, selected: choice === value ? true : null,
    }, choice === '' ? 'Not yet answered' : choice));
    return h('div', { class: 'cp-field' }, label,
      onInput
        ? hx('select', { id: fieldId, class: 'cp-select' }, {
          change: (event: Event) => {
            onInput(item.id, (event.target as HTMLSelectElement).value);
          },
        }, ...options)
        : h('select', { id: fieldId, class: 'cp-select' }, ...options));
  }

  const tag = item.input === 'longtext' ? 'textarea' : 'input';
  const attrs: Record<string, string | boolean | null> = {
    id: fieldId,
    class: item.input === 'longtext' ? 'cp-textarea' : 'cp-input',
    ...(item.placeholder ? { placeholder: item.placeholder } : {}),
    ...(tag === 'input'
      ? { type: 'text', value, inputmode: item.input === 'money' ? 'decimal' : null }
      : {}),
  };
  const field = onInput
    ? hx(tag, attrs, {
      input: (event: Event) => {
        onInput(item.id, (event.target as HTMLInputElement | HTMLTextAreaElement).value);
      },
    }, tag === 'textarea' ? value : null)
    : h(tag, attrs, tag === 'textarea' ? value : null);

  return h('div', { class: 'cp-field' }, label, field);
}

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

function renderDetections(
  section: DocSection,
  caption: string,
  rows: readonly DetectionRow[],
  emptyMessage: string,
  handlers: DocumentHandlers,
): VElement {
  const addForm = renderAddForm(handlers);
  if (rows.length === 0) {
    return h('div', {}, h('p', { class: 'cp-empty' }, emptyMessage), addForm);
  }

  // The column is always present, and what is in it changes. A table that
  // drops the column when nothing can be done hides the fact that there IS a
  // decision to record here, which is the fact a DPO is reading for. When it
  // cannot be used -- no write capability, or a saved copy of the report
  // opened away from the console -- it holds a disabled control carrying its
  // reason, the way `console-ui` handles every other unavailable action.
  const live = handlers.onApprove !== undefined && handlers.onReject !== undefined;

  return h('div', {},
    h('div', { class: 'cp-table-wrap' },
      h('table', { class: 'cp-table' },
        h('caption', {}, caption),
        h('thead', {},
          h('tr', {},
            h('th', { scope: 'col' }, 'What'),
            h('th', { scope: 'col' }, 'Frame'),
            h('th', { scope: 'col' }, 'Where in the frame'),
            h('th', { scope: 'col' }, 'Detector'),
            h('th', { scope: 'col', class: 'cp-num' }, 'Score'),
            h('th', { scope: 'col' }, 'Pixels'),
            h('th', { scope: 'col' }, 'Decision'),
            h('th', { scope: 'col', class: 'cp-noprint' }, 'Record a decision'))),
        h('tbody', {}, ...rows.map((row) => h('tr', {},
          h('th', { scope: 'row' }, row.kindLabel),
          h('td', {}, row.camera),
          h('td', {}, row.bbox),
          h('td', {}, row.detector),
          h('td', { class: 'cp-num' }, row.score),
          h('td', {}, row.pixels),
          h('td', {},
            row.decision,
            row.reviewedAt
              ? h('span', { class: 'cp-status-reason' },
                `${row.reviewedBy ? `${row.reviewedBy}, ` : ''}${humanDateTime(row.reviewedAt)}`)
              : null),
          h('td', { class: 'cp-noprint' }, renderRowActions(row, handlers, live))))))),
    addForm);
}

function renderRowActions(
  row: DetectionRow, handlers: DocumentHandlers, live: boolean,
): VNode {
  if (!row.actionable || !live) {
    // The reason is a real element rather than a `title`, so it is read by a
    // screen reader and visible on a phone, both of which a tooltip is not.
    const reasonId = `cp-why-${row.id}`;
    return h('div', {},
      h('button', {
        class: 'cp-btn cp-btn--small', type: 'button', disabled: true,
        'aria-disabled': 'true', 'aria-describedby': reasonId,
      }, 'Approve'),
      h('span', { id: reasonId, class: 'cp-status-reason' },
        row.actionsReason
        ?? 'This is a saved copy of the report. Decisions are recorded in the compliance '
          + 'centre, against the live records.'));
  }
  const approve = handlers.onApprove;
  const reject = handlers.onReject;
  return h('div', { class: 'cp-actions' },
    approve
      ? hx('button', { class: 'cp-btn cp-btn--small', type: 'button' },
        { click: () => approve(row.id) },
        'Approve', h('span', { class: 'cp-sr' }, ` the ${row.kindLabel} detection in ${row.camera}`))
      : null,
    reject
      ? hx('button', { class: 'cp-btn cp-btn--small', type: 'button' },
        { click: () => reject(row.id) },
        'Reject', h('span', { class: 'cp-sr' }, ` the ${row.kindLabel} detection in ${row.camera}`))
      : null);
}

/**
 * Adding a redaction the detectors missed.
 *
 * The box is in image pixels because that is what `wv_redaction.bbox` holds
 * and what the redact stage consumes, and the form says so rather than
 * pretending there is a point-and-drag tool here -- there is not, because this
 * pane has no frame viewer. An operator who needs one has the review screen.
 *
 * The camera is a `<select>` of the frames in this world, not a free-text
 * uuid: the server refuses a camera that is not in the world, and making the
 * operator discover that by being refused would be a worse form than none.
 */
function renderAddForm(handlers: DocumentHandlers): VNode {
  const onAdd = handlers.onAddRedaction;
  const cameras = handlers.cameraOptions ?? [];
  const kinds = handlers.redactionKinds ?? [];
  if (!onAdd && !handlers.addDisabledReason) return null;

  const disabled = !onAdd || cameras.length === 0;
  const reason = !onAdd
    ? (handlers.addDisabledReason ?? 'This build cannot write to the redaction table.')
    : cameras.length === 0
      ? 'This survey records no frames, so there is nothing to draw a box on.'
      : null;

  let cameraId = cameras[0]?.id ?? '';
  let kind = kinds[0] ?? '';
  let box = '';

  return h('form', { class: 'cp-addform cp-noprint' },
    h('h4', {}, 'Redact something the detectors missed'),
    h('p', { class: 'cp-item-guidance' },
      'This records the instruction. It does not change a pixel: removal happens in the '
      + 'redact stage on the next build, and an endpoint that claimed otherwise would be '
      + 'claiming a face had been blurred while the frame still shows it.'),
    h('div', { class: 'cp-field' },
      h('label', { class: 'cp-field-label', for: 'cp-add-camera' }, 'Frame'),
      hx('select', { id: 'cp-add-camera', class: 'cp-select', disabled: disabled || null },
        { change: (e: Event) => { cameraId = (e.target as HTMLSelectElement).value; } },
        ...cameras.map((c) => h('option', { value: c.id }, c.label)))),
    h('div', { class: 'cp-field' },
      h('label', { class: 'cp-field-label', for: 'cp-add-kind' }, 'What is in the box'),
      hx('select', { id: 'cp-add-kind', class: 'cp-select', disabled: disabled || null },
        { change: (e: Event) => { kind = (e.target as HTMLSelectElement).value; } },
        ...kinds.map((k) => h('option', { value: k }, k)))),
    h('div', { class: 'cp-field' },
      h('label', { class: 'cp-field-label', for: 'cp-add-bbox' },
        'Box in image pixels: x, y, width, height'),
      hx('input', {
        id: 'cp-add-bbox', class: 'cp-input', type: 'text',
        placeholder: 'e.g. 820, 410, 96, 130', disabled: disabled || null,
      }, { input: (e: Event) => { box = (e.target as HTMLInputElement).value; } })),
    reason ? h('p', { class: 'cp-status-reason', id: 'cp-add-why' }, reason) : null,
    hx('button', {
      class: 'cp-btn', type: 'submit', disabled: disabled || null,
      'aria-disabled': disabled ? 'true' : null,
      'aria-describedby': reason ? 'cp-add-why' : null,
    }, {
      click: (event: Event) => {
        event.preventDefault();
        if (!onAdd) return;
        const parts = box.split(/[\s,]+/).filter((p) => p.length > 0).map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return;
        onAdd({
          cameraId,
          kind,
          bbox: [parts[0]!, parts[1]!, parts[2]!, parts[3]!],
        });
      },
    }, 'Record this redaction'));
}

// ---------------------------------------------------------------------------
// Footer and export
// ---------------------------------------------------------------------------

/**
 * The footer is part of the document, not chrome.
 *
 * A printed page that has been separated from its first page must still say
 * which survey it describes, so the identifiers repeat here. Real running
 * footers need `@page` margin boxes, which no browser implements for arbitrary
 * content; repeating them once at the end is the honest version of that.
 */
function renderFooter(doc: ComplianceDocument): VElement {
  return h('footer', { class: 'cp-section' },
    h('h2', { id: `cp-${doc.kind}-provenance` }, 'This document'),
    h('dl', { class: 'cp-facts' },
      h('dt', {}, 'Document'), h('dd', {}, doc.title),
      h('dt', {}, 'Property'), h('dd', {}, doc.reference.propertyLabel),
      h('dt', {}, 'Property identifier'), h('dd', {}, doc.reference.propertyId),
      h('dt', {}, 'Survey identifier'), h('dd', {}, doc.reference.worldId),
      h('dt', {}, 'Survey version'), h('dd', {}, String(doc.reference.worldVersion)),
      h('dt', {}, 'Issued'), h('dd', {}, humanDateTime(doc.issuedAt))));
}

/**
 * The document as a standalone file.
 *
 * An agency asked to produce a certificate three years from now should be able
 * to open it without this application existing. So the export is one HTML file
 * with the stylesheet inlined, no scripts, no fonts to fetch and no network
 * calls -- it opens from a disk, from an email attachment, and from a case
 * management system that strips everything it does not understand.
 */
export function renderStandaloneHtml(
  doc: ComplianceDocument, handlers: DocumentHandlers = {},
): string {
  const body = toHtml(renderDocument(doc, handlers));
  const title = `${doc.title} — ${doc.subtitle}`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeForHead(title)}</title>
<style>${COMPLIANCE_CSS}</style>
</head>
<body class="cp-root" style="margin:0;padding:24px">
${body}
</body>
</html>
`;
}

function escapeForHead(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
