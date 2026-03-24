import './style.css';
import * as THREE from 'three';

// ─────────────────────────────────────────────
//  THREE.JS — Cherry Blossom Particle System
// ─────────────────────────────────────────────

const canvas   = document.querySelector('#bg');
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
camera.position.set(0, 0, 30);

// ── Petal texture drawn on canvas ──
function makePetalTexture() {
  const c   = document.createElement('canvas');
  c.width   = 64;
  c.height  = 80;
  const ctx = c.getContext('2d');

  ctx.save();
  ctx.translate(32, 40);

  // Outer petal shape
  ctx.beginPath();
  ctx.moveTo(0, -28);
  ctx.bezierCurveTo(14, -18, 18, 8, 0, 28);
  ctx.bezierCurveTo(-18, 8, -14, -18, 0, -28);
  ctx.closePath();

  const grad = ctx.createRadialGradient(0, -6, 0, 0, 0, 28);
  grad.addColorStop(0.0, 'rgba(255, 235, 240, 1)');
  grad.addColorStop(0.3, 'rgba(255, 183, 197, 0.95)');
  grad.addColorStop(0.7, 'rgba(232, 96, 122, 0.7)');
  grad.addColorStop(1.0, 'rgba(220, 70, 100, 0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Vein
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(0, 20);
  ctx.strokeStyle = 'rgba(255, 150, 170, 0.3)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  ctx.restore();
  return new THREE.CanvasTexture(c);
}

const petalTex = makePetalTexture();

// ── Ambient background particles ──
function makeAmbientParticles() {
  const count = 600;
  const geo   = new THREE.BufferGeometry();
  const pos   = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    pos[i * 3]     = (Math.random() - 0.5) * 160;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 100;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 80 - 20;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.35,
    color: 0xffb7c5,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}

// ── Falling sakura petals ──
const PETAL_COUNT = 350;

function makePetals() {
  const geo      = new THREE.BufferGeometry();
  const pos      = new Float32Array(PETAL_COUNT * 3);
  const speeds   = new Float32Array(PETAL_COUNT);
  const swings   = new Float32Array(PETAL_COUNT);
  const phases   = new Float32Array(PETAL_COUNT);
  const sizes    = new Float32Array(PETAL_COUNT);

  for (let i = 0; i < PETAL_COUNT; i++) {
    pos[i * 3]     = (Math.random() - 0.5) * 110;
    pos[i * 3 + 1] = (Math.random() * 80) - 10;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 60 - 5;
    speeds[i]   = 0.025 + Math.random() * 0.055;
    swings[i]   = 0.25  + Math.random() * 0.55;
    phases[i]   = Math.random() * Math.PI * 2;
    sizes[i]    = 1.2   + Math.random() * 1.8;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.PointsMaterial({
    size:        2.2,
    map:         petalTex,
    transparent: true,
    opacity:     0.88,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
    vertexColors: false,
  });

  const points = new THREE.Points(geo, mat);

  return { points, speeds, swings, phases };
}

const ambientParticles = makeAmbientParticles();
const { points: petals, speeds, swings, phases } = makePetals();
scene.add(ambientParticles);
scene.add(petals);

// ── Mouse parallax ──
const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
document.addEventListener('mousemove', (e) => {
  mouse.tx = (e.clientX / window.innerWidth  - 0.5) * 4;
  mouse.ty = (e.clientY / window.innerHeight - 0.5) * -2.5;
});

// ── Animation loop ──
let time = 0;

function animate() {
  requestAnimationFrame(animate);
  time += 0.012;

  // Parallax camera follow
  mouse.x += (mouse.tx - mouse.x) * 0.04;
  mouse.y += (mouse.ty - mouse.y) * 0.04;
  camera.position.x = mouse.x;
  camera.position.y = mouse.y;

  // Petal fall & sway
  const pos = petals.geometry.attributes.position.array;
  for (let i = 0; i < PETAL_COUNT; i++) {
    pos[i * 3 + 1] -= speeds[i];
    pos[i * 3]     += Math.sin(time * swings[i] + phases[i]) * 0.018;
    pos[i * 3 + 2] += Math.cos(time * 0.4 + phases[i]) * 0.006;

    if (pos[i * 3 + 1] < -42) {
      pos[i * 3 + 1] = 42;
      pos[i * 3]     = (Math.random() - 0.5) * 110;
    }
  }
  petals.geometry.attributes.position.needsUpdate = true;

  // Slow ambient rotation
  ambientParticles.rotation.y = time * 0.008;
  ambientParticles.rotation.x = time * 0.003;

  renderer.render(scene, camera);
}

animate();

// ── Resize handler ──
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});


// ─────────────────────────────────────────────
//  SCROLL PETAL BURST — section transitions
// ─────────────────────────────────────────────

// Create overlay container
const overlay = document.createElement('div');
overlay.id = 'petal-overlay';
document.body.appendChild(overlay);

// Track which sections have already fired
const firedSections = new Set();
let lastScrollY     = window.scrollY;
let burstCooldown   = false;

// Spawn a wave of petals that fall & part like wind
function spawnPetalBurst(intensity = 1) {
  if (burstCooldown) return;
  burstCooldown = true;
  setTimeout(() => { burstCooldown = false; }, 1200);

  const count = Math.floor(55 * intensity);

  for (let i = 0; i < count; i++) {
    const petal = document.createElement('div');
    petal.className = 'burst-petal';

    const xPct   = Math.random() * 100;           // 0–100% across screen
    const isLeft = xPct < 50;                     // which half

    // Random trajectory values
    const size   = 10 + Math.random() * 12;       // petal size px
    const dur    = 2.8 + Math.random() * 1.8;     // fall duration
    const delay  = Math.random() * 0.9;           // stagger
    const sway   = (Math.random() - 0.5) * 80;   // lateral drift px
    // Parting: left-half goes left, right-half goes right
    const partStrength = 180 + Math.random() * 220;
    const part   = isLeft ? -partStrength : partStrength;

    // Random rotations
    const r0 = Math.random() * 360;
    const r1 = r0 + (Math.random() - 0.5) * 120;
    const r2 = r1 + (Math.random() - 0.5) * 120;
    const r3 = r2 + (Math.random() - 0.5) * 100;
    const r4 = r3 + (Math.random() - 0.5) * 80;

    petal.style.cssText = `
      --x:     ${xPct}%;
      --size:  ${size}px;
      --dur:   ${dur}s;
      --delay: ${delay}s;
      --sway:  ${sway}px;
      --part:  ${part}px;
      --r0: ${r0}deg;
      --r1: ${r1}deg;
      --r2: ${r2}deg;
      --r3: ${r3}deg;
      --r4: ${r4}deg;
      left: ${xPct}%;
    `;

    overlay.appendChild(petal);

    // Remove DOM node after animation ends
    setTimeout(() => petal.remove(), (dur + delay + 0.3) * 1000);
  }
}

// ── Intersection Observer — fire on section enter ──
const sections = document.querySelectorAll('section');

// Add reveal class for fade-in animation
sections.forEach(section => {
  section.classList.add('section-reveal');
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.id || entry.target.className;

      // Reveal animation
      entry.target.classList.add('visible');

      // Petal burst — only once per section, only on downward scroll
      if (!firedSections.has(id)) {
        firedSections.add(id);

        // Skip the very first section (hero) — no burst on load
        if (entry.target.classList.contains('hero')) return;

        // Slight delay so burst coincides with section appearing
        setTimeout(() => spawnPetalBurst(1), 100);
      }
    }
  });
}, {
  threshold: 0.12,
  rootMargin: '0px 0px -60px 0px',
});

sections.forEach(section => observer.observe(section));

// ── Scroll direction — bonus burst on fast scroll ──
window.addEventListener('scroll', () => {
  const currentY = window.scrollY;
  const delta    = Math.abs(currentY - lastScrollY);
  lastScrollY    = currentY;

  // Trigger a lighter burst on very fast scroll (momentum swipe feel)
  if (delta > 280 && !burstCooldown) {
    spawnPetalBurst(0.45);
  }
}, { passive: true });
