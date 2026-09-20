/**
 * Review and publish.
 *
 * The operator walks the world here, in the same viewer a visitor will use,
 * before deciding whether the public should see it. `mode: 'operator'` turns
 * on the diagnostics and lets the camera enter unsurveyed space, which is the
 * difference between reviewing a world and touring one.
 *
 * The correction editor and the compliance centre are another builder's
 * packages, mounted through the seam in `../seams.ts`. When they are absent
 * the fallback is not a placeholder: the room and object table below writes
 * through the same `approve_corrections` endpoint the editor would use, so the
 * job can still be done.
 *
 * Publish sits at the bottom and is enabled only when `evaluateGate` says the
 * server will accept it.
 */

import {
  ApiError, button, confirm, el, evaluateGate, isValidSlug, note, parseQualityRow, slugify,
  table, toast, type Correction, type DataProblem, type WorldDetail,
} from '@m3xi/console-ui';
import type { Room, WorldDocument } from '@m3xi/world-core';
import type { PageContext } from './context.js';
import { errorPanel, loading, section } from '../shell.js';
import { mountCompliance, mountCorrections } from '../seams.js';

export interface ReviewTab {
  readonly root: HTMLElement;
  destroy(): void;
}

export function renderReview(ctx: PageContext, detail: WorldDetail, onChanged: () => void): ReviewTab {
  const root = el('div', {});
  root.appendChild(loading('the world'));

  const teardown: (() => void)[] = [];
  let dirty = false;
  const pending = new Map<string, Correction>();

  void (async () => {
    let doc: WorldDocument | null = null;
    let problems: readonly DataProblem[] = [];
    try {
      const assembled = await ctx.api.getWorldDocument(detail.world.id);
      doc = assembled.doc;
      problems = assembled.problems;
    } catch (err) {
      root.replaceChildren(errorPanel(err));
      return;
    }

    root.replaceChildren();

    for (const problem of problems.filter((p) => p.level === 'blocker')) {
      root.appendChild(note('bad', 'This world cannot be shown', problem.message));
    }
    const warnings = problems.filter((p) => p.level === 'warning');
    if (warnings.length > 0) {
      root.appendChild(note('warn', `${warnings.length} data problems`,
        el('ul', { style: 'margin:4px 0 0;padding-left:20px' },
          ...warnings.slice(0, 8).map((p) => el('li', {}, p.ref ? `${p.message} (${p.ref})` : p.message)))));
    }

    if (!doc) {
      root.appendChild(publishSection(ctx, detail, false, onChanged));
      return;
    }

    root.appendChild(scaleNote(doc));
    root.appendChild(viewerSection(doc, teardown));
    root.appendChild(await correctionSection(ctx, detail, doc, teardown, {
      onDirty: (d) => { dirty = d; },
      onCorrection: (c) => { pending.set(`${c.target}:${c.id}:${c.field}`, c); },
      onSaved: () => { dirty = false; pending.clear(); onChanged(); },
    }));
    root.appendChild(await complianceSection(ctx, detail, doc, teardown));
    root.appendChild(publishSection(ctx, detail, dirty || pending.size > 0, onChanged));
  })();

  return {
    root,
    destroy(): void {
      for (const fn of teardown.splice(0)) {
        try { fn(); } catch { /* a viewer that has already gone is fine */ }
      }
    },
  };
}

/**
 * How the metres were fixed, stated before anyone walks the world.
 *
 * Every dimension inherits the weaker of its own geometry's provenance and
 * this one, so an operator about to publish a set of measurements should know
 * whether the scale behind them was reconstructed or merely inferred.
 */
function scaleNote(doc: WorldDocument): HTMLElement {
  const { source, agreement, grounding } = doc.scale;
  const tone = grounding.provenance === 'reconstructed' ? 'info' : 'warn';
  return note(tone, 'How the metres were fixed',
    `${source}. The estimators agreed to ${(agreement * 100).toFixed(1)}%, and the scale itself is ${grounding.provenance} at ${(grounding.confidence * 100).toFixed(0)}% confidence.`,
    el('p', {}, grounding.provenance === 'reconstructed'
      ? 'Every dimension below inherits the weaker of its own provenance and this one.'
      : 'No camera measures a metre — a model estimates one. Every dimension below is at best as strong as this, whatever its own geometry says.'),
  );
}

function viewerSection(doc: WorldDocument, teardown: (() => void)[]): HTMLElement {
  const host = el('div', { class: 'c-viewerhost' });
  const wrapper = section(
    'Walk it',
    'The same viewer a visitor gets, in operator mode: diagnostics on, and the camera may enter space no camera ever saw so you can check what is there.',
    host,
    el('p', { class: 'c-hint', style: 'margin-top:8px' },
      'Arrow keys or WASD to move, drag to look. Anything the cameras did not observe is marked in the view itself.'),
  );

  void (async () => {
    try {
      const viewer = await import('@m3xi/viewer');
      const instance = await viewer.mount(host, {
        doc,
        mode: 'operator',
        locale: 'en-GB',
      });
      teardown.push(() => instance.dispose());
    } catch (err) {
      host.replaceChildren(note('warn', 'The 3D view could not start',
        err instanceof Error ? err.message : String(err),
        el('p', {}, 'The rest of this page still works: the data below is the same world, and the quality report does not depend on rendering.')));
    }
  })();

  return wrapper;
}

async function correctionSection(
  ctx: PageContext,
  detail: WorldDetail,
  doc: WorldDocument,
  teardown: (() => void)[],
  handlers: {
    onDirty: (d: boolean) => void;
    onCorrection: (c: Correction) => void;
    /**
     * Called once corrections are actually written. It re-reads the world, and
     * it has to: `get_world` derives `lastCorrectionAt` from the `updated_at`
     * the database has just moved, and that timestamp is what turns the
     * publish gate stale. Without this the operator saves a correction and the
     * Publish button beside it stays green against a quality report that now
     * describes a world that no longer exists.
     */
    onSaved: () => void;
  },
): Promise<HTMLElement> {
  const host = el('div', { class: 'c-seamhost' });
  const wrapper = section(
    'Corrections',
    'Fix what the pipeline got wrong. A room’s name and kind, and an object’s label, category and room, are correctable; geometry is not, because a hand-moved wall would become a measurement no camera supports.',
    host,
  );

  let world: object = doc;
  try {
    const engine = await import('@m3xi/spatial-engine');
    world = engine.World.fromDocument(doc);
  } catch {
    // The editor is handed the document itself if the engine will not load.
    // Its contract asks for a World; this is the closest honest substitute and
    // the seam reports the mismatch rather than pretending.
    world = doc;
  }

  const mount = await mountCorrections(host, {
    world,
    worldId: detail.world.id,
    api: ctx.api,
    onDirty: handlers.onDirty,
    onCorrection: handlers.onCorrection,
  });

  if (mount.handle) {
    teardown.push(() => mount.handle!.destroy());
    wrapper.appendChild(el('div', { style: 'margin-top:10px' },
      button({
        label: 'Save corrections',
        emphasis: 'primary',
        onClick: () => {
          void mount.handle!.save()
            .then(() => { toast('Corrections saved.', 'ok'); handlers.onSaved(); })
            .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'bad'));
        },
      })));
    return wrapper;
  }

  if (mount.fallback) host.appendChild(mount.fallback);
  host.appendChild(roomCorrectionTable(ctx, detail, doc, handlers.onSaved));
  return wrapper;
}

/**
 * The fallback editor: a table of rooms whose name and kind can be corrected
 * inline. It writes exactly what `approve_corrections` accepts — nothing more,
 * because the endpoint's allowlist is the boundary and widening it here would
 * only produce rejections.
 */
function roomCorrectionTable(
  ctx: PageContext, detail: WorldDetail, doc: WorldDocument, onSaved: () => void,
): HTMLElement {
  const edits = new Map<string, Correction>();
  const status = el('p', { class: 'c-hint', role: 'status' }, '');

  const KINDS: Room['kind'][] = [
    'living', 'kitchen', 'bedroom', 'bathroom', 'wc', 'hall', 'landing', 'stairwell',
    'utility', 'storage', 'office', 'dining', 'conservatory', 'garage', 'balcony',
    'garden', 'exterior', 'unknown',
  ];

  const record = (c: Correction): void => {
    edits.set(`${c.target}:${c.id}:${c.field}`, c);
    status.textContent = `${edits.size} unsaved ${edits.size === 1 ? 'correction' : 'corrections'}.`;
  };

  const rows = table<Room>({
    caption: `${doc.rooms.length} rooms`,
    columns: [
      {
        key: 'name', header: 'Name',
        render: (room) => el('input', {
          class: 'c-input', value: room.name ?? '',
          'aria-label': `Name of room ${room.stableKey}`,
          onchange: (e: Event) => record({
            target: 'room', id: room.id, field: 'name', value: (e.target as HTMLInputElement).value,
          }),
        }),
      },
      {
        key: 'kind', header: 'Kind',
        render: (room) => {
          const sel = el('select', {
            class: 'c-select', 'aria-label': `Kind of ${room.name ?? room.stableKey}`,
            onchange: (e: Event) => record({
              target: 'room', id: room.id, field: 'kind', value: (e.target as HTMLSelectElement).value,
            }),
          });
          for (const kind of KINDS) sel.appendChild(el('option', { value: kind, selected: kind === room.kind }, kind));
          sel.value = room.kind;
          return sel;
        },
      },
      {
        key: 'area', header: 'Area', numeric: true,
        render: (room) => el('span', {},
          `${room.area.value.toFixed(2)} m² ±${room.area.tolerance.toFixed(1)}%`),
      },
      { key: 'standard', header: 'Standard', render: (room) => room.area.standard },
      {
        key: 'provenance', header: 'From',
        render: (room) => el('span', { class: `c-pill c-pill--${room.grounding.provenance === 'observed' ? 'ok' : room.grounding.provenance === 'generated' ? 'bad' : 'muted'}` },
          room.grounding.provenance),
      },
    ],
    rows: [...doc.rooms],
    rowKey: (room) => room.id,
  });

  const save = button({
    label: 'Save corrections',
    emphasis: 'primary',
    onClick: async () => {
      if (edits.size === 0) { toast('Nothing to save.', 'info'); return; }
      try {
        const result = await ctx.api.applyCorrections(detail.world.id, [...edits.values()]);
        toast(`${result.applied} applied${result.rejected.length > 0 ? `, ${result.rejected.length} rejected` : ''}.`,
          result.rejected.length > 0 ? 'bad' : 'ok');
        edits.clear();
        status.textContent = 'Saved. Re-run the quality stage so the report describes the corrected world.';
        // Only when something was actually written. A save that applied
        // nothing moved no `updated_at`, so there is nothing new to read.
        if (result.applied > 0) onSaved();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    },
  });

  return el('div', { style: 'padding:12px' }, rows, el('div', { style: 'margin-top:10px' }, save), status);
}

async function complianceSection(
  ctx: PageContext, detail: WorldDetail, doc: WorldDocument, teardown: (() => void)[],
): Promise<HTMLElement> {
  const host = el('div', { class: 'c-seamhost', style: 'padding:12px' });
  const mount = await mountCompliance(host, {
    world: doc,
    worldId: detail.world.id,
    propertyId: detail.world.property_id,
    api: ctx.api,
  });
  if (mount.handle) teardown.push(() => mount.handle!.destroy());
  else if (mount.fallback) host.appendChild(mount.fallback);

  return section('Compliance',
    'Redactions awaiting sign-off, and the measurement audit trail behind every dimension this world will show.',
    host);
}

function publishSection(
  ctx: PageContext, detail: WorldDetail, hasUnsaved: boolean, onChanged: () => void,
): HTMLElement {
  const parsed = parseQualityRow(detail.quality as never);
  const gate = evaluateGate({
    report: parsed.report,
    worldStatus: detail.world.status,
    role: ctx.role,
    lastCorrectionAt: detail.lastCorrectionAt,
    hasUnsavedCorrections: hasUnsaved,
  });

  const published = detail.world.status === 'published';
  const suggested = detail.world.slug ?? '';
  const slugInput = el('input', {
    class: 'c-input', value: suggested, style: 'max-width:340px',
    'aria-label': 'Public link name',
    placeholder: 'two-bed-flat-ash-grove',
  });

  const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' });

  actions.appendChild(button({
    label: published ? 'Re-publish this version' : 'Publish',
    emphasis: 'primary',
    disabled: !gate.publishable,
    reason: gate.reason,
    onClick: async () => {
      const slug = slugInput.value.trim();
      if (slug && !isValidSlug(slug)) {
        toast('A link name can only contain lower-case letters, numbers and hyphens.', 'bad');
        slugInput.focus();
        return;
      }
      const ok = await confirm({
        title: published ? 'Replace the live version?' : 'Publish this world?',
        body: [
          published
            ? 'The public link will start showing this version instead. The previous version is kept and can be published again.'
            : 'Anyone with the link will be able to walk this property. Leads and analytics start from the moment it goes live.',
          slug ? `The link will be /${slug}.` : 'No link name set: the world will be reachable by its id.',
        ],
        confirmLabel: published ? 'Replace' : 'Publish',
      });
      if (!ok) return;
      try {
        await ctx.api.publish(detail.world.id, slug || undefined);
        toast('Published.', 'ok');
        onChanged();
      } catch (err) {
        // The server is the authority. If it refuses, its words are shown, not
        // a friendlier paraphrase of them.
        toast(err instanceof ApiError ? err.message : String(err), 'bad');
      }
    },
  }));

  if (published) {
    actions.appendChild(button({
      label: 'Unpublish',
      emphasis: 'danger',
      onClick: async () => {
        const ok = await confirm({
          title: 'Take this world off the internet?',
          body: [
            'The public link stops working immediately. Anyone holding it gets a not-found, the same response they would get for a link that never existed.',
            'Nothing is deleted. Exports already downloaded keep working, because they do not call back to us at all.',
          ],
          confirmLabel: 'Unpublish',
          danger: true,
        });
        if (!ok) return;
        try {
          await ctx.api.unpublish(detail.world.id);
          toast('Unpublished.', 'ok');
          onChanged();
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'bad');
        }
      },
    }));
  }

  return section('Publish',
    'A world becomes publicly viewable because it passed the quality gate, not because the pipeline finished.',
    note(gate.publishable ? 'ok' : gate.state === 'fail' ? 'bad' : 'warn', null, gate.reason),
    el('div', { class: 'c-field', style: 'max-width:340px' },
      el('label', { for: slugInput.id || undefined }, 'Public link name'),
      slugInput,
      el('span', { class: 'c-hint' },
        suggested ? 'Changing this changes the address visitors use.' : `Suggestion: ${slugify(detail.world.property_id) || 'address-with-hyphens'}`),
    ),
    actions,
  );
}
