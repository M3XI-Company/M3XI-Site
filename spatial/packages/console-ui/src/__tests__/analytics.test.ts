/**
 * Analytics arithmetic.
 *
 * These are written with hand-computed numbers rather than snapshots, because
 * the failure this guards against is a dwell figure that is quietly wrong: an
 * agency reprices a flat on the strength of "buyers spend four minutes in the
 * kitchen", and nobody ever checks it again.
 */

import { describe, expect, it } from 'vitest';
import { aggregate, mean, median, type EventRow } from '../logic/analytics.js';
import { wholePercentShares } from '../logic/format.js';

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = (offsetS: number): string => new Date(T0 + offsetS * 1000).toISOString();

function ev(session: string, kind: string, offsetS: number, roomId?: string, payload?: Record<string, unknown>): EventRow {
  return {
    session_id: session, kind, at: at(offsetS),
    room_id: roomId ?? null,
    payload: payload ?? null,
  };
}

const ROOMS = { r_kitchen: 'Kitchen/diner', r_bed1: 'Bedroom 1', r_hall: 'Hall' };

describe('derived dwell', () => {
  // One session: hall 30s, kitchen 120s, bedroom 45s, then exit.
  const session = [
    ev('s1', 'enter', 0),
    ev('s1', 'room', 0, 'r_hall'),
    ev('s1', 'room', 30, 'r_kitchen'),
    ev('s1', 'room', 150, 'r_bed1'),
    ev('s1', 'exit', 195, 'r_bed1'),
  ];

  it('derives each room’s dwell from the gap to the next room', () => {
    const a = aggregate(session, ROOMS);
    const byId = Object.fromEntries(a.rooms.map((r) => [r.roomId, r]));
    expect(byId['r_hall']!.dwellMs).toBe(30_000);
    expect(byId['r_kitchen']!.dwellMs).toBe(120_000);
    expect(byId['r_bed1']!.dwellMs).toBe(45_000);
    expect(a.totalDwellMs).toBe(195_000);
  });

  it('orders rooms by dwell, longest first', () => {
    expect(aggregate(session, ROOMS).rooms.map((r) => r.roomId))
      .toEqual(['r_kitchen', 'r_bed1', 'r_hall']);
  });

  it('gives shares that add up to exactly 100', () => {
    const a = aggregate(session, ROOMS);
    expect(a.rooms.reduce((s, r) => s + r.dwellShare, 0)).toBe(100);
    // 120/195 = 61.5%, 45/195 = 23.1%, 30/195 = 15.4% -> 62 + 23 + 15.
    expect(a.rooms.map((r) => r.dwellShare)).toEqual([62, 23, 15]);
  });

  it('measures the session by its first and last event', () => {
    const a = aggregate(session, ROOMS);
    expect(a.medianSessionMs).toBe(195_000);
    expect(a.meanSessionMs).toBe(195_000);
    expect(a.completedSessions).toBe(1);
  });

  it('names rooms from the map and falls back to the id', () => {
    const a = aggregate(session, { r_kitchen: 'Kitchen/diner' });
    expect(a.rooms.find((r) => r.roomId === 'r_kitchen')!.name).toBe('Kitchen/diner');
    expect(a.rooms.find((r) => r.roomId === 'r_hall')!.name).toBe('r_hall');
  });
});

describe('explicit dwell events', () => {
  it('uses reported milliseconds when the session reports any, and does not double count', () => {
    const a = aggregate([
      ev('s1', 'enter', 0),
      ev('s1', 'room', 0, 'r_hall'),
      ev('s1', 'room', 30, 'r_kitchen'),
      ev('s1', 'dwell', 30, 'r_hall', { ms: 28_400 }),
      ev('s1', 'dwell', 200, 'r_kitchen', { ms: 170_000 }),
      ev('s1', 'exit', 200, 'r_kitchen'),
    ], ROOMS);
    expect(a.totalDwellMs).toBe(198_400);
    expect(a.rooms.find((r) => r.roomId === 'r_kitchen')!.dwellMs).toBe(170_000);
  });

  it('ignores a negative or non-numeric dwell payload', () => {
    const a = aggregate([
      ev('s1', 'room', 0, 'r_hall'),
      ev('s1', 'dwell', 10, 'r_hall', { ms: -5 }),
      ev('s1', 'dwell', 10, 'r_hall', { ms: 'ages' }),
      ev('s1', 'exit', 20, 'r_hall'),
    ], ROOMS);
    // Neither payload is usable, so the session falls back to derived dwell.
    expect(a.rooms[0]!.dwellMs).toBe(20_000);
  });
});

describe('revisits', () => {
  const events = [
    // s1 goes kitchen, bedroom, kitchen again.
    ev('s1', 'room', 0, 'r_kitchen'),
    ev('s1', 'room', 60, 'r_bed1'),
    ev('s1', 'room', 90, 'r_kitchen'),
    ev('s1', 'exit', 150, 'r_kitchen'),
    // s2 sees the kitchen once.
    ev('s2', 'room', 0, 'r_kitchen'),
    ev('s2', 'exit', 40, 'r_kitchen'),
  ];

  it('counts visits, sessions and revisiting sessions separately', () => {
    const kitchen = aggregate(events, ROOMS).rooms.find((r) => r.roomId === 'r_kitchen')!;
    expect(kitchen.visits).toBe(3);
    expect(kitchen.sessions).toBe(2);
    expect(kitchen.revisitSessions).toBe(1);
    expect(kitchen.revisitRate).toBeCloseTo(0.5, 10);
  });

  it('counts a room seen once as no revisit', () => {
    const bed = aggregate(events, ROOMS).rooms.find((r) => r.roomId === 'r_bed1')!;
    expect(bed.revisitSessions).toBe(0);
    expect(bed.revisitRate).toBe(0);
  });

  it('averages dwell across the sessions that saw the room', () => {
    const kitchen = aggregate(events, ROOMS).rooms.find((r) => r.roomId === 'r_kitchen')!;
    // s1: 0-60 then 90-150 = 120s. s2: 40s. Total 160s over 2 sessions.
    expect(kitchen.dwellMs).toBe(160_000);
    expect(kitchen.meanDwellPerSessionMs).toBe(80_000);
  });
});

describe('where sessions end', () => {
  it('attributes the exit to the exit event’s room', () => {
    const a = aggregate([
      ev('s1', 'room', 0, 'r_kitchen'),
      ev('s1', 'room', 30, 'r_bed1'),
      ev('s1', 'exit', 60, 'r_bed1'),
      ev('s2', 'room', 0, 'r_bed1'),
      ev('s2', 'exit', 20, 'r_bed1'),
    ], ROOMS);
    const bed = a.rooms.find((r) => r.roomId === 'r_bed1')!;
    expect(bed.exits).toBe(2);
    expect(bed.exitRate).toBe(1);
  });

  it('falls back to the last room seen when a session simply stops', () => {
    const a = aggregate([
      ev('s1', 'room', 0, 'r_kitchen'),
      ev('s1', 'room', 30, 'r_bed1'),
    ], ROOMS);
    expect(a.completedSessions).toBe(0);
    expect(a.rooms.find((r) => r.roomId === 'r_bed1')!.exits).toBe(1);
  });
});

describe('the funnel', () => {
  it('counts each stage once per session, not once per event', () => {
    const a = aggregate([
      ev('s1', 'enter', 0), ev('s1', 'ask', 10), ev('s1', 'ask', 20), ev('s1', 'measure', 30),
      ev('s2', 'enter', 0), ev('s2', 'ask', 5), ev('s2', 'lead', 60),
      ev('s3', 'enter', 0),
    ], ROOMS);
    expect(a.funnel).toMatchObject({
      sessions: 3, entered: 3, asked: 2, measured: 1, leads: 1,
    });
    expect(a.funnel.leadRate).toBeCloseTo(1 / 3, 10);
  });

  it('is all zeroes with no events at all', () => {
    const a = aggregate([], ROOMS);
    expect(a.sessions).toBe(0);
    expect(a.rooms).toEqual([]);
    expect(a.funnel.leadRate).toBe(0);
  });
});

describe('robustness', () => {
  it('discards events with no session or an unparseable timestamp, and says how many', () => {
    const a = aggregate([
      { session_id: null, kind: 'room', at: at(0), room_id: 'r_hall' },
      { session_id: 's1', kind: 'room', at: 'not a date', room_id: 'r_hall' },
      ev('s1', 'room', 0, 'r_hall'),
      ev('s1', 'exit', 10, 'r_hall'),
    ], ROOMS);
    expect(a.discardedEvents).toBe(2);
    expect(a.sessions).toBe(1);
  });

  it('fills gaps in the daily series with zeroes', () => {
    const a = aggregate([
      { session_id: 's1', kind: 'enter', at: '2026-09-01T10:00:00Z' },
      { session_id: 's2', kind: 'enter', at: '2026-09-04T10:00:00Z' },
    ], ROOMS);
    expect(a.daily).toEqual([
      { date: '2026-09-01', sessions: 1 },
      { date: '2026-09-02', sessions: 0 },
      { date: '2026-09-03', sessions: 0 },
      { date: '2026-09-04', sessions: 1 },
    ]);
  });

  it('sorts events that arrive out of order', () => {
    const a = aggregate([
      ev('s1', 'exit', 100, 'r_bed1'),
      ev('s1', 'room', 0, 'r_kitchen'),
      ev('s1', 'room', 40, 'r_bed1'),
    ], ROOMS);
    expect(a.rooms.find((r) => r.roomId === 'r_kitchen')!.dwellMs).toBe(40_000);
    expect(a.rooms.find((r) => r.roomId === 'r_bed1')!.dwellMs).toBe(60_000);
  });
});

describe('statistics', () => {
  it('takes the middle of an odd list and the mean of the middle two of an even one', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
  });

  it('makes whole percentages that sum to 100 even when the thirds do not', () => {
    expect(wholePercentShares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercentShares([1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(wholePercentShares([0, 0])).toEqual([0, 0]);
    expect(wholePercentShares([7])).toEqual([100]);
    expect(wholePercentShares([1, 2, 3, 4, 5, 6, 7]).reduce((a, b) => a + b, 0)).toBe(100);
  });
});
