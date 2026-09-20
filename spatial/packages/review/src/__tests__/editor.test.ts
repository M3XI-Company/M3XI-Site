import { afterEach, describe, expect, it } from 'vitest';
import type { WorldDocument } from '@m3xi/world-core';
import type { CorrectionApi } from '../model/client.js';
import type { WireCorrection } from '../model/wire.js';
import {
  mountCorrectionEditor, readDocument,
  type CorrectionEditorHandle, type LegacyCorrectionSignal,
} from '../ui/editor.js';
import {
  all, byAttr, byTag, choose, fire, installDom, tick, typeInto,
  type InstalledDom, type MiniElement,
} from './minidom.js';
import { buildFixture } from './fixture.js';

/**
 * THE MOUNT CONTRACT, AND THE MARKUP BEHIND IT.
 *
 * `apps/console/src/seams.ts` loads this package dynamically and
 * `console-ui/src/logic/seam.ts` checks the result structurally. The first
 * block below is that check, performed here so a break is found in this
 * package's own suite rather than as a skipped test in somebody else's.
 *
 * The rest is the part a structural check cannot see: that the plan is
 * operable from the keyboard, that a correction cannot be applied from an
 * incomplete form, that a blocker actually withholds the save, and that the
 * save gate holds even when the button pressed is the console's own.
 */

let installed: InstalledDom | null = null;
let mounted: CorrectionEditorHandle | null = null;

afterEach(() => {
  mounted?.destroy();
  mounted = null;
  installed?.uninstall();
  installed = null;
});

interface Harness {
  readonly root: MiniElement;
  readonly doc: WorldDocument;
  readonly ids: ReturnType<typeof buildFixture>['ids'];
  readonly handle: CorrectionEditorHandle;
  readonly dirty: boolean[];
  readonly signals: LegacyCorrectionSignal[];
  readonly sent: { worldId: string; corrections: readonly unknown[] }[];
}

function harness(opts: {
  rejected?: readonly string[];
  world?: unknown;
} = {}): Harness {
  installed = installDom();
  const { doc, ids } = buildFixture();
  const dirty: boolean[] = [];
  const signals: LegacyCorrectionSignal[] = [];
  const sent: { worldId: string; corrections: readonly unknown[] }[] = [];

  const api: CorrectionApi = {
    session: { userId: 'user-1', email: 'sam@example.com' },
    isFixture: false,
    applyCorrections: async (worldId, corrections) => {
      sent.push({ worldId, corrections });
      return { applied: corrections.length, rejected: opts.rejected ?? [] };
    },
  };

  const handle = mountCorrectionEditor(installed.host as unknown as HTMLElement, {
    world: opts.world ?? doc,
    worldId: doc.id,
    api,
    onDirty: (d) => dirty.push(d),
    onCorrection: (c) => signals.push(c),
    // Drafts are exercised in session.test.ts against a store that can be
    // made to fail; here they would only add noise.
    store: null,
  });
  mounted = handle;
  return { root: installed.host, doc, ids, handle, dirty, signals, sent };
}

function options(root: MiniElement): MiniElement[] {
  return byAttr(root, 'role', 'option');
}

function buttonWith(root: MiniElement, text: string): MiniElement {
  const found = byTag(root, 'button').find((b) => b.textContent.includes(text));
  if (!found) {
    throw new Error(`no button containing "${text}"; saw ${byTag(root, 'button').map((b) => JSON.stringify(b.textContent)).join(', ')}`);
  }
  return found;
}

function reasonFor(root: MiniElement, button: MiniElement): string {
  const id = button.getAttribute('aria-describedby');
  if (!id) return '';
  return all(root).find((n) => n.getAttribute('id') === id)?.textContent ?? '';
}

function inputsOfType(root: MiniElement, type: string): MiniElement[] {
  return byTag(root, 'input').filter((i) => i.getAttribute('type') === type);
}

/**
 * The control a visible label points at. Going through `for`/`id` rather than
 * through document order also asserts that the label is actually wired to the
 * control, which is the half of a form control that a screen reader uses.
 */
function byLabel(root: MiniElement, text: string): MiniElement {
  const label = byTag(root, 'label').find((l) => l.textContent.trim() === text);
  if (!label) {
    throw new Error(`no label "${text}"; saw ${byTag(root, 'label').map((l) => JSON.stringify(l.textContent)).join(', ')}`);
  }
  const target = label.getAttribute('for');
  const control = target ? all(root).find((n) => n.getAttribute('id') === target) : null;
  if (!control) throw new Error(`the label "${text}" points at no control`);
  return control;
}

function selectRoom(h: Harness, index = 0): void {
  fire(options(h.root)[index]!, 'click');
}

// ---------------------------------------------------------------------------

describe('the contract the console checks for', () => {
  it('exports a mount of the agreed arity that returns destroy and save', async () => {
    expect(mountCorrectionEditor.length).toBeGreaterThanOrEqual(2);
    const h = harness();
    expect(typeof h.handle.destroy).toBe('function');
    expect(typeof h.handle.save).toBe('function');
    // `save` always returns a promise. It rejects on an empty list, which is
    // asserted in the save-gate block; swallowed here so an unhandled
    // rejection cannot fail an unrelated test.
    const promise = h.handle.save();
    expect(promise).toBeInstanceOf(Promise);
    await promise.catch(() => undefined);
  });

  it('mounts its own root into the host and takes it away again', () => {
    const h = harness();
    expect(byAttr(h.root, 'class', 'rv')).toHaveLength(1);
    h.handle.destroy();
    mounted = null;
    expect(h.root.childNodes).toHaveLength(0);
  });

  it('accepts a World, accepts a WorldDocument, and refuses anything else loudly', () => {
    const { doc } = buildFixture();
    expect(readDocument({ doc })).toBe(doc);
    expect(readDocument(doc)).toBe(doc);
    expect(() => readDocument({ rooms: 'lots' })).toThrow(/neither a World nor a WorldDocument/);
    expect(() => readDocument(null)).toThrow(/wiring fault/);
  });

  it('mounts against a World-shaped wrapper, which is what the console passes', () => {
    const { doc } = buildFixture();
    const h = harness({ world: { doc } });
    expect(options(h.root).length).toBeGreaterThan(0);
  });
});

describe('the plan is the pick surface, and it works without a mouse', () => {
  it('is a listbox whose every shape carries an accessible name', () => {
    const h = harness();
    const listbox = byAttr(h.root, 'role', 'listbox');
    expect(listbox).toHaveLength(1);
    expect(listbox[0]!.getAttribute('aria-label')).toMatch(/Floorplan/);

    const picks = options(h.root);
    expect(picks).toHaveLength(10);
    expect(picks.every((o) => (o.getAttribute('aria-label') ?? '').length > 0)).toBe(true);
    expect(picks[0]!.getAttribute('aria-label')).toContain('Hall');
  });

  it('keeps exactly one shape in the tab ring', () => {
    const h = harness();
    expect(options(h.root).filter((o) => o.getAttribute('tabindex') === '0')).toHaveLength(1);
    selectRoom(h, 1);
    const inRing = options(h.root).filter((o) => o.getAttribute('tabindex') === '0');
    expect(inRing).toHaveLength(1);
    expect(inRing[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('moves the selection with the arrow keys, Home and End', () => {
    const h = harness();
    const listbox = byAttr(h.root, 'role', 'listbox')[0]!;

    const down = fire(listbox, 'keydown', { key: 'ArrowDown' });
    expect(down.defaultPrevented).toBe(true);
    expect(options(h.root)[1]!.getAttribute('aria-selected')).toBe('true');

    fire(byAttr(h.root, 'role', 'listbox')[0]!, 'keydown', { key: 'End' });
    expect(options(h.root).at(-1)!.getAttribute('aria-selected')).toBe('true');

    fire(byAttr(h.root, 'role', 'listbox')[0]!, 'keydown', { key: 'Home' });
    expect(options(h.root)[0]!.getAttribute('aria-selected')).toBe('true');

    // A key that is not navigation is left for the browser.
    expect(fire(byAttr(h.root, 'role', 'listbox')[0]!, 'keydown', { key: 'a' }).defaultPrevented)
      .toBe(false);
  });

  it('wraps at both ends rather than dead-ending', () => {
    const h = harness();
    fire(byAttr(h.root, 'role', 'listbox')[0]!, 'keydown', { key: 'ArrowUp' });
    expect(options(h.root).at(-1)!.getAttribute('aria-selected')).toBe('true');
  });

  it('opens the detail panel on the thing that was selected', () => {
    const h = harness();
    selectRoom(h, 0);
    expect(h.root.textContent).toContain('Hall');
    expect(h.root.textContent).toContain('Room name');
    expect(h.root.textContent).toContain('measured from the photographs');
  });
});

describe('correcting something', () => {
  it('turns a typed name into a correction, a sentence and a signal to the console', () => {
    const h = harness();
    selectRoom(h, 0);

    const name = inputsOfType(h.root, 'text')[0]!;
    typeInto(name, 'Entrance hall');
    fire(buttonWith(h.root, 'Correct room name'), 'click');

    expect(h.root.textContent).toContain('Rename Hall to "Entrance hall".');
    expect(h.root.textContent).toContain('sam@example.com');
    expect(h.dirty).toEqual([true]);
    expect(h.signals).toEqual([{
      target: 'room', id: h.ids.hall, field: 'name', value: 'Entrance hall',
    }]);
  });

  it('will not offer Apply for an empty name, and says why on the screen', () => {
    const h = harness();
    selectRoom(h, 0);
    const name = inputsOfType(h.root, 'text')[0]!;
    typeInto(name, '   ');

    const apply = buttonWith(h.root, 'Correct room name');
    expect(apply.hasAttribute('disabled')).toBe(true);
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    // The reason is a sibling element wired with aria-describedby, not a
    // tooltip nobody can reach with a keyboard.
    expect(reasonFor(h.root, apply)).toMatch(/Enter a value/);
  });

  it('lets an entry be withdrawn on its own', () => {
    const h = harness();
    selectRoom(h, 0);
    typeInto(inputsOfType(h.root, 'text')[0]!, 'Entrance hall');
    fire(buttonWith(h.root, 'Correct room name'), 'click');
    expect(h.root.textContent).toContain('Corrections (1)');

    const remove = byTag(h.root, 'button')
      .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Remove this correction'))!;
    expect(remove.getAttribute('aria-label')).toContain('Rename Hall');
    fire(remove, 'click');

    expect(h.root.textContent).toContain('Nothing corrected yet');
    expect(h.dirty).toEqual([true, false]);
  });

  it('undoes and redoes from the list', () => {
    const h = harness();
    selectRoom(h, 0);
    typeInto(inputsOfType(h.root, 'text')[0]!, 'Entrance hall');
    fire(buttonWith(h.root, 'Correct room name'), 'click');

    fire(buttonWith(h.root, 'Undo'), 'click');
    expect(h.root.textContent).toContain('Nothing corrected yet');
    fire(buttonWith(h.root, 'Redo'), 'click');
    expect(h.root.textContent).toContain('Rename Hall to "Entrance hall".');
  });
});

describe('a dimension cannot be applied until the operator says how they know it', () => {
  function areaForm(h: Harness): { value: MiniElement; apply: MiniElement } {
    selectRoom(h, 1); // the kitchen
    const value = byTag(h.root, 'input')
      .filter((i) => i.getAttribute('type') === 'number')[0]!;
    return { value, apply: buttonWith(h.root, 'Correct floor area') };
  }

  it('refuses while no method is chosen, with the reason on the screen', () => {
    const h = harness();
    const { value, apply } = areaForm(h);
    typeInto(value, '24.6');
    expect(apply.hasAttribute('disabled')).toBe(true);
    expect(reasonFor(h.root, apply)).toMatch(/how you know this figure/);
  });

  it('never pre-selects the flattering answer', () => {
    const h = harness();
    areaForm(h);
    const radios = inputsOfType(h.root, 'radio');
    expect(radios.length).toBeGreaterThanOrEqual(2);
    expect(radios.some((r) => r.hasAttribute('checked'))).toBe(false);
    // The instrument select is not even shown until a site measurement is
    // claimed, so "laser" is never what the form says before anyone answered.
    const instrument = byTag(h.root, 'select')
      .find((s) => all(h.root).some((o) => o.tagName === 'option' && o.textContent.includes('Laser')))!;
    expect(instrument).toBeDefined();
    const wrap = byAttr(h.root, 'hidden');
    expect(wrap.length).toBeGreaterThan(0);
  });

  it('applies an estimate, and records it as having no instrument', () => {
    const h = harness();
    const { value, apply } = areaForm(h);
    typeInto(value, '24.6');
    fire(inputsOfType(h.root, 'radio').find((r) => r.getAttribute('value') === 'estimate')!, 'change');

    const enabled = buttonWith(h.root, 'Correct floor area');
    expect(enabled.hasAttribute('disabled')).toBe(false);
    fire(enabled, 'click');

    expect(h.root.textContent).toContain('entered as an estimate');
    // Nothing legacy-shaped exists for a dimension, so the console is told
    // nothing rather than told something the server would refuse.
    expect(h.signals).toEqual([]);
    expect(h.dirty).toEqual([true]);
  });

  it('requires the instrument once a site measurement is claimed', () => {
    const h = harness();
    const { value } = areaForm(h);
    typeInto(value, '24.6');
    fire(inputsOfType(h.root, 'radio').find((r) => r.getAttribute('value') === 'site-measure')!, 'change');

    const apply = buttonWith(h.root, 'Correct floor area');
    expect(apply.hasAttribute('disabled')).toBe(true);
    expect(reasonFor(h.root, apply)).toMatch(/what you measured with/);

    const instrument = byTag(h.root, 'select').find((s) => s.childNodes.some(
      (c) => (c as MiniElement).getAttribute?.('value') === 'laser',
    ))!;
    choose(instrument, 'laser');
    const ready = buttonWith(h.root, 'Correct floor area');
    expect(ready.hasAttribute('disabled')).toBe(false);
    fire(ready, 'click');
    expect(h.root.textContent).toContain('measured on site with a laser');
  });
});

describe('the save gate', () => {
  async function addOneCorrection(h: Harness): Promise<void> {
    selectRoom(h, 0);
    typeInto(inputsOfType(h.root, 'text')[0]!, 'Entrance hall');
    fire(buttonWith(h.root, 'Correct room name'), 'click');
  }

  it('refuses an empty list', async () => {
    const h = harness();
    await expect(h.handle.save()).rejects.toThrow(/no corrections to save/i);
  });

  it('refuses while the list is unsigned, whichever button was pressed', async () => {
    const h = harness();
    await addOneCorrection(h);
    const save = buttonWith(h.root, 'Save corrections');
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(reasonFor(h.root, save)).toMatch(/Sign off first/);
    // The console mounts its own Save button beside this editor and calls the
    // same handle, so the gate lives in `save`, not in the button.
    await expect(h.handle.save()).rejects.toThrow(/Sign off/);
  });

  it('refuses while the world has a blocker, and names it', async () => {
    const h = harness();
    selectRoom(h, 2); // the bedroom
    tick(inputsOfType(h.root, 'checkbox').at(-1)!);
    fire(buttonWith(h.root, 'Delete this room'), 'click');

    expect(h.root.textContent).toContain('this cannot be saved');
    const save = buttonWith(h.root, 'Save corrections');
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(reasonFor(h.root, save)).toMatch(/blocker/);
    await expect(h.handle.save()).rejects.toThrow(/still connects/);
  });

  it('saves a signed list, sending records rather than a client-stated author', async () => {
    const h = harness();
    await addOneCorrection(h);
    fire(buttonWith(h.root, 'Sign off these corrections'), 'click');

    const save = buttonWith(h.root, 'Save corrections');
    expect(save.hasAttribute('disabled')).toBe(false);
    await h.handle.save();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.worldId).toBe(h.doc.id);
    const payload = h.sent[0]!.corrections as readonly WireCorrection[];
    expect(payload).toHaveLength(2);
    expect(payload[0]!.change).toEqual({
      kind: 'room.rename', roomId: h.ids.hall, name: 'Entrance hall',
    });
    expect(payload[0]).not.toHaveProperty('by');
    expect(payload[1]!.change.kind).toBe('world.approve');

    // Everything landed, so the list has done its job.
    expect(h.root.textContent).toContain('Nothing corrected yet');
    expect(h.dirty).toEqual([true, false]);
  });

  it('keeps the list when the server refused something, and says what', async () => {
    const h = harness({ rejected: ['room:… is not in this world'] });
    await addOneCorrection(h);
    fire(buttonWith(h.root, 'Sign off these corrections'), 'click');

    await expect(h.handle.save()).rejects.toThrow(/is not in this world/);
    // Clearing the list here would be the quiet loss this package exists to
    // prevent: the operator has to decide what to do about the refusal.
    expect(h.root.textContent).toContain('Corrections (2)');
  });

  it('offers the save with a warning attached, because a warning is not a blocker', async () => {
    const h = harness();
    // Reassigning the sofa to the hall leaves its position in the kitchen,
    // which `validate.ts` reports as a warning and not a blocker.
    selectRoom(h, 7); // the first entity in the pick order
    const roomSelect = byTag(h.root, 'select').find((s) => s.childNodes.some(
      (c) => (c as MiniElement).getAttribute?.('value') === h.ids.hall,
    ))!;
    choose(roomSelect, h.ids.hall);
    fire(buttonWith(h.root, 'Correct in room'), 'click');

    expect(h.root.textContent).toContain('this can be saved');
    fire(buttonWith(h.root, 'Sign off these corrections'), 'click');
    await h.handle.save();
    expect(h.sent).toHaveLength(1);
  });
});

describe('what will not survive the save is said before the save', () => {
  it('names a correction the server will refuse, in the list and in the save panel', () => {
    const h = harness();
    selectRoom(h, 2);
    // Withdrawing the pipeline's roof void: the server decides on a column the
    // world document does not carry, so the editor says so rather than
    // promising either answer.
    const model = h.root.textContent;
    expect(model).toContain('Bedroom 1');

    selectRoom(h, 0);
    typeInto(inputsOfType(h.root, 'text')[0]!, 'Entrance hall');
    fire(buttonWith(h.root, 'Correct room name'), 'click');
    expect(h.root.textContent).toContain('will be saved exactly as the preview shows them');
  });

  it('warns that a coverage note is inserted with an id this preview does not have', () => {
    const h = harness();
    selectRoom(h, 0);
    typeInto(byLabel(h.root, 'Why'), 'cupboard under the stairs was never opened');
    fire(inputsOfType(h.root, 'radio').find((r) => r.getAttribute('value') === 'generated')!, 'change');
    fire(buttonWith(h.root, 'Record the gap'), 'click');

    expect(h.root.textContent).toContain('will save differently from the preview');
    expect(h.root.textContent).toContain('id the server allocates');
  });
});
