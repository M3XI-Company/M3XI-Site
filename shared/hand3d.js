/*
 * m3xi.com/ — the hand. A robot hand made of light reaches in from the
 * viewer's side of the screen, presses the homepage's first button, and
 * breaks apart into particles that fly back out past the camera.
 *
 * It is real 3D with no library: the hand is seventeen boxes (finger
 * segments, palm, wrist, forearm) in model space. A few thousand points are
 * scattered over their faces and edges, turned and moved as one body each
 * frame, and put on screen with a perspective divide, so the forearm, which is
 * nearest the camera, is drawn large and runs off the bottom of the window.
 * The boxes' edges are drawn as a wireframe so it reads as a machine.
 *
 * The canvas is fixed over the whole window (above the header: the hand is not
 * inside the page, it is in front of it), ignores the pointer, and is removed
 * when the last particle has gone. It plays once per page load, only while the
 * tab is visible and the button is on screen. With prefers-reduced-motion
 * there is no hand: the button is simply switched on.
 */
const PALETTE = ['#FFFFFF', '#7DE1FF', '#6F97FF', '#3B6BFF'];
const F = 820; // focal length, px: the camera sits this far in front of the screen
const REACH = 1700, HOLD = 140, PRESS = 240, BURST = 2600; // ms

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const button = document.querySelector('.hm-reach .co-btn');

/* ── the model ───────────────────────────────────────────────────────────── */

function boxes() {
  const list = [];
  // centre, size, then a turn about Z and a turn about X (radians). Model
  // space: the index fingertip is the origin, +y runs down the arm.
  const add = (cx, cy, cz, w, h, d, rz = 0, rx = 0) => list.push({ cx, cy, cz, w, h, d, rz, rx });
  add(0, 23, 0, 24, 46, 22); add(0, 75, 0, 26, 50, 24); add(0, 132, 0, 28, 56, 26); // index finger
  add(42, 228, 0, 116, 128, 36); // palm
  for (const [x, drop] of [[34, 0], [64, 6], [92, 16]]) { // three folded fingers
    add(x, 150 + drop, -10, 24, 36, 30, 0, 0.5);
    add(x, 172 + drop, -34, 22, 40, 22, 0, 1.3);
  }
  add(-36, 236, -12, 26, 70, 26, 0.5); add(-58, 186, -16, 22, 44, 22, 0.25); // thumb
  add(42, 310, 0, 84, 30, 44); // wrist
  add(42, 620, 0, 74, 580, 48); // forearm
  add(-6, 610, 0, 8, 520, 8); add(90, 610, 0, 8, 520, 8); // two rods beside it
  return list;
}

// A point given in a box's own axes, in model space.
function place(b, u, v, w) {
  const cx = Math.cos(b.rx), sx = Math.sin(b.rx), cz = Math.cos(b.rz), sz = Math.sin(b.rz);
  const y1 = v * cx - w * sx, z1 = v * sx + w * cx;
  return [b.cx + u * cz - y1 * sz, b.cy + u * sz + y1 * cz, b.cz + z1];
}

function build(count) {
  const bs = boxes();
  const area = bs.map((b) => 2 * (b.w * b.h + b.w * b.d + b.h * b.d));
  const total = area.reduce((a, n) => a + n, 0);
  const P = { n: 0, lx: [], ly: [], lz: [], tone: [], size: [] };
  bs.forEach((b, i) => {
    const n = Math.max(24, Math.round((count * area[i]) / total));
    for (let k = 0; k < n; k++) {
      // a random point on a random face, weighted by the face's area
      const r = Math.random() * (b.w * b.h + b.w * b.d + b.h * b.d);
      let u = (Math.random() - 0.5) * b.w, v = (Math.random() - 0.5) * b.h, w = (Math.random() - 0.5) * b.d;
      const side = Math.random() < 0.5 ? -0.5 : 0.5;
      if (r < b.w * b.h) w = side * b.d; else if (r < b.w * b.h + b.w * b.d) v = side * b.h; else u = side * b.w;
      // a third of them sit on an edge, so the shape's lines are the brightest thing
      const onEdge = Math.random() < 0.34;
      if (onEdge) { if (Math.abs(w) === b.d / 2) u = (Math.random() < 0.5 ? -0.5 : 0.5) * b.w; else w = (Math.random() < 0.5 ? -0.5 : 0.5) * b.d; }
      const p = place(b, u, v, w);
      P.lx.push(p[0]); P.ly.push(p[1]); P.lz.push(p[2]);
      P.tone.push(onEdge ? (Math.random() < 0.5 ? 0 : 1) : 2 + (Math.random() < 0.5 ? 0 : 1));
      P.size.push(onEdge ? 1.5 : 1.1 + Math.random() * 0.7);
    }
  });
  P.n = P.lx.length;
  // wireframe: each box's eight corners
  const corners = bs.map((b) => {
    const c = [];
    for (const u of [-0.5, 0.5]) for (const v of [-0.5, 0.5]) for (const w of [-0.5, 0.5]) c.push(place(b, u * b.w, v * b.h, w * b.d));
    return c;
  });
  return { P, corners };
}
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

/* ── the performance ─────────────────────────────────────────────────────── */

function play() {
  const small = window.innerWidth < 700;
  const { P, corners } = build(small ? 2200 : 5200);
  const canvas = document.createElement('canvas');
  canvas.className = 'hm-hand3d';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let vw = 0, vh = 0, S = 1; // S: how big the hand is drawn, by the window's width
  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    vw = window.innerWidth; vh = window.innerHeight;
    S = Math.max(1.25, Math.min(2.3, vw / 560));
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  window.addEventListener('resize', fit);

  const n = P.n;
  // once it bursts, each point is on its own: position, velocity, lifetime
  const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
  const VX = new Float32Array(n), VY = new Float32Array(n), VZ = new Float32Array(n), LIFE = new Float32Array(n);
  let burstAt = -1, last = 0, pressed = false;

  const lerp = (a, b, t) => a + (b - a) * t;

  // Where the fingertip is and how the hand is turned, t ms in.
  function pose(t) {
    const r = button.getBoundingClientRect();
    const tx = r.left + r.width * 0.5 - vw / 2, ty = r.top + r.height * 0.5 - vh / 2;
    const p = Math.min(1, t / REACH), e = 1 - Math.pow(1 - p, 3);
    let z = lerp(-600, 0, e);
    const k = (t - REACH - HOLD) / PRESS; // the press: in, then back
    if (k > 0 && k < 1) z += Math.sin(k * Math.PI) * 26;
    return {
      // it comes in from the lower right, across the page, so the whole arm is in view
      x: lerp(tx + vw * 0.5, tx, e), y: lerp(vh * 0.7, ty, e), z,
      rx: lerp(-1.1, -0.42, e), ry: lerp(-0.75, -0.28, e) + Math.sin(t / 700) * 0.015, rz: lerp(-1.35, -0.72, e) + Math.sin(t / 520) * 0.012,
      tx: tx + vw / 2, ty: ty + vh / 2,
    };
  }

  // Model space to camera space (x, y from the middle of the window; z into the screen).
  function turn(q, x, y, z) {
    x *= S; y *= S; z *= S;
    const x1 = x * q.cz - y * q.sz, y1 = x * q.sz + y * q.cz; // about Z
    const y2 = y1 * q.cx - z * q.sx, z2 = y1 * q.sx + z * q.cx; // about X
    return [x1 * q.cy + z2 * q.sy + q.x, y2 + q.y, -x1 * q.sy + z2 * q.cy + q.z]; // about Y, then move
  }

  function dot(x, y, z, size, tone, alpha) {
    const d = F + z;
    if (d < 70) return; // behind the camera
    const s = F / d, px = vw / 2 + x * s, py = vh / 2 + y * s;
    if (px < -20 || px > vw + 20 || py < -20 || py > vh + 20) return;
    const w = Math.min(9, Math.max(1, size * s));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = PALETTE[tone];
    ctx.fillRect(px - w / 2, py - w / 2, w, w);
  }

  function render(t) {
    const dt = Math.min(50, t - last); last = t;
    ctx.clearRect(0, 0, vw, vh);
    const pressStart = REACH + HOLD, pressEnd = pressStart + PRESS;

    if (!pressed && t >= pressStart) { pressed = true; button.classList.add('is-pressed'); }

    if (burstAt < 0) {
      const q = pose(t);
      q.cx = Math.cos(q.rx); q.sx = Math.sin(q.rx); q.cy = Math.cos(q.ry); q.sy = Math.sin(q.ry); q.cz = Math.cos(q.rz); q.sz = Math.sin(q.rz);
      const fade = Math.min(1, t / 350);

      // the wireframe
      ctx.globalAlpha = 0.75 * fade; ctx.strokeStyle = '#6F97FF'; ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (const box of corners) {
        const c = box.map((p) => { const v = turn(q, p[0], p[1], p[2]); const d = F + v[2]; return d < 70 ? null : [vw / 2 + (v[0] * F) / d, vh / 2 + (v[1] * F) / d]; });
        for (const [a, b] of EDGES) if (c[a] && c[b]) { ctx.moveTo(c[a][0], c[a][1]); ctx.lineTo(c[b][0], c[b][1]); }
      }
      ctx.stroke();

      // the points
      for (let i = 0; i < n; i++) {
        const v = turn(q, P.lx[i], P.ly[i], P.lz[i]);
        dot(v[0], v[1], v[2], P.size[i] * S * 0.85, P.tone[i], (P.tone[i] < 2 ? 1 : 0.8) * fade);
        if (t >= pressEnd) { X[i] = v[0]; Y[i] = v[1]; Z[i] = v[2]; }
      }

      if (t >= pressEnd) { // it breaks: everything leaves from where it was
        burstAt = t;
        button.classList.remove('is-pressed');
        button.classList.add('is-live');
        for (let i = 0; i < n; i++) {
          const dx = X[i] - q.x, dy = Y[i] - (q.y + 70 * S), dz = Z[i] - (q.z - 60 * S);
          const len = Math.hypot(dx, dy, dz) || 1, near = 1 + 260 / (len + 60);
          const sp = (0.1 + Math.random() * 0.5) * near;
          VX[i] = (dx / len) * sp + (Math.random() - 0.5) * 0.25;
          VY[i] = (dy / len) * sp + (Math.random() - 0.5) * 0.25 - 0.08;
          VZ[i] = (dz / len) * sp - Math.random() * 0.75; // mostly out towards the viewer
          LIFE[i] = 800 + Math.random() * (BURST - 900);
        }
      }
    } else {
      const age = t - burstAt, drag = Math.pow(0.9935, dt);
      // the shock ring from the button
      if (age < 520) {
        const r = button.getBoundingClientRect(), k = age / 520;
        ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = '#7DE1FF'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(r.left + r.width / 2, r.top + r.height / 2, 20 + k * 260, 0, 6.2832); ctx.stroke();
      }
      for (let i = 0; i < n; i++) {
        if (age > LIFE[i]) continue;
        X[i] += VX[i] * dt; Y[i] += VY[i] * dt; Z[i] += VZ[i] * dt;
        VX[i] *= drag; VY[i] = VY[i] * drag - 0.00009 * dt; VZ[i] *= drag;
        const left = 1 - age / LIFE[i];
        dot(X[i], Y[i], Z[i], P.size[i] * S, P.tone[i], left * left * (0.6 + 0.4 * Math.sin(age / 60 + i)));
      }
      if (age > BURST) { finish(); return false; }
    }
    ctx.globalAlpha = 1;
    return true;
  }

  let raf = 0, t0 = 0;
  function finish() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    button.classList.remove('is-pressed');
    button.classList.add('is-live');
    canvas.remove();
  }
  const loop = (now) => { if (!t0) t0 = now; if (render(now - t0)) raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  canvas.renderAt = (t) => { cancelAnimationFrame(raf); return render(t); }; // for looking at one moment of it
}

/* ── when ────────────────────────────────────────────────────────────────── */

if (button) {
  if (still || !window.requestAnimationFrame) button.classList.add('is-live');
  else {
    let done = false;
    const go = () => {
      if (done || document.hidden) return;
      const r = button.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return; // only if the button is on screen
      done = true;
      setTimeout(play, 500);
    };
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
    document.addEventListener('visibilitychange', go);
    window.addEventListener('scroll', go, { passive: true });
  }
}
