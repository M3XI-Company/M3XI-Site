import type { Narrative, NarrativeBlock } from '../text/narrative.js';
import type { FormattedQuantity } from '../measure/format.js';
import { clear, el } from './dom.js';

/**
 * Renders the written tour as an actual document: an `<article>` with a
 * heading hierarchy, a table of contents, and a "go to this room" control per
 * section. It is placed in the ordinary panel area, reachable by the ordinary
 * rail button and by a skip link at the very top of the viewer.
 *
 * This is the text alternative. It is not hidden behind a setting, and there
 * is no accessibility overlay widget anywhere in this product: research puts
 * the share of disabled users who find those effective at 2.4%, and they
 * routinely conflict with the assistive technology the user already has
 * configured. The accessible route through this viewer is the same route
 * everyone else takes.
 */
export function renderNarrative(
  host: HTMLElement,
  narrative: Narrative,
  onGoToRoom: (roomId: string) => void,
): void {
  clear(host);
  const article = el('article', { class: 'm3xi-tour' });

  article.appendChild(el('p', { text: narrative.lead }));

  const toc = el('ol', { class: 'm3xi-toc' });
  for (const section of narrative.sections) {
    if (section.level !== 2) continue;
    const link = el('a', { href: `#m3xi-sec-${section.id}`, text: section.heading });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = host.querySelector<HTMLElement>(`#m3xi-sec-${CSS.escape(section.id)}`);
      target?.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    });
    toc.appendChild(el('li', {}, [link]));
  }
  article.appendChild(el('nav', { 'aria-label': 'Sections of the written tour' }, [toc]));

  for (const section of narrative.sections) {
    const heading = el(section.level === 2 ? 'h2' : 'h3', {
      id: `m3xi-sec-${section.id}`,
      text: section.heading,
      tabindex: '-1',
    });
    article.appendChild(heading);

    if (section.roomId) {
      const go = el('button', {
        type: 'button',
        class: 'm3xi-goto',
        text: `Go to ${section.heading} in the 3D view`,
      });
      go.addEventListener('click', () => onGoToRoom(section.roomId!));
      article.appendChild(go);
    }

    for (const block of section.blocks) article.appendChild(renderBlock(block));
  }

  host.appendChild(article);
}

function renderBlock(block: NarrativeBlock): HTMLElement {
  switch (block.kind) {
    case 'paragraph':
      return el('p', { text: block.text });
    case 'list': {
      const wrap = el('div');
      if (block.intro) wrap.appendChild(el('p', { text: block.intro }));
      wrap.appendChild(el('ul', {}, block.items.map((i) => el('li', { text: i }))));
      return wrap;
    }
    case 'measurement':
      return quantityBlock(block.label, block.formatted);
    case 'note':
      return el('p', {
        class: 'm3xi-indicative',
      }, [
        el('strong', { text: block.tone === 'unsurveyed' ? 'Not surveyed. ' : 'Estimated. ' }),
        block.text,
      ]);
  }
}

/**
 * The single place a quantity becomes visible text. Value, tolerance and
 * standard are siblings in one element, so there is no way to render the
 * number and lose the rest of it: `aria-label` carries the spoken form, which
 * spells out the tolerance and the standard in full.
 */
export function quantityBlock(label: string, f: FormattedQuantity): HTMLElement {
  const wrap = el('div', {
    class: 'm3xi-quantity',
    role: 'group',
    'aria-label': `${label}. ${f.speech}`,
  });
  wrap.appendChild(el('span', { class: 'm3xi-q-label m3xi-sr', text: label }));
  wrap.appendChild(el('span', { class: 'm3xi-q-value' }, [
    f.value,
    ' ',
    el('span', { class: 'm3xi-q-tol', text: f.tolerance }),
  ]));
  wrap.appendChild(el('span', { class: 'm3xi-q-std', text: `${label} · ${f.standard}` }));
  if (f.status === 'indicative' && f.statusNote) {
    wrap.appendChild(el('p', { class: 'm3xi-indicative' }, [
      el('strong', { text: 'Indicative only. ' }),
      f.statusNote,
    ]));
  }
  return wrap;
}
