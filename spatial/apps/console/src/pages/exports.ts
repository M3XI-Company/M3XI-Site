/**
 * Exports: the permanence bundle.
 *
 * This is the loudest thing this product does differently, so it is a
 * top-level destination and it is stated plainly rather than implied. The most
 * common complaint about incumbent property tours is that the tour dies with
 * the subscription — the agency paid for a scan, the link stopped working, and
 * the asset they thought they owned turned out to be a rental. The bundle is
 * the answer, and a customer should be able to read what it contains before
 * they download it.
 */

import {
  BUNDLE_CONTENTS, INLINE_EXPORT_BUDGET_BYTES, OMITTED_ASSET_LINK_TTL_HOURS, PERMANENCE_PROMISE,
  bytes as fmtBytes, button, can, dateTime, el, note, table, toast, willLinkAssets,
  type BundleFile, type ExportResult, type ExportRow, type OmittedAsset, type WorldDetail,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame, section } from '../shell.js';

export async function renderExports(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Exports',
    lede: 'Every permanence bundle this organisation has built. Each one is a complete, standalone copy of a property that works with no internet connection and no relationship with us.',
  });
  frame.body.appendChild(loading('your bundles'));

  try {
    const rows = await ctx.api.listExports();
    frame.body.replaceChildren(
      promisePanel(),
      section('Bundles built',
        'A download link is generated when you ask for one and lasts a day. The bundle itself is permanent; the link is not, which is why you are meant to keep the file.',
        table<ExportRow>({
          caption: `${rows.length} ${rows.length === 1 ? 'bundle' : 'bundles'}`,
          columns: [
            {
              key: 'world', header: 'World',
              render: (r) => el('a', {
                href: `#/world/${r.world_id}/export`,
                onclick: (e: Event) => { e.preventDefault(); ctx.navigate(`#/world/${r.world_id}/export`); },
              }, r.world_id),
            },
            { key: 'formats', header: 'Formats', render: (r) => el('span', { class: 'c-mono' }, r.formats.join(', ')) },
            { key: 'bytes', header: 'Size', numeric: true, render: (r) => fmtBytes(r.bytes) },
            {
              key: 'checksum', header: 'SHA-256',
              render: (r) => el('span', { class: 'c-mono', title: r.checksum ?? '' }, r.checksum ? `${r.checksum.slice(0, 12)}…` : '—'),
            },
            { key: 'created', header: 'Built', numeric: true, render: (r) => dateTime(r.created_at) },
            { key: 'downloaded', header: 'Downloaded', numeric: true, render: (r) => dateTime(r.downloaded_at) },
            {
              key: 'get', header: 'Download',
              render: (r) => button({
                label: 'Get a link',
                small: true,
                disabled: !can(ctx.role, 'export.download'),
                reason: 'Your role cannot download bundles.',
                onClick: () => void downloadBundle(ctx, r.id),
              }),
            },
          ],
          rows: [...rows],
          rowKey: (r) => r.id,
          empty: 'No bundles yet. Build one from any world version’s Permanence bundle tab.',
        }),
      ),
      contentsSection(),
    );
  } catch (err) {
    frame.body.replaceChildren(errorPanel(err));
  }
  return frame.root;
}

/** The permanence tab inside one world. */
export async function renderExportsFor(ctx: PageContext, detail: WorldDetail): Promise<HTMLElement> {
  const root = el('div', {});
  const result = el('div', {});

  // Not a warning about waiting — nothing waits. It is a warning about what
  // the zip will and will not contain, so that an assets folder with a
  // DOWNLOAD.md in it is expected rather than read as a broken export.
  const linkWarning = willLinkAssets(detail.assetBytes)
    ? note('info', 'Some of this will travel as a link, not inside the zip',
      `The assets for this world come to ${fmtBytes(detail.assetBytes)}, and the exporter can hold ${fmtBytes(INLINE_EXPORT_BUDGET_BYTES)} of them in memory at once. You still get the bundle immediately: whatever does not fit is listed inside it with a direct download link that lasts ${OMITTED_ASSET_LINK_TTL_HOURS} hours, and assets/DOWNLOAD.md explains it to the customer. The walkthrough, the floorplan and every measurement are in the zip either way.`)
    : null;

  root.append(
    promisePanel(),
    section('Build this property’s bundle',
      'A single zip containing everything needed to keep this property, forever, with no call back to us.',
      linkWarning,
      el('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:flex-start' },
        button({
          label: 'Build the bundle',
          emphasis: 'primary',
          disabled: !can(ctx.role, 'export.create') || detail.assetCount === 0,
          reason: detail.assetCount === 0
            ? 'There are no assets to package yet. Run a build first.'
            : `Your role (${ctx.role}) cannot build exports.`,
          onClick: async () => {
            result.replaceChildren(loading('the bundle'));
            try {
              const built = await ctx.api.createExport(detail.world.id);
              result.replaceChildren(renderResult(built));
              const linked = (built.omittedAssets ?? []).length;
              // A queued answer is a fault, not a success, and is never
              // toasted as one. See renderResult.
              if (built.queued) toast('No bundle was built. See the panel below.', 'bad');
              else if (linked > 0) toast(`Bundle built. ${linked} ${linked === 1 ? 'file travels' : 'files travel'} as a download link.`, 'ok');
              else toast('Bundle built.', 'ok');
            } catch (err) {
              result.replaceChildren(errorPanel(err));
            }
          },
        }),
      ),
      result,
    ),
    contentsSection(),
  );
  return root;
}

function renderResult(built: ExportResult): HTMLElement {
  // A current wv-export always returns the bundle. `queued` can only be true
  // if this console is talking to a deployment old enough to answer an
  // oversize property with a background job — and that job named a stage
  // wv-jobs never hands out, so it sat unclaimable and nothing was ever
  // packaged. Reporting it as "being packaged in the background" is precisely
  // the lie this page was fixed to stop telling, so it is reported as the
  // fault it is, loudly, instead of as a bundle on its way.
  if (built.queued) {
    return note('bad', 'No bundle was built',
      'The export service answered with a background job instead of a bundle. Nothing claims those jobs, so no file is coming and waiting will not produce one.',
      built.reason ? `It said: ${built.reason}` : null,
      'This deployment of wv-export is out of date. Update it and export again.');
  }
  const files = built.files ?? [];
  return el('div', {},
    note('ok', 'Built', `${fmtBytes(built.bytes ?? 0)}, ${files.length} files. SHA-256 ${built.checksum ?? '—'}.`),
    built.url
      ? el('p', {}, el('a', { href: built.url, download: '' }, 'Download the bundle'),
        el('span', { class: 'c-hint' }, ' — the link lasts a day; the bundle lasts as long as you keep it.'))
      : null,
    files.length > 0
      ? table({
        caption: 'What is in the zip',
        columns: [
          { key: 'path', header: 'File', render: (f: { path: string; bytes: number }) => el('span', { class: 'c-mono' }, f.path) },
          { key: 'bytes', header: 'Size', numeric: true, render: (f) => fmtBytes(f.bytes) },
        ],
        rows: files,
        rowKey: (f) => f.path,
      })
      : null,
    (built.omittedAssets ?? []).length > 0 ? omittedPanel(built.omittedAssets ?? []) : null,
  );
}

/**
 * The files that are not in the zip, and how to get hold of them.
 *
 * This is the part of the screen an operator has to be able to act on, because
 * they are the person who hands the customer everything. So the link is on the
 * page rather than only inside the bundle, the moment it dies is beside it in
 * the same row, and what to do afterwards is stated rather than left to be
 * discovered when a customer clicks a dead URL a week later.
 *
 * An asset with no link is shown as the absence it is. There is deliberately
 * no Download control here that does nothing: a button that cannot work is how
 * a console starts lying, and this whole page is an apology for the last time
 * that happened.
 */
function omittedPanel(omitted: readonly OmittedAsset[]): HTMLElement {
  const unlinked = omitted.filter((a) => !a.url).length;
  return note('warn', `Not inside this zip: ${omitted.length} ${omitted.length === 1 ? 'file' : 'files'}`,
    'Too large for the packager, or unreadable at export time. The bundle is complete without them — the world document, the floorplan and the viewer are self-contained and do not go looking for a file that is not beside them.',
    table<OmittedAsset>({
      caption: 'Download these separately',
      columns: [
        {
          key: 'role', header: 'Asset',
          render: (a) => (a.format ? `${a.role} (${a.format})` : a.role),
        },
        { key: 'bytes', header: 'Size', numeric: true, render: (a) => fmtBytes(a.bytes) },
        { key: 'reason', header: 'Why it is not in the zip', render: (a) => el('span', { class: 'c-hint' }, a.reason) },
        {
          key: 'checksum', header: 'SHA-256',
          // Truncated with the whole hash on hover, as the bundles table does.
          // It is here because a file fetched from a link still has to be
          // verifiable to the same standard as everything in CHECKSUMS.sha256.
          render: (a) => el('span', { class: 'c-mono', title: a.checksum ?? '' },
            a.checksum ? `${a.checksum.slice(0, 12)}…` : '—'),
        },
        {
          key: 'link', header: 'Download',
          render: (a) => (a.url
            ? el('a', { href: a.url, target: '_blank', rel: 'noopener' }, `Download the ${a.role}`)
            : el('span', { class: 'c-hint' }, 'No link could be issued')),
        },
        {
          key: 'expires', header: 'Link expires', numeric: true,
          render: (a) => (a.url ? dateTime(a.expiresAt) : '—'),
        },
      ],
      rows: [...omitted],
      rowKey: (a) => `${a.role}:${a.bytes}:${a.checksum ?? a.url ?? ''}`,
    }),
    el('p', { class: 'c-hint' }, `These links last ${OMITTED_ASSET_LINK_TTL_HOURS} hours from the export. Once one has lapsed, build the bundle again: a fresh export issues fresh links, and nothing is lost in between because the files themselves are not going anywhere. The same list, with the same links and expiries, is written into assets/DOWNLOAD.md inside the zip, so the customer has it whether or not they are looking at this screen.`),
    unlinked > 0
      ? el('p', { class: 'c-hint' }, `${unlinked} of ${omitted.length} ${unlinked === 1 ? 'has' : 'have'} no link at all — storage would not issue one, so ${unlinked === 1 ? 'that file' : 'those files'} cannot be handed over from here. Export again, and if it fails a second time, send the file to the customer directly.`)
      : null,
  );
}

export function promisePanel(): HTMLElement {
  // An h2: this panel sits directly under the page's h1, and an h3 there skips
  // a heading level.
  return el('div', { class: 'c-note c-note--ok', style: 'border-left-width:3px' },
    el('h2', { style: 'font-size:13px;margin:0 0 4px' }, 'Your tour does not die with your subscription'),
    el('p', {}, 'Every property can be exported as a bundle you own outright. It is yours to host, copy, modify and redistribute, and it keeps working whatever happens to us.'),
    el('ul', { style: 'margin:8px 0 0;padding-left:20px;color:var(--ink-dim)' },
      ...PERMANENCE_PROMISE.map((line) => el('li', {}, line))),
  );
}

function contentsSection(): HTMLElement {
  return section('What is inside a bundle',
    'Open formats only. Nothing in here needs our code to read it.',
    table<BundleFile>({
      caption: `${BUNDLE_CONTENTS.length} entries`,
      columns: [
        { key: 'path', header: 'Path', render: (f) => el('span', { class: 'c-mono' }, f.path) },
        { key: 'what', header: 'What it is', render: (f) => f.what },
        { key: 'why', header: 'Why it is there', render: (f) => el('span', { class: 'c-hint' }, f.why) },
      ],
      rows: BUNDLE_CONTENTS,
      rowKey: (f) => f.path,
    }),
    note('info', 'Verifying it years later',
      'Run `sha256sum -c CHECKSUMS.sha256` inside the folder. That is a standard tool on every Linux and macOS machine and needs nothing of ours, which is the point: you can prove the numbers were not edited after the fact without asking us anything.'),
  );
}

async function downloadBundle(ctx: PageContext, exportId: string): Promise<void> {
  try {
    const url = await ctx.api.signExportUrl(exportId);
    window.open(url, '_blank', 'noopener');
    toast('Link opened. Keep the file — the link expires, the bundle does not.', 'ok');
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'bad');
  }
}
