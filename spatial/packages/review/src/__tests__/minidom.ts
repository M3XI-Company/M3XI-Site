/**
 * A DOM small enough to read, for testing the editor's markup in Node.
 *
 * WHY THIS EXISTS. This workspace has no jsdom and no happy-dom, and its rule
 * is that no new dependency is added for this package -- the only runtime
 * dependencies here are three.js and Spark, and neither is wanted in a
 * correction editor's test run. Every other package in the repo answered that
 * by having no DOM tests at all. That is not available to this one: the plan
 * IS the pick surface, the accessible names ARE the review, and an editor
 * whose markup is never asserted on is an editor whose keyboard operation and
 * labelling are hope.
 *
 * WHAT IT IS AND IS NOT. It is a test double for a browser, in the same sense
 * that jsdom is one: nodes, attributes, text and listeners, and nothing else.
 * It implements no layout, no cascade, no focus policy and no event
 * propagation, so nothing here can be mistaken for evidence that the editor
 * LOOKS right. It is evidence about structure: that the element exists, that
 * it carries the attribute, that the listener is wired and what it does when
 * it fires.
 *
 * It fabricates nothing. Every method below either does the real thing or is
 * absent, so a test that reaches for behaviour this does not have fails at the
 * missing method rather than passing against a plausible stub.
 */

export class MiniNode {
  childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends MiniNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error('removeChild: the node is not a child of this node');
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    for (const child of this.childNodes.splice(0)) child.parentNode = null;
    if (value !== '') this.appendChild(new MiniText(value));
  }
}

export class MiniText extends MiniNode {
  data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  override get textContent(): string { return this.data; }

  override set textContent(value: string) { this.data = value; }
}

export type Listener = (event: MiniEvent) => void;

export interface MiniEvent {
  readonly type: string;
  readonly target: MiniElement;
  readonly key?: string;
  readonly shiftKey?: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

export class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  /** Set by `focus()`, so a test can assert the roving tab ring moved. */
  focused = false;

  private state = new Map<string, string | boolean>();

  constructor(tagName: string, namespaceURI: string | null = null) {
    super();
    this.tagName = tagName.toLowerCase();
    this.namespaceURI = namespaceURI;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  get id(): string { return this.getAttribute('id') ?? ''; }

  set id(value: string) { this.setAttribute('id', value); }

  /** Form value, which is state rather than an attribute once a user types. */
  get value(): string {
    const v = this.state.get('value');
    return typeof v === 'string' ? v : this.getAttribute('value') ?? '';
  }

  set value(v: string) { this.state.set('value', v); }

  get checked(): boolean {
    const v = this.state.get('checked');
    return typeof v === 'boolean' ? v : this.hasAttribute('checked');
  }

  set checked(v: boolean) { this.state.set('checked', v); }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  focus(): void { this.focused = true; }
}

export class MiniDocument {
  readonly head = new MiniElement('head');
  readonly body = new MiniElement('body');

  createElement(tag: string): MiniElement {
    return new MiniElement(tag);
  }

  createElementNS(ns: string, tag: string): MiniElement {
    return new MiniElement(tag, ns);
  }

  createTextNode(data: string): MiniText {
    return new MiniText(data);
  }

  getElementById(id: string): MiniElement | null {
    const scan = (node: MiniNode): MiniElement | null => {
      if (node instanceof MiniElement && node.getAttribute('id') === id) return node;
      for (const child of node.childNodes) {
        const found = scan(child);
        if (found) return found;
      }
      return null;
    };
    return scan(this.head) ?? scan(this.body);
  }
}

// ---------------------------------------------------------------------------
// Installing and inspecting
// ---------------------------------------------------------------------------

export interface InstalledDom {
  readonly document: MiniDocument;
  readonly host: MiniElement;
  uninstall(): void;
}

/**
 * Put a document on `globalThis` for the duration of a test and take it away
 * afterwards, so a test that forgets to tear down cannot make the next file's
 * "there is no DOM in Node" assertion pass for the wrong reason.
 */
export function installDom(): InstalledDom {
  const document = new MiniDocument();
  const host = new MiniElement('div');
  document.body.appendChild(host);
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = document;
  return {
    document,
    host,
    uninstall(): void {
      if (previous === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = previous;
    },
  };
}

/** Every element under `root`, in document order, including `root` itself. */
export function all(root: MiniNode): MiniElement[] {
  const out: MiniElement[] = [];
  const walk = (node: MiniNode): void => {
    if (node instanceof MiniElement) out.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}

export function byAttr(root: MiniNode, name: string, value?: string): MiniElement[] {
  return all(root).filter((n) => (value === undefined
    ? n.hasAttribute(name)
    : n.getAttribute(name) === value));
}

export function byTag(root: MiniNode, tag: string): MiniElement[] {
  return all(root).filter((n) => n.tagName === tag);
}

/** The first element whose text contains `needle`. Trimmed, case-sensitive. */
export function withText(root: MiniNode, needle: string): MiniElement | null {
  return all(root).find((n) => n.textContent.includes(needle)) ?? null;
}

export function fire(
  node: MiniElement, type: string, init: { key?: string; shiftKey?: boolean } = {},
): MiniEvent {
  const event: MiniEvent = {
    type,
    target: node,
    ...init,
    defaultPrevented: false,
    preventDefault(): void { (this as { defaultPrevented: boolean }).defaultPrevented = true; },
  };
  for (const fn of [...(node.listeners.get(type) ?? [])]) fn(event);
  return event;
}

/** Type into an input or textarea the way a person does: set, then notify. */
export function typeInto(node: MiniElement, text: string): void {
  node.value = text;
  fire(node, 'input');
}

export function choose(node: MiniElement, value: string): void {
  node.value = value;
  fire(node, 'change');
}

export function tick(node: MiniElement, on = true): void {
  node.checked = on;
  fire(node, 'change');
}
