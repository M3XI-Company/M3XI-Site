/**
 * The suggested walking order.
 *
 * The route exists because the difference between a capture that reconstructs
 * and one that does not is mostly the order things were filmed in, and that
 * order is not obvious to anybody who has not read the pose stage. Four rules
 * produce it and each is tested for the consequence it prevents:
 *
 *   circulation first     halls and landings touch everything else, so filming
 *                         them first means every later room joins something
 *                         already registered rather than a drifting chain.
 *   upward before down    a flight filmed going up looks along the stairs; going
 *                         down, the operator's feet fill the frame.
 *   outdoors last         the indoor-to-outdoor exposure ramp is the worst in
 *                         the capture, and bilagrid.py absorbs a ramp far better
 *                         at the end of a sequence than in the middle of one.
 *   back to the door      ending where you started gives bundle adjustment a
 *                         loop to close, which is what stops the last room
 *                         drifting away from the first.
 */

import { describe, expect, it } from 'vitest';
import type { PlannedRoom } from '../types.js';
import { buildRoute, orderRooms } from '../route.js';
import { DOORWAY_CROSS_S, ENTRANCE_DWELL_S, roomDisplacementTarget } from '../thresholds.js';

const HOUSE: PlannedRoom[] = [
  { id: 'living', name: 'Living room', kind: 'living', level: 0, isEntrance: false },
  { id: 'garden', name: 'Garden', kind: 'garden', level: 0, isEntrance: false },
  { id: 'bed1', name: 'Bedroom 1', kind: 'bedroom', level: 1, isEntrance: false },
  { id: 'hall', name: 'Hall', kind: 'hall', level: 0, isEntrance: true },
  { id: 'landing', name: 'Landing', kind: 'landing', level: 1, isEntrance: false },
  { id: 'cellar', name: 'Cellar', kind: 'storage', level: -1, isEntrance: false },
];

describe('orderRooms', () => {
  it('starts at the entrance whatever order the operator listed things in', () => {
    expect(orderRooms(HOUSE)[0]!.id).toBe('hall');
  });

  it('films circulation before the rooms it connects, on each level', () => {
    const ids = orderRooms(HOUSE).map((r) => r.id);
    expect(ids.indexOf('landing')).toBeLessThan(ids.indexOf('bed1'));
  });

  it('goes up before it goes down', () => {
    const ids = orderRooms(HOUSE).map((r) => r.id);
    expect(ids.indexOf('bed1')).toBeLessThan(ids.indexOf('cellar'));
  });

  it('leaves outdoors until last, whatever level it is on', () => {
    const ids = orderRooms(HOUSE).map((r) => r.id);
    expect(ids[ids.length - 1]).toBe('garden');
  });

  it('keeps the operator\'s own order within a rank', () => {
    // They listed the rooms in an order that probably reflects the property,
    // and second-guessing it adds nothing.
    const flat: PlannedRoom[] = [
      { id: 'hall', name: 'Hall', kind: 'hall', level: 0, isEntrance: true },
      { id: 'b', name: 'B', kind: 'bedroom', level: 0, isEntrance: false },
      { id: 'a', name: 'A', kind: 'bedroom', level: 0, isEntrance: false },
    ];
    expect(orderRooms(flat).map((r) => r.id)).toEqual(['hall', 'b', 'a']);
  });

  it('copes with no declared entrance and with no rooms at all', () => {
    const noEntrance = HOUSE.map((r) => ({ ...r, isEntrance: false }));
    expect(orderRooms(noEntrance)).toHaveLength(HOUSE.length);
    expect(orderRooms([])).toEqual([]);
  });
});

describe('buildRoute', () => {
  const route = buildRoute(HOUSE);

  it('opens and closes at the front door', () => {
    expect(route.steps[0]!.kind).toBe('entrance');
    expect(route.steps[0]!.seconds).toBe(ENTRANCE_DWELL_S);
    const last = route.steps[route.steps.length - 1]!;
    expect(last.kind).toBe('close');
    expect(last.roomId).toBe('hall');
  });

  it('puts a stairs step in wherever the level changes', () => {
    // Three of them for this house, and the third is the one that is easy to
    // forget: the walk goes ground, first, basement, and then back up to the
    // ground floor for the garden, because outdoors is filmed last whatever
    // level it is on. A flight climbed with the camera off is a storey the
    // tour cannot walk between, so the step has to be there in both directions.
    const stairs = route.steps.filter((s) => s.kind === 'stairs');
    expect(stairs.map((s) => s.title)).toEqual([
      'Take the stairs to the first floor',
      'Take the stairs to the basement',
      'Take the stairs to the ground floor',
    ]);
    for (const s of stairs) expect(s.why).toContain('storey the tour cannot walk between');
  });

  it('crosses a doorway deliberately between rooms on the same level', () => {
    const doorways = route.steps.filter((s) => s.kind === 'doorway');
    expect(doorways.length).toBeGreaterThan(0);
    for (const d of doorways) expect(d.seconds).toBe(DOORWAY_CROSS_S);
  });

  it('gives every room a step and one line of reasoning', () => {
    const rooms = route.steps.filter((s) => s.kind === 'room');
    expect(rooms).toHaveLength(HOUSE.length);
    for (const s of route.steps) {
      expect(s.why.length).toBeGreaterThan(20);
      // One line, not a manual: an operator who has to read three paragraphs at
      // the front door will stop reading them by the third property.
      expect(s.why).not.toContain('\n');
    }
  });

  it('tells the operator to walk the perimeter rather than turn in the middle', () => {
    const living = route.steps.find((s) => s.kind === 'room' && s.roomId === 'living')!;
    expect(living.title).toContain('perimeter');
    expect(living.why).toContain('turning on the spot');
  });

  it('gives the garden its own reason, because it is not an interior room', () => {
    const garden = route.steps.find((s) => s.kind === 'room' && s.roomId === 'garden')!;
    expect(garden.why).toContain('outside stays attached to the inside');
  });

  it('estimates a time from the travel each room needs, not from a guess', () => {
    const target = roomDisplacementTarget(HOUSE.length);
    const roomStep = route.steps.find((s) => s.kind === 'room')!;
    expect(roomStep.seconds).toBeGreaterThan(target);
    expect(route.estimatedSeconds).toBe(route.steps.reduce((n, s) => n + s.seconds, 0));
    // A six-room house should come out in minutes, not hours: the five-to-ten
    // minutes a property is the entire economic argument for phone capture.
    expect(route.estimatedSeconds).toBeLessThan(15 * 60);
  });

  it('numbers the steps consecutively from zero', () => {
    route.steps.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('produces something usable for a one-room studio', () => {
    const studio: PlannedRoom[] = [
      { id: 'main', name: 'Studio', kind: 'living', level: 0, isEntrance: true },
    ];
    const r = buildRoute(studio);
    expect(r.steps.map((s) => s.kind)).toEqual(['entrance', 'room', 'close']);
  });

  it('does not invent a front door for a plan with no rooms', () => {
    const r = buildRoute([]);
    expect(r.steps.filter((s) => s.kind === 'close')).toHaveLength(0);
    expect(r.steps[0]!.roomId).toBeNull();
  });
});
