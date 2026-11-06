// The Argos orb. A canvas HUD core: segmented rings, a hatched reactor band,
// tick marks and a particle field. Its mood follows Argos:
//   idle      slow breathing, rings drift
//   listening ring tightens, ticks brighten
//   thinking  segments spin fast, particles fall inward
//   acting    gold shock-waves push outward
//   speaking  the core pulses with the voice
export function createOrb(canvas) {
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let state = "idle";
  let level = 0; // 0..1 voice / activity level
  let t = 0;
  const waves = [];
  const parts = Array.from({ length: 90 }, () => spawn());
  const C = { cyan: "25,227,227", gold: "214,178,106", white: "220,250,255" };
  // eased values so state changes glide
  const ease = { speed: 0.2, glow: 0.4, pull: 0, tight: 0 };
  const target = { speed: 0.2, glow: 0.4, pull: 0, tight: 0 };

  function spawn() {
    return { a: Math.random() * Math.PI * 2, r: 0.55 + Math.random() * 0.5, s: 0.2 + Math.random() * 0.8 };
  }

  function setState(s) {
    state = s;
    Object.assign(target, {
      idle: { speed: 0.2, glow: 0.4, pull: 0, tight: 0 },
      listening: { speed: 0.35, glow: 0.65, pull: 0, tight: 1 },
      thinking: { speed: 2.2, glow: 0.8, pull: 1, tight: 0.4 },
      acting: { speed: 1.2, glow: 1, pull: 0.3, tight: 0 },
      speaking: { speed: 0.6, glow: 0.7, pull: 0, tight: 0.2 },
    }[s] || target);
  }
  function pulse() { waves.push({ r: 0.3, a: 1 }); }
  function setLevel(v) { level = Math.max(level, v); }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  function ring(cx, cy, r, w, segs, gap, rot, alpha, color = C.cyan) {
    ctx.lineWidth = w;
    ctx.strokeStyle = `rgba(${color},${alpha})`;
    const step = (Math.PI * 2) / segs;
    for (let i = 0; i < segs; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, rot + i * step, rot + (i + 1) * step - gap);
      ctx.stroke();
    }
  }

  function frame() {
    const { width: W, height: H } = canvas.getBoundingClientRect();
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 * 0.92;
    for (const k in ease) ease[k] += (target[k] - ease[k]) * 0.06;
    t += (reduce ? 0.2 : 1) * 0.016 * (0.5 + ease.speed);
    level *= 0.9;
    if (state === "speaking" && !reduce) level = Math.max(level, 0.25 + 0.25 * Math.sin(t * 9) ** 2);

    ctx.clearRect(0, 0, W, H);

    // glow
    const g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
    g.addColorStop(0, `rgba(${C.cyan},${0.35 * ease.glow + level * 0.4})`);
    g.addColorStop(0.35, `rgba(${C.cyan},${0.08 * ease.glow})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // outer thin rings and ticks
    ring(cx, cy, R * 0.98, 1, 1, 0, 0, 0.18);
    ring(cx, cy, R * 0.93, 2, 6, 0.5, -t * 0.15, 0.35);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.05);
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const long = i % 10 === 0;
      ctx.strokeStyle = `rgba(${C.cyan},${long ? 0.6 : 0.22 + ease.tight * 0.3})`;
      ctx.lineWidth = long ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.84, Math.sin(a) * R * 0.84);
      ctx.lineTo(Math.cos(a) * R * (long ? 0.79 : 0.815), Math.sin(a) * R * (long ? 0.79 : 0.815));
      ctx.stroke();
    }
    ctx.restore();

    // button-ring segments like a console bezel
    ring(cx, cy, R * 0.72, R * 0.07, 16, 0.04, t * 0.08, 0.12 + ease.glow * 0.1, C.white);
    ring(cx, cy, R * 0.72, 1.5, 16, 0.04, t * 0.08, 0.4);

    // hatched reactor band
    const rb = R * (0.52 - ease.tight * 0.03);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.9);
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ctx.strokeStyle = i % 2 ? `rgba(${C.white},${0.55 + level * 0.4})` : `rgba(${C.cyan},${0.9})`;
      ctx.lineWidth = R * 0.035;
      ctx.beginPath();
      ctx.arc(0, 0, rb, a, a + (Math.PI * 2) / n * 0.7);
      ctx.stroke();
    }
    ctx.restore();
    ctx.shadowColor = `rgba(${C.cyan},1)`;
    ctx.shadowBlur = 25 * ease.glow;
    ring(cx, cy, rb + R * 0.035, 2, 1, 0, 0, 0.9);
    ring(cx, cy, rb - R * 0.035, 1, 1, 0, 0, 0.7);
    ctx.shadowBlur = 0;

    // spectrum spikes (voice)
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2 + t * 0.3;
      const amp = (0.02 + level * 0.12 * (0.5 + 0.5 * Math.sin(i * 1.7 + t * 12))) * R;
      ctx.strokeStyle = `rgba(${C.cyan},0.5)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (rb - R * 0.06), Math.sin(a) * (rb - R * 0.06));
      ctx.lineTo(Math.cos(a) * (rb - R * 0.06 - amp), Math.sin(a) * (rb - R * 0.06 - amp));
      ctx.stroke();
    }
    ctx.restore();

    // inner dial
    ring(cx, cy, R * 0.22, 1, 3, 0.6, t * 1.4, 0.6);
    ring(cx, cy, R * 0.16, 2, 1, 0, 0, 0.3 + level);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.15);
    core.addColorStop(0, `rgba(${C.white},${0.55 + level * 0.45})`);
    core.addColorStop(0.5, `rgba(${C.cyan},${0.25 + level * 0.3})`);
    core.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.15 * (1 + level * 0.25), 0, Math.PI * 2); ctx.fill();

    // particles
    for (const p of parts) {
      p.a += 0.003 * p.s * (1 + ease.speed);
      p.r -= 0.004 * p.s * ease.pull;
      if (p.r < 0.2) Object.assign(p, spawn(), { r: 1.05 });
      const x = cx + Math.cos(p.a) * p.r * R, y = cy + Math.sin(p.a) * p.r * R;
      ctx.fillStyle = `rgba(${C.cyan},${0.25 + 0.5 * p.s * ease.glow})`;
      ctx.fillRect(x, y, 1.6, 1.6);
    }

    // acting shock-waves
    if (state === "acting" && !reduce && Math.random() < 0.04) pulse();
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.r += 0.012; w.a -= 0.018;
      if (w.a <= 0) { waves.splice(i, 1); continue; }
      ring(cx, cy, R * w.r, 2, 1, 0, 0, w.a, C.gold);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { setState, setLevel, pulse, get state() { return state; } };
}
