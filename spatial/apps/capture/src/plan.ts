/**
 * The rooms the operator says are there.
 *
 * There is no way to discover this automatically. A browser has no position
 * and no depth, the property has not been reconstructed yet, and the previous
 * version's rooms — where one exists — describe what was filmed last time
 * rather than what is in front of somebody now. So the list is typed in, on
 * the doorstep, in about forty seconds, and everything downstream treats it as
 * the operator's assertion rather than as a measurement.
 *
 * It matters more than it looks. `quality.py` holds `navigation_continuity` at
 * exactly 1.0 — every room reachable from the entrance — and a room that was
 * declared and never entered is the one failure that is certainly a second
 * appointment, because the pipeline cannot invent a room and the console
 * cannot correct one into existence. The go/no-go screen makes that blocking.
 * The corollary is the rule below: a room that is NOT declared is simply not
 * checked, so under-declaring is quietly worse than over-declaring, and the
 * default list errs toward the rooms every property has.
 *
 * WHY A DEFAULT LIST AT ALL. Because the alternative is a blank screen and a
 * keyboard in a hallway, and what people do with that is type two rooms and
 * start walking. A prefilled hall, living room, kitchen, bathroom and one
 * bedroom is wrong for some properties and quick to correct, and being wrong
 * in a way that is visible is much better than being empty in a way that is
 * not.
 */

/** `RoomKind` from world-core, as data, so the picker can list it. */
export const ROOM_KINDS: readonly { readonly kind: string; readonly label: string }[] = [
  { kind: 'hall', label: 'Hall' },
  { kind: 'living', label: 'Living room' },
  { kind: 'kitchen', label: 'Kitchen' },
  { kind: 'dining', label: 'Dining room' },
  { kind: 'bedroom', label: 'Bedroom' },
  { kind: 'bathroom', label: 'Bathroom' },
  { kind: 'wc', label: 'WC' },
  { kind: 'landing', label: 'Landing' },
  { kind: 'stairwell', label: 'Stairwell' },
  { kind: 'utility', label: 'Utility room' },
  { kind: 'storage', label: 'Storage' },
  { kind: 'office', label: 'Office' },
  { kind: 'conservatory', label: 'Conservatory' },
  { kind: 'garage', label: 'Garage' },
  { kind: 'balcony', label: 'Balcony' },
  { kind: 'garden', label: 'Garden' },
  { kind: 'exterior', label: 'Outside' },
  { kind: 'unknown', label: 'Other' },
];

export interface DraftRoom {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly level: number;
  readonly isEntrance: boolean;
}

/**
 * The starting list.
 *
 * Every entry is a room a residential property almost certainly has, and the
 * hall is the entrance because that is what a front door opens into in the
 * overwhelming majority of them. An operator standing in a studio flat deletes
 * three chips; an operator in a four-bed adds four. Both are faster than
 * typing five from nothing, one-handed, in a hallway.
 */
export function defaultRooms(): readonly DraftRoom[] {
  return [
    { id: 'r1', name: 'Hall', kind: 'hall', level: 0, isEntrance: true },
    { id: 'r2', name: 'Living room', kind: 'living', level: 0, isEntrance: false },
    { id: 'r3', name: 'Kitchen', kind: 'kitchen', level: 0, isEntrance: false },
    { id: 'r4', name: 'Bathroom', kind: 'bathroom', level: 0, isEntrance: false },
    { id: 'r5', name: 'Bedroom 1', kind: 'bedroom', level: 0, isEntrance: false },
  ];
}

/** The next free id, so adding a room after deletions cannot collide. */
export function nextRoomId(rooms: readonly DraftRoom[]): string {
  let highest = 0;
  for (const room of rooms) {
    const n = Number(/^r(\d+)$/.exec(room.id)?.[1] ?? 0);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `r${highest + 1}`;
}

/**
 * A new room, named after the kind and numbered if there is already one.
 *
 * "Bedroom 2" rather than "Bedroom" again, because two rooms with the same
 * name make the chips on the live screen ambiguous — and a chip an operator
 * taps by mistake attributes a whole room's footage to the wrong place, which
 * `room_completeness` then reports about the wrong room.
 */
export function addRoom(rooms: readonly DraftRoom[], kind: string): readonly DraftRoom[] {
  const label = ROOM_KINDS.find((k) => k.kind === kind)?.label ?? 'Room';
  const sameKind = rooms.filter((r) => r.kind === kind).length;
  const name = sameKind === 0 ? label : `${label} ${sameKind + 1}`;
  const level = rooms.length > 0 ? Math.max(...rooms.map((r) => r.level)) : 0;
  return [...rooms, {
    id: nextRoomId(rooms),
    name,
    kind,
    // A new room joins the highest level already in the list, because the
    // common case for adding one is "and there is another bedroom up here".
    level: kind === 'garden' || kind === 'exterior' || kind === 'garage' ? 0 : level,
    isEntrance: rooms.length === 0,
  }];
}

export function removeRoom(rooms: readonly DraftRoom[], id: string): readonly DraftRoom[] {
  const left = rooms.filter((r) => r.id !== id);
  // The entrance cannot simply vanish: `buildRoute` falls back to the first
  // room, and `capture.loop_closure` is measured against the entrance being
  // revisited. Promoting the first remaining room keeps both meaningful.
  if (left.length > 0 && !left.some((r) => r.isEntrance)) {
    return left.map((r, i) => (i === 0 ? { ...r, isEntrance: true } : r));
  }
  return left;
}

/** Exactly one entrance, always. Setting a new one clears the old. */
export function setEntrance(rooms: readonly DraftRoom[], id: string): readonly DraftRoom[] {
  if (!rooms.some((r) => r.id === id)) return rooms;
  return rooms.map((r) => ({ ...r, isEntrance: r.id === id }));
}

export function setLevel(rooms: readonly DraftRoom[], id: string, level: number): readonly DraftRoom[] {
  const clamped = Math.max(-2, Math.min(6, Math.round(level)));
  return rooms.map((r) => (r.id === id ? { ...r, level: clamped } : r));
}

export function renameRoom(rooms: readonly DraftRoom[], id: string, name: string): readonly DraftRoom[] {
  const trimmed = name.trim().slice(0, 40);
  if (trimmed.length === 0) return rooms;
  return rooms.map((r) => (r.id === id ? { ...r, name: trimmed } : r));
}

export interface PlanProblem {
  readonly roomId: string | null;
  readonly message: string;
}

/**
 * What is wrong with the plan, in the operator's words.
 *
 * Returns problems rather than a boolean so the screen can put each one next
 * to the thing it is about. Every one of them blocks starting, because each
 * produces a capture that is wrong in a way nothing downstream can correct.
 */
export function planProblems(rooms: readonly DraftRoom[]): readonly PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (rooms.length === 0) {
    problems.push({ roomId: null, message: 'Add at least one room before you start.' });
    return problems;
  }
  const entrances = rooms.filter((r) => r.isEntrance);
  if (entrances.length === 0) {
    problems.push({
      roomId: null,
      message: 'Mark the room the front door opens into. The walk starts and ends there, and that '
        + 'is what gives the reconstruction a loop to close.',
    });
  } else if (entrances.length > 1) {
    problems.push({
      roomId: null,
      message: 'Only one room can be the entrance. The route is built outward from it.',
    });
  }
  const seen = new Map<string, string>();
  for (const room of rooms) {
    const key = room.name.trim().toLowerCase();
    if (key.length === 0) {
      problems.push({ roomId: room.id, message: 'Every room needs a name you can recognise mid-walk.' });
      continue;
    }
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push({
        roomId: room.id,
        message: `Two rooms are called "${room.name}". Give them different names, or the chips on `
          + 'the walking screen cannot be told apart and a room’s footage ends up filed under '
          + 'the wrong one.',
      });
    } else {
      seen.set(key, room.id);
    }
  }
  return problems;
}

/**
 * An estimate of how long the walk will take, in seconds.
 *
 * `buildRoute` computes the real one from the pipeline's own displacement
 * targets; this exists for the moment BEFORE a route has been built, on the
 * planning screen, where the operator is deciding whether they have time. It
 * is labelled as a rough figure wherever it is shown.
 */
export function roughWalkSeconds(rooms: readonly DraftRoom[]): number {
  const levels = new Set(rooms.map((r) => r.level)).size;
  // Forty seconds a room, eight seconds a doorway, ten seconds a staircase,
  // and ten seconds standing at the front door at each end.
  return rooms.length * 40 + Math.max(0, rooms.length - 1) * 8 + Math.max(0, levels - 1) * 10 + 20;
}
