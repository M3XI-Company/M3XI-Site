/*
 * m3xi.com — the brand pages' small effects. None of it is needed to use a
 * page, and all of it is transform-only, so it costs next to nothing:
 *
 *   1. The cog. On a device with a mouse the pointer is an old cog, in the
 *      brand's black and blue, that turns as it travels and lights up over
 *      anything you can press. Text fields keep the ordinary text cursor.
 *      Touch screens never see it.
 *   2. Tilt. Anything marked data-tilt leans a few degrees towards the pointer.
 *
 * (The hand that presses the homepage's button is shared/hand3d.js.)
 *
 * With prefers-reduced-motion the cog does not turn and nothing tilts.
 * Bundled by Vite, so it runs under script-src 'self'.
 */
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mouse = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ── 1. The cog ──────────────────────────────────────────────────────────── */

function cogSvg() {
  // Twelve square teeth round a rim, an inner ring of notches, four spokes.
  const teeth = [];
  for (let i = 0; i < 12; i++) {
    teeth.push(`<rect x="-2.6" y="-17" width="5.2" height="5" rx=".8" transform="rotate(${i * 30})"/>`);
  }
  const notches = [];
  for (let i = 0; i < 16; i++) {
    notches.push(`<path d="M0 -10.4v1.9" transform="rotate(${i * 22.5})"/>`);
  }
  return `<svg viewBox="-18 -18 36 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g class="cog-metal" stroke-width=".9" stroke-linejoin="round">${teeth.join('')}
      <path fill-rule="evenodd" d="M0-13a13 13 0 1 0 0 26a13 13 0 1 0 0-26zM0-3.2a3.2 3.2 0 1 1 0 6.4a3.2 3.2 0 1 1 0-6.4z"/>
    </g>
    <g class="cog-lines" fill="none" stroke-width=".9" stroke-linecap="round">
      <circle r="8.2"/><circle r="11.3"/>${notches.join('')}
      <path d="M0-8.2V-3.2M0 8.2V3.2M-8.2 0H-3.2M8.2 0H3.2"/>
    </g>
  </svg>`;
}

if (mouse) {
  const cog = document.createElement('div');
  cog.className = 'm3-cog';
  cog.innerHTML = cogSvg();
  document.body.appendChild(cog);
  document.documentElement.classList.add('cog-on');

  let x = -100, y = -100, turn = 0, queued = false;
  const place = () => {
    queued = false;
    cog.style.transform = `translate3d(${x - 18}px, ${y - 18}px, 0) rotate(${turn.toFixed(1)}deg)`;
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(place); } };

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    x = e.clientX; y = e.clientY;
    if (!still) turn += (e.movementX + e.movementY) * 0.9; // it rolls the way it travels
    const t = e.target instanceof Element ? e.target : null;
    cog.classList.toggle('is-text', !!(t && t.closest('input:not([type="submit"]):not([type="button"]), textarea, [contenteditable="true"]')));
    cog.classList.toggle('is-on', !!(t && t.closest('a, button, summary, select, label, [role="button"]')));
    cog.classList.add('is-in');
    queue();
  }, { passive: true });
  window.addEventListener('pointerdown', () => { if (!still) { turn += 60; queue(); } }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => cog.classList.remove('is-in'));
}

/* ── 2. Tilt ─────────────────────────────────────────────────────────────── */

if (mouse && !still) {
  document.querySelectorAll('[data-tilt]').forEach((el) => {
    const max = Number(el.dataset.tilt) || 5; // degrees
    let frame = 0;
    el.addEventListener('pointermove', (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const b = el.getBoundingClientRect();
        const px = (e.clientX - b.left) / b.width - 0.5;
        const py = (e.clientY - b.top) / b.height - 0.5;
        el.style.setProperty('--ry', (px * max * 2).toFixed(2) + 'deg');
        el.style.setProperty('--rx', (-py * max * 2).toFixed(2) + 'deg');
      });
    }, { passive: true });
    el.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame);
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    });
  });
}
