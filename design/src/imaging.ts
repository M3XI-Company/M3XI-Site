/**
 * Pictures, handled entirely in the browser before anything leaves it.
 *
 * Everything a creator brings in is decoded, redrawn onto a canvas and encoded
 * again. That is what strips the metadata: a canvas has no EXIF, no GPS, no
 * maker note and no colour profile to carry, so the file the server receives
 * holds the picture and nothing else. It is also what enforces the caps
 * (contract §6.4: 1.5 MB, 4096 px) without trusting the file's own header.
 *
 * SVG is refused outright — it is a script container, not a picture.
 */

import { CARD_W, CARD_H, EXPORT_W, EXPORT_H, MAX_UPLOAD_BYTES, MAX_UPLOAD_PX } from './cardgeom';
import { paintPaper, drawMotif, drawWords, isPaperKey, PAPERS } from './papers';
import type { PaperKey } from './papers';

/** The art is 3:4, the same shape as the collection cards. */
const ASPECT = CARD_W / CARD_H;

export type Art = {
  blob: Blob;
  /** An object URL for the preview. Revoke it when the art is replaced. */
  url: string;
  w: number;
  h: number;
  mime: string;
  bytes: number;
};

export class ArtProblem extends Error {}

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { alpha: true });
  if (!g) throw new ArtProblem('This browser cannot draw pictures. Try Chrome, Edge, Firefox or Safari.');
  g.imageSmoothingQuality = 'high';
  return { c, g };
}

function toBlob(c: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new ArtProblem('The picture could not be saved.'))), mime, quality);
  });
}

async function decode(file: Blob): Promise<{ draw: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { draw: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to the <img> route */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new ArtProblem('That file is not a picture we can read.'));
      i.src = url;
    });
    return { draw: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * Does any pixel let the paper through?
 *
 * Read from a small copy rather than the full-size canvas: reading back from
 * the canvas the browser is compositing forces it onto the slow path (and
 * says so in the console), and a clear region big enough to matter on a card
 * is still several pixels wide at 96 across.
 */
function looksTransparent(source: HTMLCanvasElement): boolean {
  const w = 96;
  const h = Math.max(1, Math.round((source.height / source.width) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return false;
  g.drawImage(source, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

/**
 * Take whatever the creator chose and hand back a 3:4 picture inside the caps.
 * The picture is cover-cropped from the middle, because the card is a fixed
 * shape and a letterboxed card looks like a mistake rather than a choice.
 */
export async function importArt(file: File): Promise<Art> {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type.indexOf('svg') >= 0 || name.endsWith('.svg')) {
    throw new ArtProblem('We cannot take SVG files. Save your art as a PNG or a JPEG and bring that.');
  }
  if (type && type.indexOf('image/') !== 0) {
    throw new ArtProblem('That is not a picture. Bring a PNG or a JPEG.');
  }
  if (file.size > 60 * 1024 * 1024) {
    throw new ArtProblem('That file is enormous. Bring one under 60 MB and we will shrink it for you.');
  }

  const src = await decode(file);
  try {
    if (src.w < CARD_W || src.h < CARD_H) {
      throw new ArtProblem(
        'That picture is ' + src.w + ' by ' + src.h + '. Card art needs to be at least ' +
        CARD_W + ' by ' + CARD_H + ', standing up, or it goes soft on a phone.',
      );
    }
    // Target size: 3:4, inside the 4096 px cap, no bigger than the source.
    let outH = Math.min(EXPORT_H, MAX_UPLOAD_PX, src.h, Math.round(src.w / ASPECT));
    outH = Math.max(CARD_H, outH);
    const outW = Math.round(outH * ASPECT);

    // Cover crop from the middle of the source.
    const scale = Math.max(outW / src.w, outH / src.h);
    const dw = src.w * scale;
    const dh = src.h * scale;
    const { c, g } = canvas(outW, outH);
    g.drawImage(src.draw, (outW - dw) / 2, (outH - dh) / 2, dw, dh);

    const clear = looksTransparent(c);
    let blob: Blob;
    let mime: string;
    if (clear) {
      blob = await toBlob(c, 'image/png');
      mime = 'image/png';
      if (blob.size > MAX_UPLOAD_BYTES) {
        // Too heavy to keep the clear parts. Lay it on cream, the house stock,
        // and send a photograph-sized file instead.
        const flat = canvas(outW, outH);
        flat.g.fillStyle = '#FFFDF8';
        flat.g.fillRect(0, 0, outW, outH);
        flat.g.drawImage(c, 0, 0);
        blob = await squeeze(flat.c);
        mime = 'image/jpeg';
      }
    } else {
      blob = await squeeze(c);
      mime = 'image/jpeg';
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new ArtProblem('We could not get that picture under 1.5 MB. Try one with less fine detail.');
    }
    return { blob, url: URL.createObjectURL(blob), w: outW, h: outH, mime, bytes: blob.size };
  } finally {
    src.close();
  }
}

/** Step the quality down, then the size, until the file fits. */
async function squeeze(c: HTMLCanvasElement): Promise<Blob> {
  for (const q of [0.92, 0.86, 0.78, 0.7, 0.62]) {
    const b = await toBlob(c, 'image/jpeg', q);
    if (b.size <= MAX_UPLOAD_BYTES) return b;
  }
  // Still too big: redraw at the card's own size and try again.
  const small = canvas(CARD_W, CARD_H);
  small.g.drawImage(c, 0, 0, CARD_W, CARD_H);
  for (const q of [0.88, 0.8, 0.7, 0.6]) {
    const b = await toBlob(small.c, 'image/jpeg', q);
    if (b.size <= MAX_UPLOAD_BYTES) return b;
  }
  return toBlob(small.c, 'image/jpeg', 0.5);
}

/* ── The composer ──────────────────────────────────────────────────── */

export type Placed = {
  key: string;
  /** Where the middle of it sits, as a fraction of the card. */
  x: number;
  y: number;
  /** How big, as a fraction of the card's width. */
  size: number;
  rot: number;
  /** Which of the paper's three spot colours, or -1 for the paper's ink. */
  spot: number;
};

export type Compose = {
  mode: 'compose';
  paper: PaperKey;
  seed: number;
  words: string;
  /** Where the words sit, as a fraction of the card's height. */
  wordsY: number;
  items: Placed[];
};

export function newCompose(): Compose {
  return {
    mode: 'compose',
    paper: 'stationery',
    seed: Math.floor(Math.random() * 1e9) || 1,
    words: '',
    wordsY: 0.34,
    items: [],
  };
}

export function readCompose(v: unknown): Compose | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (r.mode !== 'compose') return null;
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    mode: 'compose',
    paper: isPaperKey(r.paper) ? r.paper : 'stationery',
    seed: Number(r.seed) || 1,
    words: String(r.words || '').slice(0, 40),
    wordsY: Math.min(0.95, Math.max(0.05, Number(r.wordsY) || 0.34)),
    items: items.slice(0, 40).map((it) => {
      const o = (it || {}) as Record<string, unknown>;
      return {
        key: String(o.key || 'tulip'),
        x: Math.min(1, Math.max(0, Number(o.x) || 0.5)),
        y: Math.min(1, Math.max(0, Number(o.y) || 0.5)),
        size: Math.min(0.9, Math.max(0.05, Number(o.size) || 0.2)),
        rot: Number(o.rot) || 0,
        spot: Number.isFinite(Number(o.spot)) ? Number(o.spot) : -1,
      };
    }),
  };
}

/** Paint a composition at any size: the preview uses it small, the export big. */
export function paintCompose(g: CanvasRenderingContext2D, w: number, h: number, state: Compose): void {
  paintPaper(g, w, h, state.paper, state.seed);
  state.items.forEach((it) => {
    drawMotif(
      g, it.key, it.x * w, it.y * h, it.size * w, it.rot,
      placedColour(state.paper, it.spot),
      Math.max(1.6, (it.size * w) / 26),
    );
  });
  drawWords(g, w, h, state.words, state.wordsY * h);
}

/**
 * A sticker is drawn by the creator, so it is opaque — the paper's own motifs
 * sit back at a third of it. Spot -1 is the paper's ink.
 */
export function placedColour(key: PaperKey, spot: number): string {
  const paper = PAPERS[key];
  if (spot < 0) return paper.dark ? 'rgba(246,236,222,0.86)' : 'rgba(40,32,26,0.80)';
  return paper.spots[Math.abs(spot) % paper.spots.length].replace(/[\d.]+\)\s*$/, '0.92)');
}

/** Flatten a composition into the one picture that gets checked and published. */
export async function exportCompose(state: Compose): Promise<Art> {
  const { c, g } = canvas(EXPORT_W, EXPORT_H);
  paintCompose(g, EXPORT_W, EXPORT_H, state);
  let blob = await toBlob(c, 'image/png');
  let mime = 'image/png';
  if (blob.size > MAX_UPLOAD_BYTES) {
    blob = await squeeze(c);
    mime = 'image/jpeg';
  }
  return { blob, url: URL.createObjectURL(blob), w: EXPORT_W, h: EXPORT_H, mime, bytes: blob.size };
}

/* ── Fingerprint ───────────────────────────────────────────────────── */

/**
 * The sha256 the server stores the object under. Computed here so the upload
 * ticket can be issued against a name the bytes actually have.
 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
