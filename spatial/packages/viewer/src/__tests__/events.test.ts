import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewerEventRecorder, type ViewerEvent } from '../events/session.js';

/**
 * WHAT THE VIEWER REPORTS, AND WHAT IT KEEPS TO ITSELF.
 *
 * `POST /wv-view/events` was written, limited, clamped and tested, and then
 * nothing called it for a release, so every analytics screen in the console
 * read zero rows. The half that was missing is this one, and the failure mode
 * it has to be protected from is not "no events" -- that one is obvious the
 * first time anybody looks at the page -- but WRONG events, which look exactly
 * like right ones until an agency makes a decision on them.
 *
 * Three of those are pinned below:
 *
 *   a room re-entered that was never left  invents a revisit, and the revisit
 *                                          rate is half of what the room table
 *                                          is for;
 *   a last room never closed               loses the dwell in the room people
 *                                          leave from, which is the other half;
 *   a second exit                          counts one departure twice in the
 *                                          completion rate, and 409s the host.
 *
 * The clock is injected throughout so that "how long they stayed" is asserted
 * as a number rather than as `expect.any(Number)`. A dwell that is merely
 * present is not evidence of anything.
 */

interface Recorded {
  readonly events: ViewerEvent[];
  readonly recorder: ViewerEventRecorder;
  advance(ms: number): void;
}

function recording(mode: 'visitor' | 'operator' | 'embed' = 'visitor'): Recorded {
  const events: ViewerEvent[] = [];
  let t = Date.parse('2026-09-20T12:00:00.000Z');
  const recorder = new ViewerEventRecorder({
    onEvent: (e) => { events.push(e); },
    mode,
    now: () => t,
  });
  return { events, recorder, advance: (ms: number) => { t += ms; } };
}

const kinds = (events: readonly ViewerEvent[]): string[] => events.map((e) => e.kind);

afterEach(() => { vi.restoreAllMocks(); });

describe('a tour opens once and says where it opened', () => {
  it('reports the session, then the room the visitor is standing in', () => {
    const r = recording();
    r.recorder.start('r_hall');

    expect(kinds(r.events)).toEqual(['enter', 'room']);
    expect(r.events[0]).toMatchObject({ kind: 'enter', roomId: 'r_hall', payload: { mode: 'visitor' } });
    // The spawn room is a visit like any other. Naming it only on `enter`
    // would make the entrance the one room in the property nobody visited,
    // because the console counts visits from `room` events.
    expect(r.events[1]).toMatchObject({ kind: 'room', roomId: 'r_hall' });
  });

  it('tells embed traffic apart from a direct visit', () => {
    const r = recording('embed');
    r.recorder.start('r_hall');
    expect(r.events[0]).toMatchObject({ payload: { mode: 'embed' } });
  });

  it('opens without a room when the visitor spawned outside every polygon', () => {
    const r = recording();
    r.recorder.start(undefined);
    expect(kinds(r.events)).toEqual(['enter']);
    expect(r.events[0]!.roomId).toBeUndefined();
  });

  it('cannot be opened twice', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.recorder.start('r_kitchen');
    expect(kinds(r.events)).toEqual(['enter', 'room']);
  });

  it('reports nothing before it has opened', () => {
    const r = recording();
    r.recorder.enteredRoom('r_kitchen');
    r.recorder.measured('distance', 'defensible');
    r.recorder.asked('how big is it');
    r.recorder.exit();
    expect(r.events).toEqual([]);
  });
});

describe('entering and leaving a room', () => {
  it('closes the room it left with the time actually spent there', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(7_500);
    r.recorder.enteredRoom('r_kitchen');

    expect(kinds(r.events)).toEqual(['enter', 'room', 'dwell', 'room']);
    expect(r.events[2]).toMatchObject({ kind: 'dwell', roomId: 'r_hall', payload: { ms: 7_500 } });
    expect(r.events[3]).toMatchObject({ kind: 'room', roomId: 'r_kitchen' });
  });

  it('measures each room from when it was entered, not from the start of the tour', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(1_000);
    r.recorder.enteredRoom('r_kitchen');
    r.advance(30_000);
    r.recorder.enteredRoom('r_bed');

    const dwells = r.events.filter((e) => e.kind === 'dwell');
    expect(dwells.map((e) => [e.roomId, (e.payload as { ms: number }).ms]))
      .toEqual([['r_hall', 1_000], ['r_kitchen', 30_000]]);
  });

  it('does not invent a revisit when a flight ends where it began', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(4_000);
    // `onRoomChanged` runs at the end of every flight, including one that
    // walked to a viewpoint inside the room the visitor was already in.
    r.recorder.enteredRoom('r_hall');

    expect(kinds(r.events)).toEqual(['enter', 'room']);
    expect(r.recorder.currentRoomId).toBe('r_hall');
  });

  it('counts a genuine return as a second visit', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(2_000);
    r.recorder.enteredRoom('r_kitchen');
    r.advance(9_000);
    r.recorder.enteredRoom('r_hall');

    const visits = r.events.filter((e) => e.kind === 'room').map((e) => e.roomId);
    expect(visits).toEqual(['r_hall', 'r_kitchen', 'r_hall']);
  });

  it('closes a room when the camera leaves it for nowhere in particular', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(3_000);
    // An operator stepping into unsurveyed space is in no room at all. The
    // time in the hall is still real and is still reported; there is simply
    // no new room to report an entry into.
    r.recorder.enteredRoom(undefined);

    expect(kinds(r.events)).toEqual(['enter', 'room', 'dwell']);
    expect(r.events[2]).toMatchObject({ roomId: 'r_hall', payload: { ms: 3_000 } });
    expect(r.recorder.currentRoomId).toBeUndefined();
  });
});

describe('a tour ends once, and says where', () => {
  it('closes the last room and reports the exit from it', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(5_000);
    r.recorder.enteredRoom('r_kitchen');
    r.advance(11_000);
    r.recorder.exit();

    expect(kinds(r.events)).toEqual(['enter', 'room', 'dwell', 'room', 'dwell', 'exit']);
    // The room they left from is the room with the highest exit rate, and
    // without this dwell it would be the one room with no time against it.
    expect(r.events[4]).toMatchObject({ kind: 'dwell', roomId: 'r_kitchen', payload: { ms: 11_000 } });
    expect(r.events[5]).toMatchObject({
      kind: 'exit', roomId: 'r_kitchen', payload: { ms: 16_000 },
    });
  });

  it('reports exactly one exit however many times the tour is torn down', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(1_000);
    // What really happens: the page is hidden, the host disposes of the
    // viewer, and the element is removed. Three endings, one departure.
    r.recorder.exit();
    r.recorder.exit();
    r.recorder.exit();

    expect(r.events.filter((e) => e.kind === 'exit')).toHaveLength(1);
    expect(r.events.filter((e) => e.kind === 'dwell')).toHaveLength(1);
    expect(r.recorder.active).toBe(false);
  });

  it('goes quiet after the tour has ended', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.recorder.exit();
    const after = r.events.length;

    r.recorder.enteredRoom('r_kitchen');
    r.recorder.measured('area', 'defensible');
    r.recorder.asked('is the boiler new');
    expect(r.events).toHaveLength(after);
  });

  it('exits from nowhere when the visitor was in no room', () => {
    const r = recording();
    r.recorder.start(undefined);
    r.advance(800);
    r.recorder.exit();

    expect(kinds(r.events)).toEqual(['enter', 'exit']);
    expect(r.events[1]).toMatchObject({ payload: { ms: 800 } });
    expect(r.events[1]!.roomId).toBeUndefined();
  });
});

describe('measuring and asking', () => {
  it('reports the tool used and whether the figure was defensible', () => {
    const r = recording();
    r.recorder.start('r_kitchen');
    r.recorder.measured('area', 'defensible');
    r.recorder.measured('clearance', 'indicative');

    const measures = r.events.filter((e) => e.kind === 'measure');
    expect(measures).toHaveLength(2);
    expect(measures[0]).toMatchObject({
      roomId: 'r_kitchen', payload: { tool: 'area', status: 'defensible' },
    });
    expect(measures[1]).toMatchObject({ payload: { tool: 'clearance', status: 'indicative' } });
  });

  it('reports that a question was asked and never what it was', () => {
    const r = recording();
    r.recorder.start('r_bed');
    r.recorder.asked('  is there damp behind the wardrobe?  ');

    const ask = r.events.find((e) => e.kind === 'ask')!;
    // 34: the question as typed, trimmed. Not the padding around it.
    expect(ask).toMatchObject({ roomId: 'r_bed', payload: { chars: 34 } });
    // The question is about somebody's home and belongs to the person asking.
    expect(JSON.stringify(r.events)).not.toContain('damp');
  });
});

describe('the package reports, and does nothing else', () => {
  it('emits nothing when the host supplied no onEvent', () => {
    let calls = 0;
    // The sink exists in this test and is deliberately NOT handed over: a
    // viewer with no `onEvent` is the default, and the default is silence.
    const sink = (): void => { calls += 1; };
    void sink;

    const recorder = new ViewerEventRecorder({ now: () => 0 });
    recorder.start('r_hall');
    recorder.enteredRoom('r_kitchen');
    recorder.measured('distance', 'defensible');
    recorder.asked('anything');
    recorder.exit();

    expect(calls).toBe(0);
    // It still keeps its own books, so turning reporting on mid-flight would
    // not produce a tour that had apparently started in the kitchen.
    expect(recorder.active).toBe(false);
  });

  it('opens no connection of its own', () => {
    const fetchSpy = vi.fn();
    const beaconSpy = vi.fn();
    // `navigator` is a getter-only global in Node, so it is stubbed rather
    // than assigned; both are restored by unstubAllGlobals below.
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });
    try {
      const r = recording();
      r.recorder.start('r_hall');
      r.advance(1_000);
      r.recorder.enteredRoom('r_kitchen');
      r.recorder.exit();
      // The whole reason the hook exists rather than a `reportUrl` option: an
      // agency embedding this on their own origin cannot have it talking to
      // ours, and a self-hosted document has nowhere to talk to.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(beaconSpy).not.toHaveBeenCalled();
      expect(r.events.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the tour running when the host callback throws', () => {
    const seen: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const recorder = new ViewerEventRecorder({
      now: () => 0,
      onEvent: (e) => {
        seen.push(e.kind);
        // A host that posts events can be handed a full queue, a dead network
        // or its own bug. None of those is a reason to stop showing somebody
        // a property.
        if (e.kind === 'room') throw new Error('the host page is having a day');
      },
    });

    expect(() => {
      recorder.start('r_hall');
      recorder.enteredRoom('r_kitchen');
      recorder.exit();
    }).not.toThrow();
    expect(seen).toEqual(['enter', 'room', 'dwell', 'room', 'dwell', 'exit']);
  });

  it('timestamps every event from the clock it was given', () => {
    const r = recording();
    r.recorder.start('r_hall');
    r.advance(60_000);
    r.recorder.exit();

    expect(r.events.map((e) => e.at)).toEqual([
      '2026-09-20T12:00:00.000Z',
      '2026-09-20T12:00:00.000Z',
      '2026-09-20T12:01:00.000Z',
      '2026-09-20T12:01:00.000Z',
    ]);
  });
});
