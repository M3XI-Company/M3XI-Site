/**
 * Small DOM helpers, the same shape as the ones on /events/ and /staff/.
 *
 * The one rule: everything that came from a person or from the server is set
 * with textContent. There is no innerHTML anywhere in the studio. The only
 * markup the page builds from a string is an SVG path `d` we generated
 * ourselves, through setAttribute.
 */

export type Kid = Node | string | null | false | undefined;
export type Attrs = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  kids?: Kid[],
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  Object.keys(attrs || {}).forEach((k) => {
    const v = (attrs as Attrs)[k];
    if (k === 'text') n.textContent = v == null ? '' : String(v);
    else if (k === 'class') n.className = String(v);
    else if (k === 'html') throw new Error('no innerHTML in the studio');
    else if (k.indexOf('on') === 0 && typeof v === 'function') {
      n.addEventListener(k.slice(2), v as EventListener);
    } else if (v !== undefined && v !== null && v !== false) {
      n.setAttribute(k, v === true ? '' : String(v));
    }
  });
  (kids || []).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
}

export const SVGNS = 'http://www.w3.org/2000/svg';

export function svg(tag: string, attrs?: Attrs, kids?: (Element | null | false)[]): SVGElement {
  const n = document.createElementNS(SVGNS, tag) as SVGElement;
  Object.keys(attrs || {}).forEach((k) => {
    const v = (attrs as Attrs)[k];
    if (v !== undefined && v !== null && v !== false) n.setAttribute(k, String(v));
  });
  (kids || []).forEach((c) => { if (c) n.appendChild(c); });
  return n;
}

export function clear(n: Element): void {
  n.textContent = '';
}

/** A short message on a paper chip. Never used for anything a person must read once. */
export function toast(text: string): void {
  const d = el('div', { class: 'toast', role: 'status', text });
  document.body.appendChild(d);
  window.setTimeout(() => d.remove(), 4600);
}

/**
 * Every pop-up is a letter — the app's rule, kept here so the two feel like one
 * place. Cream stock, a wax seal, a serif title, plain sentences, and the
 * actions along the bottom.
 */
export type LetterAction = { label: string; rose?: boolean; onPick?: () => void };

export function letter(opts: {
  title: string;
  body?: string | Node | (Node | string | null)[];
  actions?: LetterAction[];
  onClose?: () => void;
}): () => void {
  const shade = el('div', { class: 'shade' });
  // Where the person was before the letter opened, so they are put back there
  // when it closes rather than at the top of the document.
  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    shade.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && document.contains(opener)) { try { opener.focus(); } catch { /* gone */ } }
    opts.onClose && opts.onClose();
  };
  const body: Kid[] = [];
  if (Array.isArray(opts.body)) body.push(...opts.body);
  else if (typeof opts.body === 'string') body.push(el('p', { text: opts.body }));
  else if (opts.body) body.push(opts.body);

  const actions = (opts.actions && opts.actions.length ? opts.actions : [{ label: 'Close' }]).map((a) =>
    el('button', {
      class: 'btn' + (a.rose ? ' rose' : ''),
      type: 'button',
      text: a.label,
      onclick: () => { close(); a.onPick && a.onPick(); },
    }),
  );

  const card = el('div', { class: 'letter pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title }, [
    el('span', { class: 'seal', 'aria-hidden': 'true' }),
    el('h2', { text: opts.title }),
    ...body,
    el('div', { class: 'actions' }, actions),
  ]);
  shade.appendChild(card);
  shade.addEventListener('click', (e) => { if (e.target === shade) close(); });

  /*
   * Escape closes, and Tab stays inside.
   *
   * Without the trap, Tab walked straight out into the page behind, which is
   * still fully interactive under the shade — and a `role="dialog"` with
   * `aria-modal` that does not actually hold focus is worse than none.
   */
  const focusables = (): HTMLElement[] => Array.prototype.slice.call(
    card.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
  ) as HTMLElement[];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const here = document.activeElement as HTMLElement | null;
    if (!here || !card.contains(here)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && here === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && here === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(shade);
  // The FIRST action, not the last. The destructive letters put the
  // destructive action last ("Keep it", "Throw it away"), so focusing the last
  // one put the cursor on Throw it away — and a held Enter that opened the
  // letter would auto-repeat straight onto it. The first action is always the
  // safe one.
  (actions[0] as HTMLButtonElement).focus();
  return close;
}

/** A wax seal, drawn with a tulip. Tulips, never hearts. */
export function seal(): SVGElement {
  return svg('svg', { viewBox: '0 0 36 36', class: 'sealmark', 'aria-hidden': 'true' }, [
    svg('circle', { cx: 18, cy: 18, r: 17, fill: '#B3402A' }),
    svg('circle', { cx: 18, cy: 18, r: 13, fill: 'none', stroke: 'rgba(255,255,255,.28)', 'stroke-width': 1 }),
    svg('path', {
      d: 'M18 11c-2.6 1.4-4 3.6-4 6.2 0 2.1 1.8 3.8 4 3.8s4-1.7 4-3.8c0-2.6-1.4-4.8-4-6.2z',
      fill: '#F7E7DA',
    }),
    svg('path', {
      d: 'M18 21v6M18 25c-1.8-.2-3-1.2-3.6-2.6M18 25c1.8-.2 3-1.2 3.6-2.6',
      stroke: '#F7E7DA', 'stroke-width': 1.4, fill: 'none', 'stroke-linecap': 'round',
    }),
  ]);
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? m + ' min ' + String(r).padStart(2, '0') + ' s' : r + ' s';
}
