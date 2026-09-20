import type { MeasureTool } from '../measure/session.js';
import type { ViewerMode } from '../types.js';

/**
 * WHAT THE VIEWER SAW A VISITOR DO.
 *
 * `POST /wv-view/events` has existed, been rate-limited, been clamped and been
 * tested since P2.8, and nothing has ever called it. Every analytics screen in
 * the console therefore reads zero rows in production: the room table that is
 * supposed to tell an agency "every second visitor goes back to the kitchen"
 * is empty, not because nobody visits but because nobody reports.
 *
 * This module is the reporting half, and it is deliberately the SMALLER half.
 * It knows the seven event kinds and the rules for when each one is true. It
 * knows nothing about HTTP, sessions, Supabase, batching or retries -- the
 * package must stay embeddable by an agency serving a self-hosted document
 * from their own origin, and a package that phoned home would be a package
 * nobody could embed. The viewer emits; the host page decides whether anyone
 * is listening (see spatial/apps/view/src/main.ts), and a host that passes no
 * `onEvent` pays nothing at all.
 *
 * THE SEVEN KINDS are the contract documented at the top of
 * spatial/packages/console-ui/src/logic/analytics.ts and enforced by
 * `EVENT_KINDS` in supabase/functions/wv-view/handler.ts. Both ends already
 * agree; this is the middle that was missing.
 *
 * WHAT THIS DOES NOT SEND. A payload here is telemetry about a member of the
 * public looking round somebody's home, so it carries only what an agency can
 * act on: which room, for how long, and which of the four things the tour
 * offers they used. It never carries the text of a question, a pose, a path,
 * a pointer trace or anything else that would describe the person rather than
 * the property.
 */

export type ViewerEventKind = 'enter' | 'room' | 'dwell' | 'measure' | 'ask' | 'lead' | 'exit';

interface ViewerEventBase {
  /**
   * When it happened, ISO-8601, from the viewer's own clock.
   *
   * It is a CLAIM and is treated as one: wv-view clamps it into the window
   * between the session's start and the moment the batch arrives, because a
   * browser clock set to 2035 would otherwise stretch one session across a
   * decade and poison every mean on the page.
   */
  readonly at: string;
  /** The room the visitor was in when it happened, when they were in one. */
  readonly roomId?: string;
}

/** The session opened. One per tour, and the first thing emitted. */
export interface ViewerEnterEvent extends ViewerEventBase {
  readonly kind: 'enter';
  /** `embed` traffic is an agency's own site; it is worth telling apart. */
  readonly payload: { readonly mode: ViewerMode };
}

/** The camera came to rest in a room it was not in before. */
export interface ViewerRoomEvent extends ViewerEventBase {
  readonly kind: 'room';
  readonly roomId: string;
  readonly payload: Record<string, never>;
}

/** The camera left a room, having spent `ms` in it. */
export interface ViewerDwellEvent extends ViewerEventBase {
  readonly kind: 'dwell';
  readonly roomId: string;
  readonly payload: { readonly ms: number };
}

/** A measurement completed and a figure was shown to the visitor. */
export interface ViewerMeasureEvent extends ViewerEventBase {
  readonly kind: 'measure';
  readonly payload: {
    readonly tool: MeasureTool;
    /**
     * Whether the figure the visitor was shown was defensible or indicative.
     * A tour whose measurements are mostly indicative is a tour of a property
     * that needs rescanning, and that is worth an agency knowing.
     */
    readonly status: 'defensible' | 'indicative';
  };
}

/** The visitor asked the agent a question. */
export interface ViewerAskEvent extends ViewerEventBase {
  readonly kind: 'ask';
  /**
   * The LENGTH of the question, never the question. What somebody asks about
   * a home they are considering -- "is there damp behind the sofa", "how far
   * is the school" -- is theirs, and wv-ask already records what it needs
   * server-side under the session's own metering. The count is here only so
   * that a run of empty submissions is distinguishable from real questions.
   */
  readonly payload: { readonly chars: number };
}

/**
 * The visitor left their details.
 *
 * THIS PACKAGE NEVER EMITS ONE, and it would be dishonest to pretend
 * otherwise: the viewer has no enquiry form, no contact field and no
 * lead-capture surface of any kind -- `ViewerBranding.listingUrl` sends the
 * visitor to the agency's own page, where the agency's own form lives. The
 * kind is in the union because the endpoint and the console's funnel both
 * understand it, so a host page that DOES capture an enquiry can report it
 * through the same `onEvent` hook and have it land in the same funnel. If a
 * lead surface is ever built into the viewer, this is the event it emits.
 */
export interface ViewerLeadEvent extends ViewerEventBase {
  readonly kind: 'lead';
  readonly payload: Record<string, never>;
}

/** The tour ended. One per tour, and the last thing emitted. */
export interface ViewerExitEvent extends ViewerEventBase {
  readonly kind: 'exit';
  /**
   * How long the whole tour lasted. It is NOT dwell and is not counted as
   * dwell: `aggregate()` sums `payload.ms` from `dwell` rows only, and reads
   * session length from the first and last timestamps. It is here because the
   * client's own measure of the tour is worth having beside the server's.
   */
  readonly payload: { readonly ms: number };
}

export type ViewerEvent =
  | ViewerEnterEvent
  | ViewerRoomEvent
  | ViewerDwellEvent
  | ViewerMeasureEvent
  | ViewerAskEvent
  | ViewerLeadEvent
  | ViewerExitEvent;

/** The hook `ViewerOptions.onEvent` takes. Synchronous, and must not throw. */
export type ViewerEventSink = (event: ViewerEvent) => void;

export interface ViewerEventRecorderOptions {
  /** Where events go. Absent means the tour is not reported at all. */
  readonly onEvent?: ViewerEventSink;
  readonly mode?: ViewerMode;
  /** Milliseconds since the epoch. Injectable so dwell is testable. */
  readonly now?: () => number;
}

/**
 * The rules for when each of the seven kinds is true, with no DOM in it.
 *
 * It lives apart from `WorldViewer` for the same reason the constraint solver
 * and the measurement session do: the interesting part is the bookkeeping --
 * enter exactly once, a dwell for every room entered including the last one,
 * exit exactly once however the tour ends -- and none of that needs a GPU to
 * be worth testing.
 */
export class ViewerEventRecorder {
  private readonly sink: ViewerEventSink | undefined;
  private readonly mode: ViewerMode;
  private readonly clock: () => number;

  private started = false;
  private ended = false;
  private startedAt = 0;
  private roomId: string | undefined;
  private roomSince = 0;

  constructor(opts: ViewerEventRecorderOptions = {}) {
    this.sink = opts.onEvent;
    this.mode = opts.mode ?? 'visitor';
    this.clock = opts.now ?? (() => Date.now());
  }

  /** True while events are still being produced. */
  get active(): boolean { return this.started && !this.ended; }

  /** The room the recorder believes the visitor is in. */
  get currentRoomId(): string | undefined { return this.roomId; }

  /**
   * The tour opened, with the visitor standing in `roomId` if they spawned in
   * a room at all.
   *
   * The spawn room is reported as a `room` event as well as being named on the
   * `enter`, because the console counts a room's visits from `room` events; a
   * spawn that was only ever an attribute of `enter` would make the entrance
   * hall the one room in the property nobody ever visited.
   */
  start(roomId?: string): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.clock();
    this.roomId = roomId;
    this.roomSince = this.startedAt;
    this.emit({
      kind: 'enter', at: this.iso(this.startedAt), payload: { mode: this.mode },
      ...(roomId ? { roomId } : {}),
    });
    if (roomId) this.emit({ kind: 'room', at: this.iso(this.startedAt), roomId, payload: {} });
  }

  /**
   * The camera settled somewhere. `undefined` means "no longer in any room" --
   * an operator walking through unsurveyed space, or a visitor standing in a
   * doorway between two polygons.
   *
   * Leaving a room always closes it with a `dwell` carrying the milliseconds
   * spent there. That is what makes the console's dwell column explicit rather
   * than derived from the gaps between `room` events, and the difference
   * matters for the LAST room of a session, whose gap has no next event to be
   * measured against.
   */
  enteredRoom(roomId: string | undefined): void {
    if (!this.active) return;
    // A flight that ends where it began is not a visit. Re-emitting `room`
    // here would invent a revisit, and the revisit rate is one of the two
    // numbers the room table exists to show.
    if (roomId === this.roomId) return;

    const now = this.clock();
    this.closeRoom(now);
    this.roomId = roomId;
    this.roomSince = now;
    if (roomId !== undefined) {
      this.emit({ kind: 'room', at: this.iso(now), roomId, payload: {} });
    }
  }

  /** A measurement produced a figure and showed it to the visitor. */
  measured(tool: MeasureTool, status: 'defensible' | 'indicative'): void {
    if (!this.active) return;
    this.emit({
      kind: 'measure', at: this.iso(this.clock()), payload: { tool, status },
      ...(this.roomId ? { roomId: this.roomId } : {}),
    });
  }

  /** The visitor asked the agent something. The text stays in the browser. */
  asked(question: string): void {
    if (!this.active) return;
    this.emit({
      kind: 'ask', at: this.iso(this.clock()), payload: { chars: question.trim().length },
      ...(this.roomId ? { roomId: this.roomId } : {}),
    });
  }

  /**
   * The tour ended, once, whichever of the several endings happened first:
   * the page being hidden for good, the host disposing of the viewer, or the
   * element being torn out from under it.
   *
   * Exactly once is the whole point. `exit` is what closes the session row
   * server-side, and a second one would be refused by a 409 that the host
   * would then have to reason about; two accepted ones would count one
   * departure twice in the console's completion rate.
   */
  exit(): void {
    if (!this.active) return;
    const now = this.clock();
    // The room they were standing in when they left is closed like any other,
    // so that explicit dwell covers the whole tour. Without it the final room
    // -- the one with the highest exit rate, the one worth acting on -- would
    // be the only room in the property with no time against it.
    this.closeRoom(now);
    this.ended = true;
    this.emit({
      kind: 'exit', at: this.iso(now), payload: { ms: Math.max(0, now - this.startedAt) },
      ...(this.roomId ? { roomId: this.roomId } : {}),
    });
  }

  private closeRoom(now: number): void {
    if (this.roomId === undefined) return;
    this.emit({
      kind: 'dwell', at: this.iso(now), roomId: this.roomId,
      payload: { ms: Math.max(0, now - this.roomSince) },
    });
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /**
   * A host's callback is somebody else's code running inside our render loop.
   * If it throws, the tour continues: analytics is never a precondition for
   * showing somebody a property, and an exception escaping from here would
   * take down the frame that was reporting a room change.
   */
  private emit(event: ViewerEvent): void {
    if (!this.sink) return;
    try {
      this.sink(event);
    } catch (err) {
      console.error('[m3xi/viewer] onEvent threw', err);
    }
  }
}
