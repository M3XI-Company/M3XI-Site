/*
 * m3xi.com/michael/portfolio/ — the booklets' behaviour.
 *
 *   Photographs open large in a <dialog>, with previous and next.
 *   A film plate (data-yt) swaps its still for the player when it is pressed.
 *     Nothing is loaded from YouTube until then, and then from the
 *     no-cookie domain.
 *   The magnet plate (canvas[data-magnet]) is a small live sketch: particles
 *     drawn towards the pointer.
 *
 * Captions are plain CSS (shared/book.css). Bundled by Vite.
 */
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── the large view ── */
const shots = [...document.querySelectorAll('button.bk-shot[data-large]')];
if (shots.length && 'HTMLDialogElement' in window) {
  const box = document.createElement('dialog');
  box.className = 'bk-lb';
  box.setAttribute('aria-label', 'Photograph');
  box.innerHTML = '<img alt=""><div class="bk-lb-bar"><p><b></b><span></span></p><div><button type="button" data-go="-1" aria-label="Previous">&larr;</button><button type="button" data-go="1" aria-label="Next">&rarr;</button><button type="button" data-go="0">Close</button></div></div>';
  document.body.appendChild(box);
  const img = box.querySelector('img'), title = box.querySelector('b'), text = box.querySelector('span');
  let at = 0;
  const show = (i) => {
    at = (i + shots.length) % shots.length;
    const s = shots[at], cap = s.parentElement.querySelector('.bk-cap');
    img.src = s.dataset.large;
    img.alt = s.querySelector('img') ? s.querySelector('img').alt : '';
    title.textContent = cap ? cap.querySelector('b').textContent : '';
    text.textContent = cap ? cap.querySelector('span').textContent : '';
  };
  shots.forEach((s, i) => s.addEventListener('click', () => { show(i); box.showModal(); }));
  box.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { if (go.dataset.go === '0') box.close(); else show(at + Number(go.dataset.go)); }
    else if (e.target === box) box.close(); // the backdrop
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
}

/* ── films ── */
document.querySelectorAll('.bk-video[data-yt]').forEach((b) => {
  b.addEventListener('click', () => {
    const plate = b.closest('.bk-plate');
    const frame = document.createElement('iframe');
    frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(b.dataset.yt) + '?autoplay=1&rel=0' + (b.dataset.start ? '&start=' + Number(b.dataset.start) : '');
    frame.title = b.getAttribute('aria-label') || 'Film';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    plate.classList.add('is-playing');
    b.replaceWith(frame);
  });
});

/* ── the magnet ── */
document.querySelectorAll('canvas[data-magnet]').forEach((canvas) => {
  const ctx = canvas.getContext('2d');
  const host = canvas.parentElement;
  let w = 0, h = 0, raf = 0, on = true, mx = 0, my = 0, t = 0;
  const N = 420, P = new Float32Array(N * 4);
  const size = () => {
    const b = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = b.width; h = b.height;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < N; i++) { P[i * 4] = Math.random() * w; P[i * 4 + 1] = Math.random() * h; P[i * 4 + 2] = 0; P[i * 4 + 3] = 0; }
    mx = w * 0.5; my = h * 0.45;
  };
  let held = false;
  host.addEventListener('pointermove', (e) => { const b = canvas.getBoundingClientRect(); mx = e.clientX - b.left; my = e.clientY - b.top; held = true; }, { passive: true });
  host.addEventListener('pointerleave', () => { held = false; });
  const draw = () => {
    t += 0.012;
    if (!held) { mx = w * (0.5 + 0.3 * Math.cos(t)); my = h * (0.45 + 0.22 * Math.sin(t * 1.7)); } // it wanders by itself
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#9DB8FF';
    for (let i = 0; i < N; i++) {
      const k = i * 4, dx = mx - P[k], dy = my - P[k + 1], d = Math.hypot(dx, dy) + 24;
      // pulled towards the magnet, and turned a little about it, the way filings line up along a field
      P[k + 2] = (P[k + 2] + (dx / d) * 0.5 - (dy / d) * 0.18) * 0.93;
      P[k + 3] = (P[k + 3] + (dy / d) * 0.5 + (dx / d) * 0.18) * 0.93;
      P[k] += P[k + 2]; P[k + 1] += P[k + 3];
      if (d < 30) { P[k] = Math.random() * w; P[k + 1] = Math.random() * h; }
      ctx.globalAlpha = Math.min(1, 60 / d + 0.25);
      ctx.fillRect(P[k], P[k + 1], 1.8, 1.8);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, 9, 0, 6.2832); ctx.stroke();
  };
  const loop = () => { draw(); raf = requestAnimationFrame(loop); };
  const go = () => { cancelAnimationFrame(raf); if (!w) return; if (still) draw(); else if (on && !document.hidden) raf = requestAnimationFrame(loop); };
  new ResizeObserver(() => { size(); go(); }).observe(host);
  new IntersectionObserver(([e]) => { on = e.isIntersecting; go(); }).observe(canvas);
  document.addEventListener('visibilitychange', go);
  size(); go();
});
