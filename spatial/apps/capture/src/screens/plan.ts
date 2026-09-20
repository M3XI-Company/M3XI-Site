/**
 * The rooms, the route, and the warning.
 *
 * This is the last screen where anything can be changed cheaply, so it carries
 * three things and puts them in the order they cost.
 *
 *   THE ROOMS, because a room that is declared and never entered is blocking
 *   on the go/no-go and a room that is never declared is never checked at all.
 *   Editable, pre-filled, and the entrance is a radio group because exactly
 *   one room can be it.
 *
 *   THE ROUTE, from `buildRoute`, one line of reasoning per step. Shown, not
 *   enforced: the app has no idea where the operator is and pretending to
 *   direct them turn by turn would be a lie with a progress bar on it. It is
 *   read once at the front door and then remembered.
 *
 *   THE WARNING, last and unmissable, because it is the thing that most often
 *   ends a capture early: the phone locking, or the operator switching apps.
 *   No web page can record in the background, and saying so once here is worth
 *   more than any amount of recovery code afterwards.
 */

import {
  buildRoute, mirrorCapabilityStatement, type PlannedRoom, type Route,
} from '@m3xi/capture-core';
import { button, clockText, el, focusHeading, note } from '../ui/dom.js';
import {
  ROOM_KINDS, addRoom, planProblems, removeRoom, renameRoom, roughWalkSeconds, setEntrance,
  setLevel, type DraftRoom,
} from '../plan.js';
import { BACKGROUND_WARNING } from '../recorder.js';

export interface PlanScreen {
  readonly root: HTMLElement;
  focus(): void;
}

/** Draft rooms are the operator's words; `PlannedRoom` is what the core reads. */
export function toPlannedRooms(rooms: readonly DraftRoom[]): readonly PlannedRoom[] {
  return rooms.map((r): PlannedRoom => ({
    id: r.id,
    name: r.name,
    // `kind` is chosen from ROOM_KINDS, which is world-core's RoomKind union
    // written out as data. The cast is where that correspondence is asserted.
    kind: r.kind as PlannedRoom['kind'],
    level: r.level,
    isEntrance: r.isEntrance,
  }));
}

function levelName(level: number): string {
  if (level === 0) return 'Ground';
  if (level < 0) return level === -1 ? 'Basement' : `Basement ${-level}`;
  return level === 1 ? 'First' : `Floor ${level}`;
}

function routeList(route: Route): HTMLElement {
  const list = el('ol', {});
  for (const step of route.steps) {
    list.appendChild(el('li', {},
      el('strong', {}, step.title),
      el('p', { class: 'c-small c-muted', style: 'margin:2px 0 0' }, step.why),
    ));
  }
  return list;
}

export function renderPlan(options: {
  readonly propertyTitle: string;
  readonly worldVersion: number;
  readonly rooms: readonly DraftRoom[];
  readonly onRoomsChange: (rooms: readonly DraftRoom[]) => void;
  readonly onStart: () => void;
  readonly onBack: () => void;
}): PlanScreen {
  const heading = el('h1', {}, options.propertyTitle);
  const rooms = options.rooms;
  const problems = planProblems(rooms);
  const problemFor = (id: string): string | null =>
    problems.find((p) => p.roomId === id)?.message ?? null;

  const roomList = el('ul', { style: 'list-style:none;padding:0;margin:0' });
  rooms.forEach((room, index) => {
    const nameId = `name-${room.id}`;
    const levelId = `level-${room.id}`;
    const problem = problemFor(room.id);

    const name = el('input', {
      id: nameId, class: 'c-input', type: 'text', value: room.name, maxlength: '40',
      'aria-invalid': problem !== null,
      onchange: (event: Event) => {
        options.onRoomsChange(renameRoom(rooms, room.id, (event.target as HTMLInputElement).value));
      },
    });

    const level = el('select', {
      id: levelId, class: 'c-select',
      onchange: (event: Event) => {
        options.onRoomsChange(setLevel(rooms, room.id, Number((event.target as HTMLSelectElement).value)));
      },
    });
    for (const value of [-1, 0, 1, 2, 3]) {
      const option = el('option', { value: String(value) }, levelName(value));
      if (value === room.level) option.selected = true;
      level.appendChild(option);
    }

    const entrance = el('input', {
      type: 'radio', name: 'entrance', id: `entrance-${room.id}`, value: room.id,
      checked: room.isEntrance,
      onchange: () => options.onRoomsChange(setEntrance(rooms, room.id)),
    });

    roomList.appendChild(el('li', { style: 'margin:0 0 22px' },
      el('label', { for: nameId }, `Room ${index + 1} name`),
      name,
      problem ? el('p', { class: 'c-hint', style: 'color:var(--act)' }, problem) : null,
      el('div', { style: 'display:grid;gap:10px;margin-top:10px' },
        el('div', {}, el('label', { for: levelId }, 'Floor'), level),
        el('label', { for: `entrance-${room.id}`, style: 'display:flex;gap:10px;align-items:center;min-height:56px' },
          entrance, 'The front door opens into this room'),
        button({
          label: `Remove ${room.name}`,
          onClick: () => options.onRoomsChange(removeRoom(rooms, room.id)),
        }),
      ),
    ));
  });

  const kindSelect = el('select', { class: 'c-select', id: 'add-kind', 'aria-label': 'Kind of room to add' });
  for (const kind of ROOM_KINDS) {
    kindSelect.appendChild(el('option', { value: kind.kind }, kind.label));
  }

  const globalProblems = problems.filter((p) => p.roomId === null);
  const route = rooms.length > 0 ? buildRoute(toPlannedRooms(rooms)) : null;

  const start = button({
    label: 'Start the walk',
    sublabel: route ? `About ${clockText(route.estimatedSeconds)} of filming` : undefined,
    emphasis: 'primary',
    disabled: problems.length > 0,
    onClick: options.onStart,
  });

  const root = el('div', {},
    heading,
    el('p', { class: 'c-muted' }, `Version ${options.worldVersion}. Roughly `
      + `${clockText(roughWalkSeconds(rooms))} of walking, once you add the doorways.`),

    el('section', { 'aria-labelledby': 'rooms-h' },
      el('h2', { id: 'rooms-h' }, 'Rooms in this property'),
      el('p', { class: 'c-small' },
        'A room you list and do not film stops the whole build — the pipeline cannot invent a '
        + 'room and nobody in the office can add one afterwards. A room you leave off this list '
        + 'is never checked at all. List what is actually there.'),
      roomList,
      el('div', { style: 'display:grid;gap:10px;margin-bottom:24px' },
        el('label', { for: 'add-kind' }, 'Add a room'),
        kindSelect,
        button({
          label: 'Add it',
          onClick: () => options.onRoomsChange(addRoom(rooms, kindSelect.value)),
        }),
      ),
      ...globalProblems.map((p) => note('act', p.message)),
    ),

    route ? el('section', { 'aria-labelledby': 'route-h' },
      el('h2', { id: 'route-h' }, 'Suggested order'),
      el('p', { class: 'c-small c-muted' },
        'Read this once now. Nothing on the walking screen will repeat it, because this phone '
        + 'cannot tell where you are and a turn-by-turn instruction it cannot verify would be '
        + 'worse than none.'),
      routeList(route),
    ) : null,

    el('section', { 'aria-labelledby': 'warn-h' },
      el('h2', { id: 'warn-h' }, 'Before you start'),
      note('act', BACKGROUND_WARNING, 'Stay in this app'),
      note('info',
        'The walkthrough is saved to this phone every few seconds as you film, so an interruption '
        + 'costs the rest of the property and not what you have already walked.'),
      // The analyser's own statement about what it cannot measure lives here
      // rather than on the walking screen: it is four sentences, and that
      // screen has room for one. The two buttons it asks for are the
      // highest-value controls in the app.
      note('advise', mirrorCapabilityStatement(), 'Mirrors and glass'),
      el('p', { class: 'c-small' },
        'There are buttons for both on the walking screen. A mirror invents a room that is not '
        + 'there and a window blows out; they are the two failure modes that most often cost a '
        + 'rebuild, and one tap as you pass is all it takes to record them.'),
    ),

    el('div', { class: 'c-actions' },
      start,
      button({ label: 'Choose a different property', emphasis: 'quiet', onClick: options.onBack }),
    ),
  );

  return { root, focus: () => focusHeading(heading) };
}
