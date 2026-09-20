/**
 * One stylesheet for the operator console, injected once.
 *
 * The brief was "restrained, professional, functional", which in practice
 * meant deciding what NOT to do: no gradients, no glows, no cards stacked on
 * cards, no colour that carries meaning on its own, no motion that is not a
 * state change. It is the same palette as `@m3xi/viewer` — paper, ink, one
 * muted brass accent — so the console and the thing it operates look like one
 * product rather than two.
 *
 * Density is not uniform. A portfolio of 400 listings is a table with 32px
 * rows and tabular figures, because an operator scans it. A quality report is
 * airy, because an operator reads it and then makes a decision that is hard to
 * reverse.
 *
 * Accessibility, WCAG 2.2 AA, built in rather than bolted on:
 *   - every foreground/background pair below is at least 4.5:1 for text and
 *     3:1 for controls and boundaries, in both themes;
 *   - focus is always visible, never clipped, and uses a ring that contrasts
 *     against whatever it lands on, including the filled button;
 *   - the target size minimum (24x24 CSS px, 2.5.8) is met by every control,
 *     including the dense table's row actions;
 *   - nothing conveys state by colour alone: every status carries a word;
 *   - `prefers-reduced-motion` removes transitions rather than shortening them.
 *
 * There is deliberately no accessibility overlay widget. Research on the
 * installed base is clear that they do not work — 2.4% of disabled users find
 * them effective — and they routinely fight the assistive technology the user
 * has already configured. The fix is the markup below being right.
 */
export const CONSOLE_CSS = `
:root {
  --paper: #f3f1ee;
  --paper-sunk: #eae7e2;
  --surface: #fbfaf8;
  --surface-raised: #ffffff;
  --ink: #16181a;
  --ink-dim: #55595e;
  /* Measured: 4.9:1 on --paper-sunk, 5.4:1 on --paper, 5.9:1 on --surface.
     The lighter grey this replaced was 3.5:1 on disabled controls, which is
     technically exempt under 1.4.3 and still unreadable. */
  --ink-faint: #5f6368;
  --line: rgba(20, 22, 24, 0.16);
  --line-strong: rgba(20, 22, 24, 0.34);
  --accent: #7a5c32;
  --accent-soft: rgba(122, 92, 50, 0.10);
  --on-accent: #fbfaf8;
  --focus: #16181a;

  --ok-ink: #1c5638;
  --ok-bg: #e4eee8;
  --warn-ink: #6b4a05;
  --warn-bg: #f6eeda;
  --bad-ink: #8a2116;
  --bad-bg: #f7e7e5;
  --info-ink: #24435e;
  --info-bg: #e5ecf2;

  --radius: 3px;
  --gutter: 16px;
  --motion: 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0f1113;
    --paper-sunk: #0b0d0e;
    --surface: #16191c;
    --surface-raised: #1c2024;
    --ink: #eceae6;
    --ink-dim: #a4a9ae;
    --ink-faint: #878d93;
    --line: rgba(255, 255, 255, 0.16);
    --line-strong: rgba(255, 255, 255, 0.36);
    --accent: #c9a468;
    --accent-soft: rgba(201, 164, 104, 0.14);
    --on-accent: #0f1113;
    --focus: #eceae6;
    --ok-ink: #8fcfa9;
    --ok-bg: rgba(143, 207, 169, 0.12);
    --warn-ink: #dcb768;
    --warn-bg: rgba(220, 183, 104, 0.12);
    --bad-ink: #f0958d;
    --bad-bg: rgba(240, 149, 141, 0.12);
    --info-ink: #9dc0dc;
    --info-bg: rgba(157, 192, 220, 0.12);
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --paper: #0f1113;
  --paper-sunk: #0b0d0e;
  --surface: #16191c;
  --surface-raised: #1c2024;
  --ink: #eceae6;
  --ink-dim: #a4a9ae;
  --ink-faint: #878d93;
  --line: rgba(255, 255, 255, 0.16);
  --line-strong: rgba(255, 255, 255, 0.36);
  --accent: #c9a468;
  --accent-soft: rgba(201, 164, 104, 0.14);
  --on-accent: #0f1113;
  --focus: #eceae6;
  --ok-ink: #8fcfa9;
  --ok-bg: rgba(143, 207, 169, 0.12);
  --warn-ink: #dcb768;
  --warn-bg: rgba(220, 183, 104, 0.12);
  --bad-ink: #f0958d;
  --bad-bg: rgba(240, 149, 141, 0.12);
  --info-ink: #9dc0dc;
  --info-bg: rgba(157, 192, 220, 0.12);
  color-scheme: dark;
}

*, *::before, *::after { box-sizing: border-box; }

html, body { height: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: 2px;
}
:focus:not(:focus-visible) { outline: none; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

.c-sr {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* The skip link is real, focusable and visible when focused. */
.c-skip {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--surface-raised); color: var(--ink);
  border: 1px solid var(--line-strong); border-radius: var(--radius);
  padding: 10px 14px; font-weight: 600;
}
.c-skip:focus { left: 8px; top: 8px; }

/* ---------------------------------------------------------------- shell -- */

.c-app { display: grid; grid-template-columns: 224px 1fr; min-height: 100vh; }
.c-side {
  border-right: 1px solid var(--line);
  background: var(--surface);
  display: flex; flex-direction: column; gap: 4px;
  padding: 16px 12px; position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.c-brand { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px 14px; }
.c-brand b { font-size: 15px; letter-spacing: 0.02em; }
.c-brand span { font-size: 11px; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.08em; }

.c-nav { display: flex; flex-direction: column; gap: 2px; }
.c-nav a {
  display: block; padding: 7px 10px; border-radius: var(--radius);
  color: var(--ink-dim); text-decoration: none; font-size: 13px;
  min-height: 32px;
}
.c-nav a:hover { background: var(--accent-soft); color: var(--ink); }
.c-nav a[aria-current="page"] {
  background: var(--accent-soft); color: var(--ink); font-weight: 600;
  box-shadow: inset 2px 0 0 var(--accent);
}

.c-side-foot { margin-top: auto; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-dim); }
.c-side-foot dl { margin: 0 0 10px; display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; }
.c-side-foot dt { color: var(--ink-faint); }
.c-side-foot dd { margin: 0; }

.c-main { min-width: 0; display: flex; flex-direction: column; }
.c-head {
  border-bottom: 1px solid var(--line); padding: 18px 24px 14px;
  display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap;
  background: var(--paper); position: sticky; top: 0; z-index: 5;
}
.c-head h1 { margin: 0; font-size: 19px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; }
.c-head p { margin: 3px 0 0; color: var(--ink-dim); font-size: 13px; max-width: 72ch; }
.c-head-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.c-body { padding: 20px 24px 64px; }
.c-section { margin: 0 0 28px; }
.c-section > h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.c-section > p.c-lede { margin: 0 0 12px; color: var(--ink-dim); max-width: 78ch; }

.c-crumbs { font-size: 12px; color: var(--ink-dim); margin: 0 0 6px; }
.c-crumbs a { color: var(--ink-dim); }
.c-crumbs a:hover { color: var(--ink); }

/* -------------------------------------------------------------- controls -- */

.c-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 32px; min-width: 32px; padding: 5px 12px;
  font: inherit; font-size: 13px; font-weight: 500;
  color: var(--ink); background: var(--surface-raised);
  border: 1px solid var(--line-strong); border-radius: var(--radius);
  cursor: pointer; transition: background var(--motion), border-color var(--motion);
  text-decoration: none; white-space: nowrap;
}
.c-btn:hover:not(:disabled) { background: var(--accent-soft); }
.c-btn:disabled, .c-btn[aria-disabled="true"] {
  cursor: not-allowed; color: var(--ink-faint);
  background: var(--paper-sunk); border-color: var(--line);
}
.c-btn--primary {
  background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600;
}
.c-btn--primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent); }
.c-btn--primary:focus-visible { outline-color: var(--on-accent); outline-offset: -4px; }
.c-btn--danger { color: var(--bad-ink); border-color: var(--line-strong); }
.c-btn--danger:hover:not(:disabled) { background: var(--bad-bg); }
.c-btn--quiet { border-color: transparent; background: transparent; }
.c-btn--quiet:hover:not(:disabled) { background: var(--accent-soft); }
.c-btn--small { min-height: 26px; padding: 2px 8px; font-size: 12px; }

.c-field { display: flex; flex-direction: column; gap: 4px; margin: 0 0 14px; }
.c-field > label { font-size: 12px; font-weight: 600; color: var(--ink); }
.c-field .c-hint { font-size: 12px; color: var(--ink-dim); }
.c-field .c-error { font-size: 12px; color: var(--bad-ink); font-weight: 600; }
.c-input, .c-select, .c-textarea {
  font: inherit; font-size: 13px; color: var(--ink);
  background: var(--surface-raised); border: 1px solid var(--line-strong);
  border-radius: var(--radius); padding: 6px 9px; min-height: 32px; width: 100%;
}
.c-textarea { min-height: 80px; resize: vertical; font-family: var(--mono); font-size: 12px; }
.c-input:disabled, .c-select:disabled { background: var(--paper-sunk); color: var(--ink-faint); }
.c-input[aria-invalid="true"] { border-color: var(--bad-ink); }
.c-inline { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.c-inline .c-field { margin: 0; }

.c-check { display: inline-flex; gap: 7px; align-items: center; font-size: 13px; min-height: 32px; }
.c-check input { width: 16px; height: 16px; accent-color: var(--accent); }

/* ---------------------------------------------------------------- table -- */

.c-tablewrap { border: 1px solid var(--line); border-radius: var(--radius); overflow-x: auto; background: var(--surface); }
table.c-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.c-table caption { text-align: left; padding: 10px 12px; color: var(--ink-dim); font-size: 12px; border-bottom: 1px solid var(--line); }
.c-table th, .c-table td { text-align: left; padding: 5px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
/* WCAG 2.2 target size (2.5.8): a link in a table cell is a standalone target,
   so it gets a 24px box. The cell padding above is reduced by the same amount,
   which keeps the row at roughly the density it had. */
.c-table td a { display: inline-flex; align-items: center; min-height: 24px; min-width: 24px; }
/* A bare checkbox is 13px in most browsers. The label around it is the target,
   sized to 24px, and clicking a label activates its control. */
.c-checkcell {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; min-height: 24px; cursor: pointer;
}
.c-checkcell input { width: 16px; height: 16px; accent-color: var(--accent); }
.c-table thead th {
  position: sticky; top: 0; background: var(--surface); z-index: 1;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--ink-dim); font-weight: 600; border-bottom: 1px solid var(--line-strong); white-space: nowrap;
}
.c-table tbody tr:hover { background: var(--accent-soft); }
.c-table tbody tr:last-child td { border-bottom: 0; }
.c-table .c-num { text-align: right; font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
.c-table .c-mono { font-family: var(--mono); font-size: 12px; }
.c-sortbtn {
  background: none; border: 0; padding: 2px 4px; margin: -2px -4px; font: inherit;
  color: inherit; text-transform: inherit; letter-spacing: inherit; cursor: pointer;
  display: inline-flex; gap: 4px; align-items: center; min-height: 24px;
}
.c-sortbtn:hover { color: var(--ink); }
.c-sortbtn .c-arrow { font-size: 10px; opacity: 0.8; }

.c-pager { display: flex; gap: 10px; align-items: center; padding: 10px 2px 0; font-size: 12px; color: var(--ink-dim); flex-wrap: wrap; }
.c-pager .c-spacer { margin-left: auto; }

.c-empty { padding: 28px 16px; text-align: center; color: var(--ink-dim); }
.c-empty b { display: block; color: var(--ink); margin-bottom: 4px; font-size: 14px; }

/* --------------------------------------------------------------- status -- */

.c-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.02em; white-space: nowrap; border: 1px solid transparent;
}
.c-pill--ok { color: var(--ok-ink); background: var(--ok-bg); border-color: var(--ok-ink); }
.c-pill--warn { color: var(--warn-ink); background: var(--warn-bg); border-color: var(--warn-ink); }
.c-pill--bad { color: var(--bad-ink); background: var(--bad-bg); border-color: var(--bad-ink); }
.c-pill--info { color: var(--info-ink); background: var(--info-bg); border-color: var(--info-ink); }
.c-pill--muted { color: var(--ink-dim); background: var(--paper-sunk); border-color: var(--line-strong); }
/* A shape as well as a colour, so the state survives a monochrome screen. */
.c-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.c-pill--muted::before { border-radius: 1px; }
.c-pill--warn::before { border-radius: 1px; transform: rotate(45deg); }

.c-note {
  border: 1px solid var(--line-strong); border-left-width: 3px; border-radius: var(--radius);
  padding: 10px 14px; margin: 0 0 14px; font-size: 13px; background: var(--surface);
}
.c-note h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.c-note p { margin: 0; color: var(--ink-dim); }
.c-note p + p { margin-top: 6px; }
.c-note--ok { border-left-color: var(--ok-ink); }
.c-note--warn { border-left-color: var(--warn-ink); }
.c-note--bad { border-left-color: var(--bad-ink); }
.c-note--info { border-left-color: var(--info-ink); }

/* ---------------------------------------------------------------- meter -- */

.c-meter { margin: 0 0 16px; max-width: 46rem; }
.c-meter-head { display: flex; gap: 12px; align-items: baseline; font-size: 13px; }
.c-meter-head b { font-weight: 600; }
.c-meter-head .c-meter-val { margin-left: auto; font-variant-numeric: tabular-nums; }
.c-meter-track {
  height: 8px; background: var(--paper-sunk); border: 1px solid var(--line);
  border-radius: 2px; overflow: hidden; margin: 6px 0 4px; position: relative;
}
.c-meter-fill { height: 100%; background: var(--accent); }
.c-meter--approaching .c-meter-fill { background: var(--warn-ink); }
.c-meter--at_cap .c-meter-fill, .c-meter--over_cap .c-meter-fill { background: var(--bad-ink); }
/* The ceiling is drawn, not implied: a full bar and an over-full bar must not
   look the same. */
.c-meter--over_cap .c-meter-track::after {
  content: ""; position: absolute; inset: 0; right: 0; width: 3px; left: auto; background: var(--ink);
}
.c-meter-foot { font-size: 12px; color: var(--ink-dim); }

/* ----------------------------------------------------------------- dag --- */

.c-dag { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.c-stage {
  display: grid; grid-template-columns: 28px 1fr auto auto auto;
  gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line);
}
.c-stage:last-child { border-bottom: 0; }
.c-stage-n { font-variant-numeric: tabular-nums; color: var(--ink-faint); font-size: 12px; text-align: right; }
.c-stage-name { font-weight: 600; font-size: 13px; }
.c-stage-desc { color: var(--ink-dim); font-size: 12px; margin-top: 1px; }
.c-stage-num { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--ink-dim); min-width: 5ch; text-align: right; }
.c-stage--failed { background: var(--bad-bg); }
.c-stage--blocked { opacity: 0.72; }
.c-stage--running { background: var(--accent-soft); }
.c-stage-error {
  grid-column: 2 / -1; font-family: var(--mono); font-size: 12px; color: var(--bad-ink);
  background: var(--surface-raised); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 7px 9px; margin-top: 6px; white-space: pre-wrap; word-break: break-word;
}

/* ---------------------------------------------------------------- cards -- */

.c-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.c-card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 14px 16px; }
.c-card h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.c-stat { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; line-height: 1.15; }
.c-stat-sub { font-size: 12px; color: var(--ink-dim); margin-top: 3px; }

dl.c-facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 18px; margin: 0; font-size: 13px; }
dl.c-facts dt { color: var(--ink-dim); }
dl.c-facts dd { margin: 0; font-variant-numeric: tabular-nums; }

/* --------------------------------------------------------------- dialog -- */

.c-dialogback {
  position: fixed; inset: 0; background: rgba(10, 12, 14, 0.5);
  display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 50;
}
.c-dialog {
  background: var(--surface-raised); color: var(--ink);
  border: 1px solid var(--line-strong); border-radius: var(--radius);
  max-width: 540px; width: 100%; max-height: 86vh; overflow: auto; padding: 20px 22px;
}
.c-dialog h2 { margin: 0 0 8px; font-size: 16px; }
.c-dialog p { margin: 0 0 10px; color: var(--ink-dim); }
.c-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

/* ----------------------------------------------------------------- misc -- */

.c-toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 60; max-width: 380px; }
.c-toast {
  background: var(--surface-raised); border: 1px solid var(--line-strong);
  border-left-width: 3px; border-radius: var(--radius); padding: 10px 13px; font-size: 13px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.c-toast--ok { border-left-color: var(--ok-ink); }
.c-toast--bad { border-left-color: var(--bad-ink); }
.c-toast--info { border-left-color: var(--info-ink); }

.c-code {
  font-family: var(--mono); font-size: 12px; background: var(--paper-sunk);
  border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px;
  white-space: pre-wrap; word-break: break-all; margin: 0;
}
.c-copyrow { display: flex; gap: 8px; align-items: flex-start; }
.c-copyrow .c-code { flex: 1; }

.c-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin: 0 0 16px; }
.c-tab {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 8px 12px; font: inherit; font-size: 13px; color: var(--ink-dim); cursor: pointer; min-height: 36px;
}
.c-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.c-tab:hover { color: var(--ink); }

.c-bar { display: flex; align-items: center; gap: 8px; }
.c-bar-track { flex: 1; height: 8px; background: var(--paper-sunk); border-radius: 2px; overflow: hidden; border: 1px solid var(--line); min-width: 60px; }
.c-bar-fill { height: 100%; background: var(--accent); }
.c-bar-val { font-variant-numeric: tabular-nums; font-size: 12px; min-width: 4ch; text-align: right; }

.c-viewerhost { height: min(68vh, 720px); min-height: 380px; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--paper-sunk); }
.c-seamhost { border: 1px solid var(--line); border-radius: var(--radius); padding: 0; background: var(--surface); }

.c-spark { display: block; width: 100%; height: 48px; }
.c-spark rect { fill: var(--accent); }

a { color: var(--accent); }
a:hover { color: var(--ink); }
hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
code { font-family: var(--mono); font-size: 0.92em; }

@media (max-width: 860px) {
  .c-app { grid-template-columns: 1fr; }
  .c-side { position: static; height: auto; flex-direction: column; }
  .c-nav { flex-direction: row; flex-wrap: wrap; }
  .c-head, .c-body { padding-left: 16px; padding-right: 16px; }
}
`;

let injected = false;

/** Injects the stylesheet once per document. Safe to call from every page. */
export function ensureStyles(doc: Document = document): void {
  if (injected && doc.getElementById('m3xi-console-css')) return;
  const style = doc.createElement('style');
  style.id = 'm3xi-console-css';
  style.textContent = CONSOLE_CSS;
  doc.head.appendChild(style);
  injected = true;
}
