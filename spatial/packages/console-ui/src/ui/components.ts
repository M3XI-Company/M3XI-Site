/**
 * The console's controls.
 *
 * Every one of them is a real element with a real role: a button is a
 * `<button>`, a table is a `<table>`, a dialog is a focus-trapped
 * `role="dialog"` with `aria-modal`. Nothing here is a `<div>` wearing a
 * click handler, because that is how keyboard operation quietly stops working
 * three refactors later.
 *
 * Disabled controls use `aria-disabled` plus a real `disabled`, and always
 * carry the reason in `title` AND in an adjacent `aria-describedby` node —
 * a tooltip alone is invisible to a keyboard user and to anyone on a phone.
 */

import type { ActionView } from '../logic/actions.js';
import { announce, append, el, trapFocus, uniqueId, type Child } from './dom.js';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface ButtonOptions {
  readonly label: string;
  readonly onClick?: () => void;
  readonly emphasis?: 'primary' | 'normal' | 'danger' | 'quiet';
  readonly disabled?: boolean;
  /** Shown to everyone, not just on hover, when the control is disabled. */
  readonly reason?: string;
  readonly small?: boolean;
  readonly type?: 'button' | 'submit';
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const classes = ['c-btn'];
  if (options.emphasis && options.emphasis !== 'normal') classes.push(`c-btn--${options.emphasis}`);
  if (options.small) classes.push('c-btn--small');

  const btn = el('button', {
    class: classes.join(' '),
    type: options.type ?? 'button',
    disabled: options.disabled === true,
    'aria-disabled': options.disabled === true ? 'true' : null,
    title: options.disabled && options.reason ? options.reason : null,
    onclick: options.onClick ? () => options.onClick!() : null,
  }, options.label);
  return btn;
}

/**
 * Render an `ActionView` from the logic layer.
 *
 * The reason text is rendered as a sibling paragraph rather than a tooltip, so
 * "why can't I publish this" is answered on the screen, in words, for
 * everybody. This is the join between the access rules and the pixels, and it
 * is the only place that join is made.
 */
export function actionButton(action: ActionView, onClick: () => void): HTMLElement | null {
  if (!action.visible) return null;
  const wrap = el('span', { style: 'display:inline-flex;flex-direction:column;gap:2px' });
  const btn = button({
    label: action.label,
    emphasis: action.emphasis,
    disabled: !action.enabled,
    reason: action.reason,
    onClick,
  });
  wrap.appendChild(btn);
  if (!action.enabled && action.reason) {
    const id = uniqueId('reason');
    btn.setAttribute('aria-describedby', id);
    wrap.appendChild(el('span', {
      id, class: 'c-hint', style: 'max-width:34ch;font-size:12px;color:var(--ink-dim)',
    }, action.reason));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface FieldOptions {
  readonly label: string;
  readonly value?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly type?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly autocomplete?: string;
  readonly onInput?: (value: string) => void;
  readonly onEnter?: (value: string) => void;
}

export interface Field {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
}

export function field(options: FieldOptions): Field {
  const id = uniqueId('f');
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described: string[] = [];
  if (options.hint) described.push(hintId);
  if (options.error) described.push(errId);

  const input = el('input', {
    id,
    class: 'c-input',
    type: options.type ?? 'text',
    value: options.value ?? '',
    placeholder: options.placeholder ?? null,
    required: options.required === true,
    disabled: options.disabled === true,
    autocomplete: options.autocomplete ?? null,
    'aria-invalid': options.error ? 'true' : null,
    'aria-describedby': described.length > 0 ? described.join(' ') : null,
    oninput: options.onInput ? ((e: Event) => options.onInput!((e.target as HTMLInputElement).value)) : null,
    onkeydown: options.onEnter
      ? ((e: Event) => {
        if ((e as KeyboardEvent).key === 'Enter') options.onEnter!((e.target as HTMLInputElement).value);
      })
      : null,
  });

  const root = el('div', { class: 'c-field' },
    el('label', { for: id }, options.label),
    input,
    options.hint ? el('span', { id: hintId, class: 'c-hint' }, options.hint) : null,
    options.error ? el('span', { id: errId, class: 'c-error' }, options.error) : null,
  );
  return { root, input };
}

export interface SelectOptions {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly onChange?: (value: string) => void;
}

export function select(options: SelectOptions): { root: HTMLElement; select: HTMLSelectElement } {
  const id = uniqueId('s');
  const node = el('select', {
    id, class: 'c-select', disabled: options.disabled === true,
    onchange: options.onChange ? ((e: Event) => options.onChange!((e.target as HTMLSelectElement).value)) : null,
  });
  for (const opt of options.options) {
    node.appendChild(el('option', { value: opt.value, selected: opt.value === options.value }, opt.label));
  }
  node.value = options.value;
  const root = el('div', { class: 'c-field' },
    el('label', { for: id }, options.label),
    node,
    options.hint ? el('span', { class: 'c-hint' }, options.hint) : null,
  );
  return { root, select: node };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

/** A pill always carries its word. Colour is the second signal, never the only one. */
export function pill(text: string, tone: Tone): HTMLElement {
  return el('span', { class: `c-pill c-pill--${tone}` }, text);
}

const WORLD_STATUS_TONE: Readonly<Record<string, Tone>> = {
  draft: 'muted', capturing: 'info', processing: 'info', review: 'warn',
  published: 'ok', failed: 'bad', archived: 'muted',
};

export function worldStatusPill(status: string): HTMLElement {
  return pill(status, WORLD_STATUS_TONE[status] ?? 'muted');
}

const VERDICT_TONE: Readonly<Record<string, Tone>> = {
  pass: 'ok', review: 'warn', fail: 'bad',
};

export function verdictPill(verdict: string | null): HTMLElement {
  if (!verdict) return pill('not assessed', 'muted');
  return pill(verdict, VERDICT_TONE[verdict] ?? 'bad');
}

export function note(tone: Tone, heading: string | null, ...body: Child[]): HTMLElement {
  const children: Child[] = [];
  if (heading) children.push(el('h3', {}, heading));
  for (const b of body) children.push(typeof b === 'string' ? el('p', {}, b) : b);
  return el('div', { class: `c-note c-note--${tone}`, role: tone === 'bad' ? 'alert' : null }, ...children);
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

export interface MeterOptions {
  readonly label: string;
  readonly valueText: string;
  readonly ratio: number;
  readonly state: string;
  readonly caption: string;
  /** For the accessible value: 0..max. */
  readonly now: number;
  readonly max: number;
}

/**
 * A capacity bar with a real `role="meter"`.
 *
 * `aria-valuetext` carries the human sentence, because "0.94" read aloud tells
 * nobody that they are four builds from being cut off.
 */
export function meter(options: MeterOptions): HTMLElement {
  const pct = Math.max(0, Math.min(1, options.ratio)) * 100;
  return el('div', { class: `c-meter c-meter--${options.state}` },
    el('div', { class: 'c-meter-head' },
      el('b', {}, options.label),
      el('span', { class: 'c-meter-val' }, options.valueText),
    ),
    el('div', {
      class: 'c-meter-track',
      role: 'meter',
      'aria-valuemin': '0',
      'aria-valuemax': String(options.max),
      'aria-valuenow': String(options.now),
      'aria-valuetext': `${options.valueText}. ${options.caption}`,
      'aria-label': options.label,
    }, el('div', { class: 'c-meter-fill', style: `width:${pct.toFixed(2)}%` })),
    el('p', { class: 'c-meter-foot' }, options.caption),
  );
}

/** A small inline proportion bar, for a table cell. */
export function inlineBar(ratio: number, valueText: string): HTMLElement {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return el('div', { class: 'c-bar' },
    el('div', { class: 'c-bar-track', role: 'presentation' },
      el('div', { class: 'c-bar-fill', style: `width:${pct.toFixed(1)}%` })),
    el('span', { class: 'c-bar-val' }, valueText),
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly numeric?: boolean;
  readonly sortable?: boolean;
  readonly render: (row: T) => Child;
  /** Screen-reader-only header text when the visible header is an icon. */
  readonly width?: string;
}

export interface TableOptions<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly sortKey?: string;
  readonly ascending?: boolean;
  readonly onSort?: (key: string) => void;
  readonly empty?: Child;
  readonly selectable?: {
    readonly selected: ReadonlySet<string>;
    readonly onToggle: (key: string, selected: boolean) => void;
    readonly onToggleAll: (selected: boolean) => void;
    readonly label: (row: T) => string;
  };
}

export function table<T>(options: TableOptions<T>): HTMLElement {
  const thead = el('tr', {});

  if (options.selectable) {
    const allSelected = options.rows.length > 0
      && options.rows.every((r) => options.selectable!.selected.has(options.rowKey(r)));
    const box = el('label', { class: 'c-checkcell' }, el('input', {
      type: 'checkbox',
      checked: allSelected,
      'aria-label': allSelected ? 'Clear selection' : 'Select every property on this page',
      onchange: (e: Event) => options.selectable!.onToggleAll((e.target as HTMLInputElement).checked),
    }));
    thead.appendChild(el('th', { scope: 'col', style: 'width:34px' }, box));
  }

  for (const col of options.columns) {
    const sorted = options.sortKey === col.key;
    const ariaSort = sorted ? (options.ascending ? 'ascending' : 'descending') : 'none';
    const cell = el('th', {
      scope: 'col',
      class: col.numeric ? 'c-num' : null,
      'aria-sort': col.sortable ? ariaSort : null,
      style: col.width ? `width:${col.width}` : null,
    });
    if (col.sortable && options.onSort) {
      cell.appendChild(el('button', {
        class: 'c-sortbtn', type: 'button',
        onclick: () => options.onSort!(col.key),
      },
      col.header,
      el('span', { class: 'c-arrow', 'aria-hidden': 'true' }, sorted ? (options.ascending ? '↑' : '↓') : '↕'),
      ));
    } else {
      cell.appendChild(document.createTextNode(col.header));
    }
    thead.appendChild(cell);
  }

  const tbody = el('tbody', {});
  for (const row of options.rows) {
    const key = options.rowKey(row);
    const tr = el('tr', {});
    if (options.selectable) {
      const checked = options.selectable.selected.has(key);
      tr.appendChild(el('td', {},
        el('label', { class: 'c-checkcell' }, el('input', {
          type: 'checkbox', checked,
          'aria-label': `Select ${options.selectable.label(row)}`,
          onchange: (e: Event) => options.selectable!.onToggle(key, (e.target as HTMLInputElement).checked),
        }))));
    }
    for (const col of options.columns) {
      const td = el('td', { class: col.numeric ? 'c-num' : null });
      append(td, [col.render(row)]);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const node = el('table', { class: 'c-table' },
    el('caption', {}, options.caption),
    el('thead', {}, thead),
    tbody,
  );

  if (options.rows.length === 0) {
    return el('div', { class: 'c-tablewrap' }, node, el('div', { class: 'c-empty' }, options.empty ?? 'Nothing here yet.'));
  }
  return el('div', { class: 'c-tablewrap' }, node);
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  readonly title: string;
  readonly body: readonly Child[];
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly cancelLabel?: string;
}

/**
 * A modal confirmation. Resolves true on confirm, false on cancel, Escape or
 * a click on the backdrop. Focus is trapped while it is open and restored to
 * the control that opened it when it closes.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const titleId = uniqueId('dlg');
    const dialog = el('div', {
      class: 'c-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    });
    dialog.appendChild(el('h2', { id: titleId }, options.title));
    for (const b of options.body) {
      dialog.appendChild(typeof b === 'string' ? el('p', {}, b) : (b as Node));
    }

    const back = el('div', { class: 'c-dialogback' }, dialog);
    let release: (() => void) | null = null;

    const close = (result: boolean): void => {
      release?.();
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    };

    dialog.appendChild(el('div', { class: 'c-dialog-actions' },
      button({ label: options.cancelLabel ?? 'Cancel', onClick: () => close(false) }),
      button({
        label: options.confirmLabel,
        emphasis: options.danger ? 'danger' : 'primary',
        onClick: () => close(true),
      }),
    ));

    back.addEventListener('mousedown', (e) => { if (e.target === back) close(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    release = trapFocus(dialog);
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

export function toast(message: string, tone: 'ok' | 'bad' | 'info' = 'info'): void {
  if (!toastHost) {
    toastHost = el('div', { class: 'c-toasts' });
    document.body.appendChild(toastHost);
  }
  const node = el('div', { class: `c-toast c-toast--${tone}` }, message);
  toastHost.appendChild(node);
  // The live region does the announcing; the toast is the visual half.
  announce(message, tone === 'bad');
  window.setTimeout(() => node.remove(), tone === 'bad' ? 12000 : 6000);
}

// ---------------------------------------------------------------------------
// Copyable code
// ---------------------------------------------------------------------------

export function copyBlock(value: string, label: string): HTMLElement {
  const pre = el('pre', { class: 'c-code', tabindex: '0', 'aria-label': label }, value);
  const copy = button({
    label: 'Copy',
    small: true,
    onClick: () => {
      void navigator.clipboard?.writeText(value)
        .then(() => toast(`${label} copied.`, 'ok'))
        .catch(() => {
          // Clipboard access can be refused; selecting the text is the fallback
          // that always works.
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          toast('Could not reach the clipboard. The text is selected — copy it with Ctrl+C.', 'bad');
        });
    },
  });
  return el('div', { class: 'c-copyrow' }, pre, copy);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface TabSpec {
  readonly id: string;
  readonly label: string;
  readonly render: () => HTMLElement;
}

/**
 * Tabs with the keyboard behaviour the pattern actually requires: arrow keys
 * move between tabs, Home and End jump to the ends, and only the selected tab
 * is in the tab ring.
 */
export function tabs(specs: readonly TabSpec[], initial = 0): HTMLElement {
  const list = el('div', { class: 'c-tabs', role: 'tablist' });
  const panel = el('div', {});
  const buttons: HTMLButtonElement[] = [];
  let active = Math.max(0, Math.min(initial, specs.length - 1));

  const show = (index: number, moveFocus: boolean): void => {
    active = index;
    specs.forEach((spec, i) => {
      const btn = buttons[i]!;
      const selected = i === index;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.tabIndex = selected ? 0 : -1;
    });
    const spec = specs[index]!;
    panel.replaceChildren(spec.render());
    panel.setAttribute('aria-labelledby', `tab-${spec.id}`);
    if (moveFocus) buttons[index]!.focus();
  };

  specs.forEach((spec, i) => {
    const btn = el('button', {
      class: 'c-tab', role: 'tab', type: 'button', id: `tab-${spec.id}`,
      'aria-controls': `panel-${spec.id}`,
      onclick: () => show(i, false),
      onkeydown: (e: Event) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'ArrowRight') { e.preventDefault(); show((i + 1) % specs.length, true); }
        else if (key === 'ArrowLeft') { e.preventDefault(); show((i - 1 + specs.length) % specs.length, true); }
        else if (key === 'Home') { e.preventDefault(); show(0, true); }
        else if (key === 'End') { e.preventDefault(); show(specs.length - 1, true); }
      },
    }, spec.label);
    buttons.push(btn);
    list.appendChild(btn);
  });

  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('tabindex', '0');
  panel.id = `panel-${specs[active]?.id ?? 'x'}`;

  const root = el('div', {}, list, panel);
  show(active, false);
  return root;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export function facts(pairs: readonly (readonly [string, Child])[]): HTMLElement {
  const dl = el('dl', { class: 'c-facts' });
  for (const [term, value] of pairs) {
    dl.appendChild(el('dt', {}, term));
    const dd = el('dd', {});
    append(dd, [value]);
    dl.appendChild(dd);
  }
  return dl;
}

export function stat(label: string, value: string, sub?: string): HTMLElement {
  return el('div', { class: 'c-card' },
    el('h3', {}, label),
    el('div', { class: 'c-stat' }, value),
    sub ? el('p', { class: 'c-stat-sub' }, sub) : null,
  );
}

export function emptyState(title: string, body: string, action?: HTMLElement): HTMLElement {
  return el('div', { class: 'c-empty' },
    el('b', {}, title),
    el('p', { style: 'margin:0 0 10px;max-width:56ch;display:inline-block' }, body),
    action ?? null,
  );
}

/**
 * A bar sparkline as inline SVG, labelled as an image with its own summary.
 * The table beneath it carries the numbers; this is the shape, not the data.
 */
export function sparkline(points: readonly { date: string; sessions: number }[], label: string): HTMLElement {
  if (points.length === 0) return el('p', { class: 'c-hint' }, 'No sessions yet.');
  const max = Math.max(...points.map((p) => p.sessions), 1);
  const w = 100;
  const h = 30;
  const barW = w / points.length;
  const ns = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(ns, 'svg');
  node.setAttribute('class', 'c-spark');
  node.setAttribute('viewBox', `0 0 ${w} ${h}`);
  node.setAttribute('preserveAspectRatio', 'none');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', label);
  points.forEach((p, i) => {
    const barH = (p.sessions / max) * h;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(i * barW + barW * 0.15));
    rect.setAttribute('y', String(h - barH));
    rect.setAttribute('width', String(barW * 0.7));
    rect.setAttribute('height', String(Math.max(barH, p.sessions > 0 ? 0.6 : 0)));
    node.appendChild(rect);
  });
  return node as unknown as HTMLElement;
}
