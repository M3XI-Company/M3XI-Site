/**
 * One stylesheet for four documents, and a print stylesheet that is not an
 * afterthought.
 *
 * EVERY ONE OF THESE IS A DOCUMENT SOMEBODY IS ASKED TO PRODUCE. A measurement
 * certificate is produced in a dispute, a material-information checklist is
 * produced to a trading standards officer, a privacy audit is produced to a
 * DPO, and the written tour is produced to whoever asked for the property in a
 * form they can read. So the printed copy is the deliverable and the screen is
 * the draft, which inverts the usual priority:
 *
 *   -- a table never breaks between its header and its first row, and its
 *      header repeats on every page (`display: table-header-group`);
 *   -- a row never breaks across a page, so a figure is never split from its
 *      tolerance;
 *   -- a heading never sits alone at the foot of a page (`break-after: avoid`),
 *      because a section heading on one page and its content on the next reads
 *      as a section with nothing in it;
 *   -- Parts A, B and C start on their own pages, because a reader treats them
 *      as separate documents and will hand one of them to somebody;
 *   -- every control that is not part of the document is hidden in print. What
 *      prints is the document, not a screenshot of an application.
 *
 * NOTHING CARRIES MEANING BY COLOUR. These print in greyscale and get
 * photocopied and faxed by conveyancers. INDICATIVE is a word. UNANSWERED is a
 * word. A note's severity is a rule weight and a heading, never a hue. The
 * screen palette borrows the console's tokens where it is mounted inside one
 * -- `var(--ink, #16181a)` -- so it inherits the operator's theme rather than
 * fighting it, and stands alone with the same values when it is not.
 *
 * Accessibility, WCAG 2.2 AA, in the markup rather than on top of it:
 *   - every input has a real `<label>`, every table has a `<caption>` and
 *     scoped headers, every tab panel is a real tab panel with arrow keys;
 *   - focus is a 2px ring with an offset, never removed, never clipped;
 *   - the smallest control is 24x24 CSS px (2.5.8);
 *   - text is at least 4.5:1 against its background in both themes, and the
 *     one deliberately quiet colour, `--cp-ink-dim`, is the console's own
 *     measured 5.4:1 grey rather than a lighter one that would look better;
 *   - `prefers-reduced-motion` removes the only transition here.
 * There is no accessibility overlay widget and there will not be one.
 */
export const COMPLIANCE_CSS = `
.cp-root {
  --cp-ink: var(--ink, #16181a);
  --cp-ink-dim: var(--ink-dim, #55595e);
  --cp-paper: var(--surface, #fbfaf8);
  --cp-paper-sunk: var(--paper-sunk, #eae7e2);
  --cp-line: var(--line, rgba(20, 22, 24, 0.16));
  --cp-line-strong: var(--line-strong, rgba(20, 22, 24, 0.34));
  --cp-accent: var(--accent, #7a5c32);
  --cp-focus: var(--focus, #16181a);
  --cp-font: var(--font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif);
  --cp-serif: ui-serif, Georgia, "Times New Roman", serif;
  --cp-mono: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);

  color: var(--cp-ink);
  background: var(--cp-paper);
  font-family: var(--cp-font);
  font-size: 14px;
  line-height: 1.55;
}

.cp-root *, .cp-root *::before, .cp-root *::after { box-sizing: border-box; }

.cp-root :focus-visible {
  outline: 2px solid var(--cp-focus);
  outline-offset: 2px;
}

.cp-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* --- chrome: the part that does not print ------------------------------- */

.cp-toolbar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 0 0 10px;
  border-bottom: 1px solid var(--cp-line);
  margin-bottom: 14px;
}

.cp-tabs { display: flex; flex-wrap: wrap; gap: 2px; }

.cp-tab {
  appearance: none;
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--cp-ink-dim);
  font: inherit;
  cursor: pointer;
}
.cp-tab:hover { color: var(--cp-ink); }
.cp-tab[aria-selected="true"] {
  color: var(--cp-ink);
  border-bottom-color: var(--cp-accent);
  font-weight: 600;
}

.cp-btn {
  appearance: none;
  min-height: 32px; min-width: 32px;
  padding: 6px 12px;
  border: 1px solid var(--cp-line-strong);
  border-radius: 3px;
  background: var(--cp-paper);
  color: var(--cp-ink);
  font: inherit;
  cursor: pointer;
}
.cp-btn:hover:not([disabled]) { background: var(--cp-paper-sunk); }
.cp-btn[disabled] { cursor: not-allowed; color: var(--cp-ink-dim); }
.cp-btn--small { min-height: 24px; padding: 2px 8px; font-size: 13px; }

.cp-spacer { flex: 1 1 auto; }

.cp-status { font-size: 13px; color: var(--cp-ink-dim); }

/* --- the document ------------------------------------------------------- */

.cp-doc {
  max-width: 46rem;
  font-family: var(--cp-serif);
  font-size: 15px;
}

.cp-doc h1 {
  font-size: 22px; line-height: 1.25; margin: 0 0 2px;
  font-family: var(--cp-font); letter-spacing: -0.01em;
}
.cp-doc h2 {
  font-size: 17px; margin: 26px 0 8px;
  font-family: var(--cp-font);
  padding-bottom: 4px; border-bottom: 1px solid var(--cp-line);
}
.cp-doc h3 { font-size: 15px; margin: 18px 0 6px; font-family: var(--cp-font); }
.cp-doc p { margin: 0 0 10px; }
.cp-doc ul { margin: 0 0 12px; padding-left: 20px; }
.cp-doc li { margin: 0 0 5px; }

.cp-subtitle { font-family: var(--cp-font); color: var(--cp-ink-dim); margin: 0 0 10px; }

.cp-standing {
  margin: 0 0 18px; padding: 10px 12px;
  border: 1px solid var(--cp-line);
  background: var(--cp-paper-sunk);
  font-size: 13.5px;
}
.cp-standing p { margin: 0 0 8px; }
.cp-standing p:last-child { margin-bottom: 0; }

.cp-facts { margin: 0 0 14px; display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; }
.cp-facts dt { font-family: var(--cp-font); font-size: 13px; color: var(--cp-ink-dim); }
.cp-facts dd { margin: 0; }

.cp-table-wrap { margin: 0 0 16px; overflow-x: auto; }
.cp-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.cp-table caption {
  text-align: left; font-family: var(--cp-font); font-size: 13px;
  color: var(--cp-ink-dim); padding-bottom: 6px;
}
.cp-table th, .cp-table td {
  text-align: left; vertical-align: top;
  padding: 6px 10px 6px 0;
  border-bottom: 1px solid var(--cp-line);
}
.cp-table thead th {
  font-family: var(--cp-font); font-size: 12px; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--cp-ink-dim);
  border-bottom: 1px solid var(--cp-line-strong);
}
.cp-table .cp-num { font-variant-numeric: tabular-nums; }
.cp-table-note { font-size: 13px; color: var(--cp-ink-dim); margin: 6px 0 0; }

.cp-figure-value { font-variant-numeric: tabular-nums; white-space: nowrap; }
.cp-figure-tol { color: var(--cp-ink-dim); white-space: nowrap; }
.cp-figure-basis { font-size: 12.5px; color: var(--cp-ink-dim); margin: 2px 0 0; }

/* The status word is the signal. The rule beside it is decoration that
   survives greyscale; remove the word and the row stops being readable, which
   is the test. */
.cp-status-word {
  font-family: var(--cp-font); font-size: 11.5px; font-weight: 700;
  letter-spacing: 0.06em; white-space: nowrap;
}
.cp-status--indicative { border-left: 3px solid var(--cp-ink); padding-left: 6px; }
.cp-status--declared { border-left: 3px solid var(--cp-accent); padding-left: 6px; }
.cp-status--measured { padding-left: 9px; }
/* The white-space reset here is load-bearing. The status word above it is
   nowrap so that "INDICATIVE (DECLARED)" never breaks in half, and white-space
   inherits -- without this reset the whole reason sentence became one
   unbreakable line, which widened the entry to 811 CSS px against a 673 px A4
   text width and cut the right-hand side off every printed page. */
.cp-status-reason { display: block; font-weight: 400; letter-spacing: 0; font-size: 12.5px;
  white-space: normal; color: var(--cp-ink-dim); margin-top: 2px; max-width: 46ch; }

.cp-note {
  margin: 0 0 14px; padding: 9px 12px;
  border: 1px solid var(--cp-line);
  border-left-width: 4px;
  border-left-color: var(--cp-line-strong);
  background: var(--cp-paper);
}
.cp-note--warn { border-left-color: var(--cp-ink); }
.cp-note--bad { border-left-color: var(--cp-ink); border-left-width: 6px; }
.cp-note h4 { margin: 0 0 4px; font-family: var(--cp-font); font-size: 13.5px; }
.cp-note p { margin: 0; font-size: 13.5px; }

/* --- checklist ---------------------------------------------------------- */

.cp-items { list-style: none; margin: 0 0 16px; padding: 0; }
.cp-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--cp-line);
}
.cp-item-head { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; }
.cp-item-label { font-family: var(--cp-font); font-weight: 600; font-size: 14px; }
.cp-item-guidance { font-size: 13px; color: var(--cp-ink-dim); margin: 2px 0 8px; }
.cp-item-answer { margin: 0 0 6px; }
.cp-item-reason { font-size: 13px; color: var(--cp-ink-dim); margin: 0 0 8px; max-width: 46ch; }
.cp-item-evidence { font-size: 13px; margin: 6px 0 0; padding-left: 18px; }
.cp-item-evidence li { margin: 0 0 3px; color: var(--cp-ink-dim); }

.cp-field { display: block; margin: 6px 0 0; }
.cp-field-label { display: block; font-family: var(--cp-font); font-size: 12px;
  color: var(--cp-ink-dim); margin-bottom: 3px; }
.cp-input, .cp-select, .cp-textarea {
  width: 100%; max-width: 34rem; min-height: 32px;
  padding: 5px 8px;
  border: 1px solid var(--cp-line-strong);
  border-radius: 3px;
  background: var(--cp-paper);
  color: var(--cp-ink);
  font: inherit; font-family: var(--cp-font); font-size: 13.5px;
}
.cp-textarea { min-height: 60px; resize: vertical; }

/* --- detections --------------------------------------------------------- */

.cp-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.cp-empty { font-size: 13.5px; color: var(--cp-ink-dim); padding: 10px 0; }

.cp-addform {
  margin: 0 0 16px; padding: 12px;
  border: 1px solid var(--cp-line);
  display: grid; gap: 8px; max-width: 36rem;
}
.cp-addform h4 { margin: 0; font-family: var(--cp-font); font-size: 14px; }

@media (prefers-reduced-motion: reduce) {
  .cp-root *, .cp-root *::before, .cp-root *::after {
    transition: none !important; animation: none !important;
  }
}

/* --- print -------------------------------------------------------------- */

@media print {
  @page { size: A4; margin: 18mm 16mm 20mm; }

  .cp-root {
    background: #fff; color: #000;
    --cp-ink: #000; --cp-ink-dim: #333;
    --cp-line: #999; --cp-line-strong: #000; --cp-accent: #000;
    --cp-paper: #fff; --cp-paper-sunk: #fff;
    font-size: 10.5pt;
  }
  .cp-toolbar, .cp-tabs, .cp-actions, .cp-addform, .cp-noprint { display: none !important; }

  .cp-doc { max-width: none; font-size: 10.5pt; }
  .cp-doc h1 { font-size: 16pt; }
  .cp-doc h2 { font-size: 12pt; break-after: avoid-page; page-break-after: avoid; }
  .cp-doc h3 { font-size: 11pt; break-after: avoid-page; page-break-after: avoid; }

  .cp-section { break-inside: auto; }
  .cp-section--break { break-before: page; page-break-before: always; }
  .cp-standing { border: 1pt solid #000; background: #fff; }

  /* A table may span pages; a row may not, and the header repeats. */
  .cp-table-wrap { overflow: visible; }
  .cp-table { break-inside: auto; }
  .cp-table thead { display: table-header-group; }
  .cp-table tfoot { display: table-footer-group; }
  .cp-table tr { break-inside: avoid-page; page-break-inside: avoid; }
  .cp-table th, .cp-table td { border-bottom: 0.5pt solid #999; }

  .cp-note, .cp-item, .cp-facts, .cp-figure { break-inside: avoid-page; page-break-inside: avoid; }
  .cp-note { border: 0.5pt solid #000; border-left-width: 3pt; }

  /* An unanswered field prints as a ruled line to write on. A box with a
     border prints as a box somebody has to write inside, and half of them
     write over the edge. */
  .cp-input, .cp-select, .cp-textarea {
    border: 0; border-bottom: 0.5pt solid #000; border-radius: 0;
    background: #fff; min-height: 22pt; padding-left: 0;
  }
  .cp-textarea { min-height: 44pt; }

  .cp-status--indicative, .cp-status--declared { border-left: 2pt solid #000; }
}
`;

/** Injected once per document, keyed so a second mount does not duplicate it. */
const STYLE_ID = 'm3xi-compliance-styles';

export function installStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = COMPLIANCE_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
