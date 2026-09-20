/**
 * The small amount of DOM plumbing this app needs.
 *
 * Not imported from `@m3xi/console-ui`, for the reason given at the top of
 * `api/supabase.ts`: the console's entry in the root vite.config.js is guarded
 * on `spatial/node_modules` existing and the capture page's is not, so a
 * dependency in that direction would eventually stop the thing an operator
 * holds in their hand from building on a server that has never installed
 * three.js. Four helpers is a cheaper price than that coupling.
 *
 * Everything here is about the same three obligations, because this app is
 * used one-handed, at arm's length, in somebody's hallway, sometimes in poor
 * light:
 *
 *   REAL SEMANTICS. A button is a `<button>`, a group of choices is a
 *   `<fieldset>` with a `<legend>`, and the live screen's cue is a live region
 *   a screen reader announces. There is no accessibility overlay in this
 *   product and there will not be one — the fix is the markup being right.
 *
 *   EVERY CONTROL HAS A NAME. `field` refuses to build an input without a
 *   label, rather than accepting a placeholder as one. A placeholder vanishes
 *   the moment someone types.
 *
 *   FOCUS GOES WHERE THE WORK IS. `focusHeading` moves focus to the new
 *   screen's heading on every step of the wizard. Without it a screen-reader
 *   user is left at the bottom of the screen they thought they had left, which
 *   is the single most common way a single-page app becomes unusable.
 */

type Attrs = Record<string, unknown>;

/**
 * Create an element. Attributes, then children.
 *
 * `on*` keys are attached as listeners rather than as attributes, so a handler
 * is a function and not a string of code — which also means this helper cannot
 * be used to inject markup even if a value came from a server.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export interface ButtonOptions {
  readonly label: string;
  readonly emphasis?: 'primary' | 'secondary' | 'quiet' | 'danger';
  readonly type?: 'button' | 'submit';
  /** Used when the visible label is shorter than the meaning. */
  readonly describedBy?: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  /** A second line under the label, for the two declare buttons. */
  readonly sublabel?: string;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const node = el('button', {
    type: options.type ?? 'button',
    class: `c-btn c-btn-${options.emphasis ?? 'secondary'}`,
    'aria-describedby': options.describedBy,
    disabled: options.disabled === true,
    onclick: options.onClick,
  }, el('span', { class: 'c-btn-label' }, options.label));
  if (options.sublabel) {
    node.appendChild(el('span', { class: 'c-btn-sub' }, options.sublabel));
  }
  return node;
}

let fieldSeq = 0;

export interface FieldHandles {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
}

export interface FieldOptions {
  readonly label: string;
  readonly type?: string;
  readonly value?: string;
  readonly required?: boolean;
  readonly autocomplete?: string;
  readonly inputmode?: string;
  readonly hint?: string;
}

/**
 * A labelled input. There is no way to build an unlabelled one on purpose.
 */
export function field(options: FieldOptions): FieldHandles {
  fieldSeq += 1;
  const id = `f${fieldSeq}`;
  const hintId = options.hint ? `${id}-hint` : undefined;
  const input = el('input', {
    id,
    class: 'c-input',
    type: options.type ?? 'text',
    value: options.value ?? '',
    required: options.required === true,
    autocomplete: options.autocomplete,
    inputmode: options.inputmode,
    'aria-describedby': hintId,
  });
  const root = el('div', { class: 'c-field' },
    el('label', { for: id }, options.label),
    input,
    options.hint ? el('p', { id: hintId, class: 'c-hint' }, options.hint) : null,
  );
  return { root, input };
}

export type NoteTone = 'act' | 'advise' | 'ok' | 'info';

/** A short block of prose with a tone. Never the only carrier of meaning. */
export function note(tone: NoteTone, text: string, heading?: string): HTMLElement {
  return el('div', { class: `c-note c-${tone}` },
    heading ? el('strong', {}, heading) : null,
    el('p', {}, text),
  );
}

/**
 * The one live region.
 *
 * `aria-live="polite"` and not `assertive`: the cue changes several times a
 * minute and an assertive region interrupts whatever the screen reader is
 * saying every time, which on this screen would mean it never finishes a
 * sentence. Errors that need interrupting get focus instead, which is louder
 * and does not fight the user's own navigation.
 */
export function announcer(): { readonly node: HTMLElement; say(text: string): void } {
  const node = el('div', {
    class: 'c-sr-only',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  let last = '';
  return {
    node,
    say(text: string): void {
      // Re-announcing identical text is noise; a screen reader will repeat it
      // and the operator learns to ignore the region.
      if (text === last) return;
      last = text;
      node.textContent = text;
    },
  };
}

/** Move focus to a heading, so a step change is not silent. */
export function focusHeading(heading: HTMLElement): void {
  heading.setAttribute('tabindex', '-1');
  heading.focus();
}

/** Remove every child. Shorter than the loop and says what it means. */
export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/**
 * Seconds as "4:12", for durations an operator reads at a glance.
 *
 * Minutes and seconds rather than "252 s" because the target the pipeline
 * refuses below is 45 seconds and the budget it warns above is 12 minutes, and
 * both of those are things a person thinks about in minutes.
 */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Bytes as a short human string. Binary units, because storage limits are. */
export function byteText(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
