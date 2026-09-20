/**
 * The permanence page.
 *
 * This exists as a destination of its own, not a tab inside a menu, because it
 * is the answer to the objection that loses this product the most deals: "the
 * last company we used switched the tours off". An agency should be able to
 * send their director a link to this page.
 */

import { BUNDLE_CONTENTS, PERMANENCE_PROMISE, el, note, table, type BundleFile } from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { pageFrame, section } from '../shell.js';

export async function renderPermanence(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Permanence',
    lede: 'What happens to your properties if you stop paying us, or if we stop existing.',
  });

  const exports = await ctx.api.listExports().catch(() => []);

  frame.body.append(
    section('The short answer',
      undefined,
      note('ok', 'You keep them',
        'Every property can be exported as a bundle you own outright: the walkthrough, the world data, a true-to-scale floorplan, the 3D assets and a checksum for every file. It is a folder. It works by double-clicking a file in it.'),
      el('ul', { style: 'padding-left:20px;color:var(--ink-dim);max-width:70ch' },
        ...PERMANENCE_PROMISE.map((line) => el('li', {}, line))),
    ),

    section('Why this is not the normal arrangement',
      undefined,
      el('p', { style: 'max-width:74ch;color:var(--ink-dim)' },
        'Most property tour products are a hosted link. The scan is the agency’s in the sense that they paid for it, and nobody’s in the sense that they cannot hold it. When the contract ends, the link 404s and the work is gone — including the tours attached to listings that have already sold, which is the part that causes the arguments.'),
      el('p', { style: 'max-width:74ch;color:var(--ink-dim)' },
        'A bundle is the opposite arrangement. The file does not check a licence, an account or a subscription, because there is nothing in it that could. It is HTML, JSON, SVG and open 3D formats, and the viewer inside it makes no network calls at all.'),
    ),

    section('What is inside',
      'The same list the exporter writes, in the order it writes it.',
      table<BundleFile>({
        caption: `${BUNDLE_CONTENTS.length} entries`,
        columns: [
          { key: 'path', header: 'Path', render: (f) => el('span', { class: 'c-mono' }, f.path) },
          { key: 'what', header: 'What it is', render: (f) => f.what },
          { key: 'why', header: 'Why', render: (f) => el('span', { class: 'c-hint' }, f.why) },
        ],
        rows: BUNDLE_CONTENTS,
        rowKey: (f) => f.path,
      }),
    ),

    section('Where to get one',
      undefined,
      el('p', {},
        'Open any world version and use its Permanence bundle tab, or see ',
        el('a', {
          href: '#/exports',
          onclick: (e: Event) => { e.preventDefault(); ctx.navigate('#/exports'); },
        }, 'the bundles you have already built'),
        exports.length > 0 ? ` (${exports.length} so far).` : '.'),
      el('p', { class: 'c-hint' },
        'Build one for every property you publish. It costs nothing to keep and it is the only copy that is unambiguously yours.'),
    ),
  );

  return frame.root;
}
