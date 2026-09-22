/**
 * m3xi.com/design — the router and the shell.
 *
 * One page, hash routes, no framework and no inline script (the path ships
 * under `script-src 'self'`). Each view owns everything it builds and hands
 * back a teardown, so switching routes cannot leave a timer or a poll running.
 */

import { el, clear } from './dom';
import { landing } from './landing';
import { cardsView } from './cards';
import { libraryView } from './library';
import { onChange, resume, signOut } from './pair';

const view = document.getElementById('view') as HTMLElement;
const tabs = document.getElementById('tabs') as HTMLElement;
const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

let teardown: (() => void) | null = null;
let firstPaint = true;

type Route = { name: 'home' | 'cards' | 'library' | 'poster'; arg: string };

function parse(): Route {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const head = (parts[0] || '').toLowerCase();
  if (head === 'cards') return { name: 'cards', arg: parts[1] || '' };
  if (head === 'library') return { name: 'library', arg: '' };
  if (head === 'poster' || head === 'posters') return { name: 'poster', arg: '' };
  return { name: 'home', arg: '' };
}

function posterView(host: HTMLElement): () => void {
  const box = el('section', { class: 'letter wide' }, [
    el('span', { class: 'tape', 'aria-hidden': 'true' }),
    el('span', { class: 'seal', 'aria-hidden': 'true' }),
    // h1: this is a page of its own, and it was the only route with no top
    // heading. The landing page links to it from the posters step.
    el('h1', { text: 'Posters are made in the app' }),
    el('p', { text: 'Your poster is the wall behind you on a call, and it is built on the phone: Settings, then My poster. Choose a paper, put your photos and words where you want them, and put it up.' }),
    el('div', { class: 'actions' }, [
      el('a', { class: 'btn rose', href: 'callme://poster', text: 'Open CallMe' }),
      el('a', { class: 'btn', href: '#/', text: 'Back to the studio' }),
    ]),
  ]);
  host.appendChild(box);
  return () => box.remove();
}

/** One page, four routes: the title has to say which one you are on. */
const TITLES: Record<Route['name'], string> = {
  home: 'Make your own cards — CallMe by M3XI',
  cards: 'Design a card — CallMe by M3XI',
  library: 'My designs — CallMe by M3XI',
  poster: 'Posters — CallMe by M3XI',
};

function render(): void {
  if (teardown) { teardown(); teardown = null; }
  clear(view);
  window.scrollTo({ top: 0 });
  const route = parse();
  markTabs(route.name);
  document.title = TITLES[route.name];
  if (route.name === 'cards') teardown = cardsView(view, route.arg);
  else if (route.name === 'library') teardown = libraryView(view);
  else if (route.name === 'poster') teardown = posterView(view);
  else teardown = landing(view);
  /*
   * A hash route change replaces everything inside #view and nothing else: the
   * title used to stay put, focus stayed on the tab link, and a screen-reader
   * user had no way to know the page had changed or what it now was. Moving
   * focus to the new view's own heading announces both.
   */
  const head = view.querySelector('h1, h2') as HTMLElement | null;
  if (head) {
    head.setAttribute('tabindex', '-1');
    // Not on the first paint: arriving at a page should leave the cursor where
    // the browser put it. Only a route change inside the page needs announcing.
    if (!firstPaint) {
      try { head.focus({ preventScroll: true }); } catch { head.focus(); }
    }
  }
  firstPaint = false;
}

function markTabs(name: Route['name']): void {
  Array.prototype.forEach.call(tabs.querySelectorAll('a[data-route]'), (a: Element) => {
    const on = (a as HTMLElement).dataset.route === name;
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* The studio tabs only appear once the phone has said yes. */
onChange((s) => {
  const inside = s.phase === 'signed_in';
  tabs.hidden = !inside;
  const out = document.getElementById('signout') as HTMLButtonElement | null;
  if (out) out.hidden = !inside;
  const who = document.getElementById('who');
  if (who) who.textContent = inside && s.name ? s.name : '';
  // The editors show their own "sign in first" letter when a session goes, so
  // nothing re-routes here: re-entering render() from inside a change
  // notification would tear down the very listener that is being called.
});

const out = document.getElementById('signout');
if (out) out.addEventListener('click', () => { void signOut(); location.hash = '#/'; });

// The hash is not a full page load, so a link to `#/cards` from `#/library`
// fires hashchange and nothing else. Both are handled by `render`.

window.addEventListener('hashchange', render);
resume();
render();
