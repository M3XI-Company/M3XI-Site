/**
 * DOM helpers for the correction editor.
 *
 * A deliberate copy of the three functions this package needs rather than an
 * import from `@m3xi/console-ui`. The editor is mounted through a runtime seam
 * that exists precisely so the console can boot without this package; taking a
 * hard dependency the other way would tie the two builds together again for
 * the sake of forty lines, and a version skew in those forty lines would break
 * the seam rather than one panel.
 *
 * Text goes in through `textContent` and never through `innerHTML`. A room
 * name, an operator's note and a server error string all reach this editor
 * from somewhere else, and any of the three is a script if it is parsed as
 * markup.
 */

export type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  readonly [key: string]: string | number | boolean | null | undefined | EventListener;
}

/**
 * Create an element. `on*` keys are listeners, `class` and `style` are
 * strings, `true` sets a bare attribute and `false`/`null`/`undefined` leaves
 * it off entirely rather than setting the string "false".
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
    if (value === true) { node.setAttribute(key, ''); continue; }
    node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an SVG element. Separate from `el` because SVG lives in its own
 * namespace and because `className` on an SVG element is a read-only
 * `SVGAnimatedString`, so everything here goes through `setAttribute`.
 */
export function svgEl(
  tag: string, attrs: Attrs = {}, ...children: Child[]
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

let idSeq = 0;

/** Unique within a document, so a label's `for` cannot point at another panel. */
export function uniqueId(prefix = 'rv'): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/** Present to a screen reader, invisible on screen. Never used to hide meaning. */
export function srOnly(text: string): HTMLElement {
  return el('span', { class: 'rv-sr' }, text);
}
