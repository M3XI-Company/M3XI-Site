/*
 * m3xi.com/e/?id=<event id>[&c=<check-in code>] — one event, and the page the
 * venue's QR opens (Phase 5 item 2; app repo docs/phase5/checkin.md).
 *
 * Reads event_public(p_id) (migration 0102; docs/phase5/EVENTS_CONTRACT.md in
 * the app repo) with the CallMe project's public anon key. That function
 * returns one published or cancelled event's public fields: never the
 * check-in code, never who is going, never anybody's answers.
 *
 * THE CODE. The QR encodes https://www.m3xi.com/e/?id=<id>&c=<code>. On a
 * phone with a CallMe build that knows /e/, Android opens that address in the
 * app and this page never loads. When it does load, it reads the code, takes
 * it OUT of the address bar (so sharing or bookmarking the page does not pass
 * it on), and keeps it only in the "Check in with CallMe" button's link. It is
 * never written on the page and never logged, and the page sends no referrer.
 *
 * THE BUTTON hands the same address to the app:
 *   - Android: an intent:// link whose data is exactly that https address,
 *     for the CallMe package. Chrome does not hand a link on the same site to
 *     an app (the page would just reload), so a plain link cannot do it from
 *     here. Without CallMe, or with a CallMe too old to know /e/, Chrome goes
 *     to the Play listing instead (install, or update).
 *   - iPhone: callme://e/?id=…&c=…, the app's own scheme (there are no
 *     universal links for m3xi.com yet).
 *   - A computer: no button, just how to check in with a phone.
 *
 * Everything that came from the database is set as text or as a checked
 * attribute, never as HTML.
 */

const SUPABASE_URL = 'https://cwjspmhgspiavyzrtosl.supabase.co';
// The publishable anon key the rest of the site uses (events/events.js,
// design/src/api.ts). It can call the public RPCs and nothing else.
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3anNwbWhnc3BpYXZ5enJ0b3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTI5NTQsImV4cCI6MjA5OTA4ODk1NH0.jhS5adiCcZFbfq5zRXQdRLN1k1hCOQ-Ft5ZhcLJO1zc';
const MEDIA = SUPABASE_URL + '/storage/v1/object/public/event-media/';
const PLAY = 'https://play.google.com/store/apps/details?id=com.m3xi.callme';
const PACKAGE = 'com.m3xi.callme';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/* 0102 `_event_new_code`: ten characters, no I, O, 0 or 1. */
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const SLUG = /^[a-z0-9-]{3,48}$/;
/* The only shapes the bucket accepts (0102's storage policy). Anything else is
   not drawn, rather than turned into a URL. */
const IMG_PATH = /^img\/[A-Za-z0-9_-]{8,64}\.(jpg|png)$/;
const VID_PATH = /^vid\/[A-Za-z0-9_-]{8,64}\.mp4$/;
const SAFE_LINK = /^https:\/\/(www\.)?m3xi\.com(\/\S*)?$/i;

const HOUR = 3600e3;
/* The check-in window, as 0102 reckons it: 12 hours before the start until
   6 hours after the end (an event with no end lasts 2 hours). */
const OPENS_BEFORE = 12 * HOUR;
const CLOSES_AFTER = 6 * HOUR;
/* A phone clock a little out should not hide the button: the app and the
   server have the last word. */
const SLACK = 15 * 60e3;

const $ = (id) => document.getElementById(id);

/* ── The address ───────────────────────────────────────────────────────── */

function readAddress() {
  const params = new URLSearchParams(location.search);
  const id = (params.get('id') || '').trim().toLowerCase();
  const hadCode = params.has('c');
  let code = null;
  if (hadCode) {
    // The server ignores case and anything that is not a letter or digit.
    const clean = String(params.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    code = CODE.test(clean) ? clean : null;
    params.delete('c');
    const rest = params.toString();
    try {
      history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    } catch (_) { /* an old browser keeps the address as it was */ }
  }
  return { id: UUID.test(id) ? id : null, code, hadCode };
}

const ua = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
const isAndroid = !isIOS && /Android/i.test(ua);

/** The link that hands https://www.m3xi.com/e/?id=…&c=… to CallMe, or null on a computer. */
function checkinHref(id, code) {
  // Both parts were checked against their exact shapes above, so nothing here needs escaping.
  const path = '/e/?id=' + id + '&c=' + code;
  if (isAndroid) {
    return 'intent://www.m3xi.com' + path
      + '#Intent;scheme=https;package=' + PACKAGE
      + ';S.browser_fallback_url=' + encodeURIComponent(PLAY) + ';end';
  }
  if (isIOS) return 'callme://e/?id=' + id + '&c=' + code;
  return null;
}

/* ── Small helpers ─────────────────────────────────────────────────────── */

function el(tag, attrs, kids) {
  const n = document.createElement(tag);
  Object.keys(attrs || {}).forEach((k) => {
    const v = attrs[k];
    if (k === 'text') n.textContent = v == null ? '' : String(v);
    else if (k === 'class') n.className = v;
    else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  });
  (kids || []).forEach((c) => {
    if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
}

/** A small ink icon from the site's paper kit (shared/site-chrome.css). */
function ico(name) {
  return el('i', { class: 'cm-ico cm-ico--' + name, 'aria-hidden': 'true' });
}

function mediaUrl(path, shape) {
  return typeof path === 'string' && shape.test(path) ? MEDIA + path : null;
}

/* ── Times, in the visitor's own zone ──────────────────────────────────── */

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function startOf(e) { return new Date(e.starts_at).getTime(); }
function endOf(e) {
  const end = e.ends_at ? new Date(e.ends_at).getTime() : NaN;
  return Number.isFinite(end) ? end : startOf(e) + 2 * HOUR;
}

function whenLine(e) {
  const s = new Date(e.starts_at);
  let line = dayFmt.format(s) + ' · ' + timeFmt.format(s);
  if (e.ends_at) line += ' – ' + timeFmt.format(new Date(e.ends_at));
  return line;
}

function isOver(e) {
  if (typeof e.is_over === 'boolean') return e.is_over;
  return endOf(e) < Date.now();
}

function flagFor(e) {
  if (e.status === 'cancelled') return 'Called off';
  const now = Date.now();
  if (isOver(e)) return 'Ended';
  if (startOf(e) <= now && endOf(e) > now) return 'On now';
  return '';
}

/* ── Add to calendar: built in the browser, nothing is sent anywhere ──── */

function icsStamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsText(t) { return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, '\\$&'); }

function addToCalendar(e) {
  // The event's own page, never the check-in code.
  const link = 'https://www.m3xi.com/e/?id=' + e.id;
  const name = (e.slug && SLUG.test(e.slug)) ? e.slug : 'callme-event';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//M3XI//CallMe events//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + e.id + '@m3xi.com',
    'DTSTAMP:' + icsStamp(new Date()),
    'DTSTART:' + icsStamp(new Date(e.starts_at)),
    'DTEND:' + icsStamp(new Date(endOf(e))),
    'SUMMARY:' + icsText(e.title),
    'DESCRIPTION:' + icsText(e.body + '\n\n' + link),
    e.where_label ? 'LOCATION:' + icsText(e.where_label) : '',
    'URL:' + link,
    'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(e.title + ' starts in an hour'), 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = name + '.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ── The picture or video ──────────────────────────────────────────────── */

function hookFor(e) {
  const cover = mediaUrl(e.cover_path, IMG_PATH);
  const box = (kid) => {
    const b = el('div', { class: 'hook' }, [kid]);
    // A picture that will not load takes its frame with it.
    b.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => b.remove()));
    return b;
  };
  const still = (src) => el('img', { src, alt: '', decoding: 'async', width: 760, height: 475 });

  if (e.hook_kind === 'video') {
    const vid = mediaUrl(e.hook_path, VID_PATH);
    if (vid) {
      return box(el('video', {
        src: cover ? vid : vid + '#t=0.1',
        poster: cover,
        controls: true,
        playsinline: true,
        preload: cover ? 'none' : 'metadata',
        'aria-label': 'Video for ' + e.title,
      }));
    }
    return cover ? box(still(cover)) : null;
  }
  if (e.hook_kind === 'image') {
    const src = cover || mediaUrl(e.hook_path, IMG_PATH);
    return src ? box(still(src)) : null;
  }
  return cover ? box(still(cover)) : null;
}

/* ── The event ─────────────────────────────────────────────────────────── */

const LONG = 600;

function showEvent(e) {
  document.title = e.title + ' — CallMe events';

  const hook = $('event-hook');
  hook.textContent = '';
  const h = hookFor(e);
  if (h) hook.appendChild(h);

  const when = $('event-when');
  when.textContent = whenLine(e);
  const flag = flagFor(e);
  if (flag) {
    when.appendChild(document.createTextNode(' '));
    when.appendChild(el('span', { class: e.status === 'cancelled' ? 'cm-rubber off' : 'cm-rubber', text: flag }));
  }

  $('event-h').textContent = e.title;

  const where = $('event-where');
  where.textContent = '';
  if (e.where_label) {
    where.appendChild(ico('pin'));
    where.appendChild(el('span', { text: e.where_label }));
    where.hidden = false;
  } else where.hidden = true;

  const body = String(e.body || '');
  const $body = $('event-body');
  const $more = $('event-more');
  const cut = () => body.slice(0, LONG).replace(/\s+\S*$/, '') + '…';
  if (body.length > LONG) {
    $body.textContent = cut();
    $more.hidden = false;
    $more.onclick = () => {
      const open = $more.getAttribute('aria-expanded') === 'true';
      $body.textContent = open ? cut() : body;
      $more.setAttribute('aria-expanded', open ? 'false' : 'true');
      $more.textContent = open ? 'Read the rest' : 'Show less';
    };
  } else {
    $body.textContent = body;
    $more.hidden = true;
  }

  const actions = $('event-actions');
  actions.textContent = '';
  const live = e.status !== 'cancelled' && !isOver(e);
  if (live) actions.appendChild(el('button', { class: 'cm-btn cm-btn--secondary cm-btn--sm', type: 'button', text: 'Add to calendar', onclick: () => addToCalendar(e) }));
  if (live && e.cta_url && e.cta_label && SAFE_LINK.test(e.cta_url)) {
    actions.appendChild(el('a', { class: 'cm-btn cm-btn--secondary cm-btn--sm', href: e.cta_url, text: e.cta_label }));
  }
  actions.appendChild(el('a', { class: 'cm-btn cm-btn--quiet cm-btn--sm', href: '/events/', text: 'All events' }));

  // .cm-letter brings its own washi tape and wax seal (shared/site-chrome.css).
  $('event').hidden = false;
}

/* ── Checking in ───────────────────────────────────────────────────────── */

function questionWords(n) {
  if (!n) return 'CallMe opens this event’s check-in, and one tap lets the CallMe team know you’re here.';
  const qs = n === 1 ? 'one short question' : n + ' short questions';
  return 'CallMe opens this event’s check-in. The CallMe team has ' + qs + ' for you there, and every one can be skipped.';
}

function showCheckin(e, addr) {
  const box = $('checkin');
  const words = $('checkin-words');
  const note = $('checkin-note');
  const open = $('checkin-open');
  const help = $('checkin-help');
  const stores = $('stores');
  const now = Date.now();

  note.hidden = true;
  open.hidden = true;
  help.hidden = true;
  stores.hidden = false;
  // The store cards are drawn by /shared/site-chrome.js, and the App Store one
  // is a real link only once window.M3XI_APPSTORE is live. An iPhone is never
  // sent to Google Play, and an Android phone is not shown the App Store.
  const appLive = document.documentElement.getAttribute('data-appstore-state') === 'live';
  $('store-ios').hidden = !(isIOS && !appLive);
  $('store-play').style.display = isIOS ? 'none' : '';
  $('store-apple').style.display = isAndroid ? 'none' : '';

  if (e.status === 'cancelled') {
    words.textContent = 'This event was called off, so there is nothing to check in to.';
    stores.hidden = true;
  } else if (!addr.code) {
    words.textContent = 'This check-in code didn’t come through in full. Scan the code at the venue again.';
  } else if (now > endOf(e) + CLOSES_AFTER + SLACK) {
    words.textContent = 'Check-in for this event has closed. It closes six hours after the event ends.';
    stores.hidden = true;
  } else if (now < startOf(e) - OPENS_BEFORE - SLACK) {
    const opens = new Date(startOf(e) - OPENS_BEFORE);
    words.textContent = 'Check-in opens twelve hours before the start. Scan the code again then.';
    note.textContent = 'Opens ' + dayFmt.format(opens) + ' at ' + timeFmt.format(opens);
    note.hidden = false;
  } else {
    const href = checkinHref(e.id, addr.code);
    if (href) {
      words.textContent = questionWords(Number(e.question_count) || 0);
      open.setAttribute('href', href);
      open.hidden = false;
      help.hidden = false;
    } else {
      words.textContent = 'Checking in happens in the CallMe app on your phone. At the venue, point your phone’s camera at the event’s code.';
    }
  }
  box.hidden = false;
  // One set of store cards on the page: the check-in letter's, when it shows them.
  $('getapp').hidden = !stores.hidden;
}

/* ── Loading ───────────────────────────────────────────────────────────── */

async function fetchEvent(id) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/event_public', {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id }),
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('event_public ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function valid(e) {
  return e && typeof e.id === 'string' && UUID.test(e.id.toLowerCase())
    && typeof e.title === 'string' && e.title
    && typeof e.starts_at === 'string' && !Number.isNaN(new Date(e.starts_at).getTime());
}

function showMissing(failed) {
  $('state').hidden = true;
  $('event').hidden = true;
  $('checkin').hidden = true;
  $('missing-h').textContent = failed ? 'We couldn’t load the event' : 'We can’t find that event';
  $('missing-words').textContent = failed
    ? 'Check your connection and try again.'
    : 'It may have been taken down, or the link is missing part of its address.';
  $('retry').hidden = !failed;
  $('missing').hidden = false;
}

const addr = readAddress();

function start() {
  $('missing').hidden = true;
  $('state').hidden = false;
  $('state').textContent = 'Finding the event\u2026';
  if (!addr.id) { showMissing(false); return; }
  fetchEvent(addr.id).then((e) => {
    if (!valid(e)) { showMissing(false); return; }
    e.id = e.id.toLowerCase();
    $('state').hidden = true;
    showEvent(e);
    if (addr.hadCode) showCheckin(e, addr);
  }).catch(() => showMissing(true));
}

$('retry').addEventListener('click', start);
start();
