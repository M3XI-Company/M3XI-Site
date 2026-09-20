import { describe, expect, it } from 'vitest';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type { Asset, WorldDocument } from '@m3xi/world-core';
import {
  DEFAULT_CHUNK_THRESHOLD_BYTES, pickLod, planChunks, roomOrder,
} from '../assets/chunks.js';

/** FLAT with one splat chunk per room, at the sizes a real flat produces. */
function chunkedFlat(extra: Asset[] = []): WorldDocument {
  const chunks: Asset[] = FLAT.rooms.map((room, i) => ({
    id: `a_splat_${room.id}`,
    role: 'splat_chunk',
    format: 'spz',
    url: `asset://p/splat/${room.id}.spz`,
    bytes: 14_000_000 + i * 1_000_000,
    chunkKey: room.id,
    splatCount: 400_000 + i * 50_000,
  }));
  return {
    ...FLAT,
    assets: [FLAT.assets[0]!, ...chunks, ...extra],
  };
}

describe('reachability ordering', () => {
  it('ranks the current room 0 and everything through one door 1', () => {
    const order = roomOrder(FLAT, 'r_hall');
    expect(order.get('r_hall')).toBe(0);
    expect(order.get('r_kitchen')).toBe(1);
    expect(order.get('r_bath')).toBe(1);
    expect(order.get('r_bed1')).toBe(1);
    expect(order.get('r_bed2')).toBe(1);
  });

  it('ranks by doorways, not by metres', () => {
    const order = roomOrder(FLAT, 'r_kitchen');
    expect(order.get('r_kitchen')).toBe(0);
    expect(order.get('r_hall')).toBe(1);
    // The bathroom shares a wall with the kitchen but you must go via the hall.
    expect(order.get('r_bath')).toBe(2);
  });

  it('falls back to the entrance room when no current room is given', () => {
    expect(roomOrder(FLAT).get('r_hall')).toBe(0);
  });

  it('places a room with no connection at all last, deterministically', () => {
    const doc: WorldDocument = {
      ...FLAT,
      rooms: [...FLAT.rooms, {
        ...FLAT.rooms[0]!, id: 'r_orphan', stableKey: 'orphan', name: 'Orphan',
      }],
    };
    const order = roomOrder(doc, 'r_hall');
    expect(order.get('r_orphan')).toBeGreaterThan(1);
    expect(roomOrder(doc, 'r_hall').get('r_orphan')).toBe(order.get('r_orphan'));
  });
});

describe('planning what to download', () => {
  it('loads the visitor’s own room first and the far rooms last', () => {
    const plan = planChunks(chunkedFlat(), { currentRoomId: 'r_kitchen' });
    expect(plan.strategy).toBe('chunked');
    const immediate = plan.assets.filter((a) => a.phase === 'immediate');
    expect(immediate).toHaveLength(1);
    expect(immediate[0]!.roomId).toBe('r_kitchen');
    expect(immediate[0]!.reason).toContain('standing in');

    const next = plan.assets.filter((a) => a.phase === 'next').map((a) => a.roomId);
    expect(next).toContain('r_hall');
    const background = plan.assets.filter((a) => a.phase === 'background').map((a) => a.roomId);
    expect(background).toContain('r_bath');
  });

  it('keeps the plan ordered so a sequential loader does the right thing', () => {
    const plan = planChunks(chunkedFlat(), { currentRoomId: 'r_hall' });
    const orders = plan.assets.map((a) => a.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('does not refetch a chunk that is already resident', () => {
    const plan = planChunks(chunkedFlat(), {
      currentRoomId: 'r_kitchen', loaded: ['r_kitchen'],
    });
    const kitchen = plan.assets.find((a) => a.roomId === 'r_kitchen')!;
    expect(kitchen.phase).toBe('background');
    expect(kitchen.reason).toBe('already resident');
  });

  it('reports bytes for the whole property and for the blocking first fetch', () => {
    const plan = planChunks(chunkedFlat(), { currentRoomId: 'r_hall' });
    expect(plan.totalBytes).toBeGreaterThan(DEFAULT_CHUNK_THRESHOLD_BYTES);
    expect(plan.immediateBytes).toBeLessThan(plan.totalBytes / 3);
    expect(plan.reason).toContain('room chunks');
  });

  it('falls back to proxy-only when the pipeline has published no splat', () => {
    const plan = planChunks({ ...FLAT, assets: [FLAT.assets[0]!] });
    expect(plan.strategy).toBe('proxy-only');
    expect(plan.assets).toHaveLength(0);
    expect(plan.reason).toContain('no splat asset yet');
  });

  it('fetches a small single-asset world in one go', () => {
    const doc: WorldDocument = {
      ...FLAT,
      assets: [{
        id: 'a_whole', role: 'splat', format: 'spz',
        url: 'asset://p/whole.spz', bytes: 9_000_000, splatCount: 900_000,
      }],
    };
    const plan = planChunks(doc);
    expect(plan.strategy).toBe('whole');
    expect(plan.assets[0]!.phase).toBe('immediate');
    expect(plan.reason).toContain('under the');
  });

  it('keeps a whole-property asset as a last-resort fallback behind the chunks', () => {
    const plan = planChunks(chunkedFlat([{
      id: 'a_whole', role: 'splat', format: 'spz',
      url: 'asset://p/whole.spz', bytes: 70_000_000, splatCount: 2_400_000,
    }]), { currentRoomId: 'r_hall' });
    expect(plan.strategy).toBe('chunked');
    const whole = plan.assets.find((a) => a.asset.id === 'a_whole')!;
    expect(whole.phase).toBe('background');
    expect(whole.reason).toContain('only if a chunk fails');
    expect(whole.order).toBe(plan.assets.length - 1);
  });
});

describe('level of detail against a device budget', () => {
  const fine: Asset = {
    id: 'fine', role: 'splat_chunk', format: 'spz', url: 'u', chunkKey: 'r', lod: 0,
    splatCount: 2_000_000, bytes: 40_000_000,
  };
  const coarse: Asset = {
    id: 'coarse', role: 'splat_chunk', format: 'spz', url: 'u', chunkKey: 'r', lod: 1,
    splatCount: 500_000, bytes: 10_000_000,
  };

  it('takes the finest LoD that fits the budget', () => {
    expect(pickLod([coarse, fine], 3_000_000)[0]!.id).toBe('fine');
    expect(pickLod([coarse, fine], 1_000_000)[0]!.id).toBe('coarse');
  });

  it('takes the coarsest available rather than nothing when none fits', () => {
    expect(pickLod([coarse, fine], 1_000)[0]!.id).toBe('coarse');
  });

  it('never drops a chunk that has only one LoD', () => {
    expect(pickLod([fine], 1)).toHaveLength(1);
  });

  it('returns nothing for nothing', () => {
    expect(pickLod([], 10)).toHaveLength(0);
  });

  it('gives the room the visitor is in the full budget, not the leftovers', () => {
    const doc = chunkedFlat();
    const plan = planChunks(doc, { currentRoomId: 'r_bed2', splatBudget: 600_000 });
    const immediate = plan.assets.find((a) => a.phase === 'immediate')!;
    expect(immediate.roomId).toBe('r_bed2');
    expect(immediate.asset.splatCount).toBeGreaterThan(0);
  });
});
