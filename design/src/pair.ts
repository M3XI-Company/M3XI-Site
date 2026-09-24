/**
 * Signing in without a password.
 *
 * Only the phone is signed in (POSTER §2.5). The browser shows a code, the
 * phone scans it, and what the browser ends up holding is a scoped session id
 * and a one-off secret — no account token, nothing that survives the tab.
 *
 * The secret lives in sessionStorage, not localStorage: it dies with the tab,
 * it is never shared with another tab of the same site, and a person who walks
 * away from a library computer leaves nothing behind once the window closes.
 */

import * as api from './api';
import type { Session, StatusResult } from './api';
import { el, letter, toast, fmtTime, clear } from './dom';
import { qrSvg } from './qr';

const KEY = 'm3xi.design.session';
const POLL_MS = 2500;
const CODE_REFRESH_LEAD_MS = 15000;
/** Ten characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (0093). */
const CODE_SHAPE = /^[A-Z2-9]{10}$/;

export type Phase = 'signed_out' | 'waiting' | 'claimed' | 'signed_in' | 'ended';

export type Snapshot = {
  phase: Phase;
  session: Session | null;
  name: string;
  photo: string;
  endedWhy: string;
  problem: string;
  code: string;
  matchCode: string;
};

let session: Session | null = null;
let last: StatusResult | null = null;
let phase: Phase = 'signed_out';
let endedWhy = '';
let problem = '';
let code = '';
let matchCode = '';
let codeExpiresAt = 0;
let pollTimer = 0;
let refreshing = false;

const listeners: ((s: Snapshot) => void)[] = [];

function snapshot(): Snapshot {
  return {
    phase,
    session,
    name: last?.name || '',
    photo: last?.photo || '',
    endedWhy,
    problem,
    code,
    matchCode,
  };
}

/**
 * The poll runs every couple of seconds. Redrawing the panel on every one of
 * them would snatch the "That's me" button out from under a finger that was
 * already on its way to it, so nothing is announced unless something changed.
 * The burning strip has its own timer and is not part of this.
 */
let lastSent = '';

function emit(force?: boolean): void {
  const s = snapshot();
  const fingerprint = JSON.stringify([s.phase, s.name, s.photo, s.endedWhy, s.problem, s.code, s.matchCode]);
  if (!force && fingerprint === lastSent) return;
  lastSent = fingerprint;
  // A copy: a listener is free to unsubscribe itself (a view being torn down
  // does exactly that), and splicing the live array mid-walk skips the next one.
  listeners.slice().forEach((f) => f(s));
}

export function onChange(f: (s: Snapshot) => void): () => void {
  listeners.push(f);
  f(snapshot());
  return () => {
    const i = listeners.indexOf(f);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function current(): Session | null {
  return phase === 'signed_in' ? session : null;
}

export function displayName(): string {
  return last?.name || '';
}

function store(s: Session | null): void {
  session = s;
  try {
    if (s) window.sessionStorage.setItem(KEY, JSON.stringify(s));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* private windows refuse; the session simply will not survive a reload */
  }
}

function restore(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Session;
    if (v && typeof v.id === 'string' && typeof v.secret === 'string') {
      return { id: v.id, secret: v.secret, scope: v.scope === 'poster' ? 'poster' : 'creator' };
    }
  } catch {
    /* nothing kept */
  }
  return null;
}

function stopPolling(): void {
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = 0;
}

/**
 * How many polls in a row have failed. A studio left open on a desk with no
 * connection would otherwise knock on the door every two and a half seconds
 * all night, so the wait backs off to half a minute and comes straight back
 * to normal on the first answer.
 */
let misses = 0;

function schedule(): void {
  stopPolling();
  const wait = Math.min(30000, POLL_MS * Math.pow(2, Math.min(misses, 4)));
  pollTimer = window.setTimeout(tick, wait);
}

async function tick(): Promise<void> {
  if (!session) return;
  try {
    const s = await api.status(session);
    last = s;
    misses = 0;
    problem = '';
    if (s.matchCode) matchCode = s.matchCode;
    if (s.state === 'open') {
      phase = 'waiting';
      // No code in hand happens after a reload: sessionStorage keeps the
      // session, never the printed code, because the code is the thing that
      // must not be reusable. Ask for a fresh one rather than drawing an
      // empty square.
      const stale = !CODE_SHAPE.test(code)
        || (codeExpiresAt > 0 && codeExpiresAt - Date.now() <= CODE_REFRESH_LEAD_MS);
      if (stale && !refreshing) void refreshCode();
    } else if (s.state === 'claimed') {
      phase = 'claimed';
    } else if (s.state === 'confirmed') {
      phase = 'signed_in';
    } else {
      phase = 'ended';
      endedWhy = s.endedWhy;
      store(null);
    }
  } catch (e) {
    if (e instanceof api.ApiError && (e.reason === 'unknown' || e.reason === 'closed')) {
      phase = 'ended';
      endedWhy = endedWhy || 'gone';
      store(null);
    } else {
      misses++;
      problem = api.say(e);
    }
  }
  emit();
  if (phase === 'waiting' || phase === 'claimed' || phase === 'signed_in') schedule();
}

async function refreshCode(): Promise<void> {
  if (!session || refreshing) return;
  refreshing = true;
  try {
    const r = await api.newCode(session);
    store({ id: r.id, secret: r.secret, scope: session.scope });
    code = r.code;
    matchCode = r.matchCode || matchCode;
    codeExpiresAt = r.codeExpiresAt;
    emit();
  } catch (e) {
    misses++;
    problem = api.say(e);
    emit();
  } finally {
    refreshing = false;
  }
}

export async function start(): Promise<void> {
  problem = '';
  endedWhy = '';
  last = null;
  misses = 0;
  try {
    const r = await api.open('creator');
    store({ id: r.id, secret: r.secret, scope: 'creator' });
    code = r.code;
    matchCode = r.matchCode;
    codeExpiresAt = r.codeExpiresAt;
    phase = 'waiting';
    emit();
    schedule();
  } catch (e) {
    phase = 'signed_out';
    problem = api.say(e);
    emit();
  }
}

export async function confirmIsMe(): Promise<void> {
  if (!session) return;
  try {
    await api.confirm(session);
    phase = 'signed_in';
    emit();
    schedule();
  } catch (e) {
    if (e instanceof api.ApiError && e.reason === 'needs_premium') {
      phase = 'ended';
      endedWhy = 'needs_premium';
      store(null);
    } else {
      problem = api.say(e);
    }
    emit();
  }
}

export async function notMe(): Promise<void> {
  const s = session;
  store(null);
  stopPolling();
  phase = 'signed_out';
  last = null;
  emit();
  if (s) {
    try { await api.notMe(s); } catch { /* it ends either way */ }
  }
  void start();
}

export async function signOut(): Promise<void> {
  const s = session;
  store(null);
  stopPolling();
  phase = 'signed_out';
  last = null;
  code = '';
  emit();
  if (s) {
    try { await api.done(s); } catch { /* it ends either way */ }
  }
}

/** Pick up a session this tab already had, after a reload. */
export function resume(): void {
  const s = restore();
  if (!s) return;
  session = s;
  phase = 'waiting';
  void tick();
}

/* ── The sign-in letter ────────────────────────────────────────────── */

const ENDED_WORDS: Record<string, string> = {
  not_me: 'We stopped there. Nothing was opened and nothing was shared.',
  wrong_match: 'The number picked on the phone was not the one on this page, so we stopped. That is the check working. Start again.',
  owner: 'You ended this from your phone.',
  browser: 'Signed out.',
  staff: 'A member of staff ended this session.',
  restricted: 'This account cannot use the creator studio right now. Your phone says why.',
  // The website has no account and cannot know which gate an account failed —
  // Premium, the age check, the creator terms or the identity key — so it does
  // not guess. Telling somebody who pays yearly that "it comes with Premium"
  // sends them to check their subscription instead of agreeing the terms.
  // The phone names the real reason (creatorBlockReason, usePairFlow).
  lost_access: 'We can’t open the studio for this account. Your phone can tell you why — open CallMe and look under Settings, Creator studio.',
  needs_premium: 'We can’t open the studio for this account. Your phone can tell you why — open CallMe and look under Settings, Creator studio.',
  refusals: 'Too many designs were turned down from this session, so it was stopped.',
  gone: 'That session is over.',
};

/** Group the code the way it is printed: K7QM 2HXP 9A. */
export function prettyCode(raw: string): string {
  const c = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return [c.slice(0, 4), c.slice(4, 8), c.slice(8, 10)].filter(Boolean).join(' ');
}

export function pairUrl(raw: string): string {
  return 'https://www.m3xi.com/p/' + (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The sign-in panel. It owns its own timer for the burning strip and tears it
 * down when the host is replaced.
 */
export function mountSignIn(host: HTMLElement): () => void {
  let fuseTimer = 0;
  const body = el('div', { class: 'pairbox' });
  host.appendChild(body);

  const stop = onChange(render);

  function fuse(): HTMLElement {
    const strip = el('div', { class: 'fuse', role: 'img', 'aria-label': 'How long this code lasts' }, [
      el('i', { class: 'paper' }),
    ]);
    const words = el('div', { class: 'fusewords', 'aria-live': 'off' });
    const wrap = el('div', {}, [strip, words]);
    const paper = strip.firstChild as HTMLElement;
    const paint = () => {
      const left = Math.max(0, codeExpiresAt - Date.now());
      const span = 5 * 60 * 1000;
      paper.style.width = Math.max(0, Math.min(100, (left / span) * 100)) + '%';
      words.textContent = left > 0
        ? 'This code lasts another ' + fmtTime(left / 1000) + '. A fresh one appears by itself.'
        : 'Getting a fresh code…';
    };
    paint();
    fuseTimer = window.setInterval(paint, 250);
    return wrap;
  }

  function render(s: Snapshot): void {
    if (fuseTimer) { window.clearInterval(fuseTimer); fuseTimer = 0; }
    clear(body);

    if (s.problem) body.appendChild(el('p', { class: 'warn', text: s.problem }));

    if (s.phase === 'signed_out') {
      body.appendChild(el('button', {
        class: 'btn rose big', type: 'button', text: 'Show me a code',
        onclick: () => { void start(); },
      }));
      return;
    }

    if (s.phase === 'ended') {
      body.appendChild(el('p', { text: ENDED_WORDS[s.endedWhy] || ENDED_WORDS.gone }));
      body.appendChild(el('button', {
        class: 'btn rose big', type: 'button', text: 'Start again',
        onclick: () => { void start(); },
      }));
      return;
    }

    if (s.phase === 'claimed') {
      body.appendChild(el('div', { class: 'hello' }, [
        s.photo
          ? el('img', { class: 'mug', src: s.photo, alt: '', width: '76', height: '76', loading: 'lazy' })
          : el('div', { class: 'mug blank', 'aria-hidden': 'true' }),
        el('div', {}, [
          el('h3', { text: s.name ? 'Hello ' + s.name + '. Is that you?' : 'Is that you?' }),
          el('p', { class: 'muted', text: 'If this is not your name, somebody else scanned this code. Say Not me and we will start over.' }),
        ]),
      ]));
      body.appendChild(el('div', { class: 'actions' }, [
        el('button', { class: 'btn rose', type: 'button', text: "That's me", onclick: () => { void confirmIsMe(); } }),
        el('button', { class: 'btn', type: 'button', text: 'Not me, start over', onclick: () => { void notMe(); } }),
      ]));
      return;
    }

    if (s.phase === 'signed_in') {
      body.appendChild(el('p', { text: s.name ? 'Signed in as ' + s.name + '.' : 'Signed in.' }));
      body.appendChild(el('div', { class: 'actions' }, [
        el('a', { class: 'btn rose', href: '#/cards', text: 'Design a card' }),
        el('a', { class: 'btn', href: '#/library', text: 'My designs' }),
        // "Sign out", not "Done": this ends the session on this computer.
        el('button', { class: 'btn', type: 'button', text: 'Sign out', onclick: () => { void signOut(); } }),
      ]));
      return;
    }

    /* waiting */
    // The real places. "Design your MeCards" is the card editor and has
    // neither a camera nor a code field. The scanner ("Sign in on a computer")
    // sits under the poster on My poster, and again on the collection's
    // "My designs" tab (Settings → Creator studio). The front page's three
    // steps name My poster, so this line does too.
    body.appendChild(el('p', { text: 'On your phone, open CallMe, go to My poster and tap the square under Sign in on a computer. Then point your phone at this.' }));
    if (!CODE_SHAPE.test(code)) {
      // Between codes — after a reload, or in the second before a fresh one
      // lands. Never draw a QR of half a web address.
      body.appendChild(el('p', { class: 'muted', text: 'Getting you a code…' }));
      return;
    }
    const url = pairUrl(code);
    let qr: Node;
    try {
      qr = qrSvg(url, { label: 'Scan this with CallMe to sign in' });
    } catch {
      qr = el('p', { class: 'warn', text: 'The code would not draw. Type it in instead.' });
    }
    body.appendChild(el('div', { class: 'qrpaper' }, [qr]));
    body.appendChild(el('div', { class: 'bigcode', 'aria-label': 'Your code is ' + prettyCode(code) }, [
      el('span', { text: prettyCode(code) }),
    ]));
    body.appendChild(el('p', { class: 'muted', text: 'No camera? Type that code into CallMe instead.' }));
    body.appendChild(el('div', { class: 'matchbox' }, [
      el('div', { class: 'muted', text: 'Your phone will show three numbers. Pick this one:' }),
      el('div', { class: 'matchno', text: matchCode || '··' }),
      el('div', { class: 'muted', text: 'If none of them is this number, say no on your phone. Somebody else has your code.' }),
    ]));
    body.appendChild(fuse());
    body.appendChild(el('p', { class: 'muted small', text: 'This page never holds your password or your account. It can see your designs and nothing else, and you can end it from your phone at any time.' }));
  }

  return () => {
    stop();
    if (fuseTimer) window.clearInterval(fuseTimer);
    stopPolling();
    body.remove();
  };
}

/** Used by the editors: a letter, not a redirect, when a session has gone. */
export function sessionGoneLetter(): void {
  letter({
    title: 'That session is over',
    body: 'Scan a fresh code on the front page to carry on. Nothing you saved is lost.',
    actions: [{ label: 'Sign in again', rose: true, onPick: () => { location.hash = '#/'; } }],
  });
}

export function shout(text: string): void {
  toast(text);
}
