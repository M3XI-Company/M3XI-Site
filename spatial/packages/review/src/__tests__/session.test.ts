import { describe, expect, it } from 'vitest';
import type { WorldDocument } from '@m3xi/world-core';
import {
  CorrectionSession, DRAFT_KEY_PREFIX, defaultDraftStore, newRecordId, type DraftStore,
} from '../model/session.js';
import { isServerId } from '../model/wire.js';
import { buildFixture } from './fixture.js';

/**
 * THE EDITING SESSION.
 *
 * Two properties are being defended here and they are worth naming.
 *
 * The first is that UNDO IS NOT AN INVERSE. Every case below checks the
 * corrected WORLD after the undo, not just the length of the list, because the
 * bug an inverse-based undo produces is a list that looks right over a world
 * that has kept a receipt, a weakened provenance or a moved centroid from the
 * correction that was supposedly withdrawn.
 *
 * The second is that A DRAFT IS NOT SILENTLY TRUSTED. Storage is the one input
 * to this editor that no one authenticated: it survives a deployment, it can
 * be hand-edited, and in a shared profile it was not necessarily written by
 * the person reading it. Every refusal below is a refusal WITH A REASON, and
 * the version check is the one that matters -- a correction is a record about
 * specific rows in a specific version, and a rebuild can have moved every one
 * of them.
 */

class MemoryStore implements DraftStore {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

/** Safari private mode and a full quota, which behave identically from here. */
class FullStore implements DraftStore {
  getItem(): string | null { return null; }
  setItem(): void { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }
  removeItem(): void { /* removing from a full store is allowed and useless */ }
}

/** A profile with site data disabled: naming the property throws. */
class HostileStore implements DraftStore {
  getItem(): string | null { throw new Error('Access to storage is not allowed from this context.'); }
  setItem(): void { throw new Error('Access to storage is not allowed from this context.'); }
  removeItem(): void { throw new Error('Access to storage is not allowed from this context.'); }
}

function session(doc: WorldDocument, store: DraftStore | null = new MemoryStore()): CorrectionSession {
  let n = 0;
  return new CorrectionSession({
    base: doc,
    worldId: doc.id,
    by: 'sam@example.com',
    store,
    clock: () => new Date('2026-09-20T11:00:00.000Z'),
    newId: () => {
      n += 1;
      return `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
    },
  });
}

describe('undo and redo are recomputation, not inversion', () => {
  it('drops a record and rebuilds the world from the base', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);

    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    s.add({ kind: 'entity.move', entityId: ids.sofa, centroid: [2, 0.425, 4] });
    expect(s.records).toHaveLength(2);
    expect(s.world.entities.find((e) => e.id === ids.sofa)!.grounding.provenance).toBe('inferred');

    expect(s.undo()).toBe(true);
    expect(s.records).toHaveLength(1);
    const sofa = s.world.entities.find((e) => e.id === ids.sofa)!;
    // Not merely "the list is shorter": the world is the base world again for
    // that object, receipt and provenance included.
    expect(sofa.centroid).toEqual(doc.entities.find((e) => e.id === ids.sofa)!.centroid);
    expect(sofa.grounding.provenance).toBe('observed');
    expect(sofa.grounding.sources ?? []).not.toContain('correction:');
    expect(s.world.rooms.find((r) => r.id === ids.hall)!.name).toBe('Entrance hall');

    expect(s.undo()).toBe(true);
    expect(s.records).toHaveLength(0);
    expect(s.world.rooms.find((r) => r.id === ids.hall)!.name).toBe('Hall');
    expect(s.undo()).toBe(false);
  });

  it('redoes what it undid, and forgets the future once a new edit lands', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    s.add({ kind: 'room.kind', roomId: ids.kitchen, roomKind: 'dining' });

    s.undo();
    expect(s.canRedo).toBe(true);
    expect(s.redo()).toBe(true);
    expect(s.records).toHaveLength(2);

    s.undo();
    s.add({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' });
    expect(s.canRedo).toBe(false);
    expect(s.records.map((r) => r.change.kind)).toEqual(['room.rename', 'entity.label']);
  });

  it('withdraws one entry without disturbing the others', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);
    const first = s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    s.add({ kind: 'room.kind', roomId: ids.kitchen, roomKind: 'dining' });

    expect(s.remove(first.id)).toBe(true);
    expect(s.remove('not-a-record')).toBe(false);
    expect(s.records).toHaveLength(1);
    expect(s.world.rooms.find((r) => r.id === ids.hall)!.name).toBe('Hall');
    expect(s.world.rooms.find((r) => r.id === ids.kitchen)!.kind).toBe('dining');
    // A removal is undoable like any other edit.
    expect(s.undo()).toBe(true);
    expect(s.records).toHaveLength(2);
  });

  it('reports dirty, and the validation of the corrected world', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);
    expect(s.dirty).toBe(false);
    expect(s.validation.savable).toBe(true);

    s.add({ kind: 'room.delete', roomId: ids.bedroom });
    expect(s.dirty).toBe(true);
    expect(s.validation.savable).toBe(false);
    expect(s.validation.blockers.map((b) => b.code)).toContain('opening.dangling-room');

    s.undo();
    expect(s.validation.savable).toBe(true);
  });

  it('tells a subscriber every time the list moves', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);
    const seen: number[] = [];
    const off = s.subscribe((state) => seen.push(state.records.length));

    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    s.undo();
    s.redo();
    off();
    s.add({ kind: 'room.kind', roomId: ids.kitchen, roomKind: 'dining' });

    expect(seen).toEqual([1, 0, 1]);
  });
});

describe('a second correction to the same fact replaces the first', () => {
  it('replaces rather than stacking, and keeps the earlier position in the list', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Halway' });
    s.add({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' });
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Hallway' });

    expect(s.records).toHaveLength(2);
    // Order is not cosmetic: the server applies the list in order and has no
    // transaction, so a replacement that jumped to the end could land after a
    // delete that was always meant to follow it.
    expect(s.records.map((r) => r.change.kind)).toEqual(['room.rename', 'entity.label']);
    expect(s.world.rooms.find((r) => r.id === ids.hall)!.name).toBe('Hallway');
  });

  it('does not collide two different facts about the same room', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Hallway' });
    s.add({ kind: 'room.kind', roomId: ids.hall, roomKind: 'landing' });
    expect(s.records).toHaveLength(2);
  });

  it('does not collide two coverage notes', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc);
    s.add({
      kind: 'region.mark', provenance: 'inferred', roomId: ids.hall,
      volume: { min: [4, 0, 0], max: [5, 2.4, 1] }, reason: 'behind the coats',
    });
    s.add({
      kind: 'region.mark', provenance: 'generated', roomId: ids.hall,
      volume: { min: [5, 0, 5], max: [6, 2.4, 6] }, reason: 'cupboard never opened',
    });
    expect(s.records).toHaveLength(2);
    expect(s.world.regions).toHaveLength(doc.regions.length + 2);
  });
});

describe('drafts', () => {
  it('survives a reload of the same world at the same version', () => {
    const { doc, ids } = buildFixture();
    const store = new MemoryStore();

    const first = session(doc, store);
    first.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    first.add({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' });
    expect(first.draftStatus.persisted).toBe(true);
    expect(store.getItem(`${DRAFT_KEY_PREFIX}${doc.id}`)).toBeTruthy();

    const reopened = session(doc, store);
    const found = reopened.inspectDraft();
    expect(found.kind).toBe('ready');
    if (found.kind === 'ready') {
      expect(found.count).toBe(2);
      expect(found.by).toBe('sam@example.com');
    }

    expect(reopened.restoreDraft().kind).toBe('ready');
    expect(reopened.records).toHaveLength(2);
    expect(reopened.world.rooms.find((r) => r.id === ids.hall)!.name).toBe('Entrance hall');
    // Restoring is itself undoable, for the operator who did not mean to.
    expect(reopened.undo()).toBe(true);
    expect(reopened.records).toHaveLength(0);
  });

  it('refuses a draft whose world has moved on, and says which versions', () => {
    const { doc, ids } = buildFixture();
    const store = new MemoryStore();

    const before = session(doc, store);
    before.add({ kind: 'entity.move', entityId: ids.sofa, centroid: [2, 0.425, 4] });

    // The world was rebuilt while the operator was away. Same id, new version,
    // and every centroid in the draft now refers to geometry nobody has seen.
    const rebuilt: WorldDocument = { ...doc, version: doc.version + 1 };
    const after = session(rebuilt, store);

    const found = after.inspectDraft();
    expect(found.kind).toBe('refused');
    if (found.kind === 'refused') {
      expect(found.reason).toMatch(/version 4/);
      expect(found.reason).toMatch(/version 5/);
      expect(found.count).toBe(1);
    }
    expect(after.restoreDraft().kind).toBe('refused');
    expect(after.records).toEqual([]);
    expect(after.world.entities.find((e) => e.id === ids.sofa)!.centroid)
      .toEqual(doc.entities.find((e) => e.id === ids.sofa)!.centroid);
  });

  it('refuses a draft that belongs to another world', () => {
    const { doc, ids } = buildFixture();
    const store = new MemoryStore();
    const other = session(doc, store);
    other.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });

    const moved = store.getItem(`${DRAFT_KEY_PREFIX}${doc.id}`)!;
    const elsewhere: WorldDocument = { ...doc, id: '00000000-0000-4000-8000-999999999999' };
    store.setItem(`${DRAFT_KEY_PREFIX}${elsewhere.id}`, moved);

    const found = session(elsewhere, store).inspectDraft();
    expect(found.kind).toBe('refused');
    if (found.kind === 'refused') expect(found.reason).toMatch(/belongs to world/);
  });

  it('refuses a draft that is not readable rather than guessing at it', () => {
    const { doc } = buildFixture();
    const store = new MemoryStore();
    store.setItem(`${DRAFT_KEY_PREFIX}${doc.id}`, '{not json');
    const found = session(doc, store).inspectDraft();
    expect(found.kind).toBe('refused');

    store.setItem(`${DRAFT_KEY_PREFIX}${doc.id}`, JSON.stringify({ format: 1, worldId: doc.id }));
    expect(session(doc, store).inspectDraft().kind).toBe('refused');

    store.setItem(`${DRAFT_KEY_PREFIX}${doc.id}`, JSON.stringify({
      format: 99, worldId: doc.id, version: doc.version, records: [],
    }));
    const stale = session(doc, store).inspectDraft();
    expect(stale.kind).toBe('refused');
    if (stale.kind === 'refused') expect(stale.reason).toMatch(/older editor/);
  });

  it('degrades to "your draft is not being saved" when the quota is full', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc, new FullStore());
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });

    expect(s.draftStatus.persisted).toBe(false);
    expect(s.draftStatus.reason).toMatch(/not being saved/);
    expect(s.draftStatus.reason).toMatch(/quota/i);
    // The edit itself still happened. Losing the draft must not lose the work
    // on the screen.
    expect(s.records).toHaveLength(1);
    expect(s.world.rooms.find((r) => r.id === ids.hall)!.name).toBe('Entrance hall');
  });

  it('degrades when the store itself throws on every access', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc, new HostileStore());
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    expect(s.draftStatus.persisted).toBe(false);
    expect(s.inspectDraft().kind).toBe('unavailable');
    expect(() => s.discardDraft()).not.toThrow();
    expect(s.records).toHaveLength(1);
  });

  it('degrades when there is no store at all, which is every Node import of this package', () => {
    const { doc, ids } = buildFixture();
    const s = session(doc, null);
    expect(s.draftStatus.persisted).toBe(false);
    expect(s.draftStatus.reason).toMatch(/not being saved/);
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    expect(s.records).toHaveLength(1);
    expect(s.inspectDraft().kind).toBe('unavailable');
  });

  it('finds no localStorage in Node and does not throw looking', () => {
    expect(defaultDraftStore()).toBeNull();
  });

  it('clears the draft when the list empties', () => {
    const { doc, ids } = buildFixture();
    const store = new MemoryStore();
    const s = session(doc, store);
    s.add({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' });
    expect(store.data.size).toBe(1);
    s.undo();
    expect(store.data.size).toBe(0);
  });
});

describe('record ids', () => {
  it('are the shape the server accepts, so the receipt matches the list entry', () => {
    for (let i = 0; i < 20; i++) expect(isServerId(newRecordId())).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => newRecordId())).size).toBe(200);
  });
});
