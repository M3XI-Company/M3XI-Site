import { describe, expect, it } from 'vitest';
import { World } from '../world.js';
import { FLAT } from '../__fixtures__/flat.js';
import { emptyDoc, rectRoom } from '../__fixtures__/minimal.js';
import type { NavEdge, NavNode, Vec3 } from '@m3xi/world-core';

/**
 * A hand-built six-room world.
 *
 *   r1 -- r2 -- r3
 *          |
 *         r4 -- r5        r6  (no edges at all)
 *
 * Rooms are 4 m squares in a row so every distance is checkable by hand, and
 * r6 exists but nothing connects to it.
 */
function sixRooms(extraEdges: NavEdge[] = []): World {
  const centres: Record<string, Vec3> = {
    r1: [2, 0, 2], r2: [8, 0, 2], r3: [14, 0, 2],
    r4: [8, 0, 8], r5: [14, 0, 8], r6: [20, 0, 8],
  };
  const rooms = Object.entries(centres).map(([id, c]) =>
    rectRoom(id, c[0] - 2, c[2] - 2, c[0] + 2, c[2] + 2));
  const nodes: NavNode[] = Object.entries(centres).map(([id, position]) => ({
    id: `n_${id}`, roomId: id, position, clearance: 1, isEntrance: id === 'r1', isViewpoint: true,
  }));
  const link = (a: string, b: string, kind: NavEdge['kind'] = 'door'): NavEdge => {
    const pa = centres[a.slice(2)]!;
    const pb = centres[b.slice(2)]!;
    return { a, b, cost: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), kind };
  };
  const edges: NavEdge[] = [
    link('n_r1', 'n_r2'),
    link('n_r2', 'n_r3'),
    link('n_r2', 'n_r4'),
    link('n_r4', 'n_r5'),
    ...extraEdges,
  ];
  return World.fromDocument(emptyDoc({ rooms, nav: { nodes, edges } }));
}

describe('findPath on a hand-built six-room graph', () => {
  const w = sixRooms();

  it('walks the only route there is, and measures it', () => {
    const p = w.findPath('r1', 'r5');
    expect(p).not.toBeNull();
    expect(p!.nodes.map((n) => n.id)).toEqual(['n_r1', 'n_r2', 'n_r4', 'n_r5']);
    // 6 + 6 + 6 metres, by construction.
    expect(p!.length.value).toBeCloseTo(18, 9);
    expect(p!.length.unit).toBe('m');
    // Three independent segments: 20 mm * sqrt(3).
    expect(p!.length.tolerance).toBeCloseTo(20 * Math.sqrt(3), 6);
  });

  it('returns null for a room nothing connects to', () => {
    expect(w.findPath('r1', 'r6')).toBeNull();
    expect(w.findPath('r6', 'r1')).toBeNull();
  });

  it('returns a zero-length path from a room to itself', () => {
    const p = w.findPath('r3', 'r3');
    expect(p!.nodes.map((n) => n.id)).toEqual(['n_r3']);
    expect(p!.length.value).toBe(0);
  });

  it('accepts node ids, room ids and bare points', () => {
    expect(w.findPath('n_r1', 'n_r3')!.nodes).toHaveLength(3);
    expect(w.findPath([2.2, 0, 2.2], [13.5, 0, 2.5])!.nodes.map((n) => n.id))
      .toEqual(['n_r1', 'n_r2', 'n_r3']);
  });

  it('returns null for ids and points it cannot place', () => {
    expect(w.findPath('nope', 'r1')).toBeNull();
    expect(w.findPath([NaN, 0, 0], 'r1')).toBeNull();
  });

  it('takes the cheaper route when a shortcut is expensive', () => {
    // A direct r1 -> r5 link that is geometrically short but costs a fortune:
    // A* must still prefer the three-hop route, which costs 18.
    const withShortcut = sixRooms([{ a: 'n_r1', b: 'n_r5', cost: 40, kind: 'stair' }]);
    const p = withShortcut.findPath('r1', 'r5')!;
    expect(p.nodes).toHaveLength(4);

    const withCheap = sixRooms([{ a: 'n_r1', b: 'n_r5', cost: 5, kind: 'stair' }]);
    const q = withCheap.findPath('r1', 'r5')!;
    expect(q.nodes.map((n) => n.id)).toEqual(['n_r1', 'n_r5']);
    // The geometric length is still the real distance, not the edge's cost.
    expect(q.length.value).toBeCloseTo(Math.hypot(12, 6), 9);
  });

  it('returns null when the graph is empty', () => {
    const bare = World.fromDocument(emptyDoc({ rooms: [rectRoom('r_a', 0, 0, 4, 4)] }));
    expect(bare.findPath('r_a', 'r_a')).toBeNull();
  });
});

describe('findPath on the flat', () => {
  const w = World.fromDocument(FLAT);

  it('routes from the kitchen to the second bedroom through the hall', () => {
    const p = w.findPath('r_kitchen', 'r_bed2')!;
    const ids = p.nodes.map((n) => n.id);
    expect(ids[0]).toBe('n_kitchen_a');
    expect(ids[ids.length - 1]).toBe('n_bed2_a');
    expect(ids).toContain('n_door_kitchen');
    expect(ids).toContain('n_door_bed2');
    expect(p.length.value).toBeGreaterThan(8);
    expect(p.length.value).toBeLessThan(12);
  });

  it('routes from an entity to an entity', () => {
    const p = w.findPath('e_sofa', 'e_bath')!;
    expect(p.nodes[0]!.id).toBe('n_kitchen_b');
    expect(p.nodes[p.nodes.length - 1]!.id).toBe('n_bath_a');
  });

  it('is symmetric in length', () => {
    const there = w.findPath('r_bed1', 'r_bath')!.length.value;
    const back = w.findPath('r_bath', 'r_bed1')!.length.value;
    expect(there).toBeCloseTo(back, 9);
  });
});
