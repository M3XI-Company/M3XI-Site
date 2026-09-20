import { describe, expect, it } from 'vitest';
import type { CorrectionChange, CorrectionRecord } from '../model/corrections.js';
import {
  MAX_CORRECTIONS_PER_REQUEST, isServerId, planWire, reconcile, toWire, type WireItem,
} from '../model/wire.js';
import { sendCorrections, type CorrectionApi } from '../model/client.js';
import { buildFixture } from './fixture.js';

/**
 * WHAT WILL STILL BE THERE TOMORROW.
 *
 * These tests are about one failure and one failure only: an operator presses
 * save, reads "15 applied", and one of their corrections is gone. Everything
 * below is a case where the preview and the saved world differ, and the
 * assertion is that the editor SAYS SO BEFORE THE SAVE rather than after it.
 */

let n = 0;
function rec(change: CorrectionChange, over: Partial<CorrectionRecord> = {}): CorrectionRecord {
  n += 1;
  return {
    id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`,
    at: '2026-09-20T11:00:00.000Z',
    by: 'sam@example.com',
    change,
    ...over,
  };
}

function itemFor(items: readonly WireItem[], recordId: string): WireItem {
  const found = items.find((i) => i.record.id === recordId);
  if (!found) throw new Error(`no wire item for ${recordId}`);
  return found;
}

function codes(item: WireItem): string[] {
  return item.caveats.map((c) => c.code);
}

describe('the wire form', () => {
  it('carries the record and the change, and never a client-stated author', () => {
    const { ids } = buildFixture();
    const record = rec({ kind: 'room.rename', roomId: ids.hall, name: 'Hallway' }, { note: 'on the door' });
    const wire = toWire(record);
    expect(wire).toEqual({ id: record.id, change: record.change, note: 'on the door' });
    // `at` and `by` are stamped by the server from its clock and the verified
    // token. Sending ours would put two authors on one record.
    expect(wire).not.toHaveProperty('at');
    expect(wire).not.toHaveProperty('by');
  });

  it('recognises the id shape the server resolves rows by', () => {
    expect(isServerId('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isServerId('r_hall')).toBe(false);
  });
});

describe('a batch with nothing wrong with it', () => {
  it('reports that every correction will be saved as the preview shows it', () => {
    const { doc, ids } = buildFixture();
    const report = planWire(doc, [
      rec({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' }),
      rec({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' }),
      rec({ kind: 'surface.flags', surfaceId: ids.bedroomWindowWall, isGlazed: true }),
    ]);
    expect(report.refused).toEqual([]);
    expect(report.caveated).toEqual([]);
    expect(report.sendable).toBe(true);
    expect(report.payload).toHaveLength(3);
    expect(report.items[0]!.persistence).toBe('row');
    expect(report.items[0]!.persists).toMatch(/keeps this name/);
    expect(report.items[0]!.sentence).toBe('Rename Hall to "Entrance hall".');
  });
});

describe('refusals this editor can see coming', () => {
  it('refuses a target the server cannot resolve, by name, before sending it', () => {
    const { doc } = buildFixture();
    const record = rec({ kind: 'room.rename', roomId: 'r_hall', name: 'Entrance hall' });
    const report = planWire(doc, [record]);
    const item = itemFor(report.items, record.id);
    expect(item.persistence).toBe('refused');
    expect(item.refusal).toMatch(/uuid/);
    expect(item.persists).toBe('Nothing. This correction will not be applied.');
    expect(report.refused).toHaveLength(1);
  });

  it('warns when the record id is not server-shaped, because the receipt will not match', () => {
    const { doc, ids } = buildFixture();
    const record = rec({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' }, { id: 'local-1' });
    const item = itemFor(planWire(doc, [record]).items, 'local-1');
    expect(item.persistence).toBe('row');
    expect(codes(item)).toContain('record.id-not-uuid');
  });

  it('sees that a room delete takes the doorways the preview keeps', () => {
    const { doc, ids } = buildFixture();
    const del = rec({ kind: 'room.delete', roomId: ids.bedroom });
    const item = itemFor(planWire(doc, [del]).items, del.id);
    expect(item.persistence).toBe('removal');
    expect(codes(item)).toContain('room.delete.openings-cascade');
  });

  it('refuses a correction to a row an earlier delete in the same list removes', () => {
    const { doc, ids } = buildFixture();
    const del = rec({ kind: 'room.delete', roomId: ids.bedroom });
    const later = rec({
      kind: 'opening.connects', openingId: ids.bedroomDoor, roomA: ids.hall, roomB: null,
    });
    const report = planWire(doc, [del, later]);
    const item = itemFor(report.items, later.id);
    // The preview keeps the doorway, so nothing local would notice. The server
    // applies the list in order with no transaction, and this one arrives at a
    // row that is already gone.
    expect(item.persistence).toBe('refused');
    expect(item.refusal).toMatch(/earlier correction/);
  });

  it('accepts the same correction when it comes BEFORE the delete', () => {
    const { doc, ids } = buildFixture();
    const first = rec({
      kind: 'opening.connects', openingId: ids.bedroomDoor, roomA: ids.hall, roomB: null,
    });
    const del = rec({ kind: 'room.delete', roomId: ids.bedroom });
    const report = planWire(doc, [first, del]);
    expect(itemFor(report.items, first.id).persistence).toBe('row');
  });
});

describe('dimensions: where the saved figure is not the previewed one', () => {
  it('says the stored area tolerance will not tighten to the instrument', () => {
    const { doc, ids } = buildFixture();
    const record = rec({
      kind: 'dimension.set',
      target: { kind: 'room.area', roomId: ids.kitchen },
      value: 24.6, method: 'site-measure', instrument: 'laser',
    });
    const item = itemFor(planWire(doc, [record]).items, record.id);
    expect(codes(item)).toContain('dimension.area.tolerance-floor');
    expect(item.persists).toMatch(/measurement record/);
  });

  it('says an opening stores the value and not the tolerance', () => {
    const { doc, ids } = buildFixture();
    const record = rec({
      kind: 'dimension.set',
      target: { kind: 'opening.width', openingId: ids.bedroomWindow },
      value: 1.42, method: 'site-measure', instrument: 'laser',
    });
    expect(codes(itemFor(planWire(doc, [record]).items, record.id)))
      .toContain('dimension.opening.tolerance-not-stored');
  });

  it('says an instrumentless site measurement is treated exactly like an estimate', () => {
    const { doc, ids } = buildFixture();
    const record = rec({
      kind: 'dimension.set',
      target: { kind: 'room.ceilingHeight', roomId: ids.hall },
      value: 2.62, method: 'site-measure', instrument: 'unknown',
    });
    expect(codes(itemFor(planWire(doc, [record]).items, record.id)))
      .toContain('dimension.instrument-undeclared');
  });
});

describe('the three where the honest answer is "not fully"', () => {
  it('says a coverage note is inserted with a server id and leaves no receipt', () => {
    const { doc, ids } = buildFixture();
    const record = rec({
      kind: 'region.mark', provenance: 'generated', roomId: ids.bedroom,
      volume: { min: [6, 0, 0], max: [7, 2.4, 1] }, reason: 'alcove never captured',
    });
    const item = itemFor(planWire(doc, [record]).items, record.id);
    expect(item.persistence).toBe('insert');
    expect(codes(item)).toEqual(['region.mark.server-id', 'region.mark.no-receipt']);
  });

  it('hands region.clear to the server, and says the document cannot decide it', () => {
    const { doc, ids } = buildFixture();
    const record = rec({ kind: 'region.clear', regionId: ids.roofVoid });
    const item = itemFor(planWire(doc, [record]).items, record.id);
    // `Region` in the world contract has no `source`, so from the document
    // alone a pipeline survey gap and an operator's note are a uuid and a
    // volume. Guessing either way would be worse than saying so.
    expect(item.persistence).toBe('server-decides');
    expect(codes(item)).toContain('region.clear.source-unknown');
    expect(codes(item)).toContain('region.clear.preview-refuses');
    expect(item.refusal).toBeNull();
  });

  it('refuses to withdraw a coverage note the server has never seen', () => {
    const { doc } = buildFixture();
    const mark = rec({
      kind: 'region.mark', provenance: 'inferred',
      volume: { min: [0, 0, 0], max: [1, 2.4, 1] }, reason: 'behind the fridge',
    });
    const clear = rec({ kind: 'region.clear', regionId: `rg_${mark.id}` });
    // Planned against the BASE world, which is where the server's rows are:
    // the marked note exists only in the preview.
    const item = itemFor(planWire(doc, [mark, clear]).items, clear.id);
    expect(item.persistence).toBe('refused');
    expect(item.refusal).toMatch(/added in this session/);
  });

  it('refuses to withdraw a coverage note that is not in the world at all', () => {
    const { doc } = buildFixture();
    const record = rec({ kind: 'region.clear', regionId: '00000000-0000-4000-8000-000000009999' });
    const item = itemFor(planWire(doc, [record]).items, record.id);
    expect(item.persistence).toBe('refused');
    expect(item.refusal).toMatch(/nothing for the server to withdraw/);
  });

  it('says a sign-off changes no row', () => {
    const { doc } = buildFixture();
    const record = rec({ kind: 'world.approve', note: 'checked on site' });
    const item = itemFor(planWire(doc, [record]).items, record.id);
    expect(item.persistence).toBe('signoff');
    expect(codes(item)).toContain('world.approve.no-row');
    expect(item.persists).toMatch(/audit log/);
  });

  it('says an entrance change leaves no receipt in the document', () => {
    const { doc, ids } = buildFixture();
    const record = rec({ kind: 'entrance.set', navNodeId: ids.bedroomNode });
    expect(codes(itemFor(planWire(doc, [record]).items, record.id)))
      .toContain('entrance.set.no-receipt');
  });
});

describe('the batch limit', () => {
  it('refuses to call a list longer than one request sendable', () => {
    const { doc, ids } = buildFixture();
    const many = Array.from({ length: MAX_CORRECTIONS_PER_REQUEST + 1 }, (_, i) =>
      rec({ kind: 'entity.label', entityId: ids.sofa, label: `sofa ${i}` }));
    const report = planWire(doc, many);
    expect(report.overBatchLimit).toBe(true);
    expect(report.sendable).toBe(false);
  });

  it('has nothing to send for an empty list', () => {
    const { doc } = buildFixture();
    expect(planWire(doc, []).sendable).toBe(false);
  });
});

describe('reading the server answer back', () => {
  it('reports a clean save plainly', () => {
    const { doc, ids } = buildFixture();
    const report = planWire(doc, [rec({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' })]);
    const result = reconcile(report, { applied: 1, rejected: [] });
    expect(result.surprises).toBe(false);
    expect(result.summary).toBe('All 1 correction was applied.');
  });

  it('names a refusal this editor did not predict', () => {
    const { doc, ids } = buildFixture();
    const report = planWire(doc, [
      rec({ kind: 'room.rename', roomId: ids.hall, name: 'Entrance hall' }),
      rec({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' }),
    ]);
    const result = reconcile(report, { applied: 1, rejected: ['entity:… is not in this world'] });
    expect(result.surprises).toBe(true);
    expect(result.summary).toMatch(/did not predict/);
  });

  it('does not call a refusal a surprise when it was predicted', () => {
    const { doc, ids } = buildFixture();
    const report = planWire(doc, [
      rec({ kind: 'room.rename', roomId: 'r_hall', name: 'Entrance hall' }),
      rec({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' }),
    ]);
    const result = reconcile(report, { applied: 1, rejected: ['missing id or field'] });
    expect(result.surprises).toBe(false);
  });
});

describe('sending', () => {
  it('sends the predicted refusals too, because the server is the authority', async () => {
    const { doc, ids } = buildFixture();
    const sent: unknown[] = [];
    const api: CorrectionApi = {
      applyCorrections: async (worldId, corrections) => {
        sent.push({ worldId, corrections });
        return { applied: 1, rejected: ['r_hall is not a uuid'] };
      },
    };
    const report = planWire(doc, [
      rec({ kind: 'room.rename', roomId: 'r_hall', name: 'Entrance hall' }),
      rec({ kind: 'entity.label', entityId: ids.sofa, label: 'corner sofa' }),
    ]);
    expect(report.refused).toHaveLength(1);

    const outcome = await sendCorrections(api, doc.id, report);
    expect((sent[0] as { corrections: unknown[] }).corrections).toHaveLength(2);
    expect(outcome.applied).toBe(1);
    expect(outcome.rejected).toHaveLength(1);
  });

  it('refuses to send nothing, and refuses to send too much', async () => {
    const { doc, ids } = buildFixture();
    const api: CorrectionApi = { applyCorrections: async () => ({ applied: 0, rejected: [] }) };
    await expect(sendCorrections(api, doc.id, planWire(doc, []))).rejects.toThrow(/no corrections/i);

    const many = Array.from({ length: MAX_CORRECTIONS_PER_REQUEST + 1 }, (_, i) =>
      rec({ kind: 'entity.label', entityId: ids.sofa, label: `sofa ${i}` }));
    await expect(sendCorrections(api, doc.id, planWire(doc, many))).rejects.toThrow(/smaller batches/);
  });
});
