/**
 * Viewer analytics, aggregated from `wv_event`.
 *
 * The signal an agency can act on is room-level: which room holds people, which
 * room they go back to, and which room they were in when they left. "1,204
 * views" changes nothing; "every second visitor returns to the kitchen and
 * two-thirds leave from the second bedroom" changes the photographs, the
 * description and sometimes the price. So the room table is the page and the
 * headline counts are the caption.
 *
 * The event contract this reads (written by the viewer, see the report):
 *   enter    session began; one per session
 *   room     the visitor entered `room_id` at `at`
 *   dwell    optional explicit dwell, `payload.ms` milliseconds in `room_id`
 *   measure  the visitor took a measurement
 *   ask      the visitor asked the agent a question
 *   lead     the visitor left their details
 *   exit     the session ended; `room_id` is where they were
 *
 * Dwell is taken from explicit `dwell` events when a session has any, and
 * derived from the gaps between `room` events when it does not. The two are
 * never mixed within one session, because that double-counts.
 */

import { wholePercentShares } from './format.js';

export interface EventRow {
  readonly id?: number | string;
  readonly session_id?: string | null;
  readonly kind: string;
  readonly room_id?: string | null;
  readonly payload?: Readonly<Record<string, unknown>> | null;
  readonly at: string;
}

export interface RoomStat {
  readonly roomId: string;
  readonly name: string;
  readonly dwellMs: number;
  /** Whole percent of total dwell. The column sums to exactly 100. */
  readonly dwellShare: number;
  /** Total entries into this room across all sessions. */
  readonly visits: number;
  /** Sessions that entered this room at least once. */
  readonly sessions: number;
  /** Sessions that entered it more than once. */
  readonly revisitSessions: number;
  /** revisitSessions / sessions, 0..1. */
  readonly revisitRate: number;
  /** Mean dwell per session that saw the room. */
  readonly meanDwellPerSessionMs: number;
  /** Sessions whose last event was in this room. */
  readonly exits: number;
  /** exits / sessions that reached this room, 0..1. */
  readonly exitRate: number;
}

export interface Funnel {
  readonly sessions: number;
  readonly entered: number;
  readonly asked: number;
  readonly measured: number;
  readonly leads: number;
  /** leads / sessions, 0..1. */
  readonly leadRate: number;
}

export interface AnalyticsSummary {
  readonly sessions: number;
  readonly totalDwellMs: number;
  readonly meanSessionMs: number;
  readonly medianSessionMs: number;
  /** Sessions that produced a real `exit` event rather than just stopping. */
  readonly completedSessions: number;
  readonly rooms: readonly RoomStat[];
  readonly funnel: Funnel;
  /** Sessions per calendar day, ascending, gaps filled with zero. */
  readonly daily: readonly { readonly date: string; readonly sessions: number }[];
  /** Events whose `at` did not parse, or which named no session. */
  readonly discardedEvents: number;
}

const EMPTY_FUNNEL: Funnel = {
  sessions: 0, entered: 0, asked: 0, measured: 0, leads: 0, leadRate: 0,
};

export const EMPTY_ANALYTICS: AnalyticsSummary = {
  sessions: 0, totalDwellMs: 0, meanSessionMs: 0, medianSessionMs: 0,
  completedSessions: 0, rooms: [], funnel: EMPTY_FUNNEL, daily: [], discardedEvents: 0,
};

interface Normalised {
  readonly sessionId: string;
  readonly kind: string;
  readonly roomId: string | null;
  readonly t: number;
  readonly ms: number | null;
}

export function aggregate(
  events: readonly EventRow[],
  roomNames: Readonly<Record<string, string>> = {},
): AnalyticsSummary {
  const bySession = new Map<string, Normalised[]>();
  let discarded = 0;

  for (const e of events) {
    const sessionId = typeof e.session_id === 'string' && e.session_id.length > 0 ? e.session_id : null;
    const t = Date.parse(e.at);
    if (!sessionId || !Number.isFinite(t)) { discarded += 1; continue; }
    const rawMs = e.payload && typeof e.payload['ms'] === 'number' ? (e.payload['ms'] as number) : null;
    const list = bySession.get(sessionId) ?? [];
    list.push({
      sessionId,
      kind: String(e.kind),
      roomId: typeof e.room_id === 'string' && e.room_id.length > 0 ? e.room_id : null,
      t,
      ms: rawMs !== null && Number.isFinite(rawMs) && rawMs >= 0 ? rawMs : null,
    });
    bySession.set(sessionId, list);
  }

  if (bySession.size === 0) {
    return { ...EMPTY_ANALYTICS, discardedEvents: discarded };
  }

  const dwellByRoom = new Map<string, number>();
  const visitsByRoom = new Map<string, number>();
  const sessionsByRoom = new Map<string, Set<string>>();
  const revisitByRoom = new Map<string, Set<string>>();
  const exitsByRoom = new Map<string, number>();
  const sessionDurations: number[] = [];
  const dayCounts = new Map<string, number>();

  let asked = 0, measured = 0, leads = 0, entered = 0, completed = 0;

  for (const [sessionId, raw] of bySession) {
    const evs = [...raw].sort((a, b) => a.t - b.t || rank(a.kind) - rank(b.kind));
    const first = evs[0]!;
    const last = evs[evs.length - 1]!;

    sessionDurations.push(Math.max(0, last.t - first.t));
    const day = new Date(first.t).toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);

    if (evs.some((e) => e.kind === 'enter')) entered += 1;
    if (evs.some((e) => e.kind === 'exit')) completed += 1;
    if (evs.some((e) => e.kind === 'ask')) asked += 1;
    if (evs.some((e) => e.kind === 'measure')) measured += 1;
    if (evs.some((e) => e.kind === 'lead')) leads += 1;

    // Room entries: counted from `room` events regardless of how dwell is
    // measured, because a visit is a visit whether or not it was timed.
    const entries = evs.filter((e) => e.kind === 'room' && e.roomId !== null);
    const perRoom = new Map<string, number>();
    for (const e of entries) {
      const id = e.roomId!;
      perRoom.set(id, (perRoom.get(id) ?? 0) + 1);
      visitsByRoom.set(id, (visitsByRoom.get(id) ?? 0) + 1);
    }
    for (const [roomId, n] of perRoom) {
      const seen = sessionsByRoom.get(roomId) ?? new Set<string>();
      seen.add(sessionId);
      sessionsByRoom.set(roomId, seen);
      if (n > 1) {
        const again = revisitByRoom.get(roomId) ?? new Set<string>();
        again.add(sessionId);
        revisitByRoom.set(roomId, again);
      }
    }

    // Dwell: explicit if this session reported any, derived otherwise.
    const explicit = evs.filter((e) => e.kind === 'dwell' && e.roomId !== null && e.ms !== null);
    if (explicit.length > 0) {
      for (const e of explicit) {
        dwellByRoom.set(e.roomId!, (dwellByRoom.get(e.roomId!) ?? 0) + e.ms!);
      }
    } else {
      for (let i = 0; i < entries.length; i += 1) {
        const start = entries[i]!;
        const next = evs.find((e) => e.t > start.t && (e.kind === 'room' || e.kind === 'exit'));
        const end = next ? next.t : last.t;
        const ms = Math.max(0, end - start.t);
        if (ms > 0) dwellByRoom.set(start.roomId!, (dwellByRoom.get(start.roomId!) ?? 0) + ms);
      }
    }

    // Where the session ended: the exit event's room, or the last room seen.
    const exitEvent = [...evs].reverse().find((e) => e.kind === 'exit');
    const exitRoom = exitEvent?.roomId
      ?? [...evs].reverse().find((e) => e.roomId !== null)?.roomId
      ?? null;
    if (exitRoom) exitsByRoom.set(exitRoom, (exitsByRoom.get(exitRoom) ?? 0) + 1);
  }

  const roomIds = [...new Set<string>([
    ...dwellByRoom.keys(), ...visitsByRoom.keys(), ...exitsByRoom.keys(),
  ])];
  // Longest dwell first: the table's first row should be the room that held
  // people, because that is the one the agency can act on.
  roomIds.sort((a, b) => (dwellByRoom.get(b) ?? 0) - (dwellByRoom.get(a) ?? 0) || a.localeCompare(b));

  const shares = wholePercentShares(roomIds.map((id) => dwellByRoom.get(id) ?? 0));

  const rooms: RoomStat[] = roomIds.map((roomId, i) => {
    const sessions = sessionsByRoom.get(roomId)?.size ?? 0;
    const revisits = revisitByRoom.get(roomId)?.size ?? 0;
    const dwellMs = dwellByRoom.get(roomId) ?? 0;
    const exits = exitsByRoom.get(roomId) ?? 0;
    return {
      roomId,
      name: roomNames[roomId] ?? roomId,
      dwellMs,
      dwellShare: shares[i] ?? 0,
      visits: visitsByRoom.get(roomId) ?? 0,
      sessions,
      revisitSessions: revisits,
      revisitRate: sessions === 0 ? 0 : revisits / sessions,
      meanDwellPerSessionMs: sessions === 0 ? 0 : dwellMs / sessions,
      exits,
      exitRate: sessions === 0 ? 0 : exits / sessions,
    };
  });

  const sessions = bySession.size;
  const totalDwellMs = [...dwellByRoom.values()].reduce((a, b) => a + b, 0);

  return {
    sessions,
    totalDwellMs,
    meanSessionMs: mean(sessionDurations),
    medianSessionMs: median(sessionDurations),
    completedSessions: completed,
    rooms,
    funnel: {
      sessions, entered, asked, measured, leads,
      leadRate: sessions === 0 ? 0 : leads / sessions,
    },
    daily: fillDays(dayCounts),
    discardedEvents: discarded,
  };
}

/** Ties at the same millisecond resolve to the order a session really goes in. */
function rank(kind: string): number {
  switch (kind) {
    case 'enter': return 0;
    case 'room': return 1;
    case 'dwell': return 2;
    case 'measure': return 3;
    case 'ask': return 4;
    case 'lead': return 5;
    case 'exit': return 6;
    default: return 3;
  }
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Even counts average the two middle values, as a median is defined to. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Days with no sessions are rendered as zero rather than omitted. A sparkline
 * that closes the gap turns a dead fortnight into a gentle slope.
 */
function fillDays(counts: ReadonlyMap<string, number>): { date: string; sessions: number }[] {
  const days = [...counts.keys()].sort();
  if (days.length === 0) return [];
  const out: { date: string; sessions: number }[] = [];
  const start = Date.parse(`${days[0]!}T00:00:00Z`);
  const end = Date.parse(`${days[days.length - 1]!}T00:00:00Z`);
  for (let t = start; t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, sessions: counts.get(date) ?? 0 });
  }
  return out;
}
