/**
 * Which property, and which version of it.
 *
 * Two lists and a warning. The warning is the interesting part: this screen
 * also shows walkthroughs still sitting on the phone that were never
 * registered — a walk whose upload was interrupted, or whose registration
 * failed — ABOVE the picker, because the single worst thing this app could do
 * is let somebody start a second capture while a first one they cannot get
 * back is still unsent.
 *
 * Properties with nothing to capture against are shown rather than filtered
 * out, with the reason. A property that silently vanishes from the list is how
 * an operator concludes it does not exist and drives home.
 */

import { button, el, focusHeading, note } from '../ui/dom.js';
import type { PropertyChoice, WorldChoice } from '../api/worlds.js';
import type { CaptureManifest } from '../store.js';

export interface PickScreen {
  readonly root: HTMLElement;
  focus(): void;
}

function versionLabel(world: WorldChoice): string {
  return `Version ${world.version}${world.latest ? ' (latest)' : ''} — ${world.status}`;
}

export function renderPick(options: {
  readonly choices: readonly PropertyChoice[];
  readonly truncated: boolean;
  readonly unfinished: readonly CaptureManifest[];
  readonly email: string;
  readonly onChoose: (property: PropertyChoice, world: WorldChoice) => void;
  readonly onResume: (manifest: CaptureManifest) => void;
  readonly onDiscard: (manifest: CaptureManifest) => void;
  readonly onSignOut: () => void;
}): PickScreen {
  const heading = el('h1', {}, 'Choose a property');
  const root = el('div', {}, heading);

  if (options.unfinished.length > 0) {
    const list = el('div', {});
    for (const manifest of options.unfinished) {
      const when = new Date(manifest.startedAt);
      list.appendChild(el('div', { class: 'c-note c-act' },
        el('strong', {}, `${manifest.propertyTitle}, version ${manifest.worldVersion}`),
        el('p', {},
          `Recorded ${when.toLocaleString('en-GB')} and never filed. It is still on this phone.`),
        el('div', { class: 'c-actions c-actions-row' },
          button({
            label: 'Finish sending it',
            emphasis: 'primary',
            onClick: () => options.onResume(manifest),
          }),
          button({
            label: 'Delete it',
            sublabel: 'Cannot be undone',
            onClick: () => options.onDiscard(manifest),
          }),
        ),
      ));
    }
    root.appendChild(el('section', { 'aria-labelledby': 'unfinished-h' },
      el('h2', { id: 'unfinished-h' }, 'Not yet sent'),
      el('p', {},
        'Send these before you start another walk. Once this phone is cleared or the app is '
        + 'reinstalled they are gone, and the only way back is another appointment.'),
      list,
    ));
  }

  const usable = options.choices.filter((c) => c.unavailable === null);
  const blocked = options.choices.filter((c) => c.unavailable !== null);

  if (options.choices.length === 0) {
    root.appendChild(note('advise',
      'This account can see no properties. Ask whoever runs your console to add the property and '
      + 'create a world for it, then reload this page.', 'Nothing to walk'));
  }

  if (usable.length > 0) {
    const list = el('ul', { style: 'list-style:none;padding:0;margin:0' });
    for (const choice of usable) {
      const id = `p-${choice.propertyId}`;
      const select = el('select', { class: 'c-select', id: `${id}-v`, 'aria-label': `Version of ${choice.title}` });
      for (const world of choice.worlds) {
        select.appendChild(el('option', { value: world.worldId }, versionLabel(world)));
      }
      list.appendChild(el('li', { style: 'margin:0 0 20px' },
        el('h2', { id, style: 'margin-top:0' }, choice.title),
        choice.subtitle ? el('p', { class: 'c-muted c-small' }, choice.subtitle) : null,
        choice.worlds.length > 1 ? select : el('p', { class: 'c-small c-muted' },
          versionLabel(choice.worlds[0]!)),
        el('div', { class: 'c-actions' },
          button({
            label: 'Walk this property',
            emphasis: 'primary',
            describedBy: id,
            onClick: () => {
              const chosen = choice.worlds.length > 1
                ? choice.worlds.find((w) => w.worldId === select.value) ?? choice.worlds[0]!
                : choice.worlds[0]!;
              options.onChoose(choice, chosen);
            },
          }),
        ),
      ));
    }
    root.appendChild(el('section', { 'aria-labelledby': 'usable-h' },
      el('h2', { id: 'usable-h' }, 'Ready to walk'),
      list,
    ));
  }

  if (blocked.length > 0) {
    const list = el('ul', {});
    for (const choice of blocked) {
      list.appendChild(el('li', {}, el('strong', {}, choice.title), ' — ', choice.unavailable ?? ''));
    }
    root.appendChild(el('section', { 'aria-labelledby': 'blocked-h' },
      el('h2', { id: 'blocked-h' }, 'Cannot be walked from here'),
      list,
    ));
  }

  if (options.truncated) {
    root.appendChild(note('advise',
      'Only the most recent properties are listed. If the one you are standing outside is not '
      + 'here, it exists but is further down the portfolio than this phone will load — ask the '
      + 'office to archive what is finished.', 'The list is capped'));
  }

  root.appendChild(el('footer', { style: 'margin-top:32px' },
    el('p', { class: 'c-small c-muted' }, `Signed in as ${options.email}.`),
    button({ label: 'Sign out', emphasis: 'quiet', onClick: options.onSignOut }),
  ));

  return { root, focus: () => focusHeading(heading) };
}
