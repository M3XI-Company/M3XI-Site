/**
 * Room planning.
 *
 * The assertions worth having are the invariants the rest of the app leans on:
 * exactly one entrance at all times (the route is built outward from it and
 * loop closure is measured against revisiting it), ids that never collide
 * after a deletion, and two rooms never sharing a name — because a chip tapped
 * by mistake files a whole room's footage under the wrong heading and
 * `room_completeness` then reports about the wrong room.
 */

import { describe, expect, it } from 'vitest';
import {
  ROOM_KINDS, addRoom, defaultRooms, nextRoomId, planProblems, removeRoom, renameRoom,
  roughWalkSeconds, setEntrance, setLevel,
} from './plan.js';

describe('defaultRooms', () => {
  it('starts with one entrance, and it is the hall', () => {
    const rooms = defaultRooms();
    const entrances = rooms.filter((r) => r.isEntrance);
    expect(entrances).toHaveLength(1);
    expect(entrances[0]!.kind).toBe('hall');
  });

  it('is a valid plan out of the box', () => {
    expect(planProblems(defaultRooms())).toEqual([]);
  });
});

describe('nextRoomId', () => {
  it('does not reuse an id after a deletion', () => {
    const rooms = defaultRooms();
    const afterDelete = removeRoom(rooms, 'r3');
    expect(nextRoomId(afterDelete)).toBe('r6');
  });

  it('starts at r1 for an empty plan', () => {
    expect(nextRoomId([])).toBe('r1');
  });
});

describe('addRoom', () => {
  it('numbers the second room of a kind rather than repeating the name', () => {
    const rooms = addRoom(defaultRooms(), 'bedroom');
    expect(rooms[rooms.length - 1]!.name).toBe('Bedroom 2');
  });

  it('names the first room of a kind without a number', () => {
    const rooms = addRoom(defaultRooms(), 'office');
    expect(rooms[rooms.length - 1]!.name).toBe('Office');
  });

  it('joins the highest level in the plan, which is where somebody is adding', () => {
    const upstairs = setLevel(defaultRooms(), 'r5', 1);
    const added = addRoom(upstairs, 'bedroom');
    expect(added[added.length - 1]!.level).toBe(1);
  });

  it('puts outdoor rooms on the ground whatever floor was last edited', () => {
    const upstairs = setLevel(defaultRooms(), 'r5', 2);
    for (const kind of ['garden', 'exterior', 'garage']) {
      const added = addRoom(upstairs, kind);
      expect(added[added.length - 1]!.level).toBe(0);
    }
  });

  it('makes the first room of an empty plan the entrance', () => {
    const rooms = addRoom([], 'living');
    expect(rooms[0]!.isEntrance).toBe(true);
    expect(planProblems(rooms)).toEqual([]);
  });

  it('offers every kind the world model has a name for', () => {
    expect(ROOM_KINDS.map((k) => k.kind)).toContain('stairwell');
    expect(new Set(ROOM_KINDS.map((k) => k.kind)).size).toBe(ROOM_KINDS.length);
  });
});

describe('removeRoom', () => {
  it('promotes a new entrance when the entrance is deleted', () => {
    const left = removeRoom(defaultRooms(), 'r1');
    expect(left.filter((r) => r.isEntrance)).toHaveLength(1);
    expect(left[0]!.isEntrance).toBe(true);
  });

  it('leaves the entrance alone when another room goes', () => {
    const left = removeRoom(defaultRooms(), 'r3');
    expect(left.find((r) => r.isEntrance)!.id).toBe('r1');
  });

  it('can empty the plan', () => {
    let rooms = defaultRooms();
    for (const r of defaultRooms()) rooms = removeRoom(rooms, r.id);
    expect(rooms).toEqual([]);
  });
});

describe('setEntrance', () => {
  it('moves the entrance and leaves exactly one', () => {
    const rooms = setEntrance(defaultRooms(), 'r3');
    expect(rooms.filter((r) => r.isEntrance).map((r) => r.id)).toEqual(['r3']);
  });

  it('ignores an id that is not in the plan rather than clearing the entrance', () => {
    const rooms = setEntrance(defaultRooms(), 'nope');
    expect(rooms.filter((r) => r.isEntrance)).toHaveLength(1);
  });
});

describe('setLevel', () => {
  it('rounds and clamps to floors a building has', () => {
    expect(setLevel(defaultRooms(), 'r2', 1.6).find((r) => r.id === 'r2')!.level).toBe(2);
    expect(setLevel(defaultRooms(), 'r2', 99).find((r) => r.id === 'r2')!.level).toBe(6);
    expect(setLevel(defaultRooms(), 'r2', -9).find((r) => r.id === 'r2')!.level).toBe(-2);
  });
});

describe('renameRoom', () => {
  it('trims and caps the length', () => {
    const rooms = renameRoom(defaultRooms(), 'r2', `  ${'x'.repeat(60)}  `);
    expect(rooms.find((r) => r.id === 'r2')!.name).toHaveLength(40);
  });

  it('refuses to leave a room nameless', () => {
    const rooms = renameRoom(defaultRooms(), 'r2', '   ');
    expect(rooms.find((r) => r.id === 'r2')!.name).toBe('Living room');
  });
});

describe('planProblems', () => {
  it('refuses an empty plan', () => {
    expect(planProblems([])).toHaveLength(1);
    expect(planProblems([])[0]!.message).toMatch(/at least one room/);
  });

  it('refuses a plan with no entrance', () => {
    const rooms = defaultRooms().map((r) => ({ ...r, isEntrance: false }));
    expect(planProblems(rooms)[0]!.message).toMatch(/front door/);
  });

  it('refuses a plan with two entrances', () => {
    const rooms = defaultRooms().map((r, i) => ({ ...r, isEntrance: i < 2 }));
    expect(planProblems(rooms)[0]!.message).toMatch(/Only one room/);
  });

  it('refuses two rooms with the same name, whatever the case', () => {
    const rooms = [...defaultRooms(), {
      id: 'r6', name: 'kitchen', kind: 'kitchen', level: 0, isEntrance: false,
    }];
    const problems = planProblems(rooms);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.roomId).toBe('r6');
    expect(problems[0]!.message).toMatch(/Two rooms are called/);
  });

  it('points at the room a problem belongs to, so the screen can say where', () => {
    const rooms = [...defaultRooms(), { id: 'r6', name: '  ', kind: 'wc', level: 0, isEntrance: false }];
    expect(planProblems(rooms)[0]).toMatchObject({ roomId: 'r6' });
  });
});

describe('roughWalkSeconds', () => {
  it('grows with rooms and with floors', () => {
    const flat = defaultRooms();
    const maisonette = setLevel(flat, 'r5', 1);
    expect(roughWalkSeconds(maisonette)).toBeGreaterThan(roughWalkSeconds(flat));
    expect(roughWalkSeconds(addRoom(flat, 'bedroom'))).toBeGreaterThan(roughWalkSeconds(flat));
  });

  it('clears the 45 second floor the pipeline refuses below, even for one room', () => {
    expect(roughWalkSeconds([{ id: 'r1', name: 'Studio', kind: 'living', level: 0, isEntrance: true }]))
      .toBeGreaterThan(45);
  });
});
