/* ===========================================================================
   The agent dashboard for property tours.

   One page, one job: see the tours you have captured, preview each before
   anyone else can, put it live, embed it on the listing, fix the odd label or
   pin, and read every enquiry it brought in.

   Everything here talks to the m3ix-spatial function (docs/TOUR_API.md) with
   the signed-in user's JWT. There is deliberately no anon fallback: with no
   session the page shows a sign-in card and nothing else.

   Dev mock: on localhost only, ?mock=1 serves the page from in-memory stubs
   shaped exactly like the API responses, so the list, editor, pins and
   enquiries can be exercised without an account. On the live host the
   switch is inert.
   =========================================================================== */

const SB_URL = 'https://tnlcuptfldwxtxajudoq.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRubGN1cHRmbGR3eHR4YWp1ZG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODcxNDEsImV4cCI6MjEwMDA2MzE0MX0.mgS1gDa7qeBsTCaXmefpogg02kw7tCzn0uEYPAAuC90';
const FN = SB_URL + '/functions/v1/m3ix-spatial';
const SITE = 'https://www.m3xi.com';

const Q = new URLSearchParams(location.search);
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const MOCK = IS_LOCAL && Q.get('mock') === '1';

const $ = (s, r = document) => r.querySelector(s);

/* ---------- tiny DOM builder ---------- */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function say(node, text, bad) {
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('err', !!bad);
  node.classList.toggle('ok', !bad && !!text);
}
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 7 * 86400) return Math.round(s / 86400) + ' days ago';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fullDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString();
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/* Disable a control while its request is in flight, then show the result. */
async function run(btn, msgEl, fn) {
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); }
  try {
    await fn();
  } catch (e) {
    say(msgEl, friendly(e), true);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); }
  }
}
function friendly(e) {
  const m = String((e && e.message) || e || 'Something went wrong.');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach M3XI — check your connection and try again.';
  return m;
}

/* ===========================================================================
   AUTH
   =========================================================================== */
let sb = null;

function canonicalOrigin() {
  if (location.hostname === 'm3xi.com') return 'https://www.m3xi.com';
  return location.origin;
}
/* Return here after sign-in. No fragment — the session comes back in one of
   its own (see studio/index.html for the full story). */
function returnUrl() { return canonicalOrigin() + '/tours/'; }

async function getSession() {
  if (MOCK) return { access_token: 'mock', user: { email: 'mock@localhost' } };
  if (!sb) return null;
  const { data: { session } } = await sb.auth.getSession();
  return session || null;
}

function showLoading() { $('#loading').hidden = false; $('#gate').hidden = true; $('#dash').hidden = true; $('#acct').hidden = true; }
function showGate(why) {
  shownFor = null;   // the dashboard is drawn for nobody now; the next sign-in redraws it
  $('#loading').hidden = true; $('#dash').hidden = true; $('#acct').hidden = true;
  $('#gate').hidden = false;
  const w = $('#gateWhy');
  w.hidden = !why; w.textContent = why || '';
}
function showDash(email) {
  $('#loading').hidden = true; $('#gate').hidden = true;
  $('#dash').hidden = false; $('#acct').hidden = false;
  $('#who').textContent = email || '';
  $('#who').title = email || '';
}

/* Who the page is currently drawn for. supabase-js fires auth events for
   token refreshes too; re-drawing the list on every one of those would throw
   away an editor someone is halfway through. Only a change of identity
   (sign-in, sign-out, different account) redraws. */
let shownFor;   // undefined = nothing drawn yet; null = the sign-in gate; string = that user's dashboard

async function refresh(force) {
  const session = await getSession();
  const id = session ? ((session.user && session.user.id) || (session.user && session.user.email) || 'signed-in') : null;
  if (!force && id === shownFor) return;
  shownFor = id;
  if (!session) { tours = []; $('#list').innerHTML = ''; cards.clear(); showGate(); return; }
  showDash(session.user && session.user.email);
  await loadTours();
}

async function boot() {
  if (MOCK) {
    $('#mockBanner').hidden = false;
    await refresh();
    return;
  }
  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    /* No navigator.locks: a frozen background tab holding the lock hangs every
       other m3xi.com tab. A plain passthrough is what supabase-js runs on
       browsers without locks anyway. */
    sb = createClient(SB_URL, SB_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, lock: (_n, _t, fn) => fn() },
    });
    window.__sb = sb;
  } catch (e) {
    showGate('Could not load the sign-in library — check your connection and reload.');
    return;
  }
  /* Deferred, never direct: the auth client awaits these callbacks while it
     initialises and refresh() starts with getSession(), which waits for it. */
  sb.auth.onAuthStateChange(() => setTimeout(refresh, 0));
  await refresh();
  /* Tidy the address bar after the round trip (supabase-js has read the
     fragment / code by the time getSession resolves). */
  if (Q.has('code') || Q.has('error') || location.hash) {
    Q.delete('code'); Q.delete('error'); Q.delete('error_description');
    const rest = Q.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
  }
}

$('#otpForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = ($('#gateEmail').value || '').trim();
  const msg = $('#gateMsg');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say(msg, 'That does not look like an email address.', true);
  if (!sb) return say(msg, 'Sign-in is not available in the dev mock.', true);
  await run($('#btnOtp'), msg, async () => {
    say(msg, 'Sending…');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl() } });
    if (error) throw new Error('Could not send the link: ' + error.message);
    say(msg, 'Check your inbox — the link signs you straight in and brings you back here.');
  });
});
$('#btnGoogle').addEventListener('click', async () => {
  const msg = $('#gateMsg');
  if (!sb) return say(msg, 'Sign-in is not available in the dev mock.', true);
  await run($('#btnGoogle'), msg, async () => {
    say(msg, 'Opening Google…');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: returnUrl(), queryParams: { prompt: 'select_account' } },
    });
    if (error) throw new Error('Google sign-in failed: ' + error.message);
  });
});
$('#btnSignOut').addEventListener('click', async () => {
  await run($('#btnSignOut'), null, async () => {
    if (sb) await sb.auth.signOut();
    tours = [];
    $('#list').innerHTML = '';
    cards.clear();
    showGate();
  });
});

/* ===========================================================================
   API
   =========================================================================== */
async function api(action, body = {}) {
  if (MOCK) return mock(action, body);
  const session = await getSession();
  if (!session) { showGate('You were signed out — sign in again to carry on.'); throw new Error('Sign in to do that.'); }
  const r = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + session.access_token },
    body: JSON.stringify({ action, ...body }),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    if (r.status === 401) showGate('Your sign-in has expired — sign in again to carry on.');
    const why = (j && j.error) || (j && j.problems && j.problems.join('; ')) || ('The server could not do that (HTTP ' + r.status + '). Try again in a moment.');
    throw new Error(why);
  }
  return j;
}

/* ===========================================================================
   THE LIST
   =========================================================================== */
let tours = [];
const cards = new Map();   // tour id → card element

async function loadTours() {
  const msg = $('#listMsg');
  say(msg, 'Loading your tours…');
  try {
    const j = await api('list_tours');
    tours = Array.isArray(j.tours) ? j.tours : [];
    say(msg, '');
    renderList();
  } catch (e) {
    say(msg, 'Could not load your tours: ' + friendly(e), true);
  }
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  cards.clear();
  $('#empty').hidden = tours.length > 0;
  for (const t of tours) list.appendChild(tourCard(t));
}

const STATUS = {
  unlisted: { label: 'Unlisted', cls: 'unlisted', blurb: 'Only people with the preview link can see it.' },
  published: { label: 'Live', cls: 'live', blurb: 'Anyone with the link or the listing page can walk it.' },
  archived: { label: 'Archived', cls: 'archived', blurb: 'Nothing is reachable until you restore it.' },
};

function tourCard(t) {
  const card = el('article', { class: 'panel tour', 'aria-label': t.title || t.property.address || 'Tour' });
  card._tour = t;
  cards.set(t.id, card);
  card.append(
    el('span', { class: 'cap chipcap' }),
    el('div', { class: 'head' }),
    el('div', { class: 'counts' }),
    el('div', { class: 'actions' }),
    el('p', { class: 'msg', role: 'status' }),
    el('div', { class: 'stripbox' }),
    el('div', { class: 'editorbox' }),
  );
  paintCard(card);
  return card;
}

/* Re-paint only the summary parts of a card so an open editor survives. */
function paintCard(card) {
  const t = card._tour;
  const st = STATUS[t.status] || { label: t.status || 'Unknown', cls: '', blurb: '' };
  const msg = $('.msg', card);

  $('.chipcap', card).textContent = st.label;

  const head = $('.head', card);
  head.innerHTML = '';
  head.append(
    el('div', {},
      el('div', { class: 'title', text: t.title || t.property.address || 'Untitled tour' }),
      el('div', { class: 'addr', text: (t.title && t.property.address && t.title !== t.property.address ? t.property.address + ' · ' : '') + st.blurb }),
    ),
    el('span', { class: 'chip ' + st.cls }, el('span', { class: 'dot', 'aria-hidden': 'true' }), st.label),
  );

  const counts = $('.counts', card);
  counts.innerHTML = '';
  const c = t.counts || {};
  counts.append(
    el('div', {}, el('b', { text: String(c.nodes ?? 0) }), el('span', { text: (c.nodes === 1 ? 'standpoint' : 'standpoints') })),
    el('div', {}, el('b', { text: String(c.rooms ?? 0) }), el('span', { text: (c.rooms === 1 ? 'room' : 'rooms') })),
    el('div', {}, el('b', { text: String(c.leads ?? 0) }), el('span', { text: (c.leads === 1 ? 'enquiry' : 'enquiries') })),
  );
  if (t.published_at) counts.append(el('div', {}, el('b', { text: when(t.published_at), title: fullDate(t.published_at), style: 'font-size:15px;padding-top:5px' }), el('span', { text: 'went live' })));

  const actions = $('.actions', card);
  actions.innerHTML = '';
  const strip = $('.stripbox', card);
  const editorBox = $('.editorbox', card);

  const lifecycle = (action, label, cls, okText) => el('button', {
    class: 'btn sm ' + (cls || ''), type: 'button',
    onclick: (ev) => run(ev.currentTarget, msg, async () => {
      say(msg, '');
      const j = await api(action, { tour_id: t.id });
      if (j.tour) replaceTour(j.tour);
      say(msg, okText);
    }),
  }, label);

  if (t.status !== 'archived') {
    actions.append(el('a', { class: 'btn sm ghost', href: t.urls.preview, target: '_blank', rel: 'noopener' }, 'Preview ↗'));
  }
  if (t.status === 'published') {
    actions.append(el('a', { class: 'btn sm ghost', href: t.urls.live, target: '_blank', rel: 'noopener' }, 'Open live ↗'));
    actions.append(lifecycle('unpublish', 'Unpublish', '', 'Taken down. The preview link still works; the live link no longer does.'));
  } else {
    actions.append(lifecycle('go_live', t.status === 'archived' ? 'Restore & go live' : 'Go live', 'green', 'Live. Anyone with the link can walk it now.'));
  }
  if (t.status !== 'archived') {
    actions.append(lifecycle('archive', 'Archive', '', 'Archived. Nothing is reachable until you restore it.'));
  } else {
    actions.append(lifecycle('unpublish', 'Restore (unlisted)', '', 'Restored as unlisted. The preview link works again.'));
  }

  // New preview link
  actions.append(el('button', {
    class: 'btn sm ghost', type: 'button',
    onclick: () => showStrip(strip, 'New preview link', false,
      el('p', {}, 'Anyone holding the current preview link will lose access the moment you do this. The live link (if the tour is live) is not affected.'),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm red', type: 'button', onclick: (ev) => run(ev.currentTarget, msg, async () => {
          const j = await api('rotate_view_key', { tour_id: t.id });
          if (j.tour) replaceTour(j.tour);
          strip.innerHTML = '';
          say(msg, 'New preview link made. Use Preview to open it; old links now stop.');
        }) }, 'Make a new preview link'),
        el('button', { class: 'btn sm ghost', type: 'button', onclick: () => { strip.innerHTML = ''; } }, 'Cancel'),
      )),
  }, 'New preview link'));

  // Embed
  actions.append(el('button', {
    class: 'btn sm ghost', type: 'button',
    onclick: () => {
      const script = '<script src="' + SITE + '/tour/embed.js" data-tour="' + t.slug + '" async><\/script>';
      const iframe = '<iframe src="' + SITE + '/tour/?t=' + encodeURIComponent(t.slug) + '&embed=1" width="100%" height="560" style="border:0;max-width:100%" loading="lazy" allow="fullscreen; accelerometer; gyroscope; xr-spatial-tracking" allowfullscreen title="Property tour"></iframe>';
      showStrip(strip, 'Embed on the listing', false,
        el('p', {}, 'Paste this where the tour should appear on the listing page. ' + (t.status === 'published' ? 'The tour is live, so it will show straight away.' : 'It will show once the tour is live.')),
        el('label', { class: 'lbl' }, 'Script tag (recommended)'),
        copyBlock(script, msg),
        el('label', { class: 'lbl', style: 'margin-top:12px' }, 'Plain iframe (if scripts are not allowed)'),
        copyBlock(iframe, msg),
        el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn sm ghost', type: 'button', onclick: () => { strip.innerHTML = ''; } }, 'Close')),
      );
    },
  }, 'Embed'));

  // Capture more
  actions.append(el('a', {
    class: 'btn sm ghost',
    href: '/capture/?property=' + encodeURIComponent(t.property.id) + '&address=' + encodeURIComponent(t.property.address || ''),
    title: 'Opens the capture page for this address — re-shoot a room or add more',
  }, 'Capture more'));

  // Edit / enquiries
  const editBtn = el('button', { class: 'btn sm', type: 'button', 'aria-expanded': editorBox.childElementCount ? 'true' : 'false' }, editorBox.childElementCount ? 'Close editor' : 'Edit & enquiries');
  editBtn.addEventListener('click', () => {
    if (editorBox.childElementCount) { editorBox.innerHTML = ''; editBtn.textContent = 'Edit & enquiries'; editBtn.setAttribute('aria-expanded', 'false'); return; }
    editBtn.textContent = 'Close editor'; editBtn.setAttribute('aria-expanded', 'true');
    openEditor(card);
  });
  actions.append(editBtn);

  // Delete
  actions.append(el('button', {
    class: 'btn sm ghost', type: 'button', style: 'color:var(--red)',
    onclick: () => {
      const input = el('input', { class: 'field', type: 'text', placeholder: 'Type DELETE', autocomplete: 'off', style: 'max-width:200px', 'aria-label': 'Type DELETE to confirm' });
      const go = el('button', { class: 'btn sm red', type: 'button', disabled: true, onclick: (ev) => run(ev.currentTarget, msg, async () => {
        if (input.value.trim() !== 'DELETE') throw new Error('Type DELETE in capitals to confirm.');
        await api('delete_tour', { tour_id: t.id });
        tours = tours.filter(x => x.id !== t.id);
        cards.delete(t.id);
        card.remove();
        $('#empty').hidden = tours.length > 0;
        say($('#listMsg'), 'Deleted "' + (t.title || t.property.address) + '" and every photo in it.');
      }) }, 'Delete this tour for good');
      input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'DELETE'; });
      showStrip(strip, 'Delete this tour', true,
        el('p', {}, 'This removes the tour, its rooms and standpoints, and every photo that was captured for it. It cannot be undone. Enquiries you have already received are kept on the property.'),
        el('div', { class: 'row' }, input, go, el('button', { class: 'btn sm ghost', type: 'button', onclick: () => { strip.innerHTML = ''; } }, 'Cancel')),
      );
      input.focus();
    },
  }, 'Delete'));
}

function showStrip(strip, title, danger, ...kids) {
  strip.innerHTML = '';
  strip.append(el('div', { class: 'strip' + (danger ? ' danger' : ''), role: 'region', 'aria-label': title }, el('h3', { text: title }), ...kids));
}

function copyBlock(text, msg) {
  const ta = el('textarea', { class: 'code', readonly: true, rows: 3, 'aria-label': 'Embed code' });
  ta.value = text;
  ta.addEventListener('focus', () => ta.select());
  const btn = el('button', { class: 'btn sm', type: 'button', onclick: async () => {
    let done = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); done = true; } catch (e) { done = false; }
    }
    if (!done) {
      /* Older browsers, or a page the browser will not trust with the clipboard. */
      try { ta.select(); done = document.execCommand('copy'); } catch (e) { done = false; }
    }
    if (done) {
      btn.textContent = 'Copied';
      say(msg, '');
      setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
    } else {
      ta.focus(); ta.select();
      say(msg, 'Could not copy automatically — the code is selected, press Ctrl+C / Cmd+C.', true);
    }
  } }, 'Copy');
  return el('div', {}, ta, el('div', { class: 'row', style: 'margin-top:6px' }, btn));
}

/* A lifecycle call returns the fresh TourSummary; swap it into the list and
   repaint the card without touching an open editor. */
function replaceTour(fresh) {
  const i = tours.findIndex(x => x.id === fresh.id);
  if (i >= 0) tours[i] = fresh; else tours.unshift(fresh);
  const card = cards.get(fresh.id);
  if (card) { card._tour = fresh; paintCard(card); }
}

/* ===========================================================================
   THE EDITOR
   =========================================================================== */
async function openEditor(card) {
  const t = card._tour;
  const box = $('.editorbox', card);
  const msg = $('.msg', card);
  box.innerHTML = '';
  const ed = el('div', { class: 'editor' }, el('p', { class: 'small', role: 'status', text: 'Loading the tour…' }));
  box.append(ed);
  let data, leads;
  try {
    [data, leads] = await Promise.all([
      api('get_tour', { tour_id: t.id }),
      api('list_leads', { tour_id: t.id }).catch(e => ({ error: friendly(e) })),
    ]);
  } catch (e) {
    ed.innerHTML = '';
    ed.append(el('p', { class: 'err', text: 'Could not load the tour: ' + friendly(e) }),
      el('button', { class: 'btn sm ghost', type: 'button', onclick: () => openEditor(card) }, 'Try again'));
    return;
  }
  if (data.tour) { card._tour = data.tour; replaceTour(data.tour); }
  const rooms = (data.rooms || []).slice().sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const roomOrder = new Map(rooms.map((r, i) => [r.id, i]));
  const state = {
    tour: data.tour || t,
    rooms,
    /* Room order first, then the standpoint's order within its room — the
       same order a buyer walks them. */
    nodes: (data.nodes || []).filter(n => !n.status || n.status === 'active').slice()
      .sort((a, b) => ((roomOrder.get(a.room_id) ?? 1e9) - (roomOrder.get(b.room_id) ?? 1e9)) || ((a.ordinal ?? 0) - (b.ordinal ?? 0))),
    floorplan: data.floorplan || null,
    leads: leads && Array.isArray(leads.leads) ? leads.leads : null,
    leadsError: leads && leads.error ? leads.error : null,
    msg,
  };
  for (const n of state.nodes) if (!Array.isArray(n.links)) n.links = [];
  ed.innerHTML = '';
  ed.append(
    brandingSection(state),
    roomsSection(state),
    planSection(state),
    spawnSection(state),
    leadsSection(state),
  );
  card._state = state;
}

function nodeName(state, n) {
  const room = state.rooms.find(r => r.id === n.room_id);
  const base = n.label || ((room ? room.name : 'Standpoint') + ' ' + ((n.ordinal ?? 0) + 1));
  return room && n.label && !n.label.toLowerCase().includes(room.name.toLowerCase()) ? room.name + ' · ' + base : base;
}

/* ---------- title & branding ---------- */
function brandingSection(state) {
  const t = state.tour;
  const b = t.branding || {};
  const f = (id, label, value, type = 'text', extra = {}) => {
    const input = el('input', { class: 'field', id, type, value: value || '', ...extra });
    return { input, wrap: el('div', {}, el('label', { class: 'lbl', for: id }, label), input) };
  };
  const title = f('ed-title-' + t.id, 'Tour title (shown to buyers)', t.title || t.property.address, 'text', { maxlength: 120 });
  const name = f('ed-name-' + t.id, 'Agency name', b.name, 'text', { maxlength: 80 });
  const phone = f('ed-phone-' + t.id, 'Phone', b.phone, 'tel', { maxlength: 40 });
  const email = f('ed-email-' + t.id, 'Email for enquiries', b.email, 'email', { maxlength: 120 });
  const site = f('ed-site-' + t.id, 'Website', b.website, 'url', { maxlength: 200, placeholder: 'https://' });
  const colourHex = el('input', { class: 'field', type: 'text', value: b.colour || '#d0402b', maxlength: 7, style: 'max-width:120px', 'aria-label': 'Brand colour as hex', pattern: '#[0-9a-fA-F]{6}' });
  const colourPick = el('input', { class: 'swatch', type: 'color', value: /^#[0-9a-f]{6}$/i.test(b.colour || '') ? b.colour : '#d0402b', 'aria-label': 'Pick brand colour' });
  colourPick.addEventListener('input', () => { colourHex.value = colourPick.value; });
  colourHex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(colourHex.value)) colourPick.value = colourHex.value; });

  const smsg = el('p', { class: 'msg', role: 'status' });
  const save = el('button', { class: 'btn sm', type: 'button' }, 'Save branding');
  const inputs = [title.input, name.input, phone.input, email.input, site.input, colourHex, colourPick];
  save.addEventListener('click', () => run(save, smsg, async () => {
    if (!/^#[0-9a-f]{6}$/i.test(colourHex.value)) throw new Error('The colour needs to be a hex value like #d0402b.');
    inputs.forEach(i => i.disabled = true);
    try {
      const j = await api('update_tour', {
        tour_id: t.id,
        title: title.input.value.trim(),
        branding: { name: name.input.value.trim(), phone: phone.input.value.trim(), email: email.input.value.trim(), website: site.input.value.trim(), colour: colourHex.value.toLowerCase() },
      });
      if (j.tour) { state.tour = j.tour; replaceTour(j.tour); }
      say(smsg, 'Saved. Buyers see the new details next time the tour loads.');
    } finally { inputs.forEach(i => i.disabled = false); }
  }));

  return el('section', { class: 'ed' },
    el('h3', { text: 'Title & branding' }),
    el('p', { class: 'small', style: 'margin-bottom:12px' }, 'This is what the buyer sees on the tour: your agency, how to reach you, and the colour of the buttons.'),
    el('div', { class: 'grid2' }, title.wrap, name.wrap, phone.wrap, email.wrap, site.wrap,
      el('div', {}, el('label', { class: 'lbl' }, 'Brand colour'), el('div', { class: 'row' }, colourPick, colourHex)),
      el('div', {}, el('label', { class: 'lbl' }, 'Logo'), el('p', { class: 'small' }, 'Logo upload is coming soon. Until then the tour shows your agency name.')),
    ),
    el('div', { class: 'row', style: 'margin-top:14px' }, save),
    smsg,
  );
}

/* ---------- rooms & standpoints ---------- */
function roomsSection(state) {
  const sec = el('section', { class: 'ed' }, el('h3', { text: 'Rooms & standpoints' }));
  if (!state.rooms.length) {
    sec.append(el('p', { class: 'small' }, 'No rooms have been captured for this property yet.'));
    return sec;
  }
  sec.append(el('p', { class: 'small', style: 'margin-bottom:4px' }, 'Rename a room or a standpoint, and choose which standpoints a buyer can walk between. Standpoints in the same room are already connected.'));
  for (const room of state.rooms) sec.append(roomBlock(state, room));
  const orphans = state.nodes.filter(n => !state.rooms.some(r => r.id === n.room_id));
  if (orphans.length) {
    const blk = el('div', { class: 'room' }, el('div', { class: 'rhead' }, el('b', { text: 'Standpoints without a room' })));
    orphans.forEach(n => blk.append(nodeBlock(state, n)));
    sec.append(blk);
  }
  return sec;
}

function roomBlock(state, room) {
  const rmsg = el('span', { class: 'small', role: 'status' });
  const input = el('input', { class: 'field', type: 'text', value: room.name || '', maxlength: 60, 'aria-label': 'Room name' });
  const btn = el('button', { class: 'btn sm ghost', type: 'button' }, 'Rename');
  btn.addEventListener('click', () => run(btn, rmsg, async () => {
    const name = input.value.trim();
    if (!name) throw new Error('A room needs a name.');
    input.disabled = true;
    try {
      const j = await api('update_room', { room_id: room.id, name });
      room.name = (j.room && j.room.name) || name;
      input.value = room.name;
      say(rmsg, 'Renamed.');
      refreshPins(state);
      refreshSpawnOptions(state);
      refreshLinkLabels(state);
    } finally { input.disabled = false; }
  }));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } });
  const nodes = state.nodes.filter(n => n.room_id === room.id);
  const blk = el('div', { class: 'room' },
    el('div', { class: 'rhead' }, input, btn, rmsg, el('span', { class: 'small', style: 'margin-left:auto' }, nodes.length + (nodes.length === 1 ? ' standpoint' : ' standpoints'))),
  );
  if (!nodes.length) blk.append(el('p', { class: 'small', style: 'margin-top:8px' }, 'No photos in this room yet — "Capture more" adds some.'));
  nodes.forEach(n => blk.append(nodeBlock(state, n)));
  return blk;
}

function nodeBlock(state, n) {
  const nmsg = el('span', { class: 'small', role: 'status' });
  const input = el('input', { class: 'field', type: 'text', value: n.label || '', maxlength: 60, placeholder: 'Label, e.g. By the window', 'aria-label': 'Standpoint label' });
  const btn = el('button', { class: 'btn sm ghost', type: 'button' }, 'Save label');
  btn.addEventListener('click', () => run(btn, nmsg, async () => {
    input.disabled = true;
    try {
      const j = await api('update_node', { node_id: n.id, label: input.value.trim() });
      n.label = (j.node && typeof j.node.label === 'string') ? j.node.label : input.value.trim();
      say(nmsg, 'Saved.');
      refreshPins(state);
      refreshSpawnOptions(state);
      refreshLinkLabels(state);
    } finally { input.disabled = false; }
  }));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } });

  const thumb = n.preview_url
    ? el('img', { class: 'thumb', src: n.preview_url, alt: '', loading: 'lazy' })
    : el('div', { class: 'thumb', 'aria-hidden': 'true' });

  const pinLine = el('div', { class: 'row', style: 'margin-top:8px' });
  paintPinLine(state, n, pinLine);
  n._pinLine = pinLine;

  const links = el('div', { class: 'links' });
  n._linksEl = links;
  paintLinks(state, n, links);

  return el('div', { class: 'node' },
    thumb,
    el('div', {},
      el('div', { class: 'nlbl' }, el('span', { class: 'lbl', style: 'margin:0;width:100%' }, 'Standpoint ' + ((n.ordinal ?? 0) + 1)), input, btn, nmsg),
      pinLine,
      el('div', { class: 'lbl', style: 'margin-top:10px' }, 'Walk links — connect to'),
      links,
    ),
  );
}

function paintPinLine(state, n, line) {
  line.innerHTML = '';
  const pmsg = el('span', { class: 'small', role: 'status' });
  if (!state.floorplan) {
    line.append(el('span', { class: 'small' }, 'No floorplan on this property yet.'));
    return;
  }
  if (n.pin && typeof n.pin.x === 'number') {
    line.append(
      el('span', { class: 'small' }, 'On the plan at ' + Math.round(n.pin.x * 100) + '%, ' + Math.round(n.pin.y * 100) + '%'),
      el('button', { class: 'btn sm ghost', type: 'button', onclick: (ev) => run(ev.currentTarget, pmsg, async () => {
        await api('update_node', { node_id: n.id, pin: null });
        n.pin = null;
        paintPinLine(state, n, line);
        refreshPins(state);
      }) }, 'Remove pin'),
      pmsg,
    );
  } else {
    line.append(
      el('span', { class: 'small' }, 'Not on the floorplan.'),
      el('button', { class: 'btn sm ghost', type: 'button', onclick: (ev) => run(ev.currentTarget, pmsg, async () => {
        const pin = { x: 0.5, y: 0.5 };
        const j = await api('update_node', { node_id: n.id, pin });
        n.pin = (j.node && j.node.pin) || pin;
        paintPinLine(state, n, line);
        refreshPins(state);
        say(state.msg, 'Pin placed in the middle of the plan — drag it (or use the arrow keys on it) to the right spot.');
        const p = state._pinEls && state._pinEls.get(n.id);
        if (p) p.focus();
      }) }, 'Place on plan'),
      pmsg,
    );
  }
}

function paintLinks(state, n, box) {
  box.innerHTML = '';
  const others = state.nodes.filter(o => o.id !== n.id);
  if (!others.length) { box.append(el('span', { class: 'small' }, 'No other standpoints yet.')); return; }
  for (const o of others) {
    const cb = el('input', { type: 'checkbox', checked: n.links.includes(o.id) });
    const lab = el('label', {}, cb, el('span', { class: 'linklabel', dataset: { node: o.id } }, nodeName(state, o)));
    cb.addEventListener('change', async () => {
      const want = cb.checked;
      cb.disabled = true;
      const msg = state.msg;
      try {
        /* Both directions, so a walk works whichever end it starts from. */
        const mine = want ? Array.from(new Set([...n.links, o.id])) : n.links.filter(x => x !== o.id);
        const theirs = want ? Array.from(new Set([...o.links, n.id])) : o.links.filter(x => x !== n.id);
        const j1 = await api('update_node', { node_id: n.id, links: mine });
        n.links = (j1.node && Array.isArray(j1.node.links)) ? j1.node.links : mine;
        const j2 = await api('update_node', { node_id: o.id, links: theirs });
        o.links = (j2.node && Array.isArray(j2.node.links)) ? j2.node.links : theirs;
        cb.checked = n.links.includes(o.id);
        // mirror the other node's checkbox for this one
        if (o._linksEl) {
          const other = o._linksEl.querySelector('span[data-node="' + n.id + '"]');
          if (other) other.previousSibling.checked = o.links.includes(n.id);
        }
        say(msg, want ? 'Linked ' + nodeName(state, n) + ' and ' + nodeName(state, o) + '.' : 'Unlinked ' + nodeName(state, n) + ' and ' + nodeName(state, o) + '.');
      } catch (e) {
        cb.checked = !want;
        say(msg, friendly(e), true);
      } finally { cb.disabled = false; }
    });
    box.append(lab);
  }
}
function refreshLinkLabels(state) {
  for (const n of state.nodes) {
    if (!n._linksEl) continue;
    n._linksEl.querySelectorAll('span.linklabel').forEach(s => {
      const o = state.nodes.find(x => x.id === s.dataset.node);
      if (o) s.textContent = nodeName(state, o);
    });
  }
}

/* ---------- floorplan with draggable pins ----------
   Same rules as the capture page: a pin is a fraction of the image box
   (origin top-left), and the box takes its aspect ratio from the image's
   natural size so the fractions stay true at any width. */
function planSection(state) {
  const sec = el('section', { class: 'ed' }, el('h3', { text: 'Floorplan' }));
  if (!state.floorplan || !state.floorplan.url) {
    sec.append(el('p', { class: 'small' }, 'No floorplan was added for this property. Add one from the capture page ("Capture more") and the standpoints can be pinned to it here.'));
    return sec;
  }
  sec.append(el('p', { class: 'small', style: 'margin-bottom:10px' }, 'Drag a pin to where that standpoint is. Keyboard: focus a pin and use the arrow keys (hold Shift for bigger steps).'));
  const img = el('img', { src: state.floorplan.url, alt: 'Floorplan of ' + (state.tour.property.address || 'the property') });
  const box = el('div', { class: 'planbox' }, img);
  img.addEventListener('load', () => {
    if (img.naturalWidth && img.naturalHeight) box.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
  });
  img.addEventListener('error', () => {
    sec.append(el('p', { class: 'err', text: 'The floorplan image could not be loaded — its link may have expired. Close and reopen the editor to get a fresh one.' }));
  });
  state._planBox = box;
  state._pinEls = new Map();
  sec.append(box, el('p', { class: 'small', role: 'status', style: 'margin-top:8px' }));
  state._planMsg = sec.lastChild;
  refreshPins(state);
  return sec;
}

function refreshPins(state) {
  const box = state._planBox;
  if (!box) return;
  box.querySelectorAll('.pin').forEach(p => p.remove());
  state._pinEls.clear();
  for (const n of state.nodes) {
    if (!n.pin || typeof n.pin.x !== 'number' || typeof n.pin.y !== 'number') continue;
    const p = el('button', { class: 'pin', type: 'button', 'aria-label': nodeName(state, n) + ' — drag or use arrow keys to move', title: nodeName(state, n) }, nodeName(state, n));
    p.style.left = (clamp01(n.pin.x) * 100) + '%';
    p.style.top = (clamp01(n.pin.y) * 100) + '%';
    wirePin(state, n, p, box);
    box.append(p);
    state._pinEls.set(n.id, p);
  }
}

function wirePin(state, n, p, box) {
  let dragging = false, moved = false, saving = false, saveTimer = null;
  let grab = { x: 0, y: 0 };   // where on the pin the finger landed, as a fraction offset
  const place = (x, y) => { p.style.left = (x * 100) + '%'; p.style.top = (y * 100) + '%'; };
  const current = () => ({ x: parseFloat(p.style.left) / 100, y: parseFloat(p.style.top) / 100 });
  const fromEvent = (ev) => {
    const r = box.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  };
  const save = async (pin) => {
    saving = true;
    p.classList.add('saving');
    p.setAttribute('aria-busy', 'true');
    try {
      const j = await api('update_node', { node_id: n.id, pin });
      n.pin = (j.node && j.node.pin) || pin;
      say(state._planMsg, nodeName(state, n) + ' pinned at ' + Math.round(n.pin.x * 100) + '%, ' + Math.round(n.pin.y * 100) + '%.');
      if (n._pinLine) paintPinLine(state, n, n._pinLine);
    } catch (e) {
      place(n.pin.x, n.pin.y);
      say(state._planMsg, 'Could not move the pin: ' + friendly(e), true);
    } finally { saving = false; p.classList.remove('saving'); p.removeAttribute('aria-busy'); }
  };
  p.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (saving) return;   // one move at a time — wait for the last one to land
    const at = fromEvent(ev), cur = current();
    grab = { x: cur.x - at.x, y: cur.y - at.y };
    dragging = true; moved = false;
    p.classList.add('drag');
    p.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  const under = (ev) => { const at = fromEvent(ev); return { x: clamp01(at.x + grab.x), y: clamp01(at.y + grab.y) }; };
  p.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    moved = true;
    const { x, y } = under(ev);
    place(x, y);
  });
  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    p.classList.remove('drag');
    try { p.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
    if (!moved) return;
    save(under(ev));
  };
  p.addEventListener('pointerup', end);
  p.addEventListener('pointercancel', (ev) => { dragging = false; p.classList.remove('drag'); place(n.pin.x, n.pin.y); });
  p.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.05 : 0.01;
    let dx = 0, dy = 0;
    if (ev.key === 'ArrowLeft') dx = -step; else if (ev.key === 'ArrowRight') dx = step;
    else if (ev.key === 'ArrowUp') dy = -step; else if (ev.key === 'ArrowDown') dy = step;
    else return;
    ev.preventDefault();
    const cur = { x: parseFloat(p.style.left) / 100, y: parseFloat(p.style.top) / 100 };
    const next = { x: clamp01(cur.x + dx), y: clamp01(cur.y + dy) };
    place(next.x, next.y);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(next), 500);
  });
}

/* ---------- opening view ---------- */
function spawnSection(state) {
  const t = state.tour;
  const sel = el('select', { class: 'field', style: 'max-width:360px', 'aria-label': 'Opening standpoint' });
  state._spawnSel = sel;
  refreshSpawnOptions(state);
  const smsg = el('p', { class: 'msg', role: 'status' });
  const save = el('button', { class: 'btn sm', type: 'button' }, 'Save opening view');
  save.addEventListener('click', () => run(save, smsg, async () => {
    const node_id = sel.value;
    if (!node_id) throw new Error('Pick a standpoint first.');
    const yaw = (t.spawn && t.spawn.node_id === node_id && typeof t.spawn.yaw === 'number') ? t.spawn.yaw : 0;
    sel.disabled = true;
    try {
      const j = await api('update_tour', { tour_id: t.id, spawn: { node_id, yaw } });
      if (j.tour) { state.tour = j.tour; replaceTour(j.tour); }
      say(smsg, 'Saved. The tour now opens here.');
    } finally { sel.disabled = false; }
  }));
  return el('section', { class: 'ed' },
    el('h3', { text: 'Opening view' }),
    el('p', { class: 'small', style: 'margin-bottom:10px' }, 'Where the buyer starts. The view opens facing the direction the camera faced; choosing the exact opening angle is coming.'),
    el('div', { class: 'row' }, sel, save),
    smsg,
  );
}
function refreshSpawnOptions(state) {
  const sel = state._spawnSel;
  if (!sel) return;
  const cur = sel.value || (state.tour.spawn && state.tour.spawn.node_id) || '';
  sel.innerHTML = '';
  if (!state.nodes.length) { sel.append(el('option', { value: '' }, 'No standpoints yet')); sel.disabled = true; return; }
  for (const n of state.nodes) sel.append(el('option', { value: n.id, selected: n.id === cur }, nodeName(state, n)));
  if (!state.nodes.some(n => n.id === cur)) sel.selectedIndex = 0;
}

/* ---------- enquiries ---------- */
function leadsSection(state) {
  const sec = el('section', { class: 'ed' }, el('h3', { text: 'Enquiries' }));
  if (state.leadsError) {
    sec.append(el('p', { class: 'err', text: 'Could not load enquiries: ' + state.leadsError }));
    return sec;
  }
  const leads = state.leads || [];
  if (!leads.length) {
    sec.append(el('p', { class: 'small' }, 'No enquiries yet. Every message a buyer sends from the tour lands here, and is emailed to ' + ((state.tour.branding && state.tour.branding.email) || 'your agency address') + '.'));
    return sec;
  }
  sec.append(el('p', { class: 'small' }, leads.length + (leads.length === 1 ? ' enquiry' : ' enquiries') + ', newest first.'));
  for (const L of leads) {
    const contact = String(L.contact || '').trim();
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact);
    const isPhone = !isEmail && /^[+\d][\d\s().-]{5,}$/.test(contact);
    const contactEl = isEmail ? el('a', { href: 'mailto:' + contact }, contact)
      : isPhone ? el('a', { href: 'tel:' + contact.replace(/[^+\d]/g, '') }, contact)
      : el('span', {}, contact || 'no contact given');
    let delivery;
    if (L.notified_at) delivery = el('span', { class: 'ok', title: fullDate(L.notified_at) }, 'Emailed ' + when(L.notified_at));
    else if (L.notify_error) delivery = el('span', { class: 'err' }, 'Not emailed: ' + L.notify_error, el('span', { class: 'small', style: 'display:block;font-weight:400' }, (/RESEND_API_KEY/i.test(L.notify_error) ? 'No email provider is configured yet — ask M3XI to add RESEND_API_KEY. ' : '') + 'The enquiry is safe here meanwhile.'));
    else delivery = el('span', { class: 'small' }, 'Email on its way');
    sec.append(el('div', { class: 'lead-item' },
      el('div', { class: 'lh' },
        el('div', {}, el('b', { text: L.name || 'Someone' }), ' · ', contactEl),
        el('span', { class: 'meta', title: fullDate(L.created_at) }, when(L.created_at) + (L.node_label ? ' · from ' + L.node_label : '')),
      ),
      el('div', { class: 'body', text: L.message || '(no message)' }),
      el('div', { class: 'meta', style: 'margin-top:8px' }, delivery),
    ));
  }
  return sec;
}

/* ===========================================================================
   DEV MOCK (localhost + ?mock=1 only). Shapes follow docs/TOUR_API.md and the
   m3ix-spatial function exactly: list_tours → { tours: TourSummary[] },
   get_tour → { tour, rooms, nodes (with preview_url), floorplan:{url} },
   list_leads → { leads: [...] }, writes → { ok:true, tour|room|node }.
   =========================================================================== */
function mockData() {
  const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const svg = (w, h, body) => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + body + '</svg>');
  const plan = svg(1200, 800,
    '<rect width="1200" height="800" fill="#fff"/><g fill="none" stroke="#161512" stroke-width="8">' +
    '<rect x="40" y="40" width="560" height="720"/><rect x="600" y="40" width="560" height="360"/><rect x="600" y="400" width="560" height="360"/></g>' +
    '<g font-family="Arial" font-size="40" fill="#5f5b50" text-anchor="middle"><text x="320" y="410">HALLWAY</text><text x="880" y="230">KITCHEN</text><text x="880" y="590">BEDROOM</text></g>');
  const pano = (label, hue) => svg(400, 200,
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(' + hue + ',40%,70%)"/><stop offset="1" stop-color="hsl(' + hue + ',30%,35%)"/></linearGradient></defs>' +
    '<rect width="400" height="200" fill="url(#g)"/><text x="200" y="110" font-family="Arial" font-size="34" font-weight="bold" fill="#fff" text-anchor="middle">' + label + '</text>');

  const P1 = uuid(1), P2 = uuid(2), P3 = uuid(3);
  const T1 = uuid(11), T2 = uuid(12), T3 = uuid(13);
  const R_HALL = uuid(101), R_KIT = uuid(102), R_BED = uuid(103), R2_LOUNGE = uuid(104);
  const N_HALL = uuid(201), N_KIT1 = uuid(202), N_KIT2 = uuid(203), N_BED = uuid(204), N2_L1 = uuid(205), N2_L2 = uuid(206);

  const summary = (t) => ({
    id: t.id, slug: t.slug, status: t.status, title: t.title, branding: t.branding, spawn: t.spawn,
    view_key: t.view_key, published_at: t.published_at, created_at: t.created_at,
    property: { id: t.property_id, address: t.address, has_floorplan: !!t.floorplan },
    counts: { nodes: t.nodes.filter(n => n.status === 'active').length, rooms: t.rooms.length, leads: t.leads.length },
    urls: { preview: '/tour/?t=' + encodeURIComponent(t.slug) + '&vk=' + encodeURIComponent(t.view_key || ''), live: '/tour/?t=' + encodeURIComponent(t.slug) },
  });

  const node = (id, room_id, ordinal, label, pin, links, hue, stable) => ({
    id, room_id, stable_key: stable, ordinal, label, pin, north_deg: null, links, source: 'phone-photosphere',
    captured_at: ago(30), width: 4096, height: 2048, bytes: 1843200, preview_path: 'captures/x/' + stable + '-preview.jpg', pano_path: 'captures/x/' + stable + '.jpg',
    status: 'active', _preview: pano(label, hue),
  });

  const tours = [
    {
      id: T1, slug: '14-example-street-sw1a', status: 'unlisted', title: '14 Example Street', property_id: P1,
      address: '14 Example Street, London SW1A 1AA',
      branding: { name: 'Example & Co', email: 'hello@example.co.uk', phone: '020 7946 0000', colour: '#d0402b', website: 'https://example.co.uk', logo_path: null },
      spawn: { node_id: N_HALL, yaw: 0 }, view_key: 'k7Qp2xLm', published_at: null, created_at: ago(26),
      floorplan: plan,
      rooms: [
        { id: R_HALL, name: 'Hallway', ordinal: 0, stable_key: 'r-hallway', scan: null, edited_at: null },
        { id: R_KIT, name: 'Kitchen', ordinal: 1, stable_key: 'r-kitchen', scan: null, edited_at: null },
        { id: R_BED, name: 'Bedroom', ordinal: 2, stable_key: 'r-bedroom', scan: null, edited_at: null },
      ],
      nodes: [
        node(N_HALL, R_HALL, 0, 'Hallway', { x: 0.25, y: 0.5 }, [N_KIT1, N_BED], 30, 'r-hallway-n0'),
        node(N_KIT1, R_KIT, 0, 'Kitchen — door', { x: 0.62, y: 0.3 }, [N_HALL, N_KIT2], 120, 'r-kitchen-n0'),
        node(N_KIT2, R_KIT, 1, 'Kitchen — window', { x: 0.88, y: 0.2 }, [N_KIT1], 150, 'r-kitchen-n1'),
        node(N_BED, R_BED, 0, 'Bedroom', { x: 0.75, y: 0.72 }, [N_HALL], 210, 'r-bedroom-n0'),
      ],
      leads: [
        { id: uuid(301), name: 'Priya Shah', contact: 'priya@example.com', message: 'Is the kitchen extension included in the lease? Could I view on Saturday morning?', node_label: 'Kitchen — window', notified_at: ago(2), notify_error: null, created_at: ago(2.1) },
        { id: uuid(302), name: 'Tom Reilly', contact: '07700 900123', message: 'Keen. What is the service charge?', node_label: 'Hallway', notified_at: null, notify_error: 'RESEND_API_KEY is not set', created_at: ago(20) },
      ],
    },
    {
      id: T2, slug: 'flat-3-riverside-court-e14', status: 'published', title: 'Flat 3, Riverside Court', property_id: P2,
      address: 'Flat 3, Riverside Court, London E14 9XY',
      branding: { name: 'Example & Co', email: 'hello@example.co.uk', phone: '020 7946 0000', colour: '#2e7d4f', website: 'https://example.co.uk', logo_path: null },
      spawn: { node_id: N2_L1, yaw: 0 }, view_key: 'Zx91ab2Q', published_at: ago(72), created_at: ago(100),
      floorplan: null,
      rooms: [{ id: R2_LOUNGE, name: 'Lounge', ordinal: 0, stable_key: 'r-lounge', scan: null, edited_at: null }],
      nodes: [
        node(N2_L1, R2_LOUNGE, 0, 'Lounge', null, [N2_L2], 200, 'r-lounge-n0'),
        node(N2_L2, R2_LOUNGE, 1, 'Lounge — balcony', null, [N2_L1], 190, 'r-lounge-n1'),
      ],
      leads: [],
    },
    {
      id: T3, slug: '9-old-mill-lane-ox2', status: 'archived', title: null, property_id: P3,
      address: '9 Old Mill Lane, Oxford OX2 6AB',
      branding: { name: 'Example & Co', email: 'hello@example.co.uk', phone: '', colour: '#d0402b', website: '', logo_path: null },
      spawn: null, view_key: 'mm3kPq0R', published_at: null, created_at: ago(400),
      floorplan: null, rooms: [], nodes: [], leads: [],
    },
  ];
  return { tours, summary, uuid };
}

let MOCK_DB = null;
async function mock(action, body) {
  if (!MOCK_DB) MOCK_DB = mockData();
  await new Promise(r => setTimeout(r, 250));
  const { tours, summary } = MOCK_DB;
  const find = () => {
    const t = tours.find(x => x.id === body.tour_id || x.slug === body.slug);
    if (!t) throw new Error('That tour no longer exists.');
    return t;
  };
  const findNode = () => {
    for (const t of tours) { const n = t.nodes.find(x => x.id === body.node_id); if (n) return { t, n }; }
    throw new Error('node not found');
  };
  const publicNode = (n) => { const { _preview, ...rest } = n; return { ...rest, preview_url: _preview }; };
  switch (action) {
    case 'list_tours': return { tours: tours.map(summary) };
    case 'get_tour': { const t = find(); return { tour: summary(t), rooms: t.rooms, nodes: t.nodes.filter(n => n.status === 'active').map(publicNode), floorplan: t.floorplan ? { url: t.floorplan } : null }; }
    case 'list_leads': { const t = find(); return { leads: t.leads.slice() }; }
    case 'go_live': { const t = find(); if (!t.nodes.some(n => n.status === 'active')) throw new Error('This tour has no photos yet.'); t.status = 'published'; t.published_at = new Date().toISOString(); return { ok: true, tour: summary(t) }; }
    case 'unpublish': { const t = find(); t.status = 'unlisted'; return { ok: true, tour: summary(t) }; }
    case 'archive': { const t = find(); t.status = 'archived'; return { ok: true, tour: summary(t) }; }
    case 'rotate_view_key': { const t = find(); t.view_key = Math.random().toString(36).slice(2, 10); return { ok: true, tour: summary(t) }; }
    case 'delete_tour': { const t = find(); tours.splice(tours.indexOf(t), 1); return { ok: true, objects_removed: t.nodes.length * 2 }; }
    case 'update_tour': {
      const t = find();
      if (typeof body.title === 'string') t.title = body.title.slice(0, 120);
      if (body.branding) t.branding = { ...t.branding, ...body.branding, colour: /^#[0-9a-f]{6}$/i.test(body.branding.colour || '') ? body.branding.colour : t.branding.colour };
      if (body.spawn && body.spawn.node_id) t.spawn = { node_id: body.spawn.node_id, yaw: Number(body.spawn.yaw) || 0 };
      return { ok: true, tour: summary(t) };
    }
    case 'update_room': {
      for (const t of tours) { const r = t.rooms.find(x => x.id === body.room_id); if (r) { if (body.name) r.name = String(body.name).trim().slice(0, 60); r.edited_at = new Date().toISOString(); return { ok: true, room: r }; } }
      throw new Error('room not found');
    }
    case 'update_node': {
      const { t, n } = findNode();
      if ('pin' in body) n.pin = body.pin && typeof body.pin.x === 'number' ? { x: clamp01(body.pin.x), y: clamp01(body.pin.y) } : null;
      if (typeof body.label === 'string') n.label = body.label.slice(0, 60);
      if (Array.isArray(body.links)) { const ok = new Set(t.nodes.filter(x => x.status === 'active').map(x => x.id)); n.links = body.links.filter(l => ok.has(l) && l !== n.id); }
      if (body.status === 'deleted') n.status = 'deleted';
      n.edited_at = new Date().toISOString();
      const { _preview, ...rest } = n;
      return { ok: true, node: rest };
    }
    default: throw new Error('unknown action ' + action);
  }
}

/* ===========================================================================
   GO
   =========================================================================== */
window.__tours = { get tours() { return tours; }, cards, MOCK };
showLoading();
boot();
