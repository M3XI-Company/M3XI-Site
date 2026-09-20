/**
 * A suggested walking order.
 *
 * The route exists because the difference between a capture that reconstructs
 * and one that does not is mostly the order things were filmed in, and that
 * order is not obvious. Four rules produce it, and each earns its place:
 *
 *   Perimeter, not the middle. A camera turning on the spot accumulates plenty
 *   of flow — `select_by_overlap` is perfectly happy with it — and no baseline
 *   at all, so nothing triangulates and pose ends up with one room floating.
 *   Walking the perimeter facing the walls gives both.
 *
 *   Through doorways slowly. A doorway is the only place two rooms are visible
 *   at once, so it is the only place the pose graph can join them.
 *   quality.py wants `navigation_continuity` at exactly 1.0 — every room
 *   reachable from the entrance — and a doorway crossed at a normal stride
 *   yields about three usable frames to carry that join.
 *
 *   Circulation first. Halls, landings and stairwells touch everything else,
 *   so filming them first means every later room connects to something already
 *   registered rather than to a chain of rooms that has been drifting.
 *
 *   Back to the front door. Ending where you started gives bundle adjustment a
 *   loop to close, which is what stops the last room drifting away from the
 *   first. Three seconds standing still there costs nothing — the selector
 *   discards the near-identical frames as redundant — and buys a dense cluster
 *   of mutually matchable views at the one place the walk returns to.
 *
 * Each step carries exactly one line of reasoning. The app shows a route, not
 * a manual: an operator who has to read three paragraphs at the front door
 * will stop reading them by the third property.
 */

import type { PlannedRoom, Route, RouteStep } from './types.js';
import {
  DOORWAY_CROSS_S, ENTRANCE_DWELL_S, SECONDS_PER_IMAGE_WIDTH, roomDisplacementTarget,
} from './thresholds.js';

/** Rooms that connect other rooms. Filmed first on their level. */
const CIRCULATION = new Set(['hall', 'landing', 'stairwell']);
/**
 * Filmed last, whatever level they are on. Outdoor exposure is two or three
 * stops away from indoor, so the auto-exposure ramp between the two is the
 * worst in the capture, and bilagrid.py absorbs a ramp far better at the end
 * of a sequence than in the middle of one.
 */
const OUTDOOR = new Set(['garden', 'balcony', 'exterior']);

function levelName(level: number): string {
  if (level === 0) return 'ground floor';
  if (level < 0) return level === -1 ? 'basement' : `basement ${-level}`;
  return level === 1 ? 'first floor' : `floor ${level}`;
}

/** Order rooms: entrance, then by level outward from it, circulation first. */
export function orderRooms(rooms: readonly PlannedRoom[]): PlannedRoom[] {
  const entrance = rooms.find((r) => r.isEntrance) ?? rooms[0] ?? null;
  const startLevel = entrance ? entrance.level : 0;
  const rest = rooms.filter((r) => r !== entrance);

  const rank = (r: PlannedRoom): number => {
    const outdoor = OUTDOOR.has(r.kind) ? 1 : 0;
    // Distance from the entrance's level, upward before downward: stairs are
    // easier to film going up (the camera looks along the flight) than down,
    // where the operator's own feet fill the frame.
    const levelGap = r.level >= startLevel
      ? (r.level - startLevel) * 2
      : (startLevel - r.level) * 2 + 1;
    const circulation = CIRCULATION.has(r.kind) ? 0 : 1;
    return outdoor * 1000 + levelGap * 10 + circulation;
  };

  const sorted = rest.slice().sort((a, b) => {
    const d = rank(a) - rank(b);
    // Stable within a rank: the operator listed the rooms in an order that
    // probably reflects the property, and second-guessing it adds nothing.
    return d !== 0 ? d : rooms.indexOf(a) - rooms.indexOf(b);
  });
  return entrance ? [entrance, ...sorted] : sorted;
}

export function buildRoute(rooms: readonly PlannedRoom[]): Route {
  const ordered = orderRooms(rooms);
  const steps: RouteStep[] = [];
  const perRoomWidths = roomDisplacementTarget(rooms.length);
  const roomSeconds = Math.round(perRoomWidths * SECONDS_PER_IMAGE_WIDTH);
  let index = 0;
  const push = (s: Omit<RouteStep, 'index'>): void => {
    steps.push({ ...s, index });
    index += 1;
  };

  const entrance = ordered[0] ?? null;

  push({
    kind: 'entrance',
    roomId: entrance ? entrance.id : null,
    title: entrance ? `Start at the front door, in ${entrance.name}` : 'Start at the front door',
    why: 'Standing still here for a moment gives the walk a place to come back to and close '
      + 'the loop against.',
    seconds: ENTRANCE_DWELL_S,
  });

  let previousLevel = entrance ? entrance.level : 0;
  ordered.forEach((room, i) => {
    if (room.level !== previousLevel) {
      push({
        kind: 'stairs',
        roomId: null,
        title: `Take the stairs to the ${levelName(room.level)}`,
        why: 'Film the flight itself on the way — a staircase with no frames in it is a '
          + 'storey the tour cannot walk between.',
        seconds: 8,
      });
      previousLevel = room.level;
    } else if (i > 0) {
      push({
        kind: 'doorway',
        roomId: room.id,
        title: `Through the doorway into ${room.name}`,
        why: 'Cross it slowly: the doorway is the only place both rooms are in shot, which '
          + 'is the only place they can be joined.',
        seconds: DOORWAY_CROSS_S,
      });
    }

    push({
      kind: 'room',
      roomId: room.id,
      title: `${room.name} — walk the perimeter`,
      why: OUTDOOR.has(room.kind)
        ? 'Keep the building in shot on one side so the outside stays attached to the inside.'
        : 'Follow the walls facing outward, not a circle in the middle — turning on the spot '
          + 'gives the frames nothing to measure depth from.',
      seconds: roomSeconds,
    });
  });

  if (entrance) {
    push({
      kind: 'close',
      roomId: entrance.id,
      title: `Back to the front door in ${entrance.name}`,
      why: 'Re-filming the first view last is what stops the last room drifting away from '
        + 'the first.',
      seconds: ENTRANCE_DWELL_S,
    });
  }

  return {
    steps,
    estimatedSeconds: steps.reduce((sum, s) => sum + s.seconds, 0),
  };
}
