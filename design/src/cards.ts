/**
 * #/cards — the card design editor.
 *
 * Three things, in order: the art, the card, then send it for checking. The
 * preview on the left is a twin of the app's renderer, so nothing is a
 * surprise when the design lands in somebody's collection.
 *
 * Premium only, and only after the phone has said "that's me". Everything the
 * server refuses, the editor tries to refuse first, in plain words.
 */

import * as api from './api';
import type { Design, Session } from './api';
import {
  CARD_W, CARD_H, EDITION_MAX, MAX_TITLE, MAX_LINE,
  defaultWindow, readWindow, readBand, windowProblem, winArray,
} from './cardgeom';
import type { Band, Win } from './cardgeom';
import { cardTwin } from './card';
import { el, letter, toast, clear } from './dom';
import { importArt, exportCompose, newCompose, readCompose, paintCompose, sha256Hex, ArtProblem, placedColour } from './imaging';
import type { Art, Compose, Placed } from './imaging';
import { PAPERS, PAPER_ORDER, STICKERS, drawMotif } from './papers';
import type { PaperKey } from './papers';
import { current, onChange, sessionGoneLetter } from './pair';

type ArtState = 'none' | 'local' | 'uploading' | 'checking' | 'ok' | 'refused';

const PREVIEW_W = 600;
const PREVIEW_H = 800;

export function cardsView(host: HTMLElement, designId: string): () => void {
  const cleanups: (() => void)[] = [];
  let dead = false;
  cleanups.push(() => { dead = true; });

  const gate = el('div');
  host.appendChild(gate);

  cleanups.push(onChange((s) => {
    if (s.phase === 'signed_in') return;
    clear(gate);
    gate.appendChild(el('section', { class: 'letter wide' }, [
      el('span', { class: 'seal', 'aria-hidden': 'true' }),
      el('h2', { text: 'Sign in with your phone first' }),
      el('p', { text: 'The creator studio comes with CallMe Premium, in the app. Open CallMe, go to Settings, then Creator studio, and scan the code on the front page.' }),
      el('div', { class: 'actions' }, [el('a', { class: 'btn rose', href: '#/', text: 'Go to the code' })]),
    ]));
  }));

  const session = current();
  if (!session) return () => cleanups.forEach((f) => f());

  clear(gate);
  const editorHost = el('div');
  host.appendChild(editorHost);
  const stopEditor = editor(editorHost, session, designId, () => dead);
  cleanups.push(stopEditor);
  return () => cleanups.forEach((f) => f());
}

function editor(host: HTMLElement, session: Session, designId: string, isDead: () => boolean): () => void {
  /* ── State ─────────────────────────────────────────────────── */
  let id: string | null = designId || null;
  let title = '';
  let line = '';
  let band: Band = 'bottom';
  let win: Win = defaultWindow('bottom');
  let editionMax = EDITION_MAX;
  let intent: Record<string, boolean> = { gifts: true, awards: false };
  /** The composition, kept whichever tab is showing. */
  let compose: Compose | null = null;
  /** Which of the two art routes is in use. The other one's work is not thrown away. */
  let composing = false;
  /** An imported picture, kept whichever tab is showing. */
  let art: Art | null = null;
  let artState: ArtState = 'none';
  let artAsset = '';
  let artNote = '';
  let publicArt = '';
  /**
   * A signed look at the creator's own uploaded art, for a draft whose picture
   * is not public yet (it never is before review). Without it, reopening a
   * draft that was made from an uploaded picture showed an empty card.
   */
  let previewArt = '';
  let selected = -1;
  let ownWork = false;
  let state: Design['state'] = 'draft';
  let saveTimer = 0;
  let assetTimer = 0;
  let busy = false;
  /**
   * Sent, and no longer editable.
   *
   * `queueSave()` has always returned early for anything but draft/refused,
   * but the panel stayed fully live: a creator could retype the title, watch
   * the band change on the preview, drag the photo window, and leave — with
   * nothing sent to the server and no message ever shown. It is computed once
   * per render and every control is built from it.
   */
  let frozen = false;
  /** A save that failed. Kept until one succeeds, and retried with backoff. */
  let unsaved = false;
  let retryTimer = 0;
  let retryWait = 4000;

  const twin = cardTwin({
    editable: true,
    onWindow: (w) => { win = w; refreshWindowWords(); queueSave(); },
  });

  /**
   * The same card at the size the phone draws it in a list.
   *
   * Below 160pt CallMe drops the title caption and the city and rides the
   * collector's number up beside the wearer's name — and that is every place
   * the collection and the gift sheet draw a design. A creator who only ever
   * saw the big preview was writing a title for a headline it never becomes.
   */
  const thumb = cardTwin();
  thumb.root.classList.add('thumb');

  const clip = el('div', { class: 'clip', hidden: true }, [
    el('span', { class: 'clipmark', 'aria-hidden': 'true' }),
    el('span', { text: 'Checking' }),
  ]);
  const stage = el('div', { class: 'stage' }, [
    // Every view needs a top heading. This one started at "1. The art" (h3),
    // so navigating by heading never found the page at all.
    el('h1', { class: 'stageh1', text: 'Design a card' }),
    el('div', { class: 'cardhold' }, [twin.root, clip]),
    // aria-live: the size and every problem with the photo window are written
    // here, in a different part of the page from the window itself, so moving
    // the window with the arrow keys used to say nothing at all.
    el('p', { class: 'muted small', id: 'winwords', role: 'status', 'aria-live': 'polite' }),
    el('div', { class: 'previewrow' }, [
      el('div', { class: 'thumbhold' }, [thumb.root]),
      el('p', { class: 'thumbwords', text: 'How it looks on a phone, in a list: the wearer’s name is the big line and your title is the small one under it.' }),
    ]),
  ]);

  const panel = el('div', { class: 'panel' });
  const wrap = el('div', { class: 'studio' }, [stage, panel]);
  host.appendChild(wrap);

  const winWords = stage.querySelector('#winwords') as HTMLElement;

  function refreshWindowWords(): void {
    const problem = windowProblem(win, band);
    winWords.textContent = problem
      ? problem
      : 'The photo window is ' + win.w + ' by ' + win.h + '. Drag it, or use the arrow keys.';
    winWords.className = problem ? 'warn small' : 'muted small';
  }

  function repaintCompose(): void {
    if (!compose) return;
    // The thumbnail is the same drawing at 1/4 the size — cheap enough to
    // repaint on every keystroke, which a toDataURL round trip would not be.
    const tc = thumb.artCanvas;
    tc.width = Math.round(PREVIEW_W / 4);
    tc.height = Math.round(PREVIEW_H / 4);
    const tg = tc.getContext('2d');
    if (tg) { paintCompose(tg, tc.width, tc.height, compose); thumb.useCanvas(true); }

    const c = twin.artCanvas;
    c.width = PREVIEW_W;
    c.height = PREVIEW_H;
    const g = c.getContext('2d');
    if (!g) return;
    paintCompose(g, PREVIEW_W, PREVIEW_H, compose);
    if (selected >= 0 && compose.items[selected]) {
      const it = compose.items[selected];
      g.save();
      g.strokeStyle = '#B7566B';
      g.lineWidth = 3;
      g.setLineDash([7, 6]);
      const r = (it.size * PREVIEW_W) / 2 + 8;
      g.beginPath();
      g.arc(it.x * PREVIEW_W, it.y * PREVIEW_H, r, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
    twin.useCanvas(true);
  }

  function refreshPreview(): void {
    twin.setBand(band);
    twin.setWindow(win);
    twin.setTitle(title);
    twin.setEdition(1, editionMax || EDITION_MAX);
    if (publicArt) twin.setArt(api.artUrl(publicArt));
    else if (composing && compose) repaintCompose();
    else if (art) { twin.useCanvas(false); twin.setArt(art.url); }
    else if (previewArt) { twin.useCanvas(false); twin.setArt(previewArt); }
    else { twin.useCanvas(false); twin.setArt(null); }
    clip.hidden = !(artState === 'uploading' || artState === 'checking');
    refreshWindowWords();
    // The same card at the size a phone draws it in every list view, so the
    // band's small caption is seen before the design is sent.
    thumb.setBand(band);
    thumb.setWindow(win);
    thumb.setTitle(title);
    thumb.setEdition(1, editionMax || EDITION_MAX);
    if (publicArt) { thumb.useCanvas(false); thumb.setArt(api.artUrl(publicArt)); }
    else if (composing && compose) thumb.useCanvas(true);
    else if (art) { thumb.useCanvas(false); thumb.setArt(art.url); }
    else if (previewArt) { thumb.useCanvas(false); thumb.setArt(previewArt); }
    else { thumb.useCanvas(false); thumb.setArt(null); }
  }

  /* ── Saving ────────────────────────────────────────────────── */
  function fields(): api.SaveFields {
    const f: api.SaveFields = {
      kind: 'card',
      title: title.slice(0, MAX_TITLE),
      line: line.slice(0, MAX_LINE),
      edition_max: Math.max(1, Math.min(EDITION_MAX, editionMax || EDITION_MAX)),
      intent: Object.keys(intent).filter((k) => intent[k]),
    };
    if (artAsset) f.doc = { v: 1, art: artAsset, window: { ...win }, band };
    if (compose) f.layers = compose as unknown as Record<string, unknown>;
    return f;
  }

  function queueSave(): void {
    // Typing a title is what makes a card sendable, so the send block has to
    // keep up with the keystrokes. Redrawing the whole panel would take the
    // focus out of the field being typed into, so only that block is touched.
    refreshSend();
    if (frozen) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void save(false); }, 1400);
  }

  async function save(loud: boolean): Promise<boolean> {
    if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = 0; }
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = 0; }
    if (busy) return false;
    busy = true;
    try {
      const d = await api.designSave(session, { design: id, ...fields() });
      id = d.id || id;
      state = d.state || state;
      if (id && location.hash.indexOf(id) < 0) {
        history.replaceState(null, '', '#/cards/' + id);
      }
      unsaved = false;
      retryWait = 4000;
      refreshSend();
      if (loud) toast('Saved.');
      return true;
    } catch (e) {
      if (e instanceof api.ApiError && (e.reason === 'unknown' || e.reason === 'closed')) { sessionGoneLetter(); return false; }
      /*
       * A failed autosave used to be a 4.6-second chip and nothing else —
       * `toast`'s own comment says it is "never used for anything a person
       * must read once". So a dropped connection meant ten more minutes of
       * work against a document that was no longer being saved, with no sign
       * of it. Now it is a state on the send block, and it retries.
       */
      unsaved = true;
      refreshSend();
      if (!isDead()) {
        if (retryTimer) window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => { void save(false); }, retryWait);
        retryWait = Math.min(60000, Math.round(retryWait * 1.8));
      }
      return false;
    } finally {
      busy = false;
    }
  }

  /* ── Art ───────────────────────────────────────────────────── */
  function stopAssetPoll(): void {
    if (assetTimer) window.clearTimeout(assetTimer);
    assetTimer = 0;
  }

  function pollAsset(): void {
    stopAssetPoll();
    assetTimer = window.setTimeout(async () => {
      if (isDead() || !artAsset) return;
      try {
        const s = await api.assetState(session, artAsset);
        previewArt = s.preview || previewArt;
        applyAssetState(s.state, s.reason);
      } catch {
        /* keep waiting; the phone is the place that explains a refusal */
      }
      if (artState === 'checking') pollAsset();
    }, 3000);
  }

  /** Returns the state it settled on, so a caller need not re-read the closure. */
  function applyAssetState(next: string, reason: string): ArtState {
    if (next === 'ok') {
      artState = 'ok';
      artNote = 'This art passed its checks.';
    } else if (next === 'refused' || next === 'removed') {
      artState = 'refused';
      artNote = 'This art cannot be used. Your phone says why.';
      artAsset = '';
      previewArt = '';
    } else {
      artState = 'checking';
      artNote = reason || 'Checking your art. This is usually quick.';
    }
    renderPanel();
    refreshPreview();
    return artState;
  }

  /** Send one picture to be checked. `source` is the imported file, or the
   *  flattened composition — whichever tab asked. */
  async function uploadArtFrom(source: Art | null, temporary = false): Promise<void> {
    if (!source) return;
    if (!ownWork) { toast('Tick to say the art is your own work first.'); return; }
    artState = 'uploading';
    artNote = 'Sending your art…';
    renderPanel();
    refreshPreview();
    try {
      const sha = await sha256Hex(source.blob);
      const ticket = await api.uploadUrl(session, {
        kind: 'card_art', bytes: source.bytes, mime: source.mime, sha256: sha, w: source.w, h: source.h,
      });
      await api.putBytes(ticket, source.blob);
      artAsset = ticket.asset;
      const s = await api.assetDone(session, ticket);
      previewArt = s.preview || previewArt;
      if (applyAssetState(s.state, s.reason) === 'checking') pollAsset();
      void save(false);
    } catch (e) {
      artState = art || compose ? 'local' : 'none';
      artAsset = '';
      artNote = api.say(e);
      renderPanel();
      refreshPreview();
    } finally {
      // The flattened composition is only ever a carrier for the upload.
      if (temporary) URL.revokeObjectURL(source.url);
    }
  }

  function uploadArt(): Promise<void> { return uploadArtFrom(art); }

  async function takeFile(file: File): Promise<void> {
    try {
      const next = await importArt(file);
      if (art) URL.revokeObjectURL(art.url);
      art = next;
      // The composition is NOT thrown away: it belongs to the other tab and
      // is still there when somebody goes back to it.
      composing = false;
      selected = -1;
      artAsset = '';
      artState = 'local';
      artNote = 'Ready. ' + Math.round(next.bytes / 1024) + ' KB, ' + next.w + ' by ' + next.h + '. We stripped everything else out of the file.';
      twin.useCanvas(false);
      renderPanel();
      refreshPreview();
    } catch (e) {
      const words = e instanceof ArtProblem ? e.message : 'That picture would not open. Try a PNG or a JPEG.';
      letter({ title: 'That one will not do', body: words });
    }
  }

  async function useComposed(): Promise<void> {
    if (!compose) return;
    artState = 'uploading';
    artNote = 'Flattening your card…';
    renderPanel();
    try {
      const flat = await exportCompose(compose);
      // `art` — the imported picture, if there is one — is left alone: the
      // flattened card is a one-off carrier, not a replacement for their file.
      ownWork = true;
      await uploadArtFrom(flat, true);
    } catch (e) {
      artState = 'none';
      artNote = e instanceof ArtProblem ? e.message : 'That would not flatten. Try fewer stickers.';
      renderPanel();
    }
  }

  /* ── Sending for checking ──────────────────────────────────── */
  async function submit(): Promise<void> {
    const problem = whyNotReady();
    if (problem) { letter({ title: 'Nearly there', body: problem }); return; }
    if (!(await save(false))) return;
    if (!id) return;
    try {
      const d = await api.designSubmit(session, id);
      state = d.state || 'checking';
      letter({
        title: 'Sent for checking',
        body: 'We are reading your card now. When it passes, it appears in your collection in the app and you can start giving copies. If something is wrong, your phone will tell you what.',
        actions: [
          { label: 'See my designs', rose: true, onPick: () => { location.hash = '#/library'; } },
          { label: 'Stay here' },
        ],
      });
      renderPanel();
      refreshPreview();
    } catch (e) {
      letter({ title: 'Not sent', body: api.say(e) });
    }
  }

  function whyNotReady(): string | null {
    if (artState !== 'ok') return 'The art is not ready yet. Choose a picture or compose one, then send the art to be checked.';
    if (!title.trim()) return 'Give your card a title. It goes on the band, where the wearer’s name sits.';
    const w = windowProblem(win, band);
    if (w) return w;
    if (!Object.keys(intent).some((k) => intent[k])) return 'Say what this design is for: gifts, awards, or both.';
    return null;
  }

  /* ── The panel ─────────────────────────────────────────────── */

  /**
   * A labelled control.
   *
   * Every control here used to be nameless to assistive tech: the `<label>`
   * was a sibling with no `for`, and the input had no id and no aria-label, so
   * a screen reader read "edit text, blank" eleven times down the panel and
   * clicking the visible words focused nothing. The id is generated per field;
   * the hint, where there is one, is wired up as the description.
   *
   * `frozen` disables the control, because a design that has been sent cannot
   * be changed and a live-looking input that saves nothing is a lie.
   */
  let fieldSeq = 0;
  function field(label: string, control: Node, hint?: string): HTMLElement {
    const id = 'f' + (++fieldSeq);
    const hintNode = hint ? el('div', { class: 'muted small', id: id + 'h', text: hint }) : null;
    // A group of buttons (the paper chips, the choices) is not one control, so
    // it gets a group label rather than a `for` that would point at nothing.
    const single = control instanceof HTMLInputElement
      || control instanceof HTMLSelectElement
      || control instanceof HTMLTextAreaElement;
    if (single) {
      (control as HTMLElement).setAttribute('id', id);
      if (hintNode) (control as HTMLElement).setAttribute('aria-describedby', id + 'h');
      if (frozen) (control as HTMLInputElement).disabled = true;
    } else if (control instanceof HTMLElement) {
      control.setAttribute('role', 'group');
      control.setAttribute('aria-labelledby', id + 'l');
      if (hintNode) control.setAttribute('aria-describedby', id + 'h');
    }
    return el('div', { class: 'field' }, [
      el('label', { id: id + 'l', for: single ? id : undefined, text: label }),
      control,
      hintNode,
    ]);
  }

  /**
   * Every toggle and button in the panel carries a stable key, so that a
   * rebuild can put the keyboard back where it was.
   *
   * renderPanel() clears and rebuilds the whole panel and is called from every
   * toggle in it — the own-work tick, each paper chip, each sticker, each ink
   * swatch, the band choice, the intent choices. `el()` makes fresh nodes, so
   * the focused element was destroyed on every press: focus fell to <body>,
   * the new aria-pressed state was never announced, and a keyboard-only
   * creator had to tab back through the whole page to reach the next choice.
   */
  function keyed<T extends HTMLElement>(node: T, key: string): T {
    node.setAttribute('data-k', key);
    if (frozen && (node instanceof HTMLButtonElement || node instanceof HTMLInputElement)) node.disabled = true;
    return node;
  }

  function artBlock(): HTMLElement {
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (f) void takeFile(f);
      file.value = '';
    });
    const tick = el('input', { type: 'checkbox', id: 'ownwork' });
    (tick as HTMLInputElement).checked = ownWork;
    if (frozen) (tick as HTMLInputElement).disabled = true;
    tick.setAttribute('data-k', 'ownwork');
    tick.addEventListener('change', () => { ownWork = (tick as HTMLInputElement).checked; renderPanel(); });

    /*
     * The two art routes are kept side by side, not swapped.
     *
     * "Bring your own" used to set `compose = null` and "Compose one here"
     * revoked the imported picture — so ten minutes of stickers vanished the
     * moment somebody looked at the other tab, and the next autosave dropped
     * `layers` from the record as well. Both are held in `compose` and `art`
     * now; the tab only says which one is used, and the destructive case
     * (starting a composition over from a picture, which does need a blank
     * canvas) asks first.
     */
    const useTab = (wantCompose: boolean) => {
      if (wantCompose === !!composing) return;
      if (wantCompose && !compose) compose = newCompose();
      composing = wantCompose;
      selected = -1;
      twin.useCanvas(wantCompose);
      renderPanel();
      refreshPreview();
    };

    const box = el('div', { class: 'block' }, [
      el('h3', { text: '1. The art' }),
      el('div', { class: 'tabs' }, [
        keyed(el('button', {
          class: 'tab' + (!composing ? ' on' : ''), type: 'button', text: 'Bring your own',
          // Every other toggle in this panel says which it is; these two used
          // to signal it with colour alone.
          'aria-pressed': !composing ? 'true' : 'false',
          onclick: () => useTab(false),
        }), 'tab:own'),
        keyed(el('button', {
          class: 'tab' + (composing ? ' on' : ''), type: 'button', text: 'Compose one here',
          'aria-pressed': composing ? 'true' : 'false',
          onclick: () => useTab(true),
        }), 'tab:compose'),
      ]),
    ]);

    if (!composing) {
      box.appendChild(field('Your picture', file,
        'PNG or JPEG, standing up, at least ' + CARD_W + ' by ' + CARD_H + '. We redraw it here, which strips the file’s hidden details, and keep it under 1.5 MB.'));
      if (compose) {
        box.appendChild(el('p', { class: 'muted small', text: 'Your composed card is still here — the other tab has it.' }));
      }
      box.appendChild(el('label', { class: 'tickrow', for: 'ownwork' }, [
        tick,
        el('span', { class: 'tick', text: 'This is my own work.' }),
      ]));
      box.appendChild(el('p', { class: 'muted small', text: 'No characters, logos or artwork by anyone else, no QR codes or addresses, and no photographs of real people. A card carries the wearer’s own face in the window.' }));
      box.appendChild(el('div', { class: 'actions' }, [
        keyed(el('button', {
          class: 'btn rose', type: 'button', text: 'Use this art',
          disabled: frozen || !art || !ownWork || artState === 'uploading' || artState === 'checking',
          onclick: () => { void uploadArt(); },
        }), 'useart'),
      ]));
    } else {
      box.appendChild(composeBlock());
      box.appendChild(el('div', { class: 'actions' }, [
        keyed(el('button', {
          class: 'btn rose', type: 'button', text: 'Use this art',
          disabled: frozen || artState === 'uploading' || artState === 'checking',
          onclick: () => { void useComposed(); },
        }), 'useart'),
      ]));
    }

    // aria-live: this line changes by itself — "Sending your art…", then
    // "Checking your art", then "This art passed its checks" or "This art
    // cannot be used" — while somebody is looking at the card, so it was
    // never announced to anyone.
    if (artNote) {
      box.appendChild(el('p', {
        class: artState === 'refused' ? 'warn small' : 'muted small',
        role: 'status', 'aria-live': 'polite', text: artNote,
      }));
    }
    return box;
  }

  function stickerButton(key: string, label: string): HTMLElement {
    const c = el('canvas', { width: '44', height: '44', 'aria-hidden': 'true' });
    const g = (c as HTMLCanvasElement).getContext('2d');
    if (g) drawMotif(g, key, 22, 22, 34, 0, '#19150F', 1.6);
    return keyed(el('button', {
      class: 'sticker', type: 'button', 'aria-label': 'Add a ' + label.toLowerCase(),
      onclick: () => {
        if (!compose) return;
        if (compose.items.length >= 40) { toast('That is plenty of stickers.'); return; }
        // Step each new one along, or two in a row land exactly on top of each
        // other and the second looks like nothing happened.
        const n = compose.items.length;
        compose.items.push({
          x: Math.min(0.86, 0.34 + ((n * 7) % 9) * 0.06),
          y: Math.min(0.8, 0.28 + ((n * 5) % 7) * 0.07),
          key, size: 0.22, rot: 0, spot: -1,
        });
        selected = compose.items.length - 1;
        renderPanel();
        repaintCompose();
        queueSave();
      },
    }, [c, el('span', { class: 'visually-hidden', text: label })]), 'sticker:' + key);
  }

  function composeBlock(): HTMLElement {
    const c = compose as Compose;
    const papers = el('div', { class: 'papers' }, PAPER_ORDER.map((k: PaperKey) => {
      const p = PAPERS[k];
      return keyed(el('button', {
        class: 'paperchip' + (c.paper === k ? ' on' : ''),
        type: 'button',
        style: 'background:' + p.bg,
        'aria-label': p.label + ' — ' + p.blurb,
        'aria-pressed': c.paper === k ? 'true' : 'false',
        onclick: () => { c.paper = k; renderPanel(); repaintCompose(); queueSave(); },
      }, [el('span', { class: 'papername', text: p.label })]), 'paper:' + k);
    }));

    const words = el('input', { type: 'text', maxlength: '40', value: c.words, placeholder: 'A few words, or none' });
    keyed(words, 'words');
    words.addEventListener('input', () => {
      const had = !!c.words;
      c.words = (words as HTMLInputElement).value;
      // The "Where the words sit" slider only exists while there are words,
      // and it is only built by renderPanel() — which typing never called. So
      // the first word put a strip on the card with no way to move it until
      // somebody happened to touch a sticker or a paper chip. The slider is
      // always built now and simply disabled when there is nothing to move,
      // so the shape of the block never changes under the keyboard.
      if (had !== !!c.words) wordsY.disabled = !c.words;
      repaintCompose();
      queueSave();
    });

    const wordsY = el('input', { type: 'range', min: '5', max: '95', value: String(Math.round(c.wordsY * 100)) });
    keyed(wordsY, 'wordsy');
    wordsY.disabled = frozen || !c.words;
    wordsY.addEventListener('input', () => { c.wordsY = Number((wordsY as HTMLInputElement).value) / 100; repaintCompose(); queueSave(); });

    const box = el('div', {}, [
      field('Paper', papers, 'The same four papers the app draws. Yours is a flat picture of one, with your marks on it.'),
      el('div', { class: 'actions' }, [
        keyed(el('button', {
          class: 'btn', type: 'button', text: 'Shuffle the paper',
          onclick: () => { c.seed = Math.floor(Math.random() * 1e9) || 1; repaintCompose(); queueSave(); },
        }), 'shuffle'),
      ]),
      field('Stickers', el('div', { class: 'stickers' }, STICKERS.map((s) => stickerButton(s.key, s.label)))),
      field('Words on the paper', words, 'They sit on a cream strip, the way words always do here. Drag the strip with the slider below.'),
      field('Where the words sit', wordsY, 'Available once there are some words.'),
    ]);

    const it: Placed | undefined = selected >= 0 ? c.items[selected] : undefined;
    if (it) {
      const size = el('input', { type: 'range', min: '6', max: '90', value: String(Math.round(it.size * 100)) });
      keyed(size, 'size');
      size.addEventListener('input', () => { it.size = Number((size as HTMLInputElement).value) / 100; repaintCompose(); queueSave(); });
      const rot = el('input', { type: 'range', min: '-180', max: '180', value: String(Math.round(it.rot)) });
      keyed(rot, 'rot');
      rot.addEventListener('input', () => { it.rot = Number((rot as HTMLInputElement).value); repaintCompose(); queueSave(); });
      const inks = el('div', { class: 'inks' }, [-1, 0, 1, 2].map((s) => keyed(el('button', {
        class: 'ink' + (it.spot === s ? ' on' : ''),
        type: 'button',
        style: 'background:' + placedColour(c.paper, s),
        'aria-label': s < 0 ? 'The paper’s own ink' : 'Spot colour ' + (s + 1),
        'aria-pressed': it.spot === s ? 'true' : 'false',
        onclick: () => { it.spot = s; renderPanel(); repaintCompose(); queueSave(); },
      }), 'ink:' + s)));
      box.appendChild(el('div', { class: 'selbox' }, [
        el('h4', { text: 'The sticker you picked' }),
        el('p', { class: 'muted small', text: 'Drag it on the card. Nothing you place can leave the card.' }),
        field('Size', size),
        field('Turn', rot),
        field('Colour', inks),
        el('div', { class: 'actions' }, [
          keyed(el('button', {
            class: 'btn', type: 'button', text: 'Take it off',
            onclick: () => { c.items.splice(selected, 1); selected = -1; renderPanel(); repaintCompose(); queueSave(); },
          }), 'takeoff'),
        ]),
      ]));
    } else if (c.items.length) {
      box.appendChild(el('p', { class: 'muted small', text: 'Tap a sticker on the card to move it or change it.' }));
    }
    return box;
  }

  function cardBlock(): HTMLElement {
    const t = el('input', { type: 'text', maxlength: String(MAX_TITLE), value: title, placeholder: 'A quiet garden' });
    keyed(t, 'title');
    t.addEventListener('input', () => {
      title = (t as HTMLInputElement).value;
      twin.setTitle(title);
      thumb.setTitle(title);
      queueSave();
    });
    const l = el('input', { type: 'text', maxlength: String(MAX_LINE), value: line, placeholder: 'One line about it (optional)' });
    keyed(l, 'line');
    l.addEventListener('input', () => { line = (l as HTMLInputElement).value; queueSave(); });

    const bandPick = el('div', { class: 'twoup' }, (['bottom', 'top'] as Band[]).map((b) => keyed(el('button', {
      class: 'choice' + (band === b ? ' on' : ''),
      type: 'button',
      'aria-pressed': band === b ? 'true' : 'false',
      text: b === 'bottom' ? 'Band at the bottom' : 'Band at the top',
      onclick: () => { band = b; twin.setBand(b); win = twin.window(); renderPanel(); refreshPreview(); queueSave(); },
    }), 'band:' + b)));

    const ed = el('input', { type: 'number', min: '1', max: String(EDITION_MAX), value: String(editionMax) });
    keyed(ed, 'edition');
    ed.addEventListener('change', () => {
      editionMax = Math.max(1, Math.min(EDITION_MAX, Number((ed as HTMLInputElement).value) || EDITION_MAX));
      (ed as HTMLInputElement).value = String(editionMax);
      twin.setEdition(1, editionMax);
      thumb.setEdition(1, editionMax);
      queueSave();
    });

    const intents = el('div', { class: 'twoup' }, ([['gifts', 'For gifts'], ['awards', 'For awards']] as [string, string][]).map(([k, label]) => keyed(el('button', {
      class: 'choice' + (intent[k] ? ' on' : ''),
      type: 'button',
      'aria-pressed': intent[k] ? 'true' : 'false',
      text: label,
      onclick: () => { intent = { ...intent, [k]: !intent[k] }; renderPanel(); queueSave(); },
    }), 'intent:' + k)));

    return el('div', { class: 'block' }, [
      el('h3', { text: '2. The card' }),
      field('Title (the small caption under the wearer’s name)', t,
        'Up to ' + MAX_TITLE + ' characters. On the phone this is a small uppercase line under the wearer’s own name, and in list views it is dropped, so keep it short. No addresses, handles or numbers.'),
      field('A line about it', l, 'For your own library. It is not drawn on the card.'),
      field('Where the band sits', bandPick, 'The app draws the band itself, in house type on cream, so a name is always readable.'),
      field('The photo window', el('div', { class: 'actions' }, [
        keyed(el('button', {
          class: 'btn', type: 'button', text: 'Centre it',
          onclick: () => { win = defaultWindow(band); twin.setWindow(win); refreshPreview(); queueSave(); },
        }), 'centre'),
      ]), 'Drag the window on the card. The wearer’s own face goes there, so leave room for a face.'),
      field('Copies in the edition', ed, 'Twenty at the most, and that is the whole edition — for ever.'),
      field('What it is for', intents),
    ]);
  }

  let sendBtn: HTMLButtonElement | null = null;
  let saveBtn: HTMLButtonElement | null = null;
  let sendWarn: HTMLElement | null = null;
  let sendWords: HTMLElement | null = null;

  function refreshSend(): void {
    if (!sendBtn || !sendWarn || !sendWords || !saveBtn) return;
    const problem = whyNotReady();
    sendBtn.disabled = frozen || !!problem;
    saveBtn.disabled = frozen;
    const warn = frozen ? '' : unsaved
      ? 'Not saved — we’ll keep trying. Leave this page open.'
      : (problem || '');
    sendWarn.textContent = warn;
    sendWarn.hidden = !warn;
    sendWords.textContent = frozen
      // The server's own sentence, so the block says the same thing the save
      // would have said. A frozen editor has to explain itself somewhere.
      ? stateWords(state) + '. This one has been sent for checking, so it cannot be changed. '
        + 'Start a new design from it if you want a different version.'
      : 'Every design is read before anyone can be given one. It usually takes a few minutes. If something is wrong, your phone tells you what.';
    sendWords.className = frozen ? 'frozenwords' : 'muted';
  }

  function sendBlock(): HTMLElement {
    sendWords = el('p', {});
    // Live: "Not saved — we'll keep trying" has to reach somebody who is
    // looking at the card, not at this block.
    sendWarn = el('p', { class: 'warn small', role: 'status', 'aria-live': 'polite' });
    sendBtn = keyed(el('button', {
      class: 'btn rose big', type: 'button', text: 'Send for checking',
      onclick: () => { void submit(); },
    }), 'send');
    saveBtn = keyed(el('button', {
      class: 'btn', type: 'button', text: 'Save and come back later',
      onclick: () => { void save(true); },
    }), 'save');
    const box = el('div', { class: 'block' }, [
      el('h3', { text: '3. Send it for checking' }),
      sendWords,
      sendWarn,
      el('div', { class: 'actions' }, [
        sendBtn,
        saveBtn,
        el('a', { class: 'btn', href: '#/library', text: 'My designs' }),
      ]),
    ]);
    refreshSend();
    return box;
  }

  function renderPanel(): void {
    // Where the keyboard was, by key rather than by node: the nodes are all
    // about to be replaced.
    const here = document.activeElement as HTMLElement | null;
    const key = here && panel.contains(here) ? here.getAttribute('data-k') : null;

    frozen = state !== 'draft' && state !== 'refused';
    twin.lock(frozen);

    clear(panel);
    fieldSeq = 0;
    sendBtn = null; saveBtn = null; sendWarn = null; sendWords = null;
    panel.appendChild(artBlock());
    panel.appendChild(cardBlock());
    panel.appendChild(sendBlock());

    if (key) {
      const back = panel.querySelector('[data-k="' + key.replace(/"/g, '\\"') + '"]') as HTMLElement | null;
      if (back && !(back as HTMLButtonElement).disabled) {
        try { back.focus({ preventScroll: true }); } catch { back.focus(); }
      }
    }
  }

  /* ── Dragging stickers on the card ─────────────────────────── */
  {
    let dragging = -1;
    const at = (e: PointerEvent): { x: number; y: number } | null => {
      const r = twin.artCanvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    twin.artCanvas.addEventListener('pointerdown', (ev) => {
      const e = ev as PointerEvent;
      if (!composing || !compose || frozen) return;
      const p = at(e);
      if (!p) return;
      let best = -1;
      let bestD = Infinity;
      compose.items.forEach((it, i) => {
        const dx = (it.x - p.x) * CARD_W;
        const dy = (it.y - p.y) * CARD_H;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < (it.size * CARD_W) / 1.6 && d < bestD) { best = i; bestD = d; }
      });
      selected = best;
      dragging = best;
      renderPanel();
      repaintCompose();
      if (best >= 0) {
        twin.artCanvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    twin.artCanvas.addEventListener('pointermove', (ev) => {
      const e = ev as PointerEvent;
      if (dragging < 0 || !compose || frozen) return;
      const p = at(e);
      if (!p) return;
      const it = compose.items[dragging];
      it.x = Math.min(1, Math.max(0, p.x));
      it.y = Math.min(1, Math.max(0, p.y));
      repaintCompose();
    });
    const drop = (ev: Event) => {
      const e = ev as PointerEvent;
      if (dragging < 0) return;
      dragging = -1;
      twin.artCanvas.releasePointerCapture?.(e.pointerId);
      queueSave();
    };
    twin.artCanvas.addEventListener('pointerup', drop);
    twin.artCanvas.addEventListener('pointercancel', drop);
  }

  /* ── Load ──────────────────────────────────────────────────── */
  /**
   * `asset-state` never calls a checker, so this is free to ask: it costs no
   * part of the day's allowance and only ever reads a row this creator owns.
   */
  async function loadPreview(): Promise<void> {
    try {
      const s = await api.assetState(session, artAsset);
      if (isDead()) return;
      previewArt = s.preview || '';
      if (applyAssetState(s.state, s.reason) === 'checking') pollAsset();
    } catch {
      /* the card simply stays as it was; the phone is where a refusal is explained */
    }
  }

  async function load(): Promise<void> {
    if (!id) { renderPanel(); refreshPreview(); return; }
    try {
      const all = await api.designsList(session);
      const d = all.find((x) => x.id === id);
      if (!d) { toast('That design is not here any more.'); id = null; renderPanel(); refreshPreview(); return; }
      title = d.title;
      line = d.line;
      state = d.state;
      editionMax = d.editionMax || EDITION_MAX;
      intent = { gifts: d.intent.indexOf('gifts') >= 0, awards: d.intent.indexOf('awards') >= 0 };
      if (!intent.gifts && !intent.awards) intent.gifts = true;
      const doc = (d.doc || {}) as Record<string, unknown>;
      band = readBand(doc.band ?? d.band);
      win = readWindow(doc.window ?? (d.win.length === 4 ? { x: d.win[0], y: d.win[1], w: d.win[2], h: d.win[3] } : null), band);
      artAsset = typeof doc.art === 'string' ? doc.art : '';
      publicArt = d.art || '';
      compose = readCompose(d.layers);
      composing = !!compose;
      if (artAsset || publicArt) { artState = 'ok'; artNote = 'This art passed its checks.'; }
      renderPanel();
      refreshPreview();
      // A design that has not been published yet has no public picture, so the
      // card would come back blank. Ask the server where this creator's own
      // file is — a short signed look into their own inbox — and take the
      // art's real state while we are there, rather than assuming it passed.
      if (artAsset && !publicArt) void loadPreview();
    } catch (e) {
      if (e instanceof api.ApiError && (e.reason === 'unknown' || e.reason === 'closed')) sessionGoneLetter();
      else toast(api.say(e));
      renderPanel();
      refreshPreview();
    }
  }

  void load();

  return () => {
    if (saveTimer) window.clearTimeout(saveTimer);
    if (retryTimer) window.clearTimeout(retryTimer);
    stopAssetPoll();
    if (art) URL.revokeObjectURL(art.url);
    wrap.remove();
  };
}

/**
 * The app's words, verbatim.
 *
 * These are the same seven states, named twice, by one person, within a
 * minute: send a card on the laptop, pick up the phone to watch for it. The
 * website used to say "Checking" where the phone said "Being checked", and
 * "Waiting for a person" where the phone said "With our team". Nothing mapped
 * one to the other. `src/services/designs.ts` `designStateWords` is the
 * original; keep the two in step.
 */
export function stateWords(state: Design['state']): string {
  switch (state) {
    case 'checking': return 'Being checked';
    case 'awaiting_review': return 'With our team';
    case 'ready': return 'Ready to give';
    case 'live': return 'Out in the world';
    case 'refused': return 'Sent back';
    case 'retired': return 'Retired';
    case 'removed': return 'Taken down';
    default: return 'Not finished';
  }
}

/** The whole list of serials a design can reach, for the counts line. */
export function countWords(d: Design): string {
  const c = d.counts;
  if (!c) return '';
  const left = Math.max(0, (c.editionMax || d.editionMax || EDITION_MAX) - c.issued);
  const bits = [c.given + ' of ' + (c.editionMax || d.editionMax || EDITION_MAX) + ' given'];
  if (c.earned) bits.push(c.earned + ' earned');
  bits.push(left + ' left');
  return bits.join(' · ');
}

/** Exported so the library can show the same stamp shape the app enforces. */
export function stampOf(d: Design): Record<string, unknown> | null {
  if (!d.art || d.win.length !== 4) return null;
  return {
    copy: null,
    design: d.id,
    art: d.art,
    win: winArray({ x: d.win[0], y: d.win[1], w: d.win[2], h: d.win[3] }),
    band: d.band,
  };
}
