/**
 * The application chrome: navigation, org identity, theme, and the frame every
 * page renders into.
 *
 * Landmarks are real (`<nav>`, `<main>`, `<header>`), the skip link goes to the
 * main region, and a route change moves focus to the new page's heading. That
 * last one is the difference between a single-page app that works with a
 * screen reader and one that silently strands the user at the bottom of the
 * page they thought they had left.
 */

import {
  announce, applyTheme, currentTheme, el, focusHeading, navigationFor, note, pill,
  type MemberRole, type Membership, type ThemeChoice,
} from '@m3xi/console-ui';
import { go } from './router.js';

export interface PageFrame {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  readonly body: HTMLElement;
  readonly actions: HTMLElement;
}

export interface ShellHandles {
  readonly root: HTMLElement;
  readonly main: HTMLElement;
  setActive(routeName: string): void;
}

export function buildShell(options: {
  readonly membership: Membership;
  readonly email: string;
  readonly isFixture: boolean;
  readonly onSignOut: () => void;
}): ShellHandles {
  const { membership, email } = options;
  const role: MemberRole = membership.role;

  const nav = el('nav', { class: 'c-nav', 'aria-label': 'Console sections' });
  const links = new Map<string, HTMLAnchorElement>();
  for (const entry of navigationFor(role)) {
    if (!entry.visible) continue;
    const link = el('a', { href: entry.href }, entry.label);
    links.set(entry.id, link);
    nav.appendChild(link);
  }
  // The permanence bundle is the loudest thing this product does differently,
  // so it is a top-level destination rather than a menu item inside a world.
  const permanence = el('a', { href: '#/permanence' }, 'Permanence');
  links.set('permanence', permanence);
  nav.appendChild(permanence);

  const theme = el('select', {
    class: 'c-select',
    'aria-label': 'Colour theme',
    style: 'font-size:12px;min-height:28px;padding:2px 6px',
    onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value as ThemeChoice;
      applyTheme(value);
      announce(`Theme set to ${value}.`);
    },
  },
  el('option', { value: 'system' }, 'System theme'),
  el('option', { value: 'light' }, 'Light'),
  el('option', { value: 'dark' }, 'Dark'),
  );
  theme.value = currentTheme();

  const side = el('aside', { class: 'c-side' },
    el('div', { class: 'c-brand' }, el('b', {}, 'M3XI'), el('span', {}, 'World Viewer')),
    nav,
    el('div', { class: 'c-side-foot' },
      el('dl', {},
        el('dt', {}, 'Organisation'), el('dd', {}, membership.org.name),
        el('dt', {}, 'Signed in'), el('dd', { style: 'word-break:break-all' }, email),
        el('dt', {}, 'Role'), el('dd', {}, pill(role, role === 'viewer' ? 'muted' : 'info')),
      ),
      theme,
      el('button', {
        class: 'c-btn c-btn--quiet c-btn--small',
        type: 'button',
        style: 'margin-top:8px',
        onclick: () => options.onSignOut(),
      }, 'Sign out'),
    ),
  );

  const main = el('main', { class: 'c-main', id: 'main', tabindex: '-1' });
  const root = el('div', { class: 'c-app' }, side, main);

  if (options.isFixture) {
    main.appendChild(el('div', { style: 'padding:14px 24px 0' },
      note('warn', 'Demonstration data',
        'No Supabase project is configured for this build, so every number on every page comes from the declared fixture portfolio in apps/console/src/api/fixture.ts. Nothing here is a real property, a real lead or a real charge.'),
    ));
  }

  return {
    root,
    main,
    setActive(routeName: string): void {
      for (const [id, link] of links) {
        if (id === routeName) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
  };
}

/**
 * The standard page frame: breadcrumbs, an h1, a lede, a right-aligned action
 * cluster and a body. Returning the pieces rather than a blob is what lets a
 * page fill them asynchronously without rebuilding its own header.
 */
export function pageFrame(options: {
  readonly title: string;
  readonly lede?: string;
  readonly crumbs?: readonly { readonly label: string; readonly href?: string }[];
}): PageFrame {
  const heading = el('h1', {}, options.title);
  const actions = el('div', { class: 'c-head-actions' });

  const crumbs = el('p', { class: 'c-crumbs' });
  if (options.crumbs && options.crumbs.length > 0) {
    options.crumbs.forEach((crumb, i) => {
      if (i > 0) crumbs.appendChild(document.createTextNode(' / '));
      crumbs.appendChild(crumb.href
        ? el('a', {
          href: crumb.href,
          onclick: (e: Event) => { e.preventDefault(); go(crumb.href!); },
        }, crumb.label)
        : document.createTextNode(crumb.label));
    });
  }

  const head = el('header', { class: 'c-head' },
    el('div', { style: 'min-width:0' },
      options.crumbs && options.crumbs.length > 0 ? crumbs : null,
      heading,
      options.lede ? el('p', {}, options.lede) : null,
    ),
    actions,
  );

  const body = el('div', { class: 'c-body' });
  const root = el('div', {}, head, body);
  return { root, heading, body, actions };
}

export function announceRoute(frame: PageFrame): void {
  focusHeading(frame.heading);
}

export function section(title: string, lede?: string, ...children: (Node | null)[]): HTMLElement {
  const node = el('section', { class: 'c-section' }, el('h2', {}, title));
  if (lede) node.appendChild(el('p', { class: 'c-lede' }, lede));
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

export function loading(what: string): HTMLElement {
  return el('p', { class: 'c-hint', role: 'status' }, `Loading ${what}…`);
}

export function errorPanel(err: unknown): HTMLElement {
  const message = err instanceof Error ? err.message : String(err);
  return note('bad', 'That did not work', message);
}
