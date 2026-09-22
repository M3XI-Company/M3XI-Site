/**
 * A DOM twin of the app's collection card.
 *
 * The app draws a designed card as: the art, untouched and full bleed; the
 * wearer's own photo in the design's window; and the house torn cream band,
 * which the app prints in its own type so a name is always readable and the
 * ink never flips. This is that, in HTML, so a creator sees on the website
 * what a person will hold in the app.
 *
 * It is a twin, not the renderer. The only numbers it knows come from
 * creatordoc.ts, which is the file the app agent keeps in step.
 */

import { CARD_W, CARD_H, BAND_H, MIN_WINDOW, clampWindow } from './cardgeom';
import type { Band, Win } from './cardgeom';
import { el, svg } from './dom';

export type CardTwin = {
  root: HTMLElement;
  setArt(url: string | null): void;
  /** The composer paints straight into the card, so nothing is encoded per keystroke. */
  artCanvas: HTMLCanvasElement;
  useCanvas(on: boolean): void;
  setWindow(win: Win): void;
  setBand(band: Band): void;
  setTitle(title: string): void;
  setLine(line: string): void;
  setEdition(serial: number, of: number): void;
  window(): Win;
  /**
   * Stop the window being dragged, resized or focused — for a design that has
   * been sent and can no longer be changed. The listeners stay; they simply do
   * nothing, so nothing has to be rebuilt.
   */
  lock(on: boolean): void;
};

/** A drawn placeholder, never a real face: this is where the wearer goes. */
function placeholderFace(): SVGElement {
  return svg('svg', { viewBox: '0 0 120 150', class: 'facemark', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid slice' }, [
    svg('rect', { width: 120, height: 150, fill: '#E7DECD' }),
    svg('circle', { cx: 60, cy: 58, r: 26, fill: '#CDBFA8' }),
    svg('path', { d: 'M18 150c0-26 19-44 42-44s42 18 42 44z', fill: '#CDBFA8' }),
    svg('path', { d: 'M50 56c2.6 0 4 1.4 4 3M66 56c2.6 0 4 1.4 4 3M52 70c4 3.4 12 3.4 16 0', stroke: '#8A7B62', 'stroke-width': 2.4, fill: 'none', 'stroke-linecap': 'round' }),
  ]);
}

export function cardTwin(opts?: {
  editable?: boolean;
  onWindow?: (win: Win) => void;
}): CardTwin {
  const editable = !!opts?.editable;

  const art = el('img', { class: 'art', alt: '' });
  art.hidden = true;
  const artCanvas = el('canvas', { class: 'art', 'aria-hidden': 'true' });
  artCanvas.hidden = true;
  const empty = el('div', { class: 'art empty' }, [el('span', { text: 'Your art goes here' })]);

  const win = el('div', {
    class: 'win',
    role: 'group',
    tabindex: editable ? '0' : '-1',
    'aria-label': editable
      ? 'The photo window. Drag it, or use the arrow keys to move it and shift with the arrow keys to resize it.'
      : 'The photo window',
    // Its size and every problem with it are written into #winwords, which is
    // in another part of the page: without this a blind creator moves the
    // window and hears nothing at all.
    'aria-describedby': editable ? 'winwords' : undefined,
  }, [placeholderFace(), el('span', { class: 'wintag', text: 'Their photo' })]);
  const grip = el('span', { class: 'grip', 'aria-hidden': 'true' });
  if (editable) win.appendChild(grip);

  /*
   * The band, in the app's own order — this is the whole point of the twin.
   *
   * CallMe draws the WEARER's name as the big serif line and the design's
   * title as a small uppercase caption beneath it, with the collector's number
   * beside that and the city under both (components/CreatorCard.tsx). Drawing
   * the title as the headline here told a creator their carefully weighted
   * title was the first thing anyone would read, when on the phone it is a
   * 10pt caption — and in every list view (the collection, the gift sheet) it
   * is dropped altogether, which is what `thumb` below shows.
   */
  const bandName = el('div', { class: 'bname', text: 'Their name, 27' });
  const bandTitle = el('div', { class: 'btitle' });
  const bandNo = el('div', { class: 'bn', text: 'No. 1 of 20' });
  const bandCity = el('div', { class: 'bcity', text: 'Their city' });
  const band = el('div', { class: 'band bottom' }, [
    el('span', { class: 'tear', 'aria-hidden': 'true' }),
    el('div', { class: 'bandwords' }, [
      bandName,
      el('div', { class: 'bandline' }, [bandTitle, bandNo]),
      bandCity,
    ]),
  ]);

  const root = el('div', { class: 'cardtwin' + (editable ? ' live' : '') }, [empty, art, artCanvas, win, band]);

  let current: Win = { x: 0, y: 0, w: MIN_WINDOW, h: MIN_WINDOW };
  let currentBand: Band = 'bottom';
  /** Sent for checking: the window still shows, and nothing moves it. */
  let locked = false;

  function place(): void {
    win.style.left = (current.x / CARD_W) * 100 + '%';
    win.style.top = (current.y / CARD_H) * 100 + '%';
    win.style.width = (current.w / CARD_W) * 100 + '%';
    win.style.height = (current.h / CARD_H) * 100 + '%';
  }

  function setWindow(next: Win): void {
    current = clampWindow(next, currentBand);
    place();
  }

  function announce(): void {
    if (opts?.onWindow) opts.onWindow(current);
  }

  /* ── Dragging, on pointer events. ──────────────────────────────── */
  if (editable) {
    let mode: 'move' | 'size' | null = null;
    let startX = 0;
    let startY = 0;
    let from: Win = current;
    let unit = 1;

    const down = (e: PointerEvent, how: 'move' | 'size') => {
      if (locked) return;
      const rect = root.getBoundingClientRect();
      if (!rect.width) return;
      mode = how;
      unit = CARD_W / rect.width;
      startX = e.clientX;
      startY = e.clientY;
      from = { ...current };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };
    const move = (e: PointerEvent) => {
      if (!mode) return;
      const dx = (e.clientX - startX) * unit;
      const dy = (e.clientY - startY) * unit;
      if (mode === 'move') setWindow({ ...from, x: from.x + dx, y: from.y + dy });
      else setWindow({ ...from, w: from.w + dx, h: from.h + dy });
      announce();
    };
    const up = (e: PointerEvent) => {
      if (!mode) return;
      mode = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      announce();
    };

    win.addEventListener('pointerdown', (e) => down(e as PointerEvent, 'move'));
    grip.addEventListener('pointerdown', (e) => down(e as PointerEvent, 'size'));
    win.addEventListener('pointermove', move as EventListener);
    grip.addEventListener('pointermove', move as EventListener);
    win.addEventListener('pointerup', up as EventListener);
    grip.addEventListener('pointerup', up as EventListener);
    win.addEventListener('pointercancel', up as EventListener);

    win.addEventListener('keydown', (e) => {
      if (locked) return;
      const k = (e as KeyboardEvent).key;
      const step = (e as KeyboardEvent).altKey ? 2 : 18;
      const sizing = (e as KeyboardEvent).shiftKey;
      let next: Win | null = null;
      if (k === 'ArrowLeft') next = sizing ? { ...current, w: current.w - step } : { ...current, x: current.x - step };
      else if (k === 'ArrowRight') next = sizing ? { ...current, w: current.w + step } : { ...current, x: current.x + step };
      else if (k === 'ArrowUp') next = sizing ? { ...current, h: current.h - step } : { ...current, y: current.y - step };
      else if (k === 'ArrowDown') next = sizing ? { ...current, h: current.h + step } : { ...current, y: current.y + step };
      if (!next) return;
      e.preventDefault();
      setWindow(next);
      announce();
    });
  }

  return {
    root,
    artCanvas,
    setArt(url) {
      if (url) {
        art.setAttribute('src', url);
        art.hidden = false;
        artCanvas.hidden = true;
        empty.hidden = true;
      } else {
        art.removeAttribute('src');
        art.hidden = true;
        empty.hidden = !artCanvas.hidden ? true : false;
      }
    },
    useCanvas(on) {
      artCanvas.hidden = !on;
      if (on) { art.hidden = true; empty.hidden = true; }
      else if (!art.getAttribute('src')) empty.hidden = false;
    },
    setWindow,
    setBand(next) {
      currentBand = next;
      band.className = 'band ' + next;
      setWindow(current);
    },
    setTitle(title) {
      // Uppercase, small — exactly what the app prints (CreatorCard's second row).
      bandTitle.textContent = (title || 'CALLME · MECARD').toUpperCase();
    },
    setLine() {
      // Deliberately nothing. The app does not draw the line on the band
      // (CreatorCard only ever falls back to it when there is no title), so
      // showing it here would have somebody writing for a caption that never
      // appears. The line is kept for their own library and nothing else.
    },
    setEdition(serial, of) {
      bandNo.textContent = 'No. ' + serial + ' of ' + of;
    },
    window: () => current,
    lock(on) {
      locked = !!on;
      root.classList.toggle('locked', locked);
      win.setAttribute('tabindex', editable && !locked ? '0' : '-1');
      grip.hidden = !editable || locked;
    },
  };
}

/** The height of the band as a fraction, for anything that needs to lay out around it. */
export const BAND_FRACTION = BAND_H / CARD_H;
