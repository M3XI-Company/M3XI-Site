/* ===========================================================================
   M3XI capture — the agent's side.

   One stitched 360 photo per standpoint, straight out of the camera's app.
   No phone spin, no stitching here: the page's job is to take those files,
   check each one really is a full sphere, keep every byte safe in the
   browser's own storage the moment it is accepted, upload in the background
   while the agent carries on, pin standpoints to the listing's floorplan,
   line each photo up with the plan, and hand back a preview link.

   Nothing here is lost on a reload, a dead signal or a lapsed sign-in: the
   files and every choice made about them live in IndexedDB until the tour
   has been completed and the agent starts another.
   =========================================================================== */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const SB_URL = 'https://tnlcuptfldwxtxajudoq.supabase.co';
const FN = SB_URL + '/functions/v1/m3ix-spatial';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRubGN1cHRmbGR3eHR4YWp1ZG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODcxNDEsImV4cCI6MjEwMDA2MzE0MX0.mgS1gDa7qeBsTCaXmefpogg02kw7tCzn0uEYPAAuC90';
const SITE = 'https://www.m3xi.com';

/* Dev mock: only on localhost with ?mock=1. Inert on the live host. Every
   network call is replaced by a local stub and the session check is skipped,
   so the whole flow can be driven without an account or a signal. */
const Q = new URLSearchParams(location.search);
const MOCK = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && Q.get('mock') === '1';

/* Per-page auth lock, never navigator.locks: a frozen background tab holding
   the cross-tab lock wedges auth everywhere. Same rule as the Studio pages. */
let _authQ = Promise.resolve();
const tabLock = (_n, _t, fn) => { const r = _authQ.then(() => fn()); _authQ = r.catch(() => {}); return r; };
const sb = createClient(SB_URL, KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, lock: tabLock },
});

/* ---------- tiny helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));
const rand8 = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const capture = (n, id) => { try { n.setPointerCapture(id); } catch { /* a pointer that cannot be captured still drags */ } };
const norm360 = a => ((a % 360) + 360) % 360;
const norm180 = a => ((((a + 180) % 360) + 360) % 360) - 180;
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* On m3xi.com always return to the www host — the session lives in that
   origin's localStorage, so a bare-host return would land signed out. */
function canonicalOrigin(){
  const h = location.hostname;
  if (h === 'm3xi.com' || h === 'www.m3xi.com') return SITE;
  return location.origin;
}
/* NO FRAGMENT and no query in the return URL: sign-in comes back with the
   session in a fragment of its own. */
const returnUrl = () => canonicalOrigin() + location.pathname;
const absolute = u => {
  if (!u) return '';
  if (/^https?:\/\//.test(u)) return u.replace(/^https?:\/\/m3xi\.com\//, SITE + '/');
  return SITE + (u.startsWith('/') ? '' : '/') + u;
};

function toast(msg, good){
  const t = el('div', { class: 'toast' + (good ? ' good' : ''), text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), good ? 3500 : 6500);
}

/* ---------- IndexedDB: the session and the bytes ----------
   'session' holds one document (everything but the files). 'blobs' holds the
   files: '<photoId>:orig', '<photoId>:prev' and 'plan'. */
const DB_NAME = 'm3xi-capture', DB_VER = 1;
let _db = null;
function db(){
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('session')) d.createObjectStore('session');
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error || new Error('IndexedDB refused to open'));
  });
}
async function idb(store, mode, fn){
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('aborted'));
  });
}
const blobPut = (k, b) => idb('blobs', 'readwrite', s => s.put(b, k));
const blobGet = k => idb('blobs', 'readonly', s => s.get(k));
const blobDel = k => idb('blobs', 'readwrite', s => s.delete(k));
const blobClear = () => idb('blobs', 'readwrite', s => s.clear());
const sessionPut = doc => idb('session', 'readwrite', s => s.put(doc, 'current'));
const sessionGet = () => idb('session', 'readonly', s => s.get('current'));
const sessionClear = () => idb('session', 'readwrite', s => s.clear());

/* ---------- state ---------- */
const blank = () => ({
  v: 1, address: '', captureId: null, propertyId: null, prefix: null, existingTour: null,
  startedAt: null, step: 'start',
  rooms: [],            // { id, name }
  photos: [],           // see acceptFile() for the shape; order = order within a room
  plan: null,           // { name, width, height, path, status, err }
  undo: [],             // pin undo stack: { id, prev }
  links: [],            // [keyA, keyB] chosen during calibration
  tour: null, live: null,
});
let S = blank();
let dirty = 0;          // pending saves
let saveTimer = null;
function persist(now){
  dirty++;
  clearTimeout(saveTimer);
  const go = async () => {
    try { await sessionPut(JSON.parse(JSON.stringify(S))); }
    catch (e) { console.warn('save failed', e); toast('Could not save to this browser: ' + e.message); }
    dirty = 0;
  };
  if (now) return go();
  saveTimer = setTimeout(go, 150);
}
const roomOf = id => S.rooms.find(r => r.id === id);
const photosIn = roomId => S.photos.filter(p => p.roomId === roomId);
const photoById = id => S.photos.find(p => p.id === id);
const nodeKey = p => { const r = roomOf(p.roomId); return 'r-' + slug(r ? r.name : 'room') + '-n' + (photosIn(p.roomId).indexOf(p) + 1); };
const fullLabel = p => { const r = roomOf(p.roomId); return (r ? r.name : '?') + ' · ' + p.label; };

/* Anything that still needs the network, or a save still in flight, is a
   reason not to let the tab close quietly. */
addEventListener('beforeunload', e => {
  const pending = S.photos.some(p => p.status !== 'done') || (S.plan && S.plan.status !== 'done') || dirty > 0;
  if (!pending) return;
  e.preventDefault(); e.returnValue = '';
});

/* ---------- screens ---------- */
const ORDER = ['start', 'rooms', 'plan', 'calib', 'finish'];
function show(step){
  S.step = step;
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + step));
  $$('#steps button').forEach(b => {
    const me = b.dataset.step;
    if (me === step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.disabled = !(S.startedAt && S.captureId) && me !== 'start';
    b.classList.toggle('done', ORDER.indexOf(me) < ORDER.indexOf(step));
  });
  if (step === 'start') renderStart();
  if (step === 'rooms') renderRooms();
  if (step === 'plan') renderPlan();
  if (step === 'calib') renderCalib();
  if (step === 'finish') renderFinish();
  if (step !== 'calib') calStop();
  persist();
  window.scrollTo({ top: 0 });
}
$$('#steps button').forEach(b => b.onclick = () => show(b.dataset.step));
$$('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));

/* ---------- auth ---------- */
let session = null;
async function refreshSession(){
  if (MOCK) { session = { access_token: 'mock', user: { email: 'mock@localhost' } }; }
  else { const { data } = await sb.auth.getSession(); session = data.session || null; }
  renderAuth();
  return session;
}
function renderAuth(){
  const who = $('#who');
  if (session) {
    who.innerHTML = esc(session.user?.email || 'Signed in') + (MOCK ? '' : ' · <a href="#" id="signout">Sign out</a>');
    const so = $('#signout'); if (so) so.onclick = async e => { e.preventDefault(); await sb.auth.signOut(); refreshSession(); };
    $('#signin').hidden = true;
    $('#go').disabled = false;
    $('#warn').textContent = '';
    hideAuthOverlay();
    if (upload.paused) { upload.paused = false; pump(); }
  } else {
    who.textContent = 'Signed out';
    $('#signin').hidden = false;
    $('#go').disabled = true;
  }
}
if (!MOCK) {
  sb.auth.onAuthStateChange(() => { refreshSession(); });
}
/* Sign-in controls: the same two doors as the Studio account panel. */
const say = (sel, m, bad) => { const n = $(sel); n.textContent = m; n.className = 'small ' + (bad ? 'err' : 'ok'); };
$('#btnEmail').onclick = async () => {
  const email = ($('#acctEmail').value || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say('#acctMsg', 'That does not look like an email address.', true);
  say('#acctMsg', 'Sending…');
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl() } });
  say('#acctMsg', error ? ('Could not send: ' + error.message) : 'Check your inbox — the link brings you straight back here, signed in.', !!error);
};
$('#btnGoogle').onclick = async () => {
  say('#acctMsg', 'Opening Google…');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: returnUrl(), queryParams: { prompt: 'select_account' } },
  });
  if (error) say('#acctMsg', 'Google sign-in failed: ' + error.message, true);
};
/* When a session lapses mid-capture the sign-in box moves into an overlay and
   back again afterwards. State is untouched; uploads pause and resume. */
let signinHome = null;
function showAuthOverlay(){
  const box = $('#signin');
  if (!signinHome) signinHome = { parent: box.parentNode, next: box.nextSibling };
  box.hidden = false;
  $('#authBox').innerHTML = '';
  $('#authBox').append(el('p', { class: 'lead', text: 'Your sign-in has expired. Sign in again to carry on — nothing you added has been lost.' }), box);
  $('#authOverlay').hidden = false;
  box.querySelector('h2').textContent = 'Sign in to continue';
}
function hideAuthOverlay(){
  if ($('#authOverlay').hidden) return;
  $('#authOverlay').hidden = true;
  const box = $('#signin');
  if (signinHome) signinHome.parent.insertBefore(box, signinHome.next);
  box.querySelector('h2').textContent = 'Sign in to start';
  box.hidden = !!session;
}

/* ---------- API ---------- */
class AuthError extends Error {}
async function api(payload){
  if (MOCK) return mockApi(payload);
  if (!session) { await refreshSession(); }
  if (!session) throw new AuthError('Sign in to do that.');
  const r = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + session.access_token },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({ error: 'The server sent an unreadable reply.' }));
  if (r.status === 401) throw new AuthError(j.error || 'Sign in to do that.');
  if (!r.ok || j.error) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; e.body = j; throw e; }
  return j;
}
async function put(url, blob, type){
  if (MOCK) { await sleep(300); return; }
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
  if (r.status === 401 || r.status === 403) throw new AuthError('Upload refused — sign in again.');
  if (!r.ok) throw new Error('Upload failed (HTTP ' + r.status + ')');
}
/* Three tries, backing off: a phone in a stranger's hallway has one bar. */
async function withRetry(fn, tries = 3){
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { if (e instanceof AuthError) throw e; last = e; if (i < tries - 1) await sleep(1000 * Math.pow(2, i)); }
  }
  throw last;
}

/* ---------- upload queue ----------
   Starts the moment a photo is accepted. Two at a time; each file records the
   storage path of every part that has landed, so a retry never re-sends bytes
   that are already there. */
const upload = { running: 0, max: 2, paused: false };
function nextJob(){
  const p = S.photos.find(x => x.status === 'queued');
  if (p) return { kind: 'photo', p };
  if (S.plan && S.plan.status === 'queued') return { kind: 'plan' };
  return null;
}
function pump(){
  if (upload.paused || !S.captureId) { renderStrip(); return; }
  while (upload.running < upload.max) {
    const job = nextJob(); if (!job) break;
    upload.running++;
    runJob(job).finally(() => { upload.running--; pump(); });
  }
  renderStrip();
}
async function runJob(job){
  const target = job.kind === 'photo' ? job.p : S.plan;
  target.status = 'uploading'; target.err = '';
  renderStatus(job);
  try {
    if (job.kind === 'photo') await uploadPhoto(job.p); else await uploadPlan();
    target.status = 'done';
  } catch (e) {
    if (e instanceof AuthError) { target.status = 'queued'; upload.paused = true; session = null; renderAuth(); showAuthOverlay(); }
    else { target.status = 'failed'; target.err = e.message; }
  }
  persist();
  renderStatus(job);
}
async function uploadOne(filename, blob, type){
  return withRetry(async () => {
    const u = await api({ action: 'upload_url', capture_id: S.captureId, filename });
    await put(u.upload_url, blob, type);
    return u.path;
  });
}
async function uploadPhoto(p){
  if (!p.upload.orig) {
    const b = await blobGet(p.id + ':orig'); if (!b) throw new Error('The photo is missing from this browser\'s storage. Replace it.');
    p.upload.orig = await uploadOne('n-' + p.rand + '.jpg', b, 'image/jpeg'); persist();
  }
  if (!p.upload.preview) {
    const b = await blobGet(p.id + ':prev'); if (!b) throw new Error('The preview is missing. Replace the photo.');
    p.upload.preview = await uploadOne('n-' + p.rand + '-preview.jpg', b, 'image/jpeg'); persist();
  }
}
async function uploadPlan(){
  if (S.plan.path) return;
  const b = await blobGet('plan'); if (!b) throw new Error('The floorplan is missing from this browser\'s storage. Add it again.');
  S.plan.path = await uploadOne('floorplan.jpg', b, 'image/jpeg'); persist();
}
function retry(target){ if (target.status === 'failed') { target.status = 'queued'; target.err = ''; pump(); } }
function renderStatus(job){
  if (job.kind === 'photo') { const n = document.querySelector('[data-photo="' + job.p.id + '"] .status'); if (n) paintStatus(n, job.p); }
  else { $('#planStatus').textContent = planStatusText(); }
  renderStrip();
  if (S.step === 'finish') renderFinish();
}
function paintStatus(n, p){
  n.className = 'status ' + p.status;
  n.textContent = { queued: 'Waiting to upload', uploading: 'Uploading…', done: 'Uploaded', failed: 'Failed — tap to retry' }[p.status] || p.status;
  n.title = p.err || '';
  n.onclick = () => retry(p);
  n.tabIndex = p.status === 'failed' ? 0 : -1;
  n.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); retry(p); } };
}
function renderStrip(){
  const s = $('#upstrip');
  const all = S.photos.slice(); if (S.plan) all.push(S.plan);
  if (!all.length) { s.textContent = ''; s.className = ''; return; }
  const c = { done: 0, uploading: 0, queued: 0, failed: 0 };
  all.forEach(p => c[p.status] = (c[p.status] || 0) + 1);
  const parts = [];
  if (c.uploading) parts.push('uploading ' + c.uploading);
  if (c.queued) parts.push(c.queued + ' waiting');
  if (c.failed) parts.push(c.failed + ' failed');
  s.textContent = c.done + ' of ' + all.length + ' uploaded' + (parts.length ? ' · ' + parts.join(' · ') : '') + (upload.paused ? ' · paused until you sign in' : '');
  s.className = c.failed ? 'bad' : (c.uploading || c.queued ? 'busy' : '');
}

/* ---------- accepting a photo ----------
   Decode, measure, refuse anything that is not a full sphere, make the
   1024×512 preview, hash the original, read the camera's compass heading if
   it wrote one, and store the lot before anything else happens. */
async function decode(file){
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch (e) { /* fall through */ }
  }
  return new Promise((res, rej) => {
    const im = new Image(); const u = URL.createObjectURL(file);
    im.onload = () => { URL.revokeObjectURL(u); res(im); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('not an image')); };
    im.src = u;
  });
}
function isFullSphere(w, h){ return w >= 2048 && h >= 1024 && Math.abs(w / h - 2) <= 0.04 * 2; }
function toJpeg(canvas, q){ return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('could not encode')), 'image/jpeg', q)); }
async function makePreview(img){
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
  c.getContext('2d').drawImage(img, 0, 0, 1024, 512);
  return toJpeg(c, 0.8);
}
async function sha256(blob){
  const buf = await blob.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}
/* Walk the JPEG's APP segments for the XMP packet and pull GPano's
   PoseHeadingDegrees: the compass heading the image centre faced. */
async function readPoseHeading(file){
  try {
    const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
    if (head[0] !== 0xFF || head[1] !== 0xD8) return null;
    let i = 2;
    const sig = 'http://ns.adobe.com/xap/1.0/';
    while (i + 4 <= head.length) {
      if (head[i] !== 0xFF) { i++; continue; }
      const marker = head[i + 1];
      if (marker === 0xDA || marker === 0xD9) break;                     // SOS / EOI: no more headers
      if (marker === 0xFF) { i++; continue; }
      const len = (head[i + 2] << 8) | head[i + 3];
      if (marker === 0xE1) {
        const seg = head.subarray(i + 4, i + 2 + len);
        let ok = seg.length > sig.length;
        for (let k = 0; ok && k < sig.length; k++) if (seg[k] !== sig.charCodeAt(k)) ok = false;
        if (ok) {
          const xml = new TextDecoder('utf-8').decode(seg.subarray(sig.length + 1));
          const m = xml.match(/GPano:PoseHeadingDegrees\s*=\s*"([-\d.]+)"/) || xml.match(/<GPano:PoseHeadingDegrees>\s*([-\d.]+)\s*</);
          if (m) { const v = parseFloat(m[1]); if (Number.isFinite(v)) return norm360(v); }
          return null;
        }
      }
      i += 2 + len;
    }
  } catch (e) { /* a heading is a bonus, never a blocker */ }
  return null;
}
const SOURCES = { '360-camera': '360 camera', 'phone-photosphere': 'Phone photosphere (fallback)', 'other': 'Other' };

async function acceptFile(file, roomId, replaceId){
  let img;
  try { img = await decode(file); }
  catch (e) { throw new Error('"' + file.name + '" could not be opened as an image.'); }
  const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
  if (!isFullSphere(w, h)) {
    if (img.close) img.close();
    throw new Error('This isn\'t a full 360 photo (' + w + '×' + h + '). Use the 360 camera\'s app to export the stitched image.');
  }
  const [preview, hash, heading] = await Promise.all([makePreview(img), sha256(file), readPoseHeading(file)]);
  if (img.close) img.close();

  const existing = replaceId ? photoById(replaceId) : null;
  const p = existing || {
    id: uid(), roomId, label: '', source: '360-camera', pin: null, north: null, northFrom: null,
  };
  if (!existing) {
    const n = photosIn(roomId).length + 1;
    p.label = 'Standpoint ' + n;
  }
  Object.assign(p, {
    rand: rand8(), fileName: file.name, width: w, height: h, bytes: file.size, sha256: hash,
    capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
    upload: { orig: null, preview: null }, status: 'queued', err: '',
  });
  if (heading != null) {
    p.cameraHeading = heading;
    if (p.northFrom !== 'agent') { p.north = norm360(360 - heading); p.northFrom = 'camera'; }
  } else if (!existing) { p.cameraHeading = null; }
  await blobPut(p.id + ':orig', file);
  await blobPut(p.id + ':prev', preview);
  thumbs.forget(p.id);
  if (!existing) S.photos.push(p);
  await persist(true);
  pump();
  return p;
}

/* ---------- the sphere ----------
   One shared WebGL renderer (three.js, loaded on demand) draws every
   thumbnail and the calibration view onto plain 2D canvases, so twenty
   standpoints do not mean twenty WebGL contexts. The shader maps a view
   direction straight to equirectangular UV: yaw 0 is the image centre, yaw
   grows turning right, exactly as the viewer and the API read it. */
const sphere = { ready: null, THREE: null, r: null, scene: null, cam: null, mat: null, failed: false };
function loadSphere(){
  if (sphere.ready) return sphere.ready;
  sphere.ready = (async () => {
    try {
      const THREE = await import('three');
      const r = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
      r.setPixelRatio(1);
      const scene = new THREE.Scene();
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: null }, yaw: { value: 0 }, pitch: { value: 0 }, tanX: { value: 1 }, tanY: { value: 1 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
          precision highp float;
          uniform sampler2D map; uniform float yaw, pitch, tanX, tanY; varying vec2 vUv;
          void main(){
            vec3 c = normalize(vec3(vUv.x * tanX, vUv.y * tanY, -1.0));
            float cp = cos(pitch), sp = sin(pitch);
            vec3 p = vec3(c.x, c.y * cp - c.z * sp, c.y * sp + c.z * cp);
            float cy = cos(yaw), sy = sin(yaw);
            vec3 d = vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
            float u = 0.5 + atan(d.x, -d.z) / 6.28318530718;
            float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.14159265359;
            gl_FragColor = texture2D(map, vec2(u, v));
          }`,
        depthTest: false, depthWrite: false,
      });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      Object.assign(sphere, { THREE, r, scene, cam, mat });
      return true;
    } catch (e) {
      console.warn('three.js unavailable', e);
      sphere.failed = true;
      return false;
    }
  })();
  return sphere.ready;
}
function makeTexture(bitmap){
  const THREE = sphere.THREE;
  const t = new THREE.Texture(bitmap);
  t.flipY = false; t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
const FOV = 75;
/* Draw one view onto a 2D canvas. Synchronous after render, before the GL
   buffer is handed to the compositor. */
function drawView(ctx, tex, yaw, pitch, w, h){
  const r = sphere.r;
  if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);
  const ty = Math.tan(FOV / 2 * Math.PI / 180);
  const u = sphere.mat.uniforms;
  u.map.value = tex; u.yaw.value = yaw * Math.PI / 180; u.pitch.value = pitch * Math.PI / 180;
  u.tanY.value = ty; u.tanX.value = ty * w / h;
  r.render(sphere.scene, sphere.cam);
  ctx.drawImage(r.domElement, 0, 0, w, h);
}
/* A drag-to-look canvas. Keeps its own yaw/pitch; the texture is looked up
   by photo id so a deleted photo frees its texture. */
function makeLook(canvas, getTex, opts = {}){
  const ctx = canvas.getContext('2d');
  const L = { yaw: opts.yaw || 0, pitch: 0, draw(){}, onchange: opts.onchange || null };
  let last = null, pid = null;
  L.draw = async () => {
    const tex = await getTex();
    if (!tex) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
    if (tex.flat) { ctx.drawImage(tex.flat, 0, 0, canvas.width, canvas.height); return; }
    drawView(ctx, tex, L.yaw, L.pitch, canvas.width, canvas.height);
  };
  const move = (dx, dy) => {
    L.yaw = norm180(L.yaw - dx * (FOV / canvas.clientWidth));
    L.pitch = Math.max(-85, Math.min(85, L.pitch + dy * (FOV / canvas.clientWidth)));
    L.draw(); if (L.onchange) L.onchange(L);
  };
  canvas.addEventListener('pointerdown', e => { last = [e.clientX, e.clientY]; pid = e.pointerId; capture(canvas, pid); e.preventDefault(); canvas.focus({ preventScroll: true }); });
  canvas.addEventListener('pointermove', e => { if (last == null || e.pointerId !== pid) return; move(e.clientX - last[0], e.clientY - last[1]); last = [e.clientX, e.clientY]; });
  const up = e => { if (e.pointerId === pid) { last = null; pid = null; } };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('keydown', e => {
    const k = e.key; let h = 0, v = 0;
    if (k === 'ArrowLeft') h = 1; else if (k === 'ArrowRight') h = -1; else if (k === 'ArrowUp') v = 1; else if (k === 'ArrowDown') v = -1; else return;
    e.preventDefault(); move(h * canvas.clientWidth / 15, v * canvas.clientWidth / 15);
  });
  L.set = (yaw, pitch) => { L.yaw = norm180(yaw); L.pitch = pitch ?? L.pitch; L.draw(); if (L.onchange) L.onchange(L); };
  return L;
}
/* Thumbnail textures come from the 1024×512 preview: sharp enough to see
   which room it is, a sixteenth of the memory of the original. */
const thumbs = {
  tex: new Map(),
  async get(p){
    if (this.tex.has(p.id)) return this.tex.get(p.id);
    const b = await blobGet(p.id + ':prev'); if (!b) return null;
    const ok = await loadSphere();
    let t;
    if (ok) { const bm = await createImageBitmap(b); t = makeTexture(bm); }
    else { const bm = await decode(b); t = { flat: bm }; }
    this.tex.set(p.id, t);
    return t;
  },
  forget(id){ const t = this.tex.get(id); if (t && t.dispose) t.dispose(); this.tex.delete(id); },
};

/* ---------- 1 · start ---------- */
/* A capture in progress is never replaced by accident: the start screen
   offers Continue / Start over until the agent chooses. */
function renderStart(){
  const live = !!S.captureId;
  $('#resume').hidden = !live; $('#startForm').hidden = live;
  if (live) $('#resumeAddr').textContent = S.address;
}
const ROOM_NAMES = ['Hallway', 'Living room', 'Kitchen', 'Dining room', 'Bedroom', 'Bathroom', 'En suite', 'Garden', 'Garage', 'Study'];
$('#go').onclick = async () => {
  const a = $('#addr').value.trim();
  if (!a) { $('#warn').textContent = 'Add the address first.'; $('#addr').focus(); return; }
  if (!MOCK && !(await refreshSession())) { $('#warn').textContent = 'Sign in first — captures are saved to your agency account.'; return; }
  $('#go').disabled = true; $('#warn').textContent = '';
  try {
    const reg = await api({ action: 'register_capture', address: a });
    S = blank();
    Object.assign(S, { address: a, captureId: reg.capture_id, propertyId: reg.property_id, prefix: reg.storage_prefix,
      existingTour: reg.existing_tour || null, startedAt: new Date().toISOString() });
    await persist(true);
    if (S.existingTour) toast('This address already has a tour (' + S.existingTour.status + '). Re-shot rooms replace the old photos; the rest stay.', true);
    show('rooms');
  } catch (e) {
    if (e instanceof AuthError) { session = null; renderAuth(); $('#warn').textContent = 'Your sign-in has expired. Sign in below and press Start again.'; }
    else $('#warn').textContent = 'Could not start: ' + e.message + '. Check the signal and try again.';
  }
  $('#go').disabled = !session && !MOCK;
};
$('#addr').addEventListener('keydown', e => { if (e.key === 'Enter') $('#go').click(); });
// The dashboard's "Capture more" link arrives with ?address= so the agent does not retype it
// (same address in the same agency = same property = same tour).
if (Q.get('address') && !$('#addr').value) $('#addr').value = Q.get('address').slice(0, 160);
$('#btnResume').onclick = () => { show(S.step === 'start' ? 'rooms' : S.step); pump(); };
$('#btnStartOver').onclick = async () => {
  const pending = S.photos.some(p => p.status !== 'done');
  if (!confirm('Start over? This deletes the ' + S.photos.length + ' photo' + (S.photos.length === 1 ? '' : 's') + ' saved in this browser for "' + S.address + '"' + (pending ? ' — some have not finished uploading yet' : '') + '.')) return;
  await wipe(); renderStart();
};
async function wipe(){
  upload.paused = true;
  thumbs.tex.forEach((t, id) => thumbs.forget(id));
  S = blank();
  await sessionClear(); await blobClear();
  upload.paused = false;
  $('#addr').value = '';
  renderStrip();
}

/* ---------- 2 · rooms & standpoints ---------- */
function uniqueRoomName(base){
  const names = new Set(S.rooms.map(r => r.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) { const c = base + ' ' + n; if (!names.has(c.toLowerCase())) return c; }
}
function addRoom(name){
  const n = name.trim(); if (!n) return;
  const r = { id: uid(), name: uniqueRoomName(n) };
  S.rooms.push(r); persist(); renderRooms();
  const head = document.querySelector('[data-room="' + r.id + '"] .head input');
  if (head) head.scrollIntoView({ block: 'center' });
  return r;
}
$('#btnAddRoom').onclick = () => { addRoom($('#roomName').value); $('#roomName').value = ''; };
$('#roomName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#btnAddRoom').click(); } });
function renderRoomChips(){
  const c = $('#roomChips'); c.innerHTML = '';
  ROOM_NAMES.forEach(n => c.append(el('button', { class: 'chip', type: 'button', text: n, onclick: () => addRoom(n) })));
}
let picking = null;   // { roomId, replaceId }
$('#photoFile').addEventListener('change', async e => {
  const files = Array.from(e.target.files || []); e.target.value = '';
  if (!picking || !files.length) return;
  const { roomId, replaceId } = picking; picking = null;
  await addFiles(files, roomId, replaceId);
});
async function addFiles(files, roomId, replaceId){
  const room = roomOf(roomId); if (!room) return;
  const errs = [];
  if (replaceId) files = files.slice(0, 1);
  let left = files.length;
  const busy = () => setBusy(roomId, left ? 'Checking ' + left + ' photo' + (left === 1 ? '' : 's') + '…' : '');
  busy();
  for (const f of files) {
    try { await acceptFile(f, roomId, replaceId); }
    catch (e) { errs.push(e.message); }
    left--; renderRooms(); busy();
  }
  if (errs.length) { showRoomErrors(roomId, errs); errs.forEach(m => toast(m)); }
}
function setBusy(roomId, msg){ const n = document.querySelector('[data-room="' + roomId + '"] .busy'); if (n) n.textContent = msg; }
function showRoomErrors(roomId, errs){
  const n = document.querySelector('[data-room="' + roomId + '"] .errs'); if (!n) return;
  n.innerHTML = ''; errs.forEach(m => n.append(el('p', { class: 'small err', text: m })));
}
function renderRooms(){
  renderRoomChips();
  const host = $('#rooms'); host.innerHTML = '';
  if (!S.rooms.length) { host.append(el('p', { class: 'small', style: 'margin-top:14px', text: 'No rooms yet. Tap a room name above to add it.' })); }
  S.rooms.forEach(room => host.append(renderRoom(room)));
  $('#toPlan').disabled = !S.photos.length;
  $('#toPlan').title = S.photos.length ? '' : 'Add at least one 360 photo first';
}
function renderRoom(room){
  const ps = photosIn(room.id);
  const nameIn = el('input', { type: 'text', value: room.name, 'aria-label': 'Room name', autocomplete: 'off' });
  nameIn.addEventListener('change', () => { const v = nameIn.value.trim(); if (!v) { nameIn.value = room.name; return; } if (v.toLowerCase() !== room.name.toLowerCase()) room.name = uniqueRoomName(v); nameIn.value = room.name; persist(); });
  const del = el('button', { class: 'btn sm ghost', type: 'button', text: 'Delete room', onclick: async () => {
    if (ps.length && !confirm('Delete "' + room.name + '" and its ' + ps.length + ' photo' + (ps.length === 1 ? '' : 's') + '?')) return;
    for (const p of ps) await removePhoto(p, true);
    S.rooms = S.rooms.filter(r => r.id !== room.id); persist(); renderRooms();
  } });
  const add = el('button', { class: 'btn sm red', type: 'button', text: '+ Add 360 photo', onclick: () => { picking = { roomId: room.id }; $('#photoFile').click(); } });
  const body = el('div', { class: 'body' },
    el('div', { class: 'row between' }, add, el('span', { class: 'small busy', 'aria-live': 'polite' })),
    el('div', { class: 'errs' }));
  if (!ps.length) body.append(el('p', { class: 'small', style: 'margin-top:8px', text: 'No photos yet. One full 360 photo per standpoint.' }));
  const list = el('div', { class: 'nodes' });
  ps.forEach((p, i) => list.append(renderNode(p, i, ps.length)));
  body.append(list);
  return el('section', { class: 'room', 'data-room': room.id },
    el('div', { class: 'head' }, nameIn, el('span', { class: 'small', text: ps.length + (ps.length === 1 ? ' standpoint' : ' standpoints') }), del),
    body);
}
function renderNode(p, i, n){
  const canvas = el('canvas', { width: 300, height: 188, tabindex: 0, 'aria-label': p.label + ' — 360 preview. Drag or use the arrow keys to look around.' });
  const look = makeLook(canvas, () => thumbs.get(p));
  look.draw();
  const label = el('input', { type: 'text', value: p.label, 'aria-label': 'Standpoint label', autocomplete: 'off' });
  label.addEventListener('change', () => { p.label = label.value.trim() || p.label; label.value = p.label; persist(); });
  const src = el('select', { 'aria-label': 'Photo source' });
  Object.entries(SOURCES).forEach(([k, v]) => src.append(el('option', { value: k, text: v, selected: p.source === k })));
  src.onchange = () => { p.source = src.value; persist(); };
  const status = el('span', { class: 'status' }); paintStatus(status, p);
  const flags = [];
  if (p.pin) flags.push('pinned'); if (p.north != null) flags.push(p.northFrom === 'camera' ? 'compass from camera' : 'calibrated');
  const info = el('span', { class: 'small', text: p.width + '×' + p.height + ' · ' + (p.bytes / 1048576).toFixed(1) + ' MB' + (flags.length ? ' · ' + flags.join(' · ') : '') });
  const tools = el('div', { class: 'tools' },
    el('button', { type: 'button', text: 'Replace', onclick: () => { picking = { roomId: p.roomId, replaceId: p.id }; $('#photoFile').click(); } }),
    el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: async () => { if (confirm('Delete "' + p.label + '"?')) { await removePhoto(p); renderRooms(); } } }),
    el('button', { type: 'button', text: '▲', 'aria-label': 'Move up', disabled: i === 0, onclick: () => moveWithin(p, -1) }),
    el('button', { type: 'button', text: '▼', 'aria-label': 'Move down', disabled: i === n - 1, onclick: () => moveWithin(p, 1) }),
    el('span', { class: 'handle', 'aria-hidden': 'true', title: 'Drag to reorder', text: '⋮⋮' }));
  const node = el('div', { class: 'node', 'data-photo': p.id }, canvas, el('div', { class: 'meta' }, label, src, status, info, tools));
  dragReorder(node, tools.querySelector('.handle'), p);
  return node;
}
function moveWithin(p, dir){
  const ps = photosIn(p.roomId); const i = ps.indexOf(p); const j = i + dir;
  if (j < 0 || j >= ps.length) return;
  const a = S.photos.indexOf(p), b = S.photos.indexOf(ps[j]);
  S.photos[a] = ps[j]; S.photos[b] = p;
  persist(); renderRooms();
  const h = document.querySelector('[data-photo="' + p.id + '"] [aria-label="Move ' + (dir < 0 ? 'up' : 'down') + '"]'); if (h) h.focus();
}
/* Pointer-driven reorder: works with a thumb on a phone, which HTML5
   drag-and-drop does not. */
function dragReorder(node, handle, p){
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); capture(handle, e.pointerId);
    node.classList.add('dragging');
    const list = node.parentNode;
    const onMove = ev => {
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
      if (!over || over === node || over.parentNode !== list) return;
      const r = over.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) list.insertBefore(node, over); else list.insertBefore(node, over.nextSibling);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); handle.removeEventListener('pointercancel', onUp);
      node.classList.remove('dragging');
      const ids = Array.from(list.querySelectorAll('.node')).map(n => n.dataset.photo);
      const ps = photosIn(p.roomId); const idx = ps.map(x => S.photos.indexOf(x));
      const reordered = ids.map(id => photoById(id));
      idx.forEach((slot, k) => S.photos[slot] = reordered[k]);
      persist(); renderRooms();
    };
    handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', onUp); handle.addEventListener('pointercancel', onUp);
  });
}
async function removePhoto(p, quiet){
  S.photos = S.photos.filter(x => x !== p);
  S.links = S.links.filter(l => !l.includes(p.id));
  S.undo = S.undo.filter(u => u.id !== p.id);
  thumbs.forget(p.id);
  await blobDel(p.id + ':orig'); await blobDel(p.id + ':prev');
  if (!quiet) persist();
}
$('#toPlan').onclick = () => { if (!S.photos.length) { toast('Add at least one 360 photo first.'); return; } show('plan'); };

/* ---------- 3 · floorplan & pins ---------- */
let planUrl = null, armed = null;
$('#pickPlan').onclick = () => $('#planFile').click();
$('#replacePlan').onclick = () => $('#planFile').click();
$('#planFile').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await acceptPlan(f); });
async function acceptPlan(file){
  $('#planStatus').textContent = 'Reading the plan…';
  try {
    let img;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) img = await renderPdf(file);
    else img = await decode(file);
    const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
    const scale = Math.min(1, 2000 / w0);
    const c = document.createElement('canvas'); c.width = Math.round(w0 * scale); c.height = Math.round(h0 * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    if (img.close) img.close();
    const jpg = await toJpeg(c, 0.85);
    await blobPut('plan', jpg);
    S.plan = { name: file.name, width: c.width, height: c.height, path: null, status: 'queued', err: '' };
    await persist(true);
    pump(); renderPlan();
  } catch (e) {
    $('#planStatus').textContent = '';
    toast('Could not use that plan: ' + e.message);
  }
}
/* PDFs: page 1 rendered with pdf.js, fetched only when a PDF is chosen. */
async function renderPdf(file){
  let pdfjs;
  try { pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs'); }
  catch (e) { throw new Error('the PDF reader could not load (no signal?). Export the plan as an image instead.'); }
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('the PDF took too long to read. Export the plan as an image instead.')), ms))]);
  const doc = await timeout(pdfjs.getDocument({ data: await file.arrayBuffer() }).promise, 30000);
  const page = await timeout(doc.getPage(1), 10000);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 2000 / base.width });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  // 'print' intent: pdf.js then paints without requestAnimationFrame, which a
  // backgrounded tab never fires — a display-intent render would simply hang.
  await timeout(page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise, 60000);
  return c;
}
function planStatusText(){
  if (!S.plan) return 'No plan yet — that is allowed, but buyers get no map and arrows follow room order.';
  return { queued: 'Waiting to upload', uploading: 'Uploading the plan…', done: 'Plan uploaded', failed: 'Plan upload failed — ' + (S.plan.err || '') + ' (tap Replace plan, or it retries on Finish)' }[S.plan.status] || '';
}
async function renderPlan(){
  $('#planStatus').textContent = planStatusText();
  const wrap = $('#planwrap');
  if (!S.plan) { wrap.style.display = 'none'; $('#pinChips').hidden = true; $('#planTools').hidden = true; $('#pinHint').textContent = ''; $('#pickPlan').hidden = false; return; }
  $('#pickPlan').hidden = true; $('#planTools').hidden = false; $('#pinChips').hidden = false;
  const b = await blobGet('plan');
  if (b) { if (planUrl) URL.revokeObjectURL(planUrl); planUrl = URL.createObjectURL(b); $('#planImg').src = planUrl; }
  wrap.style.display = 'block';
  renderPinChips(); renderPins();
}
function renderPinChips(){
  const c = $('#pinChips'); c.innerHTML = '';
  S.photos.forEach(p => {
    const b = el('button', { class: 'chip' + (p.pin ? ' pinned' : '') + (armed === p.id ? ' sel' : ''), type: 'button', 'aria-pressed': armed === p.id ? 'true' : 'false' },
      el('span', { class: 'dot' }), fullLabel(p));
    b.onclick = () => { armed = p.id; renderPinChips(); renderPins(); };
    c.append(b);
  });
  const unp = S.photos.filter(p => !p.pin).length;
  $('#planwrap').classList.toggle('arm', !!armed);
  if (armed) $('#pinHint').textContent = 'Now tap where "' + fullLabel(photoById(armed)) + '" is on the plan.';
  else if (unp) $('#pinHint').textContent = unp + ' standpoint' + (unp === 1 ? '' : 's') + ' not pinned yet. Tap one, then tap the plan. Drag a pin to move it.';
  else $('#pinHint').textContent = 'Every standpoint is pinned. Drag a pin to move it.';
  $('#undoPin').disabled = !S.undo.length;
}
function renderPins(){
  const wrap = $('#planwrap');
  wrap.querySelectorAll('.pin').forEach(n => n.remove());
  S.photos.filter(p => p.pin).forEach(p => {
    const pin = el('div', { class: 'pin' + (armed === p.id ? ' sel' : ''), 'data-pin': p.id, text: p.label, title: fullLabel(p), role: 'button', tabindex: 0, 'aria-label': fullLabel(p) + ' pin. Drag to move.' });
    pin.style.left = (p.pin.x * 100) + '%'; pin.style.top = (p.pin.y * 100) + '%';
    let start = null, moved = false;
    pin.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); capture(pin, e.pointerId); start = { x: e.clientX, y: e.clientY, pin: { ...p.pin } }; moved = false; });
    pin.addEventListener('pointermove', e => {
      if (!start) return;
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) moved = true;
      const f = planFrac(e); pin.style.left = (f.x * 100) + '%'; pin.style.top = (f.y * 100) + '%';
    });
    const end = e => {
      if (!start) return;
      if (moved) { S.undo.push({ id: p.id, prev: start.pin }); p.pin = planFrac(e); persist(); }
      else { armed = p.id; }
      start = null; renderPinChips(); renderPins();
    };
    pin.addEventListener('pointerup', end); pin.addEventListener('pointercancel', end);
    pin.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.05 : 0.01; let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step; else if (e.key === 'ArrowUp') dy = -step; else if (e.key === 'ArrowDown') dy = step; else return;
      e.preventDefault(); S.undo.push({ id: p.id, prev: { ...p.pin } });
      p.pin = { x: Math.min(1, Math.max(0, p.pin.x + dx)), y: Math.min(1, Math.max(0, p.pin.y + dy)) }; persist(); renderPins();
      wrap.querySelector('[data-pin="' + p.id + '"]')?.focus();
    });
    wrap.append(pin);
  });
}
function planFrac(e){
  const r = $('#planwrap').getBoundingClientRect();
  const w = r.width - 6, h = r.height - 6;              // inside the 3px border
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left - 3) / w)), y: Math.min(1, Math.max(0, (e.clientY - r.top - 3) / h)) };
}
$('#planwrap').addEventListener('click', e => {
  if (e.target.closest('.pin')) return;
  if (!armed) { $('#pinHint').textContent = 'Tap a standpoint name first, then tap the plan.'; return; }
  const p = photoById(armed); if (!p) { armed = null; return; }
  S.undo.push({ id: p.id, prev: p.pin ? { ...p.pin } : null });
  p.pin = planFrac(e);
  const next = S.photos.find(x => !x.pin);
  armed = next ? next.id : null;
  persist(); renderPinChips(); renderPins();
});
$('#undoPin').onclick = () => {
  const u = S.undo.pop(); if (!u) return;
  const p = photoById(u.id); if (p) p.pin = u.prev;
  persist(); renderPinChips(); renderPins();
};
$('#removePlan').onclick = async () => {
  if (!confirm('Remove the floorplan? The pins are kept in case you add it back.')) return;
  await blobDel('plan'); S.plan = null; persist(); renderPlan();
};
$('#toCalib').onclick = () => show('calib');

/* ---------- 4 · calibration ----------
   north_deg is the yaw, in this photo, that points to the plan's up. The
   agent turns until the neighbour is in the middle of the view; the yaw to
   look at B from A is north + bearing(A→B), so north = yaw − bearing. */
const cal = { id: null, look: null, tex: null, texId: null };
function bearing(a, b){
  // pins are fractions; bearings are measured in plan pixels so a wide plan is not squashed
  const w = S.plan ? S.plan.width : 1, h = S.plan ? S.plan.height : 1;
  const dx = (b.x - a.x) * w, dy = (b.y - a.y) * h;
  return norm360(Math.atan2(dx, -dy) * 180 / Math.PI);
}
function planDist(a, b){ const w = S.plan ? S.plan.width : 1, h = S.plan ? S.plan.height : 1; return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h); }
const calibratable = () => { const pinned = S.photos.filter(p => p.pin); return pinned.length >= 2 && S.plan ? pinned : []; };
function neighboursOf(p){
  return calibratable().filter(x => x !== p).sort((a, b) => planDist(p.pin, a.pin) - planDist(p.pin, b.pin));
}
function renderCalib(){
  const list = calibratable();
  $('#calNone').hidden = list.length > 0; $('#calBody').hidden = !list.length;
  if (!list.length) { return; }
  if (!cal.id || !list.some(p => p.id === cal.id)) cal.id = (list.find(p => p.north == null || p.northFrom === 'camera') || list[0]).id;
  const host = $('#calList'); host.innerHTML = '';
  list.forEach(p => {
    const st = p.north == null ? 'not set — arrows approximate' : (p.northFrom === 'camera' ? 'compass from camera, ' + Math.round(p.north) + '°' : 'set, ' + Math.round(p.north) + '°');
    host.append(el('button', { type: 'button', 'aria-current': p.id === cal.id ? 'true' : 'false', onclick: () => { cal.id = p.id; renderCalib(); } },
      el('span', { text: fullLabel(p) }), el('span', { class: 'small', text: st })));
  });
  calShowCurrent();
}
async function calShowCurrent(){
  const p = photoById(cal.id); if (!p) return;
  $('#calName').textContent = fullLabel(p);
  const st = $('#calStatus');
  st.className = 'status ' + (p.north == null ? 'local' : 'done');
  st.textContent = p.north == null ? 'Not set' : (p.northFrom === 'camera' ? 'Camera compass' : 'Set');
  const ns = neighboursOf(p);
  const sel = $('#calNeighbour'); const prev = sel.value; sel.innerHTML = '';
  ns.forEach(n => sel.append(el('option', { value: n.id, text: fullLabel(n) + (n.roomId !== p.roomId ? '' : ' (same room)') })));
  const preferred = ns.find(n => n.roomId !== p.roomId) || ns[0];
  sel.value = ns.some(n => n.id === prev) ? prev : preferred.id;
  sel.onchange = () => calPrompt(p);
  calPrompt(p);
  if (!cal.look) {
    cal.look = makeLook($('#calCanvas'), () => cal.tex, { onchange: L => { $('#calYaw').textContent = Math.round(L.yaw); } });
  }
  if (cal.texId !== p.id) {
    if (cal.tex && cal.tex.dispose) cal.tex.dispose();
    cal.tex = null; cal.texId = p.id;
    const ok = await loadSphere();
    const b = await blobGet(p.id + ':orig');
    if (!b) { toast('The original photo is missing from this browser. Replace it.'); return; }
    if (ok) {
      const bm = await createImageBitmap(b, { resizeWidth: 2048, resizeHeight: 1024, resizeQuality: 'high' });
      cal.tex = makeTexture(bm);
    } else {
      cal.tex = { flat: await decode(b) };
      toast('3D preview is not available in this browser, so calibration cannot be done here. Skip it — arrows will be approximate.');
    }
    const nb = photoById(sel.value);
    const startYaw = (p.north != null && nb) ? norm180(p.north + bearing(p.pin, nb.pin)) : 0;
    cal.look.set(startYaw, 0);
  } else cal.look.draw();
}
function calPrompt(p){
  const nb = photoById($('#calNeighbour').value);
  $('#calPrompt').innerHTML = nb ? 'Drag until you are facing <b>' + esc(fullLabel(nb)) + '</b>, then tap &ldquo;That way&rdquo;.' : '';
}
$('#calSet').onclick = () => {
  const p = photoById(cal.id); const nb = photoById($('#calNeighbour').value);
  if (!p || !nb || !cal.tex || cal.tex.flat) return;
  p.north = norm360(cal.look.yaw - bearing(p.pin, nb.pin)); p.northFrom = 'agent';
  const pair = [p.id, nb.id];
  if (!S.links.some(l => (l[0] === pair[0] && l[1] === pair[1]) || (l[0] === pair[1] && l[1] === pair[0]))) S.links.push(pair);
  persist();
  toast(fullLabel(p) + ' lined up (north at ' + Math.round(p.north) + '°).', true);
  calNext();
};
$('#calSkip').onclick = calNext;
$('#calClear').onclick = () => { const p = photoById(cal.id); if (p) { p.north = null; p.northFrom = null; persist(); renderCalib(); } };
function calNext(){
  const list = calibratable(); const i = list.findIndex(p => p.id === cal.id);
  const after = list.slice(i + 1).concat(list.slice(0, i)).find(p => p.north == null || p.northFrom === 'camera');
  cal.id = after ? after.id : list[(i + 1) % list.length].id;
  renderCalib();
}
function calStop(){ if (cal.tex && cal.tex.dispose) cal.tex.dispose(); cal.tex = null; cal.texId = null; }
$('#toFinish').onclick = () => show('finish');

/* ---------- 5 · finish ---------- */
function counts(){
  return { rooms: S.rooms.length, photos: S.photos.length, pinned: S.photos.filter(p => p.pin).length, calibrated: S.photos.filter(p => p.north != null).length,
    done: S.photos.filter(p => p.status === 'done').length + (S.plan && S.plan.status === 'done' ? 1 : 0), total: S.photos.length + (S.plan ? 1 : 0),
    failed: S.photos.filter(p => p.status === 'failed').length + (S.plan && S.plan.status === 'failed' ? 1 : 0) };
}
function renderFinish(){
  const c = counts();
  $('#finAddr').textContent = S.address;
  $('#sum').innerHTML = [['Rooms', c.rooms], ['Standpoints', c.photos], ['Pinned', c.pinned + ' / ' + c.photos], ['Calibrated', c.calibrated + ' / ' + c.photos]]
    .map(([k, v]) => '<div><b>' + v + '</b><span>' + k + '</span></div>').join('');
  const ready = c.total > 0 && c.done === c.total && c.photos > 0;
  const fu = $('#finUploads');
  if (S.tour) fu.textContent = '';
  else if (!c.photos) fu.textContent = 'Nothing to upload yet — add at least one 360 photo.';
  else if (ready) fu.textContent = 'Everything is uploaded.';
  else fu.innerHTML = (c.done + ' of ' + c.total + ' files uploaded. ') + (c.failed ? c.failed + ' failed — <a href="#" id="retryAll">retry them</a>. ' : 'Finishing waits for the rest. ');
  const ra = $('#retryAll'); if (ra) ra.onclick = e => { e.preventDefault(); S.photos.forEach(retry); if (S.plan) retry(S.plan); renderFinish(); };
  const uncal = c.photos - c.calibrated;
  $('#finErr').textContent = (!S.tour && uncal) ? uncal + ' standpoint' + (uncal === 1 ? '' : 's') + ' not calibrated — arrows there will be approximate.' : '';
  $('#finErr').className = 'small note';
  $('#btnComplete').disabled = !ready;
  $('#finPre').hidden = !!S.tour; $('#finPost').hidden = !S.tour;
  $('#finTitle').innerHTML = S.live ? 'THE TOUR IS <em>LIVE</em>' : (S.tour ? 'PREVIEW <em>READY</em>' : 'READY TO <em>PREVIEW</em>');
  $('#finBack').hidden = !!S.tour;
  if (S.tour) {
    $('#previewLink').value = absolute(S.tour.urls?.preview);
    $('#openPreview').href = absolute(S.tour.urls?.preview);
    $('#goLiveBox').hidden = !!S.live; $('#liveBox').hidden = !S.live;
    if (S.live) {
      $('#liveLink').value = absolute(S.live.urls?.live);
      $('#embedSnip').textContent = '<script src="' + SITE + '/tour/embed.js" data-tour="' + S.live.slug + '" async></script>';
      $('#dashLink').href = canonicalOrigin() + '/tours/';
    }
  }
}
/* The manifest: exactly what docs/TOUR_API.md complete_capture expects. */
function buildManifest(){
  const keyOf = new Map(S.photos.map(p => [p.id, nodeKey(p)]));
  const nodes = S.photos.map(p => ({
    key: keyOf.get(p.id), room: roomOf(p.roomId)?.name || 'Room', ordinal: photosIn(p.roomId).indexOf(p) + 1, label: p.label,
    path: p.upload.orig, preview_path: p.upload.preview, width: p.width, height: p.height, bytes: p.bytes, sha256: p.sha256,
    source: p.source, pin: p.pin ? { x: +p.pin.x.toFixed(4), y: +p.pin.y.toFixed(4) } : null,
    north_deg: p.north == null ? null : +norm360(p.north).toFixed(1), captured_at: p.capturedAt,
  }));
  // Links: what the agent lined up during calibration, plus a fallback that
  // joins each room to the next so a tour is walkable even without a plan.
  const links = []; const seen = new Set();
  const addLink = (a, b) => { if (!a || !b || a === b) return; const k = [a, b].sort().join('|'); if (seen.has(k)) return; seen.add(k); links.push([a, b]); };
  S.links.forEach(([a, b]) => addLink(keyOf.get(a), keyOf.get(b)));
  for (let i = 0; i < S.rooms.length - 1; i++) {
    const A = photosIn(S.rooms[i].id), B = photosIn(S.rooms[i + 1].id);
    if (!A.length || !B.length) continue;
    let pair = [A[A.length - 1], B[0]];
    if (S.plan) {                              // with a plan: the closest pinned pair across the two rooms
      let best = Infinity;
      A.filter(p => p.pin).forEach(a => B.filter(p => p.pin).forEach(b => { const d = planDist(a.pin, b.pin); if (d < best) { best = d; pair = [a, b]; } }));
    }
    addLink(keyOf.get(pair[0].id), keyOf.get(pair[1].id));
  }
  const first = S.rooms.map(r => photosIn(r.id)[0]).find(Boolean);
  return {
    action: 'complete_capture', capture_id: S.captureId, nodes,
    floorplan: S.plan && S.plan.path ? { path: S.plan.path, width: S.plan.width, height: S.plan.height } : null,
    links, spawn: first ? { key: keyOf.get(first.id), yaw: 0 } : null,
    captured_at: new Date().toISOString(),
  };
}
$('#btnComplete').onclick = async () => {
  const c = counts(); if (c.done !== c.total || !c.photos) { renderFinish(); return; }
  $('#btnComplete').disabled = true; $('#finErr').textContent = 'Building the tour…'; $('#finErr').className = 'small';
  const manifest = buildManifest();
  console.info('[capture] complete_capture manifest', JSON.stringify(manifest, null, 2));
  try {
    const res = await api(manifest);
    S.tour = res.tour; await persist(true); renderFinish();
    toast('Preview ready.', true);
  } catch (e) {
    if (e instanceof AuthError) { session = null; renderAuth(); showAuthOverlay(); $('#finErr').textContent = 'Sign in again, then tap Upload and preview.'; }
    else if (e.body && e.body.problems) { $('#finErr').textContent = 'The server rejected the capture: ' + e.body.problems.join('; '); }
    else $('#finErr').textContent = 'Could not finish: ' + e.message + '. Check the signal and try again.';
    $('#finErr').className = 'small err';
    $('#btnComplete').disabled = false;
  }
};
$('#btnGoLive').onclick = async () => {
  $('#btnGoLive').disabled = true; $('#liveErr').textContent = '';
  try {
    const res = await api({ action: 'go_live', tour_id: S.tour.id });
    S.live = res.tour || { ...S.tour, status: 'published' }; await persist(true); renderFinish();
    toast('The tour is live.', true);
  } catch (e) {
    if (e instanceof AuthError) { session = null; renderAuth(); showAuthOverlay(); $('#liveErr').textContent = 'Sign in again, then tap Go live.'; }
    else $('#liveErr').textContent = 'Could not go live: ' + e.message;
  }
  $('#btnGoLive').disabled = false;
};
$$('[data-copy]').forEach(b => b.onclick = async () => {
  const n = $('#' + b.dataset.copy); const text = n.value ?? n.textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied.', true); } catch { if (n.select) { n.select(); } toast('Copy did not work here — select the text and copy it.'); }
});
$('#btnAnother').onclick = async () => {
  const c = counts();
  if (!S.tour && S.photos.length && !confirm('Leave this capture? The ' + c.photos + ' photos saved here will be deleted.')) return;
  await wipe(); show('start');
};

/* ---------- restore on load ---------- */
(async () => {
  await refreshSession();
  if (location.hash && /access_token|error/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  let saved = null;
  try { saved = await sessionGet(); } catch (e) { toast('This browser is not letting the page save files (private mode?). You can still capture, but a reload loses everything.'); }
  if (saved && saved.captureId && (saved.photos?.length || saved.rooms?.length)) {
    S = Object.assign(blank(), saved);
    S.photos.forEach(p => { if (p.status === 'uploading') p.status = 'queued'; });
    if (S.plan && S.plan.status === 'uploading') S.plan.status = 'queued';
    renderStart(); renderStrip();
  }
  if (MOCK) { $('#devtools').hidden = false; devTools(); }
})();

/* ---------- dev mock ---------- */
async function mockApi(payload){
  await sleep(300);
  const prefix = 'captures/mock-prop/mock-cap';
  // test switches: window.__mockFail makes every upload_url fail, window.__mock401 makes every call answer 401
  if (window.__mock401) throw new AuthError('Sign in to do that.');
  if (payload.action === 'upload_url') {
    window.__mockCalls = (window.__mockCalls || []); window.__mockCalls.push(payload.filename);
    if (window.__mockFail === true || (window.__mockFail && payload.filename.includes(window.__mockFail))) throw new Error('mock: no signal');
  }
  switch (payload.action) {
    case 'register_capture': return { capture_id: 'mock-cap', property_id: 'mock-prop', storage_prefix: prefix, address: payload.address, existing_tour: null };
    case 'upload_url': return { upload_url: 'data:application/octet-stream;base64,', path: prefix + '/' + payload.filename };
    case 'complete_capture': {
      const problems = [];
      payload.nodes.forEach(n => { if (!n.path || !n.path.startsWith(prefix + '/')) problems.push(n.key + ': bad path'); if (!(n.width >= 2048 && n.height >= 1024)) problems.push(n.key + ': too small'); });
      if (problems.length) { const e = new Error('rejected'); e.status = 422; e.body = { ok: false, problems }; throw e; }
      return { ok: true, tour: mockTour('unlisted'), nodes: payload.nodes.length, rooms: S.rooms.length };
    }
    case 'go_live': return { ok: true, tour: mockTour('published') };
    default: throw new Error('mock: unknown action ' + payload.action);
  }
}
function mockTour(status){
  return { id: 'mock-tour', slug: 'mock-14-example-street', status, title: S.address, branding: null, spawn: null, view_key: 'mockvk', published_at: status === 'published' ? new Date().toISOString() : null,
    created_at: new Date().toISOString(), property: { id: 'mock-prop', address: S.address, has_floorplan: !!S.plan }, counts: { nodes: S.photos.length, rooms: S.rooms.length, leads: 0 },
    urls: { preview: '/tour/?t=mock-14-example-street&vk=mockvk', live: '/tour/?t=mock-14-example-street' } };
}
function devTools(){
  window.__cap = { get state(){ return S; }, acceptFile, addFiles, acceptPlan, buildManifest, addRoom, show, thumbs, sphere, bearing, norm360, norm180, refreshSession, pump };
  $('#btnTestSet').onclick = async () => {
    if (!S.captureId) { $('#addr').value = $('#addr').value || '14 Example Street, SW1A 1AA'; await $('#go').onclick(); }
    const plan = [['Hallway', ['test-hall.jpg']], ['Kitchen', ['test-kitchen.jpg', 'test-kitchen-2.jpg']], ['Bedroom', ['test-bedroom.jpg']]];
    for (const [name, files] of plan) {
      const r = S.rooms.find(x => x.name === name) || addRoom(name);
      const fs = [];
      for (const f of files) { const res = await fetch('./dev/' + f); if (!res.ok) { toast('dev: ' + f + ' missing'); continue; } fs.push(new File([await res.blob()], f, { type: 'image/jpeg', lastModified: Date.now() })); }
      await addFiles(fs, r.id);
    }
    const fp = await fetch('./dev/test-floorplan.jpg');
    if (fp.ok) await acceptPlan(new File([await fp.blob()], 'test-floorplan.jpg', { type: 'image/jpeg' }));
    show('rooms');
  };
}
