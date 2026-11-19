/*
 * m3xi.com — the network: M3XI's "We are connected", drawn rather than said.
 *
 * Any <canvas data-network="dark|light"> becomes a field of drifting points
 * that link to whatever is near them, with small signals travelling along the
 * links from point to point. Move a pointer over the section and it joins the
 * network too.
 *
 * Elements marked data-node inside the canvas's parent (the M3XI logo and the
 * product icons on the homepage) are fixed points in the same network:
 * data-node="hub" is wired to every plain data-node by a circuit trace that
 * carries most of the signals, so the brand is visibly what the products are
 * connected through. data-node="port" (a button) is a fixed point the loose
 * points link to, with no trace of its own.
 *
 * It is decoration: the canvas is aria-hidden and ignores the pointer itself.
 * With prefers-reduced-motion it draws once and stays still. It stops while
 * its section is off screen or the tab is hidden. Bundled by Vite from the
 * pages that use it, so it runs under `script-src 'self'`.
 */
const THEMES = {
  // rgb triplets: links, points, signals
  dark: { line: '96, 144, 255', node: '150, 182, 255', pulse: '125, 225, 255', steady: '255, 255, 255', gain: 1 },
  light: { line: '29, 78, 216', node: '29, 78, 216', pulse: '29, 78, 216', steady: '29, 78, 216', gain: 0.8 },
};
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const REACH = 150; // px: how far a point links

function network(canvas) {
  const host = canvas.parentElement;
  const ctx = canvas.getContext('2d');
  const theme = THEMES[canvas.dataset.network] || THEMES.dark;
  let w = 0, h = 0, box = null;
  let points = [], fixed = [], signals = [];
  let pointer = null, raf = 0, last = 0, sinceSignal = 0, onScreen = true;

  const rand = (a, b) => a + Math.random() * (b - a);
  const point = () => ({ x: rand(0, w), y: rand(0, h), vx: rand(-0.012, 0.012), vy: rand(-0.012, 0.012), r: rand(1.1, 2.4) });

  function measure() {
    box = canvas.getBoundingClientRect();
    w = box.width; h = box.height;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.max(12, Math.min(84, Math.round((w * h) / 13000)));
    while (points.length < want) points.push(point());
    points.length = want;
    points.forEach((p) => { if (p.x > w) p.x = rand(0, w); if (p.y > h) p.y = rand(0, h); });
    fixed = [...host.querySelectorAll('[data-node]')].map((el) => {
      const b = el.getBoundingClientRect();
      const pk = (el.closest('.hm-ic') || el).getBoundingClientRect();
      return { x: b.left - box.left + b.width / 2, y: b.top - box.top + b.height / 2, r: 0, half: pk.width / 2, fixed: true, hub: el.dataset.node === 'hub', port: el.dataset.node === 'port' };
    });
    signals = [];
  }

  // Everything a point can link to this frame.
  function field() {
    const all = points.concat(fixed);
    if (pointer) all.push(pointer);
    return all;
  }

  function neighbours(of, all) {
    const reach = of.fixed || of.pointer ? REACH * 1.25 : REACH;
    return all.filter((o) => o !== of && Math.hypot(o.x - of.x, o.y - of.y) < reach);
  }

  // The brand to a product is a circuit trace: down, across, down, with the
  // corners cut the way a board's are.
  // `lane` shifts the whole trace sideways, so three of them run as a bus.
  function trace(hub, f, lane = 0) {
    const dir0 = Math.sign(f.x - hub.x) || 1;
    hub = { x: hub.x + lane, y: hub.y }; f = { x: f.x + lane, y: f.y };
    const mid = hub.y + (f.y - hub.y) * 0.56 - lane * dir0;
    const cut = Math.min(14, Math.abs(f.x - hub.x) / 2, Math.abs(mid - hub.y) / 2);
    const dir = Math.sign(f.x - hub.x) || 1;
    return [
      { x: hub.x, y: hub.y }, { x: hub.x, y: mid - cut }, { x: hub.x + dir * cut, y: mid },
      { x: f.x - dir * cut, y: mid }, { x: f.x, y: mid + cut }, { x: f.x, y: f.y },
    ];
  }
  const lengthOf = (path) => path.reduce((n, p, i) => (i ? n + Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) : 0), 0);
  function along(path, t) {
    let left = lengthOf(path) * t;
    for (let i = 1; i < path.length; i++) {
      const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      if (left <= d) { const k = d ? left / d : 0; return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * k, y: path[i - 1].y + (path[i].y - path[i - 1].y) * k }; }
      left -= d;
    }
    return path[path.length - 1];
  }

  function send(all) {
    const hub = fixed.find((f) => f.hub);
    const spokes = fixed.filter((f) => !f.hub && !f.port);
    // Most signals run between the brand and its products, in either direction.
    if (hub && spokes.length && Math.random() < 0.55) {
      const s = spokes[Math.floor(Math.random() * spokes.length)];
      const out = Math.random() < 0.5;
      const path = out ? trace(hub, s) : trace(hub, s).reverse();
      signals.push({ a: out ? hub : s, b: out ? s : hub, path, len: lengthOf(path), t: 0, hops: 2, steady: true });
      return;
    }
    const a = all[Math.floor(Math.random() * all.length)];
    const near = neighbours(a, all);
    if (near.length) signals.push({ a, b: near[Math.floor(Math.random() * near.length)], t: 0, hops: 3 });
  }

  function draw(dt) {
    ctx.clearRect(0, 0, w, h);
    for (const p of points) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }
    const all = field();

    // links
    ctx.lineWidth = 1;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (a.fixed && b.fixed) continue; // the steady lines are drawn below
        const reach = a.fixed || b.fixed || a.pointer || b.pointer ? REACH * 1.25 : REACH;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d >= reach) continue;
        ctx.strokeStyle = `rgba(${theme.line}, ${((1 - d / reach) * 0.55 * theme.gain).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    // the brand to each product: always there
    const hub = fixed.find((f) => f.hub);
    if (hub) {
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(${theme.steady}, ${0.42 * theme.gain + 0.1})`;
      ctx.fillStyle = `rgba(${theme.steady}, .9)`;
      for (const f of fixed) {
        if (f === hub || f.port) continue;
        for (const lane of [-7, 7, 0]) {
          const path = trace(hub, f, lane);
          ctx.lineWidth = lane ? 1 : 2;
          ctx.globalAlpha = lane ? 0.45 : 1;
          ctx.beginPath();
          path.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
          // vias where the main trace turns
          if (!lane) for (const p of [path[2], path[3]]) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 6.2832); ctx.fill(); }
        }
        ctx.globalAlpha = 1;
      }
      // Stub traces fanning out of the processor's other leads: out, a 45
      // degree jog, out again, and a via. Fixed, so they are part of the board.
      if (hub.half) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = `rgba(${theme.line}, ${0.5 * theme.gain})`;
        ctx.fillStyle = `rgba(${theme.line}, ${0.8 * theme.gain})`;
        const h2 = hub.half;
        const stubs = [-0.62, -0.36, -0.1, 0.16, 0.42];
        stubs.forEach((k, i) => {
          const run = 22 + ((i * 37) % 46), jog = (i % 2 ? 1 : -1) * 12, tail = 14 + ((i * 23) % 30);
          for (const side of [-1, 1]) { // left and right
            const x0 = hub.x + side * h2, y0 = hub.y + k * h2;
            const x1 = x0 + side * run, x2 = x1 + side * 12, y2 = y0 + jog, x3 = x2 + side * tail;
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x2, y2); ctx.lineTo(x3, y2); ctx.stroke();
            ctx.beginPath(); ctx.arc(x3, y2, 2, 0, 6.2832); ctx.fill();
          }
          // top
          const tx0 = hub.x + k * h2, ty0 = hub.y - h2, ty1 = ty0 - run * 0.7, tx2 = tx0 + jog, ty2 = ty1 - 12, ty3 = ty2 - tail * 0.6;
          if (ty3 > 6) {
            ctx.beginPath(); ctx.moveTo(tx0, ty0); ctx.lineTo(tx0, ty1); ctx.lineTo(tx2, ty2); ctx.lineTo(tx2, ty3); ctx.stroke();
            ctx.beginPath(); ctx.arc(tx2, ty3, 2, 0, 6.2832); ctx.fill();
          }
        });
      }
      ctx.lineWidth = 1;
    }

    // points
    ctx.fillStyle = `rgba(${theme.node}, ${0.85 * theme.gain + 0.1})`;
    for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill(); }

    // signals
    sinceSignal += dt;
    if (!still && sinceSignal > 420 && signals.length < 14) { sinceSignal = 0; send(all); }
    ctx.shadowColor = `rgba(${theme.pulse}, .9)`;
    ctx.shadowBlur = 10;
    ctx.fillStyle = `rgb(${theme.pulse})`;
    signals = signals.filter((s) => {
      const d = s.path ? s.len || 1 : Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) || 1;
      s.t += (dt * 0.16) / d; // the same speed along a long link or a short one
      if (s.t >= 1) {
        const near = s.hops > 0 ? neighbours(s.b, all).filter((n) => n !== s.a) : [];
        if (!near.length) return false;
        s.a = s.b; s.b = near[Math.floor(Math.random() * near.length)]; s.t = 0; s.hops -= 1; s.steady = false; s.path = null;
        return true;
      }
      ctx.beginPath();
      const at = s.path ? along(s.path, s.t) : { x: s.a.x + (s.b.x - s.a.x) * s.t, y: s.a.y + (s.b.y - s.a.y) * s.t };
      ctx.arc(at.x, at.y, s.steady ? 3.2 : 2.2, 0, 6.2832);
      ctx.fill();
      return true;
    });
    ctx.shadowBlur = 0;
  }

  function frame(now) {
    const dt = Math.min(50, now - (last || now));
    last = now;
    draw(dt);
    raf = requestAnimationFrame(frame);
  }
  const stop = () => { cancelAnimationFrame(raf); raf = 0; last = 0; };
  const go = () => {
    if (!w || !h) return;
    if (still) { draw(0); return; }
    if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(frame);
  };

  new ResizeObserver(() => { measure(); stop(); go(); }).observe(host);
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) go(); else stop(); }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else go(); });
  // The marked elements settle once fonts and pictures have loaded.
  window.addEventListener('load', () => { measure(); stop(); go(); });

  if (!still) {
    host.addEventListener('pointermove', (e) => {
      if (!box) return;
      const b = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - b.left, y: e.clientY - b.top, pointer: true };
    });
    host.addEventListener('pointerleave', () => { pointer = null; });
  }

  measure();
  go();
}

document.querySelectorAll('canvas[data-network]').forEach(network);
