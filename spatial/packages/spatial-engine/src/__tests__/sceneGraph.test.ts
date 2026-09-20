import { describe, expect, it } from 'vitest';
import { buildSceneGraph, roomFrame, SCENE_GRAPH_THRESHOLDS } from '../sceneGraph.js';
import { World } from '../world.js';
import { FLAT } from '../__fixtures__/flat.js';
import { emptyDoc, rectRoom } from '../__fixtures__/minimal.js';
import { sanitiseRing } from '../math/polygon.js';
import type { Predicate, Relationship } from '@m3xi/world-core';

const graph = buildSceneGraph(FLAT);

function find(subject: string, predicate: Predicate, object?: string): Relationship[] {
  return graph.filter((r) => r.subjectId === subject && r.predicate === predicate
    && (object === undefined || r.objectId === object));
}

function has(subject: string, predicate: Predicate, object: string): boolean {
  return find(subject, predicate, object).length > 0;
}

describe('derived scene graph', () => {
  it('derives every predicate it claims to, and never duplicates one', () => {
    const predicates = new Set(graph.map((r) => r.predicate));
    for (const p of [
      'inside', 'contains', 'adjacent_to', 'connected_to', 'near', 'far_from',
      'above', 'below', 'left_of', 'right_of', 'attached_to', 'intersects',
      'visible_from', 'blocks', 'opens_into', 'supports', 'located_on',
    ] as Predicate[]) {
      expect(predicates.has(p), `missing predicate ${p}`).toBe(true);
    }
    const keys = graph.map((r) => `${r.subjectId}|${r.predicate}|${r.objectId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never relates a thing to itself', () => {
    expect(graph.every((r) => !(r.subjectId === r.objectId && r.subjectType === r.objectType)))
      .toBe(true);
  });

  it('derives containment from the polygon, both ways', () => {
    expect(has('e_sofa', 'inside', 'r_kitchen')).toBe(true);
    expect(has('r_kitchen', 'contains', 'e_sofa')).toBe(true);
    expect(has('e_bath', 'inside', 'r_bath')).toBe(true);
    // The sofa is in the west leg of the L; the bathroom is in the notch.
    expect(has('e_sofa', 'inside', 'r_bath')).toBe(false);
  });

  it('derives adjacency from shared wall planes, with the shared run', () => {
    // Hall to kitchen: the whole 3.70 m of the kitchen's east wall.
    const a = find('r_hall', 'adjacent_to', 'r_kitchen')[0];
    expect(a).toBeDefined();
    expect(a!.value).toBeCloseTo(3.70, 6);
    // Hall to bathroom: 2.10 m.
    expect(find('r_hall', 'adjacent_to', 'r_bath')[0]!.value).toBeCloseTo(2.10, 6);
    // Bedrooms 1 and 2 share the full 4.50 m partition.
    expect(find('r_bed1', 'adjacent_to', 'r_bed2')[0]!.value).toBeCloseTo(4.50, 6);
    // The two bedrooms and the kitchen are separated by the hall entirely.
    expect(has('r_kitchen', 'adjacent_to', 'r_bed1')).toBe(false);
    // Adjacency is symmetric.
    expect(has('r_kitchen', 'adjacent_to', 'r_hall')).toBe(true);
  });

  it('derives connectivity from openings, not from adjacency', () => {
    expect(has('r_hall', 'connected_to', 'r_kitchen')).toBe(true);
    expect(has('r_hall', 'connected_to', 'r_bed2')).toBe(true);
    // The kitchen and the bathroom share a wall but no door.
    expect(has('r_kitchen', 'adjacent_to', 'r_bath')).toBe(true);
    expect(has('r_kitchen', 'connected_to', 'r_bath')).toBe(false);
    expect(has('o_door_kitchen', 'opens_into', 'r_kitchen')).toBe(true);
    expect(has('o_door_kitchen', 'opens_into', 'r_hall')).toBe(true);
  });

  it('derives near and far within a room only', () => {
    const near = find('e_bed_double', 'near', 'e_bedside_a')[0];
    expect(near).toBeDefined();
    expect(near!.value!).toBeLessThanOrEqual(SCENE_GRAPH_THRESHOLDS.nearM);
    // The fridge and the sofa are at opposite ends of the L-shaped room.
    expect(has('e_fridge', 'far_from', 'e_sofa')).toBe(true);
    // 3.2 m apart is neither near nor far: the graph says nothing about them.
    expect(has('e_bed_double', 'far_from', 'e_wardrobe')).toBe(false);
    expect(has('e_bed_double', 'near', 'e_wardrobe')).toBe(false);
    // Nothing in the bathroom is "near" anything in a bedroom, whatever the
    // centroid distance says.
    expect(find('e_bath', 'near').every((r) => r.objectId.startsWith('e_'))).toBe(true);
    expect(has('e_bath', 'near', 'e_bed_single')).toBe(false);
  });

  it('derives above and below from world +Y with a footprint overlap', () => {
    expect(has('e_coffee_table', 'above', 'e_rug')).toBe(true);
    expect(has('e_rug', 'below', 'e_coffee_table')).toBe(true);
    // The television is higher than the sofa but nowhere over it.
    expect(has('e_tv', 'above', 'e_sofa')).toBe(false);
  });

  it('derives support from contact, and picks the highest supporter', () => {
    expect(has('e_rug', 'supports', 'e_coffee_table')).toBe(true);
    expect(has('e_coffee_table', 'located_on', 'e_rug')).toBe(true);
    // Things standing straight on the floor land on the room's floor surface.
    expect(has('e_sofa', 'located_on', 's_r_kitchen_floor')).toBe(true);
    expect(has('s_r_kitchen_floor', 'supports', 'e_sofa')).toBe(true);
    // The coffee table is on the rug, not on the floor as well.
    expect(has('e_coffee_table', 'located_on', 's_r_kitchen_floor')).toBe(false);
    // A sink set into a worktop is within the 0.12 m contact tolerance the
    // pipeline uses, so it reads as standing on it -- which it does.
    expect(has('e_sink', 'located_on', 'e_worktop')).toBe(true);
  });

  it('keeps the thresholds it shares with the pipeline', () => {
    // These four are duplicated in pipeline/worldengine/stages/graph.py. If one
    // side moves and the other does not, a world's graph depends on which
    // component derived it, which is exactly the inconsistency this system is
    // supposed to make impossible.
    expect(SCENE_GRAPH_THRESHOLDS.nearM).toBe(1.5);           // NEAR_M
    expect(SCENE_GRAPH_THRESHOLDS.wallSeparationM).toBe(0.35); // ADJACENT_M
    expect(SCENE_GRAPH_THRESHOLDS.contactM).toBe(0.12);        // ON_GAP_M
    expect(SCENE_GRAPH_THRESHOLDS.supportOverlap).toBe(0.33);  // ON_OVERLAP
  });

  it('reports intersection only for boxes that really overlap', () => {
    // The sink is set into the worktop: a genuine overlap.
    expect(has('e_sink', 'intersects', 'e_worktop')).toBe(true);
    // The coffee table stands ON the rug: contact, not intersection.
    expect(has('e_coffee_table', 'intersects', 'e_rug')).toBe(false);
    for (const r of graph.filter((x) => x.predicate === 'intersects')) {
      expect(r.value!).toBeGreaterThan(0);
      expect(r.value!).toBeLessThanOrEqual(1);
    }
  });

  it('derives visibility by raycast, through doorways as well as within a room', () => {
    const own = find('e_bed_double', 'visible_from', 'r_bed1')[0];
    expect(own).toBeDefined();
    expect(own!.value).toBeCloseTo(1, 6);
    // Visible from the hall too, through the bedroom door -- but not fully.
    const through = find('e_bed_double', 'visible_from', 'r_hall')[0];
    expect(through).toBeDefined();
    expect(through!.value!).toBeGreaterThan(0);
    expect(through!.value!).toBeLessThan(1);
    // Nothing in the bathroom is visible from a bedroom: no opening joins them.
    expect(has('e_wc', 'visible_from', 'r_bed1')).toBe(false);
  });

  it('records what blocks what', () => {
    const blocks = graph.filter((r) => r.predicate === 'blocks');
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.value!).toBeGreaterThanOrEqual(SCENE_GRAPH_THRESHOLDS.blockFraction);
      expect(b.subjectId).not.toBe(b.objectId);
    }
  });

  it('attaches surfaces and openings', () => {
    expect(has('s_r_hall_floor', 'attached_to', 'r_hall')).toBe(true);
    expect(has('o_win_kitchen_w', 'attached_to', 's_r_kitchen_wall_5')).toBe(true);
  });

  it('relates rooms to their floor', () => {
    expect(has('r_hall', 'inside', 'f_ground')).toBe(true);
    expect(has('f_ground', 'contains', 'r_hall')).toBe(true);
  });

  it('grounds every derived relationship at the weakest of its participants', () => {
    // e_chest_drawers is inferred; the room it is in is reconstructed.
    for (const r of find('e_chest_drawers', 'inside')) {
      expect(r.grounding.provenance).toBe('inferred');
    }
    expect(graph.every((r) => r.grounding.confidence >= 0 && r.grounding.confidence <= 1))
      .toBe(true);
  });
});

describe('left_of / right_of frame', () => {
  it('uses the inward normal of the longest wall as forward, right = forward x up', () => {
    // A room whose longest wall is the south one (z = 0), so forward is +Z and
    // right is therefore -X.
    const ring = sanitiseRing([[0, 0], [6, 0], [6, 2], [0, 2]]);
    const frame = roomFrame(ring)!;
    expect(frame.forwardX).toBeCloseTo(0, 9);
    expect(frame.forwardZ).toBeCloseTo(1, 9);
    expect(frame.rightX).toBeCloseTo(-1, 9);
    expect(frame.rightZ).toBeCloseTo(0, 9);
  });

  it('labels sides consistently with that frame', () => {
    const doc = emptyDoc({
      rooms: [rectRoom('r_a', 0, 0, 6, 2)],
      entities: [
        {
          id: 'e_left', stableKey: 'l', label: 'left thing', category: 'furniture', roomId: 'r_a',
          centroid: [1, 0.5, 1], aabb: { min: [0.5, 0, 0.5], max: [1.5, 1, 1.5] },
          observedIn: [], grounding: { provenance: 'observed', confidence: 1 },
        },
        {
          id: 'e_right', stableKey: 'r', label: 'right thing', category: 'furniture', roomId: 'r_a',
          centroid: [5, 0.5, 1], aabb: { min: [4.5, 0, 0.5], max: [5.5, 1, 1.5] },
          observedIn: [], grounding: { provenance: 'observed', confidence: 1 },
        },
      ],
    });
    const g = buildSceneGraph(doc, { skipVisibility: true });
    // With right = -X, the entity at larger X is to the LEFT.
    expect(g.some((r) => r.subjectId === 'e_right' && r.predicate === 'left_of' && r.objectId === 'e_left'))
      .toBe(true);
    expect(g.some((r) => r.subjectId === 'e_left' && r.predicate === 'right_of' && r.objectId === 'e_right'))
      .toBe(true);
  });

  it('declines to pick a side when the offset is mostly forward', () => {
    const doc = emptyDoc({
      rooms: [rectRoom('r_a', 0, 0, 6, 6)],
      entities: [
        {
          id: 'e_a', stableKey: 'a', label: 'a', category: 'furniture', roomId: 'r_a',
          centroid: [3, 0.5, 1], aabb: { min: [2.5, 0, 0.5], max: [3.5, 1, 1.5] },
          observedIn: [], grounding: { provenance: 'observed', confidence: 1 },
        },
        {
          id: 'e_b', stableKey: 'b', label: 'b', category: 'furniture', roomId: 'r_a',
          centroid: [3.1, 0.5, 5], aabb: { min: [2.6, 0, 4.5], max: [3.6, 1, 5.5] },
          observedIn: [], grounding: { provenance: 'observed', confidence: 1 },
        },
      ],
    });
    const g = buildSceneGraph(doc, { skipVisibility: true });
    expect(g.some((r) => r.predicate === 'left_of' || r.predicate === 'right_of')).toBe(false);
  });

  it('returns null for a degenerate outline', () => {
    expect(roomFrame([])).toBeNull();
  });
});

describe('World.relationships', () => {
  it('merges declared relationships over derived ones', () => {
    const declared: Relationship = {
      subjectType: 'entity', subjectId: 'e_sofa', predicate: 'near',
      objectType: 'entity', objectId: 'e_tv', value: 99,
      grounding: { provenance: 'observed', confidence: 1 },
    };
    const w = World.fromDocument({ ...FLAT, relationships: [declared] });
    const got = w.relationships('e_sofa', 'near').find((r) => r.objectId === 'e_tv');
    expect(got!.value).toBe(99);
    // ...while still exposing everything the geometry derived.
    expect(w.relationships('e_sofa').length).toBeGreaterThan(5);
    expect(w.relationships('e_sofa', 'inside')[0]!.objectId).toBe('r_kitchen');
    expect(w.relationships('nothing')).toEqual([]);
  });
});

describe('robustness', () => {
  it('derives a graph for an empty document without throwing', () => {
    expect(buildSceneGraph(emptyDoc())).toEqual([]);
  });

  it('survives degenerate rooms and non-finite entities', () => {
    const doc = emptyDoc({
      rooms: [
        { ...rectRoom('r_ok', 0, 0, 4, 4) },
        { ...rectRoom('r_bad', 0, 0, 4, 4), polygon: [[NaN, 0], [1, 1]] },
      ],
      entities: [{
        id: 'e_bad', stableKey: 'bad', label: 'bad', category: 'other', roomId: 'r_ok',
        centroid: [NaN, 0, 0], aabb: { min: [NaN, 0, 0], max: [1, 1, 1] },
        observedIn: [], grounding: { provenance: 'inferred', confidence: 0.1 },
      }],
    });
    expect(() => buildSceneGraph(doc)).not.toThrow();
  });
});
