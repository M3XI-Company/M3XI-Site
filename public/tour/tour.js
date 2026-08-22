/* ===========================================================================
   The tour a buyer sees.

   Each standpoint is one full-sphere photograph (equirectangular). It is
   painted on the inside of a sphere with the viewer at the centre, so looking
   around is exactly what the camera recorded — nothing stitched, nothing
   invented. Moving between standpoints waits until the next photo is fully
   loaded, then cross-zooms into it. When WebGL is not available the same
   photo is shown as a flat, draggable strip instead. Never a blank page.

   Conventions (docs/TOUR_API.md): yaw 0 = image centre = where the camera
   faced; yaw increases turning right. north_deg = the yaw that points to the
   floorplan's up. Pins are fractions of the plan image, origin top-left.
   =========================================================================== */

const SB = 'https://tnlcuptfldwxtxajudoq.supabase.co';
const FN = SB + '/functions/v1/m3ix-spatial';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRubGN1cHRmbGR3eHR4YWp1ZG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODcxNDEsImV4cCI6MjEwMDA2MzE0MX0.mgS1gDa7qeBsTCaXmefpogg02kw7tCzn0uEYPAAuC90';
const SITE = 'https://www.m3xi.com';

const Q = new URLSearchParams(location.search);
// /tour/<slug> is served by api/tour.js, which injects window.__M3IX_TOUR; /tour/?t=<slug> is the static form.
const INJ = (window.__M3IX_TOUR && typeof window.__M3IX_TOUR === 'object') ? window.__M3IX_TOUR : {};
const SLUG = (Q.get('t') || Q.get('tour') || INJ.slug || '').trim();
const VK = (Q.get('vk') || INJ.vk || '').trim();
const EMBED = Q.get('embed') === '1';
const START = Q.get('n') || '';
// Dev-only switches: inert on the live host.
const DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const MOCK = DEV ? Q.get('mock') : null;
const FORCE_FLAT = DEV && Q.get('flat') === '1';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const MAX_FULL = 6;                    // full-size textures kept in memory
const FOV_MIN = 30, FOV_MAX = 100, FOV_DEFAULT = 75, PITCH_MAX = 85;
const ARROW_PITCH = -25, ARROW_DIST = 22, SPHERE_R = 50;
const MOVE_MS = 500;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180;
const delta = (from, to) => wrap180(to - from);
const ease = t => t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- state */
const S = {
  manifest: null, rooms: [], roomsById: new Map(), nodesById: new Map(), nodesByRoom: new Map(),
  node: null, yaw: 0, pitch: 0, fov: FOV_DEFAULT,
  mode: 'boot',            // '3d' | 'flat'
  busy: false, ready: false, arrows: [], gyro: null,
};
let tick = 0;

// For tests and for anyone debugging a tour in the console.
window.__tour = {
  get yaw() { return S.yaw; }, get pitch() { return S.pitch; }, get fov() { return S.fov; },
  get node() { return S.node ? S.node.id : null; }, get mode() { return S.mode; }, get ready() { return S.ready; },
  get arrows() { return S.arrows.map(a => ({ target: a.target.id, yaw: a.yaw, fallback: !!a.fallback })); },
  get textures() { return countFull(); },
  goTo: id => goTo(id), look: (y, p) => setView(y, p), state: S,
};

const stage = $('#stage'), liveEl = $('#live');
const roomName = n => (S.roomsById.get(n.room_id) || {}).name || 'Room';
const nodeTitle = n => n.label || roomName(n);
const agencyName = () => (S.manifest && S.manifest.tour && S.manifest.tour.branding && S.manifest.tour.branding.name) || 'the agent';

/* ------------------------------------------------------------- the API */
class ApiError extends Error {
  constructor(kind, status, message) { super(message); this.kind = kind; this.status = status; }
}
async function api(body) {
  let r;
  try {
    r = await fetch(FN, { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body) });
  } catch (e) { throw new ApiError('network', 0, 'network'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError('http', r.status, j.error || ('HTTP ' + r.status));
  return j;
}
async function fetchManifest() {
  if (MOCK) {
    let r;
    try { r = await fetch(MOCK, { cache: 'no-store' }); } catch (e) { throw new ApiError('network', 0, 'network'); }
    if (!r.ok) throw new ApiError('http', r.status, 'mock manifest ' + r.status);
    return r.json();
  }
  return api({ action: 'manifest', slug: SLUG, view_key: VK || undefined });
}
function friendly(e) {
  if (e && e.kind === 'network') return { msg: "Couldn't load the tour — check your connection and try again.", retry: true };
  if (e && e.status === 403) return { msg: "This tour isn't live yet — ask the agent for a link.", retry: false };
  if (e && e.status === 404) return { msg: "We can't find that tour.", retry: false };
  const why = e instanceof ApiError && e.message && e.message !== 'network' ? ' (' + e.message + ')' : '';
  return { msg: "Couldn't load the tour" + why + ' — try again.', retry: true };
}

function ingest(m) {
  S.manifest = m;
  S.rooms = [...(m.rooms || [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  S.roomsById = new Map(S.rooms.map(r => [r.id, r]));
  S.nodesById = new Map(); S.nodesByRoom = new Map();
  for (const n of [...(m.nodes || [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
    n.links = Array.isArray(n.links) ? n.links : [];
    S.nodesById.set(n.id, n);
    if (!S.nodesByRoom.has(n.room_id)) S.nodesByRoom.set(n.room_id, []);
    S.nodesByRoom.get(n.room_id).push(n);
  }
}
// Signed URLs expire; a fresh manifest only swaps the URLs, the view is untouched.
let refreshing = null, expiryTimer = 0;
function refreshManifest() {
  if (refreshing) return refreshing;
  refreshing = fetchManifest().then(m => {
    const byId = new Map((m.nodes || []).map(n => [n.id, n]));
    for (const n of S.nodesById.values()) { const f = byId.get(n.id); if (f) { n.url = f.url; n.preview_url = f.preview_url; } }
    if (m.floorplan && m.floorplan.url && S.manifest.floorplan) S.manifest.floorplan.url = m.floorplan.url;
    if (m.expires_in) S.manifest.expires_in = m.expires_in;
    scheduleRefresh();
  }).finally(() => { refreshing = null; });
  return refreshing;
}
function scheduleRefresh() {
  clearTimeout(expiryTimer);
  const secs = Number(S.manifest && S.manifest.expires_in) || 3600;
  expiryTimer = setTimeout(() => refreshManifest().catch(() => {}), Math.max(15000, (secs - 120) * 1000));
}

/* ------------------------------------------------------- image loading */
async function fetchImage(url, onProgress) {
  const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  let blob;
  const total = Number(r.headers.get('content-length')) || 0;
  if (onProgress && total && r.body) {
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; onProgress(got / total);
    }
    blob = new Blob(chunks, { type: r.headers.get('content-type') || 'image/jpeg' });
  } else blob = await r.blob();
  // Load, don't img.decode(): decode() stalls in documents that are not being painted
  // (background tab, embedded frame scrolled away). The GPU upload decodes anyway.
  const img = new Image();
  const u = URL.createObjectURL(blob);
  img._blobUrl = u;
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('undecodable image')); img.src = u; })
    .catch(e => { URL.revokeObjectURL(u); throw e; });
  return img;
}
// Try once; if it fails the signed URL has probably expired, so ask for a new one and try again.
async function fetchImageRetry(urlOf, onProgress) {
  try { return await fetchImage(urlOf(), onProgress); }
  catch (e) {
    await refreshManifest().catch(() => {});
    return fetchImage(urlOf(), onProgress);
  }
}

/* --------------------------------------------------------- 3D textures */
let THREE = null, renderer = null, maxAniso = 1, raycaster = null;
const cache = new Map(); // node id -> { full, preview, fullP, previewP, used }
function entry(id) { let e = cache.get(id); if (!e) { e = { full: null, preview: null, fullP: null, previewP: null, used: 0 }; cache.set(id, e); } return e; }
function countFull() { let n = 0; for (const e of cache.values()) if (e.full) n++; return n; }
function countPreview() { let n = 0; for (const e of cache.values()) if (e.preview) n++; return n; }
function makeTexture(img) {
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  t.needsUpdate = true;
  return t;
}
function disposeTexture(t) {
  if (t.image && t.image._blobUrl) URL.revokeObjectURL(t.image._blobUrl);
  t.dispose();
}
function loadLevel(node, level, onProgress) {
  const e = entry(node.id), key = level, pkey = level + 'P';
  if (e[key]) { e.used = ++tick; return Promise.resolve(e[key]); }
  if (e[pkey]) return e[pkey];
  const urlOf = () => level === 'full' ? node.url : node.preview_url;
  e[pkey] = (async () => {
    const img = await fetchImageRetry(urlOf, onProgress);
    const t = makeTexture(img);
    if (renderer) renderer.initTexture(t);   // upload now, so the first frame with it is never late
    e[key] = t; e.used = ++tick;
    return t;
  })().finally(() => { e[pkey] = null; });
  return e[pkey];
}
function reportTextures() { console.debug('[tour] textures in memory: ' + countFull() + ' full, ' + countPreview() + ' preview'); }
function evict() {
  const keep = new Set([S.node.id, ...S.node.links]);
  const victims = [...cache.entries()].filter(([id, e]) => e.full && !keep.has(id)).sort((a, b) => a[1].used - b[1].used);
  for (const [, e] of victims) {
    if (countFull() <= MAX_FULL) break;
    disposeTexture(e.full); e.full = null;
  }
  reportTextures();
}
// The current standpoint and everything one step away: small previews first, then full size.
function preloadLinks() {
  if (S.mode !== '3d') return;
  const targets = S.node.links.map(id => S.nodesById.get(id)).filter(Boolean);
  const big = n => (n.width || 0) * (n.height || 0) > 3000 * 1500;
  const previews = targets.filter(n => n.preview_url && n.preview_url !== n.url && big(n));
  Promise.all(previews.map(n => loadLevel(n, 'preview').catch(() => {})))
    .then(() => Promise.all(targets.map(n => loadLevel(n, 'full').catch(() => {}))))
    .then(() => { if (S.node) evict(); });
}

/* ----------------------------------------------------------- geometry */
function dirOf(yawDeg, pitchDeg, out) {
  const y = yawDeg * D2R, p = pitchDeg * D2R, c = Math.cos(p);
  return out.set(-c * Math.cos(y), Math.sin(p), -c * Math.sin(y));
}
/* Pins are fractions of the plan image; bearings are measured in plan
   PIXELS so a wide plan is not squashed — the capture page calibrated
   north_deg the same way, so the two must agree. */
function planDims() {
  const fp = S.manifest && S.manifest.floorplan;
  const img = document.getElementById('planImg');
  const w = (fp && fp.width > 0) ? fp.width : (img && img.naturalWidth) || 1;
  const h = (fp && fp.height > 0) ? fp.height : (img && img.naturalHeight) || 1;
  return [w, h];
}
function yawTo(a, b) {
  if (a.pin && b.pin && a.north_deg !== null && a.north_deg !== undefined) {
    const [pw, ph] = planDims();
    const dx = (b.pin.x - a.pin.x) * pw, dy = (b.pin.y - a.pin.y) * ph;
    return wrap180(a.north_deg + Math.atan2(dx, -dy) / D2R);
  }
  return null;
}
function arrivalYaw(from, to) {
  if (from.north_deg !== null && from.north_deg !== undefined && to.north_deg !== null && to.north_deg !== undefined)
    return wrap180(S.yaw - from.north_deg + to.north_deg);
  return 0;
}

/* ------------------------------------------------------------ renderer */
const layers = []; let cur = 0, arrowScene = null, hitMeshes = [], needs = true, rafId = 0;
let V3 = null;
function invalidate() { needs = true; }

async function init3D() {
  if (FORCE_FLAT) return false;
  try { THREE = await import('three'); } catch (e) { console.warn('[tour] three.js did not load', e); return false; }
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { console.warn('[tour] WebGL unavailable', e); renderer = null; return false; }
  V3 = new THREE.Vector3();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  maxAniso = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
  raycaster = new THREE.Raycaster();
  const geo = new THREE.SphereGeometry(SPHERE_R, 64, 32);
  for (let i = 0; i < 2; i++) {
    const scene = new THREE.Scene();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.x = -1;                   // paint the inside
    scene.add(mesh);
    const cam = new THREE.PerspectiveCamera(FOV_DEFAULT, 1, 0.1, 200);
    layers.push({ scene, mesh, mat, cam });
  }
  arrowScene = new THREE.Scene();
  renderer.domElement.setAttribute('aria-hidden', 'true');
  stage.appendChild(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); }, false);
  renderer.domElement.addEventListener('webglcontextrestored', () => invalidate(), false);
  resize();
  return true;
}
function resize() {
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  if (renderer) {
    renderer.setSize(w, h, false);
    for (const L of layers) { L.cam.aspect = w / h; L.cam.updateProjectionMatrix(); }
  }
  if (S.mode === 'flat') drawFlat();
  invalidate();
}
new ResizeObserver(resize).observe(stage);

function applyCam(cam, yaw, pitch, fov) {
  if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
  cam.position.set(0, 0, 0);
  cam.lookAt(dirOf(yaw, pitch, V3));
}
function draw() {
  const L = layers[cur];
  applyCam(L.cam, S.yaw, S.pitch, S.fov);
  renderer.clear();
  renderer.render(L.scene, L.cam);
  if (trans) {
    const N = layers[1 - cur];
    applyCam(N.cam, trans.yawB, S.pitch, trans.fovB);
    renderer.clearDepth();
    renderer.render(N.scene, N.cam);
  } else {
    renderer.clearDepth();
    renderer.render(arrowScene, L.cam);
  }
}
let lastT = 0;
function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(50, now - (lastT || now)); lastT = now;
  stepInertia(dt);
  stepTransition(now);
  if (!needs) return;
  needs = false;
  if (S.mode === '3d') draw(); else if (S.mode === 'flat') drawFlat();
  updateCone();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(rafId); rafId = 0; lastT = 0; }
  else if (!rafId && S.ready) rafId = requestAnimationFrame(frame);
});

/* -------------------------------------------------------------- arrows */
let chevGeo = null;
function makeLabelSprite(text) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  const font = '700 40px "Segoe UI", system-ui, -apple-system, sans-serif';
  ctx.font = font;
  c.width = clamp(Math.ceil(ctx.measureText(text).width) + 56, 160, 1024); c.height = 84;
  ctx.font = font;
  ctx.fillStyle = 'rgba(22,21,18,.86)'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, c.width - 4, c.height - 4);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  const h = 1.35; s.scale.set(h * c.width / c.height, h, 1);
  return s;
}
function makeArrow(a) {
  if (!chevGeo) {
    const sh = new THREE.Shape();
    sh.moveTo(-1.0, 0); sh.lineTo(0.15, 0.85); sh.lineTo(0.15, 0.42); sh.lineTo(-0.42, 0);
    sh.lineTo(0.15, -0.42); sh.lineTo(0.15, -0.85); sh.closePath();
    chevGeo = new THREE.ShapeGeometry(sh);
  }
  const g = new THREE.Group();
  dirOf(a.yaw, ARROW_PITCH, g.position).multiplyScalar(ARROW_DIST);
  const inner = new THREE.Group(); inner.rotation.y = -a.yaw * D2R; g.add(inner);
  const flat = m => { m.rotation.x = -Math.PI / 2; return m; };
  const ring = flat(new THREE.Mesh(new THREE.RingGeometry(1.45, 1.95, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .8, depthTest: false, side: THREE.DoubleSide })));
  const chev = flat(new THREE.Mesh(chevGeo,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95, depthTest: false, side: THREE.DoubleSide })));
  const hit = flat(new THREE.Mesh(new THREE.CircleGeometry(3, 24),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false })));
  hit.userData.arrow = a;
  inner.add(ring, chev, hit);
  const label = makeLabelSprite(nodeTitle(a.target)); label.position.y = 2.4; g.add(label);
  a.ring = ring; a.chev = chev; a.hit = hit; a.obj = g;
  return g;
}
function clearArrows() {
  hot = null; stage.classList.remove('hot');
  if (arrowScene) {
    for (const a of S.arrows) {
      if (!a.obj) continue;
      a.obj.traverse(o => { if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } if (o.geometry && o.geometry !== chevGeo) o.geometry.dispose(); });
      arrowScene.remove(a.obj);
    }
  }
  S.arrows = []; hitMeshes = [];
}
function buildArrows() {
  clearArrows();
  const links = S.node.links.map(id => S.nodesById.get(id)).filter(Boolean);
  const placed = links.map(t => ({ target: t, yaw: yawTo(S.node, t), fallback: false }));
  const fb = placed.filter(p => p.yaw === null);
  fb.forEach((p, i) => { p.yaw = fb.length === 1 ? 0 : wrap180(i * 360 / fb.length); p.fallback = true; });
  S.arrows = placed;
  if (S.mode === '3d') for (const a of S.arrows) { arrowScene.add(makeArrow(a)); hitMeshes.push(a.hit); }
  renderArrowList();
  invalidate();
}
function renderArrowList() {
  const ul = $('#arrowList'); ul.textContent = '';
  ul.classList.toggle('srmode', S.mode === '3d');
  for (const a of S.arrows) {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button';
    const t = nodeTitle(a.target), r = roomName(a.target);
    b.textContent = 'Go to ' + (t === r ? t : r + ' — ' + t);
    b.dataset.id = a.target.id;
    b.addEventListener('click', () => goTo(a.target.id, { viaYaw: a.yaw }));
    li.appendChild(b); ul.appendChild(li);
  }
}
function setArrowBusy(id, on) {
  for (const b of $$('#arrowList button')) if (b.dataset.id === id) b.setAttribute('aria-busy', on ? 'true' : 'false');
}
function pick(clientX, clientY) {
  if (S.mode !== '3d' || !hitMeshes.length) return null;
  const r = stage.getBoundingClientRect();
  const x = ((clientX - r.left) / r.width) * 2 - 1, y = -((clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera({ x, y }, layers[cur].cam);
  const hits = raycaster.intersectObjects(hitMeshes, false);
  return hits.length ? hits[0].object.userData.arrow : null;
}
let hot = null;
function setHot(a) {
  if (hot === a) return;
  if (hot) { hot.ring.material.color.set(0xffffff); hot.chev.material.color.set(0xffffff); hot.ring.scale.setScalar(1); }
  hot = a;
  if (hot) { hot.ring.material.color.set(S.brandHex); hot.chev.material.color.set(S.brandHex); hot.ring.scale.setScalar(1.08); }
  stage.classList.toggle('hot', !!hot);
  invalidate();
}

/* -------------------------------------------------------------- moving */
let trans = null;
function setView(yaw, pitch) {
  S.yaw = wrap180(yaw);
  S.pitch = clamp(pitch, -(S.mode === 'flat' ? 40 : PITCH_MAX), S.mode === 'flat' ? 40 : PITCH_MAX);
  if (S.mode === 'flat') { drawFlat(); updateCone(); }
  invalidate();
}
// The new sphere becomes the current one in the same step that ends the fade,
// so no frame is ever drawn with the old picture alone.
function swapLayers(yaw, fov) {
  cur = 1 - cur;
  layers[cur].mat.opacity = 1;
  layers[1 - cur].mat.map = null; layers[1 - cur].mat.needsUpdate = true;
  S.yaw = wrap180(yaw); S.fov = fov;
}
function stepTransition(now) {
  if (!trans) return;
  const k = clamp((now - trans.t0) / trans.dur, 0, 1), e = ease(k);
  S.yaw = wrap180(trans.yaw0 + trans.turn * e);
  S.fov = trans.fov0 * (1 - 0.4 * e);
  trans.fovB = trans.fov0 * (0.85 + 0.15 * e);
  layers[1 - cur].mat.opacity = e;
  invalidate();
  if (k >= 1) { const t = trans; trans = null; swapLayers(t.yawB, t.fov0); t.done(); }
}
async function goTo(id, opts = {}) {
  const target = S.nodesById.get(id);
  if (!target || S.busy || !S.ready || target === S.node) return;
  S.busy = true; stage.classList.add('moving'); setArrowBusy(id, true);
  const from = S.node;
  try {
    let tex = null;
    if (S.mode === '3d') tex = await loadLevel(target, 'full');
    else await preloadFlat(target);
    const arrive = arrivalYaw(from, target);
    let via = opts.viaYaw; if (via === undefined || via === null) via = yawTo(from, target); if (via === null) via = S.yaw;
    if (S.mode === 'flat') { setFlat(target); S.yaw = arrive; finish(target); return; }

    const N = layers[1 - cur];
    N.mat.map = tex; N.mat.opacity = 0; N.mat.needsUpdate = true;
    if (REDUCED || document.hidden) swapLayers(arrive, S.fov);
    else {
      const turn = delta(S.yaw, via);
      await new Promise(res => {
        const t = { t0: performance.now(), dur: MOVE_MS, yaw0: S.yaw, turn: Math.abs(turn) <= 90 ? turn : 0,
                    fov0: S.fov, fovB: S.fov * 0.85, yawB: arrive, done: res };
        trans = t;
        invalidate();
        // Frames stop when a tab is backgrounded or an embedded frame scrolls out of view;
        // never leave the move half-done waiting for one.
        setTimeout(() => { if (trans === t) { trans = null; swapLayers(t.yawB, t.fov0); t.done(); } }, MOVE_MS + 400);
      });
    }
    finish(target);
  } catch (e) {
    console.warn('[tour] move failed', e);
    toast("Couldn't load that standpoint — try again.");
    S.busy = false; stage.classList.remove('moving'); setArrowBusy(id, false);
  }
}
function finish(target) {
  S.node = target;
  setView(S.yaw, S.pitch);
  S.busy = false; stage.classList.remove('moving');
  buildArrows(); updateChrome();
  announce();
  preloadLinks();
  if (S.mode === '3d') evict();
  invalidate();
}
function announce() {
  const r = roomName(S.node), t = nodeTitle(S.node);
  liveEl.textContent = 'Now in ' + (t === r ? r : r + ' — ' + t);
}

/* ----------------------------------------------------------- flat mode */
const flatEl = $('#flat');
function preloadFlat(node) {
  return new Promise((res, rej) => {
    const tryLoad = (again) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => { if (again) refreshManifest().catch(() => {}).then(() => tryLoad(false)); else rej(new Error('image')); };
      im.src = node.url;
    };
    tryLoad(true);
  });
}
function setFlat(node) { flatEl.style.backgroundImage = 'url("' + node.url.replace(/"/g, '%22') + '")'; }
function drawFlat() {
  if (S.mode !== 'flat') return;
  const w = stage.clientWidth, h = stage.clientHeight;
  const ih = h * 1.8, iw = ih * 2;
  const x = w / 2 - iw / 2 - (S.yaw / 360) * iw;
  const y = (h - ih) / 2 + (S.pitch / 180) * ih;
  flatEl.style.backgroundSize = iw + 'px ' + ih + 'px';
  flatEl.style.backgroundPosition = x + 'px ' + y + 'px';
}

/* --------------------------------------------------------------- input */
const ptrs = new Map();
let drag = null, inertia = null, pinch0 = null;
const degPerPx = () => (S.mode === 'flat' ? 80 : S.fov) / Math.max(1, stage.clientHeight);
function isTyping(el) {
  if (!el) return false;
  const t = (el.tagName || '').toLowerCase();
  return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
}
stage.addEventListener('pointerdown', e => {
  if (!S.ready) return;
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) {
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, t: performance.now(), vy: 0, vp: 0 };
    inertia = null; stage.classList.add('drag'); hideHint();
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: S.fov }; drag = null;
  }
});
stage.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch0 && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    setFov(pinch0.fov * pinch0.d / d); return;
  }
  if (drag && e.pointerId === drag.id) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    const now = performance.now(), dt = Math.max(1, now - drag.t);
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) drag.moved = true;
    if (S.busy) return;
    const k = degPerPx();
    const dyaw = -dx * k, dpitch = dy * k;   // drag left = turn right; pull the picture down = look up
    if (S.gyro) S.gyro.offset = wrap180(S.gyro.offset + dyaw);
    else setView(S.yaw + dyaw, S.pitch + dpitch);
    drag.vy = 0.6 * drag.vy + 0.4 * (dyaw / dt); drag.vp = 0.6 * drag.vp + 0.4 * (dpitch / dt);
    return;
  }
  if (e.pointerType === 'mouse' && !ptrs.size && S.mode === '3d') setHot(pick(e.clientX, e.clientY));
});
function endPointer(e) {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch0 = null;
  if (drag && e.pointerId === drag.id) {
    const d = drag; drag = null; stage.classList.remove('drag');
    if (!d.moved) {
      const a = pick(e.clientX, e.clientY);
      if (a) goTo(a.target.id, { viaYaw: a.yaw });
      // Tapping the floor anywhere else does nothing, on purpose.
    } else if (!REDUCED && !S.gyro && performance.now() - d.t < 80 && (Math.abs(d.vy) > 0.02 || Math.abs(d.vp) > 0.02)) {
      inertia = { vy: clamp(d.vy, -0.25, 0.25), vp: clamp(d.vp, -0.25, 0.25) };   // subtle: at most ~20° of carry
    }
  }
  if (!ptrs.size) stage.classList.remove('drag');
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('lostpointercapture', e => { if (ptrs.has(e.pointerId)) endPointer(e); });
function stepInertia(dt) {
  if (!inertia || S.busy) { if (S.busy) inertia = null; return; }
  setView(S.yaw + inertia.vy * dt, S.pitch + inertia.vp * dt);
  const f = Math.exp(-dt / 80); inertia.vy *= f; inertia.vp *= f;
  if (Math.abs(inertia.vy) < 0.004 && Math.abs(inertia.vp) < 0.004) inertia = null;
}
function setFov(f) { if (S.mode !== '3d') return; S.fov = clamp(f, FOV_MIN, FOV_MAX); invalidate(); }
stage.addEventListener('wheel', e => { if (!S.ready) return; e.preventDefault(); setFov(S.fov + e.deltaY * 0.05); }, { passive: false });
addEventListener('keydown', e => {
  if (!S.ready || isTyping(e.target) || openDialogs.length || e.altKey || e.ctrlKey || e.metaKey) return;
  const step = e.shiftKey ? 15 : 5;
  let used = true;
  switch (e.key) {
    case 'ArrowLeft': setView(S.yaw - step, S.pitch); break;
    case 'ArrowRight': setView(S.yaw + step, S.pitch); break;
    case 'ArrowUp': setView(S.yaw, S.pitch + step); break;
    case 'ArrowDown': setView(S.yaw, S.pitch - step); break;
    case '+': case '=': setFov(S.fov - 5); break;
    case '-': case '_': setFov(S.fov + 5); break;
    default: used = false;
  }
  if (used) { e.preventDefault(); hideHint(); inertia = null; }
});
let hintTimer = setTimeout(hideHint, 6000);
function hideHint() { clearTimeout(hintTimer); const h = $('#hint'); if (!h) return; h.style.opacity = '0'; setTimeout(() => h.remove(), 600); }

/* --------------------------------------------------- look with the phone */
const gyroBtn = $('#gyroBtn');
function gyroPossible() { return 'DeviceOrientationEvent' in window && (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window); }
let gyroQ = null, gyroE = null, gyroQ0 = null, gyroQ1 = null, gyroZ = null;
function onOrient(ev) {
  if (!S.gyro || ev.alpha === null || ev.alpha === undefined) return;
  const alpha = ev.alpha * D2R, beta = (ev.beta || 0) * D2R, gamma = (ev.gamma || 0) * D2R;
  const orient = ((screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0)) * D2R;
  gyroE.set(beta, alpha, -gamma, 'YXZ');
  gyroQ.setFromEuler(gyroE);
  gyroQ.multiply(gyroQ1);                                  // look out of the back of the phone
  gyroQ.multiply(gyroQ0.setFromAxisAngle(gyroZ, -orient)); // allow for landscape
  V3.set(0, 0, -1).applyQuaternion(gyroQ);
  const yawDev = Math.atan2(-V3.z, -V3.x) / D2R, pitchDev = Math.asin(clamp(V3.y, -1, 1)) / D2R;
  if (S.gyro.offset === null) S.gyro.offset = delta(yawDev, S.yaw);   // no jump when switching on
  if (S.busy) return;
  setView(yawDev + S.gyro.offset, pitchDev);
}
async function toggleGyro() {
  if (S.gyro) {
    removeEventListener('deviceorientation', onOrient); S.gyro = null;
    gyroBtn.setAttribute('aria-pressed', 'false'); gyroBtn.textContent = 'Look with your phone'; return;
  }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') { toast('Motion access was not allowed — you can still drag to look around.'); return; }
    }
  } catch (e) { toast('Motion access was not allowed — you can still drag to look around.'); return; }
  if (!gyroQ) { gyroQ = new THREE.Quaternion(); gyroE = new THREE.Euler(); gyroQ0 = new THREE.Quaternion(); gyroZ = new THREE.Vector3(0, 0, 1); gyroQ1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); }
  S.gyro = { offset: null }; inertia = null;
  addEventListener('deviceorientation', onOrient);
  gyroBtn.setAttribute('aria-pressed', 'true'); gyroBtn.textContent = 'Stop using phone';
  hideHint();
}
gyroBtn.addEventListener('click', toggleGyro);

/* ------------------------------------------------------------- dialogs */
const openDialogs = [];
const focusables = el => $$('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])', el)
  .filter(x => x.offsetParent !== null || x === document.activeElement);
function trapKeys(e) {
  const el = e.currentTarget;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(el); return; }
  if (e.key !== 'Tab') return;
  const f = focusables(el); if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function openDialog(el, focusSel) {
  if (el.classList.contains('open')) return;
  el._opener = document.activeElement;
  el.classList.add('open');
  el.addEventListener('keydown', trapKeys);
  openDialogs.push(el);
  const f = focusSel ? $(focusSel, el) : focusables(el)[0];
  (f || el).focus();
}
function closeDialog(el) {
  if (!el.classList.contains('open')) return;
  el.classList.remove('open');
  el.removeEventListener('keydown', trapKeys);
  const i = openDialogs.indexOf(el); if (i >= 0) openDialogs.splice(i, 1);
  const o = el._opener; el._opener = null;
  if (o && o.focus && document.contains(o)) o.focus(); else stage.focus();
}
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* ------------------------------------------------------------- enquire */
const leadEl = $('#lead');
$('#enqBtn').addEventListener('click', () => { $('#lstatus').textContent = ''; $('#lstatus').className = 'status'; openDialog(leadEl, '#lname'); });
$('#lcancel').addEventListener('click', () => closeDialog(leadEl));
$('#lsend').addEventListener('click', sendLead);
leadEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); sendLead(); } });
async function sendLead() {
  const st = $('#lstatus'), name = $('#lname').value.trim(), contact = $('#lcontact').value.trim(), message = $('#lmsg').value.trim();
  const show = (m, cls) => { st.textContent = m; st.className = 'status ' + (cls || ''); };
  if (!contact) { show('Add an email or phone number so ' + agencyName() + ' can reply to you.', 'bad'); $('#lcontact').focus(); return; }
  const send = $('#lsend'); send.disabled = true; show('Sending…');
  const r0 = roomName(S.node), t0 = nodeTitle(S.node);
  const body = { action: 'lead', slug: SLUG, view_key: VK || undefined, name, contact, message,
    node_label: t0 === r0 ? r0 : r0 + ' — ' + t0 };
  try {
    let r, j;
    if (MOCK) { await sleep(300); r = { ok: true, status: 200 }; j = { ok: true, lead_id: 'mock' }; console.debug('[tour] mock lead (not sent)', body); }
    else {
      r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
      j = await r.json().catch(() => ({}));
    }
    if (r.ok && j.ok) {
      show('Sent — ' + agencyName() + ' will be in touch.', 'good');
      $('#lmsg').value = '';
      setTimeout(() => { if (leadEl.classList.contains('open')) closeDialog(leadEl); }, 2600);
    } else {
      show("Couldn't send: " + (j.error || ('HTTP ' + r.status)) + ' — check the details and try again.', 'bad');
    }
  } catch (e) {
    show("Couldn't send — check your connection and try again.", 'bad');
  } finally { send.disabled = false; }
}

/* --------------------------------------------------------------- share */
const shareEl = $('#shareBox');
function liveUrl() {
  const u = new URL(location.origin + '/tour/');
  u.searchParams.set('t', SLUG); if (VK) u.searchParams.set('vk', VK);
  return u.toString();
}
function embedSnippet() { return '<script src="' + SITE + '/tour/embed.js" data-tour="' + SLUG.replace(/"/g, '') + '" async><' + '/script>'; }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); return ok;
}
$('#shareBtn').addEventListener('click', async () => {
  const url = liveUrl();
  const ok = await copyText(url);
  if (EMBED) { toast(ok ? 'Link copied' : "Couldn't copy — the link is " + url, ok ? 2200 : 6000); return; }
  $('#shareUrl').value = url; $('#embedCode').value = embedSnippet();
  $('#shareStatus').textContent = ok ? 'Link copied to your clipboard.' : "Couldn't copy automatically — select the link and copy it.";
  $('#shareStatus').className = 'status ' + (ok ? 'good' : 'bad');
  openDialog(shareEl, '#shareClose');
});
$('#copyUrl').addEventListener('click', async () => { $('#shareStatus').textContent = (await copyText($('#shareUrl').value)) ? 'Link copied.' : "Couldn't copy — select it and copy."; });
$('#copyEmbed').addEventListener('click', async () => { $('#shareStatus').textContent = (await copyText($('#embedCode').value)) ? 'Embed code copied.' : "Couldn't copy — select it and copy."; });
$('#shareClose').addEventListener('click', () => closeDialog(shareEl));
for (const id of ['#shareUrl', '#embedCode']) $(id).addEventListener('focus', e => e.target.select());

/* ---------------------------------------------------------------- plan */
const planEl = $('#plan'), planBtn = $('#planBtn'), coneEl = $('#cone');
const isPhone = () => matchMedia('(max-width: 720px)').matches;
planBtn.addEventListener('click', () => openDialog(planEl, '#closePlan'));
$('#closePlan').addEventListener('click', () => closeDialog(planEl));
$('#collapseBtn').addEventListener('click', e => {
  const c = planEl.classList.toggle('collapsed');
  e.currentTarget.textContent = c ? 'Show' : 'Hide'; e.currentTarget.setAttribute('aria-expanded', c ? 'false' : 'true');
});
addEventListener('resize', () => { if (!isPhone() && planEl.classList.contains('open')) closeDialog(planEl); });
function planGo(id) { if (isPhone()) closeDialog(planEl); goTo(id); }
function buildPlan() {
  const fp = S.manifest.floorplan && S.manifest.floorplan.url;
  const wrap = $('#planWrap'), img = $('#planImg'), list = $('#planList');
  list.textContent = '';
  $$('.dot', wrap).forEach(d => d.remove());
  const pinned = fp ? [...S.nodesById.values()].filter(n => n.pin) : [];
  if (fp && pinned.length) {
    wrap.classList.add('on');
    let again = true;
    img.onerror = () => { if (again) { again = false; refreshManifest().catch(() => {}).then(() => { img.src = S.manifest.floorplan.url; }); } else { wrap.classList.remove('on'); listAll(); } };
    img.onload = () => { const fpm = S.manifest.floorplan; if (!(fpm && fpm.width > 0 && fpm.height > 0) && S.node) buildArrows(); };
    img.src = fp;
    for (const n of pinned) {
      const d = document.createElement('button'); d.type = 'button'; d.className = 'dot';
      d.style.left = (n.pin.x * 100) + '%'; d.style.top = (n.pin.y * 100) + '%';
      d.dataset.id = n.id; d.setAttribute('aria-label', 'Go to ' + roomName(n) + (nodeTitle(n) !== roomName(n) ? ' — ' + nodeTitle(n) : ''));
      d.title = nodeTitle(n);
      d.addEventListener('click', () => planGo(n.id));
      wrap.appendChild(d);
    }
    $('#planTitle').textContent = 'Plan';
    listNodes([...S.nodesById.values()].filter(n => !n.pin));
  } else {
    wrap.classList.remove('on');
    $('#planTitle').textContent = 'Rooms';
    listAll();
  }
  function listAll() { listNodes([...S.nodesById.values()]); }
  function listNodes(nodes) {
    list.textContent = '';
    for (const r of S.rooms) {
      const mine = nodes.filter(n => n.room_id === r.id); if (!mine.length) continue;
      const h = document.createElement('li'); h.className = 'room lbl'; h.textContent = r.name || 'Room'; list.appendChild(h);
      for (const n of mine) {
        const li = document.createElement('li'); const b = document.createElement('button'); b.type = 'button';
        b.textContent = nodeTitle(n); b.dataset.id = n.id; b.addEventListener('click', () => planGo(n.id));
        li.appendChild(b); list.appendChild(li);
      }
    }
  }
}
function updateCone() {
  const n = S.node; if (!n) return;
  const on = !!(n.pin && n.north_deg !== null && n.north_deg !== undefined && $('#planWrap').classList.contains('on'));
  coneEl.classList.toggle('on', on);
  if (!on) return;
  coneEl.style.left = (n.pin.x * 100) + '%'; coneEl.style.top = (n.pin.y * 100) + '%';
  coneEl.style.transform = 'translate(-50%,-50%) rotate(' + wrap180(S.yaw - n.north_deg).toFixed(1) + 'deg)';
}

/* -------------------------------------------------------------- chrome */
function fmtDate(iso) {
  const d = new Date(iso); if (!iso || isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function buildChrome() {
  const m = S.manifest, b = (m.tour && m.tour.branding) || {}, address = (m.property && m.property.address) || '';
  if (EMBED) document.body.classList.add('embed');
  S.brandHex = /^#[0-9a-f]{6}$/i.test(b.colour || '') ? parseInt(b.colour.slice(1), 16) : 0xd0402b;
  if (/^#[0-9a-f]{6}$/i.test(b.colour || '')) document.documentElement.style.setProperty('--brand', b.colour);
  const ag = $('#agency'); ag.textContent = '';
  if (b.logo_url) {
    const im = document.createElement('img'); im.src = b.logo_url; im.alt = b.name || 'Agency';
    im.onerror = () => { ag.textContent = b.name || ''; };
    ag.appendChild(im);
  } else ag.textContent = b.name || '';
  const ct = $('#contact'); ct.textContent = '';
  if (b.phone) { const a = document.createElement('a'); a.href = 'tel:' + String(b.phone).replace(/[^\d+]/g, ''); a.textContent = b.phone; ct.appendChild(a); }
  if (b.email) { const a = document.createElement('a'); a.href = 'mailto:' + b.email; a.textContent = b.email; ct.appendChild(a); }
  if (b.website) { const a = document.createElement('a'); a.href = b.website; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Website'; ct.appendChild(a); }
  $('#addr').textContent = address;
  const when = fmtDate(m.photographed_at);
  $('#shot').textContent = when ? 'Photographed ' + when : '';
  document.title = address && b.name ? address + ' — tour by ' + b.name : (address ? address + ' — tour' : 'Property tour');
  $('#gen').classList.toggle('on', !!(m.tour && m.tour.provenance !== 'captured'));

  const strip = $('#rooms'); strip.textContent = '';
  for (const r of S.rooms) {
    const nodes = S.nodesByRoom.get(r.id); if (!nodes || !nodes.length) continue;
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'rm'; btn.textContent = r.name || 'Room'; btn.dataset.id = r.id;
    btn.addEventListener('click', () => goTo(nodes[0].id));
    strip.appendChild(btn);
  }
  buildPlan();
  if (gyroPossible() && S.mode === '3d') gyroBtn.classList.add('can');
  if (EMBED && !isPhone()) { planEl.classList.add('collapsed'); $('#collapseBtn').textContent = 'Show'; $('#collapseBtn').setAttribute('aria-expanded', 'false'); }
}
function updateChrome() {
  const n = S.node, r = roomName(n), t = nodeTitle(n);
  $('#roomNow').textContent = t === r ? r : r + ' — ' + t;
  for (const b of $$('#rooms .rm')) b.classList.toggle('on', b.dataset.id === n.room_id);
  for (const b of $$('#plan .dot, #planList button')) b.classList.toggle('on', b.dataset.id === n.id);
  for (const b of $$('#plan .dot')) b.setAttribute('aria-current', b.dataset.id === n.id ? 'true' : 'false');
  updateCone();
}

/* ---------------------------------------------------------------- boot */
const loadEl = $('#load');
const setLoad = (pct, msg) => { $('#loadBar').style.width = pct + '%'; if (msg !== undefined) $('#loadMsg').textContent = msg; };
function showError(msg, retry) {
  loadEl.classList.remove('off'); loadEl.classList.add('err');
  setLoad(0, msg);
  $('#retryBtn').classList.toggle('on', !!retry);
  if (retry) $('#retryBtn').focus();
}
$('#retryBtn').addEventListener('click', () => { loadEl.classList.remove('err'); $('#retryBtn').classList.remove('on'); boot(); });

async function boot() {
  if (!SLUG) { showError('This page opens from a tour link — ask the agent for one.', false); return; }
  setLoad(8, 'Opening the tour…');
  let m;
  try { m = await fetchManifest(); }
  catch (e) { const f = friendly(e); showError(f.msg, f.retry); return; }
  if (!m || !Array.isArray(m.nodes)) { showError("Couldn't read the tour — try again.", true); return; }
  ingest(m);
  if (!S.nodesById.size) { showError('This tour has no photos yet — ask the agent to check it.', false); return; }
  setLoad(20, 'Preparing the view…');

  if (S.mode === 'boot') S.mode = (await init3D()) ? '3d' : 'flat';
  if (S.mode === 'flat') { flatEl.classList.add('on'); $('#flatMsg').classList.add('on'); }
  buildChrome();
  scheduleRefresh();

  const spawn = (m.tour && m.tour.spawn) || {};
  const first = S.nodesById.get(START) || S.nodesById.get(spawn.node_id) || S.nodesByRoom.get(S.rooms[0] && S.rooms[0].id)?.[0] || [...S.nodesById.values()][0];
  const yaw0 = first.id === spawn.node_id && typeof spawn.yaw === 'number' ? spawn.yaw : 0;
  setLoad(25, 'Loading the first standpoint…');
  try {
    if (S.mode === '3d') {
      const tex = await loadLevel(first, 'full', p => setLoad(25 + Math.round(p * 70)));
      layers[cur].mat.map = tex; layers[cur].mat.opacity = 1; layers[cur].mat.needsUpdate = true;
    } else {
      await preloadFlat(first); setFlat(first);
    }
  } catch (e) {
    console.warn('[tour] first image failed', e);
    showError("Couldn't load the tour — check your connection and try again.", true); return;
  }
  setLoad(100, '');
  S.node = first; S.yaw = wrap180(yaw0); S.pitch = 0; S.fov = FOV_DEFAULT;
  S.ready = true;
  buildArrows(); updateChrome(); announce();
  if (S.mode === '3d') draw(); else drawFlat();
  loadEl.classList.add('off');
  if (!rafId) rafId = requestAnimationFrame(frame);
  preloadLinks();
  if (S.mode === '3d') reportTextures();
}
boot();
