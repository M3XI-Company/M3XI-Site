/**
 * One stylesheet for the correction editor, injected once.
 *
 * It borrows the operator console's custom-property NAMES rather than its
 * values: `var(--ink, #16181a)`. Mounted inside the console the editor
 * inherits that palette exactly, so the screen reads as one product; mounted
 * anywhere else the fallbacks are the same measured colours, so it is legible
 * on its own. Copying the values instead would give two palettes that drift.
 *
 * What is deliberately absent: gradients, shadows beyond a hairline, rounded
 * pills, colour that carries meaning on its own, and any motion that is not a
 * state change. An operator is deciding what an agency will publish about
 * somebody's home under a regime where an omission is automatically unfair.
 * The screen should look like an instrument.
 *
 * WCAG 2.2 AA is built in rather than bolted on:
 *   - every text pair below is at least 4.5:1, and every control boundary 3:1,
 *     in both themes; the plan's own strokes are boundaries and meet 3:1;
 *   - focus is a 2px ring plus a 2px offset, never clipped, and it contrasts
 *     against the paper, the sunk panel and the filled button alike;
 *   - every control clears the 24x24 CSS px target minimum (2.5.8), including
 *     the plan's selectable shapes, which carry an invisible hit area;
 *   - nothing is conveyed by colour alone: the plan carries hatching for
 *     unsurveyed volume and a text label for every status;
 *   - `prefers-reduced-motion` removes transitions rather than shortening them;
 *   - `forced-colors` keeps the plan readable by falling back to system
 *     colours instead of disappearing.
 *
 * There is no accessibility overlay widget here and there will not be. They
 * fight the assistive technology the operator has already configured. The fix
 * is the markup being right.
 */
export const REVIEW_CSS = `
.rv {
  --rv-ink: var(--ink, #16181a);
  --rv-dim: var(--ink-dim, #55595e);
  --rv-faint: var(--ink-faint, #5f6368);
  --rv-paper: var(--paper, #f3f1ee);
  --rv-sunk: var(--paper-sunk, #eae7e2);
  --rv-surface: var(--surface, #fbfaf8);
  --rv-line: var(--line, rgba(20, 22, 24, 0.16));
  --rv-line-strong: var(--line-strong, rgba(20, 22, 24, 0.34));
  --rv-accent: var(--accent, #7a5c32);
  --rv-accent-soft: var(--accent-soft, rgba(122, 92, 50, 0.10));
  --rv-on-accent: var(--on-accent, #fbfaf8);
  --rv-focus: var(--focus, #16181a);
  --rv-warn-ink: var(--warn-ink, #6b4a05);
  --rv-warn-bg: var(--warn-bg, #f6eeda);
  --rv-bad-ink: var(--bad-ink, #8a2116);
  --rv-bad-bg: var(--bad-bg, #f7e7e5);
  --rv-info-ink: var(--info-ink, #24435e);
  --rv-info-bg: var(--info-bg, #e5ecf2);
  --rv-ok-ink: var(--ok-ink, #1c5638);
  --rv-ok-bg: var(--ok-bg, #e4eee8);
  --rv-font: var(--font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif);
  --rv-mono: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --rv-radius: var(--radius, 3px);

  color: var(--rv-ink);
  font-family: var(--rv-font);
  font-size: 14px;
  line-height: 1.45;
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 1fr);
  gap: 16px;
  align-items: start;
}

@media (prefers-color-scheme: dark) {
  .rv:not([data-theme="light"]) {
    --rv-ink: var(--ink, #eceae6);
    --rv-dim: var(--ink-dim, #a4a9ae);
    --rv-faint: var(--ink-faint, #878d93);
    --rv-paper: var(--paper, #0f1113);
    --rv-sunk: var(--paper-sunk, #0b0d0e);
    --rv-surface: var(--surface, #16191c);
    --rv-line: var(--line, rgba(255, 255, 255, 0.16));
    --rv-line-strong: var(--line-strong, rgba(255, 255, 255, 0.36));
    --rv-accent: var(--accent, #c9a468);
    --rv-accent-soft: var(--accent-soft, rgba(201, 164, 104, 0.14));
    --rv-on-accent: var(--on-accent, #0f1113);
    --rv-focus: var(--focus, #eceae6);
    --rv-warn-ink: var(--warn-ink, #dcb768);
    --rv-warn-bg: var(--warn-bg, rgba(220, 183, 104, 0.12));
    --rv-bad-ink: var(--bad-ink, #f0958d);
    --rv-bad-bg: var(--bad-bg, rgba(240, 149, 141, 0.12));
    --rv-info-ink: var(--info-ink, #9dc0dc);
    --rv-info-bg: var(--info-bg, rgba(157, 192, 220, 0.12));
    --rv-ok-ink: var(--ok-ink, #8fcfa9);
    --rv-ok-bg: var(--ok-bg, rgba(143, 207, 169, 0.12));
  }
}

@media (max-width: 900px) {
  .rv { grid-template-columns: minmax(0, 1fr); }
}

.rv *, .rv *::before, .rv *::after { box-sizing: border-box; }

.rv-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.rv-panel {
  background: var(--rv-surface);
  border: 1px solid var(--rv-line);
  border-radius: var(--rv-radius);
  padding: 12px;
}

.rv-panel + .rv-panel { margin-top: 12px; }

.rv h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--rv-dim);
}

.rv h4 { margin: 12px 0 6px; font-size: 14px; font-weight: 600; }
.rv p { margin: 0 0 8px; }
.rv p:last-child { margin-bottom: 0; }

.rv-hint { color: var(--rv-dim); font-size: 12.5px; }
.rv-mono { font-family: var(--rv-mono); font-size: 12.5px; }

/* -- the plan ----------------------------------------------------------- */

.rv-plan-wrap {
  background: var(--rv-paper);
  border: 1px solid var(--rv-line);
  border-radius: var(--rv-radius);
  padding: 8px;
}

.rv-plan { display: block; width: 100%; height: auto; touch-action: manipulation; }

.rv-plan .rv-room-fill { fill: var(--rv-surface); stroke: var(--rv-line-strong); stroke-width: 0.04; }
.rv-plan .rv-room-label { fill: var(--rv-ink); font-size: 0.26px; font-family: var(--rv-font); }
.rv-plan .rv-room-sub { fill: var(--rv-dim); font-size: 0.2px; font-family: var(--rv-font); }
.rv-plan .rv-entity { fill: none; stroke: var(--rv-dim); stroke-width: 0.03; }
.rv-plan .rv-opening { stroke: var(--rv-accent); stroke-width: 0.1; stroke-linecap: butt; }
.rv-plan .rv-opening--window { stroke-dasharray: 0.12 0.08; }
.rv-plan .rv-hit { fill: transparent; stroke: transparent; stroke-width: 0.3; }

/* Selection is a heavier outline AND a label change, never colour alone. */
.rv-plan [aria-selected="true"] .rv-room-fill,
.rv-plan [aria-selected="true"] .rv-entity { stroke: var(--rv-ink); stroke-width: 0.08; }
.rv-plan [aria-selected="true"] .rv-room-fill { fill: var(--rv-accent-soft); }
.rv-plan [aria-selected="true"] .rv-opening { stroke-width: 0.16; }

.rv-plan [role="option"] { cursor: pointer; }
.rv-plan [role="option"]:focus { outline: none; }
.rv-plan [role="option"]:focus-visible .rv-focus-ring,
.rv-plan [role="option"]:focus .rv-focus-ring {
  stroke: var(--rv-focus); stroke-width: 0.06; fill: none; stroke-dasharray: 0.1 0.06;
}
.rv-plan .rv-focus-ring { stroke: none; fill: none; }

/* Unsurveyed volume is hatched, so it survives greyscale, colour blindness and
   a black-and-white print. The fill is set inline by planView.ts, because the
   pattern id is unique per mount and a stylesheet cannot know it. */
.rv-plan .rv-region { stroke: var(--rv-line-strong); stroke-width: 0.03; color: var(--rv-line-strong); }

/* -- controls ----------------------------------------------------------- */

.rv-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.rv-field label { font-size: 12.5px; font-weight: 600; color: var(--rv-dim); }

.rv-input, .rv-select, .rv-textarea {
  font: inherit;
  color: var(--rv-ink);
  background: var(--rv-surface);
  border: 1px solid var(--rv-line-strong);
  border-radius: var(--rv-radius);
  padding: 6px 8px;
  min-height: 32px;
  width: 100%;
}

.rv-textarea { min-height: 60px; resize: vertical; }

.rv-input:focus-visible, .rv-select:focus-visible, .rv-textarea:focus-visible,
.rv-btn:focus-visible, .rv-plan [role="option"]:focus-visible {
  outline: 2px solid var(--rv-focus);
  outline-offset: 2px;
}

.rv-btn {
  font: inherit;
  font-weight: 600;
  min-height: 32px;
  min-width: 32px;
  padding: 6px 12px;
  border-radius: var(--rv-radius);
  border: 1px solid var(--rv-line-strong);
  background: var(--rv-surface);
  color: var(--rv-ink);
  cursor: pointer;
}

.rv-btn--primary { background: var(--rv-accent); border-color: var(--rv-accent); color: var(--rv-on-accent); }
.rv-btn--quiet { border-color: transparent; background: transparent; text-decoration: underline; }
.rv-btn[disabled] { cursor: not-allowed; opacity: 1; color: var(--rv-faint); border-color: var(--rv-line); }
.rv-btn--primary[disabled] { background: var(--rv-sunk); color: var(--rv-faint); border-color: var(--rv-line); }

.rv-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.rv-row > .rv-field { flex: 1 1 140px; margin-bottom: 0; }

.rv-radios { display: flex; flex-direction: column; gap: 6px; }
.rv-radio { display: flex; gap: 8px; align-items: flex-start; min-height: 24px; }
.rv-radio input { margin-top: 3px; width: 16px; height: 16px; }
.rv-radio span { font-weight: 400; }

/* -- notes and issues ---------------------------------------------------- */

.rv-note {
  border: 1px solid var(--rv-line-strong);
  border-left-width: 4px;
  border-radius: var(--rv-radius);
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--rv-sunk);
}

.rv-note--warn { background: var(--rv-warn-bg); border-left-color: var(--rv-warn-ink); color: var(--rv-warn-ink); }
.rv-note--bad { background: var(--rv-bad-bg); border-left-color: var(--rv-bad-ink); color: var(--rv-bad-ink); }
.rv-note--info { background: var(--rv-info-bg); border-left-color: var(--rv-info-ink); color: var(--rv-info-ink); }
.rv-note--ok { background: var(--rv-ok-bg); border-left-color: var(--rv-ok-ink); color: var(--rv-ok-ink); }
.rv-note strong { display: block; margin-bottom: 2px; }

.rv-list { list-style: none; margin: 0; padding: 0; }
.rv-list li {
  border-top: 1px solid var(--rv-line);
  padding: 8px 0;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
}
.rv-list li:first-child { border-top: none; }
.rv-list .rv-who { color: var(--rv-dim); font-size: 12.5px; }

.rv-issue { display: block; padding: 6px 0; border-top: 1px solid var(--rv-line); }
.rv-issue:first-child { border-top: none; }
.rv-issue .rv-level {
  font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  margin-right: 6px;
}
.rv-issue--blocker .rv-level { color: var(--rv-bad-ink); }
.rv-issue--warning .rv-level { color: var(--rv-warn-ink); }

.rv-prov { border-collapse: collapse; width: 100%; font-size: 13px; }
.rv-prov th, .rv-prov td { text-align: left; padding: 4px 8px 4px 0; vertical-align: top; }
.rv-prov th { color: var(--rv-dim); font-weight: 600; width: 40%; }

.rv-figure { font-variant-numeric: tabular-nums; }
.rv-indicative { font-weight: 600; }

@media (prefers-reduced-motion: reduce) {
  .rv * { transition: none !important; animation: none !important; }
}

@media (forced-colors: active) {
  .rv-plan .rv-room-fill { fill: Canvas; stroke: CanvasText; }
  .rv-plan [aria-selected="true"] .rv-room-fill { fill: Highlight; }
  .rv-btn { border-color: ButtonText; }
}
`;

/**
 * Inject the stylesheet once per document.
 *
 * Guarded because this package is imported in Node, where there is no
 * document, and because a host page may have locked the head down. A missing
 * stylesheet degrades to unstyled but fully operable markup, which is a worse
 * screen and not a broken one, so it is not worth throwing over.
 */
export function ensureReviewStyles(doc?: Document): void {
  try {
    const target = doc ?? (globalThis as { document?: Document }).document;
    if (!target?.head) return;
    if (target.getElementById?.('m3xi-review-css')) return;
    const style = target.createElement('style');
    style.id = 'm3xi-review-css';
    style.textContent = REVIEW_CSS;
    target.head.appendChild(style);
  } catch {
    // Unstyled and usable beats mounted and thrown.
  }
}
