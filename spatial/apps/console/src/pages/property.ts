/**
 * One property: its address, its reference, and the history of its world
 * versions.
 *
 * A rescan makes a new version and never destroys the old one, because someone
 * acted on what the old one showed and may need to prove what that was. So
 * this page is a history, not a "current state", and it answers three
 * questions: which version is live, what each version was assessed as, and
 * what actually changed between any two of them.
 */

import {
  bytes as fmtBytes, button, can, confirm, dateTime, diffWorlds, el, facts, note, percent, pill,
  table, toast, verdictPill, worldStatusPill, type PropertyRow, type WorldDiff, type WorldSummary,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame, section } from '../shell.js';

export async function renderProperty(ctx: PageContext): Promise<HTMLElement> {
  const propertyId = ctx.route.params[0];
  const frame = pageFrame({
    title: 'Property',
    crumbs: [{ label: 'Portfolio', href: '#/portfolio' }, { label: 'Property' }],
  });
  frame.body.appendChild(loading('this property'));

  if (!propertyId) {
    frame.body.replaceChildren(note('bad', 'No property', 'That link is missing a property id.'));
    return frame.root;
  }

  let property: PropertyRow;
  try {
    property = await ctx.api.getProperty(propertyId);
  } catch (err) {
    frame.body.replaceChildren(errorPanel(err));
    return frame.root;
  }

  frame.heading.textContent = property.label;
  const live = property.worlds.find((w) => w.status === 'published') ?? null;
  const latest = property.worlds[0] ?? null;

  const headerActions: HTMLElement[] = [
    button({
      label: 'New version from a capture',
      emphasis: 'primary',
      disabled: !can(ctx.role, 'world.create'),
      reason: `Your role (${ctx.role}) cannot start a new version.`,
      onClick: () => void newVersion(),
    }),
  ];
  if (latest) {
    headerActions.push(button({
      label: 'Open latest version',
      onClick: () => ctx.navigate(`#/world/${latest.id}`),
    }));
  }
  frame.actions.replaceChildren(...headerActions);

  async function newVersion(): Promise<void> {
    const ok = await confirm({
      title: 'Start a new version?',
      body: [
        'A new version is created as a draft. Nothing is published and nothing is overwritten: the current version stays live until you publish the new one.',
        'The capture is uploaded from the capture app, and the build is started from the new version’s Build tab.',
      ],
      confirmLabel: 'Create version',
    });
    if (!ok) return;
    try {
      const created = await ctx.api.createWorld(property.id);
      toast(`Version ${created.version} created.`, 'ok');
      ctx.navigate(`#/world/${created.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  const address = property.address as Record<string, unknown>;
  const details = section('Details', undefined,
    facts([
      ['Address', property.label],
      ['Postcode', property.postcode ?? '—'],
      ['Your reference', el('span', { class: 'c-mono' }, property.ref ?? '—')],
      ['Type', typeof address['kind'] === 'string' ? address['kind'] : '—'],
      ['Bedrooms', typeof address['bedrooms'] === 'number' ? String(address['bedrooms']) : '—'],
      ['Added', dateTime(property.created_at)],
      ['Live version', live ? el('span', {}, `v${live.version}`) : el('span', { class: 'c-hint' }, 'Nothing live')],
      ['Public link', live?.slug ? el('span', { class: 'c-mono' }, `/${live.slug}`) : '—'],
    ]),
  );

  const versions = section(
    'Version history',
    'Every rescan is kept. The old version is never destroyed, because someone acted on what it showed.',
    table<WorldSummary>({
      caption: `${property.worlds.length} ${property.worlds.length === 1 ? 'version' : 'versions'}`,
      columns: [
        {
          key: 'version', header: 'Version', numeric: true,
          render: (w) => el('a', {
            href: `#/world/${w.id}`,
            onclick: (e: Event) => { e.preventDefault(); ctx.navigate(`#/world/${w.id}`); },
          }, `v${w.version}`),
        },
        { key: 'status', header: 'Status', render: (w) => worldStatusPill(w.status) },
        {
          key: 'live', header: 'Live',
          render: (w) => (w.status === 'published' ? pill('live', 'ok') : el('span', { class: 'c-hint' }, '—')),
        },
        {
          key: 'score', header: 'Quality', numeric: true,
          render: (w) => (w.quality_score === null ? verdictPill(null) : w.quality_score.toFixed(3)),
        },
        { key: 'created', header: 'Built', numeric: true, render: (w) => dateTime(w.created_at) },
        { key: 'published', header: 'Published', numeric: true, render: (w) => dateTime(w.published_at) },
        {
          key: 'supersedes', header: 'Supersedes',
          render: (w) => {
            const prev = property.worlds.find((x) => x.id === w.supersedes_id);
            return prev ? `v${prev.version}` : el('span', { class: 'c-hint' }, 'first scan');
          },
        },
      ],
      rows: property.worlds,
      rowKey: (w) => w.id,
      empty: 'This property has no world versions yet.',
    }),
  );

  frame.body.replaceChildren(details, versions);

  if (property.worlds.length >= 2) {
    frame.body.appendChild(buildComparison(ctx, property));
  } else {
    frame.body.appendChild(section(
      'What changed',
      'A comparison appears once this property has two versions.',
    ));
  }

  return frame.root;
}

function buildComparison(ctx: PageContext, property: PropertyRow): HTMLElement {
  const host = el('div', {});
  const [newest, previous] = property.worlds;

  const pick = (label: string, value: string, onChange: (v: string) => void): HTMLElement => {
    const sel = el('select', {
      class: 'c-select', 'aria-label': label, style: 'min-width:120px',
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
    });
    for (const w of property.worlds) {
      sel.appendChild(el('option', { value: w.id, selected: w.id === value }, `v${w.version} — ${w.status}`));
    }
    sel.value = value;
    return sel;
  };

  let fromId = previous!.id;
  let toId = newest!.id;

  const controls = el('div', { class: 'c-inline', style: 'margin-bottom:12px' },
    el('span', { class: 'c-hint' }, 'Compare'),
    pick('Earlier version', fromId, (v) => { fromId = v; void run(); }),
    el('span', { class: 'c-hint' }, 'with'),
    pick('Later version', toId, (v) => { toId = v; void run(); }),
  );

  async function run(): Promise<void> {
    host.replaceChildren(loading('both versions'));
    try {
      const [a, b] = await Promise.all([
        ctx.api.getWorldDocument(fromId),
        ctx.api.getWorldDocument(toId),
      ]);
      if (!a.doc || !b.doc) {
        host.replaceChildren(note('info', 'Not comparable yet',
          'One of these versions has not been built far enough to have rooms, so there is nothing to compare.'));
        return;
      }
      host.replaceChildren(renderDiff(diffWorlds(a.doc, b.doc)));
    } catch (err) {
      host.replaceChildren(errorPanel(err));
    }
  }

  void run();
  return section(
    'What changed between versions',
    'Rooms are matched by their stable key, so one room is one room across a rescan. An area change inside the declared measurement tolerance is not counted as a change.',
    controls, host,
  );
}

function renderDiff(diff: WorldDiff): HTMLElement {
  if (diff.identical) {
    return note('ok', 'Nothing material changed',
      `v${diff.fromVersion} and v${diff.toVersion} describe the same property, within the declared tolerances. ${diff.rooms.unchanged} rooms matched.`);
  }

  const list = (title: string, items: readonly string[]): HTMLElement | null => {
    if (items.length === 0) return null;
    return el('div', { style: 'margin-bottom:10px' },
      el('b', { style: 'font-size:13px' }, title),
      el('ul', { style: 'margin:4px 0 0;padding-left:20px' }, ...items.map((i) => el('li', {}, i))),
    );
  };

  const resized = diff.rooms.resized.length > 0
    ? table({
      caption: 'Rooms whose area moved by more than the declared tolerance',
      columns: [
        { key: 'name', header: 'Room', render: (r: typeof diff.rooms.resized[number]) => r.name },
        { key: 'from', header: `v${diff.fromVersion}`, numeric: true, render: (r) => `${r.from.toFixed(2)} m²` },
        { key: 'to', header: `v${diff.toVersion}`, numeric: true, render: (r) => `${r.to.toFixed(2)} m²` },
        {
          key: 'delta', header: 'Change', numeric: true,
          render: (r) => el('span', { class: r.deltaFraction < 0 ? 'c-num' : 'c-num' },
            `${r.deltaFraction > 0 ? '+' : ''}${percent(r.deltaFraction, 1)}`),
        },
        { key: 'tol', header: 'Tolerance', numeric: true, render: (r) => `±${r.tolerancePct.toFixed(1)}%` },
      ],
      rows: diff.rooms.resized,
      rowKey: (r) => r.stableKey,
    })
    : null;

  const verdictLine = diff.quality.fromVerdict === diff.quality.toVerdict
    ? `The quality verdict stayed at “${diff.quality.toVerdict}” (score ${diff.quality.fromScore.toFixed(3)} to ${diff.quality.toScore.toFixed(3)}).`
    : `The quality verdict moved from “${diff.quality.fromVerdict}” to “${diff.quality.toVerdict}”.`;

  return el('div', {},
    note(diff.quality.toVerdict === 'pass' ? 'ok' : 'warn', null, verdictLine),
    list('Rooms added', diff.rooms.added),
    list('Rooms no longer found', diff.rooms.removed),
    list('Rooms renamed', diff.rooms.renamed.map((r) => `${r.from} → ${r.to}`)),
    list('Room types changed', diff.rooms.kindChanged.map((r) => `${r.from} → ${r.to}`)),
    list('Objects added', diff.entities.added),
    list('Objects no longer found', diff.entities.removed),
    list('Objects relabelled', diff.entities.relabelled.map((r) => `${r.from} → ${r.to}`)),
    list('Quality checks that flipped', diff.quality.flipped.map(
      (f) => `${f.name.replace(/_/g, ' ')}: ${f.from ? 'passed' : 'failed'} → ${f.to ? 'passed' : 'failed'}`)),
    resized,
    el('p', { class: 'c-hint', style: 'margin-top:10px' },
      `Cameras: ${diff.coverage.fromCameras} → ${diff.coverage.toCameras}. `
      + `Volumes never observed: ${diff.coverage.fromUnobservedRegions} → ${diff.coverage.toUnobservedRegions}. `
      + `${diff.rooms.unchanged} rooms unchanged.`),
  );
}

/** Exported for the world page's header, which shows the same summary line. */
export function describeAssets(count: number, byteCount: number): string {
  return count === 0 ? 'No assets yet' : `${count} assets, ${fmtBytes(byteCount)}`;
}
