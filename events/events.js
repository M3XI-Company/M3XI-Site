/*
 * m3xi.com/events — what's on.
 *
 * Reads events_public_list() (migration 0102; see the app repo's
 * docs/phase5/EVENTS_CONTRACT.md) with the CallMe project's public anon key.
 * That function returns published events and their public fields only: never
 * the check-in code, never who is going, never anybody's answers. No table is
 * readable with this key.
 *
 * If the function is not there yet (the site can deploy before a migration is
 * applied), it falls back to events_upcoming() from 0091, which has no id and
 * no pictures, so those events show without an "Open the event" button. If
 * nothing answers at all, the page shows its "No events yet" letter with a
 * Try again button, never an error.
 *
 * Everything that came from the database is set as text or as a checked
 * attribute, never as HTML.
 */

const SUPABASE_URL = 'https://cwjspmhgspiavyzrtosl.supabase.co';
// The publishable anon key the rest of the site uses (design/src/api.ts, the
// old /events/ page). It can call the public RPCs and nothing else.
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3anNwbWhnc3BpYXZ5enJ0b3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTI5NTQsImV4cCI6MjA5OTA4ODk1NH0.jhS5adiCcZFbfq5zRXQdRLN1k1hCOQ-Ft5ZhcLJO1zc';
const MEDIA = SUPABASE_URL + '/storage/v1/object/public/event-media/';

const $state = document.getElementById('state');
const $upcoming = document.getElementById('upcoming');
const $upList = document.getElementById('upcoming-list');
const $past = document.getElementById('past');
const $pastList = document.getElementById('past-list');
const $empty = document.getElementById('empty');
const $retry = document.getElementById('retry');
const $retryWords = document.getElementById('empty-retry-words');

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{3,48}$/;
/* The only shapes the bucket accepts (0102's storage policy). Anything else is
   not drawn, rather than turned into a URL. */
const IMG_PATH = /^img\/[A-Za-z0-9_-]{8,64}\.(jpg|png)$/;
const VID_PATH = /^vid\/[A-Za-z0-9_-]{8,64}\.mp4$/;
const SAFE_LINK = /^https:\/\/(www\.)?m3xi\.com(\/\S*)?$/i;

function mediaUrl(path, shape) {
  return typeof path === 'string' && shape.test(path) ? MEDIA + path : null;
}

function eventPage(e) {
  return e.id && UUID.test(e.id) ? '/e/?id=' + encodeURIComponent(e.id) : null;
}

/* ── Times, in the visitor's own zone ──────────────────────────────────── */

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function endOf(e) {
  const s = new Date(e.starts_at);
  return e.ends_at ? new Date(e.ends_at) : new Date(s.getTime() + 2 * 3600e3);
}

function whenLine(e) {
  const s = new Date(e.starts_at);
  let line = dayFmt.format(s) + ' · ' + timeFmt.format(s);
  if (e.ends_at) line += ' – ' + timeFmt.format(new Date(e.ends_at));
  return line;
}

function isOver(e) {
  if (typeof e.is_over === 'boolean') return e.is_over;
  return endOf(e).getTime() < Date.now();
}

function flagFor(e) {
  const now = Date.now();
  if (isOver(e)) return 'Ended';
  if (new Date(e.starts_at).getTime() <= now && endOf(e).getTime() > now) return 'On now';
  return '';
}

/* ── Add to calendar: built in the browser, nothing is sent anywhere ──── */

function icsStamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsText(t) { return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, '\\$&'); }

function addToCalendar(e) {
  const s = new Date(e.starts_at);
  const link = 'https://www.m3xi.com' + (eventPage(e) || ('/events/#' + (e.slug || '')));
  const name = (e.slug && SLUG.test(e.slug)) ? e.slug : 'callme-event';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//M3XI//CallMe events//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + (e.id || name) + '@m3xi.com',
    'DTSTAMP:' + icsStamp(new Date()),
    'DTSTART:' + icsStamp(s),
    'DTEND:' + icsStamp(endOf(e)),
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

/* ── The picture or video at the top of a letter ───────────────────────── */

function hookFor(e) {
  const cover = mediaUrl(e.cover_path, IMG_PATH);
  const label = 'Video for ' + e.title;

  const still = (src) => {
    const img = el('img', { src, alt: '', loading: 'lazy', decoding: 'async', width: 640, height: 400 });
    return img;
  };
  const box = (kids) => {
    const b = el('div', { class: 'hook' }, kids);
    // A picture that will not load takes its frame with it, rather than
    // leaving a broken-image box on the letter.
    b.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => b.remove()));
    return b;
  };

  if (e.hook_kind === 'image') {
    const src = cover || mediaUrl(e.hook_path, IMG_PATH);
    return src ? box([still(src)]) : null;
  }

  if (e.hook_kind === 'video') {
    const vid = mediaUrl(e.hook_path, VID_PATH);
    if (!vid) return cover ? box([still(cover)]) : null;
    if (!cover) {
      // No poster frame: let the browser draw the first one.
      return box([el('video', { src: vid + '#t=0.1', controls: true, playsinline: true, preload: 'metadata', 'aria-label': label })]);
    }
    const b = box([still(cover)]);
    const play = el('button', {
      class: 'play', type: 'button', 'aria-label': 'Play the video for ' + e.title,
      onclick: () => {
        const v = el('video', { src: vid, poster: cover, controls: true, playsinline: true, autoplay: true, 'aria-label': label });
        b.textContent = '';
        b.appendChild(v);
        try { v.focus(); } catch (_) { /* fine */ }
      },
    }, [el('span', {}, [ico('play'), 'Play'])]);
    b.appendChild(play);
    return b;
  }

  return cover ? box([still(cover)]) : null;
}

/* ── One event, as a letter ────────────────────────────────────────────── */

const LONG = 260;

function letterFor(e) {
  const page = eventPage(e);
  const over = isOver(e);
  const flag = flagFor(e);
  const safeLink = e.cta_url && e.cta_label && SAFE_LINK.test(e.cta_url) ? e.cta_url : null;
  const anchor = e.slug && SLUG.test(e.slug) ? e.slug : null;
  const headingId = 'ev-' + (e.id && UUID.test(e.id) ? e.id : (anchor || Math.random().toString(36).slice(2)));

  const body = String(e.body || '');
  const long = body.length > LONG;
  const bodyEl = el('p', { class: 'body', text: long ? body.slice(0, LONG).replace(/\s+\S*$/, '') + '…' : body });
  let moreBtn = null;
  if (long) {
    moreBtn = el('button', {
      class: 'more', type: 'button', 'aria-expanded': 'false', text: 'Read the rest',
      onclick: () => {
        const open = moreBtn.getAttribute('aria-expanded') === 'true';
        bodyEl.textContent = open ? body.slice(0, LONG).replace(/\s+\S*$/, '') + '…' : body;
        moreBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
        moreBtn.textContent = open ? 'Read the rest' : 'Show less';
      },
    });
  }

  const title = page ? el('a', { href: page, text: e.title }) : e.title;

  const actions = [];
  if (page) actions.push(el('a', { class: 'cm-btn cm-btn--primary cm-btn--sm', href: page, text: over ? 'See the event' : 'Open the event' }));
  if (!over) actions.push(el('button', { class: 'cm-btn cm-btn--secondary cm-btn--sm', type: 'button', text: 'Add to calendar', onclick: () => addToCalendar(e) }));
  if (safeLink && !over) actions.push(el('a', { class: 'cm-btn cm-btn--quiet cm-btn--sm', href: safeLink, text: e.cta_label }));

  // .cm-letter brings its own washi tape and wax seal (shared/site-chrome.css).
  const article = el('article', { class: 'cm-letter ev', id: anchor, 'aria-labelledby': headingId }, [
    hookFor(e),
    el('div', { class: 'when' }, [whenLine(e), flag ? ' ' : null, flag ? el('span', { class: 'cm-rubber', text: flag }) : null]),
    el('h3', { id: headingId }, [title]),
    e.where_label ? el('p', { class: 'where' }, [ico('pin'), el('span', { text: e.where_label })]) : null,
    bodyEl,
    moreBtn,
    actions.length ? el('div', { class: 'actions' }, actions) : null,
  ]);
  return el('li', {}, [article]);
}

/* ── Loading ───────────────────────────────────────────────────────────── */

async function rpc(name) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) {
    const err = new Error(name + ' ' + r.status);
    err.status = r.status;
    throw err;
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function load() {
  try {
    return await rpc('events_public_list');
  } catch (e) {
    // 404: the function is not there (yet). The older list still answers.
    if (e && e.status === 404) return rpc('events_upcoming');
    throw e;
  }
}

function valid(e) {
  return e && typeof e.title === 'string' && e.title && typeof e.starts_at === 'string'
    && !Number.isNaN(new Date(e.starts_at).getTime());
}

function showEmpty(failed) {
  $state.hidden = true;
  $upcoming.hidden = true;
  $past.hidden = true;
  $empty.hidden = false;
  $retry.hidden = !failed;
  $retryWords.hidden = !failed;
}

function render(rows) {
  const events = rows.filter(valid);
  $upList.textContent = '';
  $pastList.textContent = '';
  if (!events.length) { showEmpty(false); return; }

  const coming = events.filter((e) => !isOver(e))
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past = events.filter(isOver)
    .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));

  coming.forEach((e) => $upList.appendChild(letterFor(e)));
  past.forEach((e) => $pastList.appendChild(letterFor(e)));

  $empty.hidden = true;
  $state.hidden = true;
  $upcoming.hidden = coming.length === 0;
  $past.hidden = past.length === 0;
  if (!coming.length) {
    // Only past events: say so above them, so the page never looks like it
    // lists something that is about to happen.
    $state.hidden = false;
    $state.textContent = 'Nothing is coming up just now. Events go up here a few days ahead.';
  }

  // The app's reminder letters link to /events/#<slug>.
  if (location.hash.length > 1) {
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (_) { /* a stray % — use it as it is */ }
    const t = document.getElementById(id);
    if (t) t.scrollIntoView();
  }
}

function start() {
  $empty.hidden = true;
  $state.hidden = false;
  $state.textContent = 'Finding what\u2019s on\u2026';
  load().then(render).catch(() => showEmpty(true));
}

$retry.addEventListener('click', start);
start();
