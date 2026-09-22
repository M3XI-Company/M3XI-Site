/**
 * #/ — the front of the creator studio.
 *
 * Two audiences on one page. Everyone learns how cards and posters are made
 * and is sent to the app. Premium members sign in here with a code from their
 * phone and carry on to the editor.
 *
 * No prices, no balances and no buy links anywhere (G-PAY 4 and 5, Apple
 * 3.1.3). "Comes with CallMe Premium, in the app" is the whole of it.
 */

import { el } from './dom';
import { mountSignIn, onChange } from './pair';

export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.m3xi.callme';

export function openAppRow(deepLink: string, label: string): HTMLElement {
  return el('div', { class: 'actions' }, [
    el('a', { class: 'btn rose big', href: deepLink, text: label }),
    el('a', { class: 'btn', href: PLAY_URL, rel: 'noopener', text: 'Get CallMe' }),
  ]);
}

function step(n: string, title: string, words: string, more?: { href: string; text: string }): HTMLElement {
  return el('li', { class: 'step' }, [
    el('span', { class: 'stepno', 'aria-hidden': 'true', text: n }),
    el('div', {}, [
      el('h3', { text: title }),
      el('p', { text: words }),
      more ? el('p', {}, [el('a', { href: more.href, text: more.text })]) : null,
    ]),
  ]);
}

export function landing(host: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];

  host.appendChild(el('section', { class: 'intro' }, [
    el('p', { class: 'eyebrow', text: 'CallMe creator studio' }),
    el('h1', {}, [document.createTextNode('Make your own '), el('em', { text: 'cards and posters.' })]),
    el('p', { class: 'lede', text: 'A MeCard is what people see when they meet you on CallMe. A poster is the wall behind you. Both are yours to make — and a card you design can be given to the people you talk to.' }),
  ]));

  /* ── Everyone: how it works ──────────────────────────────────── */
  host.appendChild(el('section', { class: 'band-sheet' }, [
    el('h2', { text: 'How it works' }),
    el('ol', { class: 'steps' }, [
      // The `#/poster` route was built and nothing linked to it, so the one
      // page that explains what happens to a poster could only be reached by
      // typing the hash. It is linked from the step it belongs to.
      step('1', 'Posters are made in the app', 'Open CallMe and go to Settings, then My poster. Choose a paper, put your photos and words on it, and put it up. Everything is drawn on the phone, so you see it exactly as your visitors will.',
        { href: '#/poster', text: 'More about posters ›' }),
      step('2', 'Cards are made in the app too', 'Go to Settings, then My poster, then Edit my cards. Pick a paper, add your stickers and your words, and the card is yours. It is the card people see when you match.'),
      step('3', 'Your designs live in your collection', 'Everything you make sits in your collection in the app, next to the cards you have earned. That is where a design becomes something you can give.'),
      step('4', 'Give a copy to someone you have talked to', 'Open your collection, choose a design and give a copy to a person you met on a call. Each design is an edition of twenty copies, and once the twenty are out, that is the whole edition.'),
    ]),
    openAppRow('callme://poster', 'Open CallMe'),
    el('p', { class: 'muted', text: 'Not got the app yet? CallMe is on Android now.' }),
  ]));

  /* ── The studio itself ───────────────────────────────────────── */
  const studio = el('section', { class: 'band-sheet' });
  studio.appendChild(el('h2', { text: 'The creator studio, on a big screen' }));
  studio.appendChild(el('p', { text: 'Premium members can design card art here instead: bring a picture you made yourself, or build one out of the four papers and the stickers. Mouse precision, arrow-key nudging and a proper preview of what a person will hold.' }));
  studio.appendChild(el('ul', { class: 'plainlist' }, [
    el('li', { text: 'Start from your own art, or compose one here.' }),
    el('li', { text: 'Set where the wearer’s photo sits on your card.' }),
    el('li', { text: 'Send it for checking. When it passes, it appears in your collection in the app.' }),
    el('li', { text: 'Give copies from your collection — up to twenty per design.' }),
  ]));

  const gate = el('div', { class: 'gate' });
  studio.appendChild(gate);
  host.appendChild(studio);

  /* ── Sign in ─────────────────────────────────────────────────── */
  const signIn = el('section', { class: 'letter wide', id: 'signin' }, [
    el('span', { class: 'tape', 'aria-hidden': 'true' }),
    el('span', { class: 'seal', 'aria-hidden': 'true' }),
    el('h2', { text: 'Sign in with your phone' }),
  ]);
  host.appendChild(signIn);
  cleanups.push(mountSignIn(signIn));

  cleanups.push(onChange((s) => {
    gate.textContent = '';
    if (s.phase === 'signed_in') {
      gate.appendChild(el('div', { class: 'actions' }, [
        el('a', { class: 'btn rose big', href: '#/cards', text: 'Design a card' }),
        el('a', { class: 'btn', href: '#/library', text: 'My designs' }),
      ]));
    } else {
      gate.appendChild(el('p', { class: 'chip', text: 'Creator studio comes with CallMe Premium, in the app.' }));
    }
  }));

  /* ── Collection and giving ───────────────────────────────────── */
  host.appendChild(el('section', { class: 'band-sheet' }, [
    el('h2', { text: 'From here to your collection' }),
    el('p', { text: 'A design you finish here is checked, and then it lands in your collection in the app, in with the cards you have earned. Giving happens there, on the phone, with the people you have actually spoken to — that is the part this website deliberately cannot do.' }),
    el('p', { class: 'muted', text: 'Copies belong to the person who received them. They are not for sale and they cannot be passed on.' }),
    // Straight to "My designs" — the section above is about what happens to a
    // design you made, so the general shelf is the wrong page to land on.
    openAppRow('callme://collection/mine', 'Open my collection'),
  ]));

  /* ── On a phone ──────────────────────────────────────────────── */
  host.appendChild(el('section', { class: 'note' }, [
    el('b', { text: 'On a phone?' }),
    document.createTextNode(' Posters and cards are easiest on a computer here, but you do not need this page at all: edit them right in CallMe. '),
    el('a', { href: 'callme://poster', text: 'Open CallMe' }),
    document.createTextNode('.'),
  ]));

  return () => cleanups.forEach((f) => f());
}
