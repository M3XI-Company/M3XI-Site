/**
 * The go / no-go, before they leave the property.
 *
 * This is the screen the whole app exists for. A walkthrough that fails costs
 * a second appointment, getting back into a vendor's flat is days and
 * sometimes never, and the pipeline does not find out until thirty-five
 * GPU-minutes and about $0.74 after the upload — by which time the operator is
 * three properties away. Everything measured during the walk is here so the
 * decision can be made while they are still in the hall with their shoes on.
 *
 * FOUR RULES ABOUT HOW IT IS RENDERED.
 *
 *   PLAINLY. Every finding shows the check it predicts, what was measured,
 *   what the threshold is, and the action — the four things `VerdictFinding`
 *   carries. No summarising, no "looks good", no score out of ten. The
 *   operator is comparing a number against a threshold on the next line, not
 *   admiring it.
 *
 *   WHAT COULD NOT BE JUDGED IS NAMED. `NOT_ASSESSABLE_ON_DEVICE` is nine
 *   checks and it is the majority of quality.py's gate. Hiding it would make
 *   four checks look like a verdict, and an operator who believes that stops
 *   looking. It is on the page, under its own heading, with the reason for
 *   each.
 *
 *   THE FIGURES ARE THE LIBRARY'S. `verdictFigures` produces them; this screen
 *   prints them in order and computes none of its own.
 *
 *   A FIX OR A NO-GO OFFERS THE WAY BACK. The failing rooms are listed and
 *   there is a button to walk them again, because the only moment that offer
 *   is worth anything is this one.
 */

import {
  NOT_ASSESSABLE_ON_DEVICE, verdictFigures,
  type VerdictFinding, type VerdictInput, type VerdictReport,
} from '@m3xi/capture-core';
import { button, el, focusHeading } from '../ui/dom.js';
import { figureFor } from '../display.js';

export interface VerdictScreen {
  readonly root: HTMLElement;
  focus(): void;
}

/**
 * The banner word says what to DO; the library's headline says why.
 *
 * They are deliberately different sentences. `buildVerdict` already writes a
 * good one-line summary and it opens "Do not leave yet" for a no-go, so a
 * banner reading the same words would print the same instruction twice in two
 * sizes — which is how an operator learns that the big text is decoration and
 * stops reading it.
 */
const VERDICT_WORD = {
  go: 'Good to leave',
  fix: 'Leave, but it needs work',
  no_go: 'Walk it again before you leave',
} as const;

const SEVERITY_WORD = {
  blocking: 'Stops the build',
  review: 'Sends it for correction',
  note: 'Worth knowing',
} as const;

function findingBlock(finding: VerdictFinding): HTMLElement {
  return el('li', { class: `c-finding c-finding-${finding.severity}`, style: 'list-style:none' },
    el('h3', {}, SEVERITY_WORD[finding.severity]),
    el('p', {}, finding.action),
    el('p', { class: 'c-measure' }, figureFor(finding)),
    el('p', { class: 'c-measure' }, `Check: ${finding.check}`),
  );
}

export function renderVerdict(options: {
  readonly report: VerdictReport;
  readonly input: VerdictInput;
  readonly onUpload: () => void;
  readonly onWalkAgain: () => void;
  readonly onDiscard: () => void;
}): VerdictScreen {
  const { report, input } = options;
  const heading = el('h1', {}, 'Before you leave');

  const blocking = report.findings.filter((f) => f.severity === 'blocking');
  const review = report.findings.filter((f) => f.severity === 'review');
  const notes = report.findings.filter((f) => f.severity === 'note');

  const banner = el('section', {
    class: `c-verdict-banner c-verdict-${report.verdict}`,
    'aria-labelledby': 'verdict-h',
  },
  el('h2', { id: 'verdict-h' }, VERDICT_WORD[report.verdict]),
  el('p', {}, report.headline),
  );

  const root = el('div', {}, heading, banner);

  if (report.findings.length > 0) {
    const list = el('ul', { style: 'padding:0;margin:0' });
    for (const finding of [...blocking, ...review, ...notes]) list.appendChild(findingBlock(finding));
    root.appendChild(el('section', { 'aria-labelledby': 'findings-h' },
      el('h2', { id: 'findings-h' }, `What was found (${report.findings.length})`),
      list,
    ));
  }

  // The rooms to redo, named, because "walk it again" without a list is an
  // instruction to walk the whole property again.
  const untouched = input.coverage.rooms.filter((r) => r.state === 'not_started');
  const thin = input.coverage.rooms.filter((r) => r.state === 'thin');
  const nameOf = (id: string): string => input.rooms.find((r) => r.id === id)?.name ?? id;

  if (report.verdict !== 'go') {
    const list = el('ul', {});
    for (const room of untouched) {
      list.appendChild(el('li', {}, el('strong', {}, nameOf(room.roomId)), ' — never filmed.'));
    }
    for (const room of thin) {
      list.appendChild(el('li', {},
        el('strong', {}, nameOf(room.roomId)), ' — ', room.gaps[0] ?? 'thin coverage.'));
    }
    root.appendChild(el('section', { 'aria-labelledby': 'redo-h' },
      el('h2', { id: 'redo-h' }, 'What to walk again'),
      untouched.length + thin.length > 0
        ? list
        : el('p', {}, 'No single room is short. What is listed above is about technique across '
          + 'the whole walk rather than about one place.'),
      el('div', { class: 'c-actions' },
        button({
          label: 'Walk the property again',
          sublabel: 'Keeps this recording as well',
          emphasis: report.verdict === 'no_go' ? 'primary' : 'secondary',
          onClick: options.onWalkAgain,
        }),
      ),
    ));
  }

  root.appendChild(el('section', { 'aria-labelledby': 'figures-h' },
    el('h2', { id: 'figures-h' }, 'The numbers'),
    el('ul', { class: 'c-figures' },
      ...verdictFigures(input, report).map((line) => el('li', {}, line))),
  ));

  root.appendChild(el('details', {},
    el('summary', {}, `What this phone could not check (${NOT_ASSESSABLE_ON_DEVICE.length})`),
    el('p', { class: 'c-small' },
      'The quality gate has twelve checks. This phone can predict the capture-side ones and none '
      + 'of the reconstruction-side ones, so a clear result above is not a clear result overall. '
      + 'These are judged after the upload, on a GPU.'),
    el('ul', {}, ...NOT_ASSESSABLE_ON_DEVICE.map((n) =>
      el('li', {}, el('strong', {}, n.check), ' — ', n.why))),
  ));

  root.appendChild(el('div', { class: 'c-actions' },
    button({
      label: report.verdict === 'no_go' ? 'Send it anyway' : 'Send it',
      sublabel: report.verdict === 'no_go'
        ? 'The build will fail, and the recording is kept either way'
        : undefined,
      emphasis: report.verdict === 'no_go' ? 'secondary' : 'primary',
      onClick: options.onUpload,
    }),
    button({
      label: 'Delete this recording',
      sublabel: 'Cannot be undone',
      emphasis: 'quiet',
      onClick: options.onDiscard,
    }),
  ));

  return { root, focus: () => focusHeading(heading) };
}
