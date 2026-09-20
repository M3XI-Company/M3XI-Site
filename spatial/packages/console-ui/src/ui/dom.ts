/**
 * DOM helpers.
 *
 * `el()` sets text through `textContent` and never through `innerHTML`, which
 * is the single rule that keeps an agency's own property description, a
 * visitor's lead message and a worker's error string from executing in an
 * operator's session. The one place raw markup is produced — the embed snippet
 * — builds a string that is *shown*, not parsed, and escapes its inputs.
 */

export type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  readonly [key: string]: string | number | boolean | null | undefined | EventListener;
}

/**
 * Create an element. Keys starting with `on` are listeners, `class` and
 * `style` are strings, everything else is an attribute, and `false`/`null`
 * removes the attribute rather than setting the string "false".
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (key === 'class') { node.className = String(value); continue; }
    if (key === 'style') { node.setAttribute('style', String(value)); continue; }
    if (value === true) { node.setAttribute(key, ''); continue; }
    node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: Node[]): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) node.appendChild(c);
  return node;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

/** Visually hidden but present for screen readers. */
export function sr(text: string): HTMLElement {
  return el('span', { class: 'c-sr' }, text);
}

let idSeq = 0;
export function uniqueId(prefix = 'c'): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/**
 * One polite and one assertive live region for the whole app.
 *
 * Created once and reused: a live region added to the DOM at the same moment
 * its text changes is frequently missed by screen readers, so both exist from
 * boot and only their contents change. Errors are assertive; everything else
 * is polite, because interrupting someone mid-sentence to say "saved" is rude.
 */
let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;

export function installLiveRegions(root: HTMLElement = document.body): void {
  if (!politeRegion) {
    politeRegion = el('div', { class: 'c-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    root.appendChild(politeRegion);
  }
  if (!assertiveRegion) {
    assertiveRegion = el('div', { class: 'c-sr', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' });
    root.appendChild(assertiveRegion);
  }
}

export function announce(message: string, urgent = false): void {
  installLiveRegions();
  const region = urgent ? assertiveRegion : politeRegion;
  if (!region) return;
  // Clearing first makes a repeated identical message announce again.
  region.textContent = '';
  window.setTimeout(() => { region.textContent = message; }, 30);
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusables(root: HTMLElement): HTMLElement[] {
  // Array.from rather than spread: the tsconfig lib is ES2022 + DOM without
  // DOM.Iterable, so a NodeList is not iterable at type level here.
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((n) => n.offsetParent !== null || n === document.activeElement);
}

/**
 * Trap the tab ring inside `root` until the returned function is called.
 * Restores focus to wherever it came from, which is what makes a dialog
 * dismissable without losing your place in a long table.
 */
export function trapFocus(root: HTMLElement): () => void {
  const previous = document.activeElement as HTMLElement | null;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const items = focusables(root);
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault(); first.focus();
    }
  };

  root.addEventListener('keydown', onKeyDown);
  const target = focusables(root)[0] ?? root;
  target.focus();

  return () => {
    root.removeEventListener('keydown', onKeyDown);
    if (previous && document.contains(previous)) previous.focus();
  };
}

/**
 * Move focus to the page heading after a route change.
 *
 * A single-page app that swaps its main content without moving focus leaves a
 * screen-reader user at the bottom of the previous page with no announcement
 * that anything happened. `tabindex="-1"` makes the heading programmatically
 * focusable without adding it to the tab ring.
 */
export function focusHeading(heading: HTMLElement): void {
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: false });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type ThemeChoice = 'light' | 'dark' | 'system';
const THEME_KEY = 'm3xi.console.theme';

export function currentTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch { /* private mode; fall through to system */ }
  return 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try { localStorage.setItem(THEME_KEY, choice); } catch { /* not fatal */ }
}
