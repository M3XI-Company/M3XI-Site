/**
 * Small DOM helpers. Deliberately not a framework: the viewer ships into an
 * agency's page and must not bring a runtime with it, and the total amount of
 * DOM here is a few hundred nodes.
 *
 * Everything that creates interactive content sets its accessible name at
 * creation time, so there is no path that produces an unlabelled control.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function svg(
  tag: string,
  attrs: Record<string, string | number | undefined> = {},
  children: Array<Node | string> = [],
): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

export interface ButtonSpec {
  readonly label: string;
  /** Inline SVG path data for a 16px icon on a 0 0 16 16 viewBox. */
  readonly icon?: string;
  readonly pressed?: boolean;
  readonly expanded?: boolean;
  /** Set when the visible label is hidden at narrow widths. */
  readonly keepLabel?: boolean;
  readonly onClick: (e: MouseEvent) => void;
}

export function button(spec: ButtonSpec): HTMLButtonElement {
  const node = el('button', {
    type: 'button',
    class: 'm3xi-btn',
    // The visible label is hidden by a media query at narrow widths, so the
    // accessible name comes from aria-label and never disappears with it.
    'aria-label': spec.label,
    ...(spec.pressed !== undefined ? { 'aria-pressed': String(spec.pressed) } : {}),
    ...(spec.expanded !== undefined ? { 'aria-expanded': String(spec.expanded) } : {}),
  });
  if (spec.icon) {
    const g = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, [
      svg('path', {
        d: spec.icon, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }),
    ]);
    node.appendChild(g);
  }
  node.appendChild(el('span', { text: spec.label }));
  node.addEventListener('click', spec.onClick);
  return node as HTMLButtonElement;
}

/** 16x16 line icons. Geometric, unbranded, no emoji anywhere in this product. */
export const ICONS = {
  rooms: 'M2 3h5v10H2z M9 3h5v5H9z M9 10h5v3H9z',
  measure: 'M1.5 9.5l8-8 5 5-8 8z M4 7l1.5 1.5 M6 5l1.5 1.5 M8 3l1.5 1.5',
  ask: 'M8 1.5A6.5 6.5 0 0 1 14.5 8 6.5 6.5 0 0 1 8 14.5H1.5L3 11A6.5 6.5 0 0 1 8 1.5z',
  plan: 'M1.5 2.5h13v11h-13z M6 2.5v11 M6 8h8.5',
  text: 'M2.5 3.5h11 M2.5 6.5h11 M2.5 9.5h8 M2.5 12.5h5',
  info: 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13z M8 7v4.5 M8 4.6v.2',
  inspect: 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M11 11l3.5 3.5',
  diag: 'M1.5 12.5l4-5 3 3 6-7',
  close: 'M3.5 3.5l9 9 M12.5 3.5l-9 9',
} as const;

/**
 * Focus management for non-modal panels. A non-modal panel must not trap
 * focus (2.1.2 No Keyboard Trap) but it must be reachable and dismissible
 * (2.1.1, 2.1.4), so: opening moves focus in, Escape closes and returns it.
 */
export function focusFirst(container: HTMLElement): void {
  const target = container.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  (target ?? container).focus({ preventScroll: true });
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Announce to assistive technology without stealing focus. */
export class LiveRegion {
  readonly node: HTMLElement;
  private last = '';
  private timer: number | undefined;

  constructor(politeness: 'polite' | 'assertive' = 'polite') {
    this.node = el('div', {
      class: 'm3xi-sr',
      role: 'status',
      'aria-live': politeness,
      'aria-atomic': 'true',
    });
  }

  say(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Screen readers ignore an identical consecutive update, so nudge it with
    // a zero-width space rather than dropping a repeated announcement.
    const message = trimmed === this.last ? `${trimmed}​` : trimmed;
    this.last = trimmed;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.node.textContent = message; }, 60) as unknown as number;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.node.remove();
  }
}
