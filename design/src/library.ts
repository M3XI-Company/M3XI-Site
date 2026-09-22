/**
 * #/library — every design this creator has, and where each one has got to.
 *
 * The website never carries a refusal's words. A refused design says only
 * "Can't be used — your phone says why", because the reason, the evidence and
 * the appeal all live in the app, where the person is actually signed in.
 */

import * as api from './api';
import type { Design } from './api';
import { EDITION_MAX } from './cardgeom';
import { cardTwin } from './card';
import { el, letter, toast, clear } from './dom';
import { current, onChange, sessionGoneLetter } from './pair';
import { stateWords } from './cards';

function countsLine(d: Design): string {
  const c = d.counts;
  const cap = (c && c.editionMax) || d.editionMax || EDITION_MAX;
  if (!c) return 'An edition of ' + cap + '.';
  const bits: string[] = [c.given + ' of ' + cap + ' given'];
  if (c.earned) bits.push(c.earned + ' earned');
  const waiting = (c.givenWaiting || 0) + (c.earnedWaiting || 0);
  if (waiting) bits.push(waiting + ' waiting to be kept');
  bits.push(Math.max(0, cap - c.issued) + ' left');
  return bits.join(' · ');
}

export function libraryView(host: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];
  const root = el('div');
  host.appendChild(root);

  cleanups.push(onChange((s) => {
    if (s.phase === 'signed_in') return;
    clear(root);
    root.appendChild(el('section', { class: 'letter wide' }, [
      el('span', { class: 'seal', 'aria-hidden': 'true' }),
      el('h2', { text: 'Sign in with your phone first' }),
      el('p', { text: 'Your designs are on your account, so the studio needs to know which account that is. Open CallMe, go to Settings, then Creator studio, and scan the code on the front page.' }),
      el('div', { class: 'actions' }, [el('a', { class: 'btn rose', href: '#/', text: 'Go to the code' })]),
    ]));
  }));

  const signedIn = current();
  if (!signedIn) return () => cleanups.forEach((f) => f());
  // Declared non-null, not merely narrowed: `load` and `card` below are hoisted
  // function declarations, and a hoisted function does not inherit a narrowing
  // made after it. Without this the calls inside them would pass `Session|null`
  // and a signed-out reload would send a request with no session at all.
  const session: api.Session = signedIn;

  clear(root);
  const head = el('section', { class: 'intro' }, [
    el('p', { class: 'eyebrow', text: 'Your designs' }),
    el('h1', {}, [document.createTextNode('Everything you have '), el('em', { text: 'made.' })]),
    el('p', { class: 'lede', text: 'Once a design is ready it sits in your collection in the app, and that is where you give copies to the people you have talked to.' }),
    el('div', { class: 'actions' }, [
      el('a', { class: 'btn rose big', href: '#/cards', text: 'Start a new card' }),
      el('a', { class: 'btn', href: 'callme://collection/mine', text: 'See it in your collection' }),
    ]),
  ]);
  root.appendChild(head);

  const state = el('div', { class: 'state', role: 'status', 'aria-live': 'polite', text: 'Finding your designs…' });
  const list = el('div', { class: 'list' });
  list.hidden = true;
  root.appendChild(state);
  root.appendChild(list);

  async function load(): Promise<void> {
    try {
      const rows = await api.designsList(session);
      clear(list);
      if (!rows.length) {
        state.hidden = false;
        list.hidden = true;
        state.textContent = 'Nothing yet. Start a card and it will appear here.';
        return;
      }
      state.hidden = true;
      list.hidden = false;
      rows.forEach((d) => list.appendChild(card(d)));
    } catch (e) {
      if (e instanceof api.ApiError && (e.reason === 'unknown' || e.reason === 'closed')) sessionGoneLetter();
      state.hidden = false;
      state.textContent = api.say(e);
    }
  }

  function card(d: Design): HTMLElement {
    const twin = cardTwin();
    twin.setBand(d.band);
    if (d.win.length === 4) twin.setWindow({ x: d.win[0], y: d.win[1], w: d.win[2], h: d.win[3] });
    twin.setTitle(d.title);
    twin.setEdition(1, (d.counts && d.counts.editionMax) || d.editionMax || EDITION_MAX);
    if (d.art) twin.setArt(api.artUrl(d.art));

    const editable = d.state === 'draft' || d.state === 'refused';
    const actions: (Node | null)[] = [];
    if (editable) actions.push(el('a', { class: 'btn rose', href: '#/cards/' + d.id, text: 'Carry on with it' }));
    if (d.state === 'ready' || d.state === 'live') {
      actions.push(el('a', { class: 'btn rose', href: 'callme://collection/mine', text: 'See it in your collection' }));
    }
    /*
     * "Start a new design from this one", never "Make a copy of it".
     *
     * Everywhere else in the product a COPY is one of the twenty in the
     * edition — the app's button is literally "Give a copy" — and this button
     * sat directly under a line reading "7 of 20 given · 3 left". It makes a
     * new draft. It is also off for a design our team took down, which should
     * not offer a one-tap way to make it again, and for one that was refused.
     */
    if (d.state !== 'removed' && d.state !== 'refused') {
      actions.push(el('button', {
        class: 'btn', type: 'button', text: 'Start a new design from this one',
        onclick: async () => {
          try {
            const made = await api.designDuplicate(session, d.id);
            toast('Started. It is a new draft you can change.');
            if (made.id) location.hash = '#/cards/' + made.id;
            else void load();
          } catch (e) { toast(api.say(e)); }
        },
      }));
    }
    if (d.state === 'draft') {
      actions.push(el('button', {
        class: 'btn', type: 'button', text: 'Throw it away',
        onclick: () => {
          letter({
            title: 'Throw this design away?',
            body: 'It has not been given to anyone, so nothing is lost but the work. It goes off your shelf straight '
              + 'away; if you throw one away by mistake, write to us within a month and we can put it back.',
            actions: [
              { label: 'Keep it' },
              {
                label: 'Throw it away', rose: true, onPick: async () => {
                  try { await api.designDelete(session, d.id); toast('Gone.'); void load(); }
                  catch (e) { toast(api.say(e)); }
                },
              },
            ],
          });
        },
      }));
    }

    const words = stateWords(d.state);
    return el('article', { class: 'design' }, [
      el('div', { class: 'thumb' }, [twin.root]),
      el('div', { class: 'about' }, [
        el('div', { class: 'row' }, [
          el('h2', { text: d.title || 'Untitled' }),
          el('span', { class: 'chip ' + chipClass(d.state), text: words }),
          d.paused ? el('span', { class: 'chip warn', text: 'Paused' }) : null,
        ]),
        d.line ? el('p', { class: 'muted', text: d.line }) : null,
        el('p', { class: 'counts', text: countsLine(d) }),
        d.state === 'refused'
          ? el('p', { class: 'muted small', text: 'Open CallMe to read what was wrong and to send it again.' })
          : null,
        d.state === 'checking' || d.state === 'awaiting_review'
          ? el('p', { class: 'muted small', text: 'Nothing to do — we will have it looked at. Your phone tells you when it is through.' })
          : null,
        el('div', { class: 'actions' }, actions),
      ]),
    ]);
  }

  void load();
  return () => { cleanups.forEach((f) => f()); root.remove(); };
}

function chipClass(state: Design['state']): string {
  if (state === 'ready' || state === 'live') return 'good';
  if (state === 'refused' || state === 'removed') return 'warn';
  if (state === 'checking' || state === 'awaiting_review') return 'wait';
  return '';
}
