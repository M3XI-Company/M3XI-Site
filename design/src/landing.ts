/**
 * #/ — the front of the creator studio.
 *
 * Two audiences on one page. Everyone learns how cards and posters are made
 * and is sent to the app. Premium members sign in here with a code from their
 * phone and carry on to the editor.
 *
 * The first screen says plainly what happens, in the order it happens: open
 * CallMe, go to My poster, tap Sign in on a computer, scan the square on this
 * page. Those three are drawn as numbered paper cards, with the sign-in letter
 * straight underneath, so nobody has to scroll past the explanations to find
 * the square. (Phase 5, 24 Sep 2026. The scanner sits under the poster on
 * PosterScreen, and also on the collection's My designs tab.)
 *
 * No prices, no balances and no buy links anywhere (G-PAY 4 and 5, Apple
 * 3.1.3). "Comes with CallMe Premium, in the app" is the whole of it.
 */

import { el, svg } from './dom';
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

/* ── The three steps, drawn ─────────────────────────────────────────────
 * Small ink doodles, one per card. Built with createElementNS (no innerHTML
 * anywhere in the studio) and hidden from screen readers: the card's own
 * heading and sentence say everything the picture does. */

const INK = '#19150F';
const ROSE = '#B7566B';
const STOCK = '#FFFDF8';
const BLUSH = '#F3DEDF';

function phoneOutline(): SVGElement[] {
  return [
    svg('rect', { x: 18, y: 5, width: 28, height: 54, rx: 6, fill: STOCK, stroke: INK, 'stroke-width': 2 }),
    svg('path', { d: 'M28 10h8', stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
  ];
}

function artPoster(): SVGElement {
  return svg('svg', { class: 'howart', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' }, [
    ...phoneOutline(),
    svg('rect', { x: 23, y: 16, width: 18, height: 26, rx: 1.5, fill: BLUSH, stroke: INK, 'stroke-width': 1.4, transform: 'rotate(-4 32 29)' }),
    svg('circle', { cx: 32, cy: 17, r: 2.2, fill: ROSE }),
    svg('path', { d: 'M26.5 29h11M26.5 33h7', stroke: INK, 'stroke-width': 1.2, 'stroke-linecap': 'round', transform: 'rotate(-4 32 29)' }),
    svg('path', { d: 'M27 50h10', stroke: INK, 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: 0.5 }),
  ]);
}

function artSignIn(): SVGElement {
  return svg('svg', { class: 'howart', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' }, [
    ...phoneOutline(),
    svg('path', { d: 'M23 17h18', stroke: INK, 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: 0.55 }),
    svg('rect', { x: 24, y: 22, width: 16, height: 16, rx: 2, fill: 'none', stroke: INK, 'stroke-width': 1.5 }),
    svg('path', { d: 'M29 25v10M35 25v10M26.5 28h11M26.5 32h11', stroke: INK, 'stroke-width': 1.1, 'stroke-linecap': 'round' }),
    svg('circle', { cx: 39, cy: 40, r: 7.5, fill: 'none', stroke: ROSE, 'stroke-width': 1.3, opacity: 0.55 }),
    svg('circle', { cx: 39, cy: 40, r: 3.4, fill: ROSE }),
  ]);
}

function artScan(): SVGElement {
  return svg('svg', { class: 'howart', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' }, [
    svg('rect', { x: 5, y: 13, width: 30, height: 30, rx: 2, fill: STOCK, stroke: INK, 'stroke-width': 2 }),
    svg('rect', { x: 9, y: 17, width: 7, height: 7, fill: INK }),
    svg('rect', { x: 24, y: 17, width: 7, height: 7, fill: INK }),
    svg('rect', { x: 9, y: 32, width: 7, height: 7, fill: INK }),
    svg('rect', { x: 20, y: 27, width: 3, height: 3, fill: INK }),
    svg('rect', { x: 25, y: 31, width: 3, height: 3, fill: INK }),
    svg('rect', { x: 20, y: 35, width: 3, height: 3, fill: INK }),
    svg('rect', { x: 28, y: 36, width: 3, height: 3, fill: INK }),
    svg('path', { d: 'M44 30L36 26M44 36L36 40', stroke: ROSE, 'stroke-width': 1.4, 'stroke-dasharray': '2 3', 'stroke-linecap': 'round' }),
    svg('rect', { x: 44, y: 17, width: 15, height: 30, rx: 4, fill: STOCK, stroke: INK, 'stroke-width': 2 }),
    svg('circle', { cx: 51.5, cy: 22, r: 1.6, fill: INK }),
  ]);
}

function howCard(n: string, title: string, words: string, art: SVGElement): HTMLElement {
  return el('li', { class: 'howcard' }, [
    el('span', { class: 'tape', 'aria-hidden': 'true' }),
    el('span', { class: 'hownum', 'aria-hidden': 'true', text: n }),
    art,
    el('h3', {}, [el('span', { class: 'visually-hidden', text: 'Step ' + n + ': ' }), title]),
    el('p', { text: words }),
  ]);
}

export function landing(host: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];

  host.appendChild(el('section', { class: 'intro' }, [
    el('p', { class: 'eyebrow', text: 'CallMe creator studio' }),
    el('h1', {}, [document.createTextNode('Design it here, '), el('em', { text: 'wear it on your card.' })]),
    el('p', { class: 'lede', text: 'Premium members design card art on a computer. Your phone signs this page in, with no password, and a finished design lands in your CallMe collection, ready to wear on your card or to give.' }),
  ]));

  /* ── The first screen: three steps, then the square ──────────── */
  host.appendChild(el('section', { class: 'howsteps', 'aria-labelledby': 'howsteps-h' }, [
    el('h2', { id: 'howsteps-h', text: 'Three steps to sign in' }),
    el('ol', { class: 'howto' }, [
      howCard('1', 'Open CallMe, then My poster',
        'On your phone, open CallMe and go to Settings, then My poster.', artPoster()),
      howCard('2', 'Tap Sign in on a computer',
        'It sits just under your poster. Tap the square there and your camera opens.', artSignIn()),
      howCard('3', 'Scan the square on this page',
        'Press Show me a code below, point your phone at the square, then pick the number printed beside it.', artScan()),
    ]),
  ]));

  /* ── Sign in ─────────────────────────────────────────────────── */
  const signIn = el('section', { class: 'letter wide', id: 'signin' }, [
    el('span', { class: 'tape', 'aria-hidden': 'true' }),
    el('span', { class: 'seal', 'aria-hidden': 'true' }),
    el('h2', { text: 'Sign in with your phone' }),
  ]);
  host.appendChild(signIn);
  cleanups.push(mountSignIn(signIn));

  /* ── From here to your card ──────────────────────────────────── */
  const gate = el('div', { class: 'gate' });
  host.appendChild(el('section', { class: 'band-sheet' }, [
    el('h2', { text: 'From here to your card' }),
    el('p', { text: 'Design the card here. A person on our team reads every design, and when it passes it lands in your collection in the app, under My designs. Tap Wear it to put it on your card, or give copies to people you have met on a call. Giving happens there, on the phone, with the people you have actually spoken to — that is the part this website deliberately cannot do.' }),
    el('p', { class: 'muted', text: 'Copies belong to the person who received them. They are not for sale and they cannot be passed on.' }),
    gate,
    // Straight to "My designs" — this section is about what happens to a
    // design you made, so the general shelf is the wrong page to land on.
    openAppRow('callme://collection/mine', 'Open my collection'),
  ]));

  cleanups.push(onChange((s) => {
    gate.textContent = '';
    if (s.phase === 'signed_in') {
      gate.appendChild(el('div', { class: 'actions' }, [
        el('a', { class: 'btn rose big', href: '#/cards', text: 'Design a card' }),
        el('a', { class: 'btn', href: '#/library', text: 'My designs' }),
      ]));
    } else {
      gate.appendChild(el('p', { class: 'chip', text: 'The creator studio comes with CallMe Premium, in the app.' }));
    }
  }));

  /* ── The studio itself ───────────────────────────────────────── */
  host.appendChild(el('section', { class: 'band-sheet' }, [
    el('h2', { text: 'The creator studio, on a big screen' }),
    el('p', { text: 'Bring a picture you made yourself, or build one out of the four papers and the stickers. Mouse precision, arrow-key nudging and a proper preview of what a person will hold.' }),
    el('ul', { class: 'plainlist' }, [
      el('li', { text: 'Start from your own art, or compose one here.' }),
      el('li', { text: 'Set where the wearer’s photo sits on your card.' }),
      el('li', { text: 'Send it for checking. When it passes, it appears in your collection in the app.' }),
      el('li', { text: 'Give copies from your collection — up to twenty per design.' }),
    ]),
  ]));

  /* ── Everyone: cards and posters in the app ──────────────────── */
  host.appendChild(el('section', { class: 'band-sheet' }, [
    el('h2', { text: 'Cards and posters, in the app' }),
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

  /* ── On a phone ──────────────────────────────────────────────── */
  host.appendChild(el('section', { class: 'note' }, [
    el('b', { text: 'On a phone?' }),
    document.createTextNode(' Posters and cards are easiest on a computer here, but you do not need this page at all: edit them right in CallMe. '),
    el('a', { href: 'callme://poster', text: 'Open CallMe' }),
    document.createTextNode('.'),
  ]));

  return () => cleanups.forEach((f) => f());
}
