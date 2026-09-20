/**
 * A four-hundred-byte element tree, and why this package has one.
 *
 * Every document here has two destinations that must not disagree: a live
 * pane in the operator console, where an agent ticks a checklist and approves
 * a redaction, and a file -- printed to PDF or saved as HTML -- that somebody
 * is later asked to produce. A measurement certificate whose printed copy says
 * something different from the screen it was printed from is worse than no
 * certificate, because the difference is what a dispute turns on.
 *
 * Three ways to guarantee they agree were considered.
 *
 *   -- BUILD DOM AND SERIALISE `outerHTML`. The obvious one, and it fails at
 *      the test boundary: this workspace runs vitest with `environment: 'node'`
 *      and there is no jsdom here. Adding one is a new dependency, which this
 *      package is not allowed to take. Without it, the only tested layer would
 *      be the models, and the rendering -- where "shown as indicative" either
 *      happens or does not -- would ship untested.
 *
 *   -- BUILD AN HTML STRING AND `innerHTML` IT. Cheap, and it reintroduces the
 *      one rule `console-ui/src/ui/dom.ts` is built around: a property
 *      description, a visitor's message or a worker's error string must never
 *      reach an operator's session as markup. A redaction detector name and an
 *      operator id both come off a database row and both land in these tables.
 *
 *   -- BUILD A TREE ONCE, MATERIALISE IT TWICE. Which is this. `h()` builds
 *      plain data; `toDom` walks it into real elements with real listeners for
 *      the console; `toHtml` walks the same tree into escaped markup for the
 *      file. Neither path can drift, because there is one tree, and the tests
 *      read the markup in Node without a DOM at all.
 *
 * The cost is honest and worth naming: this is not a framework. There is no
 * diffing and no reconciliation. A pane that changes re-renders its subtree
 * and rebuilds those nodes, which for a document of a few hundred rows is
 * nothing, and focus is restored explicitly where it matters.
 */

export type Attr = string | number | boolean | null | undefined;

export interface VElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, Attr>>;
  readonly children: readonly VNode[];
  /** DOM event name (without "on") to listener. Ignored by `toHtml`. */
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
  /** Called with the real element after `toDom` creates it. Ignored by `toHtml`. */
  readonly ref?: (node: HTMLElement) => void;
}

export type VNode = VElement | string | number | null | false | undefined;

/**
 * Elements with no closing tag. `toHtml` must know them: `<br></br>` is parsed
 * by every browser as two line breaks, and `<input>...</input>` is not valid
 * markup at all, so a serialiser that guesses produces a file that renders
 * differently from the screen it came from.
 */
const VOID_TAGS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

export function h(
  tag: string, attrs: Readonly<Record<string, Attr>> = {}, ...children: VNode[]
): VElement {
  return { tag, attrs, children };
}

/** `h` with listeners attached. Split out so the common case stays quiet. */
export function hx(
  tag: string,
  attrs: Readonly<Record<string, Attr>>,
  on: Readonly<Record<string, (event: Event) => void>>,
  ...children: VNode[]
): VElement {
  return { tag, attrs, children, on };
}

/** `h` with a callback that receives the real element, for focus and reads. */
export function href(
  tag: string,
  attrs: Readonly<Record<string, Attr>>,
  ref: (node: HTMLElement) => void,
  ...children: VNode[]
): VElement {
  return { tag, attrs, children, ref };
}

export function isElement(node: VNode): node is VElement {
  return typeof node === 'object' && node !== null && typeof (node as VElement).tag === 'string';
}

/**
 * Escape a text node. `&` first, or every subsequent replacement's own
 * ampersand gets escaped twice and `&amp;lt;` reaches the page.
 */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Attribute values additionally escape both quote characters. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Serialise to markup.
 *
 * `false`, `null` and `undefined` children vanish, which is what makes
 * `cond && h(...)` safe in a document builder. A `true` attribute renders as a
 * bare attribute (`disabled`), a `false`/`null`/`undefined` attribute is
 * dropped entirely -- `disabled="false"` disables a control, and that bug is
 * invisible until somebody cannot submit a form.
 */
export function toHtml(node: VNode): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return escapeText(node);
  if (typeof node === 'number') return escapeText(String(node));

  const parts: string[] = [];
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) { parts.push(` ${key}`); continue; }
    parts.push(` ${key}="${escapeAttr(String(value))}"`);
  }
  const open = `<${node.tag}${parts.join('')}>`;
  if (VOID_TAGS.has(node.tag)) return open;
  const inner = node.children.map(toHtml).join('');
  return `${open}${inner}</${node.tag}>`;
}

/**
 * Materialise into a real DOM.
 *
 * `document` is passed in rather than read off the global, so a caller that
 * has one (an iframe, a print window) can render into it, and so this function
 * has no opinion about there being exactly one document in the world.
 *
 * Text is set by creating text nodes. There is no `innerHTML` in this file and
 * there must not be: every string that reaches here came off a database row.
 */
export function toDom(node: VNode, doc: Document): Node {
  if (node === null || node === undefined || node === false) {
    return doc.createTextNode('');
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return doc.createTextNode(String(node));
  }

  const element = doc.createElement(node.tag);
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) { element.setAttribute(key, ''); continue; }
    element.setAttribute(key, String(value));
  }
  if (node.on) {
    for (const [event, listener] of Object.entries(node.on)) {
      element.addEventListener(event, listener);
    }
  }
  for (const child of node.children) element.appendChild(toDom(child, doc));
  if (node.ref) node.ref(element);
  return element;
}

/**
 * The plain text a document reads as, with one block per line.
 *
 * Used by the tests to assert what a document SAYS rather than how it is
 * marked up -- "this row reads as unanswered" is a statement about the words
 * on the page, and asserting it against class names would pass for a document
 * that renders an empty cell with the right class on it.
 *
 * Block-level tags become line breaks so that two adjacent cells never fuse
 * into one word: a naive `textContent` turns `<td>4.50</td><td>m</td>` into
 * "4.50m", and a test looking for "4.50 m" then fails for the wrong reason.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'div', 'dd', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'header', 'hr', 'label', 'legend', 'li', 'main', 'nav', 'ol', 'option', 'p',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

export function toText(node: VNode): string {
  const out: string[] = [];
  walkText(node, out);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walkText(node: VNode, out: string[]): void {
  if (node === null || node === undefined || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
  const block = BLOCK_TAGS.has(node.tag);
  if (block) out.push('\n');
  // An input's value is what the reader sees in it, so it belongs in the text.
  // An empty one contributes nothing, which is exactly right: a blank field
  // must read as blank, and a test that wants "unanswered" has to find the
  // word somewhere else on the row.
  const value = node.attrs['value'];
  if (node.tag === 'input' && typeof value === 'string' && value.length > 0) out.push(value);
  for (const child of node.children) walkText(child, out);
  if (block) out.push('\n');
}
