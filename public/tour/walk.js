/* ===========================================================================
   walk.js — walk mode inside the buyer's tour.

   A room may carry one real Gaussian-splat scan. This module opens it, drops
   the buyer at the spawn point the agent's machine worked out when the scan was
   attached, and lets them walk it first-person — inside the same page, under
   the same branding, with the same Enquire button and the same minimap.

   Two rules shape everything here:

   1. NOTHING IS INVENTED. A scan is a recording. What the phone never saw is
      empty, and the viewer says so in a line that never leaves the screen.
      There is no sky, no fill light, no in-painting, no "clean up" pass.
   2. NOTHING IS GUESSED AT VIEW TIME. The up-axis, the floor height, the
      walkable grid and the spawn point all arrive in facts.json, computed once
      when the agent attached the scan. This file READS them. If facts.json is
      missing or unreadable we say the scan is not ready and stay in the 360
      tour — we never fall back to measuring the room in the buyer's browser.

   The 360 tour is always the fallback: every failure path here ends with the
   buyer back at the standpoint they left, never on a blank screen.

   Loaded on demand: tour.js only imports this file when someone presses
   "Walk this room", so a tour without scans never pays for three.js + Spark.
   =========================================================================== */

import * as SF from './scanfacts.js';

/* ------------------------------------------------------------------ tuning */
const EYE_FALLBACK = 1.6;    // metres, only if facts.eye is absent
const SPEED = 1.35;          // m/s — a walk round a room, not a jog
const BRISK = 1.6;           // shift multiplier
const GRAVITY = 9.8;
const FALL_EDGE = 0.28;      // drop further than this and you are falling
/* The one movement rule this file adds on top of canStand(), and the reason
   for it. canStand() limits how far you may step UP; nothing limits how far
   you may step DOWN, and a real scan is not a sealed room — the office scan
   carries pockets of outdoor haze whose "floor" sits metres below the office's.
   Walking into one dropped the buyer two and a half metres into a void beneath
   the room, with no way back up. The facts already say where the room's floor
   is, so: stay near it. Nothing is recomputed here — this compares cellFloor()
   with facts.floor_y, two numbers the facts carry. The band is deliberately
   loose (a whole storey is 2.4 m) so that it only ever catches a plunge, never
   an honest step, a sunken floor or a scan whose per-cell floor is a bit noisy. */
const FLOOR_BAND = 1.5;
const CLIMB_RATE = 6;        // m/s the feet rise when stepping up
const SETTLE_RATE = 14;      // how fast the feet settle onto the floor
const HEAD_GAP = 0.12;       // keep the head this far under a ceiling
const FOV = 70;
const LOAD_TIMEOUT_MS = 90000;

/* Spark and three are pinned by the page's importmap (three@0.180.0,
   @sparkjsdev/spark@2.1.0) — the same pins studio/walkthrough.html uses. */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MB = b => (b / 1048576);
const fmtMB = b => (MB(b) < 10 ? MB(b).toFixed(1) : Math.round(MB(b))) + ' MB';

/* --------------------------------------------------------------------- CSS
   Injected once, on first use. Kept here rather than in index.html so a tour
   with no scans never ships walk-mode styling it will not use. Uses the
   page's own design tokens. */
const CSS = `
/* Above the tour chrome (#top 5, #enqBtn 7, .dlg 20): while the walk panel is
   up it is the only thing on screen, so the Enquire pill and address bar must
   not float over it. */
#walkLayer{position:absolute;inset:0;z-index:21;display:none;background:#161512}
body.walking #walkLayer{display:block}
body.walking #stage{visibility:hidden}
body.walking #arrowList,body.walking #rooms,body.walking #hint,body.walking #gyroBtn{display:none!important}
body.walking #enqBtn{bottom:78px}
#walkLayer canvas{display:block;width:100%!important;height:100%!important}
#walkInput{position:absolute;inset:0;z-index:2;touch-action:none;cursor:grab}
#walkInput.dragging{cursor:grabbing}
#walkInput.locked{cursor:none}
#walkUI{position:absolute;inset:0;z-index:8;pointer-events:none}
#walkUI button{pointer-events:auto}
#walkHonest{position:absolute;left:0;right:0;bottom:0;z-index:1;
  padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));
  background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.86));
  font-size:12.5px;line-height:1.45;color:#e8e2d5;text-align:center;pointer-events:none}
#walkHint{position:absolute;left:50%;bottom:96px;transform:translateX(-50%);z-index:2;
  background:rgba(22,21,18,.86);border:2px solid rgba(255,255,255,.35);padding:8px 14px;
  font-size:13px;font-weight:600;white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis;
  transition:opacity .5s;pointer-events:none}
#walkStick{position:absolute;width:112px;height:112px;border-radius:50%;z-index:2;
  border:2px solid rgba(255,255,255,.45);background:rgba(22,21,18,.35);display:none;pointer-events:none}
#walkNub{position:absolute;left:50%;top:50%;width:46px;height:46px;border-radius:50%;
  background:rgba(255,255,255,.82);transform:translate(-50%,-50%)}
#walkPanel{position:absolute;inset:0;z-index:22;display:none;flex-direction:column;align-items:center;
  justify-content:center;gap:14px;padding:24px;text-align:center;background:rgba(11,10,9,.95)}
#walkPanel.on{display:flex}
#walkPanel .wt{font-family:'Arial Black',sans-serif;text-transform:uppercase;letter-spacing:-.02em;font-size:17px}
#walkPanel .wm{font-size:14px;color:#cfc9bb;max-width:430px;line-height:1.6}
#walkPanel .wr{width:210px;height:4px;background:#34302a}
#walkPanel .wr span{display:block;height:100%;width:0;background:var(--red);transition:width .2s}
#walkPanel .wrow{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
@media (prefers-reduced-motion:reduce){#walkHint,#walkPanel .wr span{transition:none}}
@media (max-width:720px){#walkHint{bottom:104px;font-size:12px}}
`;

let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const s = document.createElement('style');
  s.id = 'walkCss';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------- dates */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ------------------------------------------------------- the facts contract
   scanfacts.js is the other end of this contract: it computes facts.json on
   the agent's machine and reads it back here. If the module we get is not the
   one this file was written against, that must surface as "the scan is not
   ready", never as a buyer walking through walls. */
function factsModuleProblem() {
  for (const name of ['deserialiseFacts', 'canStand', 'cellFloor', 'upQuaternion']) {
    if (typeof SF[name] !== 'function') return 'scanfacts.js has no ' + name + '()';
  }
  return null;
}

/* Read a quaternion out of whatever shape upQuaternion() hands back: a plain
   {x,y,z,w}, a THREE.Quaternion (also {x,y,z,w}), or [x,y,z,w]. */
function toQuat(q) {
  if (!q) return null;
  if (Array.isArray(q) || ArrayBuffer.isView(q)) {
    return q.length >= 4 ? { x: +q[0], y: +q[1], z: +q[2], w: +q[3] } : null;
  }
  if (typeof q === 'object' && typeof q.x === 'number' && typeof q.w === 'number') {
    return { x: +q.x, y: +q.y, z: +q.z, w: +q.w };
  }
  return null;
}

/* spawn.yaw: the facts contract does not name a unit. Everything else in the
   facts blob is metres in a three.js frame, so radians is the reading that
   matches its neighbours — but a value that could not possibly be radians is
   taken as degrees rather than spinning the buyer 57× too far. Either way this
   is only the direction they face on arrival; they can turn. */
function spawnYaw(spawn) {
  const y = Number(spawn && spawn.yaw);
  if (!isFinite(y)) return 0;
  return Math.abs(y) > Math.PI * 2 ? y * Math.PI / 180 : y;
}

/* --------------------------------------------------------------- the module */

/**
 * Create the walk-mode controller. One per page; `open()` may be called any
 * number of times and each entry disposes everything the last one made.
 *
 * host: {
 *   mount        element the walk layer is appended to (#app)
 *   suspend()    stop the 360 render loop while walking
 *   resume()     restart it on the way out
 *   toast(msg)   the tour's own transient message
 *   announce(m)  the tour's aria-live region
 *   blocked()    true while a dialog owns the keyboard
 *   refreshScan(room)  re-sign expired URLs; resolves to a fresh scan object
 *   onOpen() / onClose()
 * }
 */
export function createWalk(host) {
  injectCss();

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* live state for one entry; everything in here is thrown away on close */
  let live = null;
  let opening = false;
  let room = null, scan = null, roomName = '';

  /* ------------------------------------------------------------------ DOM */
  const layer = document.createElement('div');
  layer.id = 'walkLayer';
  layer.setAttribute('aria-hidden', 'true');   // the walk view itself is not readable; the buttons are

  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;inset:0';
  layer.appendChild(holder);

  const input = document.createElement('div');
  input.id = 'walkInput';
  layer.appendChild(input);

  const ui = document.createElement('div');
  ui.id = 'walkUI';
  ui.innerHTML =
    '<div id="walkStick"><div id="walkNub"></div></div>' +
    '<div id="walkHint"></div>' +
    '<div id="walkHonest"></div>';
  layer.appendChild(ui);

  const panel = document.createElement('div');
  panel.id = 'walkPanel';
  panel.setAttribute('role', 'status');
  panel.innerHTML =
    '<div class="wt" id="walkPT"></div>' +
    '<div class="wr"><span id="walkPB"></span></div>' +
    '<div class="wm" id="walkPM"></div>' +
    '<div class="wrow" id="walkPR"></div>';
  layer.appendChild(panel);

  const stickEl = ui.querySelector('#walkStick');
  const nubEl = ui.querySelector('#walkNub');
  const hintEl = ui.querySelector('#walkHint');
  const honestEl = ui.querySelector('#walkHonest');
  const pTitle = panel.querySelector('#walkPT');
  const pBar = panel.querySelector('#walkPB');
  const pMsg = panel.querySelector('#walkPM');
  const pRow = panel.querySelector('#walkPR');

  host.mount.appendChild(layer);

  function showPanel(title, msg, pct) {
    pTitle.textContent = title;
    pMsg.textContent = msg || '';
    pBar.parentNode.style.display = (pct === null || pct === undefined) ? 'none' : '';
    if (pct !== null && pct !== undefined) pBar.style.width = clamp(pct, 0, 100) + '%';
    pRow.textContent = '';
    panel.classList.add('on');
  }
  function panelButtons(list) {
    pRow.textContent = '';
    for (const b of list) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn sm' + (b.red ? ' red' : '');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      pRow.appendChild(el);
    }
    if (pRow.firstChild) pRow.firstChild.focus();
  }
  function hidePanel() { panel.classList.remove('on'); }

  /* One place where "this did not work" turns into a sentence and a way back.
     Never a blank screen: the 360 tour is behind this panel the whole time. */
  function fail(title, msg) {
    if (live) teardown();
    showPanel(title, msg, null);
    panelButtons([{ label: 'Back to the 360 tour', red: true, onClick: () => close() }]);
    host.announce(title + ' ' + msg);
    // The walk-mode key handler is only wired once a scan is running, and the
    // viewer's own handler stands down while walk mode is open — so without
    // this, Escape does nothing on the one screen that most needs a way out.
    // Also drop the movement pills: there is nothing to move or respawn in.
    opening = false;
    updateChrome();
    if (!escHook) {
      escHook = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
      addEventListener('keydown', escHook, true);
    }
  }
  let escHook = null;

  /* ---------------------------------------------------------------- open */
  async function open(r) {
    if (opening || live) return;
    room = r;
    scan = r && r.scan;
    roomName = (r && r.name) || 'Room';
    if (!scan) return;

    opening = true;
    document.body.classList.add('walking');
    host.onOpen();
    host.suspend();

    const when = fmtDate(scan.scanned_at);
    honestEl.textContent = (when ? 'Scanned ' + when + ' — ' : '') +
      'areas the camera could not see are left empty.';
    hintEl.style.opacity = '1';
    hintEl.textContent = coarse()
      ? 'Drag the left side to move · drag anywhere else to look'
      : 'W A S D or the arrow keys to move · click to look around · Esc to leave';

    showPanel('Opening ' + roomName, 'Getting the room ready…', 2);

    try {
      await start();
      opening = false;
    } catch (e) {
      opening = false;
      console.warn('[walk] could not open the scan', e);
      if (!document.body.classList.contains('walking')) return;   // closed while loading
      fail('This room will not open',
        (e && e.walkMessage) || 'Something went wrong opening the scan. The 360 tour still works.');
    }
  }

  const coarse = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

  function err(message) { const e = new Error(message); e.walkMessage = message; return e; }

  /* ------------------------------------------------------------- the load */
  async function start() {
    const problem = factsModuleProblem();
    if (problem) {
      console.warn('[walk] ' + problem);
      throw err('The tools that read this scan did not load. The 360 tour still works.');
    }

    /* 1. three + Spark. Spark probes the GPU the moment its module evaluates,
          so a browser with WebGL2 switched off throws here rather than later. */
    showPanel('Opening ' + roomName, 'Starting 3D…', 4);
    let THREE, SparkRenderer, SplatMesh;
    try {
      THREE = await import('three');
    } catch (e) {
      console.warn('[walk] three.js did not load', e);
      throw err('The 3D library did not load. Check your connection — the 360 tour still works without it.');
    }
    try {
      ({ SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark'));
    } catch (e) {
      console.warn('[walk] Spark did not load', e);
      throw err('Walking needs 3D, which this browser is not providing. The 360 tour still works.');
    }

    /* 2. facts.json first — it is small, and if it is missing there is nothing
          to walk. Downloading 90 MB and then discovering that would be rude. */
    showPanel('Opening ' + roomName, 'Reading the room measurements…', 8);
    const facts = await loadFacts();

    /* 3. the scan itself, with real megabytes on screen the whole way. */
    const bytes = await loadScan(facts);
    if (!document.body.classList.contains('walking')) return;      // closed mid-download

    /* 4. Are these bytes a scan at all? Spark decodes on a worker and simply
          never calls back when handed something it cannot read, so a server
          that answers a missing file with an HTML error page — and a 200 —
          would leave the buyer watching a progress bar for a minute and a half.
          Three bytes settle it. */
    const wrong = notAScan(bytes);
    if (wrong) {
      console.warn('[walk] the scan URL did not return a scan: ' + wrong);
      throw err('The scan file could not be opened — it may have moved. Ask the agent to attach it again. The 360 tour still works.');
    }

    /* 5. renderer + scene. */
    showPanel('Opening ' + roomName, 'Preparing the room…', 97);
    build(THREE, SparkRenderer, SplatMesh, facts, bytes);
  }

  /* Why these bytes are not a scan, or null when they might be. Deliberately
     shallow — reading the file is Spark's job, not ours. */
  function notAScan(bytes) {
    if (!bytes || bytes.length < 32) return 'only ' + (bytes ? bytes.length : 0) + ' bytes';
    let i = 0;
    while (i < 8 && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 10 || bytes[i] === 13)) i++;
    if (bytes[i] === 0x3c) return 'looks like HTML, not a scan';          // '<'
    const fmt = String(scan.format || '').toLowerCase();
    if (fmt === 'ply' && !(bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79)) {
      return 'does not start with "ply"';
    }
    if (fmt === 'splat' && bytes.length % 32 !== 0) return 'not a whole number of 32-byte splats';
    return null;
  }

  async function loadFacts() {
    let url = scan.facts_url;
    if (!url) throw err('This scan is not ready to walk yet — its measurements are missing. Ask the agent to attach it again.');
    let text = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
        if (r.ok) { text = await r.text(); break; }
        if (attempt === 0 && (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404)) {
          const fresh = await host.refreshScan(room).catch(() => null);   // signed URLs expire
          if (fresh && fresh.facts_url) { scan = fresh; url = fresh.facts_url; continue; }
        }
        throw err('The room measurements would not download (HTTP ' + r.status + '). The 360 tour still works.');
      } catch (e) {
        if (e && e.walkMessage) throw e;
        if (attempt === 1) throw err('The room measurements would not download — check your connection. The 360 tour still works.');
      }
    }
    if (text === null) throw err('The room measurements would not download. The 360 tour still works.');

    let facts;
    try {
      facts = SF.deserialiseFacts(JSON.parse(text));
    } catch (e1) {
      try { facts = SF.deserialiseFacts(text); }
      catch (e2) {
        console.warn('[walk] facts.json did not parse', e1, e2);
        throw err('This scan is not ready to walk yet — its measurements could not be read. Ask the agent to attach it again.');
      }
    }
    if (!facts || !facts.grid || !facts.up) {
      throw err('This scan is not ready to walk yet — its measurements are incomplete. Ask the agent to attach it again.');
    }
    if (facts.usable === false) {
      throw err('There is not enough floor in this scan to walk on. The 360 standpoint shows the whole room.');
    }
    return facts;
  }

  /* The scan can be 90 MB. Read the body as a stream so the buyer watches real
     megabytes arrive instead of an unexplained wait, then hand the bytes to
     Spark. Never a silent wait. */
  async function loadScan(facts) {
    let url = scan.url;
    if (!url) throw err('This scan is missing its file. The 360 tour still works.');
    const declared = Number(scan.bytes) || (facts.source && Number(facts.source.bytes)) || 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await fetch(url, { mode: 'cors', credentials: 'omit' });
      } catch (e) {
        if (attempt === 1) throw err('The scan would not download — check your connection. The 360 tour still works.');
        continue;
      }
      if (!r.ok) {
        if (attempt === 0 && (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404)) {
          const fresh = await host.refreshScan(room).catch(() => null);
          if (fresh && fresh.url) { scan = fresh; url = fresh.url; continue; }
        }
        throw err('The scan would not download (HTTP ' + r.status + '). The 360 tour still works.');
      }

      const total = Number(r.headers.get('content-length')) || declared || 0;
      const label = total ? fmtMB(total) : 'the scan';

      if (!r.body || !r.body.getReader) {
        showPanel('Opening ' + roomName, 'Downloading ' + label + '…', 12);
        return new Uint8Array(await r.arrayBuffer());
      }

      const reader = r.body.getReader();
      const chunks = [];
      let got = 0, lastPaint = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!document.body.classList.contains('walking')) { try { reader.cancel(); } catch (e) {} return new Uint8Array(0); }
        chunks.push(value);
        got += value.length;
        const now = performance.now();
        if (now - lastPaint > 90) {
          lastPaint = now;
          const pct = total ? 10 + 80 * (got / total) : 45;
          showPanel('Opening ' + roomName,
            total ? 'Downloading the scan — ' + fmtMB(got) + ' of ' + fmtMB(total)
                  : 'Downloading the scan — ' + fmtMB(got) + ' so far',
            pct);
        }
      }
      showPanel('Opening ' + roomName, 'Downloaded ' + fmtMB(got) + ' — unpacking…', 92);

      const out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      chunks.length = 0;                       // let the copies go before Spark allocates
      return out;
    }
    throw err('The scan would not download. The 360 tour still works.');
  }

  /* Spark has finished decoding. Deliberately declared out here, not inside
     build(), so the handler Spark keeps does not also keep the scan bytes. */
  function splatReady(state, m) {
    if (live !== state) return;
    clearTimeout(state.timer);
    state.loaded = true;
    try {
      const src = (m && (m.packedSplats || m.splats)) || (state.mesh && (state.mesh.packedSplats || state.mesh.splats));
      state.splats = src && src.getNumSplats ? src.getNumSplats() : (Number(scan.splats) || 0);
    } catch (e) { state.splats = Number(scan.splats) || 0; }
    hidePanel();
    host.announce('Walking the ' + roomName + ' scan. ' + honestEl.textContent);
    fadeHint();
  }

  /* ------------------------------------------------------------ the world */
  function build(THREE, SparkRenderer, SplatMesh, facts, bytes) {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      console.warn('[walk] WebGL unavailable', e);
      throw err('Walking needs 3D, which this browser is not providing. The 360 tour still works.');
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    holder.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');

    const scene = new THREE.Scene();
    /* No sky, no fill, no invented daylight. What was not scanned is empty, and
       empty is drawn as the page's own dark paper so it reads as "nothing here"
       rather than as a broken renderer. The honesty line says the same in words. */
    scene.background = new THREE.Color(0x161512);

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 600);
    camera.rotation.order = 'YXZ';

    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    const splatRoot = new THREE.Group();
    scene.add(splatRoot);

    /* THE ONE PIECE OF GEOMETRY WE APPLY: the rotation that puts the scan's own
       up-axis onto +Y. Everything else in facts — floor_y, spawn, the grid — is
       already expressed in this rotated frame, so once the root is turned the
       numbers are read straight off. */
    const q = toQuat(SF.upQuaternion(facts.up));
    if (!q) throw err('This scan is not ready to walk yet — which way is up could not be read.');
    splatRoot.quaternion.set(q.x, q.y, q.z, q.w);
    splatRoot.updateMatrixWorld(true);

    const eye = Number(facts.eye) > 0 ? Number(facts.eye) : EYE_FALLBACK;
    const spawn = facts.spawn || {};
    const player = {
      x: Number(spawn.x) || 0,
      z: Number(spawn.z) || 0,
      feetY: isFinite(Number(spawn.y)) ? Number(spawn.y) : (Number(facts.floor_y) || 0),
      yaw: spawnYaw(spawn),
      pitch: 0,
      vy: 0,
      grounded: true,
      eye
    };

    /* Sanity probe: the facts module we are talking to must agree with us about
       what cellFloor(x,z) means. If the spawn cell has no floor under it, the
       contract has drifted — refuse rather than drop a buyer into a void. */
    const probe = SF.cellFloor(facts, player.x, player.z);
    if (!(typeof probe === 'number' && isFinite(probe))) {
      console.warn('[walk] cellFloor at the spawn returned', probe);
      throw err('This scan is not ready to walk yet — its floor could not be read. Ask the agent to attach it again.');
    }
    player.feetY = probe;
    player.spawn = { x: player.x, z: player.z, feetY: probe, yaw: player.yaw };

    const state = {
      THREE, renderer, scene, camera, spark, splatRoot, mesh: null, facts, player,
      raf: 0, last: 0, keys: Object.create(null), stick: { x: 0, y: 0 },
      ab: new AbortController(), ro: null, splats: 0, loaded: false, timer: 0
    };
    live = state;

    /* Spark decodes on a worker; onLoad is the only signal it is ready. */
    const fileName = 'scan.' + String(scan.format || 'ply').toLowerCase();
    let mesh;
    try {
      mesh = new SplatMesh({ fileBytes: bytes, fileName, onLoad: m => splatReady(state, m) });
    } catch (e) {
      console.warn('[walk] Spark could not read the scan', e);
      throw err('This scan could not be opened — the file may not be a format we can read. The 360 tour still works.');
    }
    /* Drop our own handle on 90 MB of scan the moment Spark has it. A closure
       defined in this function would otherwise pin `bytes` for as long as
       anything holds the closure — and Spark holds onLoad on the mesh — which
       is worth a whole scan's memory on every second visit. The onLoad handler
       above therefore lives outside this scope, and this line clears the slot. */
    bytes = null;
    state.mesh = mesh;
    splatRoot.add(mesh);

    state.timer = setTimeout(() => {
      if (live === state && !state.loaded) {
        fail('This room is taking too long',
          'The scan did not finish opening. It may be too large for this device. The 360 tour still works.');
      }
    }, LOAD_TIMEOUT_MS);

    wireInput(state);
    resize(state);
    state.ro = new ResizeObserver(() => resize(state));
    state.ro.observe(host.mount);

    state.last = performance.now();
    state.raf = requestAnimationFrame(t => loop(state, t));

    showPanel('Opening ' + roomName, 'Unpacking the scan…', 99);
  }

  function resize(s) {
    const w = host.mount.clientWidth || 1, h = host.mount.clientHeight || 1;
    s.renderer.setSize(w, h, false);
    s.camera.aspect = w / h;
    s.camera.updateProjectionMatrix();
  }

  let hintTimer = 0;
  function fadeHint() {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintEl.style.opacity = '0'; }, 7000);
  }

  /* -------------------------------------------------------------- walking */
  function loop(s, now) {
    if (live !== s) return;
    s.raf = requestAnimationFrame(t => loop(s, t));
    /* dt is clamped, so coming back from a backgrounded tab costs one small
       step rather than a teleport across the room. */
    const dt = Math.min(0.05, (now - s.last) / 1000);
    s.last = now;
    frame(s, dt);
  }

  /* May a body move to this spot? The facts module's own answer, plus the
     no-plunging rule above. */
  function canGo(facts, x, z, feetY) {
    if (!SF.canStand(facts, x, z, feetY)) return false;
    const ground = Number(facts.floor_y);
    if (!isFinite(ground)) return true;          // no ground plane stated: trust canStand
    const f = SF.cellFloor(facts, x, z);
    if (typeof f !== 'number' || !isFinite(f)) return false;
    return Math.abs(f - ground) <= FLOOR_BAND;
  }

  /* One frame: read the sticks and keys, move a body, draw. Separate from the
     rAF plumbing so it can be stepped by hand. */
  function frame(s, dt) {
    const p = s.player, f = s.facts, k = s.keys;

    let mx = 0, mz = 0;
    if (k.w || k.arrowup) mz += 1;
    if (k.s || k.arrowdown) mz -= 1;
    if (k.a || k.arrowleft) mx -= 1;
    if (k.d || k.arrowright) mx += 1;
    // stick.y is forward-positive, like a pushed thumbstick and like the W key.
    mx += s.stick.x; mz += s.stick.y;

    const len = Math.hypot(mx, mz);
    if (len > 0.01) {
      const n = Math.max(1, len);
      mx /= n; mz /= n;
      const step = SPEED * (k.shift ? BRISK : 1) * dt;
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      const nx = p.x + (-sin * mz + cos * mx) * step;
      const nz = p.z + (-cos * mz - sin * mx) * step;
      /* Walls stop you; a wall you are sliding along does not. Try the full
         step, then each axis on its own — the same order walkthrough.html uses,
         which is what makes doorways passable at an angle. */
      if (canGo(f, nx, nz, p.feetY)) { p.x = nx; p.z = nz; }
      else if (canGo(f, nx, p.z, p.feetY)) p.x = nx;
      else if (canGo(f, p.x, nz, p.feetY)) p.z = nz;
    }

    /* Gravity, ground and step-up. A body, not a camera — but no jump and no
       head bob: a buyer is inspecting a room, not playing a game. */
    const gf = SF.cellFloor(f, p.x, p.z);
    const ground = (typeof gf === 'number' && isFinite(gf)) ? gf : p.feetY;
    if (p.grounded) {
      if (ground > p.feetY + 0.005) p.feetY = Math.min(ground, p.feetY + dt * CLIMB_RATE);
      else if (ground < p.feetY - FALL_EDGE) { p.grounded = false; p.vy = 0; }
      else if (reduced) p.feetY = ground;
      else p.feetY += (ground - p.feetY) * Math.min(1, dt * SETTLE_RATE);
    } else {
      p.vy -= GRAVITY * dt;
      p.feetY += p.vy * dt;
      if (p.vy <= 0 && p.feetY <= ground) { p.feetY = ground; p.vy = 0; p.grounded = true; }
    }

    /* A low ceiling is a surface, not a suggestion. */
    if (typeof SF.cellCeil === 'function') {
      const ceil = SF.cellCeil(f, p.x, p.z);
      if (typeof ceil === 'number' && isFinite(ceil) && p.feetY + p.eye + HEAD_GAP > ceil) {
        p.feetY = ceil - p.eye - HEAD_GAP;
        if (p.vy > 0) p.vy = 0;
      }
    }

    s.camera.position.set(p.x, p.feetY + p.eye, p.z);
    s.camera.rotation.y = p.yaw;
    s.camera.rotation.x = p.pitch;
    s.camera.rotation.z = 0;
    s.renderer.render(s.scene, s.camera);
  }

  /* ---------------------------------------------------------------- input */
  function wireInput(s) {
    const sig = s.ab.signal;
    const on = (el, ev, fn, opt) => el.addEventListener(ev, fn, Object.assign({ signal: sig }, opt || {}));

    /* A browser can take the 3D context away at any moment — a driver reset, a
       GPU process crash, another tab being greedy. Left alone that is a frozen
       picture with no explanation, so say what happened and offer the way out.
       We do not try to rebuild: that would mean downloading the scan again
       without being asked. */
    on(s.renderer.domElement, 'webglcontextlost', e => {
      e.preventDefault();
      if (live !== s) return;
      console.warn('[walk] the browser dropped the 3D context');
      fail('3D stopped in this browser',
        'The browser dropped the 3D view, usually because the graphics driver restarted. The 360 tour still works.');
    });

    const typing = el => {
      if (!el) return false;
      const t = (el.tagName || '').toLowerCase();
      return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
    };

    on(window, 'keydown', e => {
      if (typing(e.target) || host.blocked() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      const name = e.key.toLowerCase();
      if (name === 'shift') { s.keys.shift = true; return; }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].indexOf(name) < 0) return;
      s.keys[name] = true;
      e.preventDefault();
      hintEl.style.opacity = '0';
    });
    on(window, 'keyup', e => {
      const name = (e.key || '').toLowerCase();
      if (name === 'shift') { s.keys.shift = false; return; }
      if (s.keys[name]) { s.keys[name] = false; e.preventDefault(); }
    });
    on(window, 'blur', () => { s.keys = Object.create(null); s.stick.x = 0; s.stick.y = 0; stickEl.style.display = 'none'; });

    /* Mouse: click to take the pointer, then look freely. If pointer lock is
       refused (some embedded frames), dragging still looks around. */
    const LOOK = 0.0022, DRAG = 0.005;
    let dragging = null;

    on(input, 'pointerdown', e => {
      if (e.pointerType === 'touch') { touchDown(e); return; }
      if (!document.pointerLockElement && input.requestPointerLock) {
        try { input.requestPointerLock(); } catch (err) {}
      }
      dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
      input.classList.add('dragging');
      try { input.setPointerCapture(e.pointerId); } catch (err) {}
    });
    on(window, 'pointermove', e => {
      if (e.pointerType === 'touch') { touchMove(e); return; }
      if (document.pointerLockElement === input) {
        s.player.yaw -= e.movementX * LOOK;
        s.player.pitch = clamp(s.player.pitch - e.movementY * LOOK, -1.4, 1.4);
        return;
      }
      if (!dragging || e.pointerId !== dragging.id) return;
      s.player.yaw -= (e.clientX - dragging.x) * DRAG;
      s.player.pitch = clamp(s.player.pitch - (e.clientY - dragging.y) * DRAG, -1.4, 1.4);
      dragging.x = e.clientX; dragging.y = e.clientY;
    });
    const up = e => {
      if (e.pointerType === 'touch') { touchUp(e); return; }
      if (dragging && e.pointerId === dragging.id) { dragging = null; input.classList.remove('dragging'); }
    };
    on(window, 'pointerup', up);
    on(window, 'pointercancel', up);
    on(document, 'pointerlockchange', () => {
      input.classList.toggle('locked', document.pointerLockElement === input);
    });

    /* Touch: the lower-left quarter is the stick, everything else looks. */
    let moveId = null, lookId = null, base = { x: 0, y: 0 }, lookAt = { x: 0, y: 0 };
    function touchDown(e) {
      const r = input.getBoundingClientRect();
      const inStick = (e.clientX - r.left) < r.width * 0.45 && (e.clientY - r.top) > r.height * 0.45;
      if (moveId === null && inStick) {
        moveId = e.pointerId;
        base = { x: e.clientX - r.left, y: e.clientY - r.top };
        stickEl.style.display = 'block';
        stickEl.style.left = (base.x - 56) + 'px';
        stickEl.style.top = (base.y - 56) + 'px';
        nubEl.style.transform = 'translate(-50%,-50%)';
      } else if (lookId === null) {
        lookId = e.pointerId;
        lookAt = { x: e.clientX, y: e.clientY };
      }
      hintEl.style.opacity = '0';
    }
    function touchMove(e) {
      const r = input.getBoundingClientRect();
      if (e.pointerId === moveId) {
        const dx = (e.clientX - r.left) - base.x, dy = (e.clientY - r.top) - base.y;
        const d = Math.hypot(dx, dy), max = 46;
        const k = d > max ? max / d : 1;
        s.stick.x = clamp((dx * k) / max, -1, 1);
        s.stick.y = clamp((-dy * k) / max, -1, 1);
        nubEl.style.transform = 'translate(calc(-50% + ' + (dx * k).toFixed(1) + 'px),calc(-50% + ' + (dy * k).toFixed(1) + 'px))';
      } else if (e.pointerId === lookId) {
        s.player.yaw -= (e.clientX - lookAt.x) * DRAG;
        s.player.pitch = clamp(s.player.pitch - (e.clientY - lookAt.y) * DRAG, -1.4, 1.4);
        lookAt = { x: e.clientX, y: e.clientY };
      }
    }
    function touchUp(e) {
      if (e.pointerId === moveId) { moveId = null; s.stick.x = 0; s.stick.y = 0; stickEl.style.display = 'none'; }
      if (e.pointerId === lookId) lookId = null;
    }
  }

  /* --------------------------------------------------------------- teardown
     A second entry must not cost a second scan's worth of memory, so every
     GPU-side thing this entry made is released by hand:
       - the SplatMesh (Spark's own dispose() frees its packed splat texture
         and the worker-side copy);
       - the SparkRenderer (its accumulation targets), when it exposes dispose;
       - every geometry/material/texture still reachable from the scene;
       - the WebGLRenderer itself, plus a forced context loss so the driver
         frees the context now rather than whenever the canvas is collected;
       - the canvas element, the ResizeObserver and every listener (one
         AbortController owns all of them).
     The bytes we downloaded are dropped as soon as Spark has them. */
  function teardown() {
    const s = live;
    if (!s) return;
    live = null;

    clearTimeout(s.timer);
    cancelAnimationFrame(s.raf);
    try { s.ab.abort(); } catch (e) {}
    try { if (s.ro) s.ro.disconnect(); } catch (e) {}
    if (document.pointerLockElement === input) { try { document.exitPointerLock(); } catch (e) {} }

    const before = s.renderer && s.renderer.info ? {
      textures: s.renderer.info.memory.textures,
      geometries: s.renderer.info.memory.geometries,
      programs: s.renderer.info.programs ? s.renderer.info.programs.length : 0
    } : null;

    try {
      if (s.mesh) {
        s.splatRoot.remove(s.mesh);
        if (typeof s.mesh.dispose === 'function') s.mesh.dispose();
      }
    } catch (e) { console.warn('[walk] splat dispose', e); }
    s.mesh = null;

    try {
      if (s.spark) {
        s.scene.remove(s.spark);
        if (typeof s.spark.dispose === 'function') s.spark.dispose();
      }
    } catch (e) { console.warn('[walk] spark dispose', e); }

    try {
      s.scene.traverse(o => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of mats) {
          for (const key of Object.keys(m)) {
            const v = m[key];
            if (v && v.isTexture && v.dispose) v.dispose();
          }
          if (m.dispose) m.dispose();
        }
      });
      s.scene.clear ? s.scene.clear() : (s.scene.children.length = 0);
    } catch (e) { console.warn('[walk] scene dispose', e); }

    /* The canvas goes now; the context goes in a moment. Spark drives its splat
       sort on an async readback, and one is usually still in flight when the
       buyer presses Exit — tearing the context down underneath it throws inside
       Spark ("No target"). Letting the current task finish first costs nothing
       and keeps the console clean. `live` is already null, so a second entry
       during that beat simply builds its own renderer. */
    const renderer = s.renderer;
    const canvas = renderer.domElement;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    setTimeout(() => {
      try {
        renderer.dispose();
        if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
      } catch (e) { console.warn('[walk] renderer dispose', e); }
    }, 350);

    if (before) {
      console.debug('[walk] released — textures ' + before.textures + ', geometries ' + before.geometries +
        ', programs ' + before.programs);
    }
    s.facts = null; s.renderer = null; s.scene = null; s.camera = null; s.spark = null; s.splatRoot = null;
  }

  /* ---------------------------------------------------------------- close */
  function close() {
    if (!live && !opening && !document.body.classList.contains('walking')) return;
    teardown();
    opening = false;
    if (escHook) { removeEventListener('keydown', escHook, true); escHook = null; }
    hidePanel();
    stickEl.style.display = 'none';
    document.body.classList.remove('walking');
    host.resume();
    host.onClose();
    host.announce('Back at the 360 standpoint in ' + roomName + '.');
  }

  /* A scan's floor is measured cell by cell, so a room can contain a dip a body
     can walk down into and not step back out of — the step a person takes up is
     smaller than the one they will happily take down. Rather than invent
     geometry to smooth that over, give the buyer the way back: this puts them
     exactly where the scan started them. */
  function respawn() {
    const s = live;
    if (!s || !s.player.spawn) return;
    const sp = s.player.spawn;
    s.player.x = sp.x; s.player.z = sp.z; s.player.feetY = sp.feetY;
    s.player.yaw = sp.yaw; s.player.pitch = 0;
    s.player.vy = 0; s.player.grounded = true;
    host.announce('Back at the start of the ' + roomName + ' scan.');
  }

  const api = {
    open,
    close,
    respawn,
    isOpen: () => document.body.classList.contains('walking'),
    /* Enquire should say where the buyer actually is. */
    nodeLabel: () => roomName + ' — walking the scan',
    roomId: () => (room && room.id) || null,
    /* For tests and for anyone debugging a tour in the console. */
    debug: () => {
      const s = live;
      if (!s) return { open: false };
      const info = s.renderer && s.renderer.info;
      return {
        open: true, loaded: s.loaded, room: roomName, splats: s.splats,
        x: +s.player.x.toFixed(3), z: +s.player.z.toFixed(3),
        feetY: +s.player.feetY.toFixed(3), eyeY: +(s.player.feetY + s.player.eye).toFixed(3),
        yaw: +s.player.yaw.toFixed(3), pitch: +s.player.pitch.toFixed(3),
        up: s.facts && s.facts.up, floorY: s.facts && s.facts.floor_y,
        textures: info ? info.memory.textures : null,
        geometries: info ? info.memory.geometries : null,
        programs: info && info.programs ? info.programs.length : null,
        calls: info ? info.render.calls : null
      };
    },
    /* Test hooks: press a key, or ask whether a spot is standable. */
    key: (name, down) => { if (live) live.keys[String(name).toLowerCase()] = !!down; },
    probe: (x, z) => {
      if (!live) return null;
      return {
        floor: SF.cellFloor(live.facts, x, z),
        stand: SF.canStand(live.facts, x, z, live.player.feetY),
        open: canGo(live.facts, x, z, live.player.feetY)
      };
    },
    teleport: (x, z) => { if (live) { live.player.x = x; live.player.z = z; } },
    /* Run one frame by hand — the same body the rAF loop runs. */
    step: ms => { if (live) frame(live, Math.min(0.05, (Number(ms) || 16) / 1000)); },
    look: (yaw, pitch) => { if (live) { live.player.yaw = yaw; live.player.pitch = clamp(pitch, -1.4, 1.4); } },
    state: () => live
  };
  // Same idea as window.__tour: a way to inspect a live walk from the console.
  window.__walk = api;
  return api;
}

export default { createWalk };
