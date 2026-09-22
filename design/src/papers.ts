/**
 * The four papers and the stickers, drawn with a pen rather than shipped as
 * images: the studio has no npm dependency and no asset pipeline, and a paper
 * that is painted from numbers scales to any export size.
 *
 * The colours mirror WALLPAPERS in the app (src/components/wallpaper/themes.ts).
 * Those four fields are approved and frozen, so nothing here restyles them —
 * this is the same paper, flattened into one picture, with the creator's own
 * marks on top. Words never sit straight on a paper field: the app draws every
 * word on cream, and so does the composer (see `drawWords`).
 */

export type PaperKey = 'stationery' | 'midnight' | 'garden' | 'postcard';

export type Paper = {
  key: PaperKey;
  label: string;
  blurb: string;
  bg: string;
  ink: string;
  fillerInk: string;
  spots: string[];
  dark: boolean;
};

export const PAPERS: Record<PaperKey, Paper> = {
  stationery: {
    key: 'stationery', label: 'Stationery', blurb: 'Letters, stamps, tape and seals',
    bg: '#F8F3EA',
    ink: 'rgba(52,40,34,0.30)', fillerInk: 'rgba(52,40,34,0.22)',
    spots: ['rgba(240,170,182,0.42)', 'rgba(242,214,140,0.46)', 'rgba(170,203,224,0.46)'],
    dark: false,
  },
  midnight: {
    key: 'midnight', label: 'Midnight', blurb: 'Moons, mixtapes and late calls',
    bg: '#211C2E',
    ink: 'rgba(246,236,222,0.30)', fillerInk: 'rgba(246,236,222,0.22)',
    spots: ['rgba(232,93,117,0.30)', 'rgba(233,196,106,0.26)', 'rgba(143,123,216,0.34)'],
    dark: true,
  },
  garden: {
    key: 'garden', label: 'Garden', blurb: 'Tulips, daisies and afternoon sun',
    bg: '#F2F2E6',
    ink: 'rgba(40,52,38,0.30)', fillerInk: 'rgba(40,52,38,0.22)',
    spots: ['rgba(222,120,140,0.36)', 'rgba(150,190,140,0.40)', 'rgba(240,206,120,0.42)'],
    dark: false,
  },
  postcard: {
    key: 'postcard', label: 'Postcard', blurb: 'Airmail, stamps and somewhere else',
    bg: '#EEF2F5',
    ink: 'rgba(34,48,60,0.30)', fillerInk: 'rgba(34,48,60,0.22)',
    spots: ['rgba(214,96,110,0.34)', 'rgba(120,165,205,0.40)', 'rgba(240,206,120,0.40)'],
    dark: false,
  },
};

export const PAPER_ORDER: PaperKey[] = ['stationery', 'midnight', 'garden', 'postcard'];

export function isPaperKey(v: unknown): v is PaperKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PAPERS, v);
}

/** A tiny deterministic generator, so the same seed paints the same sheet. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

/* ── Motifs. Each draws inside a 100x100 box at the origin. ────────── */

type Motif = (c: Ctx) => void;

const tulip: Motif = (c) => {
  c.beginPath();
  c.moveTo(50, 20); c.bezierCurveTo(30, 28, 24, 46, 24, 56);
  c.bezierCurveTo(24, 70, 36, 78, 50, 78);
  c.bezierCurveTo(64, 78, 76, 70, 76, 56);
  c.bezierCurveTo(76, 46, 70, 28, 50, 20);
  c.closePath(); c.stroke();
  c.beginPath(); c.moveTo(50, 78); c.lineTo(50, 96); c.stroke();
  c.beginPath(); c.moveTo(50, 88); c.quadraticCurveTo(36, 84, 30, 74); c.stroke();
  c.beginPath(); c.moveTo(50, 88); c.quadraticCurveTo(64, 84, 70, 74); c.stroke();
};

const envelope: Motif = (c) => {
  c.beginPath(); c.rect(14, 26, 72, 48); c.stroke();
  c.beginPath(); c.moveTo(14, 26); c.lineTo(50, 54); c.lineTo(86, 26); c.stroke();
};

const stamp: Motif = (c) => {
  c.beginPath();
  const n = 9;
  for (let i = 0; i < n; i++) {
    const t = 20 + (i * 60) / (n - 1);
    c.moveTo(t, 18); c.arc(t, 18, 3, 0, Math.PI * 2);
    c.moveTo(t, 82); c.arc(t, 82, 3, 0, Math.PI * 2);
    c.moveTo(18, t); c.arc(18, t, 3, 0, Math.PI * 2);
    c.moveTo(82, t); c.arc(82, t, 3, 0, Math.PI * 2);
  }
  c.stroke();
  c.beginPath(); c.rect(28, 28, 44, 44); c.stroke();
};

const star: Motif = (c) => {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 34 : 15;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const x = 50 + Math.cos(a) * r;
    const y = 50 + Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath(); c.stroke();
};

const moon: Motif = (c) => {
  c.beginPath();
  c.arc(50, 50, 32, Math.PI * 0.35, Math.PI * 1.45);
  c.bezierCurveTo(44, 36, 44, 64, 61, 78);
  c.closePath(); c.stroke();
};

const plane: Motif = (c) => {
  c.beginPath();
  c.moveTo(12, 56); c.lineTo(88, 30); c.lineTo(58, 74); c.lineTo(48, 58); c.closePath();
  c.stroke();
  c.beginPath(); c.moveTo(48, 58); c.lineTo(88, 30); c.stroke();
};

const cloud: Motif = (c) => {
  c.beginPath();
  c.arc(38, 58, 16, Math.PI * 0.5, Math.PI * 1.5);
  c.arc(54, 46, 20, Math.PI, Math.PI * 1.85);
  c.arc(70, 58, 14, Math.PI * 1.5, Math.PI * 0.5);
  c.closePath(); c.stroke();
};

const sun: Motif = (c) => {
  c.beginPath(); c.arc(50, 50, 20, 0, Math.PI * 2); c.stroke();
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i;
    c.moveTo(50 + Math.cos(a) * 28, 50 + Math.sin(a) * 28);
    c.lineTo(50 + Math.cos(a) * 38, 50 + Math.sin(a) * 38);
  }
  c.stroke();
};

const sparkle: Motif = (c) => {
  c.beginPath();
  c.moveTo(50, 14); c.quadraticCurveTo(54, 46, 86, 50);
  c.quadraticCurveTo(54, 54, 50, 86);
  c.quadraticCurveTo(46, 54, 14, 50);
  c.quadraticCurveTo(46, 46, 50, 14);
  c.closePath(); c.stroke();
};

const washi: Motif = (c) => {
  c.beginPath(); c.moveTo(12, 38); c.lineTo(88, 30); c.lineTo(88, 62); c.lineTo(12, 70); c.closePath(); c.stroke();
  c.beginPath(); c.moveTo(30, 34); c.lineTo(30, 68); c.moveTo(50, 32); c.lineTo(50, 66); c.moveTo(70, 31); c.lineTo(70, 64); c.stroke();
};

const ring: Motif = (c) => { c.beginPath(); c.arc(50, 50, 22, 0, Math.PI * 2); c.stroke(); };
const cross: Motif = (c) => { c.beginPath(); c.moveTo(30, 50); c.lineTo(70, 50); c.moveTo(50, 30); c.lineTo(50, 70); c.stroke(); };
const dash: Motif = (c) => { c.beginPath(); c.moveTo(26, 50); c.lineTo(74, 50); c.stroke(); };
const dot3: Motif = (c) => {
  c.beginPath();
  [[34, 44], [50, 58], [66, 44]].forEach(([x, y]) => { c.moveTo(x + 4, y); c.arc(x, y, 4, 0, Math.PI * 2); });
  c.fill();
};
const squiggle: Motif = (c) => {
  c.beginPath(); c.moveTo(20, 54);
  c.quadraticCurveTo(32, 34, 44, 54); c.quadraticCurveTo(56, 74, 68, 54); c.quadraticCurveTo(76, 42, 82, 50);
  c.stroke();
};

export const MOTIFS: Record<string, Motif> = {
  tulip, envelope, stamp, star, moon, plane, cloud, sun, sparkle, washi,
  ring, cross, dash, dot3, squiggle,
};

/** The stickers a creator can place, in the order the picker shows them. */
export const STICKERS: { key: string; label: string }[] = [
  { key: 'tulip', label: 'Tulip' },
  { key: 'envelope', label: 'Envelope' },
  { key: 'stamp', label: 'Stamp' },
  { key: 'star', label: 'Star' },
  { key: 'moon', label: 'Moon' },
  { key: 'plane', label: 'Paper plane' },
  { key: 'cloud', label: 'Cloud' },
  { key: 'sun', label: 'Sun' },
  { key: 'sparkle', label: 'Sparkle' },
  { key: 'washi', label: 'Tape' },
];

/** Draw one motif centred at (x, y) at `size` points, turned by `rot` degrees. */
export function drawMotif(
  c: Ctx,
  key: string,
  x: number,
  y: number,
  size: number,
  rot: number,
  colour: string,
  stroke: number,
): void {
  const motif = MOTIFS[key];
  if (!motif) return;
  c.save();
  c.translate(x, y);
  c.rotate((rot * Math.PI) / 180);
  c.scale(size / 100, size / 100);
  c.translate(-50, -50);
  c.strokeStyle = colour;
  c.fillStyle = colour;
  c.lineWidth = (stroke * 100) / size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  motif(c);
  c.restore();
}

const HEROES: Record<PaperKey, string[]> = {
  stationery: ['envelope', 'stamp', 'washi', 'plane', 'tulip', 'star', 'sparkle'],
  midnight: ['moon', 'star', 'sparkle', 'cloud', 'plane', 'tulip'],
  garden: ['tulip', 'sun', 'cloud', 'sparkle', 'star'],
  postcard: ['stamp', 'plane', 'cloud', 'sun', 'envelope', 'star'],
};
const FILLERS = ['cross', 'ring', 'dot3', 'dash', 'squiggle'];

/**
 * Paint a whole sheet of one paper onto a canvas of any size. Motifs are
 * placed by a jittered grid rather than a true Poisson test — at this scale
 * the eye cannot tell, and the arithmetic stays short.
 */
export function paintPaper(c: Ctx, w: number, h: number, key: PaperKey, seed: number): void {
  const paper = PAPERS[isPaperKey(key) ? key : 'stationery'];
  c.save();
  c.fillStyle = paper.bg;
  c.fillRect(0, 0, w, h);
  const r = rng(seed || 1);
  const tile = Math.max(w, h) / 6.4;
  const heroes = HEROES[paper.key];
  const stroke = Math.max(1.2, tile / 34);
  for (let gy = -1; gy * tile < h + tile; gy++) {
    for (let gx = -1; gx * tile < w + tile; gx++) {
      const x = (gx + 0.5 + (r() - 0.5) * 0.8) * tile;
      const y = (gy + 0.5 + (r() - 0.5) * 0.8) * tile;
      const size = tile * (0.42 + r() * 0.26);
      const rot = (r() - 0.5) * 48;
      const spot = r() < 0.55;
      const colour = spot ? paper.spots[Math.floor(r() * paper.spots.length)] : paper.ink;
      drawMotif(c, heroes[Math.floor(r() * heroes.length)], x, y, size, rot, colour, stroke);
      if (r() < 0.8) {
        drawMotif(
          c,
          FILLERS[Math.floor(r() * FILLERS.length)],
          x + (r() - 0.4) * tile,
          y + (r() - 0.4) * tile,
          tile * (0.14 + r() * 0.1),
          (r() - 0.5) * 60,
          paper.fillerInk,
          stroke * 0.85,
        );
      }
    }
  }
  c.restore();
}

/**
 * Words on a composed card, on their own cream strip. Nothing in this world
 * puts type straight onto a paper field, so the composer does not either.
 */
export function drawWords(c: Ctx, w: number, h: number, words: string, atY: number): void {
  const text = words.trim();
  if (!text) return;
  const size = Math.round(h * 0.062);
  c.save();
  c.font = '600 ' + size + 'px "Playfair Display", Georgia, serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const width = Math.min(w * 0.86, c.measureText(text).width + size * 1.4);
  const boxH = size * 1.9;
  const x = (w - width) / 2;
  const y = Math.max(boxH * 0.6, Math.min(h - boxH * 0.6, atY)) - boxH / 2;
  c.fillStyle = 'rgba(25,21,15,0.14)';
  c.fillRect(x + size * 0.1, y + size * 0.14, width, boxH);
  c.fillStyle = '#FFFDF8';
  c.fillRect(x, y, width, boxH);
  c.strokeStyle = 'rgba(25,21,15,0.55)';
  c.lineWidth = Math.max(1.4, size * 0.05);
  c.strokeRect(x, y, width, boxH);
  c.fillStyle = '#19150F';
  c.fillText(text, w / 2, y + boxH / 2 + size * 0.04);
  c.restore();
}
