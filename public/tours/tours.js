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
  blk.append(scanRow(state, room));
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
   ROOM SCANS  (Phase 2)

   A room may carry one Gaussian-splat scan, so a buyer can walk it instead of
   only turning on the spot. Two things are true of that scan and they shape
   everything below:

   1. It is a recording. What the phone never saw stays missing. Nothing is
      filled in, so the agent is shown the holes before anyone else sees them.
   2. Where the floor is, which way is up and what you can walk on are worked
      out ONCE, here, in the agent's own browser — never again in a visitor's.
      That is what facts.json is, and it is uploaded next to the scan.

   The order (docs/TOUR_API.md → Room scans) is always:
      read the file → centres → computeFacts in a worker → show the agent what
      the scan contains → scan_upload_url → PUT scan → PUT facts.json →
      attach_scan.
   Nothing is uploaded before the agent has seen the result and said yes.
   =========================================================================== */

const SCAN_EXT = ['ply', 'spz', 'splat', 'ksplat'];
const SCAN_MAX_BYTES = 250 * 1024 * 1024;    // the tours bucket's own per-object cap
const SCAN_WARN_BYTES = 120 * 1024 * 1024;   // still works; a .spz would be kinder

/* The worker is made from a blob, and a blob has no base URL to resolve
   against, so both module paths are baked in absolute. */
const MOD_SPLATPARSE = new URL('/tour/splatparse.js', location.origin).href;
/* On localhost only, ?facts=<path> points the worker at another copy of the
   measuring module. It is deliberately NOT overridable from the query string:
   the worker imports this URL as a module, so an override would be an
   arbitrary-code hole wearing a dev-tool costume. */
const MOD_SCANFACTS = new URL('/tour/scanfacts.js', location.origin).href;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function fileExt(name) { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
function mbs(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return n + ' bytes';
  const mb = n / (1024 * 1024);
  if (mb < 1) return Math.round(n / 1024) + ' KB';
  return (mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
}
function count(n) { return Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—'; }
function dp(v, places) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(places) : '—'; }
function todayLocal() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function dayWords(iso) {
  if (!iso) return 'not recorded';
  const d = new Date(String(iso).length <= 10 ? String(iso) + 'T12:00:00' : iso);
  return isNaN(d) ? String(iso) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
/* {axis:'z',sign:-1} → "−Z", and → "z-" for the backend's summary. */
function upAxis(up) { return up && typeof up === 'object' ? String(up.axis || '') : String(up || '')[0] || ''; }
function upSign(up) { return up && typeof up === 'object' ? (Number(up.sign) < 0 ? -1 : 1) : (String(up || '')[1] === '-' ? -1 : 1); }
function upLabel(up) { const a = upAxis(up); return a ? (upSign(up) < 0 ? '−' : '+') + a.toUpperCase() : '—'; }
function upCode(up) { const a = upAxis(up).toLowerCase(); return /^[xyz]$/.test(a) ? a + (upSign(up) < 0 ? '-' : '+') : ''; }
function upSentence(up) {
  const a = upAxis(up).toLowerCase();
  if (!a) return 'We could not tell which way was up in this scan.';
  if (a === 'y' && upSign(up) > 0) return 'The scan was already the right way up (+Y).';
  return 'The scan was recorded with ' + upLabel(up) + ' pointing at the ceiling, so the viewer turns it upright before anyone walks it.';
}
/* A filename the backend's SAFE_NAME will accept. The extension is the format
   we actually read, not the one the file happened to be called: a 3DGS PLY
   saved as "room.splat" is a .ply, and the object in storage has to say so or
   the viewer picks the wrong reader for it. */
function safeScanName(name, format) {
  const ext = (SCAN_EXT.includes(String(format || '')) ? String(format) : fileExt(name)) || 'ply';
  let base = String(name || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9\-_.]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+/g, '-');
  if (!base) base = 'scan';
  return base.slice(0, 48) + '.' + ext;
}

/* ---------- the worker that reads and measures a scan ----------
   Everything heavy happens in here: hashing 91 MB, pulling 369,006 centres
   out of it, and the grid work. The tab stays answerable throughout, which is
   the whole reason this is a worker and not a promise on the main thread. */
function scanWorkerSource() {
  return `
const SPLATPARSE = ${JSON.stringify(MOD_SPLATPARSE)};
const SCANFACTS  = ${JSON.stringify(MOD_SCANFACTS)};
const post = (m) => self.postMessage(m);
const stage = (text) => post({ type: 'stage', text: String(text).slice(0, 160) });

/* scanfacts.js reports its own progress as (stage, detail) — "up" /
   "working out which way is up", "grid" / "measuring the floor", and so on.
   Its own words are already the right words, so they are what the agent
   reads; the map is only for a stage that arrives without a sentence. We
   never invent a step that did not happen. */
const STAGE_TEXT = {
  up: 'Working out which way is up…', axis: 'Working out which way is up…',
  rotate: 'Turning the scan upright…',
  floor: 'Measuring the floor…', heights: 'Measuring the floor…', grid: 'Measuring the floor…',
  walls: 'Checking what you can walk on…', walk: 'Checking what you can walk on…',
  region: 'Checking what you can walk on…', reach: 'Checking what you can walk on…',
  spawn: 'Choosing where the buyer starts…'
};
const sentence = (s) => { const t = String(s).trim(); return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!…]$/.test(t) ? '' : '…'); };
function moduleStage(a, b) {
  let s = null;
  if (typeof b === 'string' && b.trim()) s = sentence(b);
  else if (typeof a === 'string') s = STAGE_TEXT[a.toLowerCase()] || sentence(a);
  else if (a && typeof a === 'object') s = STAGE_TEXT[String(a.stage || '').toLowerCase()] || (a.text || a.label ? sentence(a.text || a.label) : null);
  if (s) stage(s);
}
async function sha256Hex(buf) {
  if (!(self.crypto && self.crypto.subtle)) return null;
  const d = await self.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

let job = null;

async function measure(positions, points) {
  let mod;
  try { mod = await import(SCANFACTS); }
  catch (e) {
    throw new Error('The part that measures a room (' + SCANFACTS + ') could not be loaded: ' +
      ((e && e.message) || e) + '. Nothing has been uploaded.');
  }
  if (typeof mod.computeFacts !== 'function') {
    throw new Error('scanfacts.js loaded but does not export computeFacts, so this scan cannot be measured yet. Nothing has been uploaded.');
  }
  const source = { format: job.format, splats: job.splats || points, bytes: job.bytes, sha256: job.sha256 };
  /* progress is what scanfacts.js actually calls; onStage/onProgress are there
     so a module that names it differently still gets to speak. */
  const opts = { count: points, points: points, source: source, filename: job.filename, progress: moduleStage, onStage: moduleStage, onProgress: moduleStage };
  stage('Measuring the room — which way is up, where the floor is, what you can walk on…');
  let facts = null, firstError = null;
  const shapes = [
    () => mod.computeFacts(positions, opts),
    () => mod.computeFacts(Object.assign({ positions: positions }, opts))
  ];
  for (const call of shapes) {
    try {
      const r = await call();
      if (r && typeof r === 'object' && r.up && r.grid) { facts = r; break; }
      if (!firstError) firstError = new Error('computeFacts did not return the facts for this scan (no up-axis or grid in what came back).');
    } catch (e) { if (!firstError) firstError = (e instanceof Error ? e : new Error(String(e))); }
  }
  if (!facts) throw firstError;

  /* The module measures points; only this page knows the file they came out
     of. Fill in what it could not have known, and never overwrite what it did. */
  const s0 = (facts.source && typeof facts.source === 'object') ? facts.source : {};
  facts.source = {
    format: s0.format || job.format,
    splats: Number.isFinite(Number(s0.splats)) ? Number(s0.splats) : (job.splats || points),
    bytes: Number.isFinite(Number(s0.bytes)) ? Number(s0.bytes) : job.bytes,
    sha256: s0.sha256 || job.sha256 || null
  };
  if (facts.version == null) facts.version = 1;
  if (!facts.computed_at) facts.computed_at = new Date().toISOString();

  let json;
  try {
    const out = typeof mod.serialiseFacts === 'function' ? mod.serialiseFacts(facts) : facts;
    json = typeof out === 'string' ? out : JSON.stringify(out);
  } catch (e) { throw new Error('The measurements could not be written out: ' + ((e && e.message) || e)); }

  /* Read the summary back off the bytes we are about to upload, not off the
     object in memory — what the room row promises and what facts.json says
     have to be the same thing. */
  let wire;
  try { wire = JSON.parse(json); }
  catch (e) { throw new Error('The measurements came out malformed, so nothing was uploaded.'); }
  if (typeof wire.usable !== 'boolean') throw new Error('The measurements do not say whether the room is walkable, and a missing verdict is not a yes.');

  /* The row the backend stores. scanfacts.js exports the one function that
     knows how to write it; only fall back to reading the file if it does not. */
  let summary = null;
  if (typeof mod.factsSummary === 'function') { try { summary = mod.factsSummary(facts); } catch (e) { summary = null; } }
  if (!summary || typeof summary.usable !== 'boolean') {
    summary = {
      area_m2: wire.area_m2, holes_pct: wire.holes_pct, usable: wire.usable,
      up: wire.up && wire.up.axis ? wire.up.axis + (wire.up.sign === -1 ? '-' : '+') : '',
    };
  }

  post({
    type: 'done',
    json: json,
    bytesJson: json.length,
    summary: summary,
    review: {
      usable: wire.usable,
      area_m2: wire.area_m2, holes_pct: wire.holes_pct, walls: wire.walls,
      up: wire.up, floor_y: wire.floor_y, eye: wire.eye,
      grid: wire.grid ? { w: wire.grid.w, h: wire.grid.h, cell: wire.grid.cell } : null,
      warnings: Array.isArray(wire.warnings) ? wire.warnings.slice(0, 8) : [],
      splats: job.splats || points, sha256: job.sha256, format: job.format, bytes: job.bytes,
      sampled: !!job.sampled
    }
  });
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'parse') {
      job = { filename: m.filename, bytes: m.bytes, format: m.format, sha256: null, splats: null, sampled: false };
      stage('Fingerprinting the file…');
      job.sha256 = await sha256Hex(m.buffer);
      stage('Reading the scan…');
      let parsed = null;
      try {
        const sp = await import(SPLATPARSE);
        parsed = await sp.parseCentres(m.buffer, m.filename);
      } catch (e) {
        m.buffer = null;
        post({ type: 'needs-renderer', message: String((e && e.message) || e) });
        return;
      }
      m.buffer = null;   // let the 91 MB go before the grid work starts
      job.splats = parsed.total || parsed.count;
      job.sampled = !!parsed.sampled;
      if (parsed.format) job.format = parsed.format;
      stage('Reading… ' + Number(job.splats).toLocaleString() + ' points');
      if (!parsed.count) throw new Error('There are no splat centres in this file, so there is nothing to measure.');
      await measure(parsed.positions, parsed.count);
      return;
    }
    if (m.type === 'positions') {
      if (!job) throw new Error('Nothing to measure — start again.');
      job.splats = m.total || m.count;
      stage('Reading… ' + Number(job.splats).toLocaleString() + ' points');
      if (!m.count) throw new Error('The renderer opened the file but found no splat centres in it.');
      await measure(new Float32Array(m.positions, 0, m.count * 3), m.count);
      return;
    }
    throw new Error('Unknown worker request.');
  } catch (e) {
    post({ type: 'error', message: String((e && e.message) || e) });
  }
};
`;
}

/* ---------- .spz / .ksplat: no reader of our own, so borrow the renderer ----------
   splatparse.js deliberately refuses these two. Rather than ship a half-tested
   decoder, load the file in the splat renderer inside a hidden canvas and read
   the centres straight out of it. If that fails too, say so plainly: export a
   .ply and attach that. */
async function centresViaRenderer(file, onStage) {
  onStage('This format needs the splat renderer to open it — loading it…');
  let THREE, Spark;
  try {
    [THREE, Spark] = await Promise.all([import('three'), import('@sparkjsdev/spark')]);
  } catch (e) {
    throw new Error('The splat renderer could not be loaded, so a .' + fileExt(file.name) +
      ' cannot be read here. Export the scan as .ply (Scaniverse: Share → Export → PLY) and attach that instead.');
  }
  const canvas = el('canvas', { width: 32, height: 32, 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0;width:32px;height:32px' });
  document.body.append(canvas);
  let renderer = null;
  try {
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true }); } catch (e) { renderer = null; }
    onStage('Opening the scan in the renderer…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    /* onLoad alone never fires for a file the renderer cannot read — it simply
       goes quiet — so the mesh's own `initialized` promise is what turns a bad
       file into an error the agent can act on instead of a two-minute wait. */
    const ready = new Promise((resolve, reject) => {
      let m;
      try { m = new Spark.SplatMesh({ fileBytes: bytes, fileName: file.name, onLoad: () => resolve(m) }); }
      catch (e) { return reject(e); }
      if (m && m.initialized && typeof m.initialized.then === 'function') m.initialized.then(() => resolve(m), reject);
    });
    const mesh = await Promise.race([ready, new Promise((_, reject) => setTimeout(
      () => reject(new Error('The renderer did not finish opening this file within a minute.')), 60000))]);
    const src = mesh.packedSplats || mesh.splats;
    if (!src || !src.forEachSplat) throw new Error('The renderer opened the file but would not hand back the splat centres.');
    const total = src.getNumSplats ? src.getNumSplats() : 0;
    if (!total) throw new Error('The renderer opened the file and found no splats in it.');
    onStage('Reading the centres out of the renderer…');
    const out = new Float32Array(total * 3);
    let w = 0;
    src.forEachSplat((i, centre) => { if (w + 3 > out.length) return; out[w++] = centre.x; out[w++] = centre.y; out[w++] = centre.z; });
    try { if (mesh.dispose) mesh.dispose(); } catch (e) { /* nothing to dispose */ }
    return { positions: out, count: w / 3, total };
  } catch (e) {
    let why = String((e && e.message) || e).trim().replace(/\s*\.?$/, '');
    if (!/^The /.test(why)) why = 'The splat renderer could not open ' + file.name + ' — ' + why;
    throw new Error(why + '. Export the scan as .ply (Scaniverse: Share → Export → PLY) and attach that instead.');
  } finally {
    try { if (renderer) renderer.dispose(); } catch (e) { /* already gone */ }
    canvas.remove();
  }
}

/* ---------- uploading ---------- */
function progressBar() {
  const fill = el('i');
  const bar = el('div', { class: 'prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  return {
    bar,
    set(frac, label) {
      const p = Math.max(0, Math.min(1, Number(frac) || 0));
      fill.style.width = (p * 100) + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      if (label) bar.setAttribute('aria-valuetext', label);
    },
  };
}

/* fetch() cannot report how much of a 91 MB body has gone, and an agent
   watching a blank screen for four minutes assumes it has hung. XHR can. */
function putWithProgress(url, body, type, onProgress, hold) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (hold) hold.xhr = xhr;
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      if (hold) hold.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      if (xhr.status === 401 || xhr.status === 403) return reject(new Error('The upload was refused (HTTP ' + xhr.status + ') — the upload link may have expired.'));
      reject(new Error('The upload failed (HTTP ' + xhr.status + ')' + (xhr.responseText ? ': ' + String(xhr.responseText).slice(0, 200) : '') + '.'));
    };
    xhr.onerror = () => { if (hold) hold.xhr = null; reject(new Error('The upload was cut off — check your connection.')); };
    xhr.onabort = () => { if (hold) hold.xhr = null; reject(new Error('Upload cancelled.')); };
    xhr.ontimeout = () => { if (hold) hold.xhr = null; reject(new Error('The upload timed out.')); };
    xhr.send(body);
  });
}
async function putScan(url, body, type, onProgress, hold, path) {
  if (MOCK) return mockPut(path, body, onProgress);
  return putWithProgress(url, body, type, onProgress, hold);
}
/* Three goes, backing off. A dropped connection halfway through 91 MB is a
   bad afternoon, not a bad scan. */
async function withRetry(fn, tries, onRetry) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); }
    catch (e) {
      last = e;
      if (/cancelled/i.test(String(e && e.message))) throw e;
      if (i < tries - 1) { if (onRetry) onRetry(i + 2, tries, e); await sleep(1200 * Math.pow(2, i)); }
    }
  }
  throw last;
}

/* ---------- the row in the editor ---------- */
function scanRow(state, room) {
  const box = el('div', { class: 'scan', role: 'group', 'aria-label': 'Walk-through scan for ' + (room.name || 'this room') });
  paintScan(state, room, box);
  return box;
}

function lockScan(box, on) {
  box.querySelectorAll('button,input,select,a.btn').forEach(n => {
    if (n._keepLive) return;
    if (n.tagName === 'A') { n.setAttribute('aria-disabled', on ? 'true' : 'false'); return; }
    n.disabled = !!on;
  });
}

function paintScan(state, room, box) {
  box.innerHTML = '';
  const scan = room.scan && room.scan.path ? room.scan : null;
  box.classList.toggle('on', !!scan);
  box.classList.remove('no');
  if (scan) attachedScan(state, room, box);
  else emptyScan(state, room, box);
}

/* Nothing attached yet. */
function emptyScan(state, room, box, opts) {
  const msg = el('p', { class: 'why', role: 'status' });
  const input = el('input', {
    class: 'field', type: 'file', accept: '.ply,.spz,.splat,.ksplat',
    id: 'scan-' + room.id, 'aria-describedby': 'scanhow-' + room.id,
  });
  const date = el('input', { class: 'field', type: 'date', value: todayLocal(), max: todayLocal(), id: 'scanwhen-' + room.id });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    beginScan(state, room, box, file, date.value);
  });
  box.append(
    el('span', { class: 'lbl' }, (opts && opts.replacing) ? 'Replace the walk-through scan' : 'Add a walk-through scan (optional)'),
    el('p', { class: 'small', id: 'scanhow-' + room.id },
      'A scan lets a buyer walk this room instead of only turning on the spot. Scan it in Scaniverse on ' +
      '"Splat" mode — about five minutes a room, walking slowly with the floor in view — then export it here. ' +
      'Export .ply; if the file comes out over about 120 MB, export .spz instead so a buyer on a phone is not waiting.'),
    el('div', { class: 'row' },
      el('div', {}, el('label', { class: 'lbl', for: 'scan-' + room.id }, 'Scan file'), input),
      el('div', {}, el('label', { class: 'lbl', for: 'scanwhen-' + room.id }, 'Scanned on'), date),
    ),
    el('p', { class: 'note' }, 'The date is shown to the buyer, so it should be the day the room was actually scanned.'),
    msg,
  );
  if (opts && opts.replacing) {
    box.append(el('div', { class: 'row' }, el('button', {
      class: 'btn sm ghost', type: 'button', onclick: () => paintScan(state, room, box),
    }, 'Keep the scan that is there')));
  }
  return box;
}

/* Reading, measuring, uploading — one status line, one bar, one way out. */
function beginScan(state, room, box, file, scannedAt) {
  const ext = fileExt(file.name);
  const status = el('p', { class: 'small', role: 'status', style: 'margin-top:10px;font-weight:600' }, 'Reading the file… ' + mbs(file.size));
  const prog = progressBar();
  const err = el('p', { class: 'why' });
  const cancel = el('button', { class: 'btn sm ghost', type: 'button' }, 'Cancel');
  cancel._keepLive = true;
  const hold = { worker: null, xhr: null, cancelled: false };
  box._hold = hold;
  cancel.addEventListener('click', () => {
    hold.cancelled = true;
    if (hold.worker) { hold.worker.terminate(); hold.worker = null; }
    if (hold.xhr) { try { hold.xhr.abort(); } catch (e) { /* already done */ } }
    paintScan(state, room, box);
  });
  box.innerHTML = '';
  box.classList.add('on');
  box.append(
    el('span', { class: 'lbl' }, 'Walk-through scan'),
    el('p', { class: 'small' }, file.name + ' · ' + mbs(file.size)),
    status, prog.bar, err,
    el('div', { class: 'row' }, cancel),
  );
  const setStage = (t) => { if (!hold.cancelled) status.textContent = t; };
  const fail = (message) => {
    if (hold.cancelled) return;
    box.classList.add('no');
    say(err, message, true);
    prog.set(0);
    cancel.textContent = 'Start again';
  };

  // Refuse what the API would refuse anyway, before reading 91 MB off disk.
  if (!SCAN_EXT.includes(ext)) {
    return fail('A scan has to be a .ply, .spz, .splat or .ksplat file — "' + file.name + '" is not one. In Scaniverse: Share → Export → PLY.');
  }
  if (file.size > SCAN_MAX_BYTES) {
    return fail('That scan is ' + mbs(file.size) + ' and one file can be at most 250 MB. Export the same scan as .spz (Scaniverse: Share → Splat → SPZ) — it is usually about a tenth of the size and looks the same.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scannedAt || ''))) {
    return fail('Pick the date this room was scanned before choosing the file — the buyer is shown that date.');
  }

  (async () => {
    let buf;
    try { buf = await file.arrayBuffer(); }
    catch (e) { return fail('The file could not be read from this device: ' + friendly(e)); }
    if (hold.cancelled) return;

    let worker;
    try {
      const url = URL.createObjectURL(new Blob([scanWorkerSource()], { type: 'text/javascript' }));
      worker = new Worker(url, { type: 'module' });
      URL.revokeObjectURL(url);
    } catch (e) {
      return fail('This browser would not start the background worker that measures a scan: ' + friendly(e));
    }
    hold.worker = worker;
    worker.onerror = (e) => { if (!hold.cancelled) fail('The measuring worker stopped: ' + ((e && e.message) || 'unknown error') + '. Nothing has been uploaded.'); };
    worker.onmessage = async (ev) => {
      const m = ev.data || {};
      if (hold.cancelled) return;
      if (m.type === 'stage') return setStage(m.text);
      if (m.type === 'needs-renderer') {
        /* splatparse.js will not open .spz / .ksplat. Try the renderer. */
        try {
          const got = await centresViaRenderer(file, setStage);
          if (hold.cancelled) return;
          worker.postMessage({ type: 'positions', positions: got.positions.buffer, count: got.count, total: got.total }, [got.positions.buffer]);
        } catch (e) {
          worker.terminate(); hold.worker = null;
          fail(friendly(e));
        }
        return;
      }
      if (m.type === 'error') { worker.terminate(); hold.worker = null; return fail(m.message + ''); }
      if (m.type === 'done') {
        worker.terminate(); hold.worker = null;
        reviewScan(state, room, box, {
          file, scannedAt, json: m.json, review: m.review, summary: m.summary,
          format: (m.review && m.review.format) || ext,
        });
      }
    };
    try { worker.postMessage({ type: 'parse', buffer: buf, filename: file.name, bytes: file.size, format: ext }, [buf]); }
    catch (e) { worker.terminate(); hold.worker = null; fail('The file could not be handed to the worker: ' + friendly(e)); }
  })();
}

/* What the scan actually contains — shown before a single byte is uploaded. */
function reviewScan(state, room, box, job) {
  const r = job.review || {};
  box.innerHTML = '';
  box.classList.add('on');
  box.classList.toggle('no', !r.usable);
  const date = el('input', { class: 'field', type: 'date', value: job.scannedAt || todayLocal(), max: todayLocal(), id: 'scanwhen-' + room.id });
  const msg = el('p', { class: 'why', role: 'status' });

  box.append(
    el('span', { class: 'lbl' }, 'What this scan contains'),
    el('p', { class: 'small' }, job.file.name + ' · ' + mbs(job.file.size) + ' · ' + count(r.splats) + ' points · measured here, nothing uploaded yet'),
    el('div', { class: 'facts' },
      el('div', {}, el('b', { text: dp(r.area_m2, 1) }), el('span', {}, 'm² to walk')),
      el('div', {}, el('b', { text: dp(r.holes_pct, 1) + '%' }), el('span', {}, 'holes')),
      el('div', {}, el('b', { text: upLabel(r.up) }), el('span', {}, 'was up')),
      el('div', {}, el('b', { text: count(r.splats) }), el('span', {}, 'points')),
    ),
    el('p', { class: 'note' }, upSentence(r.up) + ' A scan is a recording: the ' + dp(r.holes_pct, 1) +
      '% the phone never saw stays missing — behind furniture, under worktops. Nothing is filled in.'),
  );
  if (Array.isArray(r.warnings) && r.warnings.length) {
    box.append(el('ul', { class: 'warns' }, r.warnings.map(w => el('li', { text: String(w) }))));
  }
  if (r.sampled) box.append(el('p', { class: 'note' }, 'The scan was measured from an even sample of its points, not every one — the numbers are the room, not the file.'));

  if (!r.usable) {
    box.append(
      el('div', { class: 'refuse' }, 'This scan has too little floor to walk — ' + dp(r.area_m2, 1) + ' m².',
        el('span', {}, 'Rescan the room slowly, keeping the floor in view the whole time, and walk the whole floor rather than turning on the spot. Nothing has been uploaded.')),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm ghost', type: 'button', onclick: () => paintScan(state, room, box) }, 'Choose another file')),
    );
    return;
  }

  const go = el('button', { class: 'btn sm', type: 'button' }, 'Upload and attach');
  go.addEventListener('click', () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) return say(msg, 'Give the date this room was scanned — the buyer is shown it.', true);
    job.scannedAt = date.value;
    uploadScan(state, room, box, job);
  });
  box.append(
    el('div', { class: 'row' },
      el('div', {}, el('label', { class: 'lbl', for: 'scanwhen-' + room.id }, 'Scanned on'), date),
    ),
    el('div', { class: 'row' }, go,
      el('button', { class: 'btn sm ghost', type: 'button', onclick: () => paintScan(state, room, box) }, 'Cancel')),
    el('p', { class: 'note' }, 'Uploading sends ' + mbs(job.file.size) + ' plus the measurements. The scan only appears to buyers once it is attached.'),
    msg,
  );
}

/* scan_upload_url → PUT the scan → PUT facts.json → attach_scan. */
function uploadScan(state, room, box, job) {
  const status = el('p', { class: 'small', role: 'status', style: 'margin-top:10px;font-weight:600' }, 'Asking for somewhere to put it…');
  const prog = progressBar();
  const err = el('p', { class: 'why' });
  const warn = el('p', { class: 'note' });
  const hold = { xhr: null, cancelled: false };
  const cancel = el('button', { class: 'btn sm ghost', type: 'button' }, 'Cancel');
  cancel._keepLive = true;
  cancel.addEventListener('click', () => {
    hold.cancelled = true;
    if (hold.xhr) { try { hold.xhr.abort(); } catch (e) { /* already done */ } }
    reviewScan(state, room, box, job);
  });
  box.innerHTML = '';
  box.classList.add('on');
  box.classList.remove('no');
  box.append(
    el('span', { class: 'lbl' }, 'Uploading the scan'),
    el('p', { class: 'small' }, job.file.name + ' · ' + mbs(job.file.size)),
    status, prog.bar, warn, err,
    el('div', { class: 'row' }, cancel),
  );

  (async () => {
    try {
      const slot = await api('scan_upload_url', {
        room_id: room.id, filename: safeScanName(job.file.name, job.format), bytes: job.file.size,
      });
      if (hold.cancelled) return;
      /* Plain text, not say(): this is advice about the file, not a result. */
      if (slot.warning) warn.textContent = slot.warning;

      status.textContent = 'Uploading the scan… 0 of ' + mbs(job.file.size);
      await withRetry((attempt) => {
        prog.set(0);
        if (attempt) status.textContent = 'Uploading the scan again (try ' + (attempt + 1) + ' of 3)…';
        return putScan(slot.upload_url, job.file, 'application/octet-stream', (sent, total) => {
          prog.set(sent / (total || job.file.size), mbs(sent) + ' of ' + mbs(total || job.file.size));
          status.textContent = 'Uploading the scan… ' + mbs(sent) + ' of ' + mbs(total || job.file.size);
        }, hold, slot.path);
      }, 3, (next, tries, e) => { say(err, friendly(e) + ' Trying again (' + next + ' of ' + tries + ')…', true); });
      if (hold.cancelled) return;
      say(err, '');
      prog.set(1);

      status.textContent = 'Uploading the measurements…';
      const factsBlob = new Blob([job.json], { type: 'application/json' });
      await withRetry(() => putScan(slot.facts_upload_url, factsBlob, 'application/json', null, hold, slot.facts_path), 3,
        (next, tries, e) => { say(err, friendly(e) + ' Trying again (' + next + ' of ' + tries + ')…', true); });
      if (hold.cancelled) return;
      say(err, '');

      status.textContent = 'Attaching it to ' + (room.name || 'the room') + '…';
      const r = job.review || {};
      const sent = {
        room_id: room.id, path: slot.path, facts_path: slot.facts_path,
        format: job.format, bytes: job.file.size, sha256: r.sha256 || null, splats: r.splats || null,
        summary: job.summary || { area_m2: r.area_m2, holes_pct: r.holes_pct, usable: !!r.usable, up: upCode(r.up) },
        scanned_at: job.scannedAt,
      };
      const j = await api('attach_scan', sent);
      if (hold.cancelled) return;
      /* The row the backend wrote is the truth; the local copy is only for a
         backend that answers ok without echoing the room back. */
      const { room_id, ...stored } = sent;
      room.scan = (j.room && j.room.scan) || { ...stored, attached_at: new Date().toISOString() };
      room.edited_at = (j.room && j.room.edited_at) || new Date().toISOString();
      paintScan(state, room, box);
      say(state.msg, 'Scan attached to ' + (room.name || 'the room') + '. Buyers can now walk it from any standpoint in that room.');
    } catch (e) {
      if (hold.cancelled) return;
      box.classList.add('no');
      say(err, friendly(e) + ' Nothing has been attached to the room.', true);
      status.textContent = 'Upload stopped.';
      cancel.textContent = 'Back';
      box.querySelector('.row').prepend(el('button', {
        class: 'btn sm', type: 'button', onclick: () => uploadScan(state, room, box, job),
      }, 'Try the upload again'));
    }
  })();
}

/* A scan is attached: what it is, when it was taken, and the two ways out. */
function attachedScan(state, room, box) {
  const s = room.scan || {};
  const sum = s.summary || {};
  const msg = el('p', { class: 'why', role: 'status' });
  const walkable = sum.usable === true;

  box.append(
    el('span', { class: 'lbl' }, 'Walk-through scan'),
    el('div', { class: 'facts' },
      el('div', {}, el('b', { text: String(s.format || fileExt(s.path) || '—').toUpperCase() }), el('span', {}, 'format')),
      el('div', {}, el('b', { text: mbs(s.bytes) }), el('span', {}, 'size')),
      el('div', {}, el('b', { text: count(s.splats) }), el('span', {}, 'points')),
      el('div', {}, el('b', { text: dp(sum.area_m2, 1) }), el('span', {}, 'm² to walk')),
      el('div', {}, el('b', { text: dp(sum.holes_pct, 1) + '%' }), el('span', {}, 'holes')),
      el('div', {}, el('b', { text: upLabel(sum.up) }), el('span', {}, 'was up')),
    ),
    el('p', { class: 'small', style: 'margin-top:9px' },
      'Scanned ' + dayWords(s.scanned_at) + (s.attached_at ? ' · attached ' + when(s.attached_at) : '')),
  );
  box.append(walkable
    ? el('p', { class: 'note' }, 'Buyers see "Walk this room" on every standpoint in ' + (room.name || 'this room') + '. The ' + dp(sum.holes_pct, 1) + '% the phone never saw stays missing — nothing is filled in.')
    : el('p', { class: 'why' }, 'This scan is not walkable, so the viewer will not offer it. Replace it with a slower scan that keeps the floor in view.'));

  /* The date the buyer is shown, fixable without re-uploading 90 MB. */
  const date = el('input', { class: 'field', type: 'date', value: /^\d{4}-\d{2}-\d{2}$/.test(String(s.scanned_at || '')) ? s.scanned_at : '', max: todayLocal(), id: 'scanwhen-' + room.id });
  const saveDate = el('button', { class: 'btn sm ghost', type: 'button' }, 'Save date');
  saveDate.addEventListener('click', () => run(saveDate, msg, async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) throw new Error('Give the date as a real date — the buyer is shown it.');
    if (!s.path || !s.facts_path) throw new Error('This scan was attached before dates could be edited here. Replace it to set the date.');
    lockScan(box, true);
    try {
      const j = await api('attach_scan', {
        room_id: room.id, path: s.path, facts_path: s.facts_path, format: s.format, bytes: s.bytes,
        sha256: s.sha256 || null, splats: s.splats || null, summary: sum, scanned_at: date.value,
      });
      room.scan = (j.room && j.room.scan) || { ...s, scanned_at: date.value };
      paintScan(state, room, box);
      say(state.msg, 'Scan date updated.');
    } finally { lockScan(box, false); }
  }));

  const replace = el('button', {
    class: 'btn sm ghost', type: 'button',
    onclick: () => { box.innerHTML = ''; box.classList.remove('on'); emptyScan(state, room, box, { replacing: true }); },
  }, 'Replace');

  const remove = el('button', {
    class: 'btn sm ghost', type: 'button', style: 'color:var(--red)',
    onclick: () => {
      const confirmRow = el('div', { class: 'strip danger', style: 'margin-top:10px' },
        el('p', { class: 'small' }, 'Remove the walk-through scan from ' + (room.name || 'this room') +
          '? The buyer goes back to turning on the spot from the photos, and the scan file is deleted. The photos are not touched.'),
        el('div', { class: 'row' },
          el('button', {
            class: 'btn sm red', type: 'button', onclick: (ev) => run(ev.currentTarget, msg, async () => {
              lockScan(box, true);
              try {
                const j = await api('remove_scan', { room_id: room.id });
                room.scan = null;
                paintScan(state, room, box);
                say(state.msg, 'Scan removed from ' + (room.name || 'the room') +
                  (j && j.objects_removed ? ' and its ' + j.objects_removed + ' file' + (j.objects_removed === 1 ? '' : 's') + ' deleted.' : '.'));
              } finally { lockScan(box, false); }
            }),
          }, 'Remove the scan'),
          el('button', { class: 'btn sm ghost', type: 'button', onclick: () => confirmRow.remove() }, 'Keep it'),
        ),
      );
      box.append(confirmRow);
    },
  }, 'Remove');

  box.append(
    el('div', { class: 'row' },
      el('div', {}, el('label', { class: 'lbl', for: 'scanwhen-' + room.id }, 'Scanned on'), date),
      el('div', { style: 'align-self:flex-end' }, saveDate),
      el('div', { style: 'align-self:flex-end' }, replace),
      el('div', { style: 'align-self:flex-end' }, remove),
    ),
    msg,
  );
  return box;
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
  /* Storage, as far as the mock is concerned: the set of object paths that
     have actually been PUT. attach_scan checks it, exactly as the real
     function checks the bucket, so the order of the flow is really tested. */
  return { tours, summary, uuid, objects: new Set() };
}

/* A simulated PUT: real byte counts, real elapsed time, no network. */
async function mockPut(path, body, onProgress) {
  if (!MOCK_DB) MOCK_DB = mockData();
  const total = (body && (body.size ?? body.byteLength ?? body.length)) || 0;
  const steps = total > 4e6 ? 12 : 3;
  for (let i = 1; i <= steps; i++) {
    await sleep(90);
    if (onProgress) onProgress(Math.round((total * i) / steps), total);
  }
  MOCK_DB.objects.add(path);
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
  const findRoom = () => {
    for (const t of tours) { const r = t.rooms.find(x => x.id === body.room_id); if (r) return { t, r }; }
    throw new Error('Room not found');
  };
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
    /* ---- room scans: the same refusals, in the same order, as the real
           function (supabase/functions/m3ix-spatial/index.ts) ---- */
    case 'scan_upload_url': {
      const { t } = findRoom();
      const filename = String(body.filename || '').toLowerCase().replace(/[^a-z0-9\-_.]+/g, '-').slice(0, 80);
      if (!/^[a-z0-9][a-z0-9\-_.]{0,80}$/.test(filename)) throw new Error('A plain filename is required, e.g. living-room.spz');
      const ext = fileExt(filename);
      if (!SCAN_EXT.includes(ext)) throw new Error('A scan has to be a .ply, .spz, .splat or .ksplat file — "' + filename + '" is not one.');
      const bytes = Number(body.bytes);
      if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('bytes (the size of the file) is required');
      if (bytes > SCAN_MAX_BYTES) throw new Error('That scan is ' + Math.round(bytes / 1048576) + ' MB and one file can be at most 250 MB. Export the same scan as .spz (in Scaniverse: Share → Splat → SPZ) — it is usually about a tenth of the size and looks the same.');
      const rand = Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      const path = 'captures/' + t.property_id + '/scans/' + rand + '-' + filename;
      return {
        upload_url: 'mock:' + path, path,
        facts_upload_url: 'mock:' + path + '.facts.json', facts_path: path + '.facts.json',
        max_bytes: SCAN_MAX_BYTES,
        warning: bytes > SCAN_WARN_BYTES ? Math.round(bytes / 1048576) + ' MB will work, but it is a long download for a buyer on a phone. A .spz export is usually about a tenth of the size.' : null,
      };
    }
    case 'attach_scan': {
      const { t, r } = findRoom();
      const prefix = 'captures/' + t.property_id + '/scans';
      const path = String(body.path || ''), facts_path = String(body.facts_path || '');
      if (!path.startsWith(prefix + '/') || !facts_path.startsWith(prefix + '/')) throw new Error("That file is not in this property's scans folder — ask for a scan_upload_url first.");
      if (path === facts_path || !facts_path.endsWith('.json')) throw new Error('facts_path must be the .facts.json uploaded alongside the scan.');
      const format = String(body.format || '').toLowerCase() || fileExt(path);
      if (!SCAN_EXT.includes(format)) throw new Error('A scan has to be .ply, .spz, .splat or .ksplat.');
      const bytes = Number(body.bytes);
      if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('bytes (the size of the file) is required');
      if (bytes > SCAN_MAX_BYTES) throw new Error('A scan can be at most 250 MB.');
      const sIn = body.summary || {};
      if (typeof sIn.usable !== 'boolean') throw new Error('summary is required: { area_m2, holes_pct, usable, up } taken from the facts you computed.');
      const round2 = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
      const upStr = String(sIn.up || '').toLowerCase();
      const summary = { area_m2: round2(sIn.area_m2), holes_pct: round2(sIn.holes_pct), usable: sIn.usable, up: /^[xyz][+-]$/.test(upStr) ? upStr : null };
      const claimed = t.rooms.find(x => x.id !== r.id && x.scan && (x.scan.path === path || x.scan.facts_path === facts_path));
      if (claimed) throw new Error('That scan is already attached to "' + claimed.name + '". Upload it again for this room.');
      const missing = [MOCK_DB.objects.has(path) ? '' : 'the scan', MOCK_DB.objects.has(facts_path) ? '' : 'its facts.json'].filter(Boolean);
      if (missing.length) throw new Error('Not uploaded yet: ' + missing.join(' and ') + '. Upload both, then attach.');
      const prior = r.scan;
      r.scan = {
        path, facts_path, format, bytes,
        sha256: /^[0-9a-f]{64}$/i.test(String(body.sha256 || '')) ? String(body.sha256).toLowerCase() : null,
        splats: Number.isFinite(Number(body.splats)) ? Math.max(0, Math.round(Number(body.splats))) : null,
        summary, scanned_at: String(body.scanned_at || '').slice(0, 40) || null, attached_at: new Date().toISOString(),
      };
      r.edited_at = new Date().toISOString();
      let objects_removed = 0;
      for (const p of [prior && prior.path, prior && prior.facts_path]) {
        if (p && p !== path && p !== facts_path && MOCK_DB.objects.delete(p)) objects_removed++;
      }
      return { ok: true, room: r, objects_removed };
    }
    case 'remove_scan': {
      const { r } = findRoom();
      const prior = r.scan;
      if (!prior || !prior.path) return { ok: true, objects_removed: 0 };
      r.scan = null;
      r.edited_at = new Date().toISOString();
      let objects_removed = 0;
      for (const p of [prior.path, prior.facts_path]) if (p && MOCK_DB.objects.delete(p)) objects_removed++;
      return { ok: true, objects_removed };
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
