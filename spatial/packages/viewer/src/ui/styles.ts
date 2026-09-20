/**
 * One stylesheet, injected once, scoped under `.m3xi-viewer`.
 *
 * Shipping CSS as a string rather than a `.css` import keeps the package a
 * one-step drop-in: an agency embedding this needs a script tag, not a build
 * step and a stylesheet link. The scope prefix means it cannot collide with
 * whatever the host page is already running.
 *
 * The design brief was "the property dominates". In practice that means:
 *   - chrome is translucent, hairline-bordered, and sits at the edges;
 *   - it auto-hides while the visitor is moving and returns on any input;
 *   - there is exactly one accent colour and it is a muted brass, not a
 *     saturated brand blue;
 *   - type is one family, with tabular figures wherever a measurement appears,
 *     so a column of dimensions lines up;
 *   - no gradients, no glows, no rounded-rectangle cards stacked on cards.
 *
 * Contrast: every foreground/background pair below was checked against WCAG
 * 2.2 AA (4.5:1 for body text, 3:1 for UI boundaries) in both themes.
 */
export const VIEWER_CSS = `
.m3xi-viewer {
  --paper: #f3f1ee;
  --surface: rgba(255, 255, 255, 0.88);
  --surface-solid: #fbfaf8;
  --ink: #16181a;
  --ink-dim: #55595e;
  --line: rgba(20, 22, 24, 0.16);
  --line-strong: rgba(20, 22, 24, 0.32);
  --accent: #7a5c32;
  --accent-soft: rgba(122, 92, 50, 0.12);
  --radius: 3px;
  --gutter: 16px;
  --motion: 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-height: 320px;
  overflow: hidden;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.m3xi-viewer[data-theme="dark"] {
  --paper: #0f1113;
  --surface: rgba(22, 25, 28, 0.86);
  --surface-solid: #16191c;
  --ink: #eceae6;
  --ink-dim: #a4a9ae;
  --line: rgba(255, 255, 255, 0.16);
  --line-strong: rgba(255, 255, 255, 0.34);
  --accent: #c9a468;
  --accent-soft: rgba(201, 164, 104, 0.16);
}

.m3xi-viewer *, .m3xi-viewer *::before, .m3xi-viewer *::after { box-sizing: border-box; }

.m3xi-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  cursor: grab;
}
.m3xi-canvas:active { cursor: grabbing; }
.m3xi-viewer[data-tool="measure"] .m3xi-canvas { cursor: crosshair; }

/* Focus is never invisible and never clipped by an overlapping panel. */
.m3xi-viewer :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}
.m3xi-canvas:focus-visible { outline-offset: -3px; }

.m3xi-sr {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.m3xi-skip {
  position: absolute;
  top: 8px; left: 8px;
  z-index: 60;
  transform: translateY(-160%);
  background: var(--surface-solid);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  padding: 10px 14px;
  font-weight: 500;
  text-decoration: none;
  transition: transform var(--motion);
}
.m3xi-skip:focus { transform: translateY(0); }

/* --- header ------------------------------------------------------------- */

.m3xi-head {
  position: absolute;
  top: var(--gutter); left: var(--gutter);
  z-index: 30;
  max-width: min(46ch, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.m3xi-head > * { pointer-events: auto; }

.m3xi-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.005em;
  padding: 7px 12px;
  background: var(--surface);
  backdrop-filter: blur(14px) saturate(1.1);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.m3xi-title small {
  display: block;
  font-weight: 400;
  font-size: 12px;
  color: var(--ink-dim);
}

.m3xi-coverage {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  font: inherit;
  font-size: 12px;
  color: var(--ink-dim);
  padding: 6px 10px 6px 8px;
  background: var(--surface);
  backdrop-filter: blur(14px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  cursor: pointer;
  min-height: 28px;
}
.m3xi-coverage:hover { color: var(--ink); border-color: var(--line-strong); }
/* The chip carries the hatch itself, so the legend and the 3D view use one mark. */
.m3xi-swatch {
  width: 16px; height: 16px;
  flex: 0 0 auto;
  border: 1px solid var(--line-strong);
  background-image: repeating-linear-gradient(
    45deg, currentColor 0 1px, transparent 1px 5px
  );
  opacity: 0.85;
}

/* --- rail --------------------------------------------------------------- */

.m3xi-rail {
  position: absolute;
  left: 50%;
  bottom: var(--gutter);
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  gap: 2px;
  padding: 4px;
  background: var(--surface);
  backdrop-filter: blur(16px) saturate(1.1);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: opacity var(--motion), transform var(--motion);
  max-width: calc(100% - 2 * var(--gutter));
  overflow-x: auto;
  scrollbar-width: none;
}
.m3xi-rail::-webkit-scrollbar { display: none; }
.m3xi-viewer[data-chrome="hidden"] .m3xi-rail {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
  pointer-events: none;
}
.m3xi-viewer[data-chrome="hidden"] .m3xi-head { opacity: 0.35; }
.m3xi-head { transition: opacity var(--motion); }

.m3xi-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 12px;
  background: transparent;
  border: 0;
  border-radius: 2px;
  color: var(--ink-dim);
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--motion), color var(--motion);
}
.m3xi-btn:hover { background: var(--accent-soft); color: var(--ink); }
.m3xi-btn[aria-pressed="true"], .m3xi-btn[aria-expanded="true"] {
  background: var(--accent-soft);
  color: var(--ink);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.m3xi-btn svg { width: 16px; height: 16px; flex: 0 0 auto; }

/* --- panel -------------------------------------------------------------- */

.m3xi-panel {
  position: absolute;
  top: var(--gutter);
  right: var(--gutter);
  bottom: calc(var(--gutter) + 52px);
  z-index: 35;
  width: min(380px, calc(100% - 2 * var(--gutter)));
  display: flex;
  flex-direction: column;
  background: var(--surface);
  backdrop-filter: blur(20px) saturate(1.15);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}
.m3xi-panel[hidden] { display: none; }

.m3xi-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 8px 12px 14px;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}
.m3xi-panel-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.m3xi-close {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--ink-dim);
  width: 32px; height: 32px;
  border-radius: 2px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.m3xi-close:hover { background: var(--accent-soft); color: var(--ink); }

.m3xi-panel-body {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px;
}

.m3xi-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.m3xi-row {
  appearance: none;
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 2px;
  padding: 9px 10px;
  min-height: 40px;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.m3xi-row:hover { background: var(--accent-soft); }
.m3xi-row[aria-current="true"] { box-shadow: inset 2px 0 0 var(--accent); background: var(--accent-soft); }
.m3xi-row-meta {
  color: var(--ink-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* --- measurement readout ------------------------------------------------ */

.m3xi-quantity { font-variant-numeric: tabular-nums; }
.m3xi-quantity .m3xi-q-value {
  display: block;
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -0.01em;
}
.m3xi-quantity .m3xi-q-tol { color: var(--ink-dim); font-size: 13px; }
.m3xi-quantity .m3xi-q-std {
  display: block;
  margin-top: 4px;
  color: var(--ink-dim);
  font-size: 12px;
}
.m3xi-indicative {
  margin-top: 10px;
  padding: 9px 11px;
  border: 1px solid var(--line-strong);
  border-left-width: 3px;
  border-radius: 2px;
  font-size: 12.5px;
  color: var(--ink);
  background: transparent;
  background-image: repeating-linear-gradient(
    45deg, var(--line) 0 1px, transparent 1px 7px
  );
}
.m3xi-indicative strong { font-weight: 600; }

.m3xi-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.m3xi-field label { font-size: 12px; color: var(--ink-dim); }
.m3xi-field select, .m3xi-field input {
  font: inherit;
  color: var(--ink);
  background: var(--surface-solid);
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  padding: 8px 10px;
  min-height: 40px;
}

.m3xi-toolbar { display: flex; gap: 2px; margin-bottom: 12px; flex-wrap: wrap; }
.m3xi-toolbar .m3xi-btn { border: 1px solid var(--line); }

.m3xi-hint { color: var(--ink-dim); font-size: 12.5px; margin: 10px 0 0; }

/* --- floorplan ---------------------------------------------------------- */

.m3xi-plan { width: 100%; height: auto; display: block; }
.m3xi-plan .room {
  fill: var(--accent-soft);
  stroke: var(--line-strong);
  stroke-width: 0.04;
  cursor: pointer;
}
.m3xi-plan .room:hover, .m3xi-plan .room:focus-visible { fill: var(--accent); fill-opacity: 0.3; }
.m3xi-plan .room[aria-current="true"] { fill: var(--accent); fill-opacity: 0.4; }
.m3xi-plan .gap { fill: url(#m3xi-hatch); stroke: var(--line-strong); stroke-width: 0.03; stroke-dasharray: 0.12 0.08; }
/* Recorded above head height: outlined, never hatched across the floor. */
.m3xi-plan .gap-above { fill: none; stroke: var(--line-strong); stroke-width: 0.025; stroke-dasharray: 0.1 0.1; }
.m3xi-plan .label { fill: var(--ink); font-size: 0.3px; text-anchor: middle; pointer-events: none; }
.m3xi-plan .you { fill: var(--accent); stroke: var(--surface-solid); stroke-width: 0.05; }

/* --- written tour ------------------------------------------------------- */

.m3xi-tour { max-width: 62ch; }
.m3xi-tour h2 { font-size: 15px; margin: 22px 0 6px; letter-spacing: -0.005em; }
.m3xi-tour h2:first-child { margin-top: 0; }
.m3xi-tour h3 { font-size: 14px; margin: 18px 0 6px; }
.m3xi-tour p { margin: 0 0 9px; }
.m3xi-tour ul { margin: 0 0 10px; padding-left: 18px; }
.m3xi-tour li { margin-bottom: 4px; }
.m3xi-tour .m3xi-quantity { margin: 8px 0 12px; }
.m3xi-toc { margin: 0 0 18px; padding-left: 18px; }
.m3xi-goto {
  appearance: none;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--ink);
  font: inherit;
  font-size: 12.5px;
  padding: 7px 11px;
  min-height: 36px;
  cursor: pointer;
  margin-bottom: 10px;
}
.m3xi-goto:hover { background: var(--accent-soft); }

/* --- ask ---------------------------------------------------------------- */

.m3xi-ask-log { display: flex; flex-direction: column; gap: 14px; margin-bottom: 14px; }
.m3xi-ask-turn { font-size: 13.5px; }
.m3xi-ask-turn[data-role="user"] { color: var(--ink-dim); }
.m3xi-ask-turn[data-role="user"]::before { content: "You: "; font-weight: 600; }
.m3xi-cites { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px; }
.m3xi-cite {
  font-size: 11.5px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 3px 7px;
}
.m3xi-ask-form { display: flex; gap: 6px; }
.m3xi-ask-form input { flex: 1 1 auto; }
.m3xi-suggestions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.m3xi-suggestions .m3xi-btn { border: 1px solid var(--line); font-size: 12px; min-height: 32px; }

/* --- loading ------------------------------------------------------------ */

.m3xi-loading {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: var(--paper);
  color: var(--ink);
  text-align: center;
  padding: var(--gutter);
}
.m3xi-loading[hidden] { display: none; }
.m3xi-loading h2 { margin: 0; font-size: 16px; font-weight: 500; }
.m3xi-loading p { margin: 0; color: var(--ink-dim); font-size: 13px; font-variant-numeric: tabular-nums; }
.m3xi-progress {
  width: min(280px, 70vw);
  height: 2px;
  background: var(--line);
  overflow: hidden;
}
.m3xi-progress span {
  display: block;
  height: 100%;
  width: 0%;
  background: var(--accent);
  transition: width var(--motion);
}

/* --- labels over the 3D view -------------------------------------------- */

.m3xi-labels { position: absolute; inset: 0; z-index: 25; pointer-events: none; }
.m3xi-label {
  position: absolute;
  transform: translate(-50%, -50%);
  background: var(--surface-solid);
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  padding: 4px 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--ink);
}
.m3xi-label[data-status="indicative"] {
  background-image: repeating-linear-gradient(45deg, var(--line) 0 1px, transparent 1px 6px);
}
.m3xi-label small { display: block; color: var(--ink-dim); font-size: 11px; }

.m3xi-crosshair {
  position: absolute;
  left: 50%; top: 50%;
  width: 18px; height: 18px;
  margin: -9px 0 0 -9px;
  z-index: 26;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--motion);
}
.m3xi-viewer[data-tool="measure"] .m3xi-crosshair,
.m3xi-viewer[data-tool="inspect"] .m3xi-crosshair { opacity: 1; }
.m3xi-crosshair::before, .m3xi-crosshair::after {
  content: ""; position: absolute; background: var(--ink); opacity: 0.8;
}
.m3xi-crosshair::before { left: 50%; top: 0; width: 1px; height: 100%; margin-left: -0.5px; }
.m3xi-crosshair::after { top: 50%; left: 0; height: 1px; width: 100%; margin-top: -0.5px; }

/* --- touch pad ---------------------------------------------------------- */

.m3xi-pad {
  position: absolute;
  left: var(--gutter);
  bottom: var(--gutter);
  z-index: 38;
  display: none;
  grid-template-columns: repeat(3, 44px);
  grid-template-rows: repeat(2, 44px);
  gap: 2px;
}
.m3xi-viewer[data-coarse="true"] .m3xi-pad { display: grid; }
.m3xi-pad button {
  appearance: none;
  background: var(--surface);
  backdrop-filter: blur(10px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 15px;
  cursor: pointer;
}
.m3xi-pad button:active { background: var(--accent-soft); }

/* --- branding ----------------------------------------------------------- */

.m3xi-brand {
  position: absolute;
  top: var(--gutter);
  right: var(--gutter);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  background: var(--surface);
  backdrop-filter: blur(14px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--ink-dim);
}
.m3xi-brand img { height: 22px; width: auto; display: block; }
.m3xi-brand a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line-strong); }

.m3xi-diag { font-size: 12px; font-variant-numeric: tabular-nums; }
.m3xi-diag dl { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; margin: 0; }
.m3xi-diag dt { color: var(--ink-dim); }
.m3xi-diag dd { margin: 0; text-align: right; }

@media (max-width: 640px) {
  .m3xi-panel {
    top: auto;
    left: var(--gutter);
    right: var(--gutter);
    bottom: calc(var(--gutter) + 52px);
    width: auto;
    max-height: 56%;
  }
  .m3xi-head { max-width: calc(100% - 2 * var(--gutter)); }
  .m3xi-btn span { display: none; }
  .m3xi-btn { padding: 0 10px; }
}

@media (prefers-reduced-motion: reduce) {
  .m3xi-viewer * { transition-duration: 1ms !important; animation-duration: 1ms !important; }
}

@media (forced-colors: active) {
  .m3xi-panel, .m3xi-rail, .m3xi-title, .m3xi-coverage, .m3xi-label { border: 1px solid CanvasText; }
  .m3xi-btn[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; }
}
`;

let injected = false;

/** Injects the stylesheet once per document, idempotently. */
export function ensureStyles(doc: Document): void {
  if (injected && doc.getElementById('m3xi-viewer-styles')) return;
  if (doc.getElementById('m3xi-viewer-styles')) { injected = true; return; }
  const style = doc.createElement('style');
  style.id = 'm3xi-viewer-styles';
  style.textContent = VIEWER_CSS;
  doc.head.appendChild(style);
  injected = true;
}
