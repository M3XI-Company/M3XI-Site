/**
 * The walking screen.
 *
 * WHAT IS BIGGEST IS WHAT THEY NEED. The cue headline is two or three words
 * and it is set at up to 4.5rem, because it is read at arm's length by
 * somebody who is moving. Its detail sentence sits underneath at body size —
 * `Cue` draws that distinction deliberately and this screen honours it.
 * Everything else is smaller than the cue: the timer, the room chips, the
 * confidence strip.
 *
 * THERE IS NO FLOORPLAN. A browser has no position. `DeviceMotionEvent` gives
 * linear acceleration and integrating it twice is metres out inside three
 * seconds, so a plan that filled itself in would drift, and an operator would
 * believe it. The model of where somebody is, is the chip they last tapped.
 *
 * THE DIAL IS ABSENT WHERE THERE IS NO GYRO. `DeviceOrientationEvent` needs a
 * user gesture on iOS and is missing or useless on plenty of Android
 * browsers. When no sample has arrived, no dial is drawn and a line says the
 * device is not reporting it. A dial stuck at north is a measurement that is
 * not being made, drawn as though it were.
 *
 * THE TWO DECLARE BUTTONS ARE THE MOST VALUABLE CONTROLS HERE. Mirrors invent
 * phantom rooms and glazing blows out; they are the two named reconstruction
 * failure modes, and `reflective.py` needs depth, an open-vocabulary detector
 * or the finished reconstruction to find either — none of which exists on a
 * phone. `mirrorCapabilityStatement()` says so in the analyser's own words
 * under the buttons. One tap from the operator supplies what the device
 * cannot measure, which is why they are 72px and side by side under the
 * thumb.
 */

import type { DeclaredSurface } from '@m3xi/capture-core';
import { button, clockText, el } from '../ui/dom.js';
import type { LiveView, RoomChip } from '../display.js';

export interface LiveHandles {
  readonly root: HTMLElement;
  /** The preview video goes behind everything; the screen owns its position. */
  mountPreview(video: HTMLVideoElement): void;
  update(view: LiveView, chips: readonly RoomChip[], elapsedS: number): void;
  /** A failure that does not stop the recording: shown, not thrown away. */
  showProblem(message: string): void;
}

const TONE_CLASS = { act: 'c-cue-act', advise: 'c-cue-advise', ok: 'c-cue-ok' } as const;

/**
 * The yaw dial.
 *
 * Twelve bins, drawn as twelve segments of a ring, plus a needle at the
 * current heading. Radians, right-handed, +Y up: capture-core reports yaw
 * increasing clockwise viewed from above, and the SVG rotation below matches
 * that, so a physical quarter-turn right moves the needle a quarter-turn
 * clockwise.
 *
 * `aria-hidden` on the drawing with a text equivalent beside it, because "a
 * ring with seven of twelve segments filled" is not something to read out;
 * "seen 7 of 12 directions in this room" is.
 */
function dial(yaw: number, bins: readonly boolean[]): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '54');
  svg.setAttribute('height', '54');
  svg.setAttribute('viewBox', '-30 -30 60 60');
  svg.setAttribute('aria-hidden', 'true');
  const count = Math.max(1, bins.length);
  for (let i = 0; i < count; i += 1) {
    const from = (i / count) * Math.PI * 2 - Math.PI / 2;
    const to = ((i + 1) / count) * Math.PI * 2 - Math.PI / 2;
    const path = document.createElementNS(ns, 'path');
    const r = 24;
    const x0 = Math.cos(from) * r;
    const y0 = Math.sin(from) * r;
    const x1 = Math.cos(to) * r;
    const y1 = Math.sin(to) * r;
    path.setAttribute('d', `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', bins[i] ? '#86d6a3' : 'rgba(247,246,244,0.35)');
    path.setAttribute('stroke-width', '7');
    svg.appendChild(path);
  }
  const needle = document.createElementNS(ns, 'line');
  needle.setAttribute('x1', '0');
  needle.setAttribute('y1', '0');
  needle.setAttribute('x2', '0');
  needle.setAttribute('y2', '-15');
  needle.setAttribute('stroke', '#f7f6f4');
  needle.setAttribute('stroke-width', '3');
  needle.setAttribute('transform', `rotate(${((yaw * 180) / Math.PI).toFixed(1)})`);
  svg.appendChild(needle);
  return svg;
}

export function renderLive(options: {
  readonly onDeclare: (kind: DeclaredSurface) => void;
  readonly onEnterRoom: (roomId: string) => void;
  readonly onFinish: () => void;
  readonly announce: (text: string) => void;
}): LiveHandles {
  const preview = el('div', { class: 'c-preview-holder' });

  const elapsed = el('span', { class: 'c-elapsed' }, '0:00');
  const confidence = el('p', { class: 'c-confidence' });
  const problem = el('div', { role: 'alert' });

  const top = el('div', { class: 'c-live-top' },
    el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px' },
      el('span', {}, el('span', { class: 'c-sr-only' }, 'Recording time '), elapsed),
    ),
    confidence,
    problem,
  );

  const headline = el('p', { class: 'c-cue-headline' }, 'Starting');
  const detail = el('p', { class: 'c-cue-detail' },
    'The analyser is warming up. Walk into the first room and tap it below.');
  // NOT a live region. The cue is rewritten on every analysed frame, ten times
  // a second, and an `aria-live` node that changes at that rate makes a screen
  // reader unusable: it never finishes a sentence. The announcement goes
  // through the single polite region in `announcer()`, which speaks only when
  // the headline actually changes.
  const cueBlock = el('div', { class: 'c-cue c-cue-ok' }, headline, detail);

  const chipList = el('ul', { class: 'c-chips' });
  const dialHolder = el('div', { class: 'c-dial' });

  const declare = el('div', { class: 'c-declare' },
    button({
      label: 'Mirror in shot',
      sublabel: 'Tap as you pass one',
      onClick: () => { options.onDeclare('mirror'); options.announce('Mirror recorded.'); },
    }),
    button({
      label: 'Window in shot',
      sublabel: 'Or a glass door',
      onClick: () => { options.onDeclare('glazing'); options.announce('Window recorded.'); },
    }),
  );

  const bottom = el('div', { class: 'c-live-bottom' },
    // A heading, for structure rather than for sight. Every other screen has a
    // visible h1; this one cannot spare the space, and a screen with an h2 and
    // no h1 is a screen a heading-navigation user cannot enter.
    el('h2', { class: 'c-sr-only' }, 'Where you are'),
    el('nav', { 'aria-label': 'Rooms' }, chipList),
    dialHolder,
    declare,
    // One line here; the full capability statement is on the planning screen,
    // where there is time to read four sentences. A walking screen carrying
    // the whole paragraph pushes the cue off the bottom of a phone, and the
    // cue is the thing they are walking by.
    el('p', { class: 'c-small', style: 'margin:6px 0 0;color:#ded9d2' },
      'This phone cannot see mirrors or glass. Tapping is the only way they get recorded.'),
    el('div', { class: 'c-live-controls' },
      button({
        label: 'Television',
        sublabel: 'Reflects like a mirror',
        onClick: () => { options.onDeclare('television'); options.announce('Television recorded.'); },
      }),
      button({
        label: 'Finish the walk',
        emphasis: 'danger',
        onClick: options.onFinish,
      }),
    ),
  );

  const root = el('div', { class: 'c-live' },
    // The one h1 on this screen, and it is invisible: the cue is the largest
    // thing here and it is a paragraph, not a heading, because it is replaced
    // ten times a second and a heading that changes at that rate makes
    // heading navigation useless. So the structure gets a stable title and the
    // cue gets the type size.
    el('h1', { class: 'c-sr-only' }, 'Recording the walkthrough'),
    preview, top, cueBlock, bottom);

  let lastHeadline = '';
  let renderedChips = '';

  return {
    root,
    mountPreview(video: HTMLVideoElement): void {
      preview.replaceChildren(video);
    },
    showProblem(message: string): void {
      problem.replaceChildren(el('p', { class: 'c-small', style: 'color:#ff9b8d;margin:6px 0 0' }, message));
    },
    update(view: LiveView, chips: readonly RoomChip[], elapsedS: number): void {
      elapsed.textContent = clockText(elapsedS);

      headline.textContent = view.headline;
      detail.textContent = view.detail;
      cueBlock.className = `c-cue ${TONE_CLASS[view.tone]}`;
      // Announced only when it CHANGES. A live region that repeats the same
      // three words ten times a second is a live region people turn off.
      if (view.headline !== lastHeadline) {
        lastHeadline = view.headline;
        options.announce(`${view.headline}. ${view.detail}`);
      }

      confidence.className = `c-confidence c-confidence-${view.confidence.tone}`;
      confidence.replaceChildren(
        el('b', {}, view.confidence.label),
        el('span', { class: 'c-small' }, view.confidence.detail),
      );

      // Chips are rebuilt only when something about them changed: replacing
      // focusable nodes under a thumb that is mid-tap is how a tap lands on
      // the wrong room.
      const signature = chips.map((c) => `${c.roomId}:${c.state}:${c.current}`).join('|');
      if (signature !== renderedChips) {
        renderedChips = signature;
        chipList.replaceChildren(...chips.map((chip) => el('li', {},
          el('button', {
            type: 'button',
            class: 'c-chip',
            'aria-pressed': chip.current ? 'true' : 'false',
            'aria-label': chip.label,
            onclick: () => options.onEnterRoom(chip.roomId),
          },
          el('span', {}, chip.name),
          ' ',
          el('span', { class: 'c-chip-state', 'aria-hidden': 'true' },
            chip.state === 'done' ? 'done' : chip.state === 'thin' ? 'thin' : 'to do'),
          ),
        )));
      }

      if (view.yaw === null) {
        dialHolder.replaceChildren(el('p', { class: 'c-small', style: 'margin:0;color:#ded9d2' },
          'This device reports no compass, so turning and walking cannot be told apart. '
          + 'Walk the walls rather than turning on the spot.'));
      } else {
        const seen = view.yaw.bins.filter(Boolean).length;
        dialHolder.replaceChildren(
          dial(view.yaw.yaw, view.yaw.bins),
          el('p', { class: 'c-small', style: 'margin:0;color:#ded9d2' },
            view.yaw.bins.length === 0
              ? 'Tap the room you are in to start measuring what you have faced.'
              : `Faced ${seen} of ${view.yaw.bins.length} directions in this room`
                + `${view.yaw.absolute ? '' : ' (no north reference on this device)'}.`),
        );
      }
    },
  };
}
