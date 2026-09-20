import { describe, expect, it } from 'vitest';

import { isDefensible } from '@m3xi/spatial-engine';

import { FLAT, hallView, kitchenView, makeTools } from './harness.js';
import { TOOL_NAMES } from '../types.js';

describe('tool surface', () => {
  it('implements every tool named in the contract', () => {
    const { tools } = makeTools();
    for (const name of TOOL_NAMES) {
      expect(typeof (tools as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(TOOL_NAMES.length).toBe(21);
  });

  // --- context tools -------------------------------------------------------

  it('get_current_camera reports the pose and the room it is standing in', () => {
    const { tools } = makeTools();
    const r = tools.get_current_camera();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.position).toEqual([2.2, 1.6, 2.6]);
    expect(r.data.roomId).toBe('r_kitchen');
  });

  it('get_current_room finds the L-shaped kitchen from inside its long leg', () => {
    const { tools } = makeTools();
    const r = tools.get_current_room();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe('r_kitchen');
    expect(r.grounding.provenance).toBe('reconstructed');
  });

  it('get_current_room refuses when the camera is outside every room', () => {
    const { tools } = makeTools({ position: [50, 1.6, 50], orientation: [0, 0, 0, 1], fovRad: 1 });
    const r = tools.get_current_room();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('not_established');
  });

  it('get_visible_entities returns only what a ray can actually reach', () => {
    const { tools } = makeTools();
    const r = tools.get_visible_entities();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.data.entities.map((e) => e.id);
    // Standing in the kitchen looking at the sitting end: the sofa is visible,
    // and nothing in another room is.
    expect(ids).toContain('e_sofa');
    for (const id of ids) {
      expect(FLAT.entities.find((e) => e.id === id)?.roomId).toBe('r_kitchen');
    }
  });

  // --- lookup tools --------------------------------------------------------

  it('get_entity resolves by id and by label', () => {
    const { tools } = makeTools();
    expect(tools.get_entity('e_sofa').ok).toBe(true);
    const byLabel = tools.get_entity('sofa');
    expect(byLabel.ok).toBe(true);
    if (byLabel.ok) expect(byLabel.data.id).toBe('e_sofa');
  });

  it('get_entity refuses an unknown name rather than guessing a neighbour', () => {
    const { tools } = makeTools();
    const r = tools.get_entity('jacuzzi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('not_found');
  });

  it('get_entity surfaces ambiguity instead of picking one', () => {
    const { tools } = makeTools();
    const r = tools.get_entity('bed');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe('ambiguous');
      expect(r.refusal.evidenceIds?.length).toBeGreaterThan(1);
    }
  });

  it('find_entities filters by room, label and category', () => {
    const { tools } = makeTools();
    const chairs = tools.find_entities({ label: 'dining chair' });
    expect(chairs.ok && chairs.data.length).toBe(4);
    const bathroom = tools.find_entities({ roomId: 'r_bath' });
    expect(bathroom.ok && bathroom.data.length).toBe(3);
    const appliances = tools.find_entities({ category: 'appliance', roomId: 'r_kitchen' });
    expect(appliances.ok && appliances.data.map((e) => e.label).sort())
      .toEqual(['fridge freezer', 'oven', 'television']);
  });

  it('find_entities returns an empty, grounded result for something absent', () => {
    const { tools } = makeTools();
    const r = tools.find_entities({ label: 'dishwasher' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toHaveLength(0);
  });

  it('get_room resolves by name, kind and via a contained entity', () => {
    const { tools } = makeTools();
    expect(tools.get_room('Bathroom').ok && tools.get_room('Bathroom')).toBeTruthy();
    const byKind = tools.get_room('bathroom');
    expect(byKind.ok && byKind.data.id).toBe('r_bath');
    const viaEntity = tools.get_room('bookshelf');
    expect(viaEntity.ok && viaEntity.data.id).toBe('r_bed2');
  });

  // --- geometry ------------------------------------------------------------

  it('get_geometry returns a footprint for a room and a box for an entity', () => {
    const { tools } = makeTools();
    const room = tools.get_geometry('r_kitchen');
    expect(room.ok).toBe(true);
    if (room.ok) {
      expect(room.data.type).toBe('room');
      expect(room.data.polygon).toHaveLength(6); // the L
      expect(room.data.ceilingY).toBeCloseTo(2.4, 5);
    }
    const sofa = tools.get_geometry('e_sofa');
    expect(sofa.ok).toBe(true);
    if (sofa.ok) {
      expect(sofa.data.type).toBe('entity');
      expect(sofa.data.aabb?.min[0]).toBeCloseTo(0.55, 5);
    }
  });

  it('get_dimensions measures a room in its own frame with a tolerance', () => {
    const { tools } = makeTools();
    const r = tools.get_dimensions('Bedroom 2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.width.value).toBeCloseTo(4.5, 3);
    expect(r.data.depth.value).toBeCloseTo(2.7, 3);
    expect(r.data.height.value).toBeCloseTo(2.4, 3);
    // Never a bare number: unit, standard and tolerance travel with it.
    expect(r.data.width.unit).toBe('m');
    expect(r.data.width.tolerance).toBeGreaterThan(0);
    expect(r.data.area?.unit).toBe('m2');
  });

  it('get_dimensions uses the oriented box for a rotated entity', () => {
    const { tools } = makeTools();
    const r = tools.get_dimensions('desk chair');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The chair is a 0.55 m cube yawed 0.44 rad; its AABB is wider than it is.
    expect(r.data.width.value).toBeCloseTo(0.55, 5);
    expect(r.data.depth.value).toBeCloseTo(0.55, 5);
  });

  it('get_dimensions reports an opening from its declared quantities', () => {
    const { tools } = makeTools();
    const r = tools.get_dimensions('o_front_door');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.width.value).toBeCloseTo(0.9, 5);
      expect(r.data.height.value).toBeCloseTo(2.04, 5);
    }
  });

  // --- scene graph ---------------------------------------------------------

  it('get_relationships returns derived geometry facts, not declared ones', () => {
    const { tools } = makeTools();
    expect(FLAT.relationships).toHaveLength(0);
    const r = tools.get_relationships('r_kitchen');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const preds = new Set(r.data.relationships.map((x) => x.predicate));
    expect(preds.has('contains')).toBe(true);
    expect(preds.has('adjacent_to') || preds.has('connected_to')).toBe(true);
  });

  it('get_relationships can filter to one predicate', () => {
    const { tools } = makeTools();
    const r = tools.get_relationships('r_hall', 'connected_to');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.relationships.length).toBeGreaterThan(0);
    for (const rel of r.data.relationships) expect(rel.predicate).toBe('connected_to');
  });

  // --- measurement ---------------------------------------------------------

  it('measure_distance carries a standard, a tolerance and a nearest-face gap', () => {
    const { tools } = makeTools();
    const r = tools.measure_distance('sofa', 'television');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.unit).toBe('m');
    expect(r.data.standard).toBe('CLEAR-INTERNAL');
    expect(r.data.tolerance).toBeGreaterThan(0);
    expect(typeof r.data.basis?.gapM).toBe('number');
    expect(r.data.value).toBeGreaterThan(0.5);
  });

  it('measure_distance accepts a bare point as one end', () => {
    const { tools } = makeTools();
    // The sofa's centroid sits at eye level minus its half-height, so a point
    // directly above it is 1.175 m away, not zero.
    const r = tools.measure_distance('e_sofa', [1.5, 1.6, 4.75]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.value).toBeCloseTo(1.175, 3);
  });

  it('measure_area matches the fixture geometry and declares its standard', () => {
    const { tools } = makeTools();
    const r = tools.measure_area('r_kitchen');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.value).toBeCloseTo(4.1 * 3.7 + 2.3 * 2.2, 4);
    expect(r.data.standard).toBe('RICS-COMP-GIA');
    expect(isDefensible(r.data)).toBe(true);
  });

  // --- rays, visibility, collision ----------------------------------------

  it('raycast hits what the camera is pointed at and names it', () => {
    const { tools } = makeTools();
    const r = tools.raycast();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hit).toBe(true);
    expect(r.data.distanceM).toBeGreaterThan(0);
    expect(r.data.entityId ?? r.data.surfaceId).toBeTruthy();
  });

  it('check_visibility reports the blocker by name when the line is broken', () => {
    const { tools } = makeTools(hallView());
    const r = tools.check_visibility('e_sofa');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.visible).toBe(false);
    expect(r.data.blockedBy).toBeTruthy();
  });

  it('check_collision reports what a box would hit', () => {
    const { tools } = makeTools();
    const r = tools.check_collision({
      obb: { centre: [1.5, 0.4, 4.75], half: [0.5, 0.4, 0.3], quat: [0, 0, 0, 1] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as unknown as { collides: boolean; withIds: string[] };
    expect(d.collides).toBe(true);
    expect(d.withIds).toContain('e_sofa');
  });

  it('check_collision doubles as a fit test and explains a failure', () => {
    const { tools } = makeTools();
    const fits = tools.check_collision({ roomId: 'r_bed2', sizeM: [1.4, 0.6, 2.0] });
    expect(fits.ok).toBe(true);
    if (fits.ok) expect((fits.data as { fits: boolean }).fits).toBe(true);

    const tooBig = tools.check_collision({ roomId: 'r_bath', sizeM: [3, 0.8, 3] });
    expect(tooBig.ok).toBe(true);
    if (tooBig.ok) {
      const d = tooBig.data as { fits: boolean; reason?: string };
      expect(d.fits).toBe(false);
      expect(d.reason).toMatch(/does not fit|no (valid|position)/i);
    }
  });

  // --- navigation ----------------------------------------------------------

  it('find_path routes through the hall rather than through a wall', () => {
    const { tools } = makeTools();
    const r = tools.find_path('r_kitchen', 'r_bed2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.roomSequence).toContain('r_hall');
    expect(r.data.length.value).toBeGreaterThan(5);
    expect(r.data.nodes.length).toBeGreaterThan(3);
  });

  it('move_camera emits a waypoint command and updates the agent pose', () => {
    const { tools, commands, view } = makeTools();
    const before = view.position;
    const r = tools.move_camera('r_bed1');
    expect(r.ok).toBe(true);
    const move = commands.find((c) => c.kind === 'moveCamera');
    expect(move).toBeTruthy();
    if (move && move.kind === 'moveCamera') {
      expect(move.waypoints.length).toBeGreaterThan(1);
      expect(move.durationMs).toBeGreaterThan(0);
      expect(move.intent).toBe('navigation');
    }
    expect(view.position).not.toEqual(before);
    expect(view.roomId).toBe('r_bed1');
  });

  // --- side effects --------------------------------------------------------

  it('highlight_entity emits a command and refuses when nothing matches', () => {
    const { tools, commands } = makeTools();
    const r = tools.highlight_entity(['sofa', 'television']);
    expect(r.ok).toBe(true);
    expect(commands.filter((c) => c.kind === 'highlightEntities')).toHaveLength(1);
    expect(tools.highlight_entity(['unicorn']).ok).toBe(false);
  });

  it('select_entity updates the viewer state so "it" resolves next turn', () => {
    const { tools, view, commands } = makeTools();
    const r = tools.select_entity('coffee table');
    expect(r.ok).toBe(true);
    expect(view.selectedEntityId).toBe('e_coffee_table');
    expect(commands.some((c) => c.kind === 'selectEntity')).toBe(true);
  });

  // --- surfaces, summary, provenance --------------------------------------

  it('inspect_surface reports glazing and reflectivity', () => {
    const { tools } = makeTools();
    const mirror = tools.inspect_surface('s_r_bath_wall_0');
    expect(mirror.ok).toBe(true);
    if (mirror.ok) expect(mirror.data.isReflective).toBe(true);
    const glazed = tools.inspect_surface('s_r_kitchen_wall_5');
    expect(glazed.ok).toBe(true);
    if (glazed.ok) {
      expect(glazed.data.isGlazed).toBe(true);
      expect(glazed.data.openings.map((o) => o.id)).toContain('o_win_kitchen_w');
    }
  });

  it('query_world counts the property correctly', () => {
    const { tools } = makeTools();
    const r = tools.query_world();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.roomCount).toBe(5);
    expect(r.data.bedroomCount).toBe(2);
    expect(r.data.bathroomCount).toBe(1);
    expect(r.data.qualityVerdict).toBe('review');
    expect(r.data.measurementStandard).toBe('RICS-COMP-GIA');
  });

  it('get_provenance distinguishes observed, inferred and generated', () => {
    const { tools } = makeTools();
    const observed = tools.get_provenance('e_sofa');
    expect(observed.ok && observed.data.provenance).toBe('observed');
    if (observed.ok) {
      expect(observed.data.sources.length).toBeGreaterThan(0);
      // The sofa was seen; the room outline around it was reconstructed. Both
      // facts survive, and the result's own grounding takes the weaker.
      expect(observed.data.contextProvenance).toBe('reconstructed');
      expect(observed.grounding.provenance).toBe('reconstructed');
    }

    const inferred = tools.get_provenance('chest of drawers');
    expect(inferred.ok && inferred.data.provenance).toBe('inferred');

    const generated = tools.get_provenance([10.3, 1.0, 2.7]);
    expect(generated.ok).toBe(true);
    if (generated.ok) {
      expect(generated.data.provenance).toBe('generated');
      expect(generated.data.observed).toBe(false);
      expect(generated.data.regionIds).toContain('rg_bed1_far_corner');
    }
  });

  it('every tool result carries a grounding', () => {
    const { tools } = makeTools();
    const results = [
      tools.get_current_camera(), tools.get_current_room(), tools.get_visible_entities(),
      tools.get_entity('e_sofa'), tools.find_entities({ roomId: 'r_bath' }),
      tools.get_room('r_hall'), tools.get_geometry('e_sofa'), tools.get_dimensions('r_bed2'),
      tools.get_relationships('r_kitchen'), tools.measure_distance('e_sofa', 'e_tv'),
      tools.measure_area('r_bath'), tools.raycast(), tools.check_visibility('e_sofa'),
      tools.check_collision({ roomId: 'r_bed2', sizeM: [1, 1, 1] }),
      tools.find_path('r_kitchen', 'r_hall'), tools.highlight_entity(['e_sofa']),
      tools.select_entity('e_sofa'), tools.inspect_surface('s_r_bath_wall_0'),
      tools.query_world(), tools.get_provenance('e_sofa'),
    ];
    for (const r of results) {
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) {
        expect(r.grounding.provenance).toBeTruthy();
        expect(r.grounding.confidence).toBeGreaterThanOrEqual(0);
        expect(r.grounding.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});
