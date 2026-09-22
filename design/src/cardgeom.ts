/**
 * The studio's view of the card geometry — one thin layer over the shared file.
 *
 * `design/src/creatordoc.ts` is NOT written here. It is copied, byte for byte,
 * from the app repo's `supabase/functions/_shared/creatordoc.ts` by
 * `node scripts/sync-postercore.mjs`, and `--check` fails on drift. The same
 * bytes run in the edge functions (Deno), in the app (Metro) and here (Vite),
 * and they mirror `_design_doc_clean` / `_design_doc_ok` / `_design_win` in
 * migration 0094 field for field. The database is the one that decides.
 *
 * So this file exists for one reason: the studio was written against its own
 * names (CARD_W, BAND_H, clampWindow) and has a few things the server has no
 * use for (what the browser exports, the edition size, the one sentence to
 * show a creator). Renaming every call site would have been a large change for
 * no gain; this adapter is a small one, and after it there is exactly ONE
 * place that says 900, 1200, 216 or 270 — the shared file.
 *
 *   NUMBERS AND RULES  ->  creatordoc.ts (shared, do not edit here)
 *   WORDS AND THE BROWSER'S OWN LIMITS  ->  this file
 */

import {
  ART_W,
  ART_H,
  BAND_STRIP,
  MAX_ART_BYTES,
  MAX_ART_EDGE,
  MIN_WINDOW,
  TITLE_MAX,
  LINE_MAX,
  bandRect,
  windowBounds,
  fitWindow,
  defaultWindow,
} from './creatordoc';
import type { Band, CardWindow, CardDesignDoc } from './creatordoc';

/* ── The shared numbers, under the names the studio calls them ─────── */

/** The art is one flattened 3:4 image, measured in these units. */
export const CARD_W = ART_W;
export const CARD_H = ART_H;

/** The house torn cream band the app draws over the art, in card units. */
export const BAND_H = BAND_STRIP;

export { MIN_WINDOW, bandRect, defaultWindow };

/** The smallest and longest words that go on the band and in the letter. */
export const MAX_TITLE = TITLE_MAX;
export const MAX_LINE = LINE_MAX;

/** The area a window is allowed to live in: the art minus the band's strip. */
export const freeRect = windowBounds;

/**
 * Pull a window back inside the rules: whole units, at least MIN_WINDOW each
 * way, inside the art, and clear of the band. The editor calls this on every
 * drag, so a creator can never save something the server would refuse.
 */
export const clampWindow = fitWindow;

export type { Band, CardDesignDoc };
export type Win = CardWindow;

/* ── The browser's own limits ──────────────────────────────────────── */

/** What the browser exports. 3:4, inside the edge cap, small enough to encode well. */
export const EXPORT_W = 1200;
export const EXPORT_H = 1600;

/**
 * The caps the browser enforces before anything is sent (contract §6.4).
 * They are the SERVER's caps exactly: poster-asset refuses a web upload over
 * MAX_ART_BYTES, so a browser cap of its own would only ever be a second,
 * quietly different number — and if it were ever the larger of the two, a
 * picture would pass here and be refused there with no way to explain it.
 */
export const MAX_UPLOAD_BYTES = MAX_ART_BYTES;
export const MAX_UPLOAD_PX = MAX_ART_EDGE;

/** One edition is twenty copies, and never more (contract §3.9). */
export const EDITION_MAX = 20;

/** What the creator may say a design is for. There is no 'sale' on the website. */
export type Intent = 'gifts' | 'awards';

/* ── The words ─────────────────────────────────────────────────────── */

/**
 * The one sentence to show a creator when a window is wrong, or null when it
 * is fine. The server says the same thing with the word 'incomplete'; this
 * says it in the editor, before anyone waits on a check.
 */
export function windowProblem(win: Win, band: Band): string | null {
  if (![win.x, win.y, win.w, win.h].every((n) => Number.isInteger(n))) {
    return 'The photo window needs whole numbers.';
  }
  if (win.w < MIN_WINDOW || win.h < MIN_WINDOW) {
    return 'The photo window is too small. Make it bigger, so a face still reads on a phone.';
  }
  if (win.x < 0 || win.y < 0 || win.x + win.w > CARD_W || win.y + win.h > CARD_H) {
    return 'The photo window has to sit inside the art.';
  }
  const free = freeRect(band);
  if (win.y < free.y || win.y + win.h > free.y + free.h) {
    return band === 'top'
      ? 'The photo window is under the band at the top. Move it down.'
      : 'The photo window is under the band at the bottom. Move it up.';
  }
  return null;
}

/** The stamp's shape: [x, y, w, h]. */
export function winArray(win: Win): [number, number, number, number] {
  return [win.x, win.y, win.w, win.h];
}

/** Read a window out of whatever the server sent, with the defaults filled in. */
export function readWindow(v: unknown, band: Band): Win {
  const r = v as Partial<Win> | null | undefined;
  if (!r || typeof r !== 'object') return defaultWindow(band);
  const win = {
    x: Number(r.x) || 0,
    y: Number(r.y) || 0,
    w: Number(r.w) || 0,
    h: Number(r.h) || 0,
  };
  if (!win.w || !win.h) return defaultWindow(band);
  return clampWindow(win, band);
}

export function readBand(v: unknown): Band {
  return v === 'top' ? 'top' : 'bottom';
}
