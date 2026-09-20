/**
 * Sending it.
 *
 * A progress bar and four sentences, and the four sentences are the reason the
 * screen exists. A 1.7-3.8 GB upload from a property with one bar takes long
 * enough that an operator will put the phone in a pocket, walk to a car, and
 * drive — and every one of those actions ends it. So the screen says what is
 * happening, what will happen if they leave, and what is safe to do.
 *
 * It also never claims to be finished before `register_capture` has answered.
 * Bytes in a bucket with no row naming them are bytes the pipeline will never
 * read: `wv_capture` is what ingest looks at, and until the row exists the
 * walkthrough is, for every practical purpose, lost. So the two steps are
 * shown as two steps, and "sent" means both.
 */

import { button, byteText, el, focusHeading, note } from '../ui/dom.js';

export type UploadPhase = 'preparing' | 'sending' | 'registering' | 'done' | 'failed' | 'waiting';

export interface UploadScreen {
  readonly root: HTMLElement;
  focus(): void;
  progress(sent: number, total: number, chunksLeft: number): void;
  phase(phase: UploadPhase, detail?: string): void;
  /** Shown when the uploader is backing off, so a pause is not a hang. */
  retrying(inMs: number, because: string): void;
  succeeded(captureId: string, duplicate: boolean): void;
  failed(message: string): void;
}

export function renderUpload(options: {
  readonly propertyTitle: string;
  readonly worldVersion: number;
  readonly totalBytes: number;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onFinish: () => void;
  readonly onDiscard: () => void;
}): UploadScreen {
  const heading = el('h1', {}, 'Sending the walkthrough');

  const bar = el('div', { class: 'c-progress-fill', style: 'width:0%' });
  const meter = el('div', {
    class: 'c-progress',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
    'aria-label': 'Upload progress',
  }, bar);

  const figure = el('p', { class: 'c-progress-text' }, `0 of ${byteText(options.totalBytes)}`);
  const status = el('p', { role: 'status', 'aria-live': 'polite' }, 'Getting ready.');
  const outcome = el('div', {});

  const actions = el('div', { class: 'c-actions' },
    button({ label: 'Stop sending', emphasis: 'quiet', onClick: options.onCancel }),
  );

  const root = el('div', {},
    heading,
    el('p', { class: 'c-muted' }, `${options.propertyTitle}, version ${options.worldVersion}.`),
    meter,
    figure,
    status,
    outcome,
    note('info',
      'Stay on this screen with it plugged in if you can. If it stops — you lose signal, the '
      + 'phone locks, the tab closes — nothing is lost: it starts again from where it stopped, '
      + 'not from the beginning. Do not clear this browser until it says the capture is filed.'),
    actions,
  );

  const setPercent = (value: number): void => {
    const pct = Math.max(0, Math.min(100, value));
    bar.setAttribute('style', `width:${pct.toFixed(1)}%`);
    meter.setAttribute('aria-valuenow', String(Math.round(pct)));
  };

  return {
    root,
    focus: () => focusHeading(heading),

    progress(sent: number, total: number, chunksLeft: number): void {
      setPercent(total > 0 ? (sent / total) * 100 : 0);
      figure.textContent = `${byteText(sent)} of ${byteText(total)}`
        + (chunksLeft > 0 ? ` — ${chunksLeft} piece${chunksLeft === 1 ? '' : 's'} to go` : '');
    },

    phase(phase: UploadPhase, detail?: string): void {
      const words: Record<UploadPhase, string> = {
        preparing: 'Checking what is already on the server.',
        sending: 'Sending. This can take a while on a weak signal.',
        registering: 'Filing the capture against the property.',
        done: 'Filed.',
        failed: 'Stopped.',
        waiting: 'Waiting for a connection.',
      };
      status.textContent = detail ? `${words[phase]} ${detail}` : words[phase];
    },

    retrying(inMs: number, because: string): void {
      status.textContent = `${because} Trying again in ${Math.round(inMs / 1000)} seconds. `
        + 'Nothing already sent has been lost.';
    },

    succeeded(captureId: string, duplicate: boolean): void {
      setPercent(100);
      actions.replaceChildren(
        button({ label: 'Done', emphasis: 'primary', onClick: options.onFinish }),
        button({
          label: 'Delete the recording from this phone',
          sublabel: 'The copy on the server is the one that matters now',
          emphasis: 'quiet',
          onClick: options.onDiscard,
        }),
      );
      outcome.replaceChildren(note('ok',
        duplicate
          // Not an error, and saying so matters: the server is deliberately
          // idempotent so that a retry from a doorstep cannot make a second
          // row, and an operator who is told "already filed" has been told
          // something true rather than something alarming.
          ? `This walkthrough was already filed — capture ${captureId}. The retry found the first `
            + 'one rather than making a duplicate, which is exactly what should happen.'
          : `Filed as capture ${captureId}. It is safe to leave the property.`,
        'The walkthrough is on the server'));
      status.textContent = 'Filed.';
    },

    failed(message: string): void {
      outcome.replaceChildren(note('act', message, 'It did not finish'));
      actions.replaceChildren(
        button({ label: 'Try again', emphasis: 'primary', onClick: options.onRetry }),
        button({ label: 'Stop for now', emphasis: 'quiet', onClick: options.onCancel }),
      );
      // Focus moves to the failure, because this is the one moment where an
      // operator walking away without reading costs the appointment.
      const first = outcome.querySelector('p');
      if (first) { first.setAttribute('tabindex', '-1'); (first as HTMLElement).focus(); }
    },
  };
}
